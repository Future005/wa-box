// Private API used only by WA Box over the internal Docker network.
// Every route except /health needs the X-API-Key header.
// Error contract (WA Box relies on it to avoid double sends):
//   4xx = definitely NOT sent (rejected before anything went to WhatsApp)
//   5xx / no answer = maybe sent; WA Box checks the chat before doing anything else.
const http = require('node:http');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { withTimeout } = require('./engine');

const MAX_BODY = 12 * 1024 * 1024;           // base64 of a 5 MB image fits
const IMG_MAX = 5 * 1024 * 1024;
const CHAT_ID = /^[\w.-]{1,64}@(g\.us|c\.us)$/;

const bad = (status, message) => Object.assign(new Error(message), { status });

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Refuse to fetch images from private/internal addresses.
const blocked = new net.BlockList();
for (const [a, p] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['::', 128]]) blocked.addSubnet(a, p, 'ipv6');
async function assertPublicHttps(u) {
  let url; try { url = new URL(u); } catch { throw bad(400, 'Invalid image link'); }
  if (url.protocol !== 'https:') throw bad(400, 'Image link must be https');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => { throw bad(400, "Image link host can't be found"); });
  if (addrs.some(a => blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) throw bad(400, 'Image link points to a private address');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(bad(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

function createServer(engine, { apiKey, MessageMediaImpl } = {}) {
  if (!apiKey || apiKey.length < 32) throw new Error('ENGINE_API_KEY must be set (32+ characters)');
  const MessageMedia = MessageMediaImpl || require('whatsapp-web.js').MessageMedia;
  const chatId = id => { if (!CHAT_ID.test(String(id || ''))) throw bad(400, 'Invalid chatId'); return id; };

  const routes = {
    'GET /status': async () => engine.state(),
    'POST /start': async () => { engine.start(); return { ok: true }; },
    'POST /logout': async () => { engine.logout(); return { ok: true }; },
    'GET /qr': async () => {
      if (engine.status === 'ready') throw bad(400, 'Already connected');
      if (!engine.qrDataUrl) throw bad(400, 'QR code not ready yet');
      return { qrCode: engine.qrDataUrl, status: engine.status };
    },
    'GET /groups': async () => {
      const c = engine.ready();
      const chats = await withTimeout(c.getChats(), 280000, 'reading chats');
      return chats.filter(ch => ch.isGroup).map(ch => ({ id: ch.id._serialized, name: ch.name || ch.id._serialized }));
    },
    'GET /history': async (_b, q) => {
      const c = engine.ready();
      const chat = await withTimeout(c.getChatById(chatId(q.get('chatId'))), 30000, 'opening chat');
      const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 25));
      const msgs = await withTimeout(chat.fetchMessages({ limit }), 40000, 'reading messages');
      return msgs.map(m => ({ id: m.id?._serialized, body: m.body || '', fromMe: !!m.fromMe, timestamp: m.timestamp, type: m.type }));
    },
    'POST /receipts': async b => {
      const ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string' && x.length < 200) : [];
      if (!ids.length) throw bad(400, 'ids required');
      return engine.receipts(ids);
    },
    'POST /typing': async b => {
      const c = engine.ready();
      const chat = await withTimeout(c.getChatById(chatId(b.chatId)), 20000, 'opening chat');
      if (b.state === 'paused') await chat.clearState(); else await chat.sendStateTyping();
      return { ok: true };
    },
    'POST /send-text': async b => {
      chatId(b.chatId);
      const text = String(b.text || '');
      if (!text.trim() || text.length > 65000) throw bad(400, 'Text is empty or too long');
      return engine.guardSend(async c => {
        const m = await c.sendMessage(b.chatId, text, { linkPreview: b.linkPreview !== false });
        return { messageId: m?.id?._serialized || null };
      });
    },
    'POST /send-image': async b => {
      chatId(b.chatId);
      let media;
      if (b.base64) {
        if (!/^image\/(jpeg|png|webp)$/.test(b.mimetype || '')) throw bad(400, 'Image must be JPG, PNG or WebP');
        if (Buffer.byteLength(b.base64, 'base64') > IMG_MAX) throw bad(400, 'Image is over 5 MB');
        media = new MessageMedia(b.mimetype, b.base64, 'image');
      } else if (b.url) {
        engine.ready();
        await assertPublicHttps(b.url);
        try { media = await withTimeout(MessageMedia.fromUrl(b.url, { unsafeMime: true, reqOptions: { size: IMG_MAX } }), 30000, 'downloading image'); }
        catch (e) { throw bad(400, `Couldn't download the image: ${e.message}`); }
        if (!/^image\/(jpeg|png|webp)/.test(media?.mimetype || '')) throw bad(400, 'The link is not a JPG, PNG or WebP image');
      } else throw bad(400, 'No image given');
      return engine.guardSend(async c => {
        const m = await c.sendMessage(b.chatId, media, { caption: b.caption || undefined });
        return { messageId: m?.id?._serialized || null };
      });
    },
  };

  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://engine');
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, status: engine.status });
    if (!safeEqual(req.headers['x-api-key'], apiKey)) return send(401, { message: 'Unauthorized' });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(404, { message: 'Not found' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      send(200, await route(body, url.searchParams));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(`${new Date().toISOString()} [error] ${req.method} ${url.pathname}: ${e.message}`);
      send(status, { message: e.message || 'Engine error' });
    }
  });
}

module.exports = { createServer };

if (require.main === module) {
  const { Engine } = require('./engine');
  const engine = new Engine();
  const server = createServer(engine, { apiKey: process.env.ENGINE_API_KEY });
  const port = Number(process.env.PORT || 3100);
  server.listen(port, () => {
    console.log(`${new Date().toISOString()} [info] engine listening on :${port}`);
    engine.start();
    setInterval(() => engine.watchdog().catch(e => console.error('watchdog', e.message)), 60000);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`${new Date().toISOString()} [info] ${sig}: closing WhatsApp cleanly`);
      server.close();
      await engine.stop();
      process.exit(0);
    });
  }
  process.on('unhandledRejection', e => console.error(`${new Date().toISOString()} [error] unhandled: ${e?.stack || e}`));
}
