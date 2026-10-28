const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true, mode: 0o700 });

const db = new Database(path.join(DATA_DIR, 'wabox.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  must_change INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  media_file TEXT,
  media_mime TEXT,
  groups_json TEXT NOT NULL,
  time_ist TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  gap_min INTEGER NOT NULL,
  gap_max INTEGER NOT NULL,
  repeat_days TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'scheduled',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, start_at);
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  occurrence INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_at INTEGER,
  day_key TEXT,
  UNIQUE(job_id, occurrence, group_id)
);
CREATE INDEX IF NOT EXISTS sends_day ON sends(day_key, status);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`);

// ---------- migrations (add columns safely to existing databases) ----------
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('sends', 'msg_hash', 'TEXT');
addColumn('sends', 'attempt_at', 'INTEGER');
addColumn('sends', 'wa_message_id', 'TEXT');
addColumn('sends', 'override', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sends', 'verified', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE INDEX IF NOT EXISTS sends_dedupe ON sends(group_id, msg_hash);
CREATE INDEX IF NOT EXISTS sends_status ON sends(status);
-- System event log: every send attempt, outcome, connection change and error.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  job_id INTEGER,
  group_name TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
-- Single-sender lock so two app copies (e.g. during a redeploy) can never both send.
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_log (
  key TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL,
  open INTEGER NOT NULL DEFAULT 1,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
`);

/** Write to the event log (and the container log). level: info | warn | error */
function logEvent(level, kind, message, { jobId = null, group = null } = {}) {
  const line = `[${level}] ${kind}${jobId ? ` #${jobId}` : ''}${group ? ` (${group})` : ''}: ${message}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  try {
    db.prepare('INSERT INTO events(at,level,kind,job_id,group_name,message) VALUES(?,?,?,?,?,?)')
      .run(Date.now(), level, kind, jobId, group, String(message).slice(0, 1000));
  } catch (e) { console.error('[events] could not write:', e.message); }
}
// Keep 180 days of events.
setInterval(() => { try { db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - 180 * 86400000); } catch { /* ignore */ } }, 6 * 3600 * 1000).unref();

const getSetting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));

const audit = (actor, action, detail = '') =>
  db.prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)').run(Date.now(), actor, action, String(detail).slice(0, 500));

module.exports = { db, DATA_DIR, getSetting, setSetting, audit, logEvent };
