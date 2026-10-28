// Evals for the send loop. Each test acts out one way things go wrong in real life
// and checks that WA Box neither double-sends nor fails silently.
// Runs during the Docker build: if any test fails, the deploy fails and the old version keeps running.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wabox-test-'));
const KEY = 'k'.repeat(64);
const PORT = 27850 + Math.floor(Math.random() * 100);
Object.assign(process.env, {
  DATA_DIR: DATA, WABOX_TEST_FAST: '1', WA_ENGINE_URL: `http://127.0.0.1:${PORT}`, WA_ENGINE_KEY: KEY,
  WABOX_SEND_TIMEOUT_MS: '300', DRY_RUN: 'false',
});

// ---------- fake engine (same API as engine/src/server.js) ----------
const gw = { delivered: [], behaviour: {}, calls: {}, status: 'ready' };
// behaviour[chatId] = array of modes used in order; last one repeats:
//   ok | timeout_delivered | timeout_lost | reject400 | reject409 | error500_delivered
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const j = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== KEY) return j(401, { message: 'bad key' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/status') return j(200, { status: gw.status, phone: '919000000000', pushName: 'Test' });
    if (u.pathname === '/typing') return j(200, { ok: true });
    if (u.pathname === '/groups') return j(200, []);
    if (u.pathname === '/history') {
      const chat = u.searchParams.get('chatId');
      return j(200, gw.delivered.filter(d => d.chatId === chat).map(d => ({ id: d.id, body: d.text, fromMe: true, timestamp: Math.floor(d.at / 1000) })));
    }
    if (u.pathname === '/send-text' || u.pathname === '/send-image') {
      const b = JSON.parse(body); const chat = b.chatId;
      const modes = gw.behaviour[chat] || ['ok'];
      const n = gw.calls[chat] = (gw.calls[chat] || 0) + 1;
      const mode = modes[Math.min(n - 1, modes.length - 1)];
      const deliver = () => gw.delivered.push({ chatId: chat, text: b.text ?? b.caption, url: b.url, base64: !!b.base64, linkPreview: b.linkPreview, at: Date.now(), id: 'm' + gw.delivered.length });
      if (mode === 'ok') { deliver(); return j(200, { messageId: 'm' + (gw.delivered.length - 1) }); }
      if (mode === 'timeout_delivered') { deliver(); return setTimeout(() => j(200, {}), 2000); }
      if (mode === 'timeout_lost') return setTimeout(() => j(200, {}), 2000);
      if (mode === 'reject400') return j(400, { message: 'Not a participant' });
      if (mode === 'reject409') return j(409, { message: 'WhatsApp is not ready (initializing)' });
      if (mode === 'error500_delivered') { deliver(); return j(500, { message: 'Evaluation failed' }); }
    }
    j(404, { message: 'not found ' + u.pathname });
  });
});

let db, sched, setSetting, getSetting, time;
const sentTo = chat => gw.delivered.filter(d => d.chatId === chat).length;
const G = n => ({ id: `${n}@g.us`, name: `Group ${n}` });

function addGroups(...ns) {
  for (const n of ns) db.prepare('INSERT OR REPLACE INTO wa_groups(id,name,active,updated_at) VALUES(?,?,1,?)').run(G(n).id, G(n).name, Date.now());
}
function addJob({ groups, message = 'Hello *team* 🎉', runAt = Date.now(), startAt, repeat = [], gap = 30, timeIst, mediaUrl = null, mediaFile = null, linkPreview = 1 } = {}) {
  const t = time.epochToIst(runAt).time;
  return db.prepare(`INSERT INTO jobs(title,message,groups_json,time_ist,run_at,start_at,gap_min,gap_max,repeat_days,status,created_by,updated_by,created_at,updated_at,media_url,media_file,media_mime,link_preview)
    VALUES('',?,?,?,?,?,?,?,?,'scheduled','test','test',?,?,?,?,?,?)`).run(message, JSON.stringify(groups.map(G)), timeIst || t, runAt, startAt ?? runAt, gap, gap,
    JSON.stringify(repeat), Date.now(), Date.now(), mediaUrl, mediaFile, mediaFile ? 'image/png' : null, linkPreview).lastInsertRowid;
}
const job = id => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const sends = id => db.prepare('SELECT * FROM sends WHERE job_id=? ORDER BY id').all(id);
async function runUntilIdle(max = 60) {
  for (let i = 0; i < max; i++) {
    await sched.tick();
    const active = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('scheduled','running') AND start_at <= ?").get(Date.now()).n;
    if (!active) return;
    await new Promise(r => setTimeout(r, 30));
  }
}

before(async () => {
  await new Promise(r => server.listen(PORT, r));
  ({ db, setSetting, getSetting } = require('../src/db'));
  time = require('../src/time');
  sched = require('../src/scheduler');
});
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  for (const t of ['sends', 'jobs', 'wa_groups', 'events', 'alert_log', 'locks']) db.exec(`DELETE FROM ${t}`);
  Object.assign(gw, { delivered: [], behaviour: {}, calls: {}, status: 'ready' });
  setSetting('dry_run', false); setSetting('paused', false); setSetting('daily_cap', 30); setSetting('hourly_cap', 40); setSetting('dedupe_hours', 20);
  Object.assign(sched.state, { lastSentAt: 0, consecutiveFailures: 0, leader: false, busy: false, stopping: false });
});

test('sends each group exactly once, in order, and finishes', async () => {
  addGroups(1, 2, 3);
  const id = addJob({ groups: [1, 2, 3] });
  await runUntilIdle();
  assert.equal(job(id).status, 'done');
  assert.deepEqual([1, 2, 3].map(n => sentTo(G(n).id)), [1, 1, 1]);
  assert.ok(sends(id).every(s => s.status === 'sent' && s.wa_message_id));
  await runUntilIdle(); // more ticks must not resend
  assert.equal(gw.delivered.length, 3);
});

test('keeps the minimum gap between sends', async () => {
  addGroups(1, 2);
  addJob({ groups: [1, 2], gap: 30 });
  await runUntilIdle();
  const [a, b] = gw.delivered;
  assert.ok(b.at - a.at >= 30, `gap was ${b.at - a.at} ms (fast mode: 30 ms = 30 s)`);
});

test('practice mode sends nothing but records every group', async () => {
  setSetting('dry_run', true);
  addGroups(1, 2);
  const id = addJob({ groups: [1, 2] });
  await runUntilIdle();
  assert.equal(gw.delivered.length, 0);
  assert.deepEqual(sends(id).map(s => s.status), ['dry_run', 'dry_run']);
});

test('lost reply but message delivered: checks the chat, marks sent, does NOT resend', async () => {
  addGroups(1);
  gw.behaviour[G(1).id] = ['timeout_delivered', 'ok'];
  const id = addJob({ groups: [1] });
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 1);
  const s = sends(id)[0];
  assert.equal(s.status, 'sent'); assert.equal(s.verified, 1);
});

test('server error after delivery: checks the chat, does NOT resend', async () => {
  addGroups(1);
  gw.behaviour[G(1).id] = ['error500_delivered', 'ok'];
  const id = addJob({ groups: [1] });
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 1);
  assert.equal(sends(id)[0].status, 'sent');
});

test('lost reply and not in the chat: marked unconfirmed, raises an alert, never resent on its own', async () => {
  addGroups(1);
  gw.behaviour[G(1).id] = ['timeout_lost', 'ok'];
  const id = addJob({ groups: [1] });
  await runUntilIdle();
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 0);
  assert.equal(gw.calls[G(1).id], 1, 'must not try again automatically');
  assert.equal(sends(id)[0].status, 'unconfirmed');
  assert.ok(db.prepare("SELECT 1 FROM alert_log WHERE key LIKE 'unconfirmed:%' AND open=1").get(), 'alert raised');
  assert.equal(job(id).status, 'done_with_errors');
});

test('crash mid-send, message did go out: on restart it is marked sent, not resent', async () => {
  addGroups(1);
  const id = addJob({ groups: [1], startAt: Date.now() + 3600e3 });
  const j = job(id);
  gw.delivered.push({ chatId: G(1).id, text: j.message, at: Date.now(), id: 'x' });
  db.prepare(`INSERT INTO sends(job_id,occurrence,group_id,group_name,status,attempts,attempt_at,day_key) VALUES(?,?,?,?, 'sending',1,?,?)`)
    .run(id, j.run_at, G(1).id, G(1).name, Date.now(), time.istDayKey());
  await sched.recoverInFlight();
  assert.equal(sends(id)[0].status, 'sent');
  assert.equal(sentTo(G(1).id), 1);
});

test('crash mid-send, message did not go out: unconfirmed, not resent blindly', async () => {
  addGroups(1);
  const id = addJob({ groups: [1] });
  const j = job(id);
  db.prepare(`INSERT INTO sends(job_id,occurrence,group_id,group_name,status,attempts,attempt_at,day_key) VALUES(?,?,?,?, 'sending',1,?,?)`)
    .run(id, j.run_at, G(1).id, G(1).name, Date.now(), time.istDayKey());
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 0);
  assert.equal(sends(id)[0].status, 'unconfirmed');
});

test('gateway says "not ready" (409): retries once, then sends', async () => {
  addGroups(1);
  gw.behaviour[G(1).id] = ['reject409', 'ok'];
  const id = addJob({ groups: [1] });
  await runUntilIdle();
  await new Promise(r => setTimeout(r, 120));
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 1);
  assert.equal(sends(id)[0].status, 'sent');
});

test('rejected (400, e.g. removed from group): failed, not retried', async () => {
  addGroups(1, 2);
  gw.behaviour[G(1).id] = ['reject400'];
  const id = addJob({ groups: [1, 2] });
  await runUntilIdle();
  assert.equal(gw.calls[G(1).id], 1);
  assert.deepEqual(sends(id).map(s => s.status), ['failed', 'sent']);
  assert.equal(job(id).status, 'done_with_errors');
});

test('circuit breaker: 3 failures in a row pause all sending and alert', async () => {
  addGroups(1, 2, 3, 4);
  for (const n of [1, 2, 3, 4]) gw.behaviour[G(n).id] = ['reject400'];
  addJob({ groups: [1, 2, 3, 4] });
  await runUntilIdle();
  assert.equal(getSetting('paused', false), true);
  assert.equal(gw.calls[G(4).id], undefined, 'stopped before the 4th group');
  assert.ok(db.prepare("SELECT 1 FROM alert_log WHERE key='breaker' AND open=1").get());
});

test('duplicate guard: same text to same group from another job is blocked; "Send again" overrides', async () => {
  addGroups(1);
  addJob({ groups: [1], message: 'Same text' });
  await runUntilIdle();
  const b = addJob({ groups: [1], message: 'Same text' });
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 1);
  assert.equal(sends(b)[0].status, 'blocked_duplicate');
  sched.sendAgain(b, G(1).id, 'tester');
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 2);
  assert.equal(job(b).status, 'done');
});

test('weekly repeat: sends once, moves to a future day, never the same day', async () => {
  addGroups(1);
  const id = addJob({ groups: [1], repeat: [0, 1, 2, 3, 4, 5, 6] });
  await runUntilIdle();
  await runUntilIdle();
  assert.equal(sentTo(G(1).id), 1);
  const j = job(id);
  assert.equal(j.status, 'scheduled');
  assert.ok(j.run_at > Date.now() + 6 * 3600e3 - 60e3, 'next run is at least ~a day away');
});

test('server was down for days: a weekly message is marked missed once and skips ahead, no burst', async () => {
  addGroups(1);
  const old = Date.now() - 10 * 86400e3;
  const id = addJob({ groups: [1], runAt: old, repeat: [0, 1, 2, 3, 4, 5, 6] });
  await runUntilIdle();
  await runUntilIdle();
  assert.equal(gw.delivered.length, 0);
  const j = job(id);
  assert.ok(j.run_at > Date.now(), 'jumped to the future');
  assert.equal(sends(id).filter(s => s.status === 'missed').length, 1);
});

test('one-off message far too late is marked missed, not sent at an odd hour', async () => {
  addGroups(1);
  const id = addJob({ groups: [1], runAt: Date.now() - 5 * 3600e3 });
  await runUntilIdle();
  assert.equal(gw.delivered.length, 0);
  assert.equal(sends(id)[0].status, 'missed');
});

test('daily limit: stops at the cap and continues next morning (09:00-09:30 IST), not at midnight', async () => {
  setSetting('daily_cap', 1);
  addGroups(1, 2);
  const id = addJob({ groups: [1, 2] });
  await runUntilIdle();
  assert.equal(gw.delivered.length, 1);
  const t = time.epochToIst(job(id).start_at).time;
  assert.ok(t >= '09:00' && t <= '09:30', `resumes at ${t}`);
});

test('another copy holds the sender lock: this copy sends nothing', async () => {
  addGroups(1);
  db.prepare("INSERT INTO locks(name,owner,expires_at) VALUES('sender','other-copy',?)").run(Date.now() + 60e3);
  addJob({ groups: [1] });
  await sched.tick();
  assert.equal(gw.delivered.length, 0);
  db.prepare("UPDATE locks SET expires_at=? WHERE name='sender'").run(Date.now() - 1);
  await runUntilIdle();
  assert.equal(gw.delivered.length, 1);
});

test('WhatsApp disconnected: nothing sends; resumes after reconnect without duplicates', async () => {
  addGroups(1, 2);
  gw.status = 'disconnected';
  const id = addJob({ groups: [1, 2] });
  await sched.tick();
  assert.equal(gw.delivered.length, 0);
  assert.match(job(id).note, /WhatsApp/);
  gw.status = 'ready';
  await runUntilIdle();
  assert.deepEqual([sentTo(G(1).id), sentTo(G(2).id)], [1, 1]);
});

test('cancel while sending: remaining groups are not sent', async () => {
  addGroups(1, 2, 3);
  const id = addJob({ groups: [1, 2, 3], gap: 400 });
  const run = sched.tick();
  while (gw.delivered.length < 1) await new Promise(r => setTimeout(r, 5));
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);
  await run;
  await runUntilIdle();
  assert.equal(gw.delivered.length, 1);
});

test('group removed from the saved list: skipped with a reason, others still sent', async () => {
  addGroups(1);
  const id = addJob({ groups: [1, 2] });
  await runUntilIdle();
  const s = sends(id);
  assert.equal(s.find(x => x.group_id === G(2).id).status, 'skipped');
  assert.equal(sentTo(G(1).id), 1);
});

test('every send and failure is written to the event log', async () => {
  addGroups(1, 2);
  gw.behaviour[G(2).id] = ['reject400'];
  addJob({ groups: [1, 2] });
  await runUntilIdle();
  const ev = db.prepare("SELECT level, kind, message FROM events WHERE kind='send'").all();
  assert.ok(ev.some(e => e.level === 'info' && /Sent/.test(e.message)));
  assert.ok(ev.some(e => e.level === 'error' && /Failed/.test(e.message)));
});

test('image from a link: sent by link, nothing stored on the server', async () => {
  addGroups(1);
  const before = fs.readdirSync(path.join(DATA, 'media')).length;
  addJob({ groups: [1], message: 'Poster for Saturday 👇', mediaUrl: 'https://example.com/poster.png' });
  await runUntilIdle();
  assert.equal(gw.delivered[0].url, 'https://example.com/poster.png');
  assert.equal(gw.delivered[0].text, 'Poster for Saturday 👇');
  assert.equal(fs.readdirSync(path.join(DATA, 'media')).length, before);
});

test('link preview switched off is passed to WhatsApp; on by default', async () => {
  addGroups(1, 2);
  addJob({ groups: [1], message: 'Read this https://example.com/blog', linkPreview: 0 });
  await runUntilIdle();
  addJob({ groups: [2], message: 'And this https://example.com/guide' });
  await runUntilIdle();
  assert.equal(gw.delivered.find(d => d.chatId === G(1).id).linkPreview, false);
  assert.equal(gw.delivered.find(d => d.chatId === G(2).id).linkPreview, true);
});

test('uploaded image: sent, then deleted 3 days after the message is done; weekly messages keep theirs', async () => {
  addGroups(1);
  const media = path.join(DATA, 'media');
  fs.writeFileSync(path.join(media, 'a.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(media, 'b.png'), Buffer.from([137, 80, 78, 71]));
  const once = addJob({ groups: [1], message: 'With image', mediaFile: 'a.png' });
  await runUntilIdle();
  assert.equal(gw.delivered[0].base64, true);
  const weekly = addJob({ groups: [1], message: 'Weekly with image', mediaFile: 'b.png', runAt: Date.now() + 86400e3, repeat: [1] });
  sched.purgeMedia(Date.now());                       // too soon: kept for "Send again"
  assert.ok(fs.existsSync(path.join(media, 'a.png')));
  db.prepare('UPDATE jobs SET updated_at=? WHERE id IN (?,?)').run(Date.now() - 4 * 86400e3, once, weekly);
  sched.purgeMedia(Date.now());
  assert.ok(!fs.existsSync(path.join(media, 'a.png')), 'one-off image deleted');
  assert.equal(job(once).media_purged, 1);
  assert.ok(fs.existsSync(path.join(media, 'b.png')), 'weekly image kept');
});

test('"Send again" after the image was deleted asks to duplicate instead of sending without it', async () => {
  addGroups(1);
  gw.behaviour[G(1).id] = ['reject400'];
  const id = addJob({ groups: [1], message: 'Img msg', mediaUrl: null });
  await runUntilIdle();
  db.prepare('UPDATE jobs SET media_purged=1 WHERE id=?').run(id);
  assert.throws(() => sched.sendAgain(id, G(1).id, 'tester'), /Duplicate/);
});

test('unused image files (e.g. replaced while editing) are cleaned up', async () => {
  const f = path.join(DATA, 'media', 'orphan.png');
  fs.writeFileSync(f, Buffer.from([1]));
  const old = (Date.now() - 2 * 3600e3) / 1000; fs.utimesSync(f, old, old);
  sched.purgeMedia(Date.now());
  assert.ok(!fs.existsSync(f));
});
