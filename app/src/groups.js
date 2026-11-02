// Saved group list. WhatsApp is only asked for the group list when someone presses
// "Sync from WhatsApp" (or once, automatically, the first time WhatsApp connects).
// Everything else (the picker, job validation, the scheduler) reads this table instantly.
const { db, getSetting, setSetting, audit, addColumn } = require('./db');
const wa = require('./wa');

db.exec(`
CREATE TABLE IF NOT EXISTS wa_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`);

// Every group on the linked number is saved: nothing is filtered out. The picker has search.
// Groups belong to the number they were synced from: when a different number is linked (or the
// number is unlinked), the old number's groups are hidden at once and a fresh sync starts.
addColumn('wa_groups', 'missed_syncs', 'INTEGER NOT NULL DEFAULT 0');
const MIN_SYNC_GAP_MS = 15 * 1000;            // only guards against double-clicks
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 2 * 60 * 1000;    // a failed sync retries by itself
const RECHECK_AFTER_LINK_MS = 10 * 60 * 1000; // WhatsApp keeps loading older chats after a new link
const REFRESH_EVERY_MS = 6 * 3600 * 1000;     // pick up new groups even if nobody presses Sync

const sync = { running: false, startedAt: 0, finishedAt: getSetting('groups_synced_at', 0), error: null, total: 0, matched: 0, by: null,
  failures: 0, lastFailAt: 0, linkedAt: 0, rechecked: false };

function phone() { return getSetting('groups_phone', ''); }

function list() {
  return db.prepare('SELECT id, name FROM wa_groups WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
}
function get(id) {
  return db.prepare('SELECT id, name FROM wa_groups WHERE id = ? AND active = 1').get(id);
}
function count() {
  return db.prepare('SELECT COUNT(*) n FROM wa_groups WHERE active = 1').get().n;
}

/** The linked number changed or was unlinked: hide every saved group right away. */
function forgetNumber(newPhone, by = 'system') {
  const hidden = db.prepare('UPDATE wa_groups SET active = 0, missed_syncs = 0 WHERE active = 1').run().changes;
  setSetting('groups_phone', newPhone || '');
  setSetting('groups_synced_at', 0);
  Object.assign(sync, { finishedAt: 0, error: null, total: 0, matched: 0, failures: 0, lastFailAt: 0, startedAt: 0, linkedAt: Date.now(), rechecked: false });
  audit(by, 'groups_reset', newPhone ? `New number +${newPhone}: hid ${hidden} groups from the previous number` : `Number unlinked: hid ${hidden} groups`);
  return hidden;
}

async function runSync(by, forPhone) {
  sync.running = true; sync.startedAt = Date.now(); sync.error = null; sync.by = by;
  try {
    // One read of the chat list that WhatsApp Web already holds in the browser.
    const all = await wa.listGroups({ timeoutMs: SYNC_TIMEOUT_MS });
    if (forPhone && phone() && phone() !== forPhone) return;   // the number changed while we were reading
    const now = Date.now();
    const seen = new Set(all.map(g => g.id));
    const upsert = db.prepare(`INSERT INTO wa_groups(id,name,active,updated_at,missed_syncs) VALUES(?,?,1,?,0)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=1, updated_at=excluded.updated_at, missed_syncs=0`);
    db.transaction(() => {
      for (const g of all) upsert.run(g.id, g.name, now);
      // A group missing from one read may just not be loaded yet (WhatsApp loads chats gradually),
      // so it's hidden only after it's missing twice in a row.
      for (const g of db.prepare('SELECT id, missed_syncs FROM wa_groups WHERE active = 1').all()) {
        if (seen.has(g.id)) continue;
        if (g.missed_syncs >= 1) db.prepare('UPDATE wa_groups SET active = 0, missed_syncs = 0 WHERE id = ?').run(g.id);
        else db.prepare('UPDATE wa_groups SET missed_syncs = 1 WHERE id = ?').run(g.id);
      }
    })();
    if (forPhone) setSetting('groups_phone', forPhone);
    sync.total = all.length; sync.matched = count(); sync.failures = 0;
    sync.finishedAt = now; setSetting('groups_synced_at', now);
    audit(by, 'groups_synced', `${all.length} groups on this number`);
    warnAboutMissingGroups();
  } catch (e) {
    sync.failures++; sync.lastFailAt = Date.now();
    sync.error = /timeout|timed out|aborted/i.test(e.message)
      ? 'WhatsApp is still loading the chats on this number. WA Box tries again by itself in 2 minutes.'
      : /not ready|409|not connected/i.test(e.message) ? 'WhatsApp is not connected yet. Link the number first.'
      : `${e.message}. WA Box tries again by itself in 2 minutes.`;
  } finally {
    sync.running = false;
  }
}

/** Start a background sync. Returns an error string only if it can't start. */
function startSync(by, forPhone) {
  if (sync.running) return null;   // already syncing: the page shows progress
  if (Date.now() - sync.startedAt < MIN_SYNC_GAP_MS) return null;
  runSync(by, forPhone);
  return null;
}

/**
 * Called by the scheduler every tick while WhatsApp is ready. Keeps the saved groups in step with
 * the linked number: a different number resets them; then sync, retry failures, re-check once
 * shortly after linking, and refresh every few hours.
 */
function keepInStep(currentPhone, { canSync = true } = {}) {
  if (!currentPhone) return;
  // Groups saved before WA Box tracked numbers (or after an unlink) can't be trusted to belong to
  // this number: clear them and sync fresh. Same for a different number.
  if (phone() !== currentPhone) forgetNumber(currentPhone);
  if (sync.running || !canSync) return;
  const now = Date.now();
  if (!sync.linkedAt) sync.linkedAt = now;
  const never = !sync.finishedAt || !phone();
  const retry = sync.error && now - sync.lastFailAt > RETRY_AFTER_FAIL_MS && sync.failures < 10;
  const recheck = !sync.rechecked && sync.finishedAt && now - sync.linkedAt > RECHECK_AFTER_LINK_MS;
  const stale = sync.finishedAt && now - sync.finishedAt > REFRESH_EVERY_MS;
  if (recheck) sync.rechecked = true;
  if ((never && !sync.error) || retry || recheck || stale) startSync('system', currentPhone);
}

// Scheduled messages that go to groups this number isn't in (e.g. after switching numbers) would
// skip those groups. Say so once, plainly, so someone fixes them before they're due.
function warnAboutMissingGroups() {
  const alerts = require('./alerts');
  const active = new Set(list().map(g => g.id));
  const affected = db.prepare("SELECT id, title, message, groups_json FROM jobs WHERE status IN ('scheduled','running')").all()
    .filter(j => JSON.parse(j.groups_json).some(g => !active.has(g.id)));
  if (!affected.length) { alerts.clear('groups_missing').catch(() => {}); return; }
  const names = affected.slice(0, 3).map(j => `“${(j.title || j.message.split('\n')[0]).slice(0, 40)}”`).join(', ');
  alerts.raise('groups_missing', 'warn', `${affected.length} scheduled message${affected.length === 1 ? ' goes' : 's go'} to groups that aren't on the linked number (${names}${affected.length > 3 ? '…' : ''}). Those groups will be skipped. Open each message and pick groups again.`).catch(() => {});
}

function status() {
  return { running: sync.running, startedAt: sync.startedAt, finishedAt: sync.finishedAt, error: sync.error, total: sync.total,
    saved: count(), phone: phone(), by: sync.by };
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

function lists() {
  return db.prepare('SELECT * FROM group_lists ORDER BY name COLLATE NOCASE').all().map(l => {
    const ids = JSON.parse(l.group_ids);
    const groups = ids.map(id => get(id) || { id, name: null });
    return { id: l.id, name: l.name, createdBy: l.created_by, updatedAt: l.updated_at,
      groups: groups.filter(g => g.name), missing: groups.filter(g => !g.name).length,
      usual: l.last_time ? { time: l.last_time, dow: l.last_dow, gapMin: l.last_gap_min, gapMax: l.last_gap_max, repeat: JSON.parse(l.last_repeat || '[]') } : null };
  });
}

/** Remember the time/day/pacing used, for every list whose groups were all included in this message. */
function rememberUsage(groupIds, { time, dow, gapMin, gapMax, repeat }) {
  const chosen = new Set(groupIds);
  for (const l of db.prepare('SELECT id, group_ids FROM group_lists').all()) {
    const ids = JSON.parse(l.group_ids);
    if (ids.length && ids.every(id => chosen.has(id)) && ids.length >= chosen.size * 0.8) {
      db.prepare('UPDATE group_lists SET last_time=?, last_dow=?, last_gap_min=?, last_gap_max=?, last_repeat=? WHERE id=?')
        .run(time, dow, gapMin, gapMax, JSON.stringify(repeat || []), l.id);
    }
  }
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

module.exports = { _resetGap: () => { sync.startedAt = 0; }, list, get, count, startSync, status, forgetNumber, keepInStep, lists, saveList, deleteList, rememberUsage };
