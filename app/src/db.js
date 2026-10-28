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

const getSetting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));

const audit = (actor, action, detail = '') =>
  db.prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)').run(Date.now(), actor, action, String(detail).slice(0, 500));

module.exports = { db, DATA_DIR, getSetting, setSetting, audit };
