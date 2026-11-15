// The WhatsApp connection state machine, as the engine sees it. This mirrors the 'connection'
// machine in app/public/machines.js (the app adds "unknown" and "unreachable"); a test in the app
// keeps the two in step. The engine image doesn't include the app, so it carries its own copy.
// setStatus() checks every change against this list and logs anything unexpected (never blocks).
const STATES = ['created', 'initializing', 'qr_ready', 'authenticating', 'ready', 'disconnected', 'failed'];

const TRANSITIONS = [
  ['created', 'start', 'initializing'],
  ['initializing', 'need_scan', 'qr_ready'],
  ['initializing', 'session_found', 'authenticating'],
  ['initializing', 'start_failed', 'failed'],
  ['qr_ready', 'scanned', 'authenticating'],
  ['authenticating', 'ready', 'ready'],
  ['authenticating', 'login_failed', 'failed'],
  ...['qr_ready', 'authenticating', 'ready'].map(s => [s, 'dropped', 'disconnected']),
  ...['qr_ready', 'authenticating', 'ready', 'disconnected', 'failed'].map(s => [s, 'restart', 'initializing']),
  ['initializing', 'ready', 'ready'],
  ['qr_ready', 'login_failed', 'failed'],
  ['qr_ready', 'ready', 'ready'],                    // some sessions report ready without "authenticated"
];

const allowed = (from, to) => from === to || TRANSITIONS.some(([f, , t]) => f === from && t === to);

module.exports = { STATES, TRANSITIONS, allowed };
