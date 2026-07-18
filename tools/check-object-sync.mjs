#!/usr/bin/env node
// tools/check-object-sync.mjs — HEADLESS acceptance check for HOST-AUTHORITATIVE PHYSICS OBJECT SYNC
// + WORLD SNAPSHOT ON SPAWN/JOIN (VRmike, 2026-07-17). AUTHORING-ONLY — never imported by the page or
// shipped to a browser. Run from a shell:
//
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-object-sync.mjs
//
// WHY THIS EXISTS. The reported desync: one player knocks an object over and OTHER players — especially
// hunters spawning in after the hide phase — still see it UPRIGHT. The awake-prop stream + mid-join
// catch-up already existed; the real gap was the blindfold path: a hunter is fed ZERO prop transforms
// through HIDING, and by HUNTING the shoved object has settled ASLEEP (so the awake stream won't resend
// it) — so the released hunter renders the factory-fresh map. A headless browser boot can't exercise
// this (no match, no Rapier), so this drives the REAL shared code paths (a live Rapier world + the real
// Referee) and asserts the four OUTPUTS the brief specified:
//   (a) a late joiner's catch-up contains the MOVED transform (not the spawn pose);
//   (b) SLEEPING bodies generate ZERO stream traffic (steady state is quiet);
//   (c) the FINAL REST transform arrives on sleep, then the stream stops (wake/sleep propagation);
//   (d) a BLIND hunter during HIDING receives NO object transforms — then gets the FULL world at HUNTING
//       (and the mid-join catch-up is blindfold-gated so a hunter joining mid-HIDING can't peek either).
//
// Prints SKIP + exit 3 if Rapier is absent (never fails a build it can't run).

let RAPIER;
try {
  RAPIER = (await import('@dimforge/rapier3d-compat')).default;
} catch {
  console.log('SKIP: @dimforge/rapier3d-compat not installed. Run: npm i --no-save @dimforge/rapier3d-compat@0.14.0');
  process.exit(3);
}
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE, PHASE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';
const { PhysicsWorld, isArchEntry, isFixedBodyEntry } = await import('../shared/physics.js');
const { groundMapData, seatMapData } = await import('../shared/grounding.js');

await RAPIER.init();
const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json');
const feel = cfg('physics-feel.json');
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}

// Attach the SAME measured + convex-hull seams js/config.js attaches so collider shapes match the game.
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) {
  if (!b || !(b.w > 0 && b.h > 0 && b.d > 0)) continue;
  const m = { w: b.w, h: b.h, d: b.d };
  if (props[t]) props[t].measured = m;
  if (fixtures[t]) fixtures[t].measured = m;
}
for (const [t, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; }
  if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };

let fails = 0;
const ok = (cond, msg, detail) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg + (detail ? ' — ' + detail : ''));
  if (!cond) fails++;
};
const H = 1 / 60;

function footprint(c) {
  if (!c) return 0;
  const m = c.measured; if (m && m.w > 0 && m.h > 0 && m.d > 0) return m.w * m.h * m.d;
  switch (c.shape) {
    case 'box': return (c.w || 1) * (c.h || 1) * (c.d || 1);
    case 'cylinder': case 'cone': return Math.PI * (c.r || 0.5) * (c.r || 0.5) * (c.h || 1);
    case 'sphere': return (4 / 3) * Math.PI * Math.pow(c.r || 0.5, 3);
    default: return 0.5;
  }
}
// Promote the map exactly as referee.startMatch (biggest-first), no hide-spot removal.
function promote(map) {
  let id = 1;
  const mk = (o) => ({ id: id++, type: o.type, x: o.x, z: o.z, y: o.y || 0, rot: o.rot || 0 });
  const disguiseProps = (map.props || []).map(mk);
  const nonArch = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c); });
  const dynFixtures = nonArch.filter((f) => !isFixedBodyEntry(catalog[f.type])).map(mk);
  const staticFixtures = nonArch.filter((f) => isFixedBodyEntry(catalog[f.type])).map(mk);
  const dynamicCandidates = [...disguiseProps, ...dynFixtures].sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]));
  return [...dynamicCandidates, ...staticFixtures];
}

console.log('object-sync — real Rapier world + real Referee: knock an object over on the host, then verify sync\n');

const map = JSON.parse(JSON.stringify(maps.restaurant));
groundMapData(map, catalog);
seatMapData(map, catalog);
const instances = promote(map);
const world = new PhysicsWorld(RAPIER, map, instances, catalog, { dynamicProps: true, rules, feel });
const bodies = world.propBodies;
const spawnById = new Map(instances.map((p) => [p.id, { x: p.x, z: p.z }]));

const bodyById = new Map(bodies.map((b) => [b.id, b]));
const typeOf = (id) => instances.find((p) => p.id === id).type;

// ---- 1) SETTLE the map, DRAINING the awake stream each step (mirrors the referee, which calls
//         awakeProps() every tick). The restaurant map has a few bodies that micro-jitter forever (a
//         known cosmetic — see check-settle), so we DON'T require the whole world asleep; we assert the
//         real invariant per-body below: a body that STAYS asleep contributes nothing to the stream.
for (let i = 0; i < 420; i++) { world.step(H); world.awakeProps(); }
const asleepBase = bodies.filter((b) => b.body.isSleeping()).length;
console.log(`  · settled: ${asleepBase}/${bodies.length} bodies asleep (the rest micro-jitter — a known cosmetic, not new traffic)`);

// (b) SLEEPING BODIES GENERATE ZERO STREAM TRAFFIC. Over a steady-state window, a body that has been
//     asleep since the previous tick must NOT appear in the stream — the only legit "asleep" frame is
//     the one-tick awake→asleep EDGE (the final rest frame). Perpetually-jittering bodies are genuinely
//     awake, so the host legitimately streams them; that isn't a sleeping body leaking.
const prevSleeping = new Map(bodies.map((b) => [b.id, b.body.isSleeping()]));
let sleepingLeaks = 0;
for (let i = 0; i < 180; i++) {
  world.step(H);
  const awake = world.awakeProps();
  for (const q of awake) {
    const b = bodyById.get(q.id);
    const sleepingNow = b.body.isSleeping();
    // Leak = a body reported asleep AND already asleep last tick (so this isn't the final-rest edge).
    if (sleepingNow && prevSleeping.get(q.id)) sleepingLeaks++;
  }
  for (const b of bodies) prevSleeping.set(b.id, b.body.isSleeping());
}
ok(sleepingLeaks === 0, '(b) a body that stays ASLEEP generates ZERO stream traffic (only the one-tick rest edge)',
  sleepingLeaks ? `${sleepingLeaks} asleep-body frames leaked over 180 steps` : 'no asleep body streamed over 180 steps');

// ---- 2) KNOCK AN OBJECT OVER on the host. Pick a light, central dynamic body (room to slide, away from
//         walls) and give it a real shove, exactly as a player bumping it would wake + move it.
const central = [...bodies].sort((a, b) => {
  const A = spawnById.get(a.id), B = spawnById.get(b.id);
  return (Math.abs(A.x) + Math.abs(A.z)) - (Math.abs(B.x) + Math.abs(B.z));
});
const target = central.find((b) => footprint(catalog[typeOf(b.id)]) < 0.5) || central[0];
const targetType = typeOf(target.id);
const spawnPos = { ...target.body.translation() };
target.body.wakeUp();
target.body.setLinvel({ x: 4.5, y: 2.5, z: 4.5 }, true);
target.body.setAngvel({ x: 8, y: 8, z: 8 }, true);

// Step, capturing every frame the TARGET appears in. It streams while moving, then emits one FINAL rest
// frame on the awake→asleep edge. Run until the target has been asleep for a sustained window.
const targetFrames = [];
let targetSleptAt = -1;
for (let i = 0; i < 900; i++) {
  world.step(H);
  const tf = world.awakeProps().find((q) => q.id === target.id);
  if (tf) targetFrames.push({ step: i, ...tf });
  if (target.body.isSleeping()) { if (targetSleptAt < 0) targetSleptAt = i; if (i - targetSleptAt > 60) break; }
  else targetSleptAt = -1;
}
const restNow = target.body.translation();
const moved = Math.hypot(restNow.x - spawnPos.x, restNow.z - spawnPos.z);
ok(moved > 0.2, `the shoved object (${targetType}#${target.id}) actually moved (test not vacuous)`, `displaced ${moved.toFixed(2)} m`);
ok(targetFrames.length > 0, 'the moving object streamed awake transforms while in motion', `${targetFrames.length} awake frames`);
ok(targetSleptAt >= 0, 'the shoved object returns to sleep after it settles');

// (c) FINAL REST TRANSFORM on sleep: the LAST frame the target streamed must equal its true resting pose
//     (the awake→asleep edge frame).
const lastTF = targetFrames[targetFrames.length - 1];
const restErr = lastTF ? Math.hypot(lastTF.x - restNow.x, lastTF.y - restNow.y, lastTF.z - restNow.z) : Infinity;
ok(restErr < 0.02, '(c) the FINAL streamed frame is the resting pose (final rest transform sent on sleep)',
  `|lastFrame − restPose| = ${restErr.toFixed(4)} m`);
// After the target sleeps, the stream is silent for it — the stream STOPS once it rests.
let postFrames = 0;
for (let i = 0; i < 120; i++) { world.step(H); if (world.awakeProps().some((q) => q.id === target.id)) postFrames++; }
ok(postFrames === 0, '(c) once asleep, the object streams NOTHING further (stream stops after the rest frame)',
  postFrames ? `${postFrames}/120 post-sleep frames leaked` : 'silent for 120 steps after rest');

// ---- 3) Wire the settled world into a REAL Referee to exercise the network-facing logic. ----------
function makeRef() {
  const ref = new Referee({ rules, maps: { restaurant: map }, props, fixtures, feel }, 'TEST');
  clearInterval(ref.interval); // stop the background tick — we drive the referee by hand
  ref.mapId = 'restaurant';
  ref.props = instances;
  ref.physics = world;
  ref.propLive = new Map(instances.map((p) => [p.id, { x: p.x, z: p.z }]));
  ref.awakePropTransforms = world.awakeProps(); // quiet now (all asleep) — the real steady state
  ref.phaseEndsAt = Date.now() + 30000;
  return ref;
}
function addPlayer(ref, id, role, capture) {
  const p = {
    id, name: id, role, alive: true, health: 100,
    pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, disguise: null, lastInputSeq: 0,
    send: (m) => capture.push(m),
  };
  ref.players.set(id, p);
  return p;
}

// (a) LATE-JOINER CATCH-UP contains the MOVED transform (not the spawn pose).
{
  const ref = makeRef();
  const catchup = ref._propsCatchup();
  const entry = catchup.find((p) => p.id === target.id);
  const hasLive = entry && Number.isFinite(entry.qx);
  const drift = entry ? Math.hypot((entry.x - spawnById.get(target.id).x), (entry.z - spawnById.get(target.id).z)) : 0;
  ok(hasLive && drift > 0.2, '(a) a late joiner\'s catch-up carries the object\'s MOVED transform (not its spawn pose)',
    entry ? `live centre ${drift.toFixed(2)} m from spawn (qx present)` : 'target missing from catch-up');
  // NOTE: never ref.destroy() here — it would free the SHARED physics world the later blocks reuse.
}

// (d) BLINDFOLD: a HUNTER during HIDING gets NO object transforms; a PROP does; and the mid-join
//     catch-up is blindfold-gated. Then at HUNTING the hunter receives the FULL world snapshot.
{
  const ref = makeRef();
  ref.phase = PHASE.HIDING;
  // Make the stream NON-empty so the strip is a real test (not a trivially-empty snapshot): pretend the
  // target is awake this tick. The blindfold must withhold it from the hunter regardless.
  ref.awakePropTransforms = world.allProps().filter((q) => q.id === target.id);

  const hCap = [], pCap = [];
  addPlayer(ref, 'H', ROLE.HUNTER, hCap);
  addPlayer(ref, 'P', ROLE.PROP, pCap);
  ref.broadcastSnapshot();
  const hSnap = hCap.find((m) => m.t === 'snapshot');
  const pSnap = pCap.find((m) => m.t === 'snapshot');
  ok(hSnap && hSnap.props.length === 0, '(d) a HUNTER during HIDING receives ZERO object transforms (blindfold)',
    hSnap ? `hunter snapshot props: ${hSnap.props.length}` : 'no snapshot sent');
  ok(pSnap && pSnap.props.some((q) => q.id === target.id), '(d) a PROP during HIDING DOES receive the object transform (strip is hunter-only)',
    pSnap ? `prop snapshot props: ${pSnap.props.length}` : 'no snapshot sent');

  // Mid-join catch-up gate: a blindfolded hunter's catch-up is spawn-form (no live leak); a prop's is live.
  const blindCatch = ref._propsCatchup(true).find((p) => p.id === target.id);
  const openCatch = ref._propsCatchup(false).find((p) => p.id === target.id);
  ok(blindCatch && !Number.isFinite(blindCatch.qx), '(d) mid-join catch-up is BLINDFOLD-GATED (hunter joining mid-HIDING gets spawn-form, no peek)');
  ok(openCatch && Number.isFinite(openCatch.qx), '(d) an un-blindfolded catch-up still carries the live moved transform');

  // RELEASE: HIDING → HUNTING. Every hunter must receive a one-time full world snapshot with the moved object.
  hCap.length = 0; pCap.length = 0;
  ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
  const worldMsg = hCap.find((m) => m.t === 'event' && m.kind === 'world');
  const wEntry = worldMsg && worldMsg.props.find((p) => p.id === target.id);
  const wDrift = wEntry ? Math.hypot(wEntry.x - spawnById.get(target.id).x, wEntry.z - spawnById.get(target.id).z) : 0;
  ok(worldMsg && wEntry && Number.isFinite(wEntry.qx) && wDrift > 0.2,
    '(d) at HIDING→HUNTING the released hunter receives the FULL world snapshot with the moved object',
    wEntry ? `world snapshot: ${worldMsg.props.length} props, target ${wDrift.toFixed(2)} m from spawn` : 'no kind:world event');
  ok(!pCap.some((m) => m.t === 'event' && m.kind === 'world'),
    '(d) props do NOT get the release snapshot (they tracked the awake stream live — hunters-only)');
}

// ---- STATIC guards: the blindfold gate spelling stays wired (mirrors check-blindfold's contract). -----
const refSrc = readFileSync(join(here, '..', 'shared', 'referee.js'), 'utf8');
ok(/role === ROLE\.HUNTER && this\.phase === PHASE\.HIDING/.test(refSrc),
  'admitMidGame computes the blindfold gate (role === HUNTER && phase === HIDING) for the catch-up');
ok(/if \(phase === PHASE\.HUNTING\)[\s\S]{0,300}kind: 'world'/.test(refSrc),
  'setPhase sends the kind:world release snapshot to hunters at HUNTING');
const mainSrc = readFileSync(join(here, '..', 'js', 'main.js'), 'utf8');
ok(/case 'world':/.test(mainSrc) && /applyWorldSnapshot/.test(mainSrc), 'main.js handles the kind:world event via scene.applyWorldSnapshot');
const sceneSrc = readFileSync(join(here, '..', 'js', 'scene.js'), 'utf8');
ok(/applyWorldSnapshot\s*\(/.test(sceneSrc), 'scene.js defines applyWorldSnapshot');

world.destroy();
console.log('');
if (fails) { console.error(`object-sync check FAILED (${fails} problem${fails > 1 ? 's' : ''})`); process.exit(1); }
console.log('object-sync check passed');
