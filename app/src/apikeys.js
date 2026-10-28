// API keys for the public API (/api/v1). A key is shown once when it is made; only its
// SHA-256 hash is stored, so a leaked database does not leak working keys.
//
// Scopes, from least to most:
//   read      look only: status, groups, lists, messages
//   schedule  read + schedule messages + cancel the messages this key scheduled
//   full      schedule + cancel any message
// A key can also be limited to some saved group lists: it then only sees and sends to those groups.
const crypto = require('node:crypto');
const { db, audit } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read','schedule','full')),
  list_ids TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
-- Idempotency-Key: the same key + same request within 24 h returns the first answer
-- instead of scheduling the message twice (e.g. a script that retried after a timeout).
CREATE TABLE IF NOT EXISTS idempotency (
  key_id INTEGER NOT NULL,
  idem_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);
`);

const SCOPES = ['read', 'schedule', 'full'];
const RANK = { read: 0, schedule: 1, full: 2 };
const IDEM_WINDOW_MS = 24 * 3600 * 1000;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomToken(n) {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];   // 57 symbols; tiny bias is irrelevant at 32 chars
  return out;
}

function shape(r) {
  return { id: r.id, name: r.name, prefix: r.prefix, scope: r.scope, listIds: r.list_ids ? JSON.parse(r.list_ids) : null,
    createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at };
}

/** Make a key. Returns { key, ...info }; `key` is never retrievable again. */
function create({ name, scope = 'schedule', listIds = null }, by) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('Give the key a name, e.g. "Google Sheet"'), { status: 400 });
  if (!SCOPES.includes(scope)) throw Object.assign(new Error('Scope must be read, schedule or full'), { status: 400 });
  let lists = null;
  if (Array.isArray(listIds) && listIds.length) {
    lists = [...new Set(listIds.map(Number))].filter(id => db.prepare('SELECT 1 FROM group_lists WHERE id=?').get(id));
    if (!lists.length) throw Object.assign(new Error('Those group lists no longer exist'), { status: 400 });
  }
  const key = 'wbx_' + randomToken(32);
  const r = db.prepare('INSERT INTO api_keys(name,prefix,hash,scope,list_ids,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(name, key.slice(0, 10), sha256(key), scope, lists ? JSON.stringify(lists) : null, by, Date.now());
  audit(by, 'api_key_created', `${name} (${scope}${lists ? `, lists ${lists.join(',')}` : ''})`);
  return { key, ...shape(db.prepare('SELECT * FROM api_keys WHERE id=?').get(r.lastInsertRowid)) };
}

function list() {
  return db.prepare('SELECT * FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC').all().map(shape);
}

function revoke(id, by) {
  const k = db.prepare('SELECT * FROM api_keys WHERE id=?').get(Number(id));
  if (!k) throw Object.assign(new Error('Key not found'), { status: 404 });
  if (!k.revoked_at) db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(Date.now(), k.id);
  audit(by, 'api_key_revoked', k.name);
}

/** Look up a raw key. Returns the key's info, or null if unknown or revoked. */
function verify(raw) {
  raw = String(raw || '').trim();
  if (!/^wbx_[A-Za-z0-9]{32}$/.test(raw)) return null;
  const k = db.prepare('SELECT * FROM api_keys WHERE hash=?').get(sha256(raw));
  if (!k || k.revoked_at) return null;
  // Write "last used" at most once a minute.
  if (!k.last_used_at || Date.now() - k.last_used_at > 60000) db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(Date.now(), k.id);
  return shape(k);
}

const allows = (key, need) => RANK[key.scope] >= RANK[need];

/** Group ids this key may use, or null for "all saved groups". */
function allowedGroupIds(key) {
  if (!key.listIds) return null;
  const ids = new Set();
  for (const id of key.listIds) {
    const l = db.prepare('SELECT group_ids FROM group_lists WHERE id=?').get(id);
    if (l) for (const g of JSON.parse(l.group_ids)) ids.add(g);
  }
  return ids;
}

// ---------- idempotency ----------
function idemGet(keyId, idemKey, body) {
  db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(Date.now() - IDEM_WINDOW_MS);
  const row = db.prepare('SELECT * FROM idempotency WHERE key_id=? AND idem_key=?').get(keyId, idemKey);
  if (!row) return null;
  if (row.body_hash !== sha256(JSON.stringify(body ?? {}))) return { conflict: true };
  return { status: row.status, body: JSON.parse(row.response) };
}
function idemPut(keyId, idemKey, body, status, response) {
  db.prepare('INSERT OR REPLACE INTO idempotency(key_id,idem_key,body_hash,status,response,created_at) VALUES(?,?,?,?,?,?)')
    .run(keyId, idemKey, sha256(JSON.stringify(body ?? {})), status, JSON.stringify(response), Date.now());
}

module.exports = { create, list, revoke, verify, allows, allowedGroupIds, idemGet, idemPut, SCOPES };
