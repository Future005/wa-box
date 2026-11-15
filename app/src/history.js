// What happened to one message, in order: who created, edited, moved, paused or aborted it, plus what
// the scheduler did with it (started, finished, skipped). People's actions are written here; the
// scheduler's own steps come from the events log (one source each, nothing duplicated).
const { db } = require('./db');
const { prettyIst: formatIst } = require('./time');

db.exec(`
CREATE TABLE IF NOT EXISTS job_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_history_job ON job_history(job_id, at);
`);

function record(jobId, by, text) {
  if (!jobId || !text) return;
  db.prepare('INSERT INTO job_history(job_id, at, by, text) VALUES(?,?,?,?)').run(jobId, Date.now(), String(by || ''), String(text).slice(0, 500));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clip = (t, n = 40) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** Plain words for what an edit changed, e.g. "time 10:00 → 10:30; added Ops Team". Empty when nothing did. */
function describeEdit(before, after) {
  const out = [];
  if ((before.title || '') !== (after.title || '')) out.push(after.title ? `name “${clip(after.title)}”` : 'name removed');
  if (before.message !== after.message) out.push(`text → “${clip(after.message)}”`);
  if (before.run_at !== after.run_at) out.push(`time ${formatIst(before.run_at)} → ${formatIst(after.run_at)}`);
  const bg = JSON.parse(before.groups_json || '[]'), ag = JSON.parse(after.groups_json || '[]');
  const bIds = new Set(bg.map(g => g.id)), aIds = new Set(ag.map(g => g.id));
  const added = ag.filter(g => !bIds.has(g.id)), removed = bg.filter(g => !aIds.has(g.id));
  const names = list => list.length > 3 ? `${list.slice(0, 3).map(g => g.name).join(', ')} and ${list.length - 3} more` : list.map(g => g.name).join(', ');
  if (added.length) out.push(`added ${names(added)}`);
  if (removed.length) out.push(`removed ${names(removed)}`);
  if ((before.media_file || before.media_url || null) !== (after.media_file || after.media_url || null)) out.push(after.media_file || after.media_url ? 'new image' : 'image removed');
  if (before.gap_min !== after.gap_min || before.gap_max !== after.gap_max) out.push(`pacing ${after.gap_min}–${after.gap_max} s`);
  if (before.repeat_days !== after.repeat_days) {
    const d = JSON.parse(after.repeat_days || '[]');
    out.push(d.length ? `repeats ${d.map(x => DAYS[x]).join(', ')}` : 'no longer repeats');
  }
  return out.join('; ');
}

// The scheduler's steps worth showing (per-group send lines are on the Groups list already).
const SYSTEM_KINDS = ['job', 'missed', 'cancel', 'reschedule', 'repeat', 'undo', 'manual', 'duplicate', 'limit', 'recover', 'pause'];

function forJob(jobId, limit = 100) {
  const people = db.prepare('SELECT at, by, text FROM job_history WHERE job_id=?').all(jobId).map(r => ({ ...r, kind: 'person' }));
  const system = db.prepare(`SELECT at, level, kind, message FROM events WHERE job_id=? AND kind IN (${SYSTEM_KINDS.map(() => '?').join(',')})`)
    .all(jobId, ...SYSTEM_KINDS).map(r => ({ at: r.at, by: '', text: r.message, kind: r.level === 'info' ? 'system' : r.level }));
  return [...people, ...system].sort((a, b) => b.at - a.at).slice(0, limit);
}

module.exports = { record, describeEdit, forJob };
