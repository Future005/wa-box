// Drafts: messages without a time yet (job status "draft" in the state machine, see public/machines.js).
// Nothing is ever sent from a draft: the scheduler only picks up scheduled/running messages.
// A draft can be incomplete (no groups, no text yet); everything is checked when it's scheduled.
//
// Also here: unsaved edits to a scheduled message ("edits in progress"), kept on the message itself
// so the scheduled version keeps going unchanged until someone presses Save.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, audit, addColumn } = require('./db');
const savedGroups = require('./groups');
const sched = require('./scheduler');
const SM = require('./machines');
const { epochToIst, formatIst } = require('./time');
const { UNDO_MS, bad } = require('./jobs');

addColumn('jobs', 'draft_json', 'TEXT');   // the time/pace someone was considering: {date, time, pace}
addColumn('jobs', 'edit_json', 'TEXT');    // unsaved changes to a scheduled message
addColumn('jobs', 'edit_by', 'TEXT');
addColumn('jobs', 'edit_at', 'INTEGER');

const notFound = () => Object.assign(new Error('That draft is no longer here (scheduled or deleted).'), { status: 404 });
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

/** Groups by id: names from the number's saved groups, or what the draft had before. */
function resolveGroups(ids, previous = []) {
  const prev = new Map(previous.map(g => [g.id, g]));
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 500)
    .map(id => savedGroups.get(id) || prev.get(id) || null).filter(Boolean).map(g => ({ id: g.id, name: g.name }));
}

/** Create (id null) or update a draft from what's on the compose screen. Returns its id. */
function saveDraft(id, body, { by, media = null }) {
  const now = Date.now();
  const cur = id ? db.prepare("SELECT * FROM jobs WHERE id=? AND status='draft'").get(id) : null;
  if (id && !cur) throw notFound();
  const groups = resolveGroups(parse(body.groups, []), cur ? parse(cur.groups_json, []) : []);
  const plan = parse(body.draft, {});
  const draftJson = JSON.stringify({ date: String(plan.date || '').slice(0, 10), time: String(plan.time || '').slice(0, 5), pace: String(plan.pace || '') });
  const gapMin = Math.max(30, Number(plan.gapMin) || 40), gapMax = Math.max(gapMin, Number(plan.gapMax) || 120);
  const repeat = (Array.isArray(plan.repeatDays) ? plan.repeatDays : []).map(Number).filter(d => d >= 0 && d <= 6);
  const message = String(body.message || '').slice(0, 4000);
  const title = String(body.title || '').trim().slice(0, 80);
  const imageUrl = String(body.imageUrl || '').trim().slice(0, 1000) || null;
  let mediaFile = cur?.media_file || null, mediaMime = cur?.media_mime || null;
  if (media) { mediaFile = media.name; mediaMime = media.mime; }
  if (body.removeImage === '1' || imageUrl) { mediaFile = media ? mediaFile : null; mediaMime = media ? mediaMime : null; }
  const linkPreview = body.linkPreview === '0' ? 0 : 1;
  if (!cur) {
    const r = db.prepare(`INSERT INTO jobs(title,message,media_file,media_mime,media_url,link_preview,groups_json,time_ist,run_at,start_at,gap_min,gap_max,
      repeat_days,status,created_by,updated_by,created_at,updated_at,phone,draft_json) VALUES(?,?,?,?,?,?,?,'',0,0,?,?,?,'draft',?,?,?,?,?,?)`)
      .run(title, message, mediaFile, mediaMime, imageUrl, linkPreview, JSON.stringify(groups), gapMin, gapMax, JSON.stringify(repeat), by, by, now, now, savedGroups.current() || null, draftJson);
    return Number(r.lastInsertRowid);
  }
  db.prepare(`UPDATE jobs SET title=?, message=?, media_file=?, media_mime=?, media_url=?, link_preview=?, groups_json=?, gap_min=?, gap_max=?, repeat_days=?,
    draft_json=?, updated_by=?, updated_at=? WHERE id=? AND status='draft'`)
    .run(title, message, mediaFile, mediaMime, imageUrl, linkPreview, JSON.stringify(groups), gapMin, gapMax, JSON.stringify(repeat), draftJson, by, now, id);
  return id;
}

/** Schedule a draft in place (same message, now with a time). `v` is validated by validateJobInput. */
function scheduleDraft(id, v, { by, media = null, removeImage = false }) {
  const cur = db.prepare("SELECT * FROM jobs WHERE id=? AND status='draft'").get(id);
  if (!cur) throw notFound();
  if (v.imageUrl && media) throw bad('Use either an uploaded image or an image link, not both');
  let mediaFile = cur.media_file, mediaMime = cur.media_mime;
  if (media) { mediaFile = media.name; mediaMime = media.mime; }
  else if (v.imageUrl || removeImage) { mediaFile = null; mediaMime = null; }
  const now = Date.now();
  db.prepare(`UPDATE jobs SET title=?, message=?, media_file=?, media_mime=?, media_url=?, link_preview=?, groups_json=?, time_ist=?, run_at=?, start_at=?,
    gap_min=?, gap_max=?, repeat_days=?, status='scheduled', note='', draft_json=NULL, updated_by=?, updated_at=? WHERE id=? AND status='draft'`)
    .run(v.title, v.message, mediaFile, mediaMime, v.imageUrl, v.linkPreview ? 1 : 0, JSON.stringify(v.chosen), v.time, v.runAt,
      Math.max(v.runAt + sched.jitter(), now + UNDO_MS), v.gapMin, v.gapMax, JSON.stringify(v.repeatDays), by, now, id);
  savedGroups.rememberUsage(v.chosen.map(g => g.id), { time: v.time, dow: epochToIst(v.runAt).dow, gapMin: v.gapMin, gapMax: v.gapMax, repeat: v.repeatDays });
  audit(by, 'job_created', `#${id} from a draft: ${v.chosen.length} groups at ${formatIst(v.runAt)}`);
  return id;
}

/** Move a scheduled message back to drafts (no time), only before any group got it. */
function unschedule(jobId, by) {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!j || !SM.can('job', j.status, 'unschedule')) throw Object.assign(new Error('Only a scheduled message can be moved back to drafts'), { status: 409 });
  const started = db.prepare(`SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status NOT IN ${SM.inList('send', 'waiting')}`).get(j.id, j.run_at).n;
  if (started) throw Object.assign(new Error('It has already started sending, so it can\'t go back to drafts. Abort it instead.'), { status: 409 });
  const { date, time } = epochToIst(j.run_at);
  const r = db.prepare("UPDATE jobs SET status='draft', draft_json=?, run_at=0, start_at=0, note='', updated_by=?, updated_at=? WHERE id=? AND status='scheduled'")
    .run(JSON.stringify({ date, time }), by, Date.now(), j.id);
  if (!r.changes) throw Object.assign(new Error('It started sending a moment ago, so it stayed scheduled.'), { status: 409 });
  audit(by, 'job_unscheduled', `#${j.id}`);
  return { draftId: j.id };
}

/** After an abort: a new draft with the same text and image, for the groups that didn't get it. */
function draftFromAborted(jobId, by) {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!j) return null;
  const got = new Set(db.prepare(`SELECT group_id FROM sends WHERE job_id=? AND occurrence=? AND status IN ${SM.inList('send', 'reachedOrReaching')}`).all(j.id, j.run_at).map(r => r.group_id));
  const groups = parse(j.groups_json, []).filter(g => !got.has(g.id));
  let mediaFile = null;
  if (j.media_file) {   // the aborted message's image is cleaned up later, so the draft gets its own copy
    try { mediaFile = crypto.randomBytes(12).toString('hex') + path.extname(j.media_file); fs.copyFileSync(path.join(DATA_DIR, 'media', j.media_file), path.join(DATA_DIR, 'media', mediaFile)); }
    catch { mediaFile = null; }
  }
  const { date, time } = epochToIst(j.run_at);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO jobs(title,message,media_file,media_mime,media_url,link_preview,groups_json,time_ist,run_at,start_at,gap_min,gap_max,
    repeat_days,status,note,created_by,updated_by,created_at,updated_at,phone,draft_json) VALUES(?,?,?,?,?,?,?,'',0,0,?,?,?,'draft',?,?,?,?,?,?,?)`)
    .run(j.title, j.message, mediaFile, mediaFile ? j.media_mime : null, j.media_url, j.link_preview, JSON.stringify(groups), j.gap_min, j.gap_max, j.repeat_days,
      got.size ? `Kept from an aborted message: ${got.size} group${got.size === 1 ? '' : 's'} already got it and ${got.size === 1 ? 'is' : 'are'} left out.` : 'Kept from an aborted message.',
      by, by, now, now, j.phone, JSON.stringify({ date, time }));
  audit(by, 'draft_from_abort', `#${r.lastInsertRowid} from #${j.id}`);
  return Number(r.lastInsertRowid);
}

function deleteDraft(id, by) {
  const r = db.prepare("DELETE FROM jobs WHERE id=? AND status='draft'").run(id);
  if (!r.changes) throw notFound();
  audit(by, 'draft_deleted', `#${id}`);
}

// ---------- edits in progress on a scheduled message ----------
function saveEdit(jobId, data, by) {
  const r = db.prepare("UPDATE jobs SET edit_json=?, edit_by=?, edit_at=? WHERE id=? AND status='scheduled'").run(JSON.stringify(data || {}).slice(0, 20000), by, Date.now(), jobId);
  if (!r.changes) throw Object.assign(new Error('This message is no longer waiting, so changes can\'t be kept.'), { status: 409 });
}
function clearEdit(jobId) { db.prepare('UPDATE jobs SET edit_json=NULL, edit_by=NULL, edit_at=NULL WHERE id=?').run(jobId); }

module.exports = { saveDraft, scheduleDraft, unschedule, draftFromAborted, deleteDraft, saveEdit, clearEdit };
