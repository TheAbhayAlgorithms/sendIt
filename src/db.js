import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createJsonDatabase } from './json-db.js';

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
 * Opens and initializes the SQLite database (with pure-JS JSON fallback if node:sqlite is unavailable).
 * @param {string} dbPath
 */
export function createDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) {
    return createJsonDatabase(dbPath);
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

  return db;
}
