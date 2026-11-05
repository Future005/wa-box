// Number profiles. Every WhatsApp number that has been linked keeps its own groups, group lists and
// messages, like separate email accounts. One number is linked (live) at a time: its messages send.
// Link a different number and the previous one's data is kept aside; its scheduled messages wait.
// Link it again later and everything is back. Groups are read from WhatsApp only on sync.
const { db, getSetting, setSetting, audit, addColumn } = require('./db');
const wa = require('./wa');

db.exec(`
CREATE TABLE IF NOT EXISTS wa_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS numbers (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  first_linked_at INTEGER NOT NULL,
  last_linked_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS number_groups (
  phone TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  missed_syncs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone, id)
);
`);
addColumn('wa_groups', 'missed_syncs', 'INTEGER NOT NULL DEFAULT 0');
addColumn('jobs', 'phone', 'TEXT');

const MIN_SYNC_GAP_MS = 15 * 1000;            // only guards against double-clicks
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 2 * 60 * 1000;    // a failed sync retries by itself
const RECHECK_AFTER_LINK_MS = 10 * 60 * 1000; // WhatsApp keeps loading older chats after a new link
const REFRESH_EVERY_MS = 6 * 3600 * 1000;     // pick up new groups even if nobody presses Sync

/** The number WA Box works with: the linked one, or the last one linked. '' before any number. */
function current() { return getSetting('groups_phone', ''); }
const pick = p => (p === undefined || p === null ? current() : String(p));

// ---------- one-time move from the single-number layout ----------
(function migrate() {
  const cur = current();
  if (!cur) return;   // nothing linked yet: data is adopted by the first number that links
  if (!db.prepare('SELECT 1 FROM numbers WHERE phone=?').get(cur)) {
    db.prepare('INSERT INTO numbers(phone,first_linked_at,last_linked_at,synced_at) VALUES(?,?,?,?)').run(cur, Date.now(), Date.now(), getSetting('groups_synced_at', 0));
  }
  if (!db.prepare('SELECT 1 FROM number_groups LIMIT 1').get()) {
    db.prepare(`INSERT OR IGNORE INTO number_groups(phone,id,name,active,updated_at,missed_syncs)
      SELECT ?, id, name, 1, updated_at, missed_syncs FROM wa_groups WHERE active = 1`).run(cur);
  }
})();
/** Data made before numbers were tracked belongs to the number in use. */
function adopt(phone) {
  db.prepare("UPDATE jobs SET phone=? WHERE phone IS NULL OR phone=''").run(phone);
  db.prepare("UPDATE group_lists SET phone=? WHERE phone IS NULL OR phone=''").run(phone);
}

const sync = { running: false, startedAt: 0, error: null, total: 0, by: null, failures: 0, lastFailAt: 0, linkedAt: 0, rechecked: false, phone: '' };
const syncedAt = p => db.prepare('SELECT synced_at FROM numbers WHERE phone=?').get(pick(p))?.synced_at || 0;

function list(p) {
  return db.prepare('SELECT id, name FROM number_groups WHERE phone = ? AND active = 1 ORDER BY name COLLATE NOCASE').all(pick(p));
}
function get(id, p) {
  return db.prepare('SELECT id, name FROM number_groups WHERE phone = ? AND id = ? AND active = 1').get(pick(p), id);
}
function count(p) {
  return db.prepare('SELECT COUNT(*) n FROM number_groups WHERE phone = ? AND active = 1').get(pick(p)).n;
}

/**
 * Make `phone` the number in use. Nothing is deleted: the previous number's groups, lists and
 * messages stay with it, and its scheduled messages wait until it's linked again.
 */
function switchTo(phone, { name = '', by = 'system' } = {}) {
  phone = String(phone || '');
  if (!phone) return;
  const prev = current();
  const now = Date.now();
  db.prepare(`INSERT INTO numbers(phone,name,first_linked_at,last_linked_at) VALUES(?,?,?,?)
    ON CONFLICT(phone) DO UPDATE SET last_linked_at=excluded.last_linked_at, name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE numbers.name END`).run(phone, name, now, now);
  if (prev === phone) return;
  setSetting('groups_phone', phone);
  adopt(phone);
  Object.assign(sync, { error: null, total: 0, failures: 0, lastFailAt: 0, startedAt: 0, linkedAt: now, rechecked: false });
  audit(by, 'number_switched', prev ? `Now using +${phone}. +${prev} and its messages are kept; they wait until it's linked again.` : `Now using +${phone}`);
  const alerts = require('./alerts');
  alerts.clear(`number_waiting:${phone}`, `+${phone} is linked again. Its scheduled messages will go out.`).catch(() => {});
  if (prev) {
    const waiting = db.prepare("SELECT COUNT(*) n FROM jobs WHERE phone=? AND status IN ('scheduled','running')").get(prev).n;
    if (waiting) alerts.raise(`number_waiting:${prev}`, 'warn', `${waiting} scheduled message${waiting === 1 ? ' is' : 's are'} waiting for +${prev}, which isn't linked now. Link it again to send ${waiting === 1 ? 'it' : 'them'}, or open ${waiting === 1 ? 'it' : 'them'} (switch to +${prev} at the top left) to abort. Anything more than the late limit past its time is marked missed.`).catch(() => {});
  }
}
function name(p) { return db.prepare('SELECT name FROM numbers WHERE phone=?').get(pick(p))?.name || ''; }

/** Every number ever linked, newest first, with what's waiting on each. */
function numbers() {
  return db.prepare('SELECT * FROM numbers ORDER BY last_linked_at DESC').all().map(n => ({
    phone: n.phone, name: n.name, current: n.phone === current(), lastLinkedAt: n.last_linked_at, firstLinkedAt: n.first_linked_at,
    groups: count(n.phone),
    upcoming: db.prepare("SELECT COUNT(*) n FROM jobs WHERE phone=? AND status IN ('scheduled','running')").get(n.phone).n,
  }));
}

async function runSync(by, forPhone) {
  forPhone = forPhone || current();
  sync.running = true; sync.startedAt = Date.now(); sync.error = null; sync.by = by; sync.phone = forPhone;
  try {
    // One read of the chat list that WhatsApp Web already holds in the browser.
    const all = await wa.listGroups({ timeoutMs: SYNC_TIMEOUT_MS });
    if (current() !== forPhone) return;   // the number changed while we were reading
    const now = Date.now();
    const seen = new Set(all.map(g => g.id));
    const upsert = db.prepare(`INSERT INTO number_groups(phone,id,name,active,updated_at,missed_syncs) VALUES(?,?,?,1,?,0)
      ON CONFLICT(phone,id) DO UPDATE SET name=excluded.name, active=1, updated_at=excluded.updated_at, missed_syncs=0`);
    db.transaction(() => {
      for (const g of all) upsert.run(forPhone, g.id, g.name, now);
      // A group missing from one read may just not be loaded yet (WhatsApp loads chats gradually),
      // so it's hidden only after it's missing twice in a row.
      for (const g of db.prepare('SELECT id, missed_syncs FROM number_groups WHERE phone = ? AND active = 1').all(forPhone)) {
        if (seen.has(g.id)) continue;
        db.prepare(g.missed_syncs >= 1 ? 'UPDATE number_groups SET active = 0, missed_syncs = 0 WHERE phone = ? AND id = ?'
          : 'UPDATE number_groups SET missed_syncs = 1 WHERE phone = ? AND id = ?').run(forPhone, g.id);
      }
      db.prepare('UPDATE numbers SET synced_at=? WHERE phone=?').run(now, forPhone);
    })();
    sync.total = all.length; sync.failures = 0;
    audit(by, 'groups_synced', `${all.length} groups on +${forPhone}`);
    warnAboutMissingGroups();
  } catch (e) {
    sync.failures++; sync.lastFailAt = Date.now();
    sync.error = /timeout|timed out|aborted/i.test(e.message)
      ? 'WhatsApp is still loading the chats on this number. WA Box tries again by itself in 2 minutes.'
      : /not ready|409|not connected/i.test(e.message) ? 'WhatsApp is not connected yet. Link the number first.'
      : String(e.message || '').trim().length < 12
        ? 'WhatsApp Web had a problem reading the chat list. WA Box tries again by itself in 2 minutes.'   // e.g. a bare "r" from inside WhatsApp Web
      : `${e.message}. WA Box tries again by itself in 2 minutes.`;
  } finally {
    sync.running = false;
  }
}

/** Start a background sync of the number in use. Returns an error string only if it can't start. */
function startSync(by) {
  if (sync.running) return null;   // already syncing: the page shows progress
  if (Date.now() - sync.startedAt < MIN_SYNC_GAP_MS) return null;
  if (!current()) return 'Link a WhatsApp number first.';
  runSync(by, current());
  return null;
}

/**
 * Called by the scheduler every tick while WhatsApp is ready: make the linked number the one in
 * use (switching profiles if it's a different number), then sync it, retry failures, re-check once
 * shortly after linking, and refresh every few hours.
 */
function keepInStep(linkedPhone, { canSync = true, name: pushName = '' } = {}) {
  if (!linkedPhone) return;
  if (current() !== linkedPhone || !db.prepare('SELECT 1 FROM numbers WHERE phone=?').get(linkedPhone)) switchTo(linkedPhone, { name: pushName });
  else if (pushName && pushName !== name()) db.prepare('UPDATE numbers SET name=? WHERE phone=?').run(pushName, linkedPhone);
  if (sync.running || !canSync) return;
  const now = Date.now();
  if (!sync.linkedAt) sync.linkedAt = now;
  const last = syncedAt();
  const never = !last;
  const retry = sync.error && now - sync.lastFailAt > RETRY_AFTER_FAIL_MS && sync.failures < 10;
  const recheck = !sync.rechecked && last && now - sync.linkedAt > RECHECK_AFTER_LINK_MS;
  const stale = last && now - last > REFRESH_EVERY_MS;
  if (recheck) sync.rechecked = true;
  if ((never && !sync.error) || retry || recheck || stale) startSync('system');
}

// Scheduled messages of the number in use that go to groups it isn't in would skip those groups.
// Say so once, plainly, so someone fixes them before they're due.
function warnAboutMissingGroups() {
  const alerts = require('./alerts');
  const active = new Set(list().map(g => g.id));
  const affected = db.prepare("SELECT id, title, message, groups_json FROM jobs WHERE phone = ? AND status IN ('scheduled','running')").all(current())
    .filter(j => JSON.parse(j.groups_json).some(g => !active.has(g.id)));
  if (!affected.length) { alerts.clear('groups_missing').catch(() => {}); return; }
  const names = affected.slice(0, 3).map(j => `“${(j.title || j.message.split('\n')[0]).slice(0, 40)}”`).join(', ');
  alerts.raise('groups_missing', 'warn', `${affected.length} scheduled message${affected.length === 1 ? ' goes' : 's go'} to groups that aren't on +${current()} (${names}${affected.length > 3 ? '…' : ''}). Those groups will be skipped. Open each message and pick groups again.`).catch(() => {});
}

function status(p) {
  p = pick(p);
  const mine = sync.phone === p || (!sync.phone && p === current());
  return { running: mine && sync.running, startedAt: mine ? sync.startedAt : 0, finishedAt: syncedAt(p), error: mine ? sync.error : null, total: mine ? sync.total : 0,
    saved: count(p), phone: p, current: p === current(), by: mine ? sync.by : null };
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

// What the team last did with each list, offered as a suggestion next time.
addColumn('group_lists', 'last_time', 'TEXT');
addColumn('group_lists', 'last_dow', 'INTEGER');
addColumn('group_lists', 'last_gap_min', 'INTEGER');
addColumn('group_lists', 'last_gap_max', 'INTEGER');
addColumn('group_lists', 'last_repeat', 'TEXT');
addColumn('group_lists', 'phone', 'TEXT');
if (current()) adopt(current());

function lists(p) {
  p = pick(p);
  return db.prepare('SELECT * FROM group_lists WHERE phone = ? ORDER BY name COLLATE NOCASE').all(p).map(l => {
    const ids = JSON.parse(l.group_ids);
    const groups = ids.map(id => get(id, p) || { id, name: null });
    return { id: l.id, name: l.name, createdBy: l.created_by, updatedAt: l.updated_at,
      groups: groups.filter(g => g.name), missing: groups.filter(g => !g.name).length,
      usual: l.last_time ? { time: l.last_time, dow: l.last_dow, gapMin: l.last_gap_min, gapMax: l.last_gap_max, repeat: JSON.parse(l.last_repeat || '[]') } : null };
  });
}

/** Remember the time/day/pacing used, for every list whose groups were all included in this message. */
function rememberUsage(groupIds, { time, dow, gapMin, gapMax, repeat }) {
  const chosen = new Set(groupIds);
  for (const l of db.prepare('SELECT id, group_ids FROM group_lists WHERE phone = ?').all(current())) {
    const ids = JSON.parse(l.group_ids);
    if (ids.length && ids.every(id => chosen.has(id)) && ids.length >= chosen.size * 0.8) {
      db.prepare('UPDATE group_lists SET last_time=?, last_dow=?, last_gap_min=?, last_gap_max=?, last_repeat=? WHERE id=?')
        .run(time, dow, gapMin, gapMax, JSON.stringify(repeat || []), l.id);
    }
  }
}
function saveList({ id, name: listName, groupIds }, by) {
  let name = String(listName || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the list a name');
  const ids = [...new Set((groupIds || []).map(String))].filter(gid => get(gid));
  if (!ids.length) throw new Error('Pick at least one group for the list');
  if (ids.length > 50) throw new Error('A list can have up to 50 groups');
  const now = Date.now();
  if (id) {
    const r = db.prepare('UPDATE group_lists SET name=?, group_ids=?, updated_at=? WHERE id=? AND phone=?').run(name, JSON.stringify(ids), now, Number(id), current());
    if (!r.changes) throw new Error('List not found');
    return Number(id);
  }
  if (!current()) throw new Error('Link a WhatsApp number first');
  return db.prepare('INSERT INTO group_lists(name,group_ids,created_by,updated_at,phone) VALUES(?,?,?,?,?)').run(name, JSON.stringify(ids), by, now, current()).lastInsertRowid;
}
function deleteList(id) { db.prepare('DELETE FROM group_lists WHERE id=?').run(Number(id)); }

module.exports = { _resetGap: () => { sync.startedAt = 0; }, current, numbers, switchTo, name, list, get, count, startSync, status, keepInStep, lists, saveList, deleteList, rememberUsage };
