#!/usr/bin/env node
// tools/check-round-flip-blindfold.mjs — B8 (2026-07-18, VRmike): ROUND-2 PERMANENT BLINDFOLD guard.
// AUTHORING-ONLY, never shipped. Run:  node tools/check-round-flip-blindfold.mjs
//
// WHY THIS EXISTS. Playtesters reported the hunter was "permanently blindfolded / unspawned on ROUND 2"
// — reproduces every time, round 2 broken. The blindfold has three cooperating halves (see
// notes/anti-cheat-blindfold.md): a client VISUAL overlay + look-freeze, and a server DATA gate that
// withholds prop positions. B6 (spectator mode) widened the server gate to withhold data from DEAD
// players too, so a prime suspect was a player still flagged dead from round 1 being starved of data —
// or the release racing the flip. This check drives the REAL shared referee through the FULL round-flip
// lifecycle a headless page boot never exercises, and asserts the blindfold RELEASES on round 2:
//   S1) round 1 -> a prop is CAUGHT (dies, becomes a spectator) -> hunters win -> ENDING
//   S2) ENDING -> startFlippedRound() flips teams -> round 2 (the dead prop is now the HUNTER)
//   S3) round 2 HIDING: the new hunter is ALIVE on the server + correctly blindfolded (prop data withheld)
//   S4) round 2 HUNTING: the new hunter gets the one-time world catch-up AND full prop data (RELEASED)
//   S5) a faithful client-side blindfold reducer over the captured message stream ends RELEASED
//       (blind=false, look unfrozen, not spectating, spawned) — not stuck on.
// Plus a no-death flip path (round 1 ends by timer) and a static guard for the client STARTED reset.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('ROUND-FLIP BLINDFOLD: round-2 release acceptance check (B8)');

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// ---- shared harness: a real referee with a captured mailbox per player. Physics stubbed (Rapier-free,
// deterministic) — we only assert referee OUTPUTS (alive/role/snapshots/events), not the async world.
function makeRef() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
  ref._buildPhysics = async () => {};
  const inbox = new Map();
  const add = (id, role) => {
    inbox.set(id, []);
    const p = {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
      lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false },
      send: (obj) => inbox.get(id).push(obj),
    };
    ref.players.set(id, p);
    if (!ref.hostId) ref.hostId = id;
    return p;
  };
  const take = (id) => { const m = inbox.get(id); inbox.set(id, []); return m; };
  return { ref, add, take };
}

// A FAITHFUL model of the client blindfold-relevant state (mirrors js/main.js: updateBlindfold derives
// blind = role===HUNTER && phase===HIDING; ROLE sets alive+role; the STARTED reset clears blindfold +
// spectator; onSnapshot converges role/alive and enters/leaves spectator). Fed the exact captured stream.
function makeClient(id) {
  return { id, role: null, phase: PHASE.LOBBY, alive: true, spawned: false, blind: false, lookFrozen: false, spectating: false };
}
function clientApply(c, msg) {
  if (msg.t === S2C.ROLE) { c.alive = true; c.role = msg.role; }
  else if (msg.t === S2C.STARTED) {
    // main.js STARTED handler resets stale transient view-state at a fresh round (B8 hardening).
    c.spawned = false; c.blind = false; c.lookFrozen = false; c.spectating = false;
  } else if (msg.t === S2C.EVENT && msg.kind === 'phase') {
    c.phase = msg.phase;
    c.blind = c.role === ROLE.HUNTER && c.phase === PHASE.HIDING;
    c.lookFrozen = c.blind;
  } else if (msg.t === S2C.SNAPSHOT) {
    c.phase = msg.phase;
    const me = msg.players.find((p) => p.id === c.id);
    if (me) {
      c.role = me.hunter ? ROLE.HUNTER : ROLE.PROP;
      c.alive = me.alive !== false;
      const activePhase = msg.phase === PHASE.HIDING || msg.phase === PHASE.HUNTING;
      c.spectating = !c.alive && activePhase;
      if (!c.spawned) c.spawned = true;
    }
    c.blind = c.role === ROLE.HUNTER && c.phase === PHASE.HIDING;
    c.lookFrozen = c.blind;
  }
  return c;
}
const drain = (t, id, c) => { for (const m of t.take(id)) clientApply(c, m); };

// ---------------------------------------------------------------------------
// SCENARIO A — a caught prop (dead spectator) becomes the round-2 HUNTER. Reproduces the report path.
// ---------------------------------------------------------------------------
console.log('\nA) caught-prop -> round-2 hunter: blindfolds during HIDING, RELEASES at HUNTING');
{
  const t = makeRef();
  const H = t.add('H', ROLE.HUNTER);
  const P = t.add('P', ROLE.PROP);
  const cH = makeClient('H');
  const cP = makeClient('P');

  t.ref._launchRound();               // round 1 HIDING
  drain(t, 'H', cH); drain(t, 'P', cP);
  t.ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
  t.ref.broadcastSnapshot();
  drain(t, 'H', cH); drain(t, 'P', cP);
  ok(cP.blind === false && cH.blind === false, 'round 1 HUNTING: nobody blindfolded');

  // The prop is caught -> dies -> hunters win -> ENDING. (This is the "spectator" state B6 widened the
  // data gate for — the exact prime suspect for a data-starved round-2 hunter.)
  t.ref._damagePlayer(H, P, 9999, false);
  ok(P.alive === false && t.ref.phase === PHASE.ENDING, 'round 1: caught prop dies, round ends (ENDING)');
  t.ref.broadcastSnapshot();
  drain(t, 'H', cH); drain(t, 'P', cP);
  ok(cP.spectating === false, 'at ENDING the dead prop is NOT stuck spectating (inactive phase)');

  // ENDING expires -> flipped round 2. The dead prop P is now the HUNTER.
  t.ref.startFlippedRound();
  ok(P.role === ROLE.HUNTER && H.role === ROLE.PROP, 'round 2 flip: caught prop is now the HUNTER');
  ok(P.alive === true, 'round 2: the flipped-to-hunter is RESET ALIVE on the server (not starved as a phantom-dead player)');
  drain(t, 'H', cH); drain(t, 'P', cP);
  ok(cP.role === ROLE.HUNTER && cP.blind === true, 'round 2 HIDING: the new hunter IS blindfolded (correct anti-cheat)');
  ok(cP.spectating === false, 'round 2 HIDING: the new hunter is no longer spectating (STARTED reset + alive)');

  // Round-2 HIDING snapshot: the new hunter is alive + prop data withheld (blindfolded, not unspawned).
  t.ref.broadcastSnapshot();
  let raw = null;
  for (const m of t.take('P')) { if (m.t === S2C.SNAPSHOT) raw = m; clientApply(cP, m); }
  ok(raw && raw.players.find((x) => x.id === 'P').alive === true, 'round 2 HIDING snapshot: the new hunter is ALIVE server-side');
  ok(raw && raw.props.length === 0 && raw.players.filter((x) => !x.hunter).length === 0,
    'round 2 HIDING snapshot: prop transforms + prop entries withheld from the blindfolded hunter (data gate holds)');
  drain(t, 'H', cH);

  // Round-2 release: HIDING -> HUNTING. The new hunter must get the one-time world catch-up + full data.
  t.ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
  const pMsgs = t.take('P');
  ok(pMsgs.some((m) => m.t === S2C.EVENT && m.kind === 'world'),
    'round 2 release: the new hunter receives the one-time kind:world catch-up (sees the real world, not factory-fresh)');
  for (const m of pMsgs) clientApply(cP, m);
  t.ref.broadcastSnapshot();
  let rel = null;
  for (const m of t.take('P')) { if (m.t === S2C.SNAPSHOT) rel = m; clientApply(cP, m); }
  ok(rel && rel.props !== undefined && rel.players.some((x) => !x.hunter),
    'round 2 HUNTING snapshot: full prop data resumes for the released hunter');

  ok(cP.blind === false, 'RELEASED: the round-2 hunter is NOT blindfolded during HUNTING (the reported bug is GONE)');
  ok(cP.lookFrozen === false, 'RELEASED: look is unfrozen for the round-2 hunter');
  ok(cP.spectating === false && cP.spawned === true, 'RELEASED: the round-2 hunter is spawned + not spectating');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// SCENARIO B — no-death flip: round 1 ends by TIMER (both alive), the round-1 prop becomes round-2 hunter.
// ---------------------------------------------------------------------------
console.log('\nB) no-death flip (round ends by timer): round-2 hunter still releases at HUNTING');
{
  const t = makeRef();
  t.add('H', ROLE.HUNTER);
  const P = t.add('P', ROLE.PROP);
  const cP = makeClient('P');

  t.ref._launchRound();
  t.ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
  t.ref.endRound(ROLE.PROP);          // timer ran out -> props win -> ENDING
  t.ref.startFlippedRound();          // -> round 2, P is now HUNTER
  ok(P.role === ROLE.HUNTER && P.alive === true, 'round 2 (no-death): the round-1 prop is now a live HUNTER');
  drain(t, 'P', cP);
  ok(cP.blind === true, 'round 2 HIDING (no-death): the new hunter is blindfolded');
  t.ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
  drain(t, 'P', cP);
  ok(cP.blind === false && cP.lookFrozen === false, 'round 2 HUNTING (no-death): RELEASED (blindfold + look clear)');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// C — CLIENT STARTED RESET (the belt-and-suspenders that clears stale round-1 view-state at the flip).
// ---------------------------------------------------------------------------
console.log('\nC) source: main.js resets transient blindfold/spectator view-state at a fresh round (STARTED)');
{
  const main = readText('js', 'main.js');
  const started = main.slice(main.indexOf('case S2C.STARTED'), main.indexOf('case S2C.ROLE'));
  ok(/ui\.setBlindfold\(false\)/.test(started), 'STARTED clears any stale blindfold overlay');
  ok(/input\.lookFrozen = false/.test(started), 'STARTED unfreezes look (a stale HIDING freeze cannot bleed into the new round)');
  ok(/setSpectating\(false\)/.test(started), 'STARTED exits any spectator cam left over from a death last round');
  // The blindfold stays DERIVED from role+phase (never a latched flag) — the reset only clears stale state.
  ok(/state\.role === ROLE\.HUNTER && state\.phase === PHASE\.HIDING/.test(main),
    'the blindfold is still derived fresh from role+phase (updateBlindfold) — the reset does not weaken the gate');
}

console.log(fails ? `\nROUND-FLIP BLINDFOLD check FAILED (${fails})` : '\nAll round-flip blindfold checks passed.');
process.exit(fails ? 1 : 0);
