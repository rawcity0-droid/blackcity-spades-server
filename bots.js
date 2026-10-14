/**
 * bots.js — server-side computer players for online tables.
 *
 * When an online table starts with fewer than 4 humans, empty seats are
 * filled with bots so a 2- or 3-player crew can still play. Bots bid and
 * play through the same SpadesEngine methods as humans — they're just
 * seats with isBot=true and no websocket.
 *
 * The AI is a straightforward heuristic: sensible bids, follow-suit,
 * don't waste winners when partner is taking the trick, win cheap when
 * opponents are ahead, dump low otherwise. Good enough for a casual game.
 */
const { cardId } = require('./game.js');

const RANKS = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };

/** Does `card` beat `winCard` given the led suit? */
function beats(card, winCard, ledSuit) {
  if (card.suit === 'S' && winCard.suit !== 'S') return true;
  if (card.suit !== 'S' && winCard.suit === 'S') return false;
  if (card.suit !== winCard.suit) return false; // void off-suit can't win
  void ledSuit;
  return card.rank > winCard.rank;
}

/** Pick a bid for the bot's hand. Never nil — keeps it simple and sane. */
function chooseBotBid(engine, seat) {
  const hand = engine.hands[seat];
  let pts = 0;
  const suitLen = {};
  for (const c of hand) {
    suitLen[c.suit] = (suitLen[c.suit] || 0) + 1;
    if (c.rank === 14) pts += 1;
    else if (c.rank === 13) pts += 0.6;
    else if (c.rank === 12) pts += 0.3;
    if (c.suit === 'S') pts += c.rank >= 11 ? 0.5 : 0.2;
  }
  // Short side suits + spades = ruffing value.
  for (const s of ['H', 'D', 'C']) {
    if ((suitLen[s] || 0) <= 1 && (suitLen['S'] || 0) >= 2) pts += 0.5;
  }
  return Math.max(2, Math.min(6, Math.round(pts)));
}

/** Pick a card id for the bot to play. */
function chooseBotCard(engine, seat) {
  const legal = engine.legalCards(seat);
  if (legal.length === 1) return cardId(legal[0]);
  const trick = engine.currentTrick;
  const lowFirst = (a, b) => a.rank - b.rank;

  if (trick.length === 0) {
    // Leading: lowest card of the longest non-spade suit (don't lead spades
    // unless that's all we hold — legalCards already enforces break rules).
    const nonSpades = legal.filter(c => c.suit !== 'S');
    const pool = nonSpades.length ? nonSpades : legal;
    const bySuit = {};
    for (const c of pool) (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
    let longest = pool;
    for (const s of Object.keys(bySuit)) {
      if (bySuit[s].length > longest.length) longest = bySuit[s];
    }
    return cardId(longest.slice().sort(lowFirst)[0]);
  }

  const ledSuit = trick[0].card.suit;
  let winCard = trick[0].card;
  let winSeat = trick[0].seat;
  for (const p of trick.slice(1)) {
    if (beats(p.card, winCard, ledSuit)) { winCard = p.card; winSeat = p.seat; }
  }
  const partnerWinning =
    engine.teamOf[winSeat] !== undefined && engine.teamOf[winSeat] === engine.teamOf[seat];

  if (partnerWinning) {
    // Partner's got it — don't waste a winner.
    return cardId(legal.slice().sort(lowFirst)[0]);
  }
  // Win as cheaply as possible: prefer taking with the led suit over
  // wasting a spade.
  const winners = legal.filter(c => beats(c, winCard, ledSuit));
  if (winners.length) {
    winners.sort((a, b) =>
      (a.suit === 'S' ? 100 + a.rank : a.rank) - (b.suit === 'S' ? 100 + b.rank : b.rank));
    return cardId(winners[0]);
  }
  // Can't win — dump the lowest.
  return cardId(legal.slice().sort(lowFirst)[0]);
}

module.exports = { chooseBotBid, chooseBotCard, RANKS };
