// Evals for the public API (/api/v1), API keys and webhooks.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wabox-api-'));
Object.assign(process.env, { DATA_DIR: DATA, WABOX_TEST_FAST: '1', WA_ENGINE_URL: 'http://127.0.0.1:9', WA_ENGINE_KEY: 'x',
  WABOX_SKIP_URL_CHECK: '1', WABOX_ALLOW_HTTP_HOOKS: '1', WABOX_API_RATE: '40', WABOX_HOOK_TIMEOUT_MS: '500' });

let db, keys, hooks, base, srv, receiver, recvPort, time;
const received = [];
let receiverMode = 'ok';
const ADMIN = 'admin@test';

before(async () => {
  ({ db } = require('../src/db'));
  keys = require('../src/apikeys');
  hooks = require('../src/hooks');
  time = require('../src/time');
  const express = require('express');
  const app = express();
  app.use('/api/v1', require('../src/api_v1'));
  srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/v1`;
  receiver = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(receiverMode === 'ok' ? 200 : 500); res.end(); });
  });
  await new Promise(r => receiver.listen(0, r));
  recvPort = receiver.address().port;
});
after(() => { srv.close(); receiver.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  for (const t of ['jobs', 'sends', 'wa_groups', 'group_lists', 'api_keys', 'idempotency', 'webhooks', 'hook_deliveries', 'alert_log']) db.exec(`DELETE FROM ${t}`);
  const now = Date.now();
  for (const [id, name] of [['1@g.us', 'Weekend Cohort 1'], ['2@g.us', 'Weekend Cohort 2'], ['3@g.us', 'Masterclass Nov']]) {
    db.prepare('INSERT INTO wa_groups(id,name,active,updated_at) VALUES(?,?,1,?)').run(id, name, now);
  }
  db.prepare("INSERT INTO group_lists(id,name,group_ids,created_by,updated_at) VALUES(1,'Weekend','[\"1@g.us\",\"2@g.us\"]','t',?)").run(now);
  received.length = 0; receiverMode = 'ok';
});

const call = async (method, p, { key, body, headers = {} } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
};
const newKey = (scope = 'schedule', extra = {}) => keys.create({ name: `k-${crypto.randomUUID().slice(0, 6)}`, scope, ...extra }, ADMIN).key;
const tomorrowAt = t => ({ date: time.epochToIst(Date.now() + 86400e3).date, time: t });
const jobCount = () => db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('no key, a wrong key, or a revoked key: 401 with a clear error', async () => {
  assert.equal((await call('GET', '/status')).body.error.code, 'unauthorized');
  assert.equal((await call('GET', '/status', { key: 'wbx_' + 'a'.repeat(32) })).status, 401);
  const k = keys.create({ name: 'old', scope: 'read' }, ADMIN);
  assert.equal((await call('GET', '/status', { key: k.key })).status, 200);
  keys.revoke(k.id, ADMIN);
  assert.equal((await call('GET', '/status', { key: k.key })).status, 401);
});

test('keys are stored only as a hash; the key itself is shown once', () => {
  const k = keys.create({ name: 'Sheet', scope: 'schedule' }, ADMIN);
  assert.match(k.key, /^wbx_[A-Za-z0-9]{32}$/);
  const dump = JSON.stringify(db.prepare('SELECT * FROM api_keys').all());
  assert.ok(!dump.includes(k.key));
  assert.ok(!JSON.stringify(keys.list()).includes(k.key));
});

test('X-API-Key header works too', async () => {
  const key = newKey('read');
  assert.equal((await call('GET', '/groups', { headers: { 'X-API-Key': key } })).body.groups.length, 3);
});

test('a read key can look but not schedule', async () => {
  const key = newKey('read');
  assert.equal((await call('GET', '/lists', { key })).body.lists[0].name, 'Weekend');
  const r = await call('POST', '/messages', { key, body: { text: 'hi', groups: ['1@g.us'], sendAt: tomorrowAt('10:00') } });
  assert.equal(r.status, 403);
  assert.equal(jobCount(), 0);
});

test('schedule by list name and group name; recorded as made by the key; never starts inside the undo window', async () => {
  const k = keys.create({ name: 'Google Sheet', scope: 'schedule' }, ADMIN);
  const r = await call('POST', '/messages', { key: k.key, body: { text: 'Class at 11 *today*', list: 'weekend', groups: ['Masterclass Nov'], sendAt: 'now', pacing: 'gentle' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body.message;
  assert.deepEqual(m.groups.map(g => g.id).sort(), ['1@g.us', '2@g.us', '3@g.us']);
  assert.deepEqual(m.pacing, { minSeconds: 60, maxSeconds: 180 });
  assert.equal(m.createdBy, 'api:Google Sheet');
  assert.ok(Date.parse(m.startsAt) >= Date.now() + 25000);
});

test('ISO times are converted to India time; a time without a timezone is refused', async () => {
  const key = newKey();
  const day = time.epochToIst(Date.now() + 2 * 86400e3).date;
  const r = await call('POST', '/messages', { key, body: { text: 'x', groups: ['1@g.us'], sendAt: `${day}T04:30:00Z` } });
  assert.equal(r.status, 201);
  assert.equal(r.body.message.time, '10:00');
  assert.equal(r.body.message.date, day);
  const bad = await call('POST', '/messages', { key, body: { text: 'x', groups: ['1@g.us'], sendAt: `${day}T10:00:00` } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /timezone/);
});

test('the same rules as the app: past times, empty text, unknown groups and too-short gaps', async () => {
  const key = newKey();
  const past = await call('POST', '/messages', { key, body: { text: 'x', groups: ['1@g.us'], sendAt: '2020-01-01T10:00:00+05:30' } });
  assert.equal(past.body.error.code, 'invalid_request'); assert.match(past.body.error.message, /past/);
  assert.match((await call('POST', '/messages', { key, body: { text: ' ', groups: ['1@g.us'], sendAt: 'now' } })).body.error.message, /empty/);
  const unk = await call('POST', '/messages', { key, body: { text: 'x', groups: ['Nope'], sendAt: 'now' } });
  assert.equal(unk.body.error.code, 'unknown_group'); assert.match(unk.body.error.message, /Nope/);
  const fast = await call('POST', '/messages', { key, body: { text: 'x', groups: ['1@g.us'], sendAt: 'now', pacing: { minSeconds: 1, maxSeconds: 2 } } });
  assert.ok(fast.body.message.pacing.minSeconds >= require('../src/scheduler').HARD_MIN_GAP_S);
  assert.equal((await call('POST', '/messages', { key, body: { text: 'x', groups: ['1@g.us'], sendAt: 'now', repeat: ['funday'] } })).status, 400);
  assert.equal(jobCount(), 1);
});

test('Idempotency-Key: a retried request returns the first answer and schedules once', async () => {
  const key = newKey();
  const body = { text: 'once', groups: ['1@g.us'], sendAt: tomorrowAt('09:00') };
  const a = await call('POST', '/messages', { key, body, headers: { 'Idempotency-Key': 'row-17' } });
  const b = await call('POST', '/messages', { key, body, headers: { 'Idempotency-Key': 'row-17' } });
  assert.equal(a.body.message.id, b.body.message.id);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(jobCount(), 1);
  const c = await call('POST', '/messages', { key, body: { ...body, text: 'different' }, headers: { 'Idempotency-Key': 'row-17' } });
  assert.equal(c.status, 409);
  assert.equal(jobCount(), 1);
});

test('a key limited to a list only sees and sends to those groups', async () => {
  const key = newKey('schedule', { listIds: [1] });
  assert.deepEqual((await call('GET', '/groups', { key })).body.groups.map(g => g.id), ['1@g.us', '2@g.us']);
  const r = await call('POST', '/messages', { key, body: { text: 'x', groups: ['3@g.us'], sendAt: 'now' } });
  assert.equal(r.body.error.code, 'unknown_group');
  assert.equal((await call('POST', '/messages', { key, body: { text: 'x', list: 'Weekend', sendAt: 'now' } })).status, 201);
});

test('cancel: a schedule key cancels its own messages only; a full key cancels any', async () => {
  const mine = newKey(); const other = newKey(); const full = newKey('full');
  const id = (await call('POST', '/messages', { key: mine, body: { text: 'x', groups: ['1@g.us'], sendAt: tomorrowAt('10:00') } })).body.message.id;
  assert.equal((await call('DELETE', `/messages/${id}`, { key: other })).status, 403);
  const ok = await call('DELETE', `/messages/${id}`, { key: mine });
  assert.equal(ok.body.message.status, 'cancelled');
  assert.equal((await call('DELETE', `/messages/${id}`, { key: full })).status, 409);
  const id2 = (await call('POST', '/messages', { key: mine, body: { text: 'y', groups: ['1@g.us'], sendAt: tomorrowAt('11:00') } })).body.message.id;
  assert.equal((await call('DELETE', `/messages/${id2}`, { key: full })).status, 200);
  assert.equal((await call('GET', '/messages/99999', { key: full })).status, 404);
});

test('list and read messages with per-group status', async () => {
  const key = newKey();
  const id = (await call('POST', '/messages', { key, body: { text: 'x', groups: ['1@g.us', '2@g.us'], sendAt: tomorrowAt('10:00'), title: 'Reminder' } })).body.message.id;
  const one = await call('GET', `/messages/${id}`, { key });
  assert.equal(one.body.message.title, 'Reminder');
  assert.deepEqual(one.body.message.groups.map(g => g.status), ['pending', 'pending']);
  assert.equal((await call('GET', '/messages', { key })).body.messages.length, 1);
  assert.equal((await call('GET', '/messages?status=history', { key })).body.messages.length, 0);
});

test('bad JSON and unknown endpoints get the standard error shape', async () => {
  const key = newKey();
  const r = await fetch(base + '/messages', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'invalid_request');
  assert.equal((await call('GET', '/nope', { key })).body.error.code, 'not_found');
});

test('rate limit: too many requests in a minute get 429', async () => {
  const key = newKey('read');
  let last;
  for (let i = 0; i < 41; i++) last = await call('GET', '/groups', { key });
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, 'rate_limited');
});

test('webhooks: signed with the secret, only for subscribed events', async () => {
  const h = hooks.add({ url: `http://127.0.0.1:${recvPort}/in`, events: ['message.finished'] }, ADMIN);
  assert.match(h.secret, /^whsec_/);
  hooks.emit('message.started', { a: 1 });
  hooks.emit('message.finished', { message: { id: 5 } });
  assert.ok(await until(() => received.length >= 1));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(received.length, 1);
  const { headers, body } = received[0];
  assert.equal(headers['x-wabox-event'], 'message.finished');
  const [, t, v1] = headers['x-wabox-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  assert.equal(v1, crypto.createHmac('sha256', h.secret).update(`${t}.${body}`).digest('hex'));
  assert.equal(JSON.parse(body).data.message.id, 5);
});

test('webhooks: a failing receiver is retried with backoff, then given up with an alert', async () => {
  receiverMode = 'fail';
  hooks.add({ url: `http://127.0.0.1:${recvPort}/in` }, ADMIN);
  hooks.emit('group.failed', { x: 1 });
  assert.ok(await until(() => db.prepare('SELECT attempts FROM hook_deliveries').get()?.attempts === 1));
  let d = db.prepare('SELECT * FROM hook_deliveries').get();
  assert.equal(d.status, 'pending');
  assert.ok(d.next_at - Date.now() > 50e3 && d.next_at - Date.now() <= 60e3);   // 1 minute later
  for (let i = 0; i < hooks.BACKOFF_MS.length; i++) {
    db.prepare('UPDATE hook_deliveries SET next_at=0').run();
    await hooks.pump();
  }
  d = db.prepare('SELECT * FROM hook_deliveries').get();
  assert.equal(d.status, 'failed');
  assert.equal(d.attempts, 6);
  assert.ok(db.prepare("SELECT 1 FROM alert_log WHERE key LIKE 'hook:%'").get(), 'an alert was raised');
});

test('webhooks: plain http is refused except to this computer in local/test mode', () => {
  assert.throws(() => hooks.add({ url: 'http://example.com/x' }, ADMIN), /https/);
  assert.throws(() => hooks.add({ url: 'not a url' }, ADMIN), /doesn't look right/);
});
