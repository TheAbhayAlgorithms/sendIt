import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createDatabase } from './db.js';
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  generatePin,
  generateUserId,
  getSession,
  hashPin,
  parseCookies,
  resolveAdminSecret,
  verifyAdminSecret,
  verifyPin,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const USER_COOKIE = 'sendit_session';
const ADMIN_COOKIE = 'sendit_admin';

function setAuthCookie(res, name, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearAuthCookie(res, name) {
  res.setHeader(
    'Set-Cookie',
    `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

/**
 * Creates the Express app, HTTP server, WebSocket server, and SQLite database.
 */
export function createApp(options = {}) {
  const db = createDatabase(options.dbPath);
  const adminSecret = options.adminSecret || resolveAdminSecret(options.dataDir);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  // Map<userId, Set<WebSocket>>
  const onlineSockets = new Map();

  function getOnlineUserIds() {
    const ids = [];
    for (const [uid, sockets] of onlineSockets.entries()) {
      if (sockets.size > 0) ids.push(uid);
    }
    return ids;
  }

  function sendToUser(userId, payload) {
    const sockets = onlineSockets.get(userId);
    if (!sockets) return;
    const raw = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }

  function broadcastAll(payload) {
    const raw = JSON.stringify(payload);
    for (const sockets of onlineSockets.values()) {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(raw);
        }
      }
    }
  }

  function kickUser(userId, reason) {
    const sockets = onlineSockets.get(userId);
    if (!sockets) return;
    const raw = JSON.stringify({ type: 'force_logout', reason });
    for (const ws of [...sockets]) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
      ws.close(4001, reason);
    }
  }

  async function requireUser(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const session = await getSession(db, cookies[USER_COOKIE], 'user');
    if (!session) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = session.user;
    req.sessionToken = cookies[USER_COOKIE];
    next();
  }

  async function requireAdmin(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const session = await getSession(db, cookies[ADMIN_COOKIE], 'admin');
    if (!session) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }
    req.adminToken = cookies[ADMIN_COOKIE];
    next();
  }

  // -------------------- User Auth (Login Only — No Registration) --------------------

  app.post('/api/auth/login', async (req, res) => {
    const userIdInput = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    const pinInput = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';

    if (!userIdInput || !pinInput) {
      return res.status(400).json({ error: 'User ID and PIN are required' });
    }

    const user = await db.get(
      'SELECT user_id, display_name, pin_hash, pin_salt, is_active FROM users WHERE user_id = ?',
      [userIdInput]
    );

    if (!user || !verifyPin(pinInput, user.pin_salt, user.pin_hash)) {
      return res.status(401).json({ error: 'Invalid User ID or PIN' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been disabled by the administrator' });
    }

    const now = new Date().toISOString();
    await db.run('UPDATE users SET last_seen_at = ? WHERE user_id = ?', [now, user.user_id]);

    const { rawToken, expiresAt } = await createSession(db, { userId: user.user_id, role: 'user' });
    setAuthCookie(res, USER_COOKIE, rawToken, expiresAt);

    res.json({
      user: {
        userId: user.user_id,
        displayName: user.display_name,
      },
    });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    await deleteSession(db, cookies[USER_COOKIE]);
    clearAuthCookie(res, USER_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireUser, (req, res) => {
    res.json({
      user: {
        userId: req.user.user_id,
        displayName: req.user.display_name,
      },
    });
  });

  // -------------------- Admin Auth --------------------

  app.post('/api/admin/login', async (req, res) => {
    const secret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';
    if (!verifyAdminSecret(secret, adminSecret)) {
      return res.status(401).json({ error: 'Invalid admin key' });
    }
    const { rawToken, expiresAt } = await createSession(db, { role: 'admin' });
    setAuthCookie(res, ADMIN_COOKIE, rawToken, expiresAt);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    await deleteSession(db, cookies[ADMIN_COOKIE]);
    clearAuthCookie(res, ADMIN_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', requireAdmin, (req, res) => {
    res.json({ ok: true });
  });

  // -------------------- Admin User & Channel Management --------------------

  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const rows = await db.all(
      'SELECT user_id, display_name, is_active, created_at, last_seen_at FROM users ORDER BY created_at DESC'
    );

    const users = rows.map((u) => ({
      userId: u.user_id,
      displayName: u.display_name,
      isActive: Boolean(u.is_active),
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      online: (onlineSockets.get(u.user_id)?.size || 0) > 0,
    }));

    res.json({ users });
  });

  app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    const customUserId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    const customPin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';

    if (!displayName || displayName.length > 50) {
      return res.status(400).json({ error: 'Display name is required (max 50 characters)' });
    }

    let userId = customUserId;
    if (userId) {
      if (!/^[a-zA-Z0-9_-]{3,24}$/.test(userId)) {
        return res.status(400).json({
          error: 'User ID must be 3-24 characters (letters, numbers, hyphens, underscores)',
        });
      }
      const exists = await db.get('SELECT 1 FROM users WHERE user_id = ?', [userId]);
      if (exists) {
        return res.status(409).json({ error: `User ID "${userId}" is already taken` });
      }
    } else {
      userId = await generateUserId(db);
    }

    let pin = customPin;
    if (pin) {
      if (pin.length < 4 || pin.length > 32) {
        return res.status(400).json({ error: 'PIN / access code must be 4-32 characters' });
      }
    } else {
      pin = generatePin(6);
    }

    const { salt, hash } = hashPin(pin);
    const createdAt = new Date().toISOString();

    await db.run(
      'INSERT INTO users (user_id, display_name, pin_hash, pin_salt, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [userId, displayName, hash, salt, createdAt]
    );

    broadcastAll({ type: 'users_updated' });

    res.status(201).json({
      user: {
        userId,
        displayName,
        isActive: true,
        createdAt,
        lastSeenAt: null,
        online: false,
      },
      credentials: {
        userId,
        pin,
      },
    });
  });

  app.patch('/api/admin/users/:userId', requireAdmin, async (req, res) => {
    const targetId = req.params.userId;
    const user = await db.get('SELECT user_id, display_name, is_active FROM users WHERE user_id = ?', [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const nextDisplayName =
      typeof req.body?.displayName === 'string' && req.body.displayName.trim()
        ? req.body.displayName.trim().slice(0, 50)
        : user.display_name;

    const nextActive =
      typeof req.body?.isActive === 'boolean' ? (req.body.isActive ? 1 : 0) : user.is_active;

    await db.run('UPDATE users SET display_name = ?, is_active = ? WHERE user_id = ?', [
      nextDisplayName,
      nextActive,
      user.user_id,
    ]);

    if (nextActive === 0) {
      await deleteUserSessions(db, user.user_id);
      kickUser(user.user_id, 'Your account was disabled by the administrator.');
    }

    broadcastAll({ type: 'users_updated' });

    res.json({
      user: {
        userId: user.user_id,
        displayName: nextDisplayName,
        isActive: Boolean(nextActive),
      },
    });
  });

  app.post('/api/admin/users/:userId/reset-pin', requireAdmin, async (req, res) => {
    const targetId = req.params.userId;
    const user = await db.get('SELECT user_id FROM users WHERE user_id = ?', [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const customPin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
    let pin = customPin;
    if (pin) {
      if (pin.length < 4 || pin.length > 32) {
        return res.status(400).json({ error: 'PIN / access code must be 4-32 characters' });
      }
    } else {
      pin = generatePin(6);
    }

    const { salt, hash } = hashPin(pin);
    await db.run('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE user_id = ?', [hash, salt, user.user_id]);

    await deleteUserSessions(db, user.user_id);
    kickUser(user.user_id, 'Your PIN was reset by the administrator. Please sign in with your new PIN.');

    res.json({
      credentials: {
        userId: user.user_id,
        pin,
      },
    });
  });

  app.delete('/api/admin/users/:userId', requireAdmin, async (req, res) => {
    const targetId = req.params.userId;
    const user = await db.get('SELECT user_id FROM users WHERE user_id = ?', [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    kickUser(user.user_id, 'Your account was removed by the administrator.');
    await db.run('DELETE FROM users WHERE user_id = ?', [user.user_id]);
    broadcastAll({ type: 'users_updated' });

    res.json({ ok: true });
  });

  // -------------------- Chat API --------------------

  app.get('/api/chat/bootstrap', requireUser, async (req, res) => {
    const userRows = await db.all(
      'SELECT user_id, display_name, last_seen_at FROM users WHERE is_active = 1 ORDER BY display_name ASC'
    );

    const onlineSet = new Set(getOnlineUserIds());
    const users = userRows.map((u) => ({
      userId: u.user_id,
      displayName: u.display_name,
      lastSeenAt: u.last_seen_at,
      online: onlineSet.has(u.user_id),
    }));

    res.json({
      user: {
        userId: req.user.user_id,
        displayName: req.user.display_name,
      },
      users,
    });
  });

  app.get('/api/chat/messages', requireUser, async (req, res) => {
    const dmWith = typeof req.query.dmWith === 'string' ? req.query.dmWith.trim() : '';
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

    if (!dmWith) {
      return res.status(400).json({ error: 'Provide dmWith' });
    }

    const peer = await db.get('SELECT user_id FROM users WHERE user_id = ?', [dmWith]);
    if (!peer) return res.status(404).json({ error: 'User not found' });

    const rows = await db.all(
      `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.recipient_id, m.content, m.created_at
       FROM messages m
       JOIN users u ON u.user_id = m.sender_id
       WHERE m.channel_id IS NULL
         AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
       ORDER BY m.id DESC
       LIMIT ?`,
      [req.user.user_id, peer.user_id, peer.user_id, req.user.user_id, limit]
    );

    const messages = rows.reverse().map((r) => ({
      id: r.id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      recipientId: r.recipient_id,
      content: r.content,
      createdAt: r.created_at,
    }));

    res.json({ messages });
  });

  app.post('/api/chat/messages', requireUser, async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 2000) {
      return res.status(400).json({ error: 'Message content must be 1-2000 characters' });
    }

    const recipientId = typeof req.body?.recipientId === 'string' ? req.body.recipientId.trim() : '';
    if (!recipientId) {
      return res.status(400).json({ error: 'Provide recipientId' });
    }

    const peer = await db.get('SELECT user_id, is_active FROM users WHERE user_id = ?', [recipientId]);
    if (!peer || !peer.is_active) return res.status(404).json({ error: 'Recipient not found' });

    const createdAt = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO messages (sender_id, channel_id, recipient_id, content, created_at) VALUES (?, NULL, ?, ?, ?)',
      [req.user.user_id, peer.user_id, content, createdAt]
    );

    const message = {
      id: Number(result.lastInsertRowid),
      senderId: req.user.user_id,
      senderName: req.user.display_name,
      recipientId: peer.user_id,
      content,
      createdAt,
    };
    sendToUser(req.user.user_id, { type: 'message', message });
    if (peer.user_id !== req.user.user_id) {
      sendToUser(peer.user_id, { type: 'message', message });
    }
    return res.status(201).json({ message });
  });

  // Explicit route for /admin without .html
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  // -------------------- HTTP + WebSocket Server --------------------

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const cookies = parseCookies(request.headers.cookie);
    const session = await getSession(db, cookies[USER_COOKIE], 'user');
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, session.user);
    });
  });

  wss.on('connection', (ws, user) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const userId = user.user_id;
    if (!onlineSockets.has(userId)) {
      onlineSockets.set(userId, new Set());
    }
    const userSet = onlineSockets.get(userId);
    const wasOffline = userSet.size === 0;
    userSet.add(ws);

    db.run('UPDATE users SET last_seen_at = ? WHERE user_id = ?', [new Date().toISOString(), userId]).catch(() => {});
    if (wasOffline) {
      broadcastAll({ type: 'presence', userId, online: true });
    }

    ws.on('message', async (rawData) => {
      let data;
      try {
        data = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      // Re-verify user is still active on every message
      const freshUser = await db.get('SELECT user_id, display_name, is_active FROM users WHERE user_id = ?', [userId]);
      if (!freshUser || !freshUser.is_active) {
        kickUser(userId, 'Account is no longer active.');
        return;
      }

      if (data.type === 'send_message') {
        const content = typeof data.content === 'string' ? data.content.trim() : '';
        if (!content || content.length > 2000) return;

        const recipientId = typeof data.recipientId === 'string' ? data.recipientId.trim() : '';
        if (!recipientId) return;

        const peer = await db.get('SELECT user_id, is_active FROM users WHERE user_id = ?', [recipientId]);
        if (!peer || !peer.is_active) return;

        const createdAt = new Date().toISOString();
        const result = await db.run(
          'INSERT INTO messages (sender_id, channel_id, recipient_id, content, created_at) VALUES (?, NULL, ?, ?, ?)',
          [userId, peer.user_id, content, createdAt]
        );

        const message = {
          id: Number(result.lastInsertRowid),
          senderId: userId,
          senderName: freshUser.display_name,
          recipientId: peer.user_id,
          content,
          createdAt,
        };

        sendToUser(userId, { type: 'message', message });
        if (peer.user_id !== userId) {
          sendToUser(peer.user_id, { type: 'message', message });
        }
      } else if (data.type === 'typing') {
        const isTyping = Boolean(data.isTyping);
        const recipientId = typeof data.recipientId === 'string' ? data.recipientId.trim() : '';

        if (recipientId) {
          sendToUser(recipientId, {
            type: 'typing',
            userId,
            displayName: freshUser.display_name,
            recipientId,
            isTyping,
          });
        }
      }
    });

    ws.on('close', () => {
      const set = onlineSockets.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          onlineSockets.delete(userId);
          db.run('UPDATE users SET last_seen_at = ? WHERE user_id = ?', [new Date().toISOString(), userId]).catch(() => {});
          broadcastAll({ type: 'presence', userId, online: false });
        }
      }
    });
  });

  // Keep WebSocket connections alive across reverse proxies (Render, Railway, Nginx, Cloudflare)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));

  return { app, server, wss, db, adminSecret };
}
