// Saved group list. WhatsApp is only asked for the group list when someone presses
// "Sync from WhatsApp" (or once, automatically, the first time WhatsApp connects).
// Everything else (the picker, job validation, the scheduler) reads this table instantly.
const { db, getSetting, setSetting, audit } = require('./db');
const wa = require('./gateway');

db.exec(`
CREATE TABLE IF NOT EXISTS wa_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`);

const DEFAULT_KEYWORDS = ['Cohort', 'Masterclass'];
const MIN_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

const sync = { running: false, startedAt: 0, finishedAt: getSetting('groups_synced_at', 0), error: null, total: 0, matched: 0, by: null };

function keywords() {
  const k = getSetting('group_keywords', DEFAULT_KEYWORDS);
  return Array.isArray(k) ? k : DEFAULT_KEYWORDS;
}
function setKeywords(list) {
  const clean = [...new Set((list || []).map(s => String(s).trim()).filter(Boolean).map(s => s.slice(0, 40)))].slice(0, 20);
  setSetting('group_keywords', clean);
  return clean;
}
function matches(name, kws = keywords()) {
  if (!kws.length) return true; // no keywords = keep every group
  const n = name.toLowerCase();
  return kws.some(k => n.includes(k.toLowerCase()));
}

function list() {
  const kws = keywords();
  return db.prepare('SELECT id, name FROM wa_groups WHERE active = 1 ORDER BY name COLLATE NOCASE').all()
    .filter(g => matches(g.name, kws));
}
function get(id) {
  return db.prepare('SELECT id, name FROM wa_groups WHERE id = ? AND active = 1').get(id);
}
function count() {
  return db.prepare('SELECT COUNT(*) n FROM wa_groups WHERE active = 1').get().n;
}

async function runSync(by) {
  sync.running = true; sync.startedAt = Date.now(); sync.error = null; sync.by = by;
  try {
    // One read of the chat list that WhatsApp Web already holds in the browser.
    const all = await wa.listGroups({ timeoutMs: SYNC_TIMEOUT_MS });
    const kws = keywords();
    const keep = all.filter(g => matches(g.name, kws));
    const now = Date.now();
    const upsert = db.prepare(`INSERT INTO wa_groups(id,name,active,updated_at) VALUES(?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=1, updated_at=excluded.updated_at`);
    db.transaction(() => {
      // Groups not seen this time (left, or no longer matching) become inactive.
      db.prepare('UPDATE wa_groups SET active = 0').run();
      for (const g of keep) upsert.run(g.id, g.name, now);
    })();
    sync.total = all.length; sync.matched = keep.length;
    sync.finishedAt = now; setSetting('groups_synced_at', now);
    audit(by, 'groups_synced', `${keep.length} of ${all.length} groups match ${kws.join(', ') || '(all)'}`);
  } catch (e) {
    sync.error = /timeout|aborted/i.test(e.message)
      ? 'WhatsApp is still loading your chats. Wait a few minutes and sync again.'
      : e.message;
  } finally {
    sync.running = false;
  }
}

/** Start a background sync. Returns an error string if it can't start. */
function startSync(by) {
  if (sync.running) return null;
  if (Date.now() - sync.startedAt < MIN_SYNC_INTERVAL_MS) return 'Synced very recently. Try again in a couple of minutes.';
  runSync(by);
  return null;
}

function status() {
  return { ...sync, keywords: keywords(), saved: list().length };
}

// ---------- saved group lists ("Weekend cohorts", "Thu-Fri batch") ----------
db.exec(`
CREATE TABLE IF NOT EXISTS group_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  group_ids TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function lists() {
  return db.prepare('SELECT * FROM group_lists ORDER BY name COLLATE NOCASE').all().map(l => {
    const ids = JSON.parse(l.group_ids);
    const groups = ids.map(id => get(id) || { id, name: null });
    return { id: l.id, name: l.name, createdBy: l.created_by, updatedAt: l.updated_at,
      groups: groups.filter(g => g.name), missing: groups.filter(g => !g.name).length };
  });
}
function saveList({ id, name, groupIds }, by) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the list a name');
  const ids = [...new Set((groupIds || []).map(String))].filter(gid => get(gid));
  if (!ids.length) throw new Error('Pick at least one group for the list');
  if (ids.length > 50) throw new Error('A list can have up to 50 groups');
  const now = Date.now();
  if (id) {
    const r = db.prepare('UPDATE group_lists SET name=?, group_ids=?, updated_at=? WHERE id=?').run(name, JSON.stringify(ids), now, Number(id));
    if (!r.changes) throw new Error('List not found');
    return Number(id);
  }
  return db.prepare('INSERT INTO group_lists(name,group_ids,created_by,updated_at) VALUES(?,?,?,?)').run(name, JSON.stringify(ids), by, now).lastInsertRowid;
}
function deleteList(id) { db.prepare('DELETE FROM group_lists WHERE id=?').run(Number(id)); }

module.exports = { list, get, count, startSync, status, keywords, setKeywords, matches, lists, saveList, deleteList };
