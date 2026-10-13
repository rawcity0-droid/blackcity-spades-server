'use strict';

/*
 * server.js — WebSocket server for Raw City Spades multiplayer.
 *
 * JSON protocol.
 *
 * Client -> server:
 *   create_room { name, options? }        -> host a room, become seat 0
 *                                          options: {targetScore: 250|500,
 *                                                    spadesMustBreak: bool,
 *                                                    sandbags: bool}
 *                                          (validated; unknown fields ignored)
 *   join_room   { code, name, token? }      -> join a seat, or reconnect with token
 *   set_teams   { teams }                   -> host sets partnerships (lobby only)
 *   start_game  {}                          -> host starts match / next hand / rematch
 *   bid         { bid }                     -> bid 0-13 (0 = nil) on your turn
 *   play_card   { cardId }                  -> play a card on your turn
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
const { RoomManager, RoomError } = require('./rooms');
const { EngineError, cardId } = require('./game');

const PORT = Number(process.env.PORT) || 8080;

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

function route(ws, msg) {
  if (!msg || typeof msg.type !== 'string') {
    throw new RoomError('Message needs a "type" field');
  }
  const ctx = clients.get(ws);

  switch (msg.type) {
    case 'create_room': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) {
        throw new RoomError('create_room needs a "name"');
      }
      const { room, player } = manager.createRoom(msg.name, msg.options);
      player.ws = ws;
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

const wss = new WebSocketServer({ port: PORT }, () => {
  console.log(`Raw City Spades server listening on port ${PORT}`);
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
    try {
      route(ws, msg);
    } catch (err) {
      const message = (err instanceof RoomError || err instanceof EngineError)
        ? err.message
        : 'Server error';
      send(ws, { type: 'error', message });
    }
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
