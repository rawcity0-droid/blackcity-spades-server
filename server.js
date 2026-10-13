'use strict';

/*
 * server.js — WebSocket server for Raw City Spades multiplayer.
 *
 * JSON protocol.
 *
 * Client -> server:
 *   create_room { name, playerId?, options? } -> host a room, become seat 0
 *                                          options: {targetScore: 250|500,
 *                                                    spadesMustBreak: bool,
 *                                                    sandbags: bool,
 *                                                    private: bool}
 *                                          (validated; unknown fields ignored)
 *                                          Premium (subscriber) required when
 *                                          options differ from defaults or
 *                                          private is true. Free rooms use
 *                                          defaults: 500 / break-first / bags on.
 *   join_room   { code, name, token?, playerId? } -> join a seat, or reconnect
 *   set_teams   { teams }                   -> host sets partnerships (lobby only)
 *                                          Premium required (free hosts keep
 *                                          the default 0&2 vs 1&3).
 *   start_game  {}                          -> host starts match / next hand / rematch
 *   bid         { bid }                     -> bid 0-13 (0 = nil) on your turn
 *   play_card   { cardId }                  -> play a card on your turn
 *
 * REST (subscriptions — identity is the subscriber's email):
 *   POST /api/create-checkout { playerName, email } -> { url }
 *   POST /api/verify-session  { sessionId }         -> { subscribed, email }
 *   GET  /api/subscription-status?email=            -> { subscribed }
 *
 * Server -> client:
 *   room_state   { code, phase, hostSeat, teams, options, seats[], yourToken?, yourSeat? }
 *   game_state   { state }                   -> personalized: contains ONLY your hand
 *                                              (state.options mirrors room options)
 *   bid_prompt   { seat }                    -> it's your turn to bid
 *   play_prompt  { seat, legalCards[] }      -> it's your turn to play
 *   trick_result { trickNumber, cards[], winnerSeat }
 *   hand_result  { detail[], scores[], bags[] }
 *   match_result { winnerTeam, scores[] }
 *   error        { message }
 *
 * Every incoming message is validated; illegal actions get a clear error.
 * Hands are never broadcast — each socket receives only its own cards.
 */

const { WebSocketServer } = require('ws');
const http = require('http');
const { RoomManager, RoomError } = require('./rooms');
const { EngineError, cardId } = require('./game');
const subs = require('./subs');

const PORT = Number(process.env.PORT) || 8080;
const DEFAULT_OPTIONS = { targetScore: 500, spadesMustBreak: true, sandbags: true };

// Free players may choose a target of 250 or 500. Turning spades-must-break
// off or sandbags off are Premium house rules.
function isFreeOptions(o) {
  return (o.targetScore === 250 || o.targetScore === 500) &&
    o.spadesMustBreak === true &&
    o.sandbags === true;
}

function premiumError() {
  return new RoomError('That is a Premium feature — subscribe for $1.99/mo to unlock private tables, chosen teams, and custom house rules.');
}

async function requirePremium(playerId) {
  if (!subs.subscriptionsConfigured()) {
    throw new RoomError('Subscriptions are not configured on this server yet.');
  }
  if (!(await subs.isSubscribed(playerId))) throw premiumError();
}

const manager = new RoomManager();
const clients = new Map(); // ws -> { room, player }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj)); // 1 = OPEN
}

function sendToSeat(room, seat, obj) {
  const p = room.seats[seat];
  if (p && p.ws) send(p.ws, obj);
}

/** Broadcast to every seated player with a live socket. */
function broadcast(room, obj) {
  for (const p of room.seats) {
    if (p && p.ws) send(p.ws, obj);
  }
}

/** Personalized game state per player — each sees only their own hand. */
function broadcastGameState(room) {
  for (const p of room.seats) {
    if (p && p.ws && room.engine) {
      send(p.ws, { type: 'game_state', state: room.engine.getView(p.seat) });
    }
  }
}

function roomStateMsg(room) {
  return {
    type: 'room_state',
    code: room.code,
    phase: room.phase,
    hostSeat: room.hostSeat,
    teams: room.teams.map(t => t.slice()),
    options: { ...room.options },
    isPrivate: !!room.isPrivate,
    seats: room.seats.map(p => (p
      ? { seat: p.seat, name: p.name, connected: p.connected }
      : null)),
  };
}

function requireSeat(ctx) {
  if (!ctx.room || !ctx.player) throw new RoomError('Join a room first');
  return ctx;
}

/** Translate engine events into protocol messages + prompts. */
function handleEngineEvents(room, events) {
  for (const e of events) {
    if (e.type === 'trick_done') {
      broadcast(room, {
        type: 'trick_result',
        trickNumber: e.trickNumber,
        cards: e.cards,
        winnerSeat: e.winnerSeat,
      });
    } else if (e.type === 'hand_done') {
      room.phase = 'hand_done';
      broadcast(room, {
        type: 'hand_result',
        detail: e.detail,
        scores: e.scores,
        bags: e.bags,
      });
    } else if (e.type === 'match_done') {
      room.phase = 'match_done';
      broadcast(room, {
        type: 'match_result',
        winnerTeam: e.winnerTeam,
        scores: e.scores,
      });
    }
    // 'bid_made' / 'card_played' / 'bidding_done' are covered by game_state.
  }
  const eng = room.engine;
  if (eng && room.phase === 'playing') {
    broadcastGameState(room);
    if (eng.phase === 'bidding') {
      sendToSeat(room, eng.turn, { type: 'bid_prompt', seat: eng.turn });
    } else if (eng.phase === 'playing') {
      sendToSeat(room, eng.turn, {
        type: 'play_prompt',
        seat: eng.turn,
        legalCards: eng.legalCards(eng.turn).map(cardId),
      });
    }
  } else if (eng && (room.phase === 'hand_done' || room.phase === 'match_done')) {
    broadcastGameState(room);
  }
}

async function route(ws, msg) {
  if (!msg || typeof msg.type !== 'string') {
    throw new RoomError('Message needs a "type" field');
  }
  const ctx = clients.get(ws);

  switch (msg.type) {
    case 'create_room': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) {
        throw new RoomError('create_room needs a "name"');
      }
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      const wantsPrivate = !!(msg.options && msg.options.private);
      // Premium is required for private tables or non-free house rules.
      if (wantsPrivate || !isFreeOptions({ ...DEFAULT_OPTIONS, ...(msg.options || {}) })) {
        await requirePremium(playerId);
      }
      const { room, player } = manager.createRoom(msg.name, msg.options);
      room.isPrivate = wantsPrivate;
      player.ws = ws;
      player.playerId = playerId;
      clients.set(ws, { room, player });
      send(ws, { ...roomStateMsg(room), yourToken: player.token, yourSeat: player.seat });
      return;
    }

    case 'join_room': {
      if (typeof msg.code !== 'string' || typeof msg.name !== 'string') {
        throw new RoomError('join_room needs "code" and "name"');
      }
      const { room, player, reconnected } = manager.joinRoom(msg.code, msg.name, msg.token);
      player.ws = ws;
      if (typeof msg.playerId === 'string') player.playerId = msg.playerId;
      clients.set(ws, { room, player });
      send(ws, {
        ...roomStateMsg(room),
        yourToken: player.token,
        yourSeat: player.seat,
        reconnected,
      });
      broadcast(room, roomStateMsg(room));
      if (room.phase === 'playing' && room.engine) {
        send(ws, { type: 'game_state', state: room.engine.getView(player.seat) });
      }
      return;
    }

    case 'set_teams': {
      requireSeat(ctx);
      await requirePremium(ctx.player.playerId || '');
      manager.setTeams(ctx.room, ctx.player, msg.teams);
      broadcast(ctx.room, roomStateMsg(ctx.room));
      return;
    }

    case 'start_game': {
      requireSeat(ctx);
      manager.startGame(ctx.room, ctx.player);
      handleEngineEvents(ctx.room, []); // pushes game_state + first bid_prompt
      return;
    }

    case 'bid': {
      requireSeat(ctx);
      const { room, player } = ctx;
      if (!room.engine) throw new EngineError('No game in progress');
      if (player.seat !== room.engine.turn) {
        throw new EngineError("Not your turn to bid");
      }
      const events = room.engine.bid(player.seat, msg.bid);
      handleEngineEvents(room, events);
      return;
    }

    case 'play_card': {
      requireSeat(ctx);
      const { room, player } = ctx;
      if (!room.engine) throw new EngineError('No game in progress');
      if (player.seat !== room.engine.turn) {
        throw new EngineError("Not your turn to play");
      }
      const events = room.engine.playCard(player.seat, msg.cardId);
      handleEngineEvents(room, events);
      return;
    }

    default:
      throw new RoomError(`Unknown message type: ${msg.type}`);
  }
}

/* ---------- REST endpoints (subscriptions) ---------- */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 16 * 1024) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify(obj));
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  try {
    if (req.method === 'POST' && url.pathname === '/api/create-checkout') {
      const body = await readJsonBody(req);
      if (!subs.subscriptionsConfigured()) {
        return sendJson(res, 503, { error: 'Subscriptions are not configured on this server yet.' });
      }
      const checkoutUrl = await subs.createCheckoutSession(body.playerName, body.email);
      return sendJson(res, 200, { url: checkoutUrl });
    }
    if (req.method === 'POST' && url.pathname === '/api/verify-session') {
      const body = await readJsonBody(req);
      const email = await subs.verifySession(body.sessionId);
      return sendJson(res, 200, { subscribed: !!email, email: email || null });
    }
    if (req.method === 'GET' && url.pathname === '/api/subscription-status') {
      const ok = await subs.isSubscribed(url.searchParams.get('email'));
      return sendJson(res, 200, { subscribed: ok });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('Blackcity Spades server — connect with a WebSocket client.');
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('HTTP error:', err.message);
    return sendJson(res, 500, { error: err.message || 'Server error' });
  }
}

const httpServer = http.createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`Blackcity Spades server listening on port ${PORT}`);
  console.log(`Subscriptions ${subs.subscriptionsConfigured() ? 'ENABLED' : 'DISABLED (set STRIPE_SECRET_KEY)'}`);
});

wss.on('connection', (ws) => {
  clients.set(ws, { room: null, player: null });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    route(ws, msg).catch((err) => {
      const message = (err instanceof RoomError || err instanceof EngineError)
        ? err.message
        : 'Server error';
      send(ws, { type: 'error', message });
    });
  });

  ws.on('close', () => {
    const ctx = clients.get(ws);
    clients.delete(ws);
    if (ctx && ctx.room && ctx.player) {
      const { room, player } = ctx;
      manager.markDisconnected(room, player, ({ abortedGame }) => {
        // 60s hold expired.
        if (abortedGame) {
          broadcast(room, {
            type: 'error',
            message: `${player.name} timed out — game aborted, room is back in lobby`,
          });
        }
        broadcast(room, roomStateMsg(room));
      });
      broadcast(room, roomStateMsg(room)); // immediate: show them as disconnected
    }
  });
});

wss.on('error', (err) => {
  console.error('WebSocket server error:', err.message);
});

module.exports = { wss, manager };
