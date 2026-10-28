// One place that turns input into a scheduled message, used by the web app AND the public API,
// so both always follow exactly the same rules.
const { db, getSetting, audit } = require('./db');
const savedGroups = require('./groups');
const sched = require('./scheduler');
const { istToEpoch, epochToIst, formatIst } = require('./time');

const UNDO_MS = 30 * 1000;   // a new message never starts sooner than this: room for Undo
const bad = msg => Object.assign(new Error(msg), { status: 400 });

function serializeJob(j) {
  const sends = db.prepare('SELECT group_id,group_name,status,error,sent_at,attempts,ack FROM sends WHERE job_id=? AND occurrence=?').all(j.id, j.run_at);
  const { date, time } = epochToIst(j.run_at);
  return {
    id: j.id, title: j.title, message: j.message, hasImage: !!j.media_file, imageUrl: j.media_url || null,
    imagePurged: !!j.media_purged, linkPreview: j.link_preview !== 0,
    groups: JSON.parse(j.groups_json), date, time, runAt: j.run_at, startAt: j.start_at,
    gapMin: j.gap_min, gapMax: j.gap_max, repeatDays: JSON.parse(j.repeat_days),
    status: j.status, note: j.note, createdBy: j.created_by, updatedBy: j.updated_by,
    createdAt: j.created_at, updatedAt: j.updated_at, sends,
  };
}

// An image link is checked now (is it public, is it an image, is it small enough) so it
// doesn't fail silently on Saturday morning. Google Drive share links are turned into
// direct download links.
async function checkImageUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  const drive = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([\w-]{20,})/);
  if (drive) u = `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  let url;
  try { url = new URL(u); } catch { throw bad("That image link doesn't look right"); }
  if (url.protocol !== 'https:') throw bad('The image link must start with https://');
  if (u.length > 1000) throw bad('The image link is too long');
  if (process.env.WABOX_SKIP_URL_CHECK === '1') return u;
  let r;
  try { r = await fetch(u, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(10000) }); }
  catch { throw bad("Couldn't open the image link. Make sure it's public."); }
  try { await r.body?.cancel(); } catch { /* ignore */ }
  const type = r.headers.get('content-type') || '';
  if (!r.ok) throw bad(`The image link answered with an error (${r.status}). Make sure anyone with the link can view it.`);
  if (!/^image\/(jpeg|png|webp)/i.test(type)) throw bad(type.startsWith('text/html')
    ? 'That link opens a web page, not an image. Use a direct link to the image file (or a public Google Drive file link).'
    : 'The link must point to a JPG, PNG or WebP image.');
  const size = Number((r.headers.get('content-range') || '').split('/')[1] || r.headers.get('content-length') || 0);
  if (size > 5 * 1024 * 1024 && r.status !== 206) throw bad('That image is over 5 MB. Use a smaller one.');
  if (size > 5 * 1024 * 1024 && (r.headers.get('content-range') || '').includes('/')) throw bad('That image is over 5 MB. Use a smaller one.');
  return u;
}

async function validateJobInput(body, { requireFuture = true } = {}) {
  const message = String(body.message || '').trim();
  if (!message) throw bad('Message is empty');
  if (message.length > 4000) throw bad('Message is too long (max 4000 characters)');
  const title = String(body.title || '').trim().slice(0, 80);

  let groupIds = body.groups;
  if (typeof groupIds === 'string') { try { groupIds = JSON.parse(groupIds); } catch { groupIds = [groupIds]; } }
  if (!Array.isArray(groupIds) || !groupIds.length) throw bad('Pick at least one group');
  if (groupIds.length > 50) throw bad('Max 50 groups per job');
  const chosen = [...new Set(groupIds.map(String))].map(id => {
    const g = savedGroups.get(id);
    if (!g) throw bad('One of the selected groups is no longer in the saved group list. Sync groups and try again.');
    return { id: g.id, name: g.name };
  });

  let runAt;
  try { runAt = istToEpoch(String(body.date || ''), String(body.time || '')); } catch { throw bad('Pick a valid date (YYYY-MM-DD) and time (HH:MM, India time)'); }
  if (requireFuture && runAt < Date.now() - 60 * 1000) throw bad('That date/time is in the past (times are India time, IST)');
  if (runAt > Date.now() + 366 * 24 * 3600 * 1000) throw bad('Date is too far in the future');

  let gapMin = Math.round(Number(body.gapMin ?? 40));
  let gapMax = Math.round(Number(body.gapMax ?? 120));
  if (!Number.isFinite(gapMin) || !Number.isFinite(gapMax)) throw bad('Gap must be a number of seconds');
  gapMin = Math.max(sched.HARD_MIN_GAP_S, Math.min(gapMin, 1800));
  gapMax = Math.max(gapMin, Math.min(gapMax, 3600));

  let repeatDays = body.repeatDays ?? [];
  if (typeof repeatDays === 'string') { try { repeatDays = JSON.parse(repeatDays); } catch { repeatDays = []; } }
  repeatDays = [...new Set((Array.isArray(repeatDays) ? repeatDays : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();

  const imageUrl = await checkImageUrl(body.imageUrl);
  const linkPreview = body.linkPreview !== '0' && body.linkPreview !== false && body.linkPreview !== 'false';
  return { message, title, chosen, runAt, time: String(body.time), gapMin, gapMax, repeatDays, imageUrl, linkPreview };
}


/** Insert a validated message. `createdBy` is a person ("admin@example.com") or an API key ("api:Sheets sync"). */
function createJob(v, { createdBy, media = null }) {
  if (v.imageUrl && media) throw bad('Use either an uploaded image or an image link, not both');
  const now = Date.now();
  const r = db.prepare(`INSERT INTO jobs(title,message,media_file,media_mime,media_url,link_preview,groups_json,time_ist,run_at,start_at,gap_min,gap_max,
    repeat_days,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?,?,?,?)`)
    .run(v.title, v.message, media?.name || null, media?.mime || null, v.imageUrl, v.linkPreview ? 1 : 0, JSON.stringify(v.chosen), v.time, v.runAt,
      Math.max(v.runAt + sched.jitter(), now + UNDO_MS), v.gapMin, v.gapMax, JSON.stringify(v.repeatDays), createdBy, createdBy, now, now);
  savedGroups.rememberUsage(v.chosen.map(g => g.id), { time: v.time, dow: epochToIst(v.runAt).dow, gapMin: v.gapMin, gapMax: v.gapMax, repeat: v.repeatDays });
  audit(createdBy, 'job_created', `#${r.lastInsertRowid} ${v.chosen.length} groups at ${formatIst(v.runAt)}`);
  return Number(r.lastInsertRowid);
}

module.exports = { validateJobInput, checkImageUrl, serializeJob, createJob, UNDO_MS, bad };
