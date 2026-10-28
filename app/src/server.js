const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { db, DATA_DIR, getSetting, setSetting, audit, logEvent } = require('./db');
const auth = require('./auth');
const wa = require('./wa');
const sched = require('./scheduler');
const savedGroups = require('./groups');
const alerts = require('./alerts');
const { istToEpoch, epochToIst, formatIst } = require('./time');

const PORT = Number(process.env.PORT || 3000);
const BASE_PATH = ('/' + (process.env.BASE_PATH || '/wabox').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Work whether or not the reverse proxy strips the /wabox prefix.
app.use((req, _res, next) => {
  if (BASE_PATH && (req.url === BASE_PATH || req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?'))) {
    req.url = req.url.slice(BASE_PATH.length) || '/';
  }
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// Container liveness (always 200 while the process runs; used by Docker/Coolify).
app.get('/healthz', (_req, res) => res.json({ ok: true }));
// For an outside uptime monitor (UptimeRobot, Better Stack...): 503 when someone should look.
app.get('/health/monitor', (_req, res) => {
  const h = sched.health();
  const waDownLong = h.whatsapp.status !== 'ready' && Date.now() - h.whatsapp.since > 10 * 60 * 1000;
  const ok = h.scheduler.ok && !waDownLong && !h.settings.paused;
  res.status(ok ? 200 : 503).json({ ok, scheduler: h.scheduler.ok ? 'running' : 'stalled',
    whatsapp: h.whatsapp.status === 'ready' ? 'connected' : 'disconnected', sending: h.settings.paused ? 'paused' : 'on' });
});

// Serve index.html with a <base href> so assets and API calls resolve under /wabox/
// whether the visitor opened /wabox or /wabox/, and whether or not the proxy strips the prefix.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace('<head>', `<head>\n  <base href="${BASE_PATH}/">`);
app.get(['/', '/index.html'], (_req, res) => res.type('html').send(INDEX_HTML));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: 0 }));

const api = express.Router();
api.use(express.json({ limit: '100kb' }));

// CSRF: SameSite=Strict cookie + a custom header that cross-site forms cannot set.
api.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'wabox') return res.status(403).json({ error: 'Bad request origin' });
  const origin = req.get('Origin');
  if (origin && req.get('Host') && new URL(origin).host !== req.get('Host')) return res.status(403).json({ error: 'Bad request origin' });
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
api.use(apiLimiter);

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.warn('[api]', req.method, req.path, e.message);
  res.status(e.status && e.status < 500 ? e.status : 400).json({ error: e.message || 'Something went wrong' });
});
const bad = msg => Object.assign(new Error(msg), { status: 400 });

function requireUser(req, res, next) {
  const user = auth.sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  if (user.mustChange && !['/me', '/password', '/logout'].includes(req.path)) {
    return res.status(403).json({ error: 'Please change your password first', mustChange: true });
  }
  next();
}
const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

// ---------- auth ----------
api.post('/login', loginLimiter, wrap(async (req, res) => {
  const r = auth.login(req.body?.username, req.body?.password, req.ip);
  if (r.error) return res.status(401).json({ error: r.error });
  auth.setCookie(res, r.token, BASE_PATH || '/');
  res.json({ ok: true });
}));

api.use(requireUser);

api.post('/logout', (req, res) => { auth.logout(req); auth.clearCookie(res, BASE_PATH || '/'); res.json({ ok: true }); });
api.get('/me', (req, res) => res.json({ username: req.user.username, role: req.user.role, mustChange: req.user.mustChange }));
api.post('/password', wrap(async (req, res) => {
  auth.changePassword(req.user.id, req.body?.current, req.body?.next);
  audit(req.user.username, 'password_changed');
  res.json({ ok: true });
}));

// ---------- status ----------
api.get('/status', (req, res) => {
  const cfg = sched.settings();
  const s = sched.state;
  const running = s.runningJobId ? db.prepare('SELECT id,title FROM jobs WHERE id=?').get(s.runningJobId) : null;
  res.json({
    wa: { status: s.wa.status, phone: s.wa.phone, name: s.wa.pushName, error: req.user.role === 'admin' ? s.wa.error : undefined },
    dryRun: cfg.dryRun, paused: cfg.paused, dailyCap: cfg.dailyCap, maxLateMin: cfg.maxLateMin, hourlyCap: cfg.hourlyCap, dedupeHours: cfg.dedupeHours,
    sentToday: sched.sentToday(), issues: alerts.openIssues().length,
    running: running ? { ...running, group: s.currentGroup, nextSendAt: s.nextSendAt } : null,
    now: Date.now(), today: epochToIst(Date.now()).date,
  });
});

// ---------- groups ----------
// Instant: reads the saved list, never asks WhatsApp.
api.get('/groups', (_req, res) => res.json({ groups: savedGroups.list(), sync: savedGroups.status() }));
// Background sync from WhatsApp (one read of the chat list WhatsApp Web already has).
api.post('/groups/sync', wrap(async (req, res) => {
  if (sched.state.wa.status !== 'ready') throw bad('WhatsApp is not connected yet');
  const err = savedGroups.startSync(req.user.username);
  if (err) throw bad(err);
  res.json({ ok: true, sync: savedGroups.status() });
}));
api.get('/lists', (_req, res) => res.json({ lists: savedGroups.lists() }));
api.post('/lists', wrap(async (req, res) => {
  const id = savedGroups.saveList(req.body || {}, req.user.username);
  audit(req.user.username, 'list_saved', String(req.body?.name || ''));
  res.json({ ok: true, id });
}));
api.put('/lists/:id', wrap(async (req, res) => {
  savedGroups.saveList({ ...(req.body || {}), id: req.params.id }, req.user.username);
  audit(req.user.username, 'list_saved', String(req.body?.name || ''));
  res.json({ ok: true });
}));
api.delete('/lists/:id', wrap(async (req, res) => {
  savedGroups.deleteList(req.params.id);
  audit(req.user.username, 'list_deleted', `#${req.params.id}`);
  res.json({ ok: true });
}));
api.put('/groups/keywords', requireAdmin, wrap(async (req, res) => {
  const raw = req.body?.keywords;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const kws = savedGroups.setKeywords(list);
  audit(req.user.username, 'group_keywords', kws.join(', ') || '(all groups)');
  res.json({ ok: true, keywords: kws });
}));

// ---------- jobs ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

function serializeJob(j) {
  const sends = db.prepare('SELECT group_id,group_name,status,error,sent_at,attempts FROM sends WHERE job_id=? AND occurrence=?').all(j.id, j.run_at);
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

  const runAt = istToEpoch(String(body.date || ''), String(body.time || ''));
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

function saveMedia(file) {
  if (!file) return null;
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype];
  const name = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(DATA_DIR, 'media', name), file.buffer, { mode: 0o600 });
  return { name, mime: file.mimetype };
}

api.get('/jobs', (req, res) => {
  const view = req.query.view === 'history' ? 'history' : 'upcoming';
  const rows = view === 'upcoming'
    ? db.prepare("SELECT * FROM jobs WHERE status IN ('scheduled','running') ORDER BY start_at").all()
    : db.prepare("SELECT * FROM jobs WHERE status NOT IN ('scheduled','running') ORDER BY updated_at DESC LIMIT 100").all();
  res.json({ jobs: rows.map(serializeJob) });
});

api.get('/sends', (req, res) => {
  const rows = db.prepare(`SELECT s.*, j.title, j.message FROM sends s JOIN jobs j ON j.id = s.job_id
    ORDER BY COALESCE(s.sent_at, s.attempt_at, s.occurrence) DESC LIMIT 500`).all();
  res.json({ sends: rows.map(r => ({ id: r.id, jobId: r.job_id, groupId: r.group_id, title: r.title, preview: r.message.slice(0, 80),
    group: r.group_name, status: r.status, error: r.error, verified: !!r.verified, at: r.sent_at || r.attempt_at || r.occurrence })) });
});

// Decide about one group after an unclear or failed send.
api.post('/jobs/:id/groups/:gid/mark-sent', wrap(async (req, res) => {
  sched.markSent(Number(req.params.id), req.params.gid, req.user.username);
  audit(req.user.username, 'marked_sent', `#${req.params.id} ${req.params.gid}`);
  res.json({ ok: true });
}));
api.post('/jobs/:id/groups/:gid/send-again', requireAdmin, wrap(async (req, res) => {
  sched.sendAgain(Number(req.params.id), req.params.gid, req.user.username);
  audit(req.user.username, 'send_again', `#${req.params.id} ${req.params.gid}`);
  res.json({ ok: true });
}));

// Send the message to the connected number's own chat ("Message yourself") to see it on a real phone.
const testSends = new Map();
api.post('/test-send', upload.single('image'), wrap(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message && !req.file && !req.body?.imageUrl) throw bad('Write the message first');
  if (message.length > 4000) throw bad('Message is too long');
  const s = sched.state.wa;
  if (s.status !== 'ready' || !s.phone) throw bad("WhatsApp isn't connected, so a test can't be sent");
  const last = testSends.get(req.user.id) || 0;
  if (Date.now() - last < 20000) throw bad('Wait a few seconds between tests');
  const dayKey = 'test_sends_' + epochToIst(Date.now()).date;
  const today = getSetting(dayKey, 0);
  if (today >= 40) throw bad('Daily limit for test messages reached (40). Try again tomorrow.');
  testSends.set(req.user.id, Date.now()); setSetting(dayKey, today + 1);
  const chatId = `${String(s.phone).replace(/\D/g, '')}@c.us`;
  const imageUrl = req.file ? null : await checkImageUrl(req.body?.imageUrl);
  const linkPreview = req.body?.linkPreview !== '0';
  let file = req.file;
  if (!file && !imageUrl && req.body?.jobImage) {
    const j = db.prepare('SELECT media_file, media_mime FROM jobs WHERE id=?').get(Number(req.body.jobImage));
    if (j?.media_file) file = { buffer: fs.readFileSync(path.join(DATA_DIR, 'media', j.media_file)), mimetype: j.media_mime };
  }
  try {
    if (file) await wa.sendImage(chatId, file.buffer.toString('base64'), file.mimetype, message);
    else if (imageUrl) await wa.sendImageUrl(chatId, imageUrl, message);
    else await wa.sendText(chatId, message, { linkPreview });
  } catch (e) { logEvent('warn', 'test_send', `Test by ${req.user.username} failed: ${e.message}`); throw bad('Test failed: ' + e.message); }
  logEvent('info', 'test_send', `Test message sent to own number by ${req.user.username}`);
  res.json({ ok: true, to: '+' + s.phone });
}));

api.post('/jobs', upload.single('image'), wrap(async (req, res) => {
  const v = await validateJobInput(req.body);
  if (v.imageUrl && req.file) throw bad('Use either an uploaded image or an image link, not both');
  const media = saveMedia(req.file);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO jobs(title,message,media_file,media_mime,media_url,link_preview,groups_json,time_ist,run_at,start_at,gap_min,gap_max,
    repeat_days,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?,?,?,?)`)
    .run(v.title, v.message, media?.name || null, media?.mime || null, v.imageUrl, v.linkPreview ? 1 : 0, JSON.stringify(v.chosen), v.time, v.runAt,
      v.runAt + sched.jitter(), v.gapMin, v.gapMax, JSON.stringify(v.repeatDays), req.user.username, req.user.username, now, now);
  audit(req.user.username, 'job_created', `#${r.lastInsertRowid} ${v.chosen.length} groups at ${formatIst(v.runAt)}`);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

api.put('/jobs/:id', upload.single('image'), wrap(async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(Number(req.params.id));
  if (!job) throw bad('Job not found');
  if (job.status !== 'scheduled') throw bad('Only scheduled (not yet started) jobs can be edited');
  const v = await validateJobInput(req.body);
  if (v.imageUrl && req.file) throw bad('Use either an uploaded image or an image link, not both');
  let mediaFile = job.media_file, mediaMime = job.media_mime, mediaUrl = job.media_url;
  if (req.body.removeImage === '1') { mediaFile = null; mediaMime = null; mediaUrl = null; }
  const media = saveMedia(req.file);
  if (media) { mediaFile = media.name; mediaMime = media.mime; mediaUrl = null; }
  if (v.imageUrl) { mediaUrl = v.imageUrl; mediaFile = null; mediaMime = null; }
  db.prepare(`UPDATE jobs SET title=?,message=?,media_file=?,media_mime=?,media_url=?,link_preview=?,groups_json=?,time_ist=?,run_at=?,start_at=?,gap_min=?,gap_max=?,
    repeat_days=?,note='',updated_by=?,updated_at=? WHERE id=? AND status='scheduled'`)
    .run(v.title, v.message, mediaFile, mediaMime, mediaUrl, v.linkPreview ? 1 : 0, JSON.stringify(v.chosen), v.time, v.runAt, v.runAt + sched.jitter(),
      v.gapMin, v.gapMax, JSON.stringify(v.repeatDays), req.user.username, Date.now(), job.id);
  audit(req.user.username, 'job_edited', `#${job.id}`);
  res.json({ ok: true });
}));

api.post('/jobs/:id/cancel', wrap(async (req, res) => {
  const r = db.prepare("UPDATE jobs SET status='cancelled', note=?, updated_by=?, updated_at=? WHERE id=? AND status IN ('scheduled','running')")
    .run(`Cancelled by ${req.user.username}`, req.user.username, Date.now(), Number(req.params.id));
  if (!r.changes) throw bad('Job is not active');
  audit(req.user.username, 'job_cancelled', `#${req.params.id}`);
  res.json({ ok: true });
}));

api.post('/jobs/:id/send-now', wrap(async (req, res) => {
  const r = db.prepare("UPDATE jobs SET start_at=?, updated_by=?, updated_at=? WHERE id=? AND status='scheduled'")
    .run(Date.now(), req.user.username, Date.now(), Number(req.params.id));
  if (!r.changes) throw bad('Only scheduled jobs can be started now');
  // keep run_at so a repeating job keeps its weekly time
  audit(req.user.username, 'job_send_now', `#${req.params.id}`);
  res.json({ ok: true });
}));

api.get('/jobs/:id/image', (req, res) => {
  const job = db.prepare('SELECT media_file, media_mime FROM jobs WHERE id=?').get(Number(req.params.id));
  if (!job?.media_file) return res.status(404).end();
  res.type(job.media_mime).sendFile(path.join(DATA_DIR, 'media', job.media_file));
});

// ---------- templates ----------
api.get('/templates', (_req, res) => res.json({ templates: db.prepare('SELECT id,name,message,created_by FROM templates ORDER BY name').all() }));
api.post('/templates', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const message = String(req.body?.message || '').trim();
  if (!name || !message) throw bad('Name and message are required');
  if (message.length > 4000) throw bad('Message is too long');
  db.prepare('INSERT INTO templates(name,message,created_by,created_at) VALUES(?,?,?,?)').run(name, message, req.user.username, Date.now());
  res.json({ ok: true });
}));
api.delete('/templates/:id', wrap(async (req, res) => {
  db.prepare('DELETE FROM templates WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- admin: WhatsApp connection ----------
api.get('/wa/qr', requireAdmin, wrap(async (_req, res) => {
  try { res.json(await wa.getQr()); }
  catch (e) { res.json({ qrCode: null, message: e.message }); }
}));
api.post('/wa/start', requireAdmin, wrap(async (req, res) => {
  wa.start().catch(e => console.warn('[wa] start:', e.message));
  audit(req.user.username, 'wa_start');
  res.json({ ok: true });
}));
api.post('/wa/logout', requireAdmin, wrap(async (req, res) => {
  await wa.logout();
  audit(req.user.username, 'wa_logout');
  res.json({ ok: true });
}));

// ---------- admin: settings ----------
api.put('/settings', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.dryRun === 'boolean') { setSetting('dry_run', b.dryRun); audit(req.user.username, 'dry_run', String(b.dryRun)); }
  if (typeof b.paused === 'boolean') { setSetting('paused', b.paused); audit(req.user.username, 'paused', String(b.paused)); }
  if (b.dailyCap !== undefined) {
    const n = Math.round(Number(b.dailyCap));
    if (!(n >= 1 && n <= 60)) throw bad('Daily limit must be 1-60 (keep it low to stay safe)');
    setSetting('daily_cap', n); audit(req.user.username, 'daily_cap', String(n));
  }
  if (b.maxLateMin !== undefined) {
    const n = Math.round(Number(b.maxLateMin));
    if (!(n >= 5 && n <= 1440)) throw bad('Late window must be 5-1440 minutes');
    setSetting('max_late_min', n);
  }
  if (b.hourlyCap !== undefined) {
    const n = Math.round(Number(b.hourlyCap));
    if (!(n >= 1 && n <= 40)) throw bad('Hourly limit must be 1-40');
    setSetting('hourly_cap', n); audit(req.user.username, 'hourly_cap', String(n));
  }
  if (b.dedupeHours !== undefined) {
    const n = Math.round(Number(b.dedupeHours));
    if (!(n >= 0 && n <= 168)) throw bad('Duplicate window must be 0-168 hours');
    setSetting('dedupe_hours', n); audit(req.user.username, 'dedupe_hours', String(n));
  }
  if (b.alertWebhook !== undefined) {
    const u = String(b.alertWebhook || '').trim();
    if (u) { let ok = false; try { ok = new URL(u).protocol === 'https:'; } catch { /* invalid */ } if (!ok) throw bad('The alert link must start with https://'); }
    setSetting('alert_webhook', u); audit(req.user.username, 'alert_channel', u ? 'webhook set' : 'webhook removed');
  }
  if (b.alertWaNumbers !== undefined) {
    const nums = String(b.alertWaNumbers || '').split(/[,\s]+/).map(x => x.replace(/\D/g, '')).filter(Boolean);
    if (nums.some(n => n.length < 10 || n.length > 15)) throw bad('Phone numbers need the country code, e.g. 9198xxxxxxxx');
    setSetting('alert_wa_numbers', [...new Set(nums)].slice(0, 5)); audit(req.user.username, 'alert_channel', `${nums.length} WhatsApp number(s)`);
  }
  if (typeof b.alertDigest === 'boolean') setSetting('alert_digest', b.alertDigest);
  res.json({ ok: true });
}));

// ---------- admin: system ----------
api.get('/system', requireAdmin, (_req, res) => {
  const cfg = alerts.config();
  res.json({ health: sched.health(), issues: alerts.openIssues(),
    alerts: { webhook: cfg.webhookUrl ? cfg.webhookUrl.replace(/^(https:\/\/[^/]+\/).+$/, '$1…') : '', webhookSet: !!cfg.webhookUrl, waNumbers: cfg.waNumbers, digest: cfg.digest },
    unconfirmed: db.prepare(`SELECT s.job_id, s.group_id, s.group_name, s.status, s.error, s.attempt_at, j.message FROM sends s JOIN jobs j ON j.id=s.job_id
      WHERE s.status IN ('unconfirmed','sending','uncertain') ORDER BY s.attempt_at DESC LIMIT 50`).all(),
    version: process.env.SOURCE_COMMIT || process.env.COOLIFY_SOURCE_COMMIT || 'dev', instance: sched.OWNER });
});
api.get('/events', requireAdmin, (req, res) => {
  const level = ['info', 'warn', 'error'].includes(req.query.level) ? req.query.level : null;
  const q = String(req.query.q || '').trim();
  const rows = db.prepare(`SELECT * FROM events WHERE (? IS NULL OR level = ? OR (? = 'warn' AND level = 'error'))
    AND (? = '' OR message LIKE ? OR kind LIKE ? OR group_name LIKE ?) ORDER BY id DESC LIMIT 300`)
    .all(level, level, level, q, `%${q}%`, `%${q}%`, `%${q}%`);
  res.json({ events: rows });
});
api.post('/alerts/test', requireAdmin, wrap(async (req, res) => {
  const r = await alerts.test(req.user.username);
  if (!r.length) throw bad('No alert channel is set up yet. Add a webhook link or a WhatsApp number first.');
  res.json({ ok: true, delivered: r });
}));
api.post('/issues/:key/dismiss', requireAdmin, wrap(async (req, res) => {
  await alerts.clear(req.params.key);
  audit(req.user.username, 'issue_dismissed', req.params.key);
  res.json({ ok: true });
}));

// ---------- exports (archive) ----------
const csv = rows => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = v => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : t; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
};
api.get('/export/:what', requireAdmin, (req, res) => {
  const ist = ms => (ms ? formatIst(ms) : '');
  let rows;
  if (req.params.what === 'sends.csv') {
    rows = db.prepare(`SELECT s.id, s.job_id, s.group_name, s.status, s.attempts, s.verified, s.attempt_at, s.sent_at, s.error, s.wa_message_id, j.message, j.created_by
      FROM sends s JOIN jobs j ON j.id=s.job_id ORDER BY s.id DESC`).all().map(r => ({ ...r, attempt_at: ist(r.attempt_at), sent_at: ist(r.sent_at) }));
  } else if (req.params.what === 'events.csv') {
    rows = db.prepare('SELECT id, at, level, kind, job_id, group_name, message FROM events ORDER BY id DESC LIMIT 50000').all().map(r => ({ ...r, at: ist(r.at) }));
  } else if (req.params.what === 'jobs.csv') {
    rows = db.prepare('SELECT id, status, run_at, repeat_days, gap_min, gap_max, created_by, updated_by, message, groups_json FROM jobs ORDER BY id DESC').all().map(r => ({ ...r, run_at: ist(r.run_at) }));
  } else return res.status(404).json({ error: 'Not found' });
  audit(req.user.username, 'export', req.params.what);
  res.setHeader('Content-Disposition', `attachment; filename="wabox-${req.params.what.replace('.csv', '')}-${epochToIst(Date.now()).date}.csv"`);
  res.type('text/csv').send(csv(rows));
});

// ---------- admin: users ----------
api.get('/users', requireAdmin, (_req, res) => res.json({ users: db.prepare('SELECT id,username,role,must_change,disabled,created_at FROM users ORDER BY username').all() }));
api.post('/users', requireAdmin, wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  try { auth.createUser(String(username || '').trim(), password, role, true); }
  catch (e) { throw bad(/UNIQUE/.test(e.message) ? 'That username already exists' : e.message); }
  audit(req.user.username, 'user_created', `${username} (${role})`);
  res.json({ ok: true });
}));
api.post('/users/:id/reset', requireAdmin, wrap(async (req, res) => {
  auth.resetPassword(Number(req.params.id), req.body?.password);
  audit(req.user.username, 'user_reset', `#${req.params.id}`);
  res.json({ ok: true });
}));
api.post('/users/:id/disable', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad("You can't disable yourself");
  const disabled = req.body?.disabled ? 1 : 0;
  if (disabled) {
    const target = db.prepare('SELECT role FROM users WHERE id=?').get(id);
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n;
    if (target?.role === 'admin' && admins <= 1) throw bad('Keep at least one active admin');
  }
  db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled, id);
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(req.user.username, disabled ? 'user_disabled' : 'user_enabled', `#${id}`);
  res.json({ ok: true });
}));
api.get('/audit', requireAdmin, (_req, res) => res.json({ audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all() }));

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((_req, res) => res.status(404).send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status < 500 ? err.message : 'Server error' });
});

auth.seedAdmin();
if (getSetting('dry_run', null) === null) setSetting('dry_run', process.env.DRY_RUN !== 'false');
const server = app.listen(PORT, () => {
  console.log(`WA Box listening on :${PORT} (base path "${BASE_PATH || '/'}"), dry run: ${sched.settings().dryRun}`);
  sched.startLoop();
});
// Redeploys send SIGTERM: finish the message in flight, never start another, then exit.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    logEvent('info', 'shutdown', `Received ${sig}; finishing the current send and stopping`);
    server.close();
    await sched.stop();
    process.exit(0);
  });
}
process.on('unhandledRejection', e => logEvent('error', 'crash', 'Unhandled: ' + (e?.stack || e)));
