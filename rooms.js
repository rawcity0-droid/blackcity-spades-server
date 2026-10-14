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
    const isTournamentTable = !!room.tournamentCode;
    const humans = room.seats
      .map((p, s) => (p && p.connected && !p.isBot ? s : -1))
      .filter(s => s >= 0);
    if (isTournamentTable) {
      // Competitive tables stay human-only.
      const missing = room.seats.findIndex(s => s === null || !s.connected);
      if (missing >= 0) throw new RoomError('Need 4 connected players to start');
    } else {
      if (humans.length === 0) throw new RoomError('Need at least 1 player to start');
      this._fillBots(room);
      // Two humans, default teams -> pair the humans against the bots.
      if (humans.length === 2 &&
          JSON.stringify(room.teams) === JSON.stringify([[0, 2], [1, 3]])) {
        const bots = [0, 1, 2, 3].filter(s => !humans.includes(s));
        room.teams = [[humans[0], humans[1]], [bots[0], bots[1]]];
      }
    }
    if (room.phase === 'lobby' || room.phase === 'match_done') {
      room.engine = new SpadesEngine(room.teams, room.options);
    }
    room.engine.startHand();
    room.phase = 'playing';
  }

  /**
   * Host adds computer players to empty seats (lobby only).
   * Works on regular and tournament tables — a solo host can play
   * a tournament by themselves with bots.
   * Returns the number of bots added.
   */
  addBots(room, player) {
    this._needHost(room, player);
    if (room.phase === 'playing' || room.phase === 'bidding') {
      throw new RoomError('Game already in progress');
    }
    const before = room.seats.filter(s => s !== null).length;
    this._fillBots(room);
    // Two humans, default teams -> pair the humans against the bots.
    const humans = room.seats
      .map((p, s) => (p && p.connected && !p.isBot ? s : -1))
      .filter(s => s >= 0);
    if (humans.length === 2 &&
        JSON.stringify(room.teams) === JSON.stringify([[0, 2], [1, 3]])) {
      const bots = [0, 1, 2, 3].filter(s => !humans.includes(s));
      room.teams = [[humans[0], humans[1]], [bots[0], bots[1]]];
    }
    return room.seats.filter(s => s !== null).length - before;
  }

  /** Fill empty seats with computer players (regular tables only). */
  _fillBots(room) {
    const used = new Set(room.seats.filter(Boolean).map(p => p.name));
    const pool = ['Ace', 'Deuce', 'Lucky', 'Rover', 'Joker', 'Chip', 'Sunny', 'Pepper'];
    for (let s = 0; s < 4; s++) {
      if (room.seats[s] !== null) continue;
      const name = pool.find(n => !used.has(n)) || `CPU ${s + 1}`;
      used.add(name);
      room.seats[s] = {
        token: null,
        name,
        seat: s,
        connected: true, // no socket — the server plays for this seat
        disconnectTimer: null,
        ws: null,
        isBot: true,
        avatar: null,
      };
    }
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
      waitlist: [], // [{ name, ws, avatar }] — overflow, seated as spots open
      seatingDone: false,
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
    // Once seating has happened and every table is full, newcomers wait in line.
    if (t.mode !== 'bracket' && t.seatingDone && !this._freeTournamentSeat(t)) {
      t.waitlist.push(entry);
      return { tournament: t, waitlistEntry: entry, position: t.waitlist.length };
    }
    t.lobby.push(entry);
    return { tournament: t, entry };
  }

  /** Remove a lobby/waitlist entry (on disconnect). */
  leaveLobby(code, entry) {
    const t = this.tournaments.get(String(code || '').toUpperCase());
    if (!t || !entry) return;
    let i = t.lobby.indexOf(entry);
    if (i >= 0) t.lobby.splice(i, 1);
    if (t.waitlist) {
      i = t.waitlist.indexOf(entry);
      if (i >= 0) t.waitlist.splice(i, 1);
    }
  }

  /** First free seat across the tournament's lobby-phase tables, or null. */
  _freeTournamentSeat(t) {
    for (const tbl of t.tables) {
      let room;
      try { room = this.roomManager.getRoom(tbl.code); } catch { continue; }
      if (room.phase !== 'lobby') continue;
      const seat = room.seats.findIndex(s => s === null);
      if (seat >= 0) return { room, seat };
    }
    return null;
  }

  /**
   * Seat the first waiting-list player at the first free seat.
   * Returns { entry, player, tableCode, seat, token } or null.
   */
  promoteFromWaitlist(code) {
    const t = this.getTournament(code);
    if (!t.waitlist || !t.waitlist.length) return null;
    const spot = this._freeTournamentSeat(t);
    if (!spot) return null;
    const entry = t.waitlist.shift();
    const player = {
      token: makeToken(),
      name: entry.name,
      seat: spot.seat,
      connected: false, // they claim it via their token next
      disconnectTimer: null,
      ws: null,
      avatar: entry.avatar || null,
    };
    spot.room.seats[spot.seat] = player;
    if (spot.room.hostSeat < 0 || !spot.room.seats[spot.room.hostSeat]) {
      spot.room.hostSeat = spot.seat;
    }
    return { entry, player, tableCode: spot.room.code, seat: spot.seat, token: player.token };
  }

  /**
   * Voluntarily free a player's seat (leave_table). Aborts a live game,
   * following the same rule as a disconnect timeout.
   * Returns { room, abortedGame }.
   */
  freeSeat(room, player) {
    const wasHost = player.seat === room.hostSeat;
    this.roomManager._clearTimer(player);
    room.seats[player.seat] = null;
    let abortedGame = false;
    if (room.phase === 'playing') {
      room.engine = null;
      room.phase = 'lobby';
      abortedGame = true;
    }
    if (wasHost) {
      room.hostSeat = room.seats.findIndex(p => p !== null);
    }
    if (room.seats.every(s => s === null)) {
      this.roomManager.rooms.delete(room.code);
    }
    return { room, abortedGame };
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
            avatar: entry.avatar || null,
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
    t.seatingDone = true;
    // Anyone who didn't fit becomes the waiting list, in join order.
    for (const entry of t.lobby) t.waitlist.push(entry);
    t.lobby.length = 0;
    return seated;
  }

  /**
   * BRACKET TOURNAMENTS — single elimination.
   * playerCount: 4, 8, or 16. Each match is a 4-player table (2v2);
   * the winning TEAM (2 players) advances to the next round.
   */
  createBracket(hostName, playerCount, options) {
    const n = [4, 8, 16].includes(Number(playerCount)) ? Number(playerCount) : 8;
    const roundNames = n === 4 ? ['Final']
      : n === 8 ? ['Semifinals', 'Final']
      : ['Quarterfinals', 'Semifinals', 'Final'];
    const code = this._makeTournamentCode();
    const rounds = roundNames.map((name, r) => {
      const matchCount = Math.pow(2, roundNames.length - 1 - r);
      const isFinalRound = r === roundNames.length - 1;
      return {
        name,
        matches: Array.from({ length: matchCount }, (_, m) => ({
          matchId: `R${r}M${m}`,
          tableCode: null,
          teamA: null, // [name1, name2]
          teamB: null,
          winner: null, // 'A' | 'B'
          status: 'waiting', // waiting | playing | done
          // Series format: best-of-3 (first to 2) until the final, best-of-5 (first to 3) in the final.
          seriesWins: { A: 0, B: 0 },
          seriesTarget: isFinalRound ? 3 : 2,
          gameNumber: 1,
        })),
      };
    });
    const tournament = {
      code,
      name: `${cleanName(hostName)}'s Bracket`.slice(0, 40) || 'Bracket',
      mode: 'bracket',
      bracketSize: n,
      rounds,
      tables: [], // { code } — every created table, for broadcastTournament
      lobby: [], // [{ name, ws }] — waiting to be seated
      hostName: cleanName(hostName),
      createdAt: Date.now(),
      champion: null, // [name1, name2]
      started: false,
    };
    this.tournaments.set(code, tournament);
    return { tournament };
  }

  /** Make a seat-claim player object (same shape as seatPlayers). */
  _bracketSeat(name, seat, avatar) {
    return {
      token: makeToken(),
      name,
      seat,
      connected: false, // claimed via token next
      disconnectTimer: null,
      ws: null,
      avatar: avatar || null,
    };
  }

  /**
   * Host starts the bracket: seat lobby players into Round 1 matches.
   * Returns { tournament, notifications: [{ ws, name, tableCode, seat, token }] }.
   */
  startBracket(code) {
    const t = this.getTournament(code);
    if (t.mode !== 'bracket') throw new RoomError('Not a bracket tournament');
    if (t.started) throw new RoomError('Bracket already started');
    if (t.lobby.length < t.bracketSize) {
      throw new RoomError(`Need ${t.bracketSize} players to start (have ${t.lobby.length})`);
    }
    t.started = true;
    const notifications = [];
    const round0 = t.rounds[0];
    for (let m = 0; m < round0.matches.length; m++) {
      const match = round0.matches[m];
      const group = t.lobby.splice(0, 4);
      const { room } = this.roomManager.createRoom(
        `Bracket ${round0.name} ${m + 1}`, { tournamentCode: t.code });
      room.bracketTournamentCode = t.code;
      room.bracketMatchId = match.matchId;
      t.tables.push({ code: room.code });
      match.tableCode = room.code;
      match.status = 'playing';
      // Team A (group[0], group[1]) -> seats 0,2 ; Team B (group[2], group[3]) -> seats 1,3
      match.teamA = [group[0].name, group[1].name];
      match.teamB = [group[2].name, group[3].name];
      const ordered = [group[0], group[1], group[2], group[3]];
      const seatMap = [0, 2, 1, 3];
      ordered.forEach((entry, i) => {
        const seat = seatMap[i];
        const player = this._bracketSeat(entry.name, seat, entry.avatar);
        room.seats[seat] = player;
        notifications.push({ ws: entry.ws, name: entry.name, tableCode: room.code, seat, token: player.token });
      });
    }
    return { tournament: t, notifications };
  }

  /**
   * Record a completed bracket match and advance the winning team.
   * Called on match_done. Returns { tournament, notifications, champion }.
   * notifications: [{ ws, name, tableCode, seat, token }] for advanced players.
   */
  recordBracketWin(code, tableCode, winnerTeam) {
    const t = this.getTournament(code);
    if (t.mode !== 'bracket') return { tournament: t, notifications: [], champion: t.champion };
    let match = null, roundIndex = -1;
    for (let r = 0; r < t.rounds.length; r++) {
      const found = t.rounds[r].matches.find(mt => mt.tableCode === tableCode);
      if (found) { match = found; roundIndex = r; break; }
    }
    if (!match || match.status === 'done') {
      return { tournament: t, notifications: [], champion: t.champion };
    }
    // Pull all players (name + live ws + seat) from the finished room.
    let allPlayers = [];
    try {
      const room = this.roomManager.getRoom(tableCode);
      allPlayers = room.seats
        .map((p, s) => (p ? { name: p.name, ws: p.ws, seat: s, avatar: p.avatar || null } : null))
        .filter(Boolean);
    } catch { /* room gone */ }
    const winnerSlot = winnerTeam === 0 ? 'A' : 'B';
    match.seriesWins[winnerSlot]++;
    const notifications = [];
    const seriesScore = () => `${match.seriesWins.A}-${match.seriesWins.B}`;

    // Series decided? Advance. Otherwise: rematch with the same teams.
    if (match.seriesWins[winnerSlot] >= match.seriesTarget) {
      const winSeats = winnerTeam === 0 ? [0, 2] : [1, 3];
      const winners = allPlayers.filter(p => winSeats.includes(p.seat));
      match.status = 'done';
      match.winner = winnerSlot;
      const isFinal = roundIndex === t.rounds.length - 1;
      if (isFinal) {
        t.champion = winners.map(w => w.name);
      } else {
        const m = t.rounds[roundIndex].matches.indexOf(match);
        const nextMatch = t.rounds[roundIndex + 1].matches[Math.floor(m / 2)];
        const slot = (m % 2 === 0) ? 'teamA' : 'teamB';
        nextMatch[slot] = winners.map(w => w.name);
        nextMatch[slot + 'Ws'] = winners;
        if (nextMatch.teamA && nextMatch.teamB) {
          const nextName = `Bracket ${t.rounds[roundIndex + 1].name} ${Math.floor(m / 2) + 1}`;
          const created = this.roomManager.createRoom(nextName, { tournamentCode: t.code });
          const room = created.room;
          room.bracketTournamentCode = t.code;
          room.bracketMatchId = nextMatch.matchId;
          t.tables.push({ code: room.code });
          nextMatch.tableCode = room.code;
          nextMatch.status = 'playing';
          for (const teamSlot of ['teamA', 'teamB']) {
            const seats = teamSlot === 'teamA' ? [0, 2] : [1, 3];
            (nextMatch[teamSlot + 'Ws'] || []).forEach((w, idx) => {
              const seat = seats[idx];
              if (seat === undefined) return;
              const player = this._bracketSeat(w.name, seat, w.avatar);
              room.seats[seat] = player;
              notifications.push({ ws: w.ws, name: w.name, tableCode: room.code,
                seat, token: player.token, bracketAdvance: true });
            });
          }
        }
      }
    } else {
      // Rematch: same teams, fresh table. Series score carries over.
      match.gameNumber++;
      const mIdx = t.rounds[roundIndex].matches.indexOf(match);
      const rematchName = `Bracket ${t.rounds[roundIndex].name} ${mIdx + 1} G${match.gameNumber}`;
      const created = this.roomManager.createRoom(rematchName, { tournamentCode: t.code });
      const room = created.room;
      room.bracketTournamentCode = t.code;
      room.bracketMatchId = match.matchId;
      t.tables.push({ code: room.code });
      match.tableCode = room.code;
      // match stays 'playing'; winner stays null until series decided
      for (const p of allPlayers) {
        const player = this._bracketSeat(p.name, p.seat, p.avatar);
        room.seats[p.seat] = player;
        notifications.push({ ws: p.ws, name: p.name, tableCode: room.code,
          seat: p.seat, token: player.token,
          rematch: true, gameNumber: match.gameNumber, seriesScore: seriesScore() });
      }
    }
    return { tournament: t, notifications, champion: t.champion };
  }

  /** Snapshot of tournament state for host / lobby views. */
  tournamentState(code) {
    const t = this.getTournament(code);
    const base = {
      type: 'tournament_state',
      tournamentCode: t.code,
      name: t.name,
      hostName: t.hostName,
      mode: t.mode || 'tables',
      lobby: t.lobby.map(e => ({ name: e.name })),
    };
    if (t.mode === 'bracket') {
      base.bracketSize = t.bracketSize;
      base.champion = t.champion;
      base.started = !!t.started;
      base.rounds = t.rounds.map(r => ({
        name: r.name,
        matches: r.matches.map(m => ({
          matchId: m.matchId,
          tableCode: m.tableCode,
          teamA: m.teamA ? m.teamA.slice() : null,
          teamB: m.teamB ? m.teamB.slice() : null,
          winner: m.winner,
          status: m.status,
          seriesWins: m.seriesWins,
          seriesTarget: m.seriesTarget,
          gameNumber: m.gameNumber,
        })),
      }));
      base.tables = t.tables.map(tbl => {
        try {
          const room = this.roomManager.getRoom(tbl.code);
          return { code: room.code, phase: room.phase };
        } catch { return { code: tbl.code, phase: 'unknown' }; }
      });
      return base;
    }
    return {
      type: 'tournament_state',
      tournamentCode: t.code,
      name: t.name,
      hostName: t.hostName,
      lobby: t.lobby.map(e => ({ name: e.name })),
      waitlist: (t.waitlist || []).map(e => ({ name: e.name })),
      seatingDone: !!t.seatingDone,
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
