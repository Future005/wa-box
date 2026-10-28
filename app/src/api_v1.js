// Public API: /api/v1. Lets a Google Sheet, Zapier, a CRM or a script schedule messages
// with the same safety rules as the app (same validation, same limits, same duplicate guard),
// because it calls the same createJob() the app uses.
//
// Auth:   Authorization: Bearer wbx_...   (or X-API-Key: wbx_...)
// Errors: { "error": { "code": "invalid_request", "message": "Pick at least one group" } }
// Full reference: docs/API.md and /openapi.yaml
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('./db');
const keys = require('./apikeys');
const savedGroups = require('./groups');
const sched = require('./scheduler');
const { validateJobInput, createJob, UNDO_MS } = require('./jobs');
const { epochToIst } = require('./time');

const router = express.Router();
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const PACING = { gentle: [60, 180], standard: [40, 120] };

const fail = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

router.use(express.json({ limit: '100kb' }));
router.use((req, res, next) => {
  const h = req.get('Authorization') || '';
  const raw = h.toLowerCase().startsWith('bearer ') ? h.slice(7) : req.get('X-API-Key');
  if (!raw) return fail(res, 401, 'unauthorized', 'Send your API key as "Authorization: Bearer wbx_..."');
  const key = keys.verify(raw);
  if (!key) return fail(res, 401, 'unauthorized', 'That API key is not valid or was revoked');
  req.key = key;
  next();
});
router.use(rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.WABOX_API_RATE || 60), standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => 'k' + req.key.id,
  handler: (_req, res) => fail(res, 429, 'rate_limited', 'Too many requests. The limit is 60 a minute per key.') }));

const need = scope => (req, res, next) => keys.allows(req.key, scope) ? next()
  : fail(res, 403, 'forbidden', `This key can only ${req.key.scope === 'read' ? 'read' : 'schedule'}. Make a key with the "${scope}" scope.`);
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  if (e.status && e.status < 500) return fail(res, e.status, e.code || 'invalid_request', e.message);
  console.error('[api/v1]', req.method, req.path, e);
  fail(res, 500, 'server_error', 'Something went wrong on our side. Nothing was scheduled.');
});

// ---------- helpers ----------
function visibleGroups(key) {
  const allowed = keys.allowedGroupIds(key);
  return savedGroups.list().filter(g => !allowed || allowed.has(g.id));
}
const iso = ms => (ms ? new Date(ms).toISOString() : null);

function publicMessage(j) {
  const groups = JSON.parse(j.groups_json);
  const sends = db.prepare('SELECT group_id, status, sent_at, error, ack FROM sends WHERE job_id=? AND occurrence=?').all(j.id, j.run_at);
  const byId = Object.fromEntries(sends.map(s => [s.group_id, s]));
  return {
    id: j.id, title: j.title || null, text: j.message, status: j.status, note: j.note || null,
    sendAt: iso(j.run_at), startsAt: iso(j.start_at), timezone: 'Asia/Kolkata', ...epochToIst(j.run_at),
    repeat: JSON.parse(j.repeat_days).map(d => DAY_NAMES[d]),
    pacing: { minSeconds: j.gap_min, maxSeconds: j.gap_max },
    imageUrl: j.media_url || null, hasUploadedImage: !!j.media_file, linkPreview: j.link_preview !== 0,
    createdBy: j.created_by, createdAt: iso(j.created_at),
    groups: groups.map(g => ({ id: g.id, name: g.name, status: byId[g.id]?.status || 'pending', sentAt: iso(byId[g.id]?.sent_at),
      delivery: byId[g.id]?.ack >= 3 ? 'read' : byId[g.id]?.ack === 2 ? 'delivered' : byId[g.id]?.ack === 1 ? 'sent' : null,
      error: byId[g.id]?.error || null })),
  };
}

function getMessage(req) {
  const id = Number(req.params.id);
  const j = Number.isInteger(id) && db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!j) throw err(404, 'not_found', 'No message with that id');
  // A key limited to some lists only sees messages whose groups are all inside them.
  const allowed = keys.allowedGroupIds(req.key);
  if (allowed && !JSON.parse(j.groups_json).every(g => allowed.has(g.id))) throw err(404, 'not_found', 'No message with that id');
  return j;
}

/** Turn API input (group names or ids, list names, ISO time, pacing words) into the app's form fields. */
function toFormBody(b, key) {
  if (!b || typeof b !== 'object') throw err(400, 'invalid_request', 'Send a JSON body');
  const text = b.text ?? b.message;
  const visible = visibleGroups(key);
  const ids = new Set();
  const unknown = [];
  const findGroup = ref => {
    const r = String(ref).trim();
    return visible.find(g => g.id === r) || visible.find(g => g.name.toLowerCase() === r.toLowerCase());
  };
  for (const ref of [].concat(b.groups || [])) {
    const g = findGroup(ref);
    if (g) ids.add(g.id); else unknown.push(String(ref));
  }
  const listRefs = [].concat(b.lists || [], b.list ? [b.list] : []);
  if (listRefs.length) {
    const all = savedGroups.lists();
    for (const ref of listRefs) {
      const r = String(ref).trim();
      const l = all.find(x => String(x.id) === r) || all.find(x => x.name.toLowerCase() === r.toLowerCase());
      if (!l || (key.listIds && !key.listIds.includes(l.id))) { unknown.push(`list: ${r}`); continue; }
      for (const g of l.groups) if (visible.some(v => v.id === g.id)) ids.add(g.id);
    }
  }
  if (unknown.length) {
    throw err(400, 'unknown_group', `Not found in the saved groups${key.listIds ? ' this key may use' : ''}: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}. GET /api/v1/groups lists them.`);
  }

  // When: "now", an ISO time ("2026-11-01T10:00:00+05:30"), or { date, time } in India time.
  let date, time;
  const at = b.sendAt;
  if (at === undefined || at === null || at === '') throw err(400, 'invalid_request', 'Give sendAt: "now", an ISO time like "2026-11-01T10:00:00+05:30", or { "date": "2026-11-01", "time": "10:00" } (India time)');
  if (typeof at === 'object') {
    ({ date, time } = at);
  } else if (String(at).toLowerCase() === 'now') {
    ({ date, time } = epochToIst(Date.now()));
  } else {
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(at))) throw err(400, 'invalid_request', 'sendAt needs a timezone, e.g. "2026-11-01T10:00:00+05:30" or "...Z"');
    const ms = Date.parse(String(at));
    if (!Number.isFinite(ms)) throw err(400, 'invalid_request', 'sendAt is not a valid date-time');
    ({ date, time } = epochToIst(ms));
  }

  let gapMin, gapMax;
  const p = b.pacing ?? 'standard';
  if (typeof p === 'string') {
    if (!PACING[p]) throw err(400, 'invalid_request', 'pacing is "gentle", "standard", or { "minSeconds": 40, "maxSeconds": 120 }');
    [gapMin, gapMax] = PACING[p];
  } else {
    gapMin = Number(p.minSeconds ?? p.min); gapMax = Number(p.maxSeconds ?? p.max ?? gapMin);
  }

  const repeatDays = [];
  for (const d of [].concat(b.repeat || [])) {
    const i = DAY_NAMES.indexOf(String(d).trim().toLowerCase().slice(0, 3));
    if (i < 0) throw err(400, 'invalid_request', `repeat takes day names like "sat", "sun". Got "${d}".`);
    repeatDays.push(i);
  }
  return { message: text, title: b.title, groups: [...ids], date, time, gapMin, gapMax, repeatDays,
    imageUrl: b.imageUrl, linkPreview: b.linkPreview === false ? false : true };
}

// ---------- routes ----------
router.get('/status', wrap(async (req, res) => {
  const h = sched.health();
  const cfg = sched.settings();
  res.json({
    whatsapp: h.whatsapp.status === 'ready' ? 'connected' : 'disconnected',
    sending: cfg.paused ? 'paused' : 'on',
    practiceMode: cfg.dryRun,
    limits: { perDay: cfg.dailyCap, perHour: cfg.hourlyCap, sentToday: sched.sentToday(), minGapSeconds: sched.HARD_MIN_GAP_S },
    key: { name: req.key.name, scope: req.key.scope, limitedToLists: req.key.listIds },
    timezone: 'Asia/Kolkata',
  });
}));

router.get('/groups', (req, res) => res.json({ groups: visibleGroups(req.key) }));

router.get('/lists', (req, res) => {
  const ls = savedGroups.lists().filter(l => !req.key.listIds || req.key.listIds.includes(l.id));
  res.json({ lists: ls.map(l => ({ id: l.id, name: l.name, groups: l.groups })) });
});

router.get('/messages', wrap(async (req, res) => {
  const view = req.query.status === 'history' ? 'history' : 'upcoming';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = view === 'upcoming'
    ? db.prepare("SELECT * FROM jobs WHERE status IN ('scheduled','running') ORDER BY start_at LIMIT ?").all(limit * 2)
    : db.prepare("SELECT * FROM jobs WHERE status NOT IN ('scheduled','running') ORDER BY updated_at DESC LIMIT ?").all(limit * 2);
  const allowed = keys.allowedGroupIds(req.key);
  const mine = rows.filter(j => !allowed || JSON.parse(j.groups_json).every(g => allowed.has(g.id))).slice(0, limit);
  res.json({ messages: mine.map(publicMessage) });
}));

router.get('/messages/:id', wrap(async (req, res) => res.json({ message: publicMessage(getMessage(req)) })));

router.post('/messages', need('schedule'), wrap(async (req, res) => {
  const idem = String(req.get('Idempotency-Key') || '').trim();
  if (idem.length > 100) throw err(400, 'invalid_request', 'Idempotency-Key is too long (max 100)');
  if (idem) {
    const prev = keys.idemGet(req.key.id, idem, req.body);
    if (prev?.conflict) throw err(409, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request');
    if (prev) { res.set('Idempotent-Replayed', 'true'); return res.status(prev.status).json(prev.body); }
  }
  const v = await validateJobInput(toFormBody(req.body, req.key));
  const id = createJob(v, { createdBy: `api:${req.key.name}` });
  const body = { message: publicMessage(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)), undoSeconds: UNDO_MS / 1000 };
  if (idem) keys.idemPut(req.key.id, idem, req.body, 201, body);
  res.status(201).json(body);
}));

router.delete('/messages/:id', need('schedule'), wrap(async (req, res) => {
  const j = getMessage(req);
  if (req.key.scope !== 'full' && j.created_by !== `api:${req.key.name}`) {
    throw err(403, 'forbidden', 'This key can only cancel messages it scheduled. Use a "full" key to cancel others.');
  }
  if (!['scheduled', 'running'].includes(j.status)) throw err(409, 'not_active', `This message is already ${j.status.replace(/_/g, ' ')}`);
  db.prepare("UPDATE jobs SET status='cancelled', note=?, updated_by=?, updated_at=? WHERE id=?")
    .run(`Cancelled through the API (${req.key.name})`, `api:${req.key.name}`, Date.now(), j.id);
  require('./db').audit(`api:${req.key.name}`, 'job_cancelled', `#${j.id}`);
  res.json({ message: publicMessage(db.prepare('SELECT * FROM jobs WHERE id=?').get(j.id)) });
}));

router.use((_req, res) => fail(res, 404, 'not_found', 'No such endpoint. See /openapi.yaml'));
// Malformed JSON and other body errors.
// eslint-disable-next-line no-unused-vars
router.use((e, _req, res, _next) => fail(res, e.status && e.status < 500 ? e.status : 400, 'invalid_request',
  e.type === 'entity.parse.failed' ? 'The body is not valid JSON' : e.message));

module.exports = router;
