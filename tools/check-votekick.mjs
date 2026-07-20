#!/usr/bin/env node
// tools/check-votekick.mjs — acceptance guard for the VOTE-KICK system (VRmike spec, #devbot 2026-07-19).
// Player-driven removal of an AFK/problem player — the human replacement for the retired automatic
// AFK-boot. Host-authoritative. This drives the PURE (Rapier-free) referee vote-kick brain + the pure
// input hotkey matcher and asserts the whole spec:
//
//   A) LIFECYCLE — start (initiator auto-YES) → votes → majority YES of votes cast kicks the target
//      (via the SAME removePlayer cleanup path as a leaver, plus a private "kicked" notice + a public
//      leave line); a tie / majority NO keeps them (+ the per-target post-fail button cooldown).
//   B) ONE-AT-A-TIME — a second start request while a vote runs is refused (voteKickDenied); the
//      running vote is untouched.
//   C) COOLDOWN — a NEW vote against a just-survived target is refused for voteKickCooldownSeconds
//      (others are votable immediately); it opens again once the cooldown elapses.
//   D) EARLY RESOLUTION — the instant every eligible voter has cast, the vote resolves without the timer.
//   E) TIMER RESOLUTION — an untouched vote resolves when the countdown expires (_tickVoteKick).
//   F) TARGET-LEAVES — the target leaving mid-vote cancels the vote quietly; a VOTER leaving shrinks the
//      electorate so early resolution still fires.
//   G) GUARDS — no self-target, no host-target, active-round only.
//   H) SNAPSHOT — the live tally rides EVERY snapshot variant (incl. the blindfolded-hunter one).
//   I) HOTKEY — matchVoteKey matches the PHYSICAL key (e.code) IGNORING modifier state, so a Shift-held
//      Y/N still registers (a sprinting player never loses their vote).
//
// AUTHORING-ONLY, never shipped. Rapier-free (the vote-kick logic is pure referee + pure input). Run:
//     node tools/check-votekick.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C2S, S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';
import { matchVoteKey } from '../js/input.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// ── Referee harness (mirrors check-lifecycle): captured mailbox per player, physics STUBBED so the
//    round launch is Rapier-free. The vote-kick logic is entirely physics-free, so this covers it.
function makeRef() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
  ref._buildPhysics = async () => {}; // no Rapier in the sandbox; vote-kick is physics-free
  const inbox = new Map();
  const mk = (id, role) => {
    inbox.set(id, []);
    return {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
      lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false }, _lastSeen: Date.now(),
      send: (obj) => inbox.get(id).push(obj),
    };
  };
  const add = (id, role) => { const p = mk(id, role); ref.players.set(id, p); if (!ref.hostId) ref.hostId = id; return p; };
  const msgs = (id) => inbox.get(id) || [];
  const events = (id, kind) => msgs(id).filter((m) => m.t === S2C.EVENT && m.kind === kind);
  const logs = (id) => events(id, 'log').map((m) => m.text);
  const lastSnap = (id) => { const s = msgs(id).filter((m) => m.t === S2C.SNAPSHOT); return s[s.length - 1] || null; };
  const launchHunting = () => { ref._launchRound(); ref.phase = PHASE.HUNTING; ref.phaseEndsAt = Date.now() + 300000; };
  // Convenience: route a start / cast through the referee's public methods with the player OBJECT.
  const start = (initiatorId, targetId) => ref.startVoteKick(ref.players.get(initiatorId), targetId);
  const cast = (voterId, yes) => ref.castVote(ref.players.get(voterId), yes);
  return { ref, add, msgs, events, logs, lastSnap, launchHunting, start, cast };
}

console.log('VOTE-KICK — player-driven kick system: acceptance check');

// ===========================================================================
// A) LIFECYCLE — start → votes → majority kick / tie no-kick.
// ===========================================================================
console.log('\nA) lifecycle — majority YES kicks (leaver cleanup); tie / majority NO keeps (+ cooldown)');

// A1 — majority YES → the target is KICKED via the leaver path, with a private notice + public log.
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER); // host
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP);     // the target
  t.add('P3', ROLE.PROP);
  t.launchHunting();
  t.start('P1', 'P2'); // P1 opens a vote to kick P2 (P1 is an automatic YES)
  ok(!!t.ref.voteKick && t.ref.voteKick.targetId === 'P2', 'a vote opens against the target');
  ok(t.ref.voteKick.votes.get('P1') === true, 'the initiator counts as an automatic YES');
  ok(t.logs('P3').some((x) => /started a vote to kick P2/.test(x)), 'a public "started a vote" line is broadcast');
  t.cast('HOST', true);  // 2 yes
  t.cast('P3', true);    // 3 yes
  ok(t.ref.players.has('P2'), 'not resolved yet — the target hasn\'t voted and the timer hasn\'t elapsed');
  t.cast('P2', false);   // everyone has now voted → early resolve: 3 yes, 1 no → kick
  ok(!t.ref.voteKick, 'the vote is cleared after resolution');
  ok(!t.ref.players.has('P2'), 'majority YES → the target is REMOVED (same path as a leaver)');
  ok(t.events('P2', 'kicked').length === 1, 'the kicked player gets a private "kicked" notice');
  ok(t.logs('P3').some((x) => /P2 left \(vote-kicked\)/.test(x)), 'a public "X left (vote-kicked)" leave line fires');
  ok(t.events('P3', 'voteKickResult').some((m) => m.kicked === true && m.target === 'P2'), 'a voteKickResult(kicked) is broadcast to everyone');
  t.ref.destroy();
}

// A2 — TIE → the target STAYS and their button goes on the per-target cooldown.
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.launchHunting();       // electorate = {HOST, P1, P2}
  t.start('P1', 'P2');     // P1 auto-yes (1 yes)
  t.cast('HOST', false);   // 1 no
  t.cast('P2', false);     // everyone voted → 1 yes, 2 no → majority NO → stay
  ok(!t.ref.voteKick && t.ref.players.has('P2'), 'majority NO → the target stays');
  ok(t.events('HOST', 'voteKickResult').some((m) => m.kicked === false && m.target === 'P2'), 'a voteKickResult(not kicked) is broadcast');
  ok((t.ref._voteKickCooldownUntil.get('P2') || 0) > Date.now(), 'the survived target gets a per-target post-fail cooldown');
  t.ref.destroy();
}

// A3 — a lone AFK target (never votes) is kicked on the timer by the initiator's YES (the point of the
//      feature — removing someone who isn't responding). "majority YES of votes CAST" = 1 yes, 0 no.
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('AFK', ROLE.PROP); // target, never votes
  t.launchHunting();
  t.start('HOST', 'AFK');  // HOST auto-yes; AFK stays silent
  ok(!!t.ref.voteKick, 'the vote is still open (AFK hasn\'t voted, timer not elapsed)');
  t.ref._tickVoteKick(t.ref.voteKick.endsAt + 1); // countdown expires
  ok(!t.ref.players.has('AFK'), 'timer expiry with 1 yes / 0 no → the AFK target is kicked');
  t.ref.destroy();
}

// ===========================================================================
// B) ONE-AT-A-TIME — a second vote game-wide is refused.
// ===========================================================================
console.log('\nB) concurrency — only ONE vote-kick active game-wide');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP);
  t.add('P3', ROLE.PROP);
  t.launchHunting();
  t.start('P1', 'P2'); // vote 1 opens
  const before = t.ref.voteKick;
  t.start('P3', 'P1'); // a second start request while one runs
  ok(t.ref.voteKick === before && t.ref.voteKick.targetId === 'P2', 'a second start request is refused — the running vote is untouched');
  ok(t.events('P3', 'voteKickDenied').length === 1, 'the refused initiator gets a private voteKickDenied');
  t.ref.destroy();
}

// ===========================================================================
// C) COOLDOWN — a failed target is un-votable for the cooldown; others are free immediately.
// ===========================================================================
console.log('\nC) cooldown — a FAILED target is on a per-target cooldown; other players usable at once');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // will survive a vote
  t.add('P3', ROLE.PROP);
  t.launchHunting();
  // Fail a vote against P2.
  t.start('P1', 'P2');
  t.cast('HOST', false); t.cast('P3', false); t.cast('P2', false); // 1 yes, 3 no → stays
  ok(t.ref.players.has('P2') && !t.ref.voteKick, 'P2 survived the first vote');
  // A NEW vote against P2 immediately is refused (cooldown).
  t.start('P1', 'P2');
  ok(!t.ref.voteKick, 'a new vote against the just-survived target is REFUSED (per-target cooldown)');
  ok(t.events('P1', 'voteKickDenied').length >= 1, 'the initiator is told why (voteKickDenied)');
  // But a vote against a DIFFERENT player opens right away.
  t.start('P1', 'P3');
  ok(!!t.ref.voteKick && t.ref.voteKick.targetId === 'P3', 'another player is votable immediately (cooldown is per-target)');
  // Clear that vote, then expire P2's cooldown → a vote against P2 works again.
  t.cast('HOST', false); t.cast('P2', false); t.cast('P3', false); // resolve the P3 vote (any way)
  t.ref._voteKickCooldownUntil.set('P2', Date.now() - 1); // cooldown elapsed
  t.ref._voteKickCooldownUntil.set('P3', Date.now() - 1);
  t.start('P1', 'P2');
  ok(!!t.ref.voteKick && t.ref.voteKick.targetId === 'P2', 'once the cooldown elapses the target is votable again');
  t.ref.destroy();
}

// ===========================================================================
// D) EARLY RESOLUTION — resolves the instant every eligible voter has cast (no timer wait).
// ===========================================================================
console.log('\nD) early resolution — resolves the moment everyone eligible has voted');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.launchHunting();
  t.start('P1', 'P2'); // P1 auto-yes
  const endsAt = t.ref.voteKick.endsAt;
  t.cast('HOST', true); // 2 yes
  t.cast('P2', true);   // all 3 voted → early resolve WITHOUT reaching endsAt
  ok(!t.ref.voteKick && !t.ref.players.has('P2'), 'the vote resolved early (all voted) — the target is kicked');
  ok(Date.now() < endsAt, 'resolution happened before the countdown would have expired');
  t.ref.destroy();
}

// ===========================================================================
// E) TIMER RESOLUTION — an untouched vote resolves when the window expires.
// ===========================================================================
console.log('\nE) timer resolution — resolves on countdown expiry');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.launchHunting();
  t.start('P1', 'P2');   // 1 yes only; nobody else votes
  t.ref._tickVoteKick(t.ref.voteKick.endsAt - 500); // still within the window
  ok(!!t.ref.voteKick, 'a vote inside its window is NOT resolved by the tick');
  t.ref._tickVoteKick(t.ref.voteKick.endsAt + 1);   // window elapsed
  ok(!t.ref.voteKick, 'the vote resolves once the countdown expires');
  t.ref.destroy();
}

// ===========================================================================
// F) TARGET-LEAVES / VOTER-LEAVES.
// ===========================================================================
console.log('\nF) departures — target leaving cancels; a voter leaving shrinks the electorate');

// F1 — the TARGET leaves mid-vote → the vote cancels quietly (a cancelled result, no kick).
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.launchHunting();
  t.start('P1', 'P2');
  t.ref.removePlayer('P2'); // the target leaves on their own
  ok(!t.ref.voteKick, 'the target leaving cancels the vote');
  ok(t.events('HOST', 'voteKickResult').some((m) => m.cancelled === true), 'a cancelled voteKickResult is broadcast');
  t.ref.destroy();
}

// F2 — a VOTER leaves → the electorate shrinks so the remaining votes can early-resolve.
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.add('P3', ROLE.PROP); // will leave without voting
  t.launchHunting();       // electorate = {HOST, P1, P2, P3}
  t.start('P1', 'P2');     // P1 auto-yes
  t.cast('HOST', true);    // 2 yes; P2 + P3 haven't voted (size 2 < 4)
  ok(!!t.ref.voteKick, 'not yet resolved (P2 + P3 still owe votes)');
  t.ref.removePlayer('P3'); // P3 leaves → electorate {HOST,P1,P2}
  ok(!!t.ref.voteKick, 'still open — P2 still owes a vote');
  t.cast('P2', false);      // now everyone left has voted → resolve (2 yes, 1 no) → kick
  ok(!t.ref.voteKick && !t.ref.players.has('P2'), 'the shrunk electorate early-resolves correctly');
  t.ref.destroy();
}

// ===========================================================================
// G) GUARDS — no self / host target, active-round only.
// ===========================================================================
console.log('\nG) guards — no self-kick, no host-kick, active-round only');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.launchHunting();
  t.start('P1', 'P1'); // self
  ok(!t.ref.voteKick, 'you cannot vote-kick yourself');
  t.start('P1', 'HOST'); // host = the server
  ok(!t.ref.voteKick, 'you cannot vote-kick the host (the host IS the server)');
  ok(t.events('P1', 'voteKickDenied').length >= 1, 'the host-target attempt is explained (voteKickDenied)');
  t.ref.destroy();
}
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  // No launch — still in LOBBY.
  t.start('HOST', 'P1');
  ok(!t.ref.voteKick, 'no votes can start in the LOBBY (active round only)');
  t.ref.destroy();
}

// ===========================================================================
// H) SNAPSHOT — the live tally rides every snapshot variant.
// ===========================================================================
console.log('\nH) snapshot — the live tally rides every snapshot (incl. the blindfolded-hunter variant)');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.launchHunting();
  t.start('P1', 'P2');
  t.cast('HOST', true); // 2 yes; P2 waiting
  t.ref.broadcastSnapshot();
  const snapProp = t.lastSnap('P1');
  ok(snapProp && snapProp.voteKick && snapProp.voteKick.target === 'P2', 'a prop\'s snapshot carries the vote tally');
  ok(snapProp.voteKick.yes === 2 && snapProp.voteKick.no === 0 && snapProp.voteKick.waiting === 1, 'the tally counts are correct (2 yes, 0 no, 1 waiting)');
  ok(Array.isArray(snapProp.voteKick.voters) && snapProp.voteKick.voters.includes('P1'), 'the electorate (voters) rides along so a client can tell if it is eligible');
  ok(typeof snapProp.voteKick.timeLeft === 'number', 'the countdown (timeLeft) rides the snapshot');
  // The blindfolded-hunter variant: put the round in HIDING so HOST gets the blindfold snapshot.
  t.ref.phase = PHASE.HIDING;
  t.ref.broadcastSnapshot();
  const snapHunter = t.lastSnap('HOST');
  ok(snapHunter && snapHunter.voteKick && snapHunter.voteKick.target === 'P2', 'the blindfolded-hunter snapshot ALSO carries the vote tally (no position data lost)');
  // Idle → null.
  t.ref.phase = PHASE.HUNTING;
  t.ref._cancelVoteKick();
  t.ref.broadcastSnapshot();
  const snapIdle = t.lastSnap('P1');
  ok(snapIdle && snapIdle.voteKick === null, 'with no vote running the snapshot carries voteKick:null');
  t.ref.destroy();
}

// ===========================================================================
// I) HOTKEY — matchVoteKey matches the physical key IGNORING modifier state.
// ===========================================================================
// ===========================================================================
// J) VOTE CHANGE — an elector may FLIP their pick before the vote resolves. The initiator starts on an
//    automatic YES but can switch to NO and just watch (VRmike, 2026-07-20). A re-cast OVERWRITES the
//    previous pick — it never adds a second vote, so early resolution (votes.size ≥ electorate) is intact.
// ===========================================================================
console.log('\nJ) vote change — an elector (incl. the initiator) can flip their pick before resolution');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP); // target
  t.add('P3', ROLE.PROP);
  t.launchHunting();       // electorate = {HOST, P1, P2, P3}
  t.start('P1', 'P2');     // P1 is the initiator = auto-YES
  ok(t.ref.voteKick.votes.get('P1') === true, 'the initiator starts on an automatic YES');
  const sizeBefore = t.ref.voteKick.votes.size;
  t.cast('P1', false);     // the initiator flips to NO
  ok(t.ref.voteKick && t.ref.voteKick.votes.get('P1') === false, 'the initiator can flip their pick to NO');
  ok(t.ref.voteKick.votes.size === sizeBefore, 'flipping OVERWRITES the pick — it never adds a second vote');
  ok(!!t.ref.voteKick, 'flipping does NOT trigger premature resolution (others still owe a vote)');
  // A regular voter can flip too, and the live tally reflects it.
  t.cast('P3', true);      // P3 → YES
  t.cast('P3', false);     // P3 changes their mind → NO
  ok(t.ref.voteKick.votes.get('P3') === false, 'a regular elector can also change their pick');
  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('HOST');
  ok(snap && snap.voteKick.yes === 0 && snap.voteKick.no === 2, 'the flipped picks ride the live snapshot tally (0 yes, 2 no)');
  t.ref.destroy();
}

console.log('\nI) hotkey — Y/N matched by physical key, modifier-independent (Shift-held still votes)');
ok(matchVoteKey({ code: 'KeyY' }) === true, 'Y (KeyY) → yes');
ok(matchVoteKey({ code: 'KeyN' }) === false, 'N (KeyN) → no');
ok(matchVoteKey({ code: 'KeyY', shiftKey: true }) === true, 'Shift+Y still registers as YES (modifier ignored)');
ok(matchVoteKey({ code: 'KeyN', shiftKey: true, ctrlKey: true, altKey: true }) === false, 'Shift+Ctrl+Alt+N still registers as NO (all modifiers ignored)');
ok(matchVoteKey({ code: 'KeyY', key: 'Y' }) === true, 'matches on e.code, so an upper-case e.key from Shift does not break it');
ok(matchVoteKey({ code: 'KeyA' }) === null, 'an unrelated key is null (no false positive)');
ok(matchVoteKey(null) === null, 'a null event is handled safely');
// STATIC: the handler must NOT gate the vote on modifier state (that would eat a Shift-held vote).
{
  const src = readFileSync(join(root, 'js', 'input.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function matchVoteKey'), src.indexOf('export function matchVoteKey') + 400);
  ok(/e\.code === 'KeyY'/.test(fn) && /e\.code === 'KeyN'/.test(fn), 'matchVoteKey keys off e.code (the physical key)');
  ok(!/shiftKey|ctrlKey|altKey|metaKey/.test(fn), 'matchVoteKey never consults a modifier flag (modifier-independent by construction)');
}

// ===========================================================================
// K) INITIATE FROM A CLIENT CLICK — the exact path build #210 regressed. A scoreboard "vote kick" click
//    sends C2S.START_VOTEKICK{target} to the host; the host must OPEN a vote (initiator auto-YES) and the
//    live banner must ride the NEXT snapshot to EVERY player — the initiator INCLUDED. The prior checks
//    all called ref.startVoteKick / ref.castVote DIRECTLY, so they never exercised the message routing an
//    actual click travels through — which is why #210 shipped with the click dead. Here we drive the real
//    router (ref.handleMessage) with the literal message ui.onVoteKick sends. The DOM click layer (the
//    button node must stay put across ~15 Hz scoreboard refreshes) is guarded statically in L.
// ===========================================================================
console.log('\nK) initiate from a client START_VOTEKICK message — opens the vote + banner for everyone');
{
  const t = makeRef();
  t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);   // the initiator (a guest clicking "vote kick" on the target's row)
  t.add('P2', ROLE.PROP);   // the target
  t.launchHunting();
  ok(!t.ref.voteKick, 'no vote is running before the click (this is the FIRST click, not a vote change)');
  // The exact message a scoreboard "vote kick" click sends: js/main.js ui.onVoteKick -> session.send.
  t.ref.handleMessage('P1', { t: C2S.START_VOTEKICK, target: 'P2' });
  ok(!!t.ref.voteKick && t.ref.voteKick.targetId === 'P2', 'the START_VOTEKICK message OPENS a vote against the target');
  ok(t.ref.voteKick.initiatorId === 'P1' && t.ref.voteKick.votes.get('P1') === true, 'the initiator is recorded as the auto-YES');
  // The banner (live tally) must ride the very next snapshot to EVERYONE — initiator included.
  t.ref.broadcastSnapshot();
  for (const who of ['P1', 'HOST', 'P2']) {
    const snap = t.lastSnap(who);
    ok(snap && snap.voteKick && snap.voteKick.target === 'P2', `${who} gets the vote banner in their snapshot`);
    ok(Array.isArray(snap.voteKick.voters) && snap.voteKick.voters.includes(who), `${who} is in the electorate (eligible to vote)`);
  }
  const initSnap = t.lastSnap('P1');
  ok(initSnap.voteKick.yes === 1 && initSnap.voteKick.no === 0, "the initiator's banner shows their auto-YES (1 yes, 0 no)");
  // And a live vote via the message router still resolves (the change path from #210 stays intact).
  t.ref.handleMessage('HOST', { t: C2S.CAST_VOTE, vote: true });
  t.ref.handleMessage('P2', { t: C2S.CAST_VOTE, vote: false }); // all cast -> early resolve (2 yes, 1 no) -> kick
  ok(!t.ref.voteKick && !t.ref.players.has('P2'), 'casts via the message router still tally + resolve (2 yes, 1 no -> kick)');
  t.ref.destroy();
}

// ===========================================================================
// L) DOM CLICK-TARGET STABILITY (static) — the #210 regression was purely client-side: updatePauseScoreboard
//    blew the whole list away (`innerHTML = ''`) and recreated every row — INCLUDING the vote-kick <button> —
//    on every ~15 Hz snapshot refresh, so a click that outlasted one frame had its button torn out between
//    mousedown and mouseup and never fired. Guard that the scoreboard now reconciles rows IN PLACE (keyed)
//    so the click target is stable, and still wires the onVoteKick handler.
// ===========================================================================
console.log('\nL) client scoreboard reconciles rows in place (the vote-kick button stays clickable across refreshes)');
{
  const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const s = src.indexOf('updatePauseScoreboard(');
  const fn = src.slice(s, src.indexOf('VOTE-KICK banner', s)); // the function body (up to the next method's doc)
  ok(s >= 0 && fn.length > 0, 'found updatePauseScoreboard for inspection');
  ok(/_psRows/.test(fn), 'keeps a keyed row cache (_psRows) so row + button nodes are REUSED across refreshes');
  ok(/insertBefore/.test(fn), 'rows are reordered in place (insertBefore MOVES nodes) rather than destroyed + recreated');
  ok(/addEventListener\('click'/.test(fn), 'the vote-kick button still wires an onVoteKick click handler');
  // The only innerHTML reset allowed is the empty-roster branch — never a per-refresh blanket wipe.
  const wipes = (fn.match(/innerHTML\s*=\s*''/g) || []).length;
  ok(wipes <= 1, `no per-refresh blanket list wipe (found ${wipes}; only the empty-roster path may keep one)`);
}

// ===========================================================================
// M) VOTE-KICK BANNER PLACEMENT (static, QoL pack 2026-07-20, VRmike) — the banner used to sit at a fixed
//    62px and OVERLAP the props' taunt button (top 88px) + its red stop button (top 140px) on PC, making
//    it unreadable. It must now anchor BELOW the entire top-of-screen strip — never overlapping any top UI
//    element at any width. We parse the shipped CSS and assert the banner's top clears the LOWEST fixed top
//    element (the taunt-stop button: top + its min-height).
// ===========================================================================
console.log('\nM) vote-kick banner sits BELOW all top-of-screen UI (never overlaps the taunt button/HUD)');
{
  const css = readFileSync(join(root, 'css', 'style.css'), 'utf8');
  const topPx = (sel) => {
    // first `top: <n>px` or `top: calc(<n>px ...)` inside the given rule block
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*?top:\\s*(?:calc\\(\\s*)?(\\d+)px');
    const m = re.exec(css);
    return m ? parseInt(m[1], 10) : null;
  };
  const minH = (() => { const m = /\.taunt-btn,\s*\.taunt-stop-btn\s*\{[^}]*?min-height:\s*(\d+)px/.exec(css); return m ? parseInt(m[1], 10) : 46; })();
  const vk = topPx('.votekick');
  const tauntBtn = topPx('.taunt-btn');
  const tauntStop = topPx('.taunt-stop-btn');
  ok(vk != null && tauntBtn != null && tauntStop != null, `parsed banner + taunt tops (banner=${vk}, taunt=${tauntBtn}, stop=${tauntStop})`);
  ok(vk >= tauntBtn + minH, `banner (${vk}px) clears the taunt button bottom (${tauntBtn}+${minH}=${tauntBtn + minH}px)`);
  ok(vk >= tauntStop + minH, `banner (${vk}px) clears the taunt STOP button bottom (${tauntStop}+${minH}=${tauntStop + minH}px)`);
  // The old overlapping absolute positions must be gone (62px fixed, and the 108px narrow-screen override).
  ok(!/\.votekick\s*\{[^}]*top:\s*62px/.test(css), 'the old fixed 62px banner top (which overlapped the taunt button) is gone');
  ok(!/\.votekick\s*\{\s*top:\s*108px/.test(css), 'the old 108px narrow-screen override (still overlapping) is gone');
}

// ===========================================================================
// N) MID-GAME NAME EDIT SURVIVES THE ~15 Hz SNAPSHOT REFRESH (static, QoL pack 2026-07-20, VRmike). Since
//    build #213 the scoreboard reuses rows and redraws ~15×/s from snapshots. The inline rename box must
//    survive that: while it's open the refresh must NOT overwrite the name cell (which holds the <input>).
//    Guard the mechanism statically — the case VRmike explicitly warned about.
// ===========================================================================
console.log('\nN) pause-scoreboard rename box survives a snapshot refresh (edit state guards the name cell)');
{
  const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const s = src.indexOf('updatePauseScoreboard(');
  const defAt = src.indexOf('_beginNameEdit(row, id)'); // the METHOD definition (not the call site)
  const fn = src.slice(s, defAt); // just the refresh function (up to the editor method)
  ok(s >= 0 && defAt > s && fn.length > 0, 'found updatePauseScoreboard for inspection');
  // The refresh must SKIP writing the name cell while THIS row is being edited (guarded by _psEditId).
  ok(/_psEditId/.test(fn), 'the refresh consults the edit-in-progress marker (_psEditId)');
  ok(/if\s*\(!\(isSelf && this\._psEditId === p\.id\)\)/.test(fn), 'the name cell is only rewritten when NOT editing this row (survives the refresh)');
  ok(/ps-self-row/.test(fn) && /ps-editable/.test(fn), 'your own row is highlighted + made click-to-edit');

  // The editor itself: commits via onRename, cancels on Esc, and stops key propagation so Esc/typing
  // never leaks to the game/pause handlers on window.
  const edit = src.slice(defAt, src.indexOf('setVoteKick(', defAt));
  ok(edit.length > 0, 'found _beginNameEdit for inspection');
  ok(/this\.onRename\(/.test(edit), 'committing relays the rename via onRename (host validates + de-dupes)');
  ok(/stopPropagation\(\)/.test(edit), 'the editor stops key propagation (Esc cancels the edit, not the pause menu)');
  ok(/Escape/.test(edit) && /cancelled\s*=\s*true/.test(edit), 'Esc cancels the edit');
  ok(/'Enter'|"Enter"/.test(edit), 'Enter commits (blur → commit)');
  ok(/this\._psEditId = null/.test(edit), 'commit/cancel clears _psEditId so the refresh resumes rendering the name');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll vote-kick checks passed.');
process.exitCode = fails ? 1 : 0;
