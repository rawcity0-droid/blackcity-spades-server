'use strict';

/*
 * subs.js — Blackcity Spades Premium ($1.99/mo) via Stripe.
 *
 * Server-authoritative subscription checks. No webhooks: the server verifies
 * checkout sessions and subscription status on demand through the Stripe API.
 *
 * Player identity is the client-generated playerId (a UUID kept in the
 * player's browser). Anyone who knows a playerId could claim it, but UUIDs
 * are unguessable — good enough until real accounts exist.
 *
 * Needs STRIPE_SECRET_KEY in the environment. Without it, checkout creation
 * is unavailable and every premium check fails closed with a clear error.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1UQ2KiAS0ay5ROvPG0wvwvXd';
const SUCCESS_URL = process.env.SUBSCRIBE_SUCCESS_URL ||
  'https://muse.ai/s/spades-xrxr64xjxi5vxtxmxt?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = process.env.SUBSCRIBE_CANCEL_URL ||
  'https://muse.ai/s/spades-xrxr64xjxi5vxtxmxt';
const STORE_PATH = path.join(__dirname, 'subs.json');
const REVERIFY_MS = 24 * 60 * 60 * 1000; // re-check with Stripe daily
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

let store = {}; // playerId -> { subscriptionId, verifiedAt }
try {
  store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) || {};
} catch {
  store = {};
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store));
  } catch (err) {
    console.error('subs: could not persist store:', err.message);
  }
}

function secretKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

function stripeRequest(method, apiPath, params) {
  return new Promise((resolve, reject) => {
    const key = secretKey();
    if (!key) return reject(new Error('STRIPE_SECRET_KEY is not configured'));
    const body = params ? querystring.stringify(params) : '';
    let fullPath = apiPath;
    const headers = {
      'Authorization': 'Bearer ' + key,
      'Stripe-Version': '2025-08-27.basil',
    };
    if (method === 'GET' && body) {
      fullPath += (fullPath.includes('?') ? '&' : '?') + body;
    } else if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({
      hostname: 'api.stripe.com',
      path: fullPath,
      method,
      headers,
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 300) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const msg = (data && data.error && data.error.message) || `Stripe HTTP ${res.statusCode}`;
        reject(new Error(msg));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Stripe request timed out')); });
    if (method !== 'GET' && body) req.write(body);
    req.end();
  });
}

function cleanPlayerId(id) {
  const s = String(id || '').trim().slice(0, 64);
  if (!s) throw new Error('playerId is required');
  return s;
}

/** Create a subscription Checkout Session; returns the hosted URL. */
async function createCheckoutSession(playerId, playerName) {
  const pid = cleanPlayerId(playerId);
  const session = await stripeRequest('POST', '/v1/checkout/sessions', {
    'mode': 'subscription',
    'line_items[0][price]': PRICE_ID,
    'line_items[0][quantity]': '1',
    'success_url': SUCCESS_URL,
    'cancel_url': CANCEL_URL,
    'client_reference_id': pid,
    'metadata[player_id]': pid,
    'subscription_data[metadata][player_id]': pid,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/** Verify a completed checkout session and record the subscription. */
async function verifySession(sessionId, playerId) {
  const pid = cleanPlayerId(playerId);
  const sid = String(sessionId || '').trim();
  if (!sid.startsWith('cs_')) throw new Error('Invalid checkout session');
  const session = await stripeRequest('GET', '/v1/checkout/sessions/' + encodeURIComponent(sid), {});
  if (session.payment_status !== 'paid') return false;
  if (session.client_reference_id !== pid &&
      !(session.metadata && session.metadata.player_id === pid)) {
    return false; // session belongs to a different player
  }
  const subId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription && session.subscription.id);
  if (!subId) return false;
  const sub = await stripeRequest('GET', '/v1/subscriptions/' + encodeURIComponent(subId), {});
  if (!ACTIVE_STATUSES.has(sub.status)) return false;
  store[pid] = { subscriptionId: sub.id, verifiedAt: Date.now() };
  saveStore();
  return true;
}

/** Search Stripe for an active subscription carrying this playerId. */
async function findActiveSubscription(pid) {
  const res = await stripeRequest('GET', '/v1/subscriptions/search', {
    query: `metadata['player_id']:'${pid}'`,
    limit: '5',
  });
  for (const sub of (res.data || [])) {
    if (ACTIVE_STATUSES.has(sub.status)) return sub;
  }
  return null;
}

async function refreshFromStripe(pid, hadRecord) {
  const rec = store[pid];
  try {
    if (rec && rec.subscriptionId) {
      const sub = await stripeRequest(
        'GET', '/v1/subscriptions/' + encodeURIComponent(rec.subscriptionId), {});
      const ok = ACTIVE_STATUSES.has(sub.status);
      if (ok) {
        store[pid] = { subscriptionId: sub.id, verifiedAt: Date.now() };
        saveStore();
      } else {
        delete store[pid];
        saveStore();
      }
      return ok;
    }
    const sub = await findActiveSubscription(pid);
    if (sub) {
      store[pid] = { subscriptionId: sub.id, verifiedAt: Date.now() };
      saveStore();
      return true;
    }
    if (rec) { delete store[pid]; saveStore(); }
    return false;
  } catch (err) {
    console.error('subs: Stripe check failed:', err.message);
    // Graceful: keep a previously-verified record if Stripe is unreachable.
    return hadRecord;
  }
}

/** The authoritative premium check. Fails closed without a key. */
async function isSubscribed(playerId) {
  if (process.env.SUBS_BYPASS === '1') return true; // automated tests only
  let pid;
  try { pid = cleanPlayerId(playerId); } catch { return false; }
  if (!secretKey()) return false;
  const rec = store[pid];
  if (rec && (Date.now() - rec.verifiedAt) < REVERIFY_MS) return true;
  return refreshFromStripe(pid, !!rec);
}

function subscriptionsConfigured() {
  return !!secretKey() || process.env.SUBS_BYPASS === '1'; // bypass: automated tests only
}

module.exports = {
  createCheckoutSession,
  verifySession,
  isSubscribed,
  subscriptionsConfigured,
  PRICE_ID,
};
