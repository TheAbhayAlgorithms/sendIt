import fs from 'node:fs';
import path from 'node:path';

/**
 * Pure-JS JSON-file-backed fallback implementing the subset of node:sqlite's
 * DatabaseSync API used by SendIt, for runtimes where node:sqlite is unavailable.
 */
export function createJsonDatabase(dbPath) {
  const jsonPath = dbPath === ':memory:' ? null : `${dbPath}.json`;

  let state = {
    users: [],
    sessions: [],
    channels: [
      {
        id: 'general',
        name: 'general',
        description: 'Workspace-wide announcements and chat',
        created_at: new Date().toISOString(),
      },
    ],
    messages: [],
    nextMessageId: 1,
  };

  if (jsonPath && fs.existsSync(jsonPath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      state = { ...state, ...loaded };
    } catch {
      // Keep default state if file is unreadable
    }
  }

  function persist() {
    if (!jsonPath) return;
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(state));
  }

  const eqNoCase = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  return {
    exec() {},
    close() {},
    prepare(rawSql) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();

      return {
        get(...args) {
          if (sql.startsWith('SELECT 1 FROM users WHERE user_id = ?')) {
            return state.users.some((u) => eqNoCase(u.user_id, args[0])) ? { 1: 1 } : undefined;
          }
          if (sql.startsWith('SELECT token_hash, user_id, role, expires_at FROM sessions WHERE token_hash = ?')) {
            return state.sessions.find((s) => s.token_hash === args[0]);
          }
          if (sql.startsWith('SELECT user_id, display_name, is_active FROM users WHERE user_id = ?')) {
            return state.users.find((u) => eqNoCase(u.user_id, args[0]));
          }
          if (sql.startsWith('SELECT user_id, display_name, pin_hash, pin_salt, is_active FROM users WHERE user_id = ?')) {
            return state.users.find((u) => eqNoCase(u.user_id, args[0]));
          }
          if (sql.startsWith('SELECT user_id, is_active FROM users WHERE user_id = ?')) {
            return state.users.find((u) => eqNoCase(u.user_id, args[0]));
          }
          if (sql.startsWith('SELECT user_id FROM users WHERE user_id = ?')) {
            return state.users.find((u) => eqNoCase(u.user_id, args[0]));
          }
          if (sql.startsWith('SELECT 1 FROM channels WHERE id = ?')) {
            return state.channels.some((c) => eqNoCase(c.id, args[0])) ? { 1: 1 } : undefined;
          }
          if (sql.startsWith('SELECT id FROM channels WHERE id = ?')) {
            return state.channels.find((c) => eqNoCase(c.id, args[0]));
          }
          return undefined;
        },

        all(...args) {
          if (sql.startsWith('SELECT user_id, display_name, is_active, created_at, last_seen_at FROM users')) {
            return [...state.users].sort((a, b) => b.created_at.localeCompare(a.created_at));
          }
          if (sql.startsWith('SELECT user_id, display_name, last_seen_at FROM users WHERE is_active = 1')) {
            return state.users
              .filter((u) => u.is_active)
              .sort((a, b) => a.display_name.localeCompare(b.display_name));
          }
          if (sql.startsWith('SELECT id, name, description, created_at FROM channels') ||
              sql.startsWith('SELECT id, name, description FROM channels')) {
            return [...state.channels].sort((a, b) => a.created_at.localeCompare(b.created_at));
          }
          if (sql.includes('FROM messages m') && sql.includes('WHERE m.channel_id = ?')) {
            const [channelId, limit] = args;
            return state.messages
              .filter((m) => m.channel_id && eqNoCase(m.channel_id, channelId))
              .sort((a, b) => b.id - a.id)
              .slice(0, limit)
              .map((m) => {
                const sender = state.users.find((u) => eqNoCase(u.user_id, m.sender_id));
                return { ...m, sender_name: sender ? sender.display_name : m.sender_id };
              });
          }
          if (sql.includes('FROM messages m') && sql.includes('WHERE m.channel_id IS NULL')) {
            const [u1, u2, , , limit] = args;
            return state.messages
              .filter(
                (m) =>
                  !m.channel_id &&
                  ((eqNoCase(m.sender_id, u1) && eqNoCase(m.recipient_id, u2)) ||
                    (eqNoCase(m.sender_id, u2) && eqNoCase(m.recipient_id, u1)))
              )
              .sort((a, b) => b.id - a.id)
              .slice(0, limit)
              .map((m) => {
                const sender = state.users.find((u) => eqNoCase(u.user_id, m.sender_id));
                return { ...m, sender_name: sender ? sender.display_name : m.sender_id };
              });
          }
          return [];
        },

        run(...args) {
          if (sql.startsWith('INSERT INTO sessions')) {
            const [token_hash, user_id, role, created_at, expires_at] = args;
            state.sessions.push({ token_hash, user_id, role, created_at, expires_at });
            persist();
            return { changes: 1 };
          }
          if (sql.startsWith('DELETE FROM sessions WHERE token_hash = ?')) {
            state.sessions = state.sessions.filter((s) => s.token_hash !== args[0]);
            persist();
            return { changes: 1 };
          }
          if (sql.startsWith('DELETE FROM sessions WHERE user_id = ?')) {
            state.sessions = state.sessions.filter((s) => !s.user_id || !eqNoCase(s.user_id, args[0]));
            persist();
            return { changes: 1 };
          }
          if (sql.startsWith('INSERT INTO users')) {
            const [user_id, display_name, pin_hash, pin_salt, created_at] = args;
            state.users.push({
              user_id,
              display_name,
              pin_hash,
              pin_salt,
              is_active: 1,
              created_at,
              last_seen_at: null,
            });
            persist();
            return { changes: 1 };
          }
          if (sql.startsWith('UPDATE users SET last_seen_at = ? WHERE user_id = ?')) {
            const user = state.users.find((u) => eqNoCase(u.user_id, args[1]));
            if (user) user.last_seen_at = args[0];
            persist();
            return { changes: user ? 1 : 0 };
          }
          if (sql.startsWith('UPDATE users SET display_name = ?, is_active = ? WHERE user_id = ?')) {
            const user = state.users.find((u) => eqNoCase(u.user_id, args[2]));
            if (user) {
              user.display_name = args[0];
              user.is_active = args[1];
            }
            persist();
            return { changes: user ? 1 : 0 };
          }
          if (sql.startsWith('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE user_id = ?')) {
            const user = state.users.find((u) => eqNoCase(u.user_id, args[2]));
            if (user) {
              user.pin_hash = args[0];
              user.pin_salt = args[1];
            }
            persist();
            return { changes: user ? 1 : 0 };
          }
          if (sql.startsWith('DELETE FROM users WHERE user_id = ?')) {
            state.users = state.users.filter((u) => !eqNoCase(u.user_id, args[0]));
            state.sessions = state.sessions.filter((s) => !s.user_id || !eqNoCase(s.user_id, args[0]));
            state.messages = state.messages.filter(
              (m) => !eqNoCase(m.sender_id, args[0]) && (!m.recipient_id || !eqNoCase(m.recipient_id, args[0]))
            );
            persist();
            return { changes: 1 };
          }
          if (sql.startsWith('INSERT INTO channels')) {
            const [id, name, description, created_at] = args;
            state.channels.push({ id, name, description, created_at });
            persist();
            return { changes: 1 };
          }
          if (sql.startsWith('INSERT INTO messages (sender_id, channel_id, recipient_id, content, created_at) VALUES (?, ?, NULL, ?, ?)')) {
            const [sender_id, channel_id, content, created_at] = args;
            const id = state.nextMessageId++;
            state.messages.push({ id, sender_id, channel_id, recipient_id: null, content, created_at });
            persist();
            return { lastInsertRowid: id };
          }
          if (sql.startsWith('INSERT INTO messages (sender_id, channel_id, recipient_id, content, created_at) VALUES (?, NULL, ?, ?, ?)')) {
            const [sender_id, recipient_id, content, created_at] = args;
            const id = state.nextMessageId++;
            state.messages.push({ id, sender_id, channel_id: null, recipient_id, content, created_at });
            persist();
            return { lastInsertRowid: id };
          }
          return { changes: 0 };
        },
      };
    },
  };
}
