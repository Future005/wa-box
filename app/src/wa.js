// Client for the WA Box engine (engine/): our own whatsapp-web.js service on the private
// Docker network. This is the ONLY file that knows how WhatsApp is reached.
const BASE = (process.env.WA_ENGINE_URL || 'http://engine:3100').replace(/\/$/, '');
const SEND_TIMEOUT_MS = Number(process.env.WABOX_SEND_TIMEOUT_MS || 60000);

function apiKey() {
  const k = (process.env.WA_ENGINE_KEY || '').trim();
  if (!k) throw new Error('Engine API key not configured');
  return k;
}

class EngineError extends Error {
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
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new EngineError(res.status, (data && data.message) || `HTTP ${res.status}`);
  return data;
}

const getStatus = async () => {
  const s = await call('GET', '/status', undefined, { timeoutMs: 15000 });
  return { status: s.status, phone: s.phone || null, pushName: s.pushName || null, waVersion: s.waVersion || null, engineError: s.error || null };
};
const start = () => call('POST', '/start');
const getQr = () => call('GET', '/qr');
const logout = () => call('POST', '/logout');

async function listGroups({ timeoutMs = 60000 } = {}) {
  const groups = await call('GET', '/groups', undefined, { timeoutMs });
  return groups.filter(g => g?.id?.endsWith('@g.us')).map(g => ({ id: g.id, name: g.name || g.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const typing = (chatId, state = 'typing') => call('POST', '/typing', { chatId, state }, { timeoutMs: 25000 });
const sendText = (chatId, text, { linkPreview = true } = {}) =>
  call('POST', '/send-text', { chatId, text, linkPreview }, { timeoutMs: SEND_TIMEOUT_MS });
const sendImage = (chatId, base64, mimetype, caption) =>
  call('POST', '/send-image', { chatId, base64, mimetype, caption: caption || undefined }, { timeoutMs: SEND_TIMEOUT_MS * 2 });
const sendImageUrl = (chatId, url, caption) =>
  call('POST', '/send-image', { chatId, url, caption: caption || undefined }, { timeoutMs: SEND_TIMEOUT_MS * 2 });
const history = (chatId, limit = 25) =>
  call('GET', `/history?chatId=${encodeURIComponent(chatId)}&limit=${limit}`, undefined, { timeoutMs: 45000 });

/**
 * Did the request definitely NOT send? The engine answers 4xx only when it rejected the
 * request before anything reached WhatsApp; a refused connection means the engine never got it.
 * Everything else (timeouts, 5xx, dropped connections) is "maybe sent".
 */
function definitelyNotSent(err) {
  if (err instanceof EngineError) return err.status >= 400 && err.status < 500;
  const code = err?.cause?.code || err?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) || /not configured/.test(err?.message || '');
}

// Kept for call sites written for the old gateway; there is a single fixed session now.
const ensureSession = async () => 'wabox';
const resetSession = () => {};

module.exports = { ensureSession, resetSession, getStatus, start, getQr, logout, listGroups, typing, sendText, sendImage, sendImageUrl, history,
  definitelyNotSent, EngineError, GatewayError: EngineError };
