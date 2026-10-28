const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');

const COOKIE = 'wabox_sid';
const IDLE_MS = 12 * 3600 * 1000;      // 12h of inactivity
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // absolute 7 days
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 10;
const USERNAME_RE = /^[a-zA-Z0-9._@+-]{3,64}$/;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Fixed dummy hash so unknown usernames take the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-never-valid', 12);

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 200) return 'Password is too long';
  return null;
}

function createUser(username, password, role, mustChange = true) {
  if (!USERNAME_RE.test(username || '')) throw new Error('Username: 3-64 characters (letters, numbers, . _ - @ +), e.g. a name or an email');
  const err = validatePassword(password);
  if (err) throw new Error(err);
  if (!['admin', 'member'].includes(role)) throw new Error('Invalid role');
  const hash = bcrypt.hashSync(password, 12);
  return db.prepare('INSERT INTO users(username,pass_hash,role,must_change,created_at) VALUES(?,?,?,?,?)')
    .run(username, hash, role, mustChange ? 1 : 0, Date.now());
}

/** Seed the first admin from env (Coolify generates the password). */
function seedAdmin() {
  const username = process.env.ADMIN_USER || 'admin';
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count > 0) {
    // ADMIN_USER changed after first boot: rename the original seeded 'admin' account once.
    const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    const original = db.prepare("SELECT id FROM users WHERE username = 'admin' AND role = 'admin'").get();
    if (!taken && original && USERNAME_RE.test(username)) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, original.id);
      audit('system', 'admin_renamed', `admin -> ${username}`);
      console.log(`[auth] admin account renamed to ${username}`);
    }
    return;
  }
  let password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < MIN_PASSWORD) {
    password = crypto.randomBytes(12).toString('base64url');
    console.log('==================================================================');
    console.log(` WA Box first admin created. Username: ${username}`);
    console.log(` One-time password: ${password}`);
    console.log(' You will be asked to change it on first login.');
    console.log('==================================================================');
  }
  createUser(username, password, 'admin', true);
  audit('system', 'seed_admin', username);
}

function login(username, password, ip) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  const now = Date.now();
  if (!user || user.disabled) {
    bcrypt.compareSync(String(password || ''), DUMMY_HASH);
    return { error: 'Wrong username or password' };
  }
  if (user.locked_until > now) {
    return { error: `Too many attempts. Try again in ${Math.ceil((user.locked_until - now) / 60000)} min` };
  }
  if (!bcrypt.compareSync(String(password || ''), user.pass_hash)) {
    const failed = user.failed_count + 1;
    const locked = failed >= LOCK_AFTER ? now + LOCK_MS : 0;
    db.prepare('UPDATE users SET failed_count=?, locked_until=? WHERE id=?').run(locked ? 0 : failed, locked, user.id);
    audit(user.username, 'login_failed', ip);
    return { error: locked ? 'Too many attempts. Locked for 15 minutes' : 'Wrong username or password' };
  }
  db.prepare('UPDATE users SET failed_count=0, locked_until=0 WHERE id=?').run(user.id);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,last_seen) VALUES(?,?,?,?)').run(sha(token), user.id, now, now);
  audit(user.username, 'login', ip);
  return { token, user };
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, token, basePath) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=${basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_MS / 1000}` +
    (process.env.COOKIE_INSECURE === 'true' ? '' : '; Secure'));
}
function clearCookie(res, basePath) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=${basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=0` +
    (process.env.COOKIE_INSECURE === 'true' ? '' : '; Secure'));
}

function sessionUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  const now = Date.now();
  const row = db.prepare(`SELECT s.token_hash, s.created_at, s.last_seen, u.id, u.username, u.role, u.must_change, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row) return null;
  if (row.disabled || now - row.last_seen > IDLE_MS || now - row.created_at > MAX_AGE_MS) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
    return null;
  }
  if (now - row.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now, row.token_hash);
  return { id: row.id, username: row.username, role: row.role, mustChange: !!row.must_change, tokenHash: row.token_hash };
}

function logout(req) {
  const token = readCookie(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

function changePassword(userId, current, next) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user || !bcrypt.compareSync(String(current || ''), user.pass_hash)) throw new Error('Current password is wrong');
  const err = validatePassword(next);
  if (err) throw new Error(err);
  if (current === next) throw new Error('New password must be different');
  db.prepare('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?').run(bcrypt.hashSync(next, 12), userId);
}

function resetPassword(userId, next) {
  const err = validatePassword(next);
  if (err) throw new Error(err);
  db.prepare('UPDATE users SET pass_hash=?, must_change=1, failed_count=0, locked_until=0 WHERE id=?').run(bcrypt.hashSync(next, 12), userId);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

// Periodic cleanup of expired sessions
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?').run(Date.now() - IDLE_MS, Date.now() - MAX_AGE_MS);
}, 3600 * 1000).unref();

module.exports = { seedAdmin, login, logout, sessionUser, setCookie, clearCookie, changePassword, resetPassword, createUser, validatePassword };
