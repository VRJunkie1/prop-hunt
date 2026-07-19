#!/usr/bin/env node
// tools/check-lifecycle.mjs — acceptance guard for B2: LIFECYCLE BUGS — GHOST PLAYERS + HUNTER
// SPAWN CLIPPING / EMBEDDING (playtest fixes, VRmike, 2026-07-18).
//
//   A) GHOST PLAYERS (pure referee, no Rapier). A player who LEAVES — GRACEFULLY (removePlayer)
//      or via a SILENT TIMEOUT (a locked/dropped phone that stops sending, swept by tick) — is
//      FULLY gone: dropped from the roster + every snapshot + the team counts, announced with a
//      public "X left" line, and the round is RECOUNTED so a departure resolves or unsticks it:
//        - last living prop leaves  → hunters win immediately (a ghost prop can't keep it alive),
//        - last living hunter leaves → props win immediately,
//        - a leaver with survivors  → round continues, but they vanish from snapshots/counts,
//        - a flipped round after a mid-round leave assigns cleanly (no crash on a shrunk roster).
//
//   B) HUNTER SPAWN CLIPPING + EMBEDDING (live Rapier). Two hunters sharing one spawn separate so
//      neither overlaps the other; a spawn point OBSTRUCTED by a settled prop lifts/nudges the
//      hunter CLEAR (onto it or beside it) — nobody inside another player, a prop, or geometry —
//      all through the ONE resolveSpawnOverlap resolver (extended from the faf3d6b overlap machinery).
//
// AUTHORING-ONLY, never shipped. Part A runs Rapier-free (pure shared/referee.js). Part B needs the
// CDN WASM physics installed locally (not saved to package.json):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-lifecycle.mjs
// If Rapier is absent, part B prints SKIP (not a failure) and the exit code reflects part A alone.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

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

// ── Referee harness (mirrors check-sync-convergence / check-team-flip): captured mailbox per
//    player, physics STUBBED so the round-launch is Rapier-free + deterministic. We assert the
//    referee's OUTPUTS (roster, snapshots, feed) — the ghost-player logic is entirely physics-free.
function makeRef() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
  ref._buildPhysics = async () => {}; // no Rapier in the sandbox; the leave/recount logic is physics-free
  const inbox = new Map();
  const mk = (id, role, extra = {}) => {
    inbox.set(id, []);
    const p = {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
      lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false }, _lastSeen: Date.now(),
      send: (obj) => inbox.get(id).push(obj),
    };
    Object.assign(p, extra);
    return p;
  };
  const add = (id, role, extra = {}) => { const p = mk(id, role, extra); ref.players.set(id, p); if (!ref.hostId) ref.hostId = id; return p; };
  const msgs = (id) => inbox.get(id) || [];
  const lastSnap = (id) => { const s = msgs(id).filter((m) => m.t === S2C.SNAPSHOT); return s[s.length - 1] || null; };
  const logs = (id) => msgs(id).filter((m) => m.t === S2C.EVENT && m.kind === 'log').map((m) => m.text);
  // Launch a live round with the given roles already assigned (sets the per-round team flags),
  // then force HUNTING so we can test a mid-round leave.
  const launchHunting = () => { ref._launchRound(); ref.phase = PHASE.HUNTING; ref.phaseEndsAt = Date.now() + 30000; };
  return { ref, mk, add, msgs, lastSnap, logs, launchHunting };
}

console.log('LIFECYCLE — ghost players + hunter spawn clipping/embedding: acceptance check');

// ===========================================================================
// A) GHOST PLAYERS — a leaver is fully gone + the round recounts.
// ===========================================================================
console.log('\nA) ghost players — a leaver is removed from snapshots + counts, round recounts both teams');

// A1 — last living PROP leaves → hunters win immediately (a ghost prop can't keep the round alive).
{
  const t = makeRef();
  const HostH = t.add('HostH', ROLE.HUNTER); // host is a hunter here
  t.add('H2', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.launchHunting();
  ok(t.ref._roundHadProps === true && t.ref._roundHadHunters === true, 'round records it started with both teams');
  t.ref.removePlayer('P1'); // the only prop leaves mid-round
  ok(!t.ref.players.has('P1'), 'the leaver is dropped from the roster');
  ok(t.ref.lastResult && t.ref.lastResult.winner === ROLE.HUNTER, 'last prop LEFT → hunters win immediately');
  ok(t.ref.phase === PHASE.ENDING, 'round transitioned to ENDING (not left hanging on the timer)');
  // Gone from snapshots + counts.
  t.ref.phase = PHASE.HUNTING; // (recount already fired; re-broadcast to inspect the snapshot roster)
  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('HostH');
  ok(snap && !snap.players.some((pl) => pl.id === 'P1'), 'the leaver is absent from every snapshot');
  ok(snap && snap.propsTotal === 0 && snap.propsAlive === 0, 'team counts drop the leaver (propsTotal/propsAlive = 0)');
  t.ref.destroy();
}

// A2 — last living HUNTER leaves → props win immediately (symmetric).
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP);
  t.launchHunting();
  t.ref.removePlayer('H1'); // the only hunter leaves mid-round
  ok(!t.ref.players.has('H1'), 'the departed hunter is off the roster');
  ok(t.ref.lastResult && t.ref.lastResult.winner === ROLE.PROP, 'last hunter LEFT → props win immediately');
  ok(t.ref.phase === PHASE.ENDING, 'round resolved to ENDING');
  t.ref.destroy();
}

// A3 — a leaver WITH survivors: round continues, but they vanish from snapshots + counts.
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP);
  t.launchHunting();
  t.ref.removePlayer('P1'); // one of two props leaves
  ok(t.ref.phase === PHASE.HUNTING && !t.ref.lastResult, 'a prop leaves with a prop still alive → round keeps running');
  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('H1');
  ok(snap && !snap.players.some((pl) => pl.id === 'P1'), 'the leaver is gone from the snapshot');
  ok(snap && snap.propsTotal === 1 && snap.propsAlive === 1, 'counts reflect exactly the one remaining prop');
  t.ref.destroy();
}

// A4 — public "X left" feed line for everyone (graceful) + it does NOT fire for an unknown id.
{
  const t = makeRef();
  const H = t.add('H1', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP);
  t.launchHunting();
  t.ref.removePlayer('P1');
  ok(t.logs('H1').some((x) => /P1 left/.test(x)), 'a public "X left" line is broadcast to everyone');
  const before = t.msgs('H1').length;
  t.ref.removePlayer('nobody'); // unknown id → no-op, no phantom log
  ok(t.msgs('H1').length === before, 'removing an unknown id is a silent no-op (no phantom "left")');
  t.ref.destroy();
}

// A5 — SILENT TIMEOUT: a peer that stops sending (locked phone) is swept out by tick, same as a leave.
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);   // host (never swept)
  t.add('P1', ROLE.PROP);
  const P2 = t.add('P2', ROLE.PROP);
  t.launchHunting();
  const now = Date.now();
  // P2's phone locked: last message is well past the timeout window; everyone else is live.
  P2._lastSeen = now - (rules.leaveTimeoutSeconds * 1000) - 2000;
  t.ref.players.get('H1')._lastSeen = now;
  t.ref.players.get('P1')._lastSeen = now;
  t.ref._sweepSilentPlayers(now);
  ok(!t.ref.players.has('P2'), 'the silent peer is timed out and removed (no lingering ghost)');
  ok(t.ref.players.has('H1') && t.ref.players.has('P1'), 'live peers are NOT swept');
  ok(t.logs('H1').some((x) => /P2 left/.test(x)), 'the timeout is announced as a public leave line');
  t.ref.destroy();
}

// A6 — the HOST is never timed out even if its own loopback goes momentarily quiet.
{
  const t = makeRef();
  const H = t.add('HOST', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.launchHunting();
  const now = Date.now();
  H._lastSeen = now - (rules.leaveTimeoutSeconds * 1000) - 5000; // host "silent"
  t.ref.players.get('P1')._lastSeen = now;
  t.ref._sweepSilentPlayers(now);
  ok(t.ref.players.has('HOST'), 'the host (= the referee\'s own tab) is never swept by the silent-timeout');
  t.ref.destroy();
}

// A7 — a mid-round leave does NOT crash the between-rounds flipped assignment (leave-proof).
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);
  t.add('H2', ROLE.HUNTER);
  t.add('P1', ROLE.PROP);
  t.add('P2', ROLE.PROP);
  t.launchHunting();
  t.ref.removePlayer('P1'); // someone leaves mid-round; round keeps running (a prop is still alive)
  let crashed = false;
  try { t.ref.startFlippedRound(); } catch (e) { crashed = true; console.error('    ' + e.message); }
  ok(!crashed, 'startFlippedRound survives a shrunk roster (no crash on a mid-round leaver)');
  const roster = [...t.ref.players.values()];
  ok(roster.length === 3 && roster.some((p) => p.role === ROLE.PROP), 'the flipped round assigns the remaining 3 cleanly (>=1 prop)');
  ok(t.ref._roundHadProps === true, 'the new round re-records its starting teams');
  t.ref.destroy();
}

// A8 — a SOLO prop-only round (0 hunters) must NOT instantly resolve on the recount (runs on the timer).
{
  const t = makeRef();
  t.add('SOLO', ROLE.PROP); // lone host, prop, no hunters (minPlayers=1)
  t.launchHunting();
  ok(t.ref._roundHadHunters === false, 'solo round records it never had hunters');
  t.ref.checkRoundOver();
  ok(t.ref.phase === PHASE.HUNTING && !t.ref.lastResult, 'a hunter-less solo round does not false-resolve — it runs on the timer');
  t.ref.destroy();
}

// ===========================================================================
// A′) CONNECTION LIVENESS VIA KEEPALIVE PINGS (2026-07-19, VRmike). Liveness is the LAST MESSAGE
//     OF ANY KIND — a dedicated ~1Hz keepalive ping (referee.markSeen) OR any C2S — NEVER input.
//     So an AFK-but-CONNECTED player (zero inputs, pings flowing) stays in indefinitely, while a
//     genuinely dead connection (pings stopped) still gets swept. See net.js + rules.json.
// ===========================================================================
console.log('\nA′) connection liveness — pings (not input) decide who stays; AFK-but-connected never booted');

// A9 — markSeen() is the ping hook: it stamps the SAME _lastSeen the sweep reads, and no-ops on an
//      unknown id (a ping that raced the peer's removal).
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);
  const P = t.add('P1', ROLE.PROP);
  P._lastSeen = 0; // pretend long-silent
  t.ref.markSeen('P1'); // a keepalive ping arrives
  ok(P._lastSeen > 0 && (Date.now() - P._lastSeen) < 1000, 'markSeen() stamps _lastSeen — a keepalive ping refreshes liveness (pings feed the same clock as C2S)');
  let crashed = false;
  try { t.ref.markSeen('nobody'); } catch { crashed = true; }
  ok(!crashed, 'markSeen() on an unknown id is a silent no-op (no crash)');
  t.ref.destroy();
}

// A10 — AFK-BUT-CONNECTED STAYS: a player that sends ZERO inputs but whose ~1Hz keepalive keeps
//       arriving is NEVER swept, even across 5 simulated minutes. Someone idle in the bathroom
//       stays in the game. Each simulated second a keepalive stamps liveness AT `now`; the sweep
//       runs at that same `now` — pings alone hold the player in.
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);
  t.add('AFK', ROLE.PROP);
  t.launchHunting();
  const threshold = rules.leaveTimeoutSeconds * 1000;
  const base = Date.now();
  const pingMs = 1000; // the dedicated keepalive cadence
  let removed = false;
  for (let dt = 0; dt <= 5 * 60 * 1000; dt += pingMs) {
    const now = base + dt;
    t.ref.players.get('AFK')._lastSeen = now; // a keepalive ping arrived this second (models markSeen at `now`) — NO input, ever
    t.ref.players.get('H1')._lastSeen = now;
    t.ref._sweepSilentPlayers(now);
    if (!t.ref.players.has('AFK')) removed = true;
  }
  ok(!removed && t.ref.players.has('AFK'), `an AFK-but-connected player (pings only, zero inputs) survives 5 simulated minutes (threshold ${threshold}ms)`);
  t.ref.destroy();
}

// A11 — GENUINELY DEAD CONNECTION STILL CLEANED UP: the keepalive STOPS (tab closed / phone asleep /
//       network drop). Once ping silence exceeds the threshold the peer is swept, exactly as before —
//       cleanup is preserved, just driven by an accurate signal.
{
  const t = makeRef();
  t.add('H1', ROLE.HUNTER);
  const DEAD = t.add('DEAD', ROLE.PROP);
  t.launchHunting();
  const base = Date.now();
  DEAD._lastSeen = base; // last keepalive at t0; none since (connection died)
  const now = base + rules.leaveTimeoutSeconds * 1000 + 3000; // silence past the threshold
  t.ref.players.get('H1')._lastSeen = now; // host still pinging
  t.ref._sweepSilentPlayers(now);
  ok(!t.ref.players.has('DEAD'), 'ping silence past the threshold still sweeps a genuinely dead connection (cleanup preserved)');
  ok(t.logs('H1').some((x) => /DEAD left/.test(x)), 'the dead connection is announced as a public leave line');
  // And a peer JUST under the threshold is NOT swept (boundary — no premature boot of a jittery link).
  const t2 = makeRef();
  t2.add('H1', ROLE.HUNTER);
  const LIVE = t2.add('LIVE', ROLE.PROP);
  t2.launchHunting();
  const b2 = Date.now();
  LIVE._lastSeen = b2;
  t2.ref.players.get('H1')._lastSeen = b2 + rules.leaveTimeoutSeconds * 1000; // keep host live at the sweep instant
  t2.ref._sweepSilentPlayers(b2 + rules.leaveTimeoutSeconds * 1000 - 500); // 0.5s inside the window
  ok(t2.ref.players.has('LIVE'), 'a peer silent for JUST under the threshold is NOT swept (a jitter spike inside the window is tolerated)');
  t.ref.destroy();
  t2.ref.destroy();
}

// ===========================================================================
// B) HUNTER SPAWN CLIPPING + EMBEDDING — live Rapier resolveSpawnOverlap.
// ===========================================================================
console.log('\nB) hunter spawn separation + settled-prop embedding (live Rapier)');

let RAPIER = null;
try {
  RAPIER = (await import('@dimforge/rapier3d-compat')).default;
} catch {
  console.log('  SKIP: @dimforge/rapier3d-compat not installed. Run: npm i --no-save @dimforge/rapier3d-compat@0.14.0');
}

if (RAPIER) {
  await RAPIER.init();
  const feel = readJSON('shared', 'config', 'physics-feel.json');
  const { PhysicsWorld } = await import('../shared/physics.js');
  const H = 1 / 60;
  const pr = rules.playerRadius;
  const minSep = 2 * pr - 0.15; // colliders no longer interpenetrate (matches check-solid-players D3)

  // A small solid box prop to obstruct a spawn (a settled crate resting on the floor at the spawn).
  const catalog = { crate: { shape: 'box', w: 1.2, h: 1.2, d: 1.2 } };
  const CRATE_HALF = 0.6, CRATE_TOP = 1.2;
  const mkWorld = (propInstances = []) => new PhysicsWorld(
    RAPIER, { size: 40, fixtures: [] }, propInstances, catalog,
    { rules, feel, dynamicProps: true }
  );

  // B1 — two hunters share ONE spawn point → they separate (nobody fused).
  {
    const w = mkWorld();
    const at = { x: 0, y: 0, z: 0 };
    w.addPlayer('a', at); w.resolveSpawnOverlap('a');
    w.addPlayer('b', at); w.resolveSpawnOverlap('b');
    const A = w.getPlayer('a'), B = w.getPlayer('b');
    const sep = Math.hypot(A.x - B.x, A.z - B.z);
    ok(sep >= minSep, `B1: two hunters on one spawn separate (sep=${sep.toFixed(2)} ≥ ${minSep.toFixed(2)})`);
    w.destroy();
  }

  // B2 — a SINGLE hunter spawned INSIDE a settled prop is lifted/nudged CLEAR of it (no player
  //      needed — phase 2 runs solo). Clear = on top of the crate OR beside it, and never below floor.
  {
    const w = mkWorld([{ id: 1, type: 'crate', x: 0, z: 0, y: 0, rot: 0 }]);
    w.addPlayer('h', { x: 0, y: 0, z: 0 }); // right inside the crate
    w.resolveSpawnOverlap('h');
    const P = w.getPlayer('h');
    const horiz = Math.hypot(P.x, P.z);
    const onTop = P.y > CRATE_TOP - 0.1;
    const beside = horiz > CRATE_HALF + pr - 0.1;
    ok(onTop || beside, `B2: a hunter embedded in a prop is cleared (footY=${P.y.toFixed(2)} horiz=${horiz.toFixed(2)} onTop=${onTop} beside=${beside})`);
    ok(P.y > -0.05, `B2: never resolved BELOW the floor (footY=${P.y.toFixed(2)})`);
    // Settle a moment: a cleared spawn must stay put, not sink back into the prop.
    for (let i = 0; i < 30; i++) w.step(H);
    const S = w.getPlayer('h');
    const sHoriz = Math.hypot(S.x, S.z);
    ok((S.y > CRATE_TOP - 0.15) || (sHoriz > CRATE_HALF + pr - 0.15), `B2: stays clear after a short settle (footY=${S.y.toFixed(2)} horiz=${sHoriz.toFixed(2)})`);
    w.destroy();
  }

  // B3 — the real bug: TWO hunters at an OBSTRUCTED spawn. They must end up neither overlapping each
  //      other NOR embedded in the prop NOR outside the arena — the whole B2 ask in one shot.
  {
    const w = mkWorld([{ id: 1, type: 'crate', x: 0, z: 0, y: 0, rot: 0 }]);
    w.addPlayer('a', { x: 0, y: 0, z: 0 }); w.resolveSpawnOverlap('a');
    w.addPlayer('b', { x: 0, y: 0, z: 0 }); w.resolveSpawnOverlap('b');
    const clearOfCrate = (id) => {
      const P = w.getPlayer(id);
      const horiz = Math.hypot(P.x, P.z);
      return (P.y > CRATE_TOP - 0.15) || (horiz > CRATE_HALF + pr - 0.15);
    };
    const A = w.getPlayer('a'), B = w.getPlayer('b');
    const sep = Math.hypot(A.x - B.x, A.z - B.z);
    const bound = 40 / 2 - 0.5 - pr;
    const inBounds = (P) => Math.abs(P.x) <= bound + 1e-6 && Math.abs(P.z) <= bound + 1e-6;
    ok(sep >= minSep, `B3: two hunters at an obstructed spawn don't overlap each other (sep=${sep.toFixed(2)})`);
    ok(clearOfCrate('a') && clearOfCrate('b'), 'B3: neither hunter is embedded in the prop');
    ok(A.y > -0.05 && B.y > -0.05 && inBounds(A) && inBounds(B), 'B3: neither is below the floor or outside the arena walls');
    w.destroy();
  }

  // B4 — control: with NO obstruction the resolver is a cheap near-no-op (a lone spawn stays put).
  {
    const w = mkWorld();
    w.addPlayer('lone', { x: 5, y: 0, z: -3 });
    w.resolveSpawnOverlap('lone');
    const P = w.getPlayer('lone');
    ok(Math.abs(P.x - 5) < 0.05 && Math.abs(P.z + 3) < 0.05 && Math.abs(P.y) < 0.05,
      `B4: a lone, unobstructed spawn is left untouched (${P.x.toFixed(2)},${P.y.toFixed(2)},${P.z.toFixed(2)})`);
    w.destroy();
  }
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll lifecycle checks passed.');
// Set the exit code and let Node drain the event loop and CLOSE its handles on its own instead
// of forcing a synchronous process.exit(). On Windows, exit() mid-teardown races the Rapier WASM /
// libuv async handles as they close and trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// (src/win/async.c:76 → abort 0xC0000409). By this point every Referee interval is cleared (destroy())
// and every PhysicsWorld is freed, so nothing keeps the loop alive — the process exits cleanly with
// this code once the last handle finishes closing. See memory/notes/tooling-exit.md.
process.exitCode = fails ? 1 : 0;
