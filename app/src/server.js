const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { db, DATA_DIR, getSetting, setSetting, audit } = require('./db');
const auth = require('./auth');
const wa = require('./gateway');
const sched = require('./scheduler');
const savedGroups = require('./groups');
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
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

app.get('/healthz', (_req, res) => res.json({ ok: true }));

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
    dryRun: cfg.dryRun, paused: cfg.paused, dailyCap: cfg.dailyCap, maxLateMin: cfg.maxLateMin,
    sentToday: sched.sentToday(),
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
    id: j.id, title: j.title, message: j.message, hasImage: !!j.media_file,
    groups: JSON.parse(j.groups_json), date, time, runAt: j.run_at, startAt: j.start_at,
    gapMin: j.gap_min, gapMax: j.gap_max, repeatDays: JSON.parse(j.repeat_days),
    status: j.status, note: j.note, createdBy: j.created_by, updatedBy: j.updated_by,
    createdAt: j.created_at, updatedAt: j.updated_at, sends,
  };
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

  return { message, title, chosen, runAt, time: String(body.time), gapMin, gapMax, repeatDays };
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
    ORDER BY COALESCE(s.sent_at, s.occurrence) DESC LIMIT 300`).all();
  res.json({ sends: rows.map(r => ({ id: r.id, jobId: r.job_id, title: r.title, preview: r.message.slice(0, 80),
    group: r.group_name, status: r.status, error: r.error, at: r.sent_at || r.occurrence })) });
});

api.post('/jobs', upload.single('image'), wrap(async (req, res) => {
  const v = await validateJobInput(req.body);
  const media = saveMedia(req.file);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO jobs(title,message,media_file,media_mime,groups_json,time_ist,run_at,start_at,gap_min,gap_max,
    repeat_days,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?,?,?,?)`)
    .run(v.title, v.message, media?.name || null, media?.mime || null, JSON.stringify(v.chosen), v.time, v.runAt,
      v.runAt + sched.jitter(), v.gapMin, v.gapMax, JSON.stringify(v.repeatDays), req.user.username, req.user.username, now, now);
  audit(req.user.username, 'job_created', `#${r.lastInsertRowid} ${v.chosen.length} groups at ${formatIst(v.runAt)}`);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

api.put('/jobs/:id', upload.single('image'), wrap(async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(Number(req.params.id));
  if (!job) throw bad('Job not found');
  if (job.status !== 'scheduled') throw bad('Only scheduled (not yet started) jobs can be edited');
  const v = await validateJobInput(req.body);
  let mediaFile = job.media_file, mediaMime = job.media_mime;
  if (req.body.removeImage === '1') { mediaFile = null; mediaMime = null; }
  const media = saveMedia(req.file);
  if (media) { mediaFile = media.name; mediaMime = media.mime; }
  db.prepare(`UPDATE jobs SET title=?,message=?,media_file=?,media_mime=?,groups_json=?,time_ist=?,run_at=?,start_at=?,gap_min=?,gap_max=?,
    repeat_days=?,note='',updated_by=?,updated_at=? WHERE id=? AND status='scheduled'`)
    .run(v.title, v.message, mediaFile, mediaMime, JSON.stringify(v.chosen), v.time, v.runAt, v.runAt + sched.jitter(),
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
  res.json({ ok: true });
}));

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
app.listen(PORT, () => {
  console.log(`WA Box listening on :${PORT} (base path "${BASE_PATH || '/'}"), dry run: ${sched.settings().dryRun}`);
  sched.startLoop();
});
