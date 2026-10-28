// Outgoing webhooks: tell another system when a message starts, finishes, or a group fails.
//
// Every delivery is written to the database first, then POSTed. A delivery that doesn't get a
// 2xx is retried after 1 min, 5 min, 30 min, 2 h and 6 h, then marked failed and shown on the
// API page (and raised as an alert), so nothing is dropped quietly.
//
// Each request is signed:  X-WABox-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
const crypto = require('node:crypto');
const { db, audit, logEvent } = require('./db');
const alerts = require('./alerts');

db.exec(`
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hook_deliveries (
  id INTEGER PRIMARY KEY,
  hook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS hook_due ON hook_deliveries(status, next_at);
`);

const EVENTS = ['message.started', 'message.finished', 'group.failed'];
const BACKOFF_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3];   // then give up
const TIMEOUT_MS = Number(process.env.WABOX_HOOK_TIMEOUT_MS || 10000);
const bad = m => Object.assign(new Error(m), { status: 400 });

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw bad("That webhook address doesn't look right"); }
  const localHttp = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    && (process.env.WABOX_LOCAL === 'true' || process.env.WABOX_ALLOW_HTTP_HOOKS === '1');
  if (u.protocol !== 'https:' && !localHttp) throw bad('The webhook address must start with https://');
  if (u.href.length > 500) throw bad('The webhook address is too long');
  return u.href;
}

const shape = h => ({ id: h.id, url: h.url, events: JSON.parse(h.events), createdBy: h.created_by, createdAt: h.created_at, disabled: !!h.disabled,
  lastDelivery: db.prepare('SELECT status, last_code, created_at FROM hook_deliveries WHERE hook_id=? ORDER BY id DESC LIMIT 1').get(h.id) || null });

/** Add a webhook. Returns its signing secret once. */
function add({ url, events }, by) {
  url = checkUrl(url);
  const evs = Array.isArray(events) && events.length ? [...new Set(events)].filter(e => EVENTS.includes(e)) : EVENTS;
  if (!evs.length) throw bad('Pick at least one event');
  if (db.prepare('SELECT COUNT(*) n FROM webhooks').get().n >= 10) throw bad('Up to 10 webhooks');
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const r = db.prepare('INSERT INTO webhooks(url,secret,events,created_by,created_at) VALUES(?,?,?,?,?)').run(url, secret, JSON.stringify(evs), by, Date.now());
  audit(by, 'webhook_added', `${url} (${evs.join(', ')})`);
  return { secret, ...shape(db.prepare('SELECT * FROM webhooks WHERE id=?').get(r.lastInsertRowid)) };
}
function remove(id, by) {
  const h = db.prepare('SELECT * FROM webhooks WHERE id=?').get(Number(id));
  if (!h) throw Object.assign(new Error('Webhook not found'), { status: 404 });
  db.prepare('DELETE FROM webhooks WHERE id=?').run(h.id);
  audit(by, 'webhook_removed', h.url);
}
const list = () => db.prepare('SELECT * FROM webhooks ORDER BY id').all().map(shape);
const deliveries = (limit = 50) => db.prepare(`SELECT d.id, d.hook_id, w.url, d.event, d.status, d.attempts, d.next_at, d.last_code, d.last_error, d.created_at, d.delivered_at
  FROM hook_deliveries d JOIN webhooks w ON w.id = d.hook_id ORDER BY d.id DESC LIMIT ?`).all(limit);

function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Queue an event for every webhook that wants it, then try to deliver right away. */
function emit(event, data, { onlyHookId = null } = {}) {
  try {
    const hooks = db.prepare('SELECT * FROM webhooks WHERE disabled=0').all()
      .filter(h => onlyHookId ? h.id === onlyHookId : JSON.parse(h.events).includes(event));
    if (!hooks.length) return 0;
    const now = Date.now();
    const ins = db.prepare('INSERT INTO hook_deliveries(hook_id,event,payload,next_at,created_at) VALUES(?,?,?,?,?)');
    for (const h of hooks) {
      const id = ins.run(h.id, event, '', now, now).lastInsertRowid;
      const payload = JSON.stringify({ id: `evt_${id}`, event, createdAt: new Date(now).toISOString(), data });
      db.prepare('UPDATE hook_deliveries SET payload=? WHERE id=?').run(payload, id);
    }
    setImmediate(() => pump().catch(e => logEvent('warn', 'webhook', e.message)));
    return hooks.length;
  } catch (e) {
    logEvent('error', 'webhook', `Could not queue ${event}: ${e.message}`);
    return 0;
  }
}

let pumping = false;
/** Deliver everything that is due. Safe to call often. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const due = db.prepare(`SELECT d.*, w.url, w.secret FROM hook_deliveries d JOIN webhooks w ON w.id = d.hook_id
      WHERE d.status='pending' AND d.next_at <= ? ORDER BY d.id LIMIT 25`).all(Date.now());
    for (const d of due) await deliverOne(d);
  } finally { pumping = false; }
}

async function deliverOne(d) {
  const attempts = d.attempts + 1;
  let code = null, error = null;
  try {
    const r = await fetch(d.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'WA-Box-Webhooks/1', 'X-WABox-Event': d.event,
        'X-WABox-Delivery': `evt_${d.id}`, 'X-WABox-Signature': sign(d.secret, d.payload) },
      body: d.payload });
    code = r.status;
    try { await r.body?.cancel(); } catch { /* ignore */ }
    if (r.ok) {
      db.prepare("UPDATE hook_deliveries SET status='ok', attempts=?, last_code=?, last_error=NULL, delivered_at=? WHERE id=?").run(attempts, code, Date.now(), d.id);
      return;
    }
    error = `Answered ${code}`;
  } catch (e) {
    error = /timeout|abort/i.test(e.name + e.message) ? `No answer within ${TIMEOUT_MS / 1000} s` : (e.cause?.code || e.message);
  }
  if (attempts > BACKOFF_MS.length) {
    db.prepare("UPDATE hook_deliveries SET status='failed', attempts=?, last_code=?, last_error=? WHERE id=?").run(attempts, code, error, d.id);
    logEvent('error', 'webhook', `Gave up delivering ${d.event} to ${d.url} after ${attempts} tries: ${error}`);
    alerts.raise(`hook:${d.hook_id}`, 'warn', `A webhook (${d.url}) stopped answering. ${d.event} could not be delivered after ${attempts} tries (${error}). See API → Webhooks.`).catch(() => {});
    return;
  }
  db.prepare('UPDATE hook_deliveries SET attempts=?, last_code=?, last_error=?, next_at=? WHERE id=?')
    .run(attempts, code, error, Date.now() + BACKOFF_MS[attempts - 1], d.id);
  logEvent('warn', 'webhook', `${d.event} to ${d.url}: ${error}. Retrying in ${Math.round(BACKOFF_MS[attempts - 1] / 60000)} min`);
}

/** Send a "ping" to one webhook so the person setting it up can see it arrive. */
function test(id) {
  const h = db.prepare('SELECT * FROM webhooks WHERE id=?').get(Number(id));
  if (!h) throw Object.assign(new Error('Webhook not found'), { status: 404 });
  emit('ping', { message: 'Hello from WA Box. This webhook works.' }, { onlyHookId: h.id });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => pump().catch(() => {}), 30 * 1000);
  timer.unref?.();
  // Keep 30 days of delivery history.
  setInterval(() => { try { db.prepare("DELETE FROM hook_deliveries WHERE created_at < ? AND status != 'pending'").run(Date.now() - 30 * 86400e3); } catch { /* ignore */ } }, 6 * 3600e3).unref?.();
}

module.exports = { add, remove, list, deliveries, emit, pump, test, sign, start, EVENTS, BACKOFF_MS, checkUrl };
