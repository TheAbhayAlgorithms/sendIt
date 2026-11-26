import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
import { createJsonDatabase } from './json-db.js';

const { Pool } = pg;
const require = createRequire(import.meta.url);

function loadSqlite() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    return null;
  }
}

const DEFAULT_DB_PATH = process.env.VERCEL
  ? path.join('/tmp', 'sendit-data', 'sendit.db')
  : path.join(process.cwd(), 'data', 'sendit.db');

/**
 * Converts `?` placeholders to `$1, $2, ...` and case-insensitive ID comparisons for Postgres.
 */
function toPostgresSql(rawSql) {
  let idx = 0;
  let sql = rawSql.replace(/\?/g, () => `$${++idx}`);
  sql = sql
    .replace(/\b(m\.sender_id|m\.recipient_id|u\.user_id|user_id)\s*=\s*(\$\d+)/g, 'LOWER($1) = LOWER($2)')
    .replace(/\b(m\.channel_id|channels\.id|(?<!\.)id)\s*=\s*(\$\d+)/g, 'LOWER($1) = LOWER($2)');
  return sql;
}

function createPostgresAdapter(connectionString) {
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const pool = new Pool({
    connectionString,
    max: 5,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            pin_salt TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            last_seen_at TEXT
          );

          CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(user_id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
            recipient_id TEXT REFERENCES users(user_id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
          CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(sender_id, recipient_id, id);
          CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        `);

        const existing = await pool.query('SELECT id FROM channels WHERE LOWER(id) = LOWER($1)', ['general']);
        if (existing.rowCount === 0) {
          await pool.query(
            'INSERT INTO channels (id, name, description, created_at) VALUES ($1, $2, $3, $4)',
            ['general', 'general', 'Workspace-wide announcements and chat', new Date().toISOString()]
          );
        }
      })();
    }
    return readyPromise;
  }

  return {
    kind: 'postgres',
    ensureReady,
    async get(sql, params = []) {
      await ensureReady();
      const res = await pool.query(toPostgresSql(sql), params);
      return res.rows[0];
    },
    async all(sql, params = []) {
      await ensureReady();
      const res = await pool.query(toPostgresSql(sql), params);
      return res.rows;
    },
    async run(sql, params = []) {
      await ensureReady();
      let pgSql = toPostgresSql(sql);
      if (/^\s*INSERT\s+INTO\s+messages\b/i.test(pgSql) && !/\bRETURNING\b/i.test(pgSql)) {
        pgSql += ' RETURNING id';
      }
      const res = await pool.query(pgSql, params);
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: res.rows[0]?.id,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function wrapSyncDatabase(syncDb, kind) {
  return {
    kind,
    async ensureReady() {},
    async get(sql, params = []) {
      return syncDb.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return syncDb.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      return syncDb.prepare(sql).run(...params);
    },
    async close() {
      syncDb.close();
    },
  };
}

/**
 * Opens and initializes the database:
 * - Uses PostgreSQL (Supabase) when `connectionString` or `process.env.DATABASE_URL` is set (and `dbPath` is not explicitly `:memory:`).
 * - Otherwise uses `node:sqlite` (with JSON-file fallback if `node:sqlite` is unavailable).
 */
export function createDatabase(dbPath = DEFAULT_DB_PATH, options = {}) {
  const connectionString =
    options.connectionString ?? (dbPath === ':memory:' ? null : process.env.DATABASE_URL);

  if (connectionString && connectionString.trim().length > 0) {
    return createPostgresAdapter(connectionString.trim());
  }

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) {
    return wrapSyncDatabase(createJsonDatabase(dbPath), 'json');
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      channel_id TEXT,
      recipient_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (sender_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(user_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(sender_id, recipient_id, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  const existingGeneral = db.prepare('SELECT id FROM channels WHERE id = ?').get('general');
  if (!existingGeneral) {
    db.prepare(
      'INSERT INTO channels (id, name, description, created_at) VALUES (?, ?, ?, ?)'
    ).run('general', 'general', 'Workspace-wide announcements and chat', new Date().toISOString());
  }

  return wrapSyncDatabase(db, 'sqlite');
}
