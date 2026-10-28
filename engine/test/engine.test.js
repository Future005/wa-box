// Evals for the engine, using a fake WhatsApp client (no Chrome needed).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
const { Engine } = require('../src/engine');
const { createServer } = require('../src/server');
const KEY = 'e'.repeat(64);

// ---------- fake whatsapp-web.js ----------
let made = [];
class FakeClient extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.sent = []; this.state = 'CONNECTED'; this.destroyed = false; made.push(this); }
  async initialize() { setImmediate(() => { this.emit('qr', 'qr-data'); if (FakeClient.autoReady) { this.emit('authenticated'); this.info = { wid: { user: '919000000000' }, pushname: 'Acme Academy' }; this.emit('ready'); } }); }
  async getWWebVersion() { return '2.3000.1012345678'; }
  async getState() { if (this.hang) return new Promise(() => {}); return this.state; }
  async destroy() { this.destroyed = true; }
  async logout() {}
  async getChats() { return [{ isGroup: true, id: { _serialized: '1@g.us' }, name: 'A' }, { isGroup: false, id: { _serialized: '9@c.us' }, name: 'Someone' }]; }
  async getChatById(id) { return { fetchMessages: async () => this.sent.filter(s => s.chatId === id).map((s, i) => ({ id: { _serialized: 'm' + i }, body: typeof s.content === 'string' ? s.content : s.opts.caption, fromMe: true, timestamp: 1 })), sendStateTyping: async () => {}, clearState: async () => {} }; }
  async getMessageById(id) { return this.sent.find(s => s.id === id) ? { ack: 1 } : null; }
  async sendMessage(chatId, content, opts) { if (this.failSend) throw new Error('Evaluation failed'); const id = 'true_' + chatId + '_' + this.sent.length; this.sent.push({ chatId, content, opts, id }); return { id: { _serialized: id } }; }
}
FakeClient.autoReady = true;
class FakeAuth { constructor(o) { this.o = o; } }
class FakeMedia { constructor(mimetype, data) { this.mimetype = mimetype; this.data = data; } static async fromUrl() { return new FakeMedia('image/png', 'x'); } }

const tick = () => new Promise(r => setTimeout(r, 20));
let engine, server, base;
async function boot() {
  engine = new Engine({ ClientImpl: FakeClient, LocalAuthImpl: FakeAuth, chromePath: '/bin/false' });
  server = createServer(engine, { apiKey: KEY, MessageMediaImpl: FakeMedia });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const call = async (method, p, body, key = KEY) => {
  const r = await fetch(base + p, { method, headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
beforeEach(async () => { made = []; FakeClient.autoReady = true; delete process.env.WA_WEB_VERSION; if (server) { server.closeAllConnections(); server.close(); } fs.rmSync(path.join(process.env.DATA_DIR, 'last-good-wa-version.txt'), { force: true }); await boot(); });

test('rejects requests without the key; /health is open', async () => {
  assert.equal((await call('GET', '/status', null, 'wrong')).status, 401);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('refuses to start with a missing or short API key', () => {
  assert.throws(() => createServer(engine, { apiKey: 'short' }));
});

test('start -> QR -> ready; records the WhatsApp Web version that worked', async () => {
  FakeClient.autoReady = false;
  await engine.start(); await tick();
  assert.equal(engine.status, 'qr_ready');
  assert.match((await call('GET', '/qr')).body.qrCode, /^data:image\/png;base64,/);
  made[0].info = { wid: { user: '919000000000' }, pushname: 'Acme Academy' }; made[0].emit('ready'); await tick();
  const s = (await call('GET', '/status')).body;
  assert.equal(s.status, 'ready'); assert.equal(s.phone, '919000000000');
  assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR, 'last-good-wa-version.txt'), 'utf8'), '2.3000.1012345678');
});

test('not ready: sends are refused with 409 (= definitely not sent)', async () => {
  const r = await call('POST', '/send-text', { chatId: '1@g.us', text: 'hi' });
  assert.equal(r.status, 409);
});

test('send text passes link preview choice and returns the message id', async () => {
  await engine.start(); await tick();
  const r = await call('POST', '/send-text', { chatId: '1@g.us', text: 'Read https://example.com', linkPreview: false });
  assert.equal(r.status, 200); assert.match(r.body.messageId, /^true_/);
  assert.equal(made[0].sent[0].opts.linkPreview, false);
});

test('bad input is rejected with 400 before anything is sent', async () => {
  await engine.start(); await tick();
  assert.equal((await call('POST', '/send-text', { chatId: 'nonsense', text: 'hi' })).status, 400);
  assert.equal((await call('POST', '/send-image', { chatId: '1@g.us', base64: 'AA==', mimetype: 'application/pdf' })).status, 400);
  assert.equal((await call('POST', '/send-image', { chatId: '1@g.us', url: 'https://127.0.0.1/x.png' })).status, 400);
  assert.equal(made[0].sent.length, 0);
});

test('a failure inside WhatsApp Web is a 5xx (= maybe sent, WA Box checks the chat)', async () => {
  await engine.start(); await tick();
  made[0].failSend = true;
  assert.equal((await call('POST', '/send-text', { chatId: '1@g.us', text: 'hi' })).status, 500);
});

test('groups lists only groups; history returns our sent messages', async () => {
  await engine.start(); await tick();
  assert.deepEqual((await call('GET', '/groups')).body, [{ id: '1@g.us', name: 'A' }]);
  await call('POST', '/send-text', { chatId: '1@g.us', text: 'hello' });
  const h = (await call('GET', '/history?chatId=1@g.us&limit=10')).body;
  assert.equal(h[0].body, 'hello'); assert.equal(h[0].fromMe, true);
});

test('connection drop: reconnects by itself', async () => {
  await engine.start(); await tick();
  engine.restart = async function (reason) { this.restartedFor = reason; };
  made[0].emit('disconnected', 'NAVIGATION');
  assert.equal(engine.status, 'disconnected');
  assert.equal(engine.restartedFor, 'connection dropped');
});

test('Chrome stops answering 3 checks in a row: restarted', async () => {
  await engine.start(); await tick();
  let restarted = null;
  engine.restart = async r => { restarted = r; };
  made[0].state = 'CONFLICT';
  await engine.watchdog(); await engine.watchdog();
  assert.equal(restarted, null);
  await engine.watchdog();
  assert.equal(restarted, 'Chrome stopped answering');
});

test('after 2 failed starts it pins the last WhatsApp Web version that worked', async () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'last-good-wa-version.txt'), '2.3000.1000000000');
  engine.initFailures = 1;
  assert.deepEqual(engine.versionPin(), { webVersionCache: { type: 'none' } });
  engine.initFailures = 2;
  const pin = engine.versionPin();
  assert.equal(pin.webVersion, '2.3000.1000000000');
  assert.match(pin.webVersionCache.remotePath, /wa-version\/main\/html\/2\.3000\.1000000000\.html$/);
  process.env.WA_WEB_VERSION = '2.3000.1111111111'; engine.initFailures = 0;
  assert.equal(engine.versionPin().webVersion, '2.3000.1111111111');
});

test('restart waits for a message that is being sent', async () => {
  await engine.start(); await tick();
  engine.inFlight = 1;
  const t0 = Date.now();
  setTimeout(() => { engine.inFlight = 0; }, 300);
  await engine.restart('test');
  assert.ok(Date.now() - t0 >= 280, 'waited for the send to finish');
  assert.equal(made[0].destroyed, true);
});

test('delivery receipts: from WhatsApp events when seen, else asked from WhatsApp Web', async () => {
  await engine.start(); await tick();
  const a = (await call('POST', '/send-text', { chatId: '1@g.us', text: 'one' })).body.messageId;
  const b = (await call('POST', '/send-text', { chatId: '1@g.us', text: 'two' })).body.messageId;
  made[0].emit('message_ack', { fromMe: true, id: { _serialized: a } }, 2);
  const r = (await call('POST', '/receipts', { ids: [a, b] })).body;
  assert.equal(r[a], 2, 'delivered (from event)');
  assert.equal(r[b], 1, 'sent (asked WhatsApp Web)');
  assert.equal((await call('POST', '/receipts', { ids: [] })).status, 400);
});

after(() => { server.closeAllConnections(); server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
