import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/createApp.js';

function extractCookie(res, name) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const header of setCookies) {
    if (header.startsWith(`${name}=`)) {
      return header.split(';')[0];
    }
  }
  return '';
}

describe('SendIt invite-only chat application', () => {
  let server;
  let db;
  let baseUrl;
  let wsBaseUrl;
  const adminSecret = 'test-admin-secret-123';

  before(async () => {
    const instance = createApp({ dbPath: ':memory:', adminSecret });
    server = instance.server;
    db = instance.db;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('has no self-registration endpoint and rejects unknown users', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'hacker', pin: '1234' }),
    });
    assert.equal(regRes.status, 404);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'USR-9999', pin: '123456' }),
    });
    assert.equal(loginRes.status, 401);
  });

  it('allows admin to create users with unique User IDs & PINs, and users to login & chat in real time', async () => {
    // 1. Admin login fails with wrong secret, succeeds with correct secret
    const badAdmin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong' }),
    });
    assert.equal(badAdmin.status, 401);

    const adminRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: adminSecret }),
    });
    assert.equal(adminRes.status, 200);
    const adminCookie = extractCookie(adminRes, 'sendit_admin');
    assert.ok(adminCookie);

    // 2. Admin creates Alice (auto User ID & PIN) and Bob (custom User ID & PIN)
    const aliceCreate = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ displayName: 'Alice' }),
    });
    assert.equal(aliceCreate.status, 201);
    const aliceData = await aliceCreate.json();
    assert.match(aliceData.credentials.userId, /^USR-\d{4}$/);
    assert.match(aliceData.credentials.pin, /^\d{6}$/);

    const bobCreate = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ displayName: 'Bob', userId: 'bob01', pin: '998877' }),
    });
    assert.equal(bobCreate.status, 201);

    // 3. Alice fails with wrong PIN, succeeds with issued User ID + PIN
    const badPin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: aliceData.credentials.userId, pin: '000000' }),
    });
    assert.equal(badPin.status, 401);

    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aliceData.credentials),
    });
    assert.equal(aliceLogin.status, 200);
    const aliceCookie = extractCookie(aliceLogin, 'sendit_session');

    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'bob01', pin: '998877' }),
    });
    assert.equal(bobLogin.status, 200);
    const bobCookie = extractCookie(bobLogin, 'sendit_session');

    // 4. Connect both over WebSocket and exchange a channel message + DM
    const wsAlice = new WebSocket(`${wsBaseUrl}/ws`, { headers: { Cookie: aliceCookie } });
    const wsBob = new WebSocket(`${wsBaseUrl}/ws`, { headers: { Cookie: bobCookie } });

    await Promise.all([
      new Promise((resolve) => wsAlice.once('open', resolve)),
      new Promise((resolve) => wsBob.once('open', resolve)),
    ]);

    const bobReceivedChannel = new Promise((resolve) => {
      wsBob.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.message.channelId === 'general') {
          resolve(msg.message);
        }
      });
    });

    wsAlice.send(JSON.stringify({ type: 'send_message', channelId: 'general', content: 'Hello team!' }));
    const channelMsg = await bobReceivedChannel;
    assert.equal(channelMsg.content, 'Hello team!');
    assert.equal(channelMsg.senderName, 'Alice');

    const aliceReceivedDm = new Promise((resolve) => {
      wsAlice.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.message.recipientId === aliceData.credentials.userId) {
          resolve(msg.message);
        }
      });
    });

    wsBob.send(
      JSON.stringify({
        type: 'send_message',
        recipientId: aliceData.credentials.userId,
        content: 'Hey Alice, secret DM!',
      })
    );
    const dmMsg = await aliceReceivedDm;
    assert.equal(dmMsg.content, 'Hey Alice, secret DM!');

    // 5. Verify persistence via REST API
    const historyRes = await fetch(`${baseUrl}/api/chat/messages?channelId=general`, {
      headers: { Cookie: bobCookie },
    });
    const history = await historyRes.json();
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].content, 'Hello team!');

    // 6. Admin disables Bob -> Bob's WS is kicked and Bob can no longer login
    const bobKicked = new Promise((resolve) => {
      wsBob.once('close', (code) => resolve(code));
    });

    const disableRes = await fetch(`${baseUrl}/api/admin/users/bob01`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ isActive: false }),
    });
    assert.equal(disableRes.status, 200);
    assert.equal(await bobKicked, 4001);

    const bobReLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'bob01', pin: '998877' }),
    });
    assert.equal(bobReLogin.status, 403);

    // 7. Admin resets Alice's PIN -> old PIN fails, new PIN works
    const resetRes = await fetch(
      `${baseUrl}/api/admin/users/${encodeURIComponent(aliceData.credentials.userId)}/reset-pin`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ pin: '445566' }),
      }
    );
    assert.equal(resetRes.status, 200);

    const oldPinRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aliceData.credentials),
    });
    assert.equal(oldPinRes.status, 401);

    const newPinRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: aliceData.credentials.userId, pin: '445566' }),
    });
    assert.equal(newPinRes.status, 200);

    wsAlice.close();
  });
});
