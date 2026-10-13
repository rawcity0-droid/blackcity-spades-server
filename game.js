'use strict';

/*
 * game.js — Authoritative Spades engine (no AI; all 4 seats are humans).
 *
 * Seats are numbered 0-3. Partnerships are configured as two pairs of seats,
 * e.g. [[0,2],[1,3]] (default). Every rule is enforced server-side; illegal
 * moves throw EngineError with a human-readable message.
 *
 * Rules implemented:
 *  - 52-card deck, 13 cards dealt to each seat.
 *  - Bidding 0-13 per seat; a bid of 0 is a nil bid.
 *  - Must follow the led suit when able.
 *  - Spades may not be led until broken, unless the player holds only spades.
 *  - Trick winner: highest spade played, otherwise highest card of led suit.
 *  - Scoring per hand, per team:
 *      contract = sum of partners' bids (nil bids add 0)
 *      taken >= contract  ->  contract*10 + 1 per overtrick (overtricks = bags)
 *      taken <  contract  ->  -(contract*10)
 *      nil bid            ->  +100 if the bidder took 0 tricks, else -100
 *      10 accumulated bags -> -100 penalty, bags reset by 10
 *  - Match ends when a team reaches the target score (250 or 500, default 500)
 *    or drops below -200 (higher score wins; a tie plays another hand).
 *
 * Game options (second constructor arg, all optional):
 *  - targetScore: 250 or 500 (default 500)
 *  - spadesMustBreak: when false, spades may be led at any time (default true)
 *  - sandbags: when false, overtricks still score +1 each but bags are never
 *    tracked and the 10-bag -100 penalty never applies (default true)
 * Unknown option fields are ignored for backward compatibility.
 */

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J 12=Q 13=K 14=A

function rankLabel(r) {
  return r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r);
}

/** Canonical card id, e.g. "AS", "10H", "2C". */
function cardId(card) {
  return rankLabel(card.rank) + card.suit;
}

/** Parse a card id back into {rank, suit}; returns null when malformed. */
function parseCardId(id) {
  const m = /^([2-9]|10|J|Q|K|A)([SHDC])$/.exec(String(id));
  if (!m) return null;
  const rank = m[1] === 'A' ? 14 : m[1] === 'K' ? 13 : m[1] === 'Q' ? 12
             : m[1] === 'J' ? 11 : parseInt(m[1], 10);
  return { rank, suit: m[2] };
}

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Highest spade wins the trick; otherwise highest card of the led suit. */
function trickWinner(trick) {
  const spades = trick.filter(t => t.card.suit === 'S');
  const pool = spades.length > 0
    ? spades
    : trick.filter(t => t.card.suit === trick[0].card.suit);
  return pool.reduce((best, t) => (t.card.rank > best.card.rank ? t : best));
}

function validateTeamsShape(teams) {
  if (!Array.isArray(teams) || teams.length !== 2 ||
      !teams.every(t => Array.isArray(t) && t.length === 2)) {
    throw new EngineError('teams must be two pairs of seats, e.g. [[0,2],[1,3]]');
  }
  const flat = teams.flat().sort((a, b) => a - b);
  if (flat.join(',') !== '0,1,2,3') {
    throw new EngineError('teams must cover exactly seats 0,1,2,3 once each');
  }
}

class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

/**
 * Validate game options, applying defaults. Unknown fields are ignored so
 * older clients keep working. Throws EngineError on invalid values.
 */
function validateOptions(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const targetScore = o.targetScore === undefined ? 500 : o.targetScore;
  if (targetScore !== 250 && targetScore !== 500) {
    throw new EngineError('targetScore must be 250 or 500');
  }
  const spadesMustBreak = o.spadesMustBreak === undefined ? true : o.spadesMustBreak;
  if (typeof spadesMustBreak !== 'boolean') {
    throw new EngineError('spadesMustBreak must be a boolean');
  }
  const sandbags = o.sandbags === undefined ? true : o.sandbags;
  if (typeof sandbags !== 'boolean') {
    throw new EngineError('sandbags must be a boolean');
  }
  return { targetScore, spadesMustBreak, sandbags };
}

class SpadesEngine {
  constructor(teams, options) {
    validateTeamsShape(teams);
    this.options = validateOptions(options);
    this.teams = teams.map(t => t.slice());
    this.teamOf = {};
    teams.forEach((pair, ti) => pair.forEach(s => { this.teamOf[s] = ti; }));
    this.scores = [0, 0];
    this.bags = [0, 0];
    this.handNumber = 0;
    this.phase = 'idle'; // idle -> bidding -> playing -> hand_done -> match_done
    this.winner = null;
    this.hands = null;
    this.bids = null;
  }

  _needPhase(p) {
    if (this.phase !== p) throw new EngineError(`Action not allowed while ${this.phase}`);
  }

  _needSeat(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
      throw new EngineError(`Invalid seat: ${seat}`);
    }
  }

  /** Deal a fresh hand. Allowed from idle or hand_done (next hand). */
  startHand() {
    if (this.phase === 'bidding' || this.phase === 'playing') {
      throw new EngineError('Hand already in progress');
    }
    if (this.phase === 'match_done') throw new EngineError('Match is over');
    this.handNumber += 1;
    const deck = shuffle(buildDeck());
    this.hands = [[], [], [], []];
    for (let i = 0; i < 52; i++) this.hands[i % 4].push(deck[i]);
    // Sort each hand by suit, then rank — cosmetic, helps clients display.
    for (const h of this.hands) {
      h.sort((a, b) => a.suit === b.suit ? a.rank - b.rank
                                         : SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
    }
    this.dealer = (this.handNumber - 1) % 4; // dealer rotates each hand
    this.bids = [null, null, null, null];
    this.tricksWon = [0, 0, 0, 0]; // per seat, this hand
    this.currentTrick = [];        // [{seat, card}]
    this.trickNumber = 0;
    this.spadesBroken = false;
    this.handScores = null;
    this.phase = 'bidding';
    this.turn = (this.dealer + 1) % 4; // bidding starts left of dealer
  }

  /** Record a bid (0-13; 0 = nil). Returns protocol-neutral events. */
  bid(seat, value) {
    this._needPhase('bidding');
    this._needSeat(seat);
    if (seat !== this.turn) throw new EngineError(`Not seat ${seat}'s turn to bid`);
    if (!Number.isInteger(value) || value < 0 || value > 13) {
      throw new EngineError('Bid must be an integer from 0 to 13 (0 = nil)');
    }
    this.bids[seat] = value;
    const events = [{ type: 'bid_made', seat, bid: value }];
    if (this.bids.every(b => b !== null)) {
      this.phase = 'playing';
      this.turn = (this.dealer + 1) % 4; // left of dealer leads the first trick
      events.push({ type: 'bidding_done', bids: this.bids.slice() });
    } else {
      this.turn = (this.turn + 1) % 4;
    }
    return events;
  }

  /** Cards the seat is legally allowed to play right now. */
  legalCards(seat) {
    this._needSeat(seat);
    const hand = this.hands[seat];
    if (this.currentTrick.length === 0) {
      // Leading. With spadesMustBreak=false, spades may be led at any time.
      if (!this.options.spadesMustBreak) return hand.slice();
      // Otherwise spades stay buried until broken, unless that's all you hold.
      const nonSpades = hand.filter(c => c.suit !== 'S');
      if (!this.spadesBroken && nonSpades.length > 0) return nonSpades;
      return hand.slice();
    }
    const ledSuit = this.currentTrick[0].card.suit;
    const follow = hand.filter(c => c.suit === ledSuit);
    return follow.length > 0 ? follow : hand.slice(); // void -> may dump anything
  }

  /** Play a card. Returns protocol-neutral events. */
  playCard(seat, id) {
    this._needPhase('playing');
    this._needSeat(seat);
    if (seat !== this.turn) throw new EngineError(`Not seat ${seat}'s turn to play`);
    const card = parseCardId(id);
    if (!card) throw new EngineError(`Malformed card id: ${id}`);
    const hand = this.hands[seat];
    const idx = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
    if (idx < 0) throw new EngineError(`Card ${id} is not in your hand`);
    const ok = this.legalCards(seat).some(c => c.rank === card.rank && c.suit === card.suit);
    if (!ok) {
      const led = this.currentTrick.length === 0 ? 'lead'
        : `follow ${this.currentTrick[0].card.suit}`;
      throw new EngineError(`Illegal play: ${id} (must ${led} when able)`);
    }
    const [played] = hand.splice(idx, 1);
    if (played.suit === 'S') this.spadesBroken = true;
    this.currentTrick.push({ seat, card: played });
    const events = [{ type: 'card_played', seat, card: cardId(played) }];

    if (this.currentTrick.length === 4) {
      const winner = trickWinner(this.currentTrick);
      this.tricksWon[winner.seat] += 1;
      this.trickNumber += 1;
      events.push({
        type: 'trick_done',
        trickNumber: this.trickNumber,
        cards: this.currentTrick.map(t => ({ seat: t.seat, card: cardId(t.card) })),
        winnerSeat: winner.seat,
      });
      this.currentTrick = [];
      if (this.hands.every(h => h.length === 0)) {
        this._scoreHand(events);
      } else {
        this.turn = winner.seat; // trick winner leads next
      }
    } else {
      this.turn = (this.turn + 1) % 4;
    }
    return events;
  }

  _scoreHand(events) {
    const detail = [];
    for (let t = 0; t < 2; t++) {
      const seats = this.teams[t];
      const contract = seats.reduce((s, seat) => s + this.bids[seat], 0);
      const taken = seats.reduce((s, seat) => s + this.tricksWon[seat], 0);
      let points;
      if (taken >= contract) {
        const over = taken - contract; // bags
        points = contract * 10 + over;
        if (this.options.sandbags) {
          this.bags[t] += over;
          if (this.bags[t] >= 10) { this.bags[t] -= 10; points -= 100; }
        }
        // sandbags=false: overtricks still score +1 each, but bags are
        // never tracked and the 10-bag penalty never applies.
      } else {
        points = -contract * 10;
      }
      // Nil scoring is per player, on top of the team contract.
      for (const seat of seats) {
        if (this.bids[seat] === 0) points += this.tricksWon[seat] === 0 ? 100 : -100;
      }
      this.scores[t] += points;
      detail.push({
        team: t, seats: seats.slice(), contract, taken,
        points, bags: this.bags[t], score: this.scores[t],
      });
    }
    this.handScores = detail;
    this.phase = 'hand_done';
    events.push({ type: 'hand_done', detail, scores: this.scores.slice(), bags: this.bags.slice() });

    const [a, b] = this.scores;
    const target = this.options.targetScore;
    if (a >= target || b >= target || a <= -200 || b <= -200) {
      if (a !== b) {
        this.winner = a > b ? 0 : 1;
        this.phase = 'match_done';
        events.push({ type: 'match_done', winnerTeam: this.winner, scores: this.scores.slice() });
      }
      // Exact tie at the line: play another hand.
    }
  }

  /**
   * Per-player view. Each player receives ONLY their own hand —
   * the server must never broadcast another player's cards.
   */
  getView(seat) {
    this._needSeat(seat);
    const teamTricks = [0, 1].map(t =>
      this.teams[t].reduce((s, st) => s + (this.tricksWon ? this.tricksWon[st] : 0), 0));
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      dealer: this.dealer ?? null,
      turn: this.turn ?? null,
      teams: this.teams.map(t => t.slice()),
      options: { ...this.options },
      bids: this.bids ? this.bids.slice() : null,
      teamTricks,
      scores: this.scores.slice(),
      bags: this.bags.slice(),
      spadesBroken: this.spadesBroken || false,
      trickNumber: this.trickNumber || 0,
      currentTrick: (this.currentTrick || []).map(t => ({ seat: t.seat, card: cardId(t.card) })),
      mySeat: seat,
      myTeam: this.teamOf[seat],
      myHand: this.hands ? this.hands[seat].map(cardId) : [],
      myBid: this.bids ? this.bids[seat] : null,
      handScores: this.handScores,
      winner: this.winner,
    };
  }
}

module.exports = { SpadesEngine, EngineError, cardId, parseCardId, SUITS, RANKS, validateOptions };
