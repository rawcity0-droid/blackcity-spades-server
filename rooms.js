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
      spectators: [], // { name, ws } — watch-only, never see hands
      tournamentCode: options && options.tournamentCode ? String(options.tournamentCode) : null,
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

  /** Attach a spectator (watch-only, no seat). Returns spectator record. */
  addSpectator(code, name) {
    const room = this.getRoom(code);
    const spectator = {
      name: cleanName(name),
      ws: null, // attached by server.js
    };
    room.spectators.push(spectator);
    return { room, spectator };
  }

  /** Detach a spectator. */
  removeSpectator(room, spectator) {
    const i = room.spectators.indexOf(spectator);
    if (i >= 0) room.spectators.splice(i, 1);
  }

  /**
   * Start a game on a room without requiring a seated host player.
   * Used by tournament hosts (Premium verified by caller).
   */
  forceStartGame(room) {
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

/*
 * TournamentManager — groups multiple rooms (tables) into a single event.
 *
 * A Premium host creates a tournament with 1-8 tables. Players join with the
 * tournament code and wait in the lobby; the host seats them (4 per table)
 * and starts each table's game. Spectators can watch any table.
 *
 * Tournament codes use the same 6-character alphabet as room codes, drawn
 * from the same namespace (a tournament code will never collide with a room
 * code because both are checked against their own maps — actually we share
 * the RoomManager's code space by prefixing tournament codes with 'T').
 */
class TournamentManager {
  constructor(roomManager) {
    this.roomManager = roomManager;
    this.tournaments = new Map(); // code -> tournament
  }

  _makeTournamentCode() {
    let code;
    do { code = 'T' + makeCode().slice(0, 5); } while (
      this.tournaments.has(code) || this.roomManager.rooms.has(code));
    return code;
  }

  getTournament(code) {
    const t = this.tournaments.get(String(code || '').toUpperCase());
    if (!t) throw new RoomError('Tournament not found — check the code');
    return t;
  }

  /**
   * Create a tournament. The host's playerId must be a Premium subscriber
   * (checked by server.js). Returns { tournament, hostPlayer }.
   */
  createTournament(hostName, tableCount, options) {
    const n = Math.max(1, Math.min(8, Math.floor(Number(tableCount) || 1)));
    const code = this._makeTournamentCode();
    const tables = [];
    for (let i = 0; i < n; i++) {
      // Host takes seat 0 at table 0; other tables start empty.
      const { room } = this.roomManager.createRoom(
        i === 0 ? hostName : `Table ${i + 1}`,
        { ...(options || {}), tournamentCode: code });
      // Free the host's auto-seat on non-host tables so players can fill them.
      if (i !== 0) room.seats[0] = null;
      tables.push({ tableIndex: i, code: room.code });
    }
    const tournament = {
      code,
      name: String(hostName || 'Tournament').trim().slice(0, 32) || 'Tournament',
      tables, // [{ tableIndex, code }]
      lobby: [], // [{ name, ws }] — waiting to be seated
      hostName: cleanName(hostName),
      createdAt: Date.now(),
    };
    // Re-seat the host properly at table 0.
    const table0 = this.roomManager.getRoom(tables[0].code);
    table0.seats[0].name = cleanName(hostName);
    this.tournaments.set(code, tournament);
    return { tournament, hostRoom: table0, hostPlayer: table0.seats[0] };
  }

  /** A player joins the tournament lobby (not seated yet). */
  joinLobby(code, name) {
    const t = this.getTournament(code);
    const entry = { name: cleanName(name), ws: null };
    t.lobby.push(entry);
    return { tournament: t, entry };
  }

  /** Remove a lobby entry (on disconnect). */
  leaveLobby(code, entry) {
    const t = this.tournaments.get(String(code || '').toUpperCase());
    if (!t || !entry) return;
    const i = t.lobby.indexOf(entry);
    if (i >= 0) t.lobby.splice(i, 1);
  }

  /**
   * Seat lobby players into tables, 4 per table in join order.
   * Returns [{ entry, name, tableCode, seat, token }].
   */
  seatPlayers(code) {
    const t = this.getTournament(code);
    const seated = [];
    for (const entry of t.lobby) {
      let placed = false;
      for (const tbl of t.tables) {
        const room = this.roomManager.getRoom(tbl.code);
        if (room.phase !== 'lobby') continue;
        const seat = room.seats.findIndex(s => s === null);
        if (seat >= 0) {
          const player = {
            token: makeToken(),
            name: entry.name,
            seat,
            connected: false, // they claim it via their token next
            disconnectTimer: null,
            ws: null,
          };
          room.seats[seat] = player;
          entry.assigned = { tableCode: room.code, seat, token: player.token };
          seated.push({ entry, name: entry.name, tableCode: room.code, seat, token: player.token });
          placed = true;
          break;
        }
      }
      if (!placed) break; // all tables full
    }
    // Remove seated players from the lobby.
    t.lobby = t.lobby.filter(e => !e.assigned);
    return seated;
  }

  /** Snapshot of tournament state for host / lobby views. */
  tournamentState(code) {
    const t = this.getTournament(code);
    return {
      type: 'tournament_state',
      tournamentCode: t.code,
      name: t.name,
      hostName: t.hostName,
      lobby: t.lobby.map(e => ({ name: e.name })),
      tables: t.tables.map(tbl => {
        const room = this.roomManager.getRoom(tbl.code);
        return {
          tableIndex: tbl.tableIndex,
          code: room.code,
          phase: room.phase,
          seats: room.seats.map(p => (p
            ? { seat: p.seat, name: p.name, connected: p.connected }
            : null)),
        };
      }),
    };
  }
}

module.exports = { RoomManager, RoomError, TournamentManager };
