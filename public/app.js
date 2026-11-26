const loginView = document.getElementById('login-view');
const chatView = document.getElementById('chat-view');
const loginForm = document.getElementById('login-form');
const loginUserId = document.getElementById('login-userid');
const loginPin = document.getElementById('login-pin');
const togglePinBtn = document.getElementById('toggle-pin-btn');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');

const sidebar = document.getElementById('sidebar');
const openSidebarBtn = document.getElementById('open-sidebar-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');
const usersList = document.getElementById('users-list');
const meNameEl = document.getElementById('me-name');
const meIdEl = document.getElementById('me-id');
const logoutBtn = document.getElementById('logout-btn');

const chatTitle = document.getElementById('chat-title');
const chatSubtitle = document.getElementById('chat-subtitle');
const messagesContainer = document.getElementById('messages-container');
const typingBar = document.getElementById('typing-bar');
const composerForm = document.getElementById('composer-form');
const messageInput = document.getElementById('message-input');

const state = {
  user: null,
  users: [],
  activePeerId: null,
  unread: new Map(), // userId -> count
  typingUsers: new Map(), // userId -> { displayName, timeoutId }
  ws: null,
  reconnectTimer: null,
  wsFailures: 0,
  pollTimer: null,
};

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function clearError() {
  loginError.classList.add('hidden');
  loginError.textContent = '';
}

togglePinBtn.addEventListener('click', () => {
  const isPwd = loginPin.type === 'password';
  loginPin.type = isPwd ? 'text' : 'password';
  togglePinBtn.textContent = isPwd ? 'Hide' : 'Show';
});

openSidebarBtn.addEventListener('click', () => sidebar.classList.add('open'));
closeSidebarBtn.addEventListener('click', () => sidebar.classList.remove('open'));

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  loginSubmit.disabled = true;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        userId: loginUserId.value.trim(),
        pin: loginPin.value.trim(),
      }),
    });
    loginPin.value = '';
    await enterChat();
  } catch (err) {
    showError(err.message);
  } finally {
    loginSubmit.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  teardownChat('Signed out.');
});

function teardownChat(notice) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.wsFailures = 0;
  state.user = null;
  chatView.classList.add('hidden');
  loginView.classList.remove('hidden');
  if (notice && notice !== 'Signed out.') {
    showError(notice);
  } else {
    clearError();
  }
}

async function enterChat() {
  const data = await api('/api/chat/bootstrap');
  state.user = data.user;
  state.users = data.users;
  state.unread.clear();

  meNameEl.textContent = state.user.displayName;
  meIdEl.textContent = state.user.userId;

  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');

  const peers = state.users.filter((u) => u.userId !== state.user.userId);
  if (!state.activePeerId || !peers.some((p) => p.userId === state.activePeerId)) {
    state.activePeerId = peers.length > 0 ? peers[0].userId : null;
  }

  renderSidebar();
  await loadMessages();
  connectWebSocket();
}

function renderSidebar() {
  usersList.innerHTML = '';
  const peers = state.users.filter((u) => u.userId !== state.user.userId);
  if (peers.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '8px 10px';
    empty.style.fontSize = '12px';
    empty.style.color = 'var(--text-muted)';
    empty.textContent = 'No other users added yet';
    usersList.appendChild(empty);
    return;
  }

  for (const u of peers) {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    if (state.activePeerId === u.userId) {
      btn.classList.add('active');
    }

    const left = document.createElement('span');
    left.className = 'nav-item-left';
    left.innerHTML = `
      <span class="status-dot ${u.online ? 'online' : ''}"></span>
      <span class="nav-item-label">${escapeHtml(u.displayName)}</span>
    `;
    btn.appendChild(left);

    const unread = state.unread.get(u.userId) || 0;
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = unread;
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => selectPeer(u.userId));
    usersList.appendChild(btn);
  }
}

async function selectPeer(userId) {
  state.activePeerId = userId;
  state.unread.delete(userId);
  state.typingUsers.clear();
  renderTypingBar();
  sidebar.classList.remove('open');
  renderSidebar();
  await loadMessages();
  messageInput.focus();
}

function updateHeader() {
  if (!state.activePeerId) {
    chatTitle.textContent = 'No chats yet';
    chatSubtitle.textContent = 'Wait for another user to be added';
    messageInput.placeholder = 'Select a user to message...';
    messageInput.disabled = true;
    return;
  }
  messageInput.disabled = false;
  const peer = state.users.find((u) => u.userId === state.activePeerId);
  chatTitle.textContent = peer ? peer.displayName : state.activePeerId;
  chatSubtitle.textContent = peer
    ? `${peer.userId} • ${peer.online ? 'Online' : 'Offline'}`
    : 'Direct Message';
  messageInput.placeholder = `Message ${peer ? peer.displayName : state.activePeerId}`;
}

async function loadMessages() {
  updateHeader();
  if (!state.activePeerId) {
    messagesContainer.innerHTML = '<div class="empty-state">No other users available to chat with yet.</div>';
    return;
  }

  const { messages } = await api(`/api/chat/messages?dmWith=${encodeURIComponent(state.activePeerId)}&limit=80`);
  messagesContainer.innerHTML = '';
  if (messages.length === 0) {
    messagesContainer.innerHTML = '<div class="empty-state">No messages here yet. Say hello!</div>';
    return;
  }
  for (const msg of messages) {
    appendMessageElement(msg);
  }
  scrollToBottom();
}

function appendMessageElement(msg) {
  const empty = messagesContainer.querySelector('.empty-state');
  if (empty) empty.remove();

  const isOwn = msg.senderId === state.user.userId;
  const row = document.createElement('div');
  row.className = `msg-row ${isOwn ? 'own' : ''}`;

  const initials = (msg.senderName || msg.senderId || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const timeStr = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  row.innerHTML = `
    <div class="msg-avatar">${escapeHtml(initials)}</div>
    <div class="msg-bubble-wrap">
      <div class="msg-meta">
        <span class="msg-sender">${escapeHtml(isOwn ? 'You' : msg.senderName)}</span>
        <span class="msg-time">${escapeHtml(timeStr)}</span>
      </div>
      <div class="msg-bubble">${escapeHtml(msg.content)}</div>
    </div>
  `;

  messagesContainer.appendChild(row);
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function connectWebSocket() {
  if (location.hostname.endsWith('.vercel.app')) {
    startHttpPollingFallback();
    return;
  }

  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsFailures = 0;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === 'force_logout') {
      teardownChat(data.reason || 'Your session was ended by an administrator.');
      return;
    }

    if (data.type === 'presence') {
      const target = state.users.find((u) => u.userId === data.userId);
      if (target) {
        target.online = data.online;
        renderSidebar();
        updateHeader();
      }
      return;
    }

    if (data.type === 'users_updated') {
      const fresh = await api('/api/chat/bootstrap').catch(() => null);
      if (fresh) {
        state.users = fresh.users;
        const peers = state.users.filter((u) => u.userId !== state.user.userId);
        if (!state.activePeerId && peers.length > 0) {
          state.activePeerId = peers[0].userId;
          await loadMessages();
        }
        renderSidebar();
        updateHeader();
      }
      return;
    }

    if (data.type === 'typing') {
      if (data.userId === state.user.userId || data.userId !== state.activePeerId) return;

      const existing = state.typingUsers.get(data.userId);
      if (existing) clearTimeout(existing.timeoutId);

      if (data.isTyping) {
        const timeoutId = setTimeout(() => {
          state.typingUsers.delete(data.userId);
          renderTypingBar();
        }, 3000);
        state.typingUsers.set(data.userId, { displayName: data.displayName, timeoutId });
      } else {
        state.typingUsers.delete(data.userId);
      }
      renderTypingBar();
      return;
    }

    if (data.type === 'message') {
      const msg = data.message;
      const belongsToCurrent =
        state.activePeerId &&
        (msg.senderId === state.activePeerId || msg.recipientId === state.activePeerId);

      if (belongsToCurrent) {
        appendMessageElement(msg);
        scrollToBottom();
        state.typingUsers.delete(msg.senderId);
        renderTypingBar();
      } else if (msg.senderId !== state.user.userId) {
        state.unread.set(msg.senderId, (state.unread.get(msg.senderId) || 0) + 1);
        renderSidebar();
      }
    }
  };

  ws.onclose = (evt) => {
    if (!state.user || evt.code === 4001) return;
    state.wsFailures += 1;
    if (state.wsFailures >= 3) {
      startHttpPollingFallback();
      return;
    }
    state.reconnectTimer = setTimeout(connectWebSocket, 2500);
  };
}

function startHttpPollingFallback() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (!state.user) return;
    try {
      await loadMessages();
    } catch (err) {
      if (err.message.includes('401') || err.message.includes('Authentication')) {
        teardownChat('Session expired. Please sign in again.');
      }
    }
  }, 3000);
}

function renderTypingBar() {
  const names = [...state.typingUsers.values()].map((v) => v.displayName);
  if (names.length === 0) {
    typingBar.textContent = '';
  } else if (names.length === 1) {
    typingBar.textContent = `${names[0]} is typing...`;
  } else {
    typingBar.textContent = `${names.join(', ')} are typing...`;
  }
}

let typingStopTimer = null;
messageInput.addEventListener('input', () => {
  if (!state.activePeerId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  const payload = { type: 'typing', recipientId: state.activePeerId, isTyping: true };
  state.ws.send(JSON.stringify(payload));

  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ ...payload, isTyping: false }));
  }, 1500);
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composerForm.requestSubmit();
  }
});

composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content || !state.activePeerId) return;

  const payload = { recipientId: state.activePeerId, content };

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'send_message', ...payload }));
    messageInput.value = '';
    clearTimeout(typingStopTimer);
  } else {
    try {
      const { message } = await api('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      messageInput.value = '';
      appendMessageElement(message);
      scrollToBottom();
    } catch (err) {
      showError(err.message);
    }
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-14.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2m-14.07 7.07 1.41-1.41m11.32-11.32 1.41-1.41"/></svg>';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sendit_theme', theme);
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    const icon = btn.querySelector('.theme-icon');
    const label = btn.querySelector('.theme-label');
    if (theme === 'dark') {
      if (icon) icon.innerHTML = SUN_SVG;
      if (label) label.textContent = 'Light';
    } else {
      if (icon) icon.innerHTML = MOON_SVG;
      if (label) label.textContent = 'Dark';
    }
  });
}

applyTheme(localStorage.getItem('sendit_theme') || 'dark');
document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
});

// Check existing session on page load
(async () => {
  try {
    await enterChat();
  } catch {
    loginView.classList.remove('hidden');
  }
})();
