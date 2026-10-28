// The send loop. Exactly one job runs at a time and exactly one message is in
// flight at a time. All safety limits here are enforced server-side.
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, getSetting, audit } = require('./db');
const wa = require('./gateway');
const savedGroups = require('./groups');
const { istDayKey, nextIstMidnight, nextWeeklyOccurrence } = require('./time');

const HARD_MIN_GAP_S = 30;          // never two sends closer than this
const TICK_MS = 20 * 1000;
const RECONNECT_EVERY_MS = 5 * 60 * 1000;

const state = {
  wa: { status: 'unknown', phone: null, pushName: null, error: null, checkedAt: 0 },
  busy: false,
  runningJobId: null,
  currentGroup: null,
  nextSendAt: null,
  lastSentAt: 0,
  lastReconnectTry: 0,
};

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function settings() {
  return {
    dryRun: getSetting('dry_run', process.env.DRY_RUN !== 'false'),
    dailyCap: Number(getSetting('daily_cap', Number(process.env.DAILY_CAP || 30))),
    maxLateMin: Number(getSetting('max_late_min', Number(process.env.MAX_LATE_MINUTES || 120))),
    paused: getSetting('paused', false),
  };
}

const jitter = () => Math.floor(rand(0, 60)) * 1000;

function sentToday() {
  return db.prepare("SELECT COUNT(*) n FROM sends WHERE day_key=? AND status='sent'").get(istDayKey()).n;
}

async function refreshWa() {
  try {
    const s = await wa.getStatus();
    state.wa = { ...s, error: null, checkedAt: Date.now() };
    // Bring a stopped/disconnected session back up (it reuses saved login; no QR unless logged out).
    if (['created', 'disconnected', 'failed', 'stopped'].includes(s.status) &&
        Date.now() - state.lastReconnectTry > RECONNECT_EVERY_MS) {
      state.lastReconnectTry = Date.now();
      wa.start().catch(e => console.warn('[wa] start failed:', e.message));
    }
  } catch (e) {
    state.wa = { status: 'unreachable', phone: null, pushName: null, error: e.message, checkedAt: Date.now() };
  }
  // First time WhatsApp is connected and nothing is saved yet: one automatic sync,
  // after a short wait so WhatsApp Web can finish loading chats.
  if (state.wa.status === 'ready') {
    if (!state.readySince) state.readySince = Date.now();
    if (!state.autoSynced && savedGroups.count() === 0 && Date.now() - state.readySince > 90 * 1000) {
      state.autoSynced = true;
      savedGroups.startSync('system');
    }
  } else {
    state.readySince = 0;
  }
  return state.wa.status === 'ready';
}

function getJob(id) { return db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
function jobStillActive(id) {
  const j = getJob(id);
  return j && ['scheduled', 'running'].includes(j.status);
}

/** Sleep up to ms, waking early if the job is cancelled or paused. */
async function interruptibleSleep(ms, jobId) {
  const until = Date.now() + ms;
  state.nextSendAt = until;
  while (Date.now() < until) {
    if (!jobStillActive(jobId) || settings().paused) return false;
    await sleep(Math.min(1000, until - Date.now()));
  }
  return true;
}

function upsertSend(job, group, fields) {
  db.prepare(`INSERT INTO sends(job_id,occurrence,group_id,group_name,status,attempts,error,sent_at,day_key)
    VALUES(@job_id,@occurrence,@group_id,@group_name,@status,@attempts,@error,@sent_at,@day_key)
    ON CONFLICT(job_id,occurrence,group_id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
    error=excluded.error, sent_at=excluded.sent_at, day_key=excluded.day_key`).run({
    job_id: job.id, occurrence: job.run_at, group_id: group.id, group_name: group.name,
    status: 'pending', attempts: 0, error: null, sent_at: null, day_key: null, ...fields,
  });
}

function finishOccurrence(job, note = '') {
  const days = JSON.parse(job.repeat_days || '[]');
  const next = days.length ? nextWeeklyOccurrence(job.run_at, job.time_ist, days) : null;
  if (next) {
    db.prepare("UPDATE jobs SET run_at=?, start_at=?, status='scheduled', note=?, updated_at=? WHERE id=?")
      .run(next, next + jitter(), note, Date.now(), job.id);
  } else {
    const failed = db.prepare("SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status IN ('failed','missed')").get(job.id, job.run_at).n;
    db.prepare('UPDATE jobs SET status=?, note=?, updated_at=? WHERE id=?')
      .run(failed ? 'done_with_errors' : 'done', note, Date.now(), job.id);
  }
}

function markMissed(job, reason) {
  for (const g of JSON.parse(job.groups_json)) {
    const ex = db.prepare('SELECT status FROM sends WHERE job_id=? AND occurrence=? AND group_id=?').get(job.id, job.run_at, g.id);
    if (!ex || ex.status === 'pending' || ex.status === 'retry') upsertSend(job, g, { status: 'missed', error: reason });
  }
  audit('system', 'job_missed', `#${job.id} ${reason}`);
  finishOccurrence(job, reason);
}

async function sendOne(job, group, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] job #${job.id} -> ${group.name}`);
    return;
  }
  // Show "typing..." for a human-looking moment, scaled a little by length.
  const typingMs = Math.min(5000, 2000 + job.message.length * 15) + rand(0, 800);
  try { await wa.typing(group.id, 'typing'); } catch { /* non-fatal */ }
  await sleep(typingMs);
  if (job.media_file) {
    const buf = fs.readFileSync(path.join(DATA_DIR, 'media', job.media_file));
    await wa.sendImage(group.id, buf.toString('base64'), job.media_mime, job.message);
  } else {
    await wa.sendText(group.id, job.message);
  }
  try { await wa.typing(group.id, 'paused'); } catch { /* non-fatal */ }
}

async function runJob(job) {
  const cfg = settings();
  state.runningJobId = job.id;
  db.prepare("UPDATE jobs SET status='running', note='', updated_at=? WHERE id=?").run(Date.now(), job.id);

  // No live group-list read before sending: we use the saved list. If the number has
  // since left a group, WhatsApp rejects that one send and it is recorded as failed.
  const groups = JSON.parse(job.groups_json);
  const gapMin = Math.max(HARD_MIN_GAP_S, job.gap_min);
  const gapMax = Math.max(gapMin, job.gap_max);

  for (const group of groups) {
    const existing = db.prepare('SELECT * FROM sends WHERE job_id=? AND occurrence=? AND group_id=?').get(job.id, job.run_at, group.id);
    if (existing && ['sent', 'dry_run', 'skipped', 'missed'].includes(existing.status)) continue;
    if (existing && existing.status === 'failed' && existing.attempts >= 2) continue;

    if (!savedGroups.get(group.id)) {
      upsertSend(job, group, { status: 'skipped', error: 'Group is no longer in the saved list (left it, renamed, or no longer matches the keywords)' });
      continue;
    }

    if (!cfg.dryRun && sentToday() >= cfg.dailyCap) {
      const resume = nextIstMidnight() + Math.floor(rand(5, 30)) * 60000;
      db.prepare("UPDATE jobs SET status='running', start_at=?, note=?, updated_at=? WHERE id=?")
        .run(resume, `Daily limit of ${cfg.dailyCap} reached. Remaining groups continue tomorrow.`, Date.now(), job.id);
      audit('system', 'daily_cap', `#${job.id}`);
      return;
    }

    // Random gap since the previous send (across jobs too).
    const sinceLast = (Date.now() - state.lastSentAt) / 1000;
    const wantGap = rand(gapMin, gapMax);
    if (state.lastSentAt && sinceLast < wantGap) {
      const ok = await interruptibleSleep((wantGap - sinceLast) * 1000, job.id);
      if (!ok) return;
    }
    if (!cfg.dryRun && !(await refreshWa())) {
      db.prepare("UPDATE jobs SET note=? WHERE id=?").run('WhatsApp disconnected. Paused until it reconnects.', job.id);
      return;
    }
    if (!jobStillActive(job.id)) return;

    state.currentGroup = group.name;
    state.nextSendAt = null;
    const attempts = (existing?.attempts || 0) + 1;
    try {
      await sendOne(job, group, cfg.dryRun);
      upsertSend(job, group, { status: cfg.dryRun ? 'dry_run' : 'sent', attempts, sent_at: Date.now(), day_key: istDayKey() });
    } catch (e) {
      console.warn(`[send] job #${job.id} -> ${group.name} failed:`, e.message);
      upsertSend(job, group, { status: attempts >= 2 ? 'failed' : 'retry', attempts, error: e.message.slice(0, 300) });
      if (attempts < 2) {
        // One retry, after a calm pause, then move on.
        db.prepare("UPDATE jobs SET start_at=?, note=? WHERE id=?").run(Date.now() + 90000, 'Retrying a failed group shortly', job.id);
        state.lastSentAt = Date.now();
        return;
      }
    } finally {
      state.currentGroup = null;
    }
    state.lastSentAt = Date.now();
  }
  finishOccurrence(getJob(job.id));
}

async function tick() {
  if (state.busy) return;
  state.busy = true;
  try {
    const ready = await refreshWa();
    const cfg = settings();
    const now = Date.now();

    const due = db.prepare("SELECT * FROM jobs WHERE status IN ('scheduled','running') AND start_at <= ? ORDER BY start_at, id LIMIT 1").get(now);
    if (!due) return;

    if (now - due.start_at > cfg.maxLateMin * 60000) {
      markMissed(due, `Not sent: more than ${cfg.maxLateMin} min late (server or WhatsApp was offline)`);
      return;
    }
    if (cfg.paused) return;
    if (!ready && !cfg.dryRun) {
      db.prepare('UPDATE jobs SET note=? WHERE id=?').run('Waiting for WhatsApp to connect', due.id);
      return;
    }
    await runJob(due);
  } catch (e) {
    console.error('[scheduler] tick error:', e);
  } finally {
    state.busy = false;
    state.runningJobId = null;
    state.nextSendAt = null;
  }
}

function startLoop() {
  // Anything left "running" from a crash resumes from where it stopped (sends are idempotent).
  setTimeout(tick, 3000);
  setInterval(tick, TICK_MS).unref?.();
}

module.exports = { startLoop, state, settings, sentToday, refreshWa, jitter, HARD_MIN_GAP_S };
