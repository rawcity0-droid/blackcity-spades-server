'use strict';

/*
 * subs.js — Blackcity Spades Premium ($1.99/mo) via Stripe.
 *
 * Server-authoritative subscription checks. No webhooks: the server verifies
 * checkout sessions and subscription status on demand through the Stripe API.
 *
 * Player identity is the subscriber's email address (lowercased). The static
 * game client cannot persist storage across reloads, so the email — which the
 * player knows — is the reproducible key. The server persists the
 * email -> subscription mapping in subs.json and re-verifies with Stripe
 * at most once a day.
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

let store = {}; // email -> { subscriptionId, verifiedAt }
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

function cleanEmail(email) {
  const s = String(email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('a valid email is required');
  return s;
}

/** Create a subscription Checkout Session; returns the hosted URL. */
async function createCheckoutSession(playerName, email) {
  const em = cleanEmail(email);
  const session = await stripeRequest('POST', '/v1/checkout/sessions', {
    'mode': 'subscription',
    'line_items[0][price]': PRICE_ID,
    'line_items[0][quantity]': '1',
    'success_url': SUCCESS_URL,
    'cancel_url': CANCEL_URL,
    'customer_email': em,
    'client_reference_id': em,
    'metadata[player_email]': em,
    'metadata[player_name]': String(playerName || '').slice(0, 60),
    'subscription_data[metadata][player_email]': em,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/** Verify a completed checkout session; returns the subscriber email or null. */
async function verifySession(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid.startsWith('cs_')) throw new Error('Invalid checkout session');
  const session = await stripeRequest('GET', '/v1/checkout/sessions/' + encodeURIComponent(sid), {});
  if (session.payment_status !== 'paid') return null;
  const subId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription && session.subscription.id);
  if (!subId) return null;
  const sub = await stripeRequest('GET', '/v1/subscriptions/' + encodeURIComponent(subId), {});
  if (!ACTIVE_STATUSES.has(sub.status)) return null;
  const email = cleanEmail(
    (sub.metadata && sub.metadata.player_email) ||
    (session.metadata && session.metadata.player_email) ||
    session.customer_email || session.customer_details?.email);
  store[email] = { subscriptionId: sub.id, verifiedAt: Date.now() };
  saveStore();
  return email;
}

/** Find an active subscription for a customer email via the Stripe API. */
async function findActiveSubscription(email) {
  const customers = await stripeRequest('GET', '/v1/customers/search', {
    query: `email:'${email.replace(/'/g, "\\'")}'`,
    limit: '3',
  });
  for (const cus of (customers.data || [])) {
    const subs = await stripeRequest('GET', '/v1/subscriptions', {
      customer: cus.id,
      status: 'active',
      limit: '5',
    });
    for (const sub of (subs.data || [])) {
      if (ACTIVE_STATUSES.has(sub.status)) return { sub, email };
    }
  }
  return null;
}

async function refreshFromStripe(email, hadRecord) {
  const rec = store[email];
  try {
    if (rec && rec.subscriptionId) {
      const sub = await stripeRequest(
        'GET', '/v1/subscriptions/' + encodeURIComponent(rec.subscriptionId), {});
      const ok = ACTIVE_STATUSES.has(sub.status);
      if (ok) {
        store[email] = { subscriptionId: sub.id, verifiedAt: Date.now() };
        saveStore();
      } else {
        delete store[email];
        saveStore();
      }
      return ok;
    }
    const found = await findActiveSubscription(email);
    if (found) {
      store[email] = { subscriptionId: found.sub.id, verifiedAt: Date.now() };
      saveStore();
      return true;
    }
    if (rec) { delete store[email]; saveStore(); }
    return false;
  } catch (err) {
    console.error('subs: Stripe check failed:', err.message);
    // Graceful: keep a previously-verified record if Stripe is unreachable.
    return hadRecord;
  }
}

/** The authoritative premium check. Fails closed without a key. */
async function isSubscribed(email) {
  if (process.env.SUBS_BYPASS === '1') return true; // automated tests only
  let em;
  try { em = cleanEmail(email); } catch { return false; }
  if (!secretKey()) return false;
  const rec = store[em];
  if (rec && (Date.now() - rec.verifiedAt) < REVERIFY_MS) return true;
  return refreshFromStripe(em, !!rec);
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
