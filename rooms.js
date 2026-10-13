'use strict';

/*
 * rooms.js — Room management for the Raw City Spades server.
 *
 *  - createRoom(name, options)      -> 6-character room code, caller becomes host (seat 0).
 *                                   options: {targetScore, spadesMustBreak, sandbags}
 *                                   (validated; unknown fields ignored)
 *  - joinRoom(code, name, token) -> takes the first free seat, or reconnects a
 *                                   disconnected player when their token matches
 *  - setTeams(room, player, teams) — host only, lobby only
 *  - startGame(room, player)     — host only, needs 4 connected players
 *  - markDisconnected(room, player, onTimeout) — holds the seat for 60 seconds;
 *    on timeout the seat is freed (lobby) or the in-progress game is aborted.
 *
 * Player tokens are random 128-bit hex strings handed to the client on
 * create/join; the client stores theirs and passes it back to reclaim a seat
 * after a disconnect. The alphabet avoids 0/O and 1/I/L so codes read clearly
 * when shared by voice or text.
 */

const crypto = require('crypto');
const { SpadesEngine, validateOptions } = require('./game');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 6;
const RECONNECT_HOLD_MS = 60 * 1000;

class RoomError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoomError';
  }
}

function makeCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanName(name) {
  const n = String(name ?? '').trim().slice(0, 24);
  if (!n) throw new RoomError('Display name is required');
  return n;
}

function validateTeamsShape(teams) {
  if (!Array.isArray(teams) || teams.length !== 2 ||
      !teams.every(t => Array.isArray(t) && t.length === 2)) {
    throw new RoomError('teams must be two pairs of seats, e.g. [[0,2],[1,3]]');
  }
  const flat = teams.flat().sort((a, b) => a - b);
  if (flat.join(',') !== '0,1,2,3') {
    throw new RoomError('teams must cover exactly seats 0,1,2,3 once each');
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> room
  }

  getRoom(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new RoomError('Room not found — check the code');
    return room;
  }

  createRoom(name, options) {
    let code;
    do { code = makeCode(); } while (this.rooms.has(code));
    const room = {
      code,
      seats: [null, null, null, null], // seat index -> player or null
      hostSeat: 0,
      teams: [[0, 2], [1, 3]],
      options: validateOptions(options), // validated here; unknown fields ignored
      phase: 'lobby', // lobby -> playing -> hand_done -> match_done
      engine: null,
    };
    const player = {
      token: makeToken(),
      name: cleanName(name),
      seat: 0,
      connected: true,
      disconnectTimer: null,
      ws: null, // attached by server.js
    };
    room.seats[0] = player;
    this.rooms.set(code, room);
    return { room, player };
  }

  joinRoom(code, name, token) {
    const room = this.getRoom(code);
    if (token) {
      const player = room.seats.find(p => p && p.token === token);
      if (!player) throw new RoomError('Reconnect token not recognized for this room');
      this._clearTimer(player);
      player.connected = true;
      if (name) player.name = cleanName(name);
      return { room, player, reconnected: true };
    }
    const seat = room.seats.findIndex(s => s === null);
    if (seat < 0) throw new RoomError('Room is full (4 players max)');
    const player = {
      token: makeToken(),
      name: cleanName(name),
      seat,
      connected: true,
      disconnectTimer: null,
      ws: null,
    };
    room.seats[seat] = player;
    return { room, player, reconnected: false };
  }

  /** Host may set or swap partnerships before the game starts. */
  setTeams(room, player, teams) {
    this._needHost(room, player);
    if (room.phase !== 'lobby') throw new RoomError('Teams can only change before the game starts');
    validateTeamsShape(teams);
    room.teams = teams.map(t => t.slice());
  }

  /**
   * Host starts the match (lobby -> first hand), the next hand after a
   * completed one, or a fresh match after match_done.
   */
  startGame(room, player) {
    this._needHost(room, player);
    if (room.phase === 'playing' || room.phase === 'bidding') {
      throw new RoomError('Game already in progress');
    }
    const missing = room.seats.findIndex(s => s === null || !s.connected);
    if (missing >= 0) throw new RoomError('Need 4 connected players to start');
    if (room.phase === 'lobby' || room.phase === 'match_done') {
      room.engine = new SpadesEngine(room.teams, room.options);
    }
    room.engine.startHand();
    room.phase = 'playing';
  }

  /** Mark a player disconnected; the seat is held 60s for reconnect. */
  markDisconnected(room, player, onTimeout) {
    player.connected = false;
    player.ws = null;
    this._clearTimer(player);
    const timer = setTimeout(() => {
      player.disconnectTimer = null;
      const wasPlaying = room.phase === 'playing';
      room.seats[player.seat] = null;
      if (wasPlaying) {
        // No AI stand-ins: abort the in-progress game, back to lobby.
        room.engine = null;
        room.phase = 'lobby';
      }
      if (room.hostSeat === player.seat) {
        const next = room.seats.findIndex(p => p !== null);
        room.hostSeat = next; // -1 when the room is now empty
      }
      if (room.seats.every(s => s === null)) {
        this.rooms.delete(room.code);
      }
      if (onTimeout) onTimeout({ abortedGame: wasPlaying });
    }, RECONNECT_HOLD_MS);
    // Never let a reconnect timer keep the node process alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
    player.disconnectTimer = timer;
  }

  _needHost(room, player) {
    if (!player || player.seat !== room.hostSeat) {
      throw new RoomError('Only the host can do that');
    }
  }

  _clearTimer(player) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
  }
}

module.exports = { RoomManager, RoomError };
