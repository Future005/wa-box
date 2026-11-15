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
