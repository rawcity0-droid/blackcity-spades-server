'use strict';
/*
 * test-subs.js — subscription gating tests (no Stripe key needed).
 * Run: node test-subs.js   (server must NOT have SUBS_BYPASS set)
 *
 * Verifies:
 *  - free create_room with defaults works
 *  - create_room with custom options is rejected (Premium)
 *  - create_room with private:true is rejected (Premium)
 *  - set_teams is rejected for non-subscribers (Premium)
 *  - /api/subscription-status returns {subscribed:false}
 *  - /api/create-checkout returns 503 without a key
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = 8099;
process.env.PORT = String(PORT);
const { wss } = require('./server.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function wsCall(payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(payload)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'room_state' || m.type === 'error') {
        clearTimeout(timer); ws.close(); resolve(m);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }).on('error', reject);
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  await new Promise(r => setTimeout(r, 400));

  // 1. Free room with defaults works.
  const free = await wsCall({ type: 'create_room', name: 'Free', playerId: 'pid-free-1' });
  check('free create_room with defaults works', free.type === 'room_state', free.type);

  // 2. Custom options rejected.
  const custom = await wsCall({ type: 'create_room', name: 'Custom', playerId: 'pid-free-2', options: { targetScore: 250 } });
  check('custom options rejected for non-subscriber',
    custom.type === 'error' && /(premium|not configured)/i.test(custom.message), custom.message);

  // 3. Private room rejected.
  const priv = await wsCall({ type: 'create_room', name: 'Priv', playerId: 'pid-free-3', options: { private: true } });
  check('private room rejected for non-subscriber',
    priv.type === 'error' && /(premium|not configured)/i.test(priv.message), priv.message);

  // 4. set_teams rejected — need a room first, then set_teams on same socket.
  const teamsResult = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    let roomed = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create_room', name: 'Host', playerId: 'pid-free-4' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'room_state' && !roomed) {
        roomed = true;
        ws.send(JSON.stringify({ type: 'set_teams', teams: [[0, 1], [2, 3]] }));
      } else if (m.type === 'error') {
        clearTimeout(timer); ws.close(); resolve(m);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  check('set_teams rejected for non-subscriber',
    /(premium|not configured)/i.test(teamsResult.message), teamsResult.message);

  // 5. REST: status false.
  const st = await httpGet('/api/subscription-status?playerId=pid-free-1');
  check('subscription-status false without key', st.status === 200 && st.body.subscribed === false, JSON.stringify(st.body));

  // 6. REST: create-checkout 503 without key.
  const co = await httpPost('/api/create-checkout', { playerId: 'x' });
  check('create-checkout 503 without key', co.status === 503, `status=${co.status}`);

  console.log(`\n${passed}/${passed + failed} subscription gating checks passed`);
  wss.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e.message); process.exit(1); });
