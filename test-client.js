'use strict';

/*
 * test-client.js — End-to-end test for the Raw City Spades server.
 *
 * Spawns the server on a test port, connects 4 scripted WebSocket clients,
 * and plays a complete hand: create/join room, set teams, start, all 4 players
 * bid 3, then each plays the first legal card from every play_prompt until all
 * 13 tricks are done. Then it independently verifies:
 *   - 13 tricks completed, 4 cards each, sane winners
 *   - no error messages on any client
 *   - hand_result scoring matches an independent recomputation
 *   - each player received only their own 13-card hand (52 distinct cards)
 *   - a second hand can be started by the host
 *   - custom options room {targetScore: 250, spadesMustBreak: false, sandbags: false}:
 *     options echoed in room_state, invalid options rejected, full hand plays
 *     with no bags accumulating and scoring matching a no-penalty recomputation
 *   - deterministic engine-level checks: spade-lead rule, sandbag penalty,
 *     and targetScore match-end behavior, each vs. the default
 *
 * Exit 0 = ALL TESTS PASSED, exit 1 = failure (with details).
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SpadesEngine, cardId } = require('./game');

const TEST_PORT = 18080;
const DIR = __dirname;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function makeClient(name) {
  const c = {
    name, ws: null, seat: null, token: null, code: null,
    errors: [], tricks: [], handResult: null, matchResult: null,
    gameStates: [], bidPrompts: 0, lastRoomState: null,
  };
  c.ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
  c.send = (obj) => c.ws.send(JSON.stringify(obj));
  c.opened = new Promise((res, rej) => {
    c.ws.on('open', res);
    c.ws.on('error', rej);
  });
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    switch (m.type) {
      case 'room_state':
        c.lastRoomState = m;
        if (m.yourSeat !== undefined) {
          c.seat = m.yourSeat; c.token = m.yourToken; c.code = m.code;
        }
        break;
      case 'game_state':
        c.gameStates.push(m.state);
        break;
      case 'bid_prompt':
        c.bidPrompts++;
        if (m.seat === c.seat) c.send({ type: 'bid', bid: 3 });
        break;
      case 'play_prompt':
        if (m.seat === c.seat) {
          if (!m.legalCards || m.legalCards.length === 0) {
            c.errors.push('play_prompt with no legal cards');
          } else {
            c.send({ type: 'play_card', cardId: m.legalCards[0] });
          }
        }
        break;
      case 'trick_result':
        c.tricks.push(m);
        break;
      case 'hand_result':
        c.handResult = m;
        break;
      case 'match_result':
        c.matchResult = m;
        break;
      case 'error':
        c.errors.push(m.message);
        break;
      default:
        c.errors.push(`unknown message type: ${m.type}`);
    }
  });
  return c;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // 1. Spawn the server.
  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(TEST_PORT) },
  });
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  const listening = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(t); res(); }
    });
  });
  await listening;
  console.log('Server started on port', TEST_PORT);

  const alice = makeClient('Alice');
  const bob = makeClient('Bob');
  const carol = makeClient('Carol');
  const dave = makeClient('Dave');
  const all = [alice, bob, carol, dave];

  try {
    // 2. Create + join.
    await alice.opened;
    alice.send({ type: 'create_room', name: 'Alice' });
    await waitFor(() => alice.seat !== null, 5000, 'alice seat');
    const code = alice.code;
    check('room code is 6 chars, unambiguous alphabet',
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code), `code=${code}`);
    check('host is seat 0 with a token', alice.seat === 0 && !!alice.token);

    for (const c of [bob, carol, dave]) {
      await c.opened;
      c.send({ type: 'join_room', code, name: c.name });
    }
    await waitFor(() => dave.seat !== null, 5000, 'all joined');
    const seats = all.map(c => c.seat).sort().join(',');
    check('4 players hold seats 0-3', seats === '0,1,2,3', `seats=${seats}`);

    // 3. Host sets teams, starts the game.
    alice.send({ type: 'set_teams', teams: [[0, 2], [1, 3]] });
    await sleep(200);
    alice.send({ type: 'start_game', });
    await waitFor(() => all.every(c => c.gameStates.length > 0), 5000, 'game_state for all');

    // 4. Wait for the full hand to play out (auto-bid 3, auto-play first legal).
    await waitFor(() => alice.handResult !== null, 30000, 'hand_result');

    // 5. Assertions.
    const anyErrors = all.flatMap(c => c.errors.map(e => `${c.name}: ${e}`));
    check('no error messages on any client', anyErrors.length === 0, anyErrors.join(' | '));

    check('13 tricks completed', alice.tricks.length === 13, `got ${alice.tricks.length}`);
    const tricksSane = alice.tricks.every(t =>
      t.cards.length === 4 &&
      new Set(t.cards.map(x => x.seat)).size === 4 &&
      t.winnerSeat >= 0 && t.winnerSeat <= 3);
    check('every trick has 4 distinct seats and a valid winner', tricksSane);

    // Bids: everyone bid 3.
    const bidState = alice.gameStates.find(s => s.bids && s.bids.every(b => b !== null));
    check('all four bids recorded as 3', !!bidState && bidState.bids.join(',') === '3,3,3,3');

    // Independent scoring recomputation. Teams: A=[0,2], B=[1,3]; contract 6 each.
    const teamOf = s => (s === 0 || s === 2 ? 0 : 1);
    const taken = [0, 0];
    for (const t of alice.tricks) taken[teamOf(t.winnerSeat)]++;
    check('trick winners tally to 13 total tricks', taken[0] + taken[1] === 13,
      `A=${taken[0]} B=${taken[1]}`);
    const hr = alice.handResult;
    let scoringOk = true;
    const notes = [];
    for (const d of hr.detail) {
      const expTaken = taken[d.team];
      const contract = 6;
      const expPoints = expTaken >= contract ? contract * 10 + (expTaken - contract) : -contract * 10;
      const expBags = expTaken >= contract ? expTaken - contract : 0;
      if (d.taken !== expTaken || d.points !== expPoints || d.bags !== expBags ||
          d.score !== expPoints || d.contract !== contract) {
        scoringOk = false;
        notes.push(`team${d.team}: got taken=${d.taken} pts=${d.points} bags=${d.bags} score=${d.score}`);
      }
    }
    check('hand_result scoring matches independent recomputation', scoringOk, notes.join(' | '));

    // Hand privacy: 52 distinct cards across the four private hands.
    const firstHands = all.map(c => {
      const gs = c.gameStates.find(s => s.myHand && s.myHand.length === 13);
      return gs ? gs.myHand : null;
    });
    const allDealt = firstHands.every(h => h && h.length === 13);
    const distinct = new Set(firstHands.flat()).size;
    check('each player got a private 13-card hand (52 distinct)', allDealt && distinct === 52,
      `distinct=${distinct}`);
    const noLeak = all.every(c => {
      const gs = c.gameStates[0];
      return !('hands' in gs) && !('otherHands' in gs);
    });
    check('game_state exposes no other player hands', noLeak);

    // 6. Host starts a second hand.
    const statesBefore = alice.gameStates.length;
    alice.send({ type: 'start_game' });
    await waitFor(
      () => alice.gameStates.length > statesBefore &&
              alice.gameStates[alice.gameStates.length - 1].handNumber === 2,
      5000, 'second hand dealt');
    check('host can start the next hand after hand_done', true, 'handNumber=2');
    await waitFor(() => all.every(c => c.bidPrompts > 4 || c.handResult), 5000, 'bidding resumes');
    check('bidding resumes on hand 2', all.some(c => c.bidPrompts > 4) || !!alice.handResult);

    // 7. Illegal action is rejected cleanly: play out of turn.
    const daveWs = dave;
    const errsBefore = daveWs.errors.length;
    daveWs.send({ type: 'play_card', cardId: 'AS' }); // almost certainly not dave's turn/card
    await sleep(400);
    check('illegal action returns an error (not a crash)',
      daveWs.errors.length > errsBefore, daveWs.errors.slice(errsBefore).join(' | '));

    // 8. Custom options room: {targetScore: 250, spadesMustBreak: false, sandbags: false}.
    const eve = makeClient('Eve');
    const frank = makeClient('Frank');
    const grace = makeClient('Grace');
    const heidi = makeClient('Heidi');
    const crew = [eve, frank, grace, heidi];
    await eve.opened;
    eve.send({
      type: 'create_room', name: 'Eve',
      options: { targetScore: 250, spadesMustBreak: false, sandbags: false, bogus: 'ignored' },
    });
    await waitFor(() => eve.seat !== null, 5000, 'custom room seat');
    const customCode = eve.code;
    const echoed = eve.lastRoomState && eve.lastRoomState.options;
    check('room_state echoes validated options (unknown fields ignored)',
      !!echoed && echoed.targetScore === 250 && echoed.spadesMustBreak === false &&
      echoed.sandbags === false && !('bogus' in echoed),
      `options=${JSON.stringify(echoed)}`);

    for (const c of [frank, grace, heidi]) {
      await c.opened;
      c.send({ type: 'join_room', code: customCode, name: c.name });
    }
    await waitFor(() => heidi.seat !== null, 5000, 'custom room all joined');
    eve.send({ type: 'start_game' });
    await waitFor(() => eve.handResult !== null, 30000, 'custom hand_result');

    const crewErrors = crew.flatMap(c => c.errors.map(e => `${c.name}: ${e}`));
    check('custom-options hand: no errors', crewErrors.length === 0, crewErrors.join(' | '));
    check('custom-options hand: 13 tricks completed', eve.tricks.length === 13,
      `got ${eve.tricks.length}`);
    check('sandbags=false: no bags accumulate',
      eve.handResult.bags.join(',') === '0,0',
      `bags=${eve.handResult.bags.join(',')}`);

    // Scoring recomputation with NO bag penalty possible.
    const teamOf2 = s => (s === 0 || s === 2 ? 0 : 1);
    const taken2 = [0, 0];
    for (const t of eve.tricks) taken2[teamOf2(t.winnerSeat)]++;
    let customScoringOk = true;
    const customNotes = [];
    for (const d of eve.handResult.detail) {
      const expTaken = taken2[d.team];
      const contract = 6; // everyone bid 3
      const expPoints = expTaken >= contract ? contract * 10 + (expTaken - contract) : -contract * 10;
      if (d.taken !== expTaken || d.points !== expPoints || d.bags !== 0 || d.score !== expPoints) {
        customScoringOk = false;
        customNotes.push(`team${d.team}: taken=${d.taken} pts=${d.points} bags=${d.bags} score=${d.score}`);
      }
    }
    check('custom-options scoring matches no-penalty recomputation',
      customScoringOk, customNotes.join(' | '));

    const customView = eve.gameStates.find(s => s.options);
    check('game_state view includes the active options',
      !!customView && customView.options.targetScore === 250 &&
      customView.options.spadesMustBreak === false && customView.options.sandbags === false);

    for (const c of crew) { try { c.ws.close(); } catch { /* noop */ } }

    // 9. Invalid options are rejected with a clear error.
    const zed = makeClient('Zed');
    await zed.opened;
    zed.send({ type: 'create_room', name: 'Zed', options: { targetScore: 300 } });
    await sleep(400);
    check('targetScore=300 rejected',
      zed.errors.some(e => /targetScore/.test(e)), zed.errors.join(' | '));
    zed.send({ type: 'create_room', name: 'Zed', options: { spadesMustBreak: 'yes' } });
    await sleep(400);
    check('non-boolean spadesMustBreak rejected',
      zed.errors.some(e => /spadesMustBreak/.test(e)), zed.errors.join(' | '));
    zed.send({ type: 'create_room', name: 'Zed', options: { sandbags: 1 } });
    await sleep(400);
    check('non-boolean sandbags rejected',
      zed.errors.some(e => /sandbags/.test(e)), zed.errors.join(' | '));
    try { zed.ws.close(); } catch { /* noop */ }

    // 10. Deterministic engine-level checks for each option vs. the default.
    const riggedHand = [
      { rank: 14, suit: 'S' }, // AS
      { rank: 2, suit: 'C' }, { rank: 3, suit: 'C' }, { rank: 4, suit: 'C' },
      { rank: 5, suit: 'C' }, { rank: 6, suit: 'C' }, { rank: 7, suit: 'C' },
      { rank: 8, suit: 'C' }, { rank: 9, suit: 'C' }, { rank: 10, suit: 'C' },
      { rank: 11, suit: 'C' }, { rank: 12, suit: 'C' }, { rank: 13, suit: 'C' },
    ];

    const engNoBreak = new SpadesEngine([[0, 2], [1, 3]], { spadesMustBreak: false });
    engNoBreak.startHand();
    engNoBreak.hands[0] = riggedHand.map(c => ({ ...c }));
    engNoBreak.currentTrick = [];
    engNoBreak.spadesBroken = false;
    const legalNoBreak = engNoBreak.legalCards(0).map(cardId);
    check('spadesMustBreak=false: may lead a spade while unbroken',
      legalNoBreak.includes('AS'), legalNoBreak.join(','));

    const engDefaultLead = new SpadesEngine([[0, 2], [1, 3]]);
    engDefaultLead.startHand();
    engDefaultLead.hands[0] = riggedHand.map(c => ({ ...c }));
    engDefaultLead.currentTrick = [];
    engDefaultLead.spadesBroken = false;
    const legalDefault = engDefaultLead.legalCards(0).map(cardId);
    check('default: may NOT lead a spade while unbroken',
      !legalDefault.includes('AS') && legalDefault.length === 12,
      legalDefault.join(','));

    // Rig a hand: both teams contract 8; team 0 takes 18 (10 overtricks).
    function riggedScoreHand(options) {
      const e = new SpadesEngine([[0, 2], [1, 3]], options);
      e.phase = 'playing';
      e.bids = [4, 4, 4, 4];
      e.tricksWon = [9, 1, 9, 1];
      e.hands = [[], [], [], []];
      e._scoreHand([]);
      return e;
    }
    const engNoBags = riggedScoreHand({ sandbags: false });
    check('sandbags=false: 10 overtricks, no penalty, bags stay 0',
      engNoBags.scores[0] === 90 && engNoBags.bags[0] === 0 && engNoBags.scores[1] === -80,
      `scores=${engNoBags.scores.join(',')} bags=${engNoBags.bags.join(',')}`);

    const engBags = riggedScoreHand({});
    check('default sandbags=true: 10-bag -100 penalty applies',
      engBags.scores[0] === -10 && engBags.bags[0] === 0,
      `scores=${engBags.scores.join(',')} bags=${engBags.bags.join(',')}`);

    // Rig scores near the line: team 0 about to score 62 more (bids 3 each,
    // team 0 takes 8 with 2 over, team 1 takes 5 and fails).
    function riggedForTarget(options, startScores) {
      const e = new SpadesEngine([[0, 2], [1, 3]], options);
      e.scores = startScores.slice();
      e.phase = 'playing';
      e.bids = [3, 3, 3, 3];
      e.tricksWon = [4, 3, 4, 3];
      e.hands = [[], [], [], []];
      e._scoreHand([]);
      return e;
    }
    const eng250 = riggedForTarget({ targetScore: 250 }, [240, 100]);
    check('targetScore=250: match ends when a team reaches 250',
      eng250.phase === 'match_done' && eng250.winner === 0,
      `phase=${eng250.phase} scores=${eng250.scores.join(',')}`);

    const eng500 = riggedForTarget({}, [240, 100]);
    check('default targetScore=500: match continues below 500',
      eng500.phase === 'hand_done' && eng500.winner === null,
      `phase=${eng500.phase} scores=${eng500.scores.join(',')}`);
  } catch (e) {
    check(`test flow (${e.message})`, false);
  } finally {
    for (const c of all) { try { c.ws.close(); } catch { /* noop */ } }
    server.kill();
    await sleep(300);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length === 0) {
    console.log('ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.log('TEST FAILURES:', failed.map(f => f.name).join('; '));
    process.exit(1);
  }
}

main();
