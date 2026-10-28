// Alerts: tell a human when something needs attention, even if nobody has the app open.
// Channels (set by an admin in Settings):
//   - Webhook URL: Slack, Google Chat, Discord, or anything that accepts a JSON POST.
//   - WhatsApp: a short note to admin phone numbers, sent from the connected number.
// Each alert key fires at most once per hour while the problem lasts, and is listed
// as an open issue in the System page until it clears.
const { db, getSetting, logEvent } = require('./db');
const wa = require('./wa');
const { epochToIst } = require('./time');

const REPEAT_MS = 60 * 60 * 1000;

function config() {
  return {
    webhookUrl: getSetting('alert_webhook', ''),
    waNumbers: getSetting('alert_wa_numbers', []),
    digest: getSetting('alert_digest', true),
    appUrl: process.env.PUBLIC_URL || 'https://wabox.example.com/wabox/',
  };
}

async function deliver(text, { waReady = false } = {}) {
  const cfg = config();
  const results = [];
  if (cfg.webhookUrl) {
    try {
      const r = await fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10000) });
      results.push(r.ok ? 'webhook' : `webhook HTTP ${r.status}`);
    } catch (e) { results.push('webhook failed: ' + e.message); }
  }
  if (cfg.waNumbers.length && waReady) {
    for (const n of cfg.waNumbers) {
      try { await wa.sendText(`${n}@c.us`, text); results.push('whatsapp ' + n); }
      catch (e) { results.push(`whatsapp ${n} failed: ${e.message}`); }
    }
  }
  return results;
}

/**
 * Raise (or refresh) an issue. Delivers at most once per hour per key.
 * level: warn | error
 */
async function raise(key, level, message, { waReady = false } = {}) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM alert_log WHERE key=?').get(key);
  db.prepare(`INSERT INTO alert_log(key,last_at,open,level,message) VALUES(?,?,1,?,?)
    ON CONFLICT(key) DO UPDATE SET open=1, level=excluded.level, message=excluded.message`).run(key, row?.last_at || 0, level, message);
  if (row?.open && now - row.last_at < REPEAT_MS) return;
  db.prepare('UPDATE alert_log SET last_at=? WHERE key=?').run(now, key);
  const icon = level === 'error' ? '🔴' : '🟠';
  const text = `${icon} WA Box: ${message}\n${config().appUrl}`;
  const res = await deliver(text, { waReady });
  logEvent(level, 'alert', `${message}${res.length ? ` [sent via ${res.join(', ')}]` : ' [no alert channel set up]'}`);
}

/** Mark an issue as resolved (and say so, if it had been announced). */
async function clear(key, message, { waReady = false } = {}) {
  const row = db.prepare('SELECT * FROM alert_log WHERE key=? AND open=1').get(key);
  if (!row) return;
  db.prepare('UPDATE alert_log SET open=0 WHERE key=?').run(key);
  if (message) {
    await deliver(`🟢 WA Box: ${message}`, { waReady });
    logEvent('info', 'alert_cleared', message);
  }
}

function openIssues() {
  return db.prepare('SELECT key, level, message, last_at FROM alert_log WHERE open=1 ORDER BY last_at DESC').all();
}

async function test(by) {
  const res = await deliver(`✅ WA Box test alert from ${by}. If you can read this, alerts work.`, { waReady: true });
  logEvent('info', 'alert_test', `Test alert by ${by}: ${res.join(', ') || 'no channel set up'}`);
  return res;
}

/** Morning digest. If it doesn't arrive, something is wrong. */
async function digest({ waReady, summary }) {
  if (!config().digest) return;
  const { date } = epochToIst(Date.now());
  const key = 'digest:' + date;
  if (db.prepare('SELECT 1 FROM alert_log WHERE key=?').get(key)) return;
  db.prepare('INSERT INTO alert_log(key,last_at,open,level,message) VALUES(?,?,0,?,?)').run(key, Date.now(), 'info', 'digest');
  const res = await deliver(`☀️ WA Box daily check\n${summary}`, { waReady });
  logEvent('info', 'digest', `${summary.replace(/\n/g, ' | ')} [sent via ${res.join(', ') || 'no channel'}]`);
}

module.exports = { raise, clear, openIssues, test, digest, config };
