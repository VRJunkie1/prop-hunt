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
import { S2C, PHASE, ROLE } from '../shared/protocol.js';
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

console.log(fails ? `\nFAILED (${fails})` : '\nAll vote-kick checks passed.');
process.exitCode = fails ? 1 : 0;
