// Thin client for the Gateway REST API (whatsapp-web.js engine).
// Gateway is reachable only on the private Docker network; never from the internet.
const fs = require('node:fs');

const BASE = (process.env.GATEWAY_URL || 'http://gateway:2785').replace(/\/$/, '') + '/api';
const SESSION_NAME = process.env.GATEWAY_SESSION_NAME || 'wabox';

function apiKey() {
  if (process.env.GATEWAY_API_KEY) return process.env.GATEWAY_API_KEY.trim();
  // Fallback: Gateway writes a generated first-boot key into its data volume.
  const file = process.env.GATEWAY_API_KEY_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new Error('Gateway API key not configured');
}

class GatewayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(method, path, body, { timeoutMs = 60000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-API-Key': apiKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new GatewayError(res.status, Array.isArray(msg) ? msg.join(', ') : String(msg));
  }
  return data;
}

let sessionId = null;

/** Find (or create) our single WhatsApp session. */
async function ensureSession() {
  if (sessionId) return sessionId;
  const list = await call('GET', '/sessions');
  const items = Array.isArray(list) ? list : (list?.data || list?.items || []);
  let s = items.find(x => x.name === SESSION_NAME);
  if (!s) s = await call('POST', '/sessions', { name: SESSION_NAME });
  sessionId = s.id;
  return sessionId;
}

async function getStatus() {
  const id = await ensureSession();
  const s = await call('GET', `/sessions/${id}`);
  return { status: s.status, phone: s.phone || null, pushName: s.pushName || null };
}

async function start() {
  const id = await ensureSession();
  try {
    return await call('POST', `/sessions/${id}/start`, undefined, { timeoutMs: 120000 });
  } catch (e) {
    // "already started" is fine
    if (e.status === 400 && /already/i.test(e.message)) return null;
    throw e;
  }
}

async function getQr() {
  const id = await ensureSession();
  return call('GET', `/sessions/${id}/qr`);
}

async function logout() {
  const id = await ensureSession();
  return call('POST', `/sessions/${id}/logout`);
}

async function listGroups({ timeoutMs = 60000 } = {}) {
  const id = await ensureSession();
  const groups = await call('GET', `/sessions/${id}/groups?limit=1000`, undefined, { timeoutMs });
  const arr = Array.isArray(groups) ? groups : (groups?.data || []);
  return arr
    .filter(g => g && g.id && String(g.id).endsWith('@g.us'))
    .map(g => ({ id: g.id, name: g.name || g.subject || g.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function typing(chatId, state = 'typing') {
  const id = await ensureSession();
  return call('POST', `/sessions/${id}/chats/typing`, { chatId, state });
}

async function sendText(chatId, text, { linkPreview = true } = {}) {
  const id = await ensureSession();
  return call('POST', `/sessions/${id}/messages/send-text`, { chatId, text, ...(linkPreview ? {} : { linkPreview: false }) }, { timeoutMs: SEND_TIMEOUT_MS });
}

async function sendImage(chatId, base64, mimetype, caption) {
  const id = await ensureSession();
  return call('POST', `/sessions/${id}/messages/send-image`, { chatId, base64, mimetype, caption: caption || undefined }, { timeoutMs: SEND_TIMEOUT_MS * 2 });
}

/** Image fetched by the gateway from a public https link at send time. */
async function sendImageUrl(chatId, url, caption) {
  const id = await ensureSession();
  return call('POST', `/sessions/${id}/messages/send-image`, { chatId, url, caption: caption || undefined }, { timeoutMs: SEND_TIMEOUT_MS * 2 });
}

/** Recent messages in a chat, read live from WhatsApp Web (oldest first). */
async function history(chatId, limit = 25) {
  const id = await ensureSession();
  const r = await call('GET', `/sessions/${id}/messages/${encodeURIComponent(chatId)}/history?limit=${limit}`, undefined, { timeoutMs: 45000 });
  return Array.isArray(r) ? r : (r?.data || r?.messages || []);
}

/**
 * Did the request definitely NOT send? (rejected by the gateway before sending,
 * or never reached it). Anything else (timeouts, 5xx, dropped connections) is
 * "uncertain": the message may or may not have gone out.
 */
function definitelyNotSent(err) {
  if (err instanceof GatewayError) return err.status >= 400 && err.status < 500;
  const code = err?.cause?.code || err?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) || /not configured/.test(err?.message || '');
}
const SEND_TIMEOUT_MS = Number(process.env.WABOX_SEND_TIMEOUT_MS || 60000);

function resetSession() { sessionId = null; }

module.exports = { ensureSession, resetSession, getStatus, start, getQr, logout, listGroups, typing, sendText, sendImage, sendImageUrl, history, definitelyNotSent, GatewayError };
