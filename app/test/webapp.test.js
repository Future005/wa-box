// The web app's own API (what the browser uses), run for real: the server starts as a separate
// process with its own data folder and a small fake WhatsApp engine, and we sign in like a person.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wabox-web-'));
const KEY = 'k'.repeat(64);
const PHONE = '919000000000';
const GROUPS = [{ id: 'a@g.us', name: 'Weekend Cohort 1' }, { id: 'b@g.us', name: 'Weekend Cohort 2' }, { id: 'c@g.us', name: 'Ops Team' }];
let engine, app, base, cookie = '';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function call(method, p, body, { form } = {}) {
  const headers = { 'X-Requested-With': 'wabox', cookie };
  let payload;
  if (form) { payload = form; } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers, body: payload });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json ?? text };
}
const form = o => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return f; };
const tomorrow = () => new Date(Date.now() + 330 * 60000 + 86400e3).toISOString().slice(0, 10);

before(async () => {
  engine = http.createServer((req, res) => {
    const j = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== KEY) return j(401, { message: 'key' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/status') return j(200, { status: 'ready', phone: PHONE, pushName: 'Test', live: true });
    if (u.pathname === '/groups') return j(200, GROUPS);
    if (u.pathname === '/receipts') return j(200, {});
    j(200, { ok: true });
  });
  const ePort = await listen(engine);
  const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));   // a free port number
  base = `http://127.0.0.1:${port}/wabox/api/`;
  app = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(port), BASE_PATH: '/wabox', COOKIE_INSECURE: 'true', WABOX_TEST_FAST: '1',
      WA_ENGINE_URL: `http://127.0.0.1:${ePort}`, WA_ENGINE_KEY: KEY, ADMIN_USER: 'admin@example.com', ADMIN_PASSWORD: 'first-pass-123',
      GROUP_KEYWORDS: '', ORG_NAME: '', PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; app.stdout.on('data', d => { log += d; }); app.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base.replace('api/', 'healthz'), { signal: AbortSignal.timeout(1000) })).ok) break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(app.exitCode === null, 'server exited: ' + log);
  assert.equal((await call('POST', 'login', { username: 'admin@example.com', password: 'first-pass-123' })).status, 200);
  assert.equal((await call('POST', 'password', { current: 'first-pass-123', next: 'second-pass-456' })).status, 200);
  for (let i = 0; i < 100 && !((await call('GET', 'groups')).body.groups || []).length; i++) await new Promise(r => setTimeout(r, 50));
});
after(() => { app?.kill(); engine?.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// ---------- batch 1: templates and message names ----------
test('templates can be edited and renamed, and count how often they are used', async () => {
  const r = await call('POST', 'templates', { name: 'Class reminder', message: 'Class at 10' });
  assert.equal(r.status, 200); assert.ok(r.body.id);
  assert.equal((await call('PUT', `templates/${r.body.id}`, { name: 'Weekend class', message: 'Class at *11*' })).status, 200);
  let t = (await call('GET', 'templates')).body.templates.find(x => x.id === r.body.id);
  assert.equal(t.name, 'Weekend class'); assert.equal(t.message, 'Class at *11*'); assert.equal(t.updated_by, 'admin@example.com');
  assert.equal((await call('PUT', 'templates/99999', { name: 'x', message: 'y' })).status, 404);
  assert.equal((await call('PUT', `templates/${r.body.id}`, { name: '', message: 'y' })).status, 400);
  const job = await call('POST', 'jobs', null, { form: form({ title: '', message: t.message, groups: ['a@g.us'], date: tomorrow(), time: '10:00', templateId: String(t.id) }) });
  assert.equal(job.status, 200, JSON.stringify(job.body));
  t = (await call('GET', 'templates')).body.templates.find(x => x.id === r.body.id);
  assert.equal(t.uses, 1);
});

test('a message keeps the name you give it, and the name can be changed when editing', async () => {
  const r = await call('POST', 'jobs', null, { form: form({ title: 'Saturday reminder', message: 'Hi {group}', groups: ['a@g.us', 'b@g.us'], date: tomorrow(), time: '11:00' }) });
  assert.equal(r.status, 200);
  let j = (await call('GET', 'jobs?view=upcoming')).body.jobs.find(x => x.id === r.body.id);
  assert.equal(j.title, 'Saturday reminder');
  const ed = await call('PUT', `jobs/${r.body.id}`, null, { form: form({ title: 'Sat class', message: 'Hi {group}', groups: ['a@g.us', 'b@g.us'], date: tomorrow(), time: '11:00' }) });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  j = (await call('GET', 'jobs?view=upcoming')).body.jobs.find(x => x.id === r.body.id);
  assert.equal(j.title, 'Sat class');
});

// ---------- batch 3: drafts ----------
const jobsIn = async view => (await call('GET', `jobs?view=${view}`)).body.jobs;

test('a draft can be incomplete, is saved as you go, and never shows up as scheduled or sent', async () => {
  const r = await call('POST', 'drafts', null, { form: form({ message: 'Half a thought', groups: ['a@g.us'], draft: { date: tomorrow(), time: '' } }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('PUT', `drafts/${r.body.id}`, null, { form: form({ title: 'Quiz', message: 'Quiz on Friday', groups: ['a@g.us', 'b@g.us'], draft: { date: tomorrow(), time: '18:00' } }) })).status, 200);
  const d = (await jobsIn('drafts')).find(j => j.id === r.body.id);
  assert.equal(d.status, 'draft'); assert.equal(d.title, 'Quiz'); assert.equal(d.groups.length, 2); assert.equal(d.time, '18:00');
  assert.ok(!(await jobsIn('upcoming')).some(j => j.id === r.body.id), 'not in upcoming');
  assert.ok(!(await jobsIn('history')).some(j => j.id === r.body.id), 'not in history');
  const empty = await call('POST', 'drafts', null, { form: form({ message: '', groups: [] }) });
  assert.equal(empty.status, 200, 'an empty draft is fine');
  assert.equal((await call('DELETE', `drafts/${empty.body.id}`)).status, 200);
  assert.equal((await call('DELETE', `drafts/${empty.body.id}`)).status, 404);
});

test('scheduling a draft checks everything, then turns that same draft into a scheduled message', async () => {
  const r = await call('POST', 'drafts', null, { form: form({ message: 'Class at 11', groups: [] }) });
  const noGroups = await call('POST', `drafts/${r.body.id}/schedule`, null, { form: form({ title: '', message: 'Class at 11', groups: [], date: tomorrow(), time: '11:00' }) });
  assert.equal(noGroups.status, 400, 'still checked');
  const ok = await call('POST', `drafts/${r.body.id}/schedule`, null, { form: form({ title: 'Class', message: 'Class at 11', groups: ['a@g.us'], date: tomorrow(), time: '11:00' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.id, r.body.id, 'same message');
  const j = (await jobsIn('upcoming')).find(x => x.id === r.body.id);
  assert.equal(j.status, 'scheduled'); assert.equal(j.time, '11:00');
  assert.ok(!(await jobsIn('drafts')).some(x => x.id === r.body.id));
});

test('a scheduled message can go back to drafts (no time) before it starts', async () => {
  const r = await call('POST', 'jobs', null, { form: form({ title: '', message: 'Maybe Saturday', groups: ['a@g.us'], date: tomorrow(), time: '09:30' }) });
  const u = await call('POST', `jobs/${r.body.id}/unschedule`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const d = (await jobsIn('drafts')).find(x => x.id === r.body.id);
  assert.equal(d.status, 'draft'); assert.equal(d.time, '09:30', 'remembers the time it had');
  assert.ok(!(await jobsIn('upcoming')).some(x => x.id === r.body.id));
  assert.equal((await call('POST', `jobs/${r.body.id}/unschedule`)).status, 409, 'already a draft');
});

test('aborting can keep a draft with the same text for the groups that did not get it', async () => {
  const r = await call('POST', 'jobs', null, { form: form({ title: 'Webinar', message: 'Webinar at 7', groups: ['a@g.us', 'b@g.us', 'c@g.us'], date: tomorrow(), time: '19:00' }) });
  const c = await call('POST', `jobs/${r.body.id}/cancel`, { scope: 'all', keepDraft: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.ok(c.body.draftId);
  const d = (await jobsIn('drafts')).find(x => x.id === c.body.draftId);
  assert.equal(d.message, 'Webinar at 7'); assert.equal(d.title, 'Webinar'); assert.equal(d.groups.length, 3);
  assert.equal((await jobsIn('history')).find(x => x.id === r.body.id).status, 'cancelled', 'the aborted one stays in history');
  const r2 = await call('POST', 'jobs', null, { form: form({ title: '', message: 'No draft please', groups: ['a@g.us'], date: tomorrow(), time: '20:00' }) });
  assert.equal((await call('POST', `jobs/${r2.body.id}/cancel`, { scope: 'all' })).body.draftId, null);
});

test('unsaved edits to a scheduled message are kept apart until saved; saving clears them', async () => {
  const r = await call('POST', 'jobs', null, { form: form({ title: '', message: 'Original', groups: ['a@g.us'], date: tomorrow(), time: '12:00' }) });
  assert.equal((await call('PUT', `jobs/${r.body.id}/edit-draft`, { data: { message: 'Half-edited', time: '12:30' } })).status, 200);
  let j = (await jobsIn('upcoming')).find(x => x.id === r.body.id);
  assert.equal(j.message, 'Original', 'the scheduled version is unchanged');
  assert.equal(j.editDraft.data.message, 'Half-edited'); assert.equal(j.editDraft.by, 'admin@example.com');
  assert.equal((await call('PUT', `jobs/${r.body.id}`, null, { form: form({ title: '', message: 'Final', groups: ['a@g.us'], date: tomorrow(), time: '12:30' }) })).status, 200);
  j = (await jobsIn('upcoming')).find(x => x.id === r.body.id);
  assert.equal(j.message, 'Final'); assert.equal(j.editDraft, null);
});

// ---------- batch 4: another time, Sent period and CSV ----------
test('a second time copies the first message\'s image instead of needing it again', async () => {
  const f = form({ title: 'Poster', message: 'See you', groups: ['a@g.us'], date: tomorrow(), time: '08:00' });
  f.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'p.png');
  const first = await call('POST', 'jobs', null, { form: f });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await call('POST', 'jobs', null, { form: form({ title: 'Poster', message: 'See you', groups: ['a@g.us'], date: tomorrow(), time: '16:00', copyImageFrom: String(first.body.id) }) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const Database = require('better-sqlite3');
  const d = new Database(path.join(DATA, 'wabox.db'), { readonly: true });
  const [a, b] = [first.body.id, second.body.id].map(id => d.prepare('SELECT media_file FROM jobs WHERE id=?').get(id).media_file);
  d.close();
  assert.ok(a && b && a !== b, 'each message has its own copy');
  assert.ok(fs.existsSync(path.join(DATA, 'media', b)));
});

test('Sent can be limited to a period and downloaded as CSV', async () => {
  const Database = require('better-sqlite3');
  const d = new Database(path.join(DATA, 'wabox.db'));
  const job = (await jobsIn('upcoming'))[0];
  const old = Date.now() - 40 * 86400e3, recent = Date.now() - 3600e3;
  for (const [t, g] of [[old, 'Old, group'], [recent, 'New "group"']]) {
    const id = d.prepare("INSERT INTO sends(job_id,occurrence,group_id,group_name,status,attempt_at) VALUES(?,?,?,?,'sending',?)").run(job.id, t, 'x' + t, g, t).lastInsertRowid;
    d.prepare("UPDATE sends SET status='sent', sent_at=? WHERE id=?").run(t, id);
  }
  d.close();
  const all = (await call('GET', 'sends')).body.sends;
  const week = (await call('GET', `sends?since=${Date.now() - 7 * 86400e3}`)).body.sends;
  assert.ok(all.length >= 2); assert.equal(week.length, all.length - 1);
  const csv = await call('GET', `sends.csv?since=${Date.now() - 7 * 86400e3}`);
  assert.equal(csv.status, 200);
  assert.match(csv.body, /^﻿?"When \(India time\)","Group","Message name","Message","Result","Delivery","Details"/);
  assert.match(csv.body, /"New ""group"""/); assert.doesNotMatch(csv.body, /Old, group/);
});

test('every status change in these tests followed the state machines', () => {
  const Database = require('better-sqlite3');
  const d = new Database(path.join(DATA, 'wabox.db'), { readonly: true });
  const v = d.prepare('SELECT machine, from_state, to_state FROM state_violations').all();
  d.close();
  assert.deepEqual(v, []);
});
