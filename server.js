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
const { RoomManager, RoomError, TournamentManager } = require('./rooms');
const { chooseBotBid, chooseBotCard } = require('./bots');
const { EngineError, cardId } = require('./game');
const subs = require('./subs');

const PORT = Number(process.env.PORT) || 8080;
const DEFAULT_OPTIONS = { targetScore: 500, spadesMustBreak: true, sandbags: true };

function isDefaultOptions(o) {
  return o.targetScore === DEFAULT_OPTIONS.targetScore &&
    o.spadesMustBreak === DEFAULT_OPTIONS.spadesMustBreak &&
    o.sandbags === DEFAULT_OPTIONS.sandbags;
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
const tournaments = new TournamentManager(manager);
const clients = new Map(); // ws -> { room, player } | { spectatorOf, spectator } | { tournament, lobbyEntry }

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

/** Broadcast to seated players AND spectators (results, room state). */
function broadcastAll(room, obj) {
  broadcast(room, obj);
  for (const s of room.spectators) {
    if (s.ws) send(s.ws, obj);
  }
}

/** Personalized game state per player — each sees only their own hand. */
function broadcastGameState(room) {
  for (const p of room.seats) {
    if (p && p.ws && room.engine) {
      send(p.ws, { type: 'game_state', state: room.engine.getView(p.seat) });
    }
  }
  // Spectators get the masked view — never any hands.
  if (room.engine) {
    const spec = { type: 'game_state', state: room.engine.getSpectatorView() };
    for (const s of room.spectators) {
      if (s.ws) send(s.ws, spec);
    }
  }
}

/** Validate a player avatar: small JPEG/PNG/WebP data URL, max ~50KB. */
function cleanAvatar(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s.startsWith('data:image/')) return null;
  if (s.length > 70000) return null; // ~50KB binary
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return null;
  return s;
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
      ? { seat: p.seat, name: p.name, connected: p.connected, avatar: p.avatar || null, isBot: !!p.isBot }
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
      broadcastAll(room, {
        type: 'trick_result',
        trickNumber: e.trickNumber,
        cards: e.cards,
        winnerSeat: e.winnerSeat,
      });
    } else if (e.type === 'hand_done') {
      room.phase = 'hand_done';
      broadcastAll(room, {
        type: 'hand_result',
        detail: e.detail,
        scores: e.scores,
        bags: e.bags,
      });
    } else if (e.type === 'match_done') {
      room.phase = 'match_done';
      broadcastAll(room, {
        type: 'match_result',
        winnerTeam: e.winnerTeam,
        scores: e.scores,
      });
      // Bracket tournaments: advance the winning team automatically.
      if (room.bracketTournamentCode && room.bracketMatchId) {
        try {
          const result = tournaments.recordBracketWin(
            room.bracketTournamentCode, room.code, e.winnerTeam);
          for (const n of result.notifications) {
            if (n.ws) {
              send(n.ws, {
                type: 'tournament_seated',
                tournamentCode: room.bracketTournamentCode,
                tableCode: n.tableCode,
                seat: n.seat,
                token: n.token,
                bracketAdvance: !!n.bracketAdvance,
                rematch: !!n.rematch,
                gameNumber: n.gameNumber || 1,
                seriesScore: n.seriesScore || null,
              });
            }
          }
          broadcastTournament(result.tournament,
            tournaments.tournamentState(room.bracketTournamentCode));
        } catch (err) { /* bracket bookkeeping must never crash the game */ }
      }
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
  maybeBotMove(room);
}

/**
 * If it's a bot's turn, play for it after a short human-like pause.
 * Chained: each bot move flows back through handleEngineEvents.
 */
function maybeBotMove(room) {
  const eng = room.engine;
  if (!eng || room.phase !== 'playing') return;
  if (eng.phase !== 'bidding' && eng.phase !== 'playing') return;
  const seat = eng.turn;
  const p = room.seats[seat];
  if (!p || !p.isBot) return;
  const timer = setTimeout(() => {
    try {
      if (room.engine !== eng || room.phase !== 'playing') return;
      if (eng.turn !== seat) return;
      const now = room.seats[seat];
      if (!now || !now.isBot) return;
      let events = null;
      if (eng.phase === 'bidding') {
        events = eng.bid(seat, chooseBotBid(eng, seat));
      } else if (eng.phase === 'playing') {
        events = eng.playCard(seat, chooseBotCard(eng, seat));
      }
      if (events) handleEngineEvents(room, events);
    } catch (err) { /* a bot hiccup must never crash the table */ }
  }, 1200 + Math.random() * 1500);
  if (typeof timer.unref === 'function') timer.unref();
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
      const avatar = cleanAvatar(msg.avatar);
      // Creating a table and sharing its code is a Premium feature — only the
      // host pays; guests join free with the code.
      await requirePremium(playerId);
      const { room, player } = manager.createRoom(msg.name, msg.options);
      room.isPrivate = wantsPrivate;
      player.ws = ws;
      player.playerId = playerId;
      if (avatar) player.avatar = avatar;
      clients.set(ws, { room, player });
      send(ws, { ...roomStateMsg(room), yourToken: player.token, yourSeat: player.seat });
      return;
    }

    case 'join_room': {
      if (typeof msg.code !== 'string' || typeof msg.name !== 'string') {
        throw new RoomError('join_room needs "code" and "name"');
      }
      // Guests join free with the host's code — only the host pays Premium.
      const { room, player, reconnected } = manager.joinRoom(msg.code, msg.name, msg.token);
      player.ws = ws;
      // Don't overwrite a valid stored premium email with an empty string
      // (client Premium is session-only; a rejoin with empty playerId would
      // wipe the server's copy and break host Premium actions).
      if (typeof msg.playerId === 'string' && msg.playerId) player.playerId = msg.playerId;
      const joinAvatar = cleanAvatar(msg.avatar);
      if (joinAvatar) player.avatar = joinAvatar;
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
        // Rejoining mid-turn: the rejoin game_state wipes the client's one-shot
        // turn prompts (legalCards/canBid), and prompts are the only source of
        // legal cards — so re-send the pending prompt if it's their turn.
        // Sent only to this socket (never broadcast): per-seat privacy.
        const eng = room.engine;
        if (eng.phase === 'bidding' && eng.turn === player.seat) {
          send(ws, { type: 'bid_prompt', seat: player.seat });
        } else if (eng.phase === 'playing' && eng.turn === player.seat) {
          send(ws, {
            type: 'play_prompt',
            seat: player.seat,
            legalCards: eng.legalCards(player.seat).map(cardId),
          });
        }
      }
      return;
    }

    case 'set_teams': {
      requireSeat(ctx);
      // Refresh premium identity from the request (client may have restored
      // Premium after the seat was claimed; stored copy may be stale/empty).
      if (typeof msg.playerId === 'string' && msg.playerId) ctx.player.playerId = msg.playerId;
      await requirePremium(ctx.player.playerId || '');
      manager.setTeams(ctx.room, ctx.player, msg.teams);
      broadcast(ctx.room, roomStateMsg(ctx.room));
      return;
    }

    case 'set_options': {
      // Host changes house rules from the lobby (before the game starts).
      requireSeat(ctx);
      // Refresh premium identity from the request (see set_teams).
      if (typeof msg.playerId === 'string' && msg.playerId) ctx.player.playerId = msg.playerId;
      await requirePremium(ctx.player.playerId || '');
      const options = manager.setOptions(ctx.room, ctx.player, msg.options);
      broadcast(ctx.room, roomStateMsg(ctx.room));
      send(ctx.ws, { type: 'options_updated', code: ctx.room.code, options });
      return;
    }

    case 'chat': {
      // Table talk: seated players can chat back-and-forth. Broadcast to the
      // table (players + spectators). Ephemeral — no history stored.
      requireSeat(ctx);
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : '';
      if (!text) throw new RoomError('chat needs "text"');
      const now = Date.now();
      if (ctx.player.lastChatAt && now - ctx.player.lastChatAt < 2000) {
        throw new RoomError('Slow down — one message every couple of seconds.');
      }
      ctx.player.lastChatAt = now;
      const chatMsg = { type: 'chat', from: String(ctx.player.name).slice(0, 20), seat: ctx.player.seat, text };
      broadcast(ctx.room, chatMsg);
      for (const s of ctx.room.spectators) { if (s.ws) send(s.ws, chatMsg); }
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

    case 'spectate_room': {
      // Watch-only: sees the table, never any hands. For tournament streams.
      if (typeof msg.code !== 'string' || typeof msg.name !== 'string') {
        throw new RoomError('spectate_room needs "code" and "name"');
      }
      // Watching a host's table is free — only the host pays Premium.
      const { room, spectator } = manager.addSpectator(msg.code, msg.name);
      spectator.ws = ws;
      clients.set(ws, { spectatorOf: room, spectator });
      send(ws, {
        type: 'spectate_joined',
        code: room.code,
        spectator: true,
        ...roomStateMsg(room),
      });
      if (room.phase === 'playing' && room.engine) {
        send(ws, { type: 'game_state', state: room.engine.getSpectatorView() });
      }
      return;
    }

    case 'create_tournament': {
      // Premium host creates a tournament with 1-8 tables.
      if (typeof msg.name !== 'string' || !msg.name.trim()) {
        throw new RoomError('create_tournament needs a "name"');
      }
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      await requirePremium(playerId);
      const { tournament, hostRoom, hostPlayer } =
        tournaments.createTournament(msg.name, msg.tableCount, msg.options);
      hostPlayer.ws = ws;
      hostPlayer.playerId = playerId;
      clients.set(ws, { room: hostRoom, player: hostPlayer, tournamentHost: tournament.code });
      send(ws, {
        type: 'tournament_created',
        tournamentCode: tournament.code,
        tournamentName: tournament.name,
        tables: tournament.tables.map(t => ({ tableIndex: t.tableIndex, code: t.code })),
        // Host auto-joins table 0.
        tableCode: hostRoom.code,
        yourSeat: hostPlayer.seat,
        yourToken: hostPlayer.token,
      });
      send(ws, roomStateMsg(hostRoom));
      return;
    }

    case 'join_tournament': {
      // Player joins the tournament lobby; host seats them next.
      if (typeof msg.tournamentCode !== 'string' || typeof msg.name !== 'string') {
        throw new RoomError('join_tournament needs "tournamentCode" and "name"');
      }
      // Guests join the tournament free — only the host pays Premium.
      const { tournament, entry, waitlistEntry, position } = tournaments.joinLobby(msg.tournamentCode, msg.name);
      const myEntry = waitlistEntry || entry;
      myEntry.ws = ws;
      const lobbyAvatar = cleanAvatar(msg.avatar);
      if (lobbyAvatar) myEntry.avatar = lobbyAvatar;
      clients.set(ws, { tournament, lobbyEntry: myEntry });
      if (waitlistEntry) {
        send(ws, {
          type: 'tournament_waitlisted',
          tournamentCode: tournament.code,
          position,
        });
      }
      send(ws, tournaments.tournamentState(tournament.code));
      // Notify the host's table(s) — broadcast to all seated players in tournament.
      broadcastTournament(tournament, tournaments.tournamentState(tournament.code));
      return;
    }

    case 'seat_tournament_players': {
      // Host seats lobby players into tables (4 per table).
      const tcode = typeof msg.tournamentCode === 'string' ? msg.tournamentCode : '';
      const tournament = tournaments.getTournament(tcode);
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      await requirePremium(playerId);
      const seated = tournaments.seatPlayers(tcode);
      // Tell each seated player their table + token so their client
      // can auto-join the room and claim the seat.
      for (const s of seated) {
        if (s.entry.ws) {
          send(s.entry.ws, {
            type: 'tournament_seated',
            tournamentCode: tcode,
            tableCode: s.tableCode,
            seat: s.seat,
            token: s.token,
          });
        }
      }
      broadcastTournament(tournament, tournaments.tournamentState(tcode));
      return;
    }

    case 'add_bots': {
      // Host fills empty seats with computer players (lobby only).
      const { room, player } = requireSeat(ctx);
      const added = manager.addBots(room, player);
      broadcastAll(room, roomStateMsg(room));
      send(ws, { type: 'bots_added', code: room.code, added });
      return;
    }

    case 'leave_table': {
      // Voluntary leave. Frees the seat; tournament tables pull from the waitlist.
      const { room, player } = requireSeat(ctx);
      const tcode = room.tournamentCode;
      const { abortedGame } = tournaments.freeSeat(room, player);
      clients.set(ws, {});
      if (abortedGame) {
        broadcastAll(room, {
          type: 'error',
          message: `${player.name} left — game aborted, room is back in lobby`,
        });
      }
      let promo = null;
      if (tcode) {
        try {
          const t = tournaments.getTournament(tcode);
          if (t.mode !== 'bracket') {
            promo = tournaments.promoteFromWaitlist(tcode);
            if (promo) notifyPromoted(promo, tcode);
            broadcastTournament(t, tournaments.tournamentState(tcode));
          }
        } catch { /* tournament gone */ }
      }
      try { broadcastAll(room, roomStateMsg(room)); } catch { /* room gone */ }
      send(ws, { type: 'left_table', code: room.code });
      return;
    }

    case 'tournament_start_table': {
      // Host starts the game on one tournament table.
      const tcode = typeof msg.tournamentCode === 'string' ? msg.tournamentCode : '';
      const tournament = tournaments.getTournament(tcode);
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      await requirePremium(playerId);
      const idx = Math.floor(Number(msg.tableIndex) || 0);
      const tbl = tournament.tables[idx];
      if (!tbl) throw new RoomError('No such table');
      const room = manager.getRoom(tbl.code);
      manager.forceStartGame(room);
      handleEngineEvents(room, []);
      broadcastTournament(tournament, tournaments.tournamentState(tcode));
      return;
    }

    case 'create_bracket': {
      // Premium host creates a single-elimination bracket (4, 8, or 16 players).
      if (typeof msg.name !== 'string' || !msg.name.trim()) {
        throw new RoomError('create_bracket needs a "name"');
      }
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      await requirePremium(playerId);
      const { tournament } = tournaments.createBracket(
        msg.name, msg.playerCount, msg.options);
      const entry = { name: String(msg.name).trim().slice(0, 20), ws };
      const bracketAvatar = cleanAvatar(msg.avatar);
      if (bracketAvatar) entry.avatar = bracketAvatar;
      tournament.lobby.push(entry);
      clients.set(ws, { tournament, lobbyEntry: entry });
      send(ws, {
        type: 'bracket_created',
        tournamentCode: tournament.code,
        tournamentName: tournament.name,
        bracketSize: tournament.bracketSize,
      });
      send(ws, tournaments.tournamentState(tournament.code));
      return;
    }

    case 'bracket_start': {
      // Host starts Round 1: lobby players are seated into bracket matches.
      const tcode = typeof msg.tournamentCode === 'string' ? msg.tournamentCode : '';
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      await requirePremium(playerId);
      const { tournament, notifications } = tournaments.startBracket(tcode);
      for (const n of notifications) {
        if (n.ws) {
          send(n.ws, {
            type: 'tournament_seated',
            tournamentCode: tcode,
            tableCode: n.tableCode,
            seat: n.seat,
            token: n.token,
          });
        }
      }
      broadcastTournament(tournament, tournaments.tournamentState(tcode));
      return;
    }

    case 'bracket_start_table': {
      // Host starts the game on one bracket table (by table code).
      const tcode = typeof msg.tournamentCode === 'string' ? msg.tournamentCode : '';
      const tableCode = typeof msg.tableCode === 'string' ? msg.tableCode : '';
      const tournament = tournaments.getTournament(tcode);
      const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
      await requirePremium(playerId);
      const room = manager.getRoom(tableCode);
      manager.forceStartGame(room);
      handleEngineEvents(room, []);
      broadcastTournament(tournament, tournaments.tournamentState(tcode));
      return;
    }

    default:
      throw new RoomError(`Unknown message type: ${msg.type}`);
  }
}

/** Send a message to everyone in a tournament (all tables + lobby). */
/**
 * Tell a waitlist-promoted player their table + token so their client
 * can auto-join and claim the seat.
 */
function notifyPromoted(promo, tcode) {
  if (!promo || !promo.entry.ws) return;
  const ws = promo.entry.ws;
  try {
    const room = manager.getRoom(promo.tableCode);
    clients.set(ws, { room, player: promo.player });
  } catch { /* room gone */ }
  send(ws, {
    type: 'tournament_seated',
    tournamentCode: tcode,
    tableCode: promo.tableCode,
    seat: promo.seat,
    token: promo.token,
    fromWaitlist: true,
  });
}

function broadcastTournament(tournament, obj) {
  const seen = new Set();
  for (const tbl of tournament.tables) {
    try {
      const room = manager.getRoom(tbl.code);
      for (const p of room.seats) {
        if (p && p.ws && !seen.has(p.ws)) { seen.add(p.ws); send(p.ws, obj); }
      }
      for (const s of room.spectators) {
        if (s.ws && !seen.has(s.ws)) { seen.add(s.ws); send(s.ws, obj); }
      }
    } catch { /* table gone */ }
  }
  for (const e of tournament.lobby) {
    if (e.ws && !seen.has(e.ws)) { seen.add(e.ws); send(e.ws, obj); }
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
    if (req.method === 'GET' && url.pathname === '/stats') {
      // Owner-only live stats dashboard. Open with ?email=<owner email>.
      if (!subs.isOwner(url.searchParams.get('email'))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Not authorized.');
      }
      let playersOnline = 0, inLobby = 0, inGame = 0, tables = 0, gamesPlaying = 0;
      for (const room of manager.rooms.values()) {
        tables++;
        if (room.phase === 'playing' || room.phase === 'bidding') gamesPlaying++;
        for (const p of room.seats) {
          if (p && !p.isBot && p.connected) {
            playersOnline++;
            if (room.phase === 'lobby') inLobby++; else inGame++;
          }
        }
        for (const s of (room.spectators || [])) {
          if (s && s.ws) playersOnline++;
        }
      }
      let tournamentsRunning = 0;
      for (const t of tournaments.tournaments.values()) {
        if (!t.finished) tournamentsRunning++;
      }
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta http-equiv="refresh" content="30">` +
        `<title>Blackcity Spades — Live Stats</title>` +
        `<style>body{font-family:sans-serif;background:#0f1b2d;color:#fff;margin:0;padding:20px}` +
        `h1{font-size:22px;color:#e8b93c} .card{background:#1a2a44;border-radius:12px;padding:16px;margin:12px 0}` +
        `.num{font-size:40px;font-weight:bold;color:#e8b93c} .label{color:#9fb0cc;font-size:14px}` +
        `.t{color:#9fb0cc;font-size:12px;margin-top:20px}</style></head><body>` +
        `<h1>♠️ Blackcity Spades — Live</h1>` +
        `<div class="card"><div class="num">${playersOnline}</div><div class="label">Players online now</div></div>` +
        `<div class="card"><div class="num">${tables}</div><div class="label">Active tables (${gamesPlaying} games in progress)</div></div>` +
        `<div class="card"><div class="num">${inLobby}</div><div class="label">Players in lobbies</div></div>` +
        `<div class="card"><div class="num">${inGame}</div><div class="label">Players in games</div></div>` +
        `<div class="card"><div class="num">${tournamentsRunning}</div><div class="label">Tournaments running</div></div>` +
        `<div class="t">Auto-refreshes every 30 seconds. Only visible with the owner email.</div>` +
        `</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
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

// Keepalive: reap half-open mobile sockets so their delayed 'close' can't
// nuke a live rejoin (ghost-nuke). Every 25s, ping; terminate sockets that
// miss 3 pongs in a row (75s of silence). Tolerant of brief mobile stalls.
const keepalive = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPongs = (ws.missedPongs || 0) + 1;
    } else {
      ws.missedPongs = 0;
    }
    if (ws.missedPongs >= 3) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);
if (typeof keepalive.unref === 'function') keepalive.unref();

wss.on('connection', (ws) => {
  clients.set(ws, { room: null, player: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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
    if (!ctx) return;
    if (ctx.spectatorOf && ctx.spectator) {
      // Spectator left — just detach.
      manager.removeSpectator(ctx.spectatorOf, ctx.spectator);
      return;
    }
    if (ctx.tournament && ctx.lobbyEntry) {
      // Left the tournament lobby before being seated.
      tournaments.leaveLobby(ctx.tournament.code, ctx.lobbyEntry);
      try {
        broadcastTournament(ctx.tournament, tournaments.tournamentState(ctx.tournament.code));
      } catch { /* tournament gone */ }
      return;
    }
    if (ctx.room && ctx.player) {
      const { room, player } = ctx;
      // Ghost-nuke guard: if the player already rejoined on a newer socket,
      // player.ws points there — this closing socket is stale. Skip
      // markDisconnected so we don't null the live connection.
      if (player.ws !== ws) return;
      manager.markDisconnected(room, player, ({ abortedGame }) => {
        // 60s hold expired — seat is now free.
        if (abortedGame) {
          broadcastAll(room, {
            type: 'error',
            message: `${player.name} timed out — game aborted, room is back in lobby`,
          });
        }
        const tcode = room.tournamentCode;
        if (tcode) {
          try {
            const t = tournaments.getTournament(tcode);
            if (t.mode !== 'bracket') {
              const promo = tournaments.promoteFromWaitlist(tcode);
              if (promo) notifyPromoted(promo, tcode);
              broadcastTournament(t, tournaments.tournamentState(tcode));
            }
          } catch { /* tournament gone */ }
        }
        try { broadcastAll(room, roomStateMsg(room)); } catch { /* room gone */ }
      });
      broadcastAll(room, roomStateMsg(room)); // immediate: show them as disconnected
    }
  });
});

wss.on('error', (err) => {
  console.error('WebSocket server error:', err.message);
});

module.exports = { wss, manager };
