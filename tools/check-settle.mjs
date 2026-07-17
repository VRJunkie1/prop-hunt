#!/usr/bin/env node
// tools/check-settle.mjs — HEADLESS "SETTLE TEST" that TESTS TIME, not frame zero (PHYSICS SETTLE
// ROUND 5, VRmike, 2026-07-17). This is the deliverable that four prior physics rounds needed and
// never had: a check that lets the simulation RUN before it judges the world.
//
// WHY EVERY PAST CHECK MISSED THE BUG. Rounds 1-4 audited the world at SPAWN (frame zero), where a
// prop floating a hair above its table looks perfectly placed. The bug only exists AFTER time passes:
// round 4 spawned every dynamic prop ASLEEP (physics.js body.sleep()), and a sleeping Rapier body
// takes NO gravity step until a collision wakes it — so a prop authored even 0.1-0.8 m proud of its
// real support HUNG IN THE AIR forever ("they fall, but ONLY after I jump into them" — the player is
// the wake event). A frame-zero audit PASSES that: the body is asleep exactly where it spawned. So
// this check does the one thing the others didn't: it STEPS the sim (no artificial wake — exactly
// like the referee at match start, which just ticks and never touches the props) and then asserts the
// world came to REST correctly.
//
// TWO invariants, both judged only AFTER the sim has run:
//   1. MOBILITY — every should-be-dynamic prop (everything non-architecture and non-wall-attached)
//      actually got a DYNAMIC rigid body. A prop the phone-budget cap demoted to an immovable STATIC
//      collider "refuses to fall even when hit" (VRmike's beige cylinders + paper-towel roll: the ~89
//      smallest candidates overflowed the old 150 cap). Audited by CATALOG INTENT, so a mis-filed prop
//      can't dodge by sitting in the wrong bucket.
//   2. RESTING ON A SUPPORT — after stepping, a downward SHAPE-CAST of each dynamic prop's footprint
//      hits a support within EPS. Nothing is left hanging in the air. Shape-cast (not a single centre
//      ray) so an edge-rest or a body that settled slightly tilted isn't a false "floating".
//
// It MUST FAIL on the pre-fix build (naming the floating sauce bottles/burgers AND the immovable
// cylinders/paper-towel) and PASS after. Run `--simulate-main` to reproduce the pre-fix behaviour
// (old 150 cap + spawn-asleep) in one command, so this check can prove it still bites without editing
// source — that is the "fail-first" evidence, reproducible forever.
//
// AUTHORING-ONLY, never shipped. Needs a local dev Rapier (same as check-physics-live):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-settle.mjs                 # the shipped build — must PASS
//     node tools/check-settle.mjs --simulate-main # the pre-fix build — must FAIL
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
const { PhysicsWorld, isArchEntry, isFixedBodyEntry, halfExtentsFor, FLOOR_Y } = await import('../shared/physics.js');
const { groundMapData, seatMapData } = await import('../shared/grounding.js');

// Robust to both a real CLI flag (`node tools/check-settle.mjs --simulate-main`) and harnesses that
// hand argv over as one JSON-encoded string element (e.g. `["--simulate-main"]`).
const SIMULATE_MAIN = process.argv.slice(2).join(' ').includes('simulate-main');
// The pre-round-5 phone-budget cap. Under --simulate-main we clamp to this so the SAME ~89 smallest
// props overflow to immovable static colliders exactly as they did on the shipped-with-bug build.
const OLD_CAP = 150;

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

// Attach the SAME measured + convex-hull seams js/config.js attaches, so the collider shapes/heights
// the test sees match the shipping game exactly (otherwise it'd settle against primitive fallbacks).
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

// footprint() — copy of referee's biggest-first key, so the SAME items become dynamic here.
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

// Promote a map exactly as referee.startMatch (global biggest-first), but with NO hide-spot removal
// — the WORST case (most bodies, densest packing) a phone/host ever faces at match start. Everything
// non-fixed is a dynamic-body candidate; only architecture + wall-attached (isFixedBodyEntry) stays a
// static collider. Returns { instances, dynamicCandidates } so the audit can name the should-be-dynamic set.
function promote(map) {
  let id = 1;
  const mk = (o) => ({ id: id++, type: o.type, x: o.x, z: o.z, y: o.y || 0, rot: o.rot || 0 });
  const disguiseProps = (map.props || []).map(mk);
  const nonArch = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c); });
  const dynFixtures = nonArch.filter((f) => !isFixedBodyEntry(catalog[f.type])).map(mk);
  const staticFixtures = nonArch.filter((f) => isFixedBodyEntry(catalog[f.type])).map(mk);
  const dynamicCandidates = [...disguiseProps, ...dynFixtures].sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]));
  return { instances: [...dynamicCandidates, ...staticFixtures], dynamicCandidates };
}

let failures = 0;
const check = (ok, name, detail) => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const H = 1 / 60;
const STEPS = 600;         // 10 s of game time — well past the ~1-2 s the map needs to settle.
// A prop must rest within this of a support after settling. Empirically the shipped build settles
// every prop to ≤0.045 m (median 0), while the pre-fix build leaves genuine sleeper-floaters at
// 0.13–0.17 m — so 0.08 sits comfortably between (won't false-fail a settled prop, still catches a
// prop left hanging in the air). It is deliberately looser than the 2 cm SPAWN_EPS: a 2 cm hover is
// Rapier's normal resting skin, not a bug; the bug is a prop suspended 10+ cm with no gravity step.
const REST_EPS = 0.08;
const SINK_TOL = 0.5;      // nothing may end this far below the floor plane (a tunnel/eject failure).
// Group a list of "type@(x,z)" offenders into "type×N" for a readable failure line.
function tally(list) {
  const byType = {};
  for (const s of list) { const t = s.split('@')[0]; byType[t] = (byType[t] || 0) + 1; }
  return Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', ');
}

console.log(`settle test — full restaurant map, no players, STEP ${(STEPS * H).toFixed(0)}s, then judge the RESTED world`);
console.log(SIMULATE_MAIN ? '  MODE: --simulate-main (pre-round-5: 150-cap + spawn-asleep) — expected to FAIL\n' : '  MODE: shipped build — expected to PASS\n');

const map = JSON.parse(JSON.stringify(maps.restaurant));
// Same load pipeline as js/config.js: ground orphans/sinkers, then SEAT clutter on the collider top
// beneath it so nothing spawns embedded in a taller hull.
groundMapData(map, catalog);
seatMapData(map, catalog);

const { instances, dynamicCandidates } = promote(map);

// Under --simulate-main, clamp the cap so the SAME props overflow to static as on the buggy build.
const runRules = SIMULATE_MAIN ? { ...rules, maxDynamicProps: OLD_CAP } : rules;
const world = new PhysicsWorld(RAPIER, map, instances, catalog, { dynamicProps: true, rules: runRules, feel });
const bodies = world.propBodies;                        // the REAL dynamic bodies built this run
const dynIds = new Set(bodies.map((b) => b.id));
const typeById = new Map(instances.map((p) => [p.id, p.type]));
const posById = new Map(instances.map((p) => [p.id, { x: p.x, z: p.z }]));

// ---- INVARIANT 1: MOBILITY. Every should-be-dynamic prop must actually be a dynamic body. One the
// cap demoted to an immovable static collider "refuses to fall even when hit" — the beige cylinders /
// paper-towel roll / sauce bottles VRmike reported. Audited by CATALOG INTENT (dynamicCandidates), so
// a prop can't dodge by being in the wrong bucket.
const immovable = dynamicCandidates.filter((p) => !dynIds.has(p.id)).map((p) => `${p.type}@(${p.x.toFixed(1)},${p.z.toFixed(1)})`);
check(immovable.length === 0,
  `every knockable prop got a DYNAMIC body (nothing "refuses to fall even when hit")`,
  immovable.length ? `${immovable.length} demoted to an IMMOVABLE static collider: ${tally(immovable)}` : `all ${dynamicCandidates.length} should-be-dynamic props are real rigid bodies (cap ${runRules.maxDynamicProps})`);

// --- FAITHFUL MATCH-START: under --simulate-main, force every fresh body ASLEEP exactly as round 4's
// _buildProps did. The shipped build spawns them AWAKE (round 5), so we do nothing here for it.
if (SIMULATE_MAIN) { for (const b of bodies) if (b.body.sleep) b.body.sleep(); }

// ---- STEP TIME. No artificial wake — this mirrors the referee, which just ticks the world and never
// touches a prop. On the shipped build the awake props FALL and settle; on --simulate-main the asleep
// props never take a gravity step and stay hanging — which is the whole bug, now visible to a check.
const sleepingAtSpawn = bodies.filter((b) => b.body.isSleeping()).length;
let firstQuiet = -1;
for (let i = 0; i < STEPS; i++) {
  world.step(H);
  if (firstQuiet < 0 && bodies.every((b) => b.body.isSleeping())) firstQuiet = i + 1;
}
const asleepEnd = bodies.filter((b) => b.body.isSleeping()).length;

// Shape-cast a prop's footprint cuboid straight down (excluding self); toi = how far its whole
// FOOTPRINT can still fall before hitting a support. Robust to an edge-rest / slight tilt a single
// centre ray misses. FULL vertical half-extent (so a prop resting in contact reads ~0, not a spurious
// inset gap); horizontal extents shrunk 10% so it doesn't catch a same-height neighbour beside it.
function fallGap(b) {
  const t = b.body.translation();
  const he = halfExtentsFor(catalog[typeById.get(b.id)]);
  const shape = new RAPIER.Cuboid(Math.max(he.hx * 0.9, 0.02), he.hy, Math.max(he.hz * 0.9, 0.02));
  const ownCol = b.body.collider(0);
  const hit = world.world.castShape(
    { x: t.x, y: t.y, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0 },
    shape, 0, 50, true, undefined, undefined, ownCol,
  );
  if (!hit) return Infinity;                                    // nothing under the footprint at all
  const toi = hit.toi != null ? hit.toi : hit.time_of_impact;  // property name varies across builds
  return typeof toi === 'number' ? toi : 0;                    // contact-at-start (already touching) ⇒ resting (0)
}

// ---- INVARIANT 2: RESTING ON A SUPPORT. After settling, nothing may hang in the air.
const floating = [];
const sunk = [];
for (const b of bodies) {
  const p = posById.get(b.id); const label = `${typeById.get(b.id)}@(${p.x.toFixed(1)},${p.z.toFixed(1)})`;
  const gap = fallGap(b);
  if (gap > REST_EPS) floating.push(`${label} ${gap === Infinity ? 'nothing below' : '+' + gap.toFixed(2) + 'm'}`);
  const y = b.body.translation().y;
  if (y < FLOOR_Y - SINK_TOL) sunk.push(`${label} y=${y.toFixed(2)}`);
}
check(floating.length === 0,
  `every dynamic prop RESTS ON a support after ${(STEPS * H).toFixed(0)}s (nothing left hanging in the air)`,
  floating.length ? `${floating.length} still floating: ${floating.slice(0, 8).join('; ')}${floating.length > 8 ? ` … (${tally(floating)})` : ''}` : `all ${bodies.length} props settled onto a support (≤${REST_EPS} m)`);
check(sunk.length === 0, `nothing sank through the floor`, sunk.length ? `${sunk.length}: ${sunk.slice(0, 6).join('; ')}` : `all props above y=${(FLOOR_Y - SINK_TOL).toFixed(1)}`);

console.log(`  · settle: ${sleepingAtSpawn}/${bodies.length} asleep at spawn → ${asleepEnd}/${bodies.length} asleep after ${(STEPS * H).toFixed(0)}s` +
  (firstQuiet > 0 ? `; world fully quiet by ${(firstQuiet * H).toFixed(1)}s` : `; ${bodies.length - asleepEnd} still micro-settling (informational — steady state is quiet)`));

world.destroy();

// ---- SELF-TEST: prove INVARIANT 2 can actually BITE (a check that can't pass by checking nothing).
// The current restaurant map happens to have no fully-airborne prop — grounding+seating leaves every
// item at least edge-supported, so the pre-fix build's headline failure is INVARIANT 1 (immovable
// props). To prove the "rests on a support" assertion is NOT vacuous, stand up a tiny world with one
// box RESTING on the ground and one box HANGING 1 m in the air, run the SAME footprint shape-cast, and
// assert it passes the rester and flags the floater. If this ever regresses, the resting check is broken.
{
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  w.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0)); // ground, top at y=0
  const restBody = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.5, 0));   // box ON the ground
  const restCol = w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), restBody);
  const floatBody = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(5, 1.5, 0));  // box 1 m in the air
  const floatCol = w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), floatBody);
  w.step();
  const cast = (body, ownCol) => {
    const t = body.translation();
    const hit = w.castShape({ x: t.x, y: t.y, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0 },
      new RAPIER.Cuboid(0.45, 0.5, 0.45), 0, 50, true, undefined, undefined, ownCol);
    if (!hit) return Infinity;
    const toi = hit.toi != null ? hit.toi : hit.time_of_impact; // property name varies across builds
    return typeof toi === 'number' ? toi : 0; // a contact-at-start hit with no toi ⇒ resting (0)
  };
  const restGap = cast(restBody, restCol);
  const floatGap = cast(floatBody, floatCol);
  check(restGap <= REST_EPS && floatGap > REST_EPS,
    `SELF-TEST: the resting check bites (flags a 1 m-airborne box, passes a grounded one)`,
    `rester gap ${restGap.toFixed(2)}m (≤${REST_EPS} ✓), floater gap ${floatGap === Infinity ? '∞' : floatGap.toFixed(2)}m (>${REST_EPS} ✓)`);
  w.free();
}

console.log('');
if (failures) {
  console.error(`settle test FAILED (${failures} problem${failures > 1 ? 's' : ''})` + (SIMULATE_MAIN ? ' — EXPECTED under --simulate-main (this is the pre-fix "before" evidence)' : ''));
  process.exit(1);
}
if (SIMULATE_MAIN) { console.error('settle test PASSED under --simulate-main — the check FAILED TO BITE (it should fail on the pre-fix build). Investigate.'); process.exit(2); }
console.log('settle test passed');
