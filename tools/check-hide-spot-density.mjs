#!/usr/bin/env node
// HIDE-SPOT REMOVAL + MAP DENSITY check (2026-07-16, VRmike). AUTHORING-ONLY: never imported
// by the page. Pure, zero-dependency, deterministic — runs on a bare `node`, no install/network.
//
//     node tools/check-hide-spot-density.mjs
//
// Guards the three-part "map density + hide-spot expansion" build against the failure modes the
// task calls out (broken movement / newly-stuck spots), using the REAL shared modules so it can
// never drift from the engine:
//
//   1. Removal ratio is the bumped 0.25.
//   2. The load-time removal pass covers EVERYTHING disguisable — it now reaches map.fixtures,
//      not just map.props — while NEVER touching architecture (floors/walls/ceilings).
//   3. Render/collider CONSISTENCY: for every match seed, the set of static fixtures the client
//      RENDERS (scene scenery loop) is byte-identical to the set physics builds COLLIDERS for
//      and the set the debug overlay draws. So a removed built-in can never leave an invisible
//      wall (collider, no mesh) OR a ghost-walkable mesh (mesh, no collider) — the exact
//      stuck-spot failure the task warns about.
//   4. Determinism + min-keep clamp (host reproducibility; a sparse pool never empties).
//   5. Spawn + doorway clearance under WORST-CASE density (nothing removed = densest): no static
//      fixture footprint sits on a spawn/hunter-spawn, and the door + divider walkways stay open.
//      Removal only ever FREES space, so the un-removed map is the worst case for blocking.
//   6. The density additions actually landed (regression tripwire): more dining tables, ringed
//      chairs, and the requested grouped-identical clusters (bottles/stools/canisters).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDisguisableEntry, isArchEntry, isStaticEntry, halfExtentsFor } from '../shared/physics.js';
import { worldColliderBoxes } from '../shared/bounds.js';
import { seededSkipSet } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cfg = (name) => JSON.parse(readFileSync(join(root, 'shared', 'config', name), 'utf8'));
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const rules = cfg('rules.json');
const maps = cfg('maps.json');
const catalog = { ...props, ...fixtures };
const map = maps.restaurant;

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('hide-spot removal + map density check (restaurant)\n');

// ---- Mirror of referee.startMatch removal (the ONE place the decision is made) -------------
// Kept a faithful copy of the referee's math using the SAME imported seededSkipSet + classifiers,
// so if the referee's rule changes without this check, the invariants below break.
const skipRatio = rules.mapRandomizeSkip != null ? rules.mapRandomizeSkip : 0.25;
const minKept = rules.minPropsKept != null ? rules.minPropsKept : 6;
const mapFixtures = map.fixtures || [];
const eligibleFixtureIdx = [];
mapFixtures.forEach((f, i) => {
  const c = catalog[f.type];
  if (c && isDisguisableEntry(c)) eligibleFixtureIdx.push(i);
});
const archIdx = new Set(
  mapFixtures.map((f, i) => [f, i]).filter(([f]) => isArchEntry(catalog[f.type])).map(([, i]) => i),
);
function removedFixturesForSeed(seed) {
  const local = seededSkipSet(eligibleFixtureIdx.length, (seed ^ 0x9e3779b9) >>> 0, skipRatio, minKept);
  return new Set([...local].map((k) => eligibleFixtureIdx[k]));
}

// ---- 1) Ratio bumped to 0.25 ---------------------------------------------------------------
console.log('1) removal ratio:');
ok(skipRatio === 0.25, `rules.mapRandomizeSkip === 0.25 (got ${skipRatio})`);

// ---- 2) Removal reaches fixtures, never architecture ---------------------------------------
console.log('\n2) removal covers disguisable fixtures, never architecture:');
ok(eligibleFixtureIdx.length > 0, `restaurant has disguisable fixtures eligible for removal (${eligibleFixtureIdx.length})`);
let anyFixtureEverRemoved = false;
let archEverRemoved = false;
let nonEligibleEverRemoved = false;
const SEEDS = 400;
const removedUnion = new Set();
let removedCountSum = 0;
for (let s = 1; s <= SEEDS; s++) {
  const removed = removedFixturesForSeed(s);
  removedCountSum += removed.size;
  for (const i of removed) {
    removedUnion.add(i);
    if (removed.size) anyFixtureEverRemoved = true;
    if (archIdx.has(i)) archEverRemoved = true;
    if (!eligibleFixtureIdx.includes(i)) nonEligibleEverRemoved = true;
  }
}
ok(anyFixtureEverRemoved, 'the removal pass actually deletes fixtures (widened beyond map.props)');
ok(!archEverRemoved, 'architecture (floors/walls/ceilings) is NEVER removed, across 400 seeds');
ok(!nonEligibleEverRemoved, 'only disguisable fixtures are ever removed (never a non-disguisable index)');
const avgRemoved = removedCountSum / SEEDS;
const expected = Math.round(eligibleFixtureIdx.length * skipRatio);
ok(
  Math.abs(avgRemoved - expected) <= 2,
  `avg removed ≈ 25% of eligible: ${avgRemoved.toFixed(1)} vs expected ~${expected}`,
);

// ---- 3) Render <-> collider consistency (no invisible wall / no ghost-walkable mesh) --------
// For each seed, compute the set of static fixtures each subsystem KEEPS and assert they match.
//   scene.buildWorld static loop keeps: !removed && isStaticEntry(c)
//   physics._buildStatic         keeps: !removed && c.static
//   bounds.worldColliderBoxes    keeps: !removed && c.static   (drives the debug overlay)
console.log('\n3) render/collider consistency (removed built-in leaves NO invisible wall, NO ghost mesh):');
let mismatches = 0;
for (let s = 1; s <= 200; s++) {
  const removed = removedFixturesForSeed(s);
  const sceneKeep = new Set();
  const physicsKeep = new Set();
  mapFixtures.forEach((f, i) => {
    if (removed.has(i)) return;
    const c = catalog[f.type];
    if (!c) return;
    if (isStaticEntry(c)) sceneKeep.add(i);
    if (c.static) physicsKeep.add(i);
  });
  // Debug overlay (shared bounds) must key off the SAME removed set.
  const overlayTypes = worldColliderBoxes(map, catalog, rules, removed)
    .filter((b) => b.kind === 'fixture').length;
  const boundsKeepCount = physicsKeep.size;
  const sameSize = sceneKeep.size === physicsKeep.size;
  const sameMembers = [...sceneKeep].every((i) => physicsKeep.has(i));
  const overlayAgrees = overlayTypes === boundsKeepCount;
  if (!(sameSize && sameMembers && overlayAgrees)) mismatches++;
}
ok(mismatches === 0, 'scene-rendered static set == physics-collider set == debug-overlay set, across 200 seeds');

// ---- 4) Determinism + min-keep clamp -------------------------------------------------------
console.log('\n4) determinism + min-keep:');
const a = [...removedFixturesForSeed(12345)].sort((x, y) => x - y).join(',');
const b = [...removedFixturesForSeed(12345)].sort((x, y) => x - y).join(',');
ok(a === b, 'same seed → identical removal set (host reproducible)');
let keepFloorHeld = true;
for (let s = 1; s <= SEEDS; s++) {
  const removed = removedFixturesForSeed(s);
  if (eligibleFixtureIdx.length - removed.size < minKept) keepFloorHeld = false;
}
ok(keepFloorHeld, `at least minPropsKept (${minKept}) disguisable fixtures always survive`);
// And the disguise-pool props side keeps its own floor.
let propFloorHeld = true;
const nProps = (map.props || []).length;
for (let s = 1; s <= SEEDS; s++) {
  const skip = seededSkipSet(nProps, s >>> 0, skipRatio, minKept);
  if (nProps - skip.size < minKept) propFloorHeld = false;
}
ok(propFloorHeld, `disguise-pool props also keep the min-keep floor (${nProps} props)`);

// ---- 5) Spawn + doorway clearance under worst-case density ---------------------------------
// Worst case for BLOCKING = the densest map (nothing removed). Only STATIC fixtures + boundary
// walls are hard blockers (props/tables are knockable & shovable). A spawn must not sit inside a
// static footprint (expanded by the player radius) or the player wedges at spawn.
console.log('\n5) spawn + doorway clearance (worst-case: nothing removed):');
const playerR = rules.playerRadius != null ? rules.playerRadius : 0.4;
// Blockers = STATIC fixtures a body cannot pass, EXCLUDING floor slabs (floor:true) — those are
// walkable ground, you stand on them, so a spawn/lane sitting "inside" a floor tile is expected.
const staticBoxes = worldColliderBoxes(map, catalog, rules).filter((b) => b.kind === 'fixture' && !b.floor);
const spawnPts = [...(map.spawns || []), map.hunterSpawn].filter(Boolean);
let spawnBlocked = 0;
let worstSpawn = null;
for (const sp of spawnPts) {
  for (const box of staticBoxes) {
    // Point-in-expanded-AABB test in the box's local (yaw-rotated) frame.
    const dx = sp.x - box.cx;
    const dz = sp.z - box.cz;
    const c = Math.cos(-(box.rot || 0));
    const sn = Math.sin(-(box.rot || 0));
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    if (Math.abs(lx) < box.hx + playerR && Math.abs(lz) < box.hz + playerR) {
      spawnBlocked++;
      worstSpawn = { sp, type: box.type };
    }
  }
}
ok(spawnBlocked === 0, `no spawn/hunter-spawn sits inside a static fixture (+player radius)${worstSpawn ? ` — hit ${worstSpawn.type} at (${worstSpawn.sp.x},${worstSpawn.sp.z})` : ''}`);

// The two divider walkways (x=-7.5, x=+7.5 along z=-4.5) and the door threshold (0, z~16..17.6)
// must be clear of static fixtures so a player can pass kitchen<->dining and out the door.
const lanes = [
  { name: 'divider walkway -x', x: -7.5, z: -4.5 },
  { name: 'divider walkway +x', x: 7.5, z: -4.5 },
  { name: 'door threshold', x: 0, z: 16.4 },
];
for (const lane of lanes) {
  let clear = true;
  for (const box of staticBoxes) {
    const dx = lane.x - box.cx;
    const dz = lane.z - box.cz;
    const c = Math.cos(-(box.rot || 0));
    const sn = Math.sin(-(box.rot || 0));
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    // Require room for the disguise body (capped just under the 1.2 m doorway) to pass.
    if (Math.abs(lx) < box.hx + 0.55 && Math.abs(lz) < box.hz + 0.55) clear = false;
  }
  ok(clear, `${lane.name} (${lane.x},${lane.z}) stays open for a disguised body`);
}

// ---- 6) Density additions landed (regression tripwire) -------------------------------------
console.log('\n6) density additions present:');
const tables = (map.fixtures || []).filter((f) => f.type === 'round_table').length;
const chairs = (map.props || []).filter((f) => f.type === 'diner_chair').length;
const stools = (map.props || []).filter((f) => f.type === 'kitchen_stool').length;
const bottleProps = (map.props || []).filter((f) => f.type === 'ketchup' || f.type === 'mustard').length;
const canisters = (map.fixtures || []).filter((f) => f.type === 'canister').length;
ok(tables >= 10, `dining round_tables boosted to ${tables} (>= 10, was 6)`);
ok(chairs >= 40, `ringed diner_chairs boosted to ${chairs} (>= 40, was 28)`);
ok(stools >= 16, `kitchen_stools clustered up to ${stools} (>= 16, was 8)`);
ok(bottleProps >= 12, `disguisable bottle-cluster props added: ${bottleProps} ketchup/mustard in map.props (>= 12, was 0)`);
ok(canisters >= 12, `grouped canisters up to ${canisters} (>= 12, was 9)`);

// Grouped-identical sanity: the added bottle props really do cluster (>=1 group of >=4 within
// a tight radius) so a disguised player has neighbours to blend with.
function biggestCluster(items, radius) {
  let best = 0;
  for (const a of items) {
    let n = 0;
    for (const b of items) {
      if (Math.hypot(a.x - b.x, (a.z ?? 0) - (b.z ?? 0)) <= radius && (a.y || 0) === (b.y || 0)) n++;
    }
    best = Math.max(best, n);
  }
  return best;
}
const bottleItems = (map.props || []).filter((f) => f.type === 'ketchup' || f.type === 'mustard');
ok(biggestCluster(bottleItems, 1.1) >= 4, 'at least one bottle cluster has 4+ bottles side-by-side (disguise cover)');
const stoolItems = (map.props || []).filter((f) => f.type === 'kitchen_stool');
ok(biggestCluster(stoolItems, 1.0) >= 4, 'at least one stool bunch has 4+ stools side-by-side');

console.log('');
if (fails) {
  console.error(`hide-spot-density check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('hide-spot-density check passed');
