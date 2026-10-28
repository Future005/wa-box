// One WhatsApp Web session in headless Chrome, kept alive.
//
// What this file is responsible for:
//  1. Keep the login: LocalAuth stores it on the /data volume; restarts reuse it (no new QR).
//  2. Self-heal: reconnect after a drop, retry a failed start with backoff, and restart Chrome
//     when it stops answering, grows past a memory limit, or once a night at ~04:00 IST.
//  3. Pin a known-good WhatsApp Web version: every time the session reaches "ready" we record the
//     version. If starting fails twice in a row (often a WhatsApp Web change), we retry pinned to
//     the last version that worked. WA_WEB_VERSION forces a specific version.
//  4. Chrome runs headless with a minimal flag set inside a locked-down container (see compose).
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const DATA = process.env.DATA_DIR || '/data';
const GOOD_VERSION_FILE = path.join(DATA, 'last-good-wa-version.txt');
const WA_VERSION_URL = v => `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${v}.html`;
const CHROME_MAX_MB = Number(process.env.CHROME_MAX_MB || 1500);
const IST = 330 * 60000;

const log = (level, msg) => console[level === 'error' ? 'error' : 'log'](`${new Date().toISOString()} [${level}] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}

class Engine {
  constructor({ ClientImpl, LocalAuthImpl, chromePath } = {}) {
    const wweb = ClientImpl ? null : require('whatsapp-web.js');
    this.Client = ClientImpl || wweb.Client;
    this.LocalAuth = LocalAuthImpl || wweb.LocalAuth;
    this.chromePath = chromePath || process.env.CHROME_PATH || undefined;
    this.client = null;
    this.status = 'created';          // created | initializing | qr_ready | authenticating | ready | disconnected | failed
    this.since = Date.now();
    this.qr = null; this.qrDataUrl = null;
    this.info = { phone: null, pushName: null, waVersion: null };
    this.lastError = null;
    this.initFailures = 0;
    this.inFlight = 0;
    this.lastSendAt = 0;
    this.restarting = null;
    this.stopping = false;
    this.strikes = 0;
    this.lastNightly = null;
    this.acks = new Map();   // messageId -> latest WhatsApp receipt (1 sent, 2 delivered, 3 read)
  }

  setStatus(s, why = '') {
    if (s !== this.status) log(s === 'ready' ? 'info' : 'warn', `status ${this.status} -> ${s}${why ? ` (${why})` : ''}`);
    this.status = s; this.since = Date.now();
    if (s !== 'qr_ready') { this.qr = null; this.qrDataUrl = null; }
  }

  versionPin() {
    const forced = (process.env.WA_WEB_VERSION || '').trim();
    let v = forced;
    if (!v && this.initFailures >= 2 && fs.existsSync(GOOD_VERSION_FILE)) v = fs.readFileSync(GOOD_VERSION_FILE, 'utf8').trim();
    if (!v) return { webVersionCache: { type: 'none' } };   // live WhatsApp Web build
    log('info', `using pinned WhatsApp Web version ${v}${forced ? ' (WA_WEB_VERSION)' : ' (last known good)'}`);
    return { webVersion: v, webVersionCache: { type: 'remote', remotePath: WA_VERSION_URL(v) } };
  }

  build() {
    const c = new this.Client({
      authStrategy: new this.LocalAuth({ clientId: 'wabox', dataPath: path.join(DATA, 'session') }),
      puppeteer: {
        headless: true,
        executablePath: this.chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
          '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--lang=en-US'],
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        protocolTimeout: 120000,
      },
      authTimeoutMs: 120000,
      takeoverOnConflict: true,
      ...this.versionPin(),
    });
    c.on('qr', async qr => {
      this.setStatus('qr_ready', 'waiting for scan');
      this.qr = qr;
      try { this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch { this.qrDataUrl = null; }
    });
    c.on('authenticated', () => this.setStatus('authenticating'));
    c.on('auth_failure', m => { this.lastError = `Login failed: ${m}`; this.setStatus('failed', m); });
    c.on('ready', async () => {
      this.initFailures = 0; this.strikes = 0; this.lastError = null;
      try {
        this.info.phone = c.info?.wid?.user || null;
        this.info.pushName = c.info?.pushname || null;
        this.info.waVersion = await c.getWWebVersion();
        if (this.info.waVersion) fs.writeFileSync(GOOD_VERSION_FILE, this.info.waVersion);
      } catch (e) { log('warn', 'could not read session info: ' + e.message); }
      this.setStatus('ready', `WhatsApp Web ${this.info.waVersion || '?'}`);
    });
    c.on('change_state', s => log('info', `whatsapp state ${s}`));
    // Delivery receipts for messages we sent. Kept in memory (bounded); WA Box asks for them.
    c.on('message_ack', (msg, ack) => {
      if (!msg?.fromMe || !msg.id?._serialized) return;
      this.acks.set(msg.id._serialized, ack);
      if (this.acks.size > 5000) this.acks.delete(this.acks.keys().next().value);
    });
    c.on('disconnected', reason => {
      if (this.client !== c || this.stopping) return;
      this.lastError = `Disconnected: ${reason}`;
      this.setStatus('disconnected', reason);
      // LOGOUT means the device was unlinked from the phone: start fresh so a new QR appears.
      this.restart(String(reason) === 'LOGOUT' ? 'logged out from the phone' : 'connection dropped', { delayMs: 10000 });
    });
    return c;
  }

  /** Start if not running. Safe to call repeatedly. */
  async start() {
    if (this.stopping) return;
    if (this.client && !['failed', 'disconnected'].includes(this.status)) return;
    if (this.restarting) return this.restarting;
    return this.restart('start');
  }

  async restart(reason, { delayMs = 0 } = {}) {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      if (delayMs) await sleep(delayMs);
      // Never pull the browser out from under a message that's being sent.
      for (let i = 0; i < 60 && this.inFlight > 0; i++) await sleep(500);
      log('warn', `starting WhatsApp (${reason})`);
      await this.teardown();
      if (this.stopping) return;
      this.setStatus('initializing', reason);
      const c = this.build();
      this.client = c;
      try {
        await withTimeout(c.initialize(), 240000, 'start');
      } catch (e) {
        this.initFailures++;
        this.lastError = `Start failed: ${e.message}`;
        this.setStatus('failed', e.message);
        await this.teardown();   // free Chrome's memory while we wait to retry
        const wait = Math.min(300000, 30000 * 2 ** (this.initFailures - 1));
        log('error', `start failed (${this.initFailures}x), retrying in ${wait / 1000}s`);
        setTimeout(() => { this.restarting = null; this.restart('retry after failed start'); }, wait).unref();
      }
    })().finally(() => { this.restarting = null; });
    return this.restarting;
  }

  async teardown() {
    const c = this.client; this.client = null;
    if (!c) return;
    const proc = c.pupBrowser?.process?.();
    try { await withTimeout(c.destroy(), 20000, 'close'); } catch (e) { log('warn', 'close: ' + e.message); }
    try { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Latest receipt for each id: from events we saw, else asked from WhatsApp Web. */
  async receipts(ids) {
    const c = this.ready(); const out = {};
    for (const id of ids.slice(0, 100)) {
      if (this.acks.has(id) && this.acks.get(id) >= 2) { out[id] = this.acks.get(id); continue; }
      try {
        const m = await withTimeout(c.getMessageById(id), 10000, 'reading receipt');
        if (m && typeof m.ack === 'number') { out[id] = m.ack; this.acks.set(id, m.ack); }
        else if (this.acks.has(id)) out[id] = this.acks.get(id);
      } catch { if (this.acks.has(id)) out[id] = this.acks.get(id); }
    }
    return out;
  }

  async logout() {
    if (this.client && this.status === 'ready') {
      try { await withTimeout(this.client.logout(), 30000, 'logout'); } catch (e) { log('warn', 'logout: ' + e.message); }
    }
    try { fs.rmSync(path.join(DATA, 'session'), { recursive: true, force: true }); } catch { /* ignore */ }
    this.info = { phone: null, pushName: null, waVersion: this.info.waVersion };
    return this.restart('logged out from WA Box');
  }

  ready() {
    if (this.status !== 'ready' || !this.client) {
      throw Object.assign(new Error(`WhatsApp is not ready (${this.status})`), { status: 409 });
    }
    return this.client;
  }

  async guardSend(fn) {
    const c = this.ready();
    this.inFlight++;
    try { const r = await fn(c); this.lastSendAt = Date.now(); return r; } finally { this.inFlight--; }
  }

  // ---------- watchdog ----------
  chromeRssMb() {
    const pid = this.client?.pupBrowser?.process?.()?.pid;
    if (!pid) return 0;
    try {
      const kids = new Map();
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
          if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d));
        } catch { /* process ended */ }
      }
      let kb = 0; const stack = [pid];
      while (stack.length) {
        const p = stack.pop();
        // Pss splits memory shared between Chrome's processes fairly, so the total isn't double-counted.
        try { kb += Number((fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m) || [])[1] || 0); }
        catch { try { kb += Number((fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1] || 0); } catch { /* gone */ } }
        stack.push(...(kids.get(p) || []));
      }
      return Math.round(kb / 1024);
    } catch { return 0; }
  }

  async watchdog() {
    if (this.stopping || this.restarting) return;
    if (['failed', 'disconnected', 'created'].includes(this.status) && !this.restarting && Date.now() - this.since > 60000) {
      return this.restart(`still ${this.status} after a minute`);
    }
    if (this.status !== 'ready') return;
    // Is the page still answering?
    try {
      const state = await withTimeout(this.client.getState(), 30000, 'health check');
      if (state === 'CONNECTED') this.strikes = 0;
      else { this.strikes++; log('warn', `health check: state ${state} (${this.strikes}/3)`); }
    } catch (e) { this.strikes++; log('warn', `health check failed (${this.strikes}/3): ${e.message}`); }
    if (this.strikes >= 3) { this.strikes = 0; return this.restart('Chrome stopped answering'); }
    // Too much memory?
    const mb = this.chromeRssMb();
    if (mb > CHROME_MAX_MB && Date.now() - this.lastSendAt > 120000) return this.restart(`Chrome using ${mb} MB (limit ${CHROME_MAX_MB})`);
    // Nightly refresh around 04:00 IST, only when idle.
    const d = new Date(Date.now() + IST); const day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === 4 && d.getUTCMinutes() < 20 && this.lastNightly !== day && Date.now() - this.lastSendAt > 5 * 60000) {
      this.lastNightly = day;
      return this.restart('nightly refresh');
    }
  }

  async stop() {
    this.stopping = true;
    for (let i = 0; i < 60 && this.inFlight > 0; i++) await sleep(500);
    await this.teardown();
  }

  state() {
    return { status: this.status, since: this.since, phone: this.info.phone, pushName: this.info.pushName,
      waVersion: this.info.waVersion, error: this.lastError, chromeMb: this.chromeRssMb() };
  }
}

module.exports = { Engine, withTimeout };
