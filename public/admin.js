const loginView = document.getElementById('admin-login-view');
const dashboardView = document.getElementById('admin-dashboard-view');
const loginForm = document.getElementById('admin-login-form');
const secretInput = document.getElementById('admin-secret-input');
const toggleSecretBtn = document.getElementById('toggle-admin-secret-btn');
const loginError = document.getElementById('admin-login-error');

if (toggleSecretBtn) {
  toggleSecretBtn.addEventListener('click', () => {
    const isPwd = secretInput.type === 'password';
    secretInput.type = isPwd ? 'text' : 'password';
    toggleSecretBtn.title = isPwd ? 'Hide password' : 'Show password';
    toggleSecretBtn.setAttribute('aria-label', isPwd ? 'Hide password' : 'Show password');
    toggleSecretBtn.innerHTML = isPwd
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  });
}
const logoutBtn = document.getElementById('admin-logout-btn');

const statTotal = document.getElementById('stat-total');
const statActive = document.getElementById('stat-active');
const statOnline = document.getElementById('stat-online');

const addUserForm = document.getElementById('add-user-form');
const addUserError = document.getElementById('add-user-error');
const newDisplayName = document.getElementById('new-display-name');
const newUserId = document.getElementById('new-user-id');
const newPin = document.getElementById('new-pin');

const credentialsBox = document.getElementById('credentials-box');
const credHeading = document.getElementById('cred-heading');
const credUserId = document.getElementById('cred-userid');
const credPin = document.getElementById('cred-pin');
const copyCredBtn = document.getElementById('copy-cred-btn');

const usersTbody = document.getElementById('users-tbody');
const addChannelForm = document.getElementById('add-channel-form');
const channelError = document.getElementById('channel-error');
const newChannelName = document.getElementById('new-channel-name');
const newChannelDesc = document.getElementById('new-channel-desc');
const channelsSummary = document.getElementById('channels-summary');

let lastCredentials = null;

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
  loginError.classList.add('hidden');
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ secret: secretInput.value.trim() }),
    });
    secretInput.value = '';
    await loadDashboard();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove('hidden');
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  dashboardView.classList.add('hidden');
  loginView.classList.remove('hidden');
});

async function loadDashboard() {
  const [{ users }, { channels }] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/channels'),
  ]);

  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');

  statTotal.textContent = users.length;
  statActive.textContent = users.filter((u) => u.isActive).length;
  statOnline.textContent = users.filter((u) => u.online).length;

  renderUsersTable(users);
  channelsSummary.textContent = `Active channels: ${channels.map((c) => `#${c.name}`).join(', ')}`;
}

function showCredentials(heading, credentials) {
  lastCredentials = credentials;
  credHeading.textContent = heading;
  credUserId.textContent = credentials.userId;
  credPin.textContent = credentials.pin;
  credentialsBox.classList.remove('hidden');
}

copyCredBtn.addEventListener('click', async () => {
  if (!lastCredentials) return;
  const text = `SendIt Login\nUser ID: ${lastCredentials.userId}\nPIN: ${lastCredentials.pin}`;
  await navigator.clipboard.writeText(text).catch(() => {});
  copyCredBtn.textContent = 'Copied!';
  setTimeout(() => {
    copyCredBtn.textContent = 'Copy Credentials';
  }, 1500);
});

addUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addUserError.classList.add('hidden');
  try {
    const data = await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        displayName: newDisplayName.value.trim(),
        userId: newUserId.value.trim() || undefined,
        pin: newPin.value.trim() || undefined,
      }),
    });
    newDisplayName.value = '';
    newUserId.value = '';
    newPin.value = '';
    showCredentials(`Created ${data.user.displayName} — copy and share these credentials:`, data.credentials);
    await loadDashboard();
  } catch (err) {
    addUserError.textContent = err.message;
    addUserError.classList.remove('hidden');
  }
});

function renderUsersTable(users) {
  usersTbody.innerHTML = '';
  if (users.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" style="color: var(--text-muted); text-align: center;">No users added yet.</td>';
    usersTbody.appendChild(tr);
    return;
  }

  for (const u of users) {
    const tr = document.createElement('tr');
    const lastSeen = u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : 'Never';

    tr.innerHTML = `
      <td class="mono">${escapeHtml(u.userId)}</td>
      <td>${escapeHtml(u.displayName)}</td>
      <td>
        <span class="badge ${u.isActive ? 'badge-active' : 'badge-disabled'}">
          ${u.isActive ? 'Active' : 'Disabled'}
        </span>
      </td>
      <td>
        <span style="display: inline-flex; align-items: center; gap: 6px;">
          <span class="status-dot ${u.online ? 'online' : ''}"></span>
          ${u.online ? 'Online' : 'Offline'}
        </span>
      </td>
      <td style="color: var(--text-muted); font-size: 13px;">${escapeHtml(lastSeen)}</td>
      <td class="actions-cell"></td>
    `;

    const actionsTd = tr.querySelector('.actions-cell');

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-secondary btn-sm';
    resetBtn.textContent = 'Reset PIN';
    resetBtn.addEventListener('click', async () => {
      const data = await api(`/api/admin/users/${encodeURIComponent(u.userId)}/reset-pin`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      showCredentials(`New PIN generated for ${u.displayName} (old sessions signed out):`, data.credentials);
      await loadDashboard();
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = u.isActive ? 'Disable' : 'Enable';
    toggleBtn.addEventListener('click', async () => {
      await api(`/api/admin/users/${encodeURIComponent(u.userId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      await loadDashboard();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete user ${u.displayName} (${u.userId})? This removes their messages and sessions.`)) {
        return;
      }
      await api(`/api/admin/users/${encodeURIComponent(u.userId)}`, { method: 'DELETE' });
      await loadDashboard();
    });

    actionsTd.append(resetBtn, toggleBtn, deleteBtn);
    usersTbody.appendChild(tr);
  }
}

addChannelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  channelError.classList.add('hidden');
  try {
    await api('/api/admin/channels', {
      method: 'POST',
      body: JSON.stringify({
        name: newChannelName.value.trim(),
        description: newChannelDesc.value.trim(),
      }),
    });
    newChannelName.value = '';
    newChannelDesc.value = '';
    await loadDashboard();
  } catch (err) {
    channelError.textContent = err.message;
    channelError.classList.remove('hidden');
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

applyTheme(localStorage.getItem('sendit_theme') || 'light');
document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
});

// Check existing admin session on load
(async () => {
  try {
    await loadDashboard();
  } catch {
    loginView.classList.remove('hidden');
  }
})();
