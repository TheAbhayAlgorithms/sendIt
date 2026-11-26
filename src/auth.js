import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * Hashes a user PIN with a random salt using scrypt.
 * @param {string} pin
 * @param {string} [existingSalt]
 */
export function hashPin(pin, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { salt, hash };
}

/**
 * Verifies a plaintext PIN against a stored salt and scrypt hash.
 */
export function verifyPin(pin, salt, expectedHash) {
  const { hash } = hashPin(pin, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates a readable unique User ID like USR-4829.
 */
export function generateUserId(db) {
  const checkStmt = db.prepare('SELECT 1 FROM users WHERE user_id = ?');
  for (let i = 0; i < 20; i++) {
    const num = crypto.randomInt(1000, 9999);
    const candidate = `USR-${num}`;
    if (!checkStmt.get(candidate)) return candidate;
  }
  return `USR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Generates a 6-digit numeric PIN.
 */
export function generatePin(length = 6) {
  let pin = '';
  for (let i = 0; i < length; i++) {
    pin += crypto.randomInt(0, 10).toString();
  }
  return pin;
}

/**
 * Hashes a raw session token for storage in SQLite.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Creates a new session in SQLite and returns the raw token.
 */
export function createSession(db, { userId = null, role }) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tokenHash, userId, role, now.toISOString(), expiresAt.toISOString());

  return { rawToken, expiresAt };
}

/**
 * Validates a raw session token against SQLite.
 */
export function getSession(db, rawToken, expectedRole) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashToken(rawToken);
  const session = db
    .prepare('SELECT token_hash, user_id, role, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash);

  if (!session || session.role !== expectedRole) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  if (expectedRole === 'user') {
    const user = db
      .prepare('SELECT user_id, display_name, is_active FROM users WHERE user_id = ?')
      .get(session.user_id);
    if (!user || !user.is_active) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return { ...session, user };
  }

  return session;
}

/**
 * Deletes a single session by raw token.
 */
export function deleteSession(db, rawToken) {
  if (!rawToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
}

/**
 * Deletes all sessions belonging to a specific user.
 */
export function deleteUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * Parses cookies from a Cookie header string.
 */
export function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

const DEFAULT_DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'sendit-data')
  : path.join(process.cwd(), 'data');

/**
 * Resolves the admin secret from env or persisted data/admin.secret file.
 */
export function resolveAdminSecret(dataDir = DEFAULT_DATA_DIR) {
  const envSecret =
    process.env.ADMIN_SECRET ||
    process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_KEY;
  if (envSecret && envSecret.trim().length > 0) {
    return envSecret.trim();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, 'admin.secret');
  if (fs.existsSync(secretFile)) {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  }
  const generated = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(secretFile, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/**
 * Constant-time comparison for admin secret.
 */
export function verifyAdminSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
