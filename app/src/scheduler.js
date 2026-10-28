// The send loop.
//
// Safety design (each line maps to a failure we refuse to allow):
//  * One sender at a time: a lease in the database. Two copies of the app (e.g. during a
//    redeploy) can never both send.
//  * Write-ahead: a send is recorded as "sending" BEFORE the request goes out. If the app
//    crashes mid-send, on restart we check the group's chat instead of sending again.
//  * No blind retries: if WhatsApp's reply is lost (timeout, 5xx), we read the group's
//    recent messages to see if ours is there. Found -> sent. Not found -> "unconfirmed"
//    and a human decides. Only errors that prove nothing was sent are retried (once).
//  * Duplicate guard: the same text to the same group within N hours is blocked,
//    whichever job it came from.
//  * Repeats only move forward, never into the past, never twice in one day, and a
//    weekly job skips missed weeks instead of catching up in a burst.
//  * Circuit breaker: 3 failures in a row pauses all sending and alerts an admin.
//  * Daily and hourly caps; overflow resumes the next morning, not at midnight.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, getSetting, setSetting, audit, logEvent } = require('./db');
const wa = require('./wa');
const savedGroups = require('./groups');
const alerts = require('./alerts');
const hooks = require('./hooks');
const { renderMessage } = require('./render');
// The text a given group actually receives (placeholders filled in).
const textFor = (job, group) => renderMessage(job.message, { groupName: group.name, at: job.run_at });
const { istDayKey, nextIstMidnight, nextWeeklyOccurrence, formatIst: rawIst, prettyIst: formatIst, epochToIst } = require('./time');

const FAST = process.env.WABOX_TEST_FAST === '1';   // tests only: seconds become milliseconds
const SEC = FAST ? 1 : 1000;
const HARD_MIN_GAP_S = 30;
const TICK_MS = FAST ? 50 : 20 * 1000;
const LEASE_MS = FAST ? 2000 : 90 * 1000;
const RECONNECT_EVERY_MS = 5 * 60 * 1000;
const VERIFY_DELAY_MS = FAST ? 20 : 20 * 1000;
const BREAKER_THRESHOLD = 3;
const OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const DONE_STATES = ['sent', 'dry_run', 'skipped', 'missed', 'blocked_duplicate', 'unconfirmed'];

const state = {
  wa: { status: 'unknown', phone: null, pushName: null, error: null, checkedAt: 0, since: Date.now() },
  busy: false, stopping: false, leader: false,
  runningJobId: null, currentGroup: null, nextSendAt: null,
  lastSentAt: 0, lastTickAt: 0, lastSuccessAt: getSetting('last_success_at', 0),
  lastReconnectTry: 0, consecutiveFailures: 0, readySince: 0, autoSynced: false,
  startedAt: Date.now(),
};

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => (FAST ? 0 : Math.floor(rand(0, 60)) * 1000);
const hashMessage = (message, media) => crypto.createHash('sha256').update(String(message).trim() + '|' + (media || '')).digest('hex').slice(0, 32);
const norm = s => String(s || '').replace(/\r\n/g, '\n').trim();

function settings() {
  return {
    dryRun: getSetting('dry_run', process.env.DRY_RUN !== 'false'),
    dailyCap: Number(getSetting('daily_cap', Number(process.env.DAILY_CAP || 30))),
    hourlyCap: Number(getSetting('hourly_cap', 20)),
    maxLateMin: Number(getSetting('max_late_min', Number(process.env.MAX_LATE_MINUTES || 120))),
    dedupeHours: Number(getSetting('dedupe_hours', 20)),
    paused: getSetting('paused', false),
  };
}

const sentToday = () => db.prepare("SELECT COUNT(*) n FROM sends WHERE day_key=? AND status IN ('sent','sending','uncertain')").get(istDayKey()).n;
const sentLastHour = () => db.prepare("SELECT COUNT(*) n, MIN(attempt_at) first FROM sends WHERE attempt_at > ? AND status IN ('sent','sending','uncertain')").get(Date.now() - 3600 * 1000);

// ---------- lease ----------
function acquireLease() {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO locks(name,owner,expires_at) VALUES('sender',?,?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE locks.owner=excluded.owner OR locks.expires_at < ?`).run(OWNER, now + LEASE_MS, now);
  const held = r.changes > 0;
  if (held !== state.leader) logEvent(held ? 'info' : 'warn', 'lease', held ? 'This copy is now the sender' : 'Another copy holds the sender lock; standing by');
  state.leader = held;
  return held;
}
function releaseLease() { db.prepare("DELETE FROM locks WHERE name='sender' AND owner=?").run(OWNER); state.leader = false; }

// ---------- WhatsApp status ----------
async function refreshWa() {
  const prev = state.wa.status;
  try {
    const s = await wa.getStatus();
    state.wa = { ...state.wa, ...s, error: s.engineError || null, checkedAt: Date.now() };
    if (['created', 'disconnected', 'failed', 'stopped'].includes(s.status) && Date.now() - state.lastReconnectTry > RECONNECT_EVERY_MS) {
      state.lastReconnectTry = Date.now();
      logEvent('warn', 'whatsapp', `Status is "${s.status}", trying to reconnect`);
      wa.start().catch(e => logEvent('error', 'whatsapp', 'Reconnect failed: ' + e.message));
    }
  } catch (e) {
    if (/not found|404/i.test(e.message)) wa.resetSession();
    state.wa = { ...state.wa, status: 'unreachable', error: e.message, checkedAt: Date.now() };
  }
  const now = state.wa.status;
  if (now !== prev) {
    state.wa.since = Date.now();
    logEvent(now === 'ready' ? 'info' : 'warn', 'whatsapp', `Connection changed: ${prev} -> ${now}${state.wa.error ? ` (${state.wa.error})` : ''}`);
  }
  const ready = now === 'ready';
  if (ready) {
    if (!state.readySince) state.readySince = Date.now();
    if (!state.autoSynced && savedGroups.count() === 0 && Date.now() - state.readySince > (FAST ? 0 : 90 * 1000)) {
      state.autoSynced = true; savedGroups.startSync('system');
    }
    await alerts.clear('wa_down', 'WhatsApp is connected again. Scheduled messages will go out.', { waReady: true });
  } else {
    state.readySince = 0;
    if (Date.now() - state.wa.since > 5 * 60 * 1000 && now !== 'unknown') {
      await alerts.raise('wa_down', 'error', now === 'qr_ready'
        ? 'WhatsApp got logged out. An admin needs to scan the QR code again. Nothing is being sent.'
        : `WhatsApp is not connected (${now}) for over 5 minutes. Nothing is being sent.`);
    }
  }
  return ready;
}

// ---------- helpers ----------
const getJob = id => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const jobStillActive = (id, runAt) => { const j = getJob(id); return j && ['scheduled', 'running'].includes(j.status) && (runAt === undefined || j.run_at === runAt); };
const getSend = (job, groupId) => db.prepare('SELECT * FROM sends WHERE job_id=? AND occurrence=? AND group_id=?').get(job.id, job.run_at, groupId);

function upsertSend(job, group, fields) {
  const cur = getSend(job, group.id) || {};
  const row = { job_id: job.id, occurrence: job.run_at, group_id: group.id, group_name: group.name,
    status: 'pending', attempts: 0, error: null, sent_at: null, day_key: null, msg_hash: null, attempt_at: null,
    wa_message_id: null, override: 0, verified: 0, ...cur, ...fields };
  db.prepare(`INSERT INTO sends(job_id,occurrence,group_id,group_name,status,attempts,error,sent_at,day_key,msg_hash,attempt_at,wa_message_id,override,verified)
    VALUES(@job_id,@occurrence,@group_id,@group_name,@status,@attempts,@error,@sent_at,@day_key,@msg_hash,@attempt_at,@wa_message_id,@override,@verified)
    ON CONFLICT(job_id,occurrence,group_id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts, error=excluded.error,
    sent_at=excluded.sent_at, day_key=excluded.day_key, msg_hash=excluded.msg_hash, attempt_at=excluded.attempt_at,
    wa_message_id=excluded.wa_message_id, override=excluded.override, verified=excluded.verified`).run(row);
  if (PROBLEM_STATES.includes(row.status) && cur.status !== row.status) {
    hooks.emit('group.failed', { message: hookMessage(job), group: { id: group.id, name: group.name }, status: row.status, error: row.error });
  }
}
const PROBLEM_STATES = ['failed', 'missed', 'unconfirmed', 'blocked_duplicate', 'skipped'];
const iso = ms => (ms ? new Date(ms).toISOString() : null);
/** The message as webhooks (and the public API) describe it. */
function hookMessage(job) {
  return { id: job.id, title: job.title || null, preview: firstLine(job.message), runAt: iso(job.run_at),
    repeat: JSON.parse(job.repeat_days || '[]').map(d => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]), createdBy: job.created_by };
}

async function interruptibleSleep(ms, jobId, runAt) {
  const until = Date.now() + ms;
  state.nextSendAt = until;
  while (Date.now() < until) {
    if (state.stopping || !jobStillActive(jobId, runAt) || settings().paused) return false;
    if (!acquireLease()) return false;
    await sleep(Math.min(FAST ? 10 : 1000, Math.max(0, until - Date.now())));
  }
  return true;
}

/** Look in the group's chat for our message sent at/after `since`. true / false / null (couldn't check) */
async function foundInChat(groupId, message, since) {
  try {
    const msgs = await wa.history(groupId, 30);
    return msgs.some(m => m.fromMe && norm(m.body) === norm(message) && (!m.timestamp || m.timestamp * 1000 >= since - 2 * 60 * 1000));
  } catch (e) {
    logEvent('warn', 'verify', `Could not read chat to verify: ${e.message}`);
    return null;
  }
}

async function resolveUncertain(job, group, row, reason) {
  await sleep(VERIFY_DELAY_MS);
  const found = await foundInChat(group.id, textFor(job, group), row.attempt_at || Date.now());
  if (found) {
    upsertSend(job, group, { status: 'sent', sent_at: Date.now(), verified: 1, error: null });
    logEvent('info', 'verify', `Reply was lost (${reason}) but the message is in the chat. Marked sent, not resending.`, { jobId: job.id, group: group.name });
    return 'sent';
  }
  const why = found === null ? "couldn't read the chat to check" : "it isn't in the chat";
  upsertSend(job, group, { status: 'unconfirmed', error: `Unclear if it was sent (${reason}); ${why}. Check the group, then mark it sent or send again.` });
  logEvent('error', 'verify', `Unconfirmed send: ${reason}; ${why}`, { jobId: job.id, group: group.name });
  await alerts.raise(`unconfirmed:${job.id}:${group.id}`, 'error',
    `Not sure if “${group.name}” got the ${formatIst(job.run_at)} message. Please check the group, then open the message in WA Box to mark it sent or send again.`, { waReady: state.wa.status === 'ready' });
  return 'unconfirmed';
}

/** After a crash/restart: resolve any send that was in flight, by looking at the chat. Never resend blindly. */
async function recoverInFlight() {
  const rows = db.prepare("SELECT * FROM sends WHERE status IN ('sending','uncertain')").all();
  for (const row of rows) {
    const job = getJob(row.job_id);
    if (!job) continue;
    const j = { ...job, run_at: row.occurrence };
    logEvent('warn', 'recover', 'Found a send that was in progress when the app stopped. Checking the chat before doing anything.', { jobId: job.id, group: row.group_name });
    await resolveUncertain(j, { id: row.group_id, name: row.group_name }, row, 'the app restarted mid-send');
  }
}

async function tripBreaker(lastError) {
  setSetting('paused', true);
  audit('system', 'paused', 'circuit breaker');
  logEvent('error', 'breaker', `${BREAKER_THRESHOLD} sends in a row failed. Paused all sending. Last error: ${lastError}`);
  await alerts.raise('breaker', 'error', `${BREAKER_THRESHOLD} sends in a row failed, so WA Box paused all sending to protect the number. Last error: ${lastError}. Check WhatsApp, then resume in Safety & settings.`, { waReady: state.wa.status === 'ready' });
}

function finishOccurrence(job, note = '') {
  job = getJob(job.id);
  const days = JSON.parse(job.repeat_days || '[]');
  const problems = db.prepare("SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status IN ('failed','missed','unconfirmed','blocked_duplicate','skipped')").get(job.id, job.run_at).n;
  hooks.emit('message.finished', { message: hookMessage(job), status: problems ? 'done_with_errors' : 'done',
    groups: db.prepare('SELECT group_id id, group_name name, status, sent_at, error FROM sends WHERE job_id=? AND occurrence=? ORDER BY id').all(job.id, job.run_at)
      .map(g => ({ id: g.id, name: g.name, status: g.status, sentAt: iso(g.sent_at), error: g.error })) });
  const sentN = db.prepare("SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status IN ('sent','dry_run')").get(job.id, job.run_at).n;
  const total = JSON.parse(job.groups_json).length;
  const practice = db.prepare("SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status='dry_run'").get(job.id, job.run_at).n > 0;
  if (!problems && sentN) {
    alerts.note(`✅ “${firstLine(job.message)}”: ${sentN}/${total} groups${practice ? ' (practice mode, nothing actually sent)' : ''}. Delivery ticks update in WA Box.`, { waReady: state.wa.status === 'ready' }).catch(() => {});
  }
  if (problems) {
    alerts.raise(`job_errors:${job.id}:${job.run_at}`, 'warn', `“${firstLine(job.message)}” (${formatIst(job.run_at)}) finished, but ${problems} group${problems === 1 ? '' : 's'} didn't get it. See Sent for details.`, { waReady: state.wa.status === 'ready' }).catch(() => {});
  }
  if (days.length) {
    // Never into the past, never twice on the same day, skip missed weeks.
    const next = nextWeeklyOccurrence(Math.max(job.run_at, Date.now()), job.time_ist, days);
    if (!next || next <= Date.now() || next - job.run_at < 6 * 3600 * 1000) {
      db.prepare("UPDATE jobs SET status='cancelled', note=?, updated_at=? WHERE id=?").run('Stopped automatically: the next repeat date looked wrong. Please re-create it.', Date.now(), job.id);
      logEvent('error', 'repeat', `Next repeat ${next ? formatIst(next) : 'none'} looked wrong; stopped the repeat`, { jobId: job.id });
      alerts.raise(`repeat:${job.id}`, 'error', `A weekly message (“${firstLine(job.message)}”) was stopped because its next date looked wrong. Please re-create it.`).catch(() => {});
      return;
    }
    db.prepare("UPDATE jobs SET run_at=?, start_at=?, status='scheduled', note=?, updated_at=? WHERE id=?").run(next, next + jitter(), note, Date.now(), job.id);
    logEvent('info', 'repeat', `Next send: ${formatIst(next)}`, { jobId: job.id });
  } else {
    db.prepare('UPDATE jobs SET status=?, note=?, updated_at=? WHERE id=?').run(problems ? 'done_with_errors' : 'done', note, Date.now(), job.id);
  }
}
function humanError(e) {
  const m = String(e?.message || e || '');
  if (/aborted due to timeout|timeout/i.test(m)) return "WhatsApp didn't reply in time";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(m)) return "Couldn't reach the WhatsApp gateway";
  if (/not a participant|not.*member|forbidden/i.test(m)) return 'This number is not in the group (or was removed)';
  if (/not ready|ENGINE_NOT_READY/i.test(m)) return 'WhatsApp was still starting';
  return m.slice(0, 300);
}
const firstLine = t => (String(t || '').split('\n').find(l => l.trim()) || '').replace(/[*_~`]/g, '').trim().slice(0, 60);

function markMissed(job, reason) {
  for (const g of JSON.parse(job.groups_json)) {
    const ex = getSend(job, g.id);
    if (!ex || ['pending', 'retry'].includes(ex.status)) upsertSend(job, g, { status: 'missed', error: reason });
  }
  logEvent('warn', 'missed', reason, { jobId: job.id });
  alerts.raise(`missed:${job.id}:${job.run_at}`, 'warn', `“${firstLine(job.message)}” (${formatIst(job.run_at)}) was not sent: ${reason}`).catch(() => {});
  finishOccurrence(job, reason);
}

// ---------- the send of one message to one group ----------
async function sendToGroup(job, group, cfg, msgHash) {
  const text = textFor(job, group);
  const prev = getSend(job, group.id);
  const attempts = (prev?.attempts || 0) + 1;
  // Write-ahead: recorded before the request leaves.
  upsertSend(job, group, { status: cfg.dryRun ? 'dry_run' : 'sending', attempts, attempt_at: Date.now(), msg_hash: msgHash, day_key: istDayKey(), error: null });
  if (cfg.dryRun) {
    upsertSend(job, group, { status: 'dry_run', sent_at: Date.now() });
    logEvent('info', 'send', 'Practice mode: would have sent now', { jobId: job.id, group: group.name });
    return 'ok';
  }
  const t0 = Date.now();
  try {
    try { await wa.typing(group.id, 'typing'); } catch { /* non-fatal */ }
    await sleep(FAST ? 1 : Math.min(5000, 2000 + text.length * 15) + rand(0, 800));
    let r;
    if (job.media_url) {
      r = await wa.sendImageUrl(group.id, job.media_url, text);
    } else if (job.media_file) {
      const buf = fs.readFileSync(path.join(DATA_DIR, 'media', job.media_file));
      r = await wa.sendImage(group.id, buf.toString('base64'), job.media_mime, text);
    } else if (job.media_purged) {
      throw Object.assign(new Error('The image was already deleted from WA Box. Duplicate the message and attach it again.'), { status: 410 });
    } else {
      r = await wa.sendText(group.id, text, { linkPreview: job.link_preview !== 0 });
    }
    try { await wa.typing(group.id, 'paused'); } catch { /* non-fatal */ }
    upsertSend(job, group, { status: 'sent', sent_at: Date.now(), wa_message_id: r?.messageId || r?.id || null });
    state.consecutiveFailures = 0; state.lastSuccessAt = Date.now(); setSetting('last_success_at', state.lastSuccessAt);
    logEvent('info', 'send', `Sent in ${Date.now() - t0} ms${r?.messageId ? ` (id ${String(r.messageId).slice(-12)})` : ''}`, { jobId: job.id, group: group.name });
    return 'ok';
  } catch (e) {
    const msg = humanError(e);
    if (wa.definitelyNotSent(e)) {
      const transient = (e.status === 409) || !e.status;   // engine not ready / gateway unreachable
      if (transient && attempts < 2) {
        upsertSend(job, group, { status: 'retry', error: msg });
        logEvent('warn', 'send', `Not sent (${msg}). Will retry once in 90 s.`, { jobId: job.id, group: group.name });
        return 'retry';
      }
      upsertSend(job, group, { status: 'failed', error: msg });
      logEvent('error', 'send', `Failed, not sent: ${msg}`, { jobId: job.id, group: group.name });
      state.consecutiveFailures++;
      return 'failed';
    }
    // The request may have reached WhatsApp. Check the chat instead of retrying.
    upsertSend(job, group, { status: 'uncertain', error: msg });
    logEvent('warn', 'send', `No clear answer (${msg}). Checking the chat before deciding.`, { jobId: job.id, group: group.name });
    const out = await resolveUncertain(job, group, getSend(job, group.id), msg);
    if (out === 'sent') { state.consecutiveFailures = 0; return 'ok'; }
    state.consecutiveFailures++;
    return 'failed';
  }
}

async function runJob(job) {
  const cfg = settings();
  state.runningJobId = job.id;
  db.prepare("UPDATE jobs SET status='running', note='', updated_at=? WHERE id=?").run(Date.now(), job.id);
  if (!db.prepare('SELECT 1 FROM sends WHERE job_id=? AND occurrence=? LIMIT 1').get(job.id, job.run_at)) {
    hooks.emit('message.started', { message: hookMessage(job), groups: JSON.parse(job.groups_json), practiceMode: cfg.dryRun });
  }
  logEvent('info', 'job', `Started: ${JSON.parse(job.groups_json).length} groups${cfg.dryRun ? ' (practice mode)' : ''}`, { jobId: job.id });
  const groups = JSON.parse(job.groups_json);
  const gapMin = Math.max(HARD_MIN_GAP_S, job.gap_min);
  const gapMax = Math.max(gapMin, job.gap_max);

  for (const group of groups) {
    const existing = getSend(job, group.id);
    if (existing && DONE_STATES.includes(existing.status)) continue;
    if (existing && ['sending', 'uncertain'].includes(existing.status)) continue; // handled by recovery
    if (existing && existing.status === 'failed' && !existing.override) continue;

    // Hash of exactly what this group gets, so {group}/{day}/{date} don't defeat the duplicate guard.
    const msgHash = hashMessage(textFor(job, group), job.media_url || job.media_file);
    if (!savedGroups.get(group.id)) {
      upsertSend(job, group, { status: 'skipped', error: 'Group is no longer in the saved list (left it, renamed, or no longer matches the keywords)' });
      logEvent('warn', 'send', 'Skipped: group no longer in saved list', { jobId: job.id, group: group.name });
      continue;
    }
    if (!cfg.dryRun) {
      if (sentToday() >= cfg.dailyCap) {
        const resume = nextIstMidnight() + 9 * 3600 * 1000 + Math.floor(rand(0, 30)) * 60000; // next day ~09:00-09:30 IST
        db.prepare("UPDATE jobs SET start_at=?, note=?, updated_at=? WHERE id=?").run(resume, `Daily limit of ${cfg.dailyCap} reached. The rest go out tomorrow around ${rawIst(resume).slice(11)}.`, Date.now(), job.id);
        logEvent('warn', 'limit', `Daily limit reached; continuing ${formatIst(resume)}`, { jobId: job.id });
        alerts.raise('daily_cap:' + istDayKey(), 'warn', `Daily limit of ${cfg.dailyCap} messages reached. Remaining groups go out tomorrow morning.`).catch(() => {});
        return;
      }
      const hr = sentLastHour();
      if (hr.n >= cfg.hourlyCap) {
        const resume = (hr.first || Date.now()) + 3600 * 1000 + Math.floor(rand(1, 5)) * 60000;
        db.prepare("UPDATE jobs SET start_at=?, note=?, updated_at=? WHERE id=?").run(resume, `Hourly limit of ${cfg.hourlyCap} reached. Continuing around ${rawIst(resume).slice(11)}.`, Date.now(), job.id);
        logEvent('warn', 'limit', `Hourly limit reached; continuing ${formatIst(resume)}`, { jobId: job.id });
        return;
      }
      if (!existing?.override && cfg.dedupeHours > 0) {
        const dupe = db.prepare(`SELECT s.job_id, s.sent_at, s.attempt_at FROM sends s WHERE s.group_id=? AND s.msg_hash=? AND s.status IN ('sent','sending','uncertain','unconfirmed')
          AND COALESCE(s.sent_at, s.attempt_at) > ? AND NOT (s.job_id=? AND s.occurrence=?) LIMIT 1`).get(group.id, msgHash, Date.now() - cfg.dedupeHours * 3600 * 1000, job.id, job.run_at);
        if (dupe) {
          const when = formatIst(dupe.sent_at || dupe.attempt_at);
          upsertSend(job, group, { status: 'blocked_duplicate', error: `Blocked: the same message already went to this group at ${when} (message #${dupe.job_id}).`, msg_hash: msgHash });
          logEvent('warn', 'duplicate', `Blocked a repeat of the same message (already sent ${when} by #${dupe.job_id})`, { jobId: job.id, group: group.name });
          alerts.raise(`dupe:${job.id}:${group.id}`, 'warn', `Blocked a duplicate: “${firstLine(job.message)}” already went to “${group.name}” at ${when}. If it really should go again, open the message and press "Send again".`).catch(() => {});
          continue;
        }
      }
    }

    // Random gap since the previous send (across jobs too).
    const sinceLast = (Date.now() - state.lastSentAt) / SEC;
    const wantGap = rand(gapMin, gapMax);
    if (state.lastSentAt && sinceLast < wantGap) {
      if (!await interruptibleSleep((wantGap - sinceLast) * SEC, job.id, job.run_at)) return;
    }
    if (state.stopping || !acquireLease() || !jobStillActive(job.id, job.run_at) || settings().paused) return;
    if (!cfg.dryRun && !(await refreshWa())) {
      db.prepare('UPDATE jobs SET note=? WHERE id=?').run('WhatsApp disconnected. Waiting until it reconnects.', job.id);
      return;
    }

    state.currentGroup = group.name; state.nextSendAt = null;
    const out = await sendToGroup(job, group, cfg, msgHash);
    state.currentGroup = null;
    state.lastSentAt = Date.now();
    if (out === 'retry') {
      db.prepare('UPDATE jobs SET start_at=?, note=? WHERE id=?').run(Date.now() + 90 * SEC, 'Retrying one group shortly', job.id);
      return;
    }
    if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
      await tripBreaker(getSend(job, group.id)?.error || 'unknown');
      return;
    }
  }
  logEvent('info', 'job', 'Finished this send', { jobId: job.id });
  finishOccurrence(job);
}

// ---------- digest ----------
async function maybeDigest(ready) {
  const t = epochToIst(Date.now());
  if (t.time < '08:30' || t.time > '10:00') return;
  const start = Date.now(), end = nextIstMidnight();
  const jobs = db.prepare("SELECT groups_json FROM jobs WHERE status IN ('scheduled','running') AND start_at < ?").all(end);
  const groups = jobs.reduce((n, j) => n + JSON.parse(j.groups_json).length, 0);
  const fails = db.prepare("SELECT COUNT(*) n FROM sends WHERE status IN ('failed','unconfirmed','missed') AND COALESCE(sent_at, attempt_at, occurrence) > ?").get(start - 24 * 3600 * 1000).n;
  const cfg = settings();
  const lines = [];
  if (t.dow === 1) {   // Monday: the week ahead
    const week = db.prepare("SELECT message, groups_json, run_at FROM jobs WHERE status IN ('scheduled','running') AND run_at < ? ORDER BY run_at").all(start + 7 * 86400000);
    lines.push('', `This week (${week.length}):`, ...(week.length ? week.map(j => `• ${formatIst(j.run_at)} · ${firstLine(j.message)} · ${JSON.parse(j.groups_json).length} groups`) : ['• Nothing scheduled yet']));
  }
  const summary = [
    `WhatsApp: ${ready ? 'connected' : 'NOT connected'}`,
    `Mode: ${cfg.paused ? 'paused' : cfg.dryRun ? 'practice (nothing is sent)' : 'live'}`,
    `Today: ${jobs.length} message${jobs.length === 1 ? '' : 's'} to ${groups} group sends`,
    `Problems in the last 24 h: ${fails}`,
    ...lines,
  ].join('\n');
  await alerts.digest({ waReady: ready, summary });
}

// ---------- delivery receipts ----------
let lastReceipts = 0;
async function pollReceipts() {
  if (Date.now() - lastReceipts < (FAST ? 0 : 2 * 60 * 1000)) return;
  lastReceipts = Date.now();
  const rows = db.prepare(`SELECT id, wa_message_id FROM sends WHERE status='sent' AND wa_message_id IS NOT NULL
    AND (ack IS NULL OR ack < 2) AND sent_at > ? ORDER BY sent_at DESC LIMIT 50`).all(Date.now() - 48 * 3600 * 1000);
  if (!rows.length) return;
  try {
    const acks = await wa.receipts(rows.map(r => r.wa_message_id));
    const upd = db.prepare('UPDATE sends SET ack=?, ack_at=? WHERE id=? AND (ack IS NULL OR ack < ?)');
    for (const r of rows) if (typeof acks[r.wa_message_id] === 'number') upd.run(acks[r.wa_message_id], Date.now(), r.id, acks[r.wa_message_id]);
  } catch (e) { logEvent('warn', 'receipts', 'Could not read delivery ticks: ' + e.message); }
}

// ---------- undo / skip ----------
/** Stop a message before its first group gets it. A weekly message skips just this time. */
function undo(jobId, by) {
  const job = getJob(jobId);
  if (!job || !['scheduled', 'running'].includes(job.status)) throw new Error('This message is not waiting to go out');
  const started = db.prepare("SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status NOT IN ('pending','retry')").get(job.id, job.run_at).n;
  if (started) throw new Error('It has already started sending. Use Stop instead.');
  const days = JSON.parse(job.repeat_days || '[]');
  if (days.length) {
    const next = nextWeeklyOccurrence(Math.max(job.run_at, Date.now()), job.time_ist, days);
    db.prepare("UPDATE jobs SET run_at=?, start_at=?, status='scheduled', note=?, updated_by=?, updated_at=? WHERE id=?")
      .run(next, next + jitter(), `Skipped ${formatIst(job.run_at)} (undo by ${by})`, by, Date.now(), job.id);
    logEvent('info', 'undo', `${by} skipped this time; next ${formatIst(next)}`, { jobId });
    return { skipped: true, next };
  }
  db.prepare("UPDATE jobs SET status='cancelled', note=?, updated_by=?, updated_at=? WHERE id=?").run(`Undone by ${by} before sending`, by, Date.now(), job.id);
  logEvent('info', 'undo', `${by} undid it before any group got it`, { jobId });
  return { cancelled: true };
}

// ---------- tick ----------
async function tick() {
  if (state.busy || state.stopping) return;
  state.busy = true;
  try {
    state.lastTickAt = Date.now();
    const ready = await refreshWa();
    if (!acquireLease()) return;
    if (ready) await recoverInFlight();
    if (ready) await pollReceipts();
    await maybeDigest(ready).catch(e => logEvent('warn', 'digest', e.message));
    const cfg = settings();
    const now = Date.now();
    const due = db.prepare("SELECT * FROM jobs WHERE status IN ('scheduled','running') AND start_at <= ? ORDER BY start_at, id LIMIT 1").get(now);
    if (!due) return;
    if (now - due.start_at > cfg.maxLateMin * 60000) {
      markMissed(due, `more than ${cfg.maxLateMin} min late (the server or WhatsApp was offline)`);
      return;
    }
    if (cfg.paused) return;
    if (!ready && !cfg.dryRun) {
      db.prepare('UPDATE jobs SET note=? WHERE id=?').run('Waiting for WhatsApp to connect', due.id);
      return;
    }
    await runJob(due);
  } catch (e) {
    logEvent('error', 'scheduler', e.stack || e.message);
  } finally {
    state.busy = false; state.runningJobId = null; state.nextSendAt = null; state.currentGroup = null;
  }
}

// ---------- image retention ----------
// Uploaded images are only kept until they're no longer needed: 3 days after a one-off
// message finishes or a message is cancelled (long enough for "Send again"). Weekly
// messages keep theirs until they're stopped. Image links are never stored.
const MEDIA_KEEP_MS = 3 * 24 * 3600 * 1000;
function purgeMedia(now = Date.now()) {
  const dir = path.join(DATA_DIR, 'media');
  const jobs = db.prepare("SELECT id, media_file FROM jobs WHERE media_file IS NOT NULL AND status IN ('done','done_with_errors','cancelled') AND updated_at < ?").all(now - MEDIA_KEEP_MS);
  for (const j of jobs) {
    try { fs.rmSync(path.join(dir, j.media_file), { force: true }); } catch { /* already gone */ }
    db.prepare('UPDATE jobs SET media_file=NULL, media_purged=1 WHERE id=?').run(j.id);
    logEvent('info', 'cleanup', 'Deleted the uploaded image (no longer needed)', { jobId: j.id });
  }
  // Files no job points to (replaced while editing, or a failed save), older than an hour.
  const used = new Set(db.prepare('SELECT media_file FROM jobs WHERE media_file IS NOT NULL').all().map(r => r.media_file));
  let orphans = 0;
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (used.has(f)) continue;
    try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > 3600 * 1000) { fs.rmSync(path.join(dir, f), { force: true }); orphans++; } } catch { /* ignore */ }
  }
  if (orphans) logEvent('info', 'cleanup', `Deleted ${orphans} unused image file(s)`);
  return jobs.length + orphans;
}

let timer = null;
function startLoop() {
  hooks.start();
  purgeMedia();
  setInterval(() => { try { purgeMedia(); } catch (e) { logEvent('warn', 'cleanup', e.message); } }, 3600 * 1000).unref?.();
  logEvent('info', 'scheduler', `Started (instance ${OWNER})`);
  setTimeout(tick, FAST ? 10 : 3000);
  timer = setInterval(tick, TICK_MS);
}
/** Graceful stop: finish the message in flight, never start a new one, release the lock. */
async function stop(timeoutMs = 25000) {
  state.stopping = true;
  clearInterval(timer);
  const until = Date.now() + timeoutMs;
  while (state.busy && Date.now() < until) await sleep(100);
  releaseLease();
  logEvent('info', 'scheduler', 'Stopped');
}

// ---------- manual decisions on a group ----------
function currentRow(jobId, groupId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Message not found');
  const row = db.prepare('SELECT * FROM sends WHERE job_id=? AND group_id=? ORDER BY occurrence DESC LIMIT 1').get(jobId, groupId);
  if (!row) throw new Error('No send recorded for that group');
  return { job, row };
}
function markSent(jobId, groupId, by) {
  const { job, row } = currentRow(jobId, groupId);
  if (!['unconfirmed', 'failed'].includes(row.status)) throw new Error('Only unconfirmed or failed sends can be marked as sent');
  db.prepare("UPDATE sends SET status='sent', sent_at=COALESCE(sent_at, attempt_at, ?), error=? WHERE id=?").run(Date.now(), `Marked as sent by ${by}`, row.id);
  alerts.clear(`unconfirmed:${jobId}:${groupId}`).catch(() => {});
  logEvent('info', 'manual', `${by} confirmed it was sent`, { jobId, group: row.group_name });
  if (job.status === 'done_with_errors') {
    const left = db.prepare("SELECT COUNT(*) n FROM sends WHERE job_id=? AND occurrence=? AND status IN ('failed','missed','unconfirmed','blocked_duplicate','skipped')").get(jobId, row.occurrence).n;
    if (!left) db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(jobId);
  }
}
function sendAgain(jobId, groupId, by) {
  const { job, row } = currentRow(jobId, groupId);
  if (!['unconfirmed', 'failed', 'blocked_duplicate', 'skipped', 'missed'].includes(row.status)) throw new Error('This group already got it');
  if (JSON.parse(job.repeat_days).length && row.occurrence !== job.run_at) throw new Error('This weekly message has moved on to its next date. Use "Duplicate" to send it again.');
  if (!['done', 'done_with_errors', 'running', 'scheduled'].includes(job.status)) throw new Error('This message was cancelled. Use "Duplicate" to send it again.');
  if (job.media_purged) throw new Error('Its image was already deleted from WA Box. Use "Duplicate" and attach the image again.');
  db.prepare("UPDATE sends SET status='retry', attempts=0, override=1, error=? WHERE id=?").run(`Send again requested by ${by}`, row.id);
  if (['done', 'done_with_errors'].includes(job.status)) {
    db.prepare("UPDATE jobs SET status='running', run_at=?, start_at=?, note=?, updated_at=? WHERE id=?").run(row.occurrence, Date.now(), `Sending again to ${row.group_name}`, Date.now(), jobId);
  }
  alerts.clear(`unconfirmed:${jobId}:${groupId}`).catch(() => {});
  logEvent('warn', 'manual', `${by} asked to send again (overrides the duplicate guard for this group)`, { jobId, group: row.group_name });
}

function health() {
  const now = Date.now();
  const cfg = settings();
  const next = db.prepare("SELECT id, start_at FROM jobs WHERE status IN ('scheduled','running') ORDER BY start_at LIMIT 1").get();
  const day = 24 * 3600 * 1000;
  const fail24 = db.prepare("SELECT COUNT(*) n FROM sends WHERE status IN ('failed','unconfirmed','missed') AND COALESCE(sent_at, attempt_at, occurrence) > ?").get(now - day).n;
  const sent24 = db.prepare("SELECT COUNT(*) n FROM sends WHERE status='sent' AND sent_at > ?").get(now - day).n;
  return {
    scheduler: { ok: now - state.lastTickAt < 3 * TICK_MS + 60000, lastTickAt: state.lastTickAt, leader: state.leader, busy: state.busy, startedAt: state.startedAt },
    whatsapp: { status: state.wa.status, since: state.wa.since, phone: state.wa.phone, name: state.wa.pushName, error: state.wa.error },
    lastSuccessAt: state.lastSuccessAt, nextJob: next || null, sent24, fail24,
    queue: db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('scheduled','running')").get().n,
    consecutiveFailures: state.consecutiveFailures, settings: cfg,
  };
}

module.exports = { startLoop, stop, tick, purgeMedia, undo, pollReceipts, recoverInFlight, state, settings, sentToday, refreshWa, jitter, health, markSent, sendAgain, hashMessage, HARD_MIN_GAP_S, OWNER };
