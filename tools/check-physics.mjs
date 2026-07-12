#!/usr/bin/env node
// PHYSICS ALIGNMENT GUARD — solidity pass #4 (relaunch #2). AUTHORING-ONLY: never imported
// by the page or shipped to a browser (like tools/check-blindfold.mjs and the other
// tools/check-*.mjs). A pure, zero-dependency, deterministic check that runs on a bare
// `node` with no install and no network, so it is a real pre-ship gate.
//
// WHY THIS EXISTS (the four-attempt lesson). Physics kept "passing a check" while the live
// game was broken because the check and the engine derived collider geometry from DIFFERENT
// code. This guard reads the ONE shared source — shared/bounds.js — the SAME function the
// engine's collider math and the ?debug=1 in-world overlay read. So "the check", "what you
// SEE", and "what the engine builds" cannot drift.
//
// It asserts the two invariants the player report demanded (2026-07-11, Jie):
//
//   MISALIGNMENT GUARD — every collider's world AABB actually OVERLAPS its visual mesh's
//     AABB, and the collider is not SMALLER than the mesh (no gap a player can phase into,
//     and the "invisible wall in empty space / ghost prop with no collision" symptom is
//     impossible because collider and mesh coincide). Round colliders (cylinder/sphere)
//     hug the body and are intentionally tighter than the GLB's square bbox — reported,
//     not failed (matches tools/check-physics-solidity.mjs).
//
//   OPEN-MIDDLE GUARD — every spawn point AND the hunter spawn is collider-free at player
//     height (a player can actually STAND there, never trapped inside/against an invisible
//     collider), and no static fixture collider is absurdly oversized (a blown-up transform
//     that would enclose the arena — the "confined to a strip along a wall" symptom).
//
// Sizes/placements come from shared/bounds.js (which itself reuses the SAME pure helpers
// shared/physics.js builds real colliders from). Mesh sizes are derived the way js/scene.js
// scales GLBs (native bbox from asset-dims.json × the map's modelScale, an exact
// modelDims/measured override, or the primitive for a model-less entry).
//
// This is a GEOMETRY guard. The runtime "bounce off a prop" depenetration regression fixed
// this pass (physics.js _isPenetrating scoped to static-world colliders) is BEHAVIOURAL and
// can only be confirmed in a live browser playtest — called out honestly in the notes.
//
// Run:  node tools/check-physics.mjs
// Exit: 0 = all invariants hold, 1 = a geometry invariant was violated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FLOOR_Y } from '../shared/physics.js';
import {
  worldColliderBoxes,
  propColliderBoxes,
  meshSize,
  pointInBox,
  GROUND_SLAB_HALF_Y,
  WALL_INSET,
  WALL_HALF_THICK,
} from '../shared/bounds.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (name) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', name), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const rules = cfg('rules.json');
const assetDims = cfg('asset-dims.json'); // native GLB bboxes, keyed by GLB path

const TOL = 0.05; // 5 cm slack on every size comparison (rounding in the authored data)
const playerRadius = rules.playerRadius ?? 0.4;
const playerHalfHeight = rules.playerHalfHeight ?? 0.5;
const capsuleMidY = playerRadius + playerHalfHeight; // capsule centre when foot at FLOOR_Y

let fails = 0;
let unverified = 0;
const notes = [];
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};
const note = (msg) => notes.push(msg);

// 1D overlap of two centred intervals.
const overlaps1D = (cA, hA, cB, hB) => Math.abs(cA - cB) <= hA + hB + 1e-9;

console.log('physics alignment check (collider ⇔ mesh + open middle), one shared source\n');

// ---- GLOBAL constant sanity (shared/bounds.js ⇔ physics.js _buildStatic) ----------------
console.log('config:');
ok(FLOOR_Y === 0, `FLOOR_Y == 0 (ground slab top + every clamp key off this)`);
ok(GROUND_SLAB_HALF_Y === 1.5, `ground slab half-thickness 1.5 (top on FLOOR_Y, extended down)`);
ok(WALL_HALF_THICK === 0.75 && WALL_INSET === 0.5, `boundary wall constants match the engine`);

for (const [mapId, map] of Object.entries(maps)) {
  const catalog = { ...props, ...fixtures };
  const mapScale = typeof map.modelScale === 'number' ? map.modelScale : undefined;
  const half = map.size / 2;
  console.log(`\nmap "${mapId}" (size ${map.size}${mapScale ? `, modelScale ${mapScale}` : ''}):`);

  // ---- MISALIGNMENT: static fixtures --------------------------------------------------
  // worldColliderBoxes appends static fixtures (kind 'fixture') in map.fixtures order,
  // after ground + the 4 walls — so the i-th 'fixture' box pairs with the i-th static
  // fixture record. Zip them to compare collider vs mesh per instance.
  const worldBoxes = worldColliderBoxes(map, catalog, rules);
  const fixtureBoxes = worldBoxes.filter((b) => b.kind === 'fixture');
  const staticFixtures = (map.fixtures || []).filter((f) => catalog[f.type] && catalog[f.type].static);
  ok(fixtureBoxes.length === staticFixtures.length, `static-fixture collider count matches static fixture records (${fixtureBoxes.length})`);

  const reportedTypes = new Set();
  for (let i = 0; i < Math.min(fixtureBoxes.length, staticFixtures.length); i++) {
    const box = fixtureBoxes[i];
    const f = staticFixtures[i];
    const c = catalog[f.type];
    const ms = meshSize(c, mapScale, assetDims);
    if (!ms) {
      unverified++;
      if (!reportedTypes.has(f.type)) { note(`"${f.type}" (map ${mapId}): mesh size unverifiable (GLB "${c.model}" not in asset-dims.json)`); reportedTypes.add(f.type); }
      continue;
    }
    // Mesh AABB: same x/z as the collider (both placed at f.x/f.z, same yaw); base rests
    // on f.y, so mesh centre y = meshH/2 + f.y.
    const meshCy = ms.h / 2 + (f.y || 0);
    const meshHx = ms.w / 2, meshHy = ms.h / 2, meshHz = ms.d / 2;
    // (a) collider AABB overlaps mesh AABB in ALL THREE axes (catches a wrong-axis /
    //     offset placement: an invisible wall displaced from its mesh would NOT overlap).
    const over =
      overlaps1D(box.cx, box.hx, f.x, meshHx) &&
      overlaps1D(box.cz, box.hz, f.z, meshHz) &&
      overlaps1D(box.cy, box.hy, meshCy, meshHy);
    // (b) collider is not SMALLER than the mesh (no gap to phase through, no top-face gap).
    const notSmaller =
      2 * box.hx >= ms.w - TOL && 2 * box.hz >= ms.d - TOL && 2 * box.hy >= ms.h - TOL;
    if (!reportedTypes.has(f.type)) {
      ok(over, `"${f.type}" collider AABB overlaps its mesh AABB (no displaced/invisible wall)`);
      ok(
        notSmaller,
        `"${f.type}" collider not smaller than mesh ` +
          `(${(2 * box.hx).toFixed(2)}×${(2 * box.hy).toFixed(2)}×${(2 * box.hz).toFixed(2)} vs mesh ` +
          `${ms.w.toFixed(2)}×${ms.h.toFixed(2)}×${ms.d.toFixed(2)})`
      );
      reportedTypes.add(f.type);
    } else if (!over || !notSmaller) {
      // A later instance of an already-passed type diverged (different f.y etc.) — surface it.
      ok(over && notSmaller, `"${f.type}" @ (${f.x},${f.z}) collider still aligns with its mesh`);
    }
  }

  // ---- MISALIGNMENT: props (disguise pool + knockable fixtures) -----------------------
  const propBoxes = propColliderBoxes(map, catalog);
  const propReported = new Set();
  let roundSkipped = 0;
  for (const box of propBoxes) {
    const c = catalog[box.type];
    if (!box.box) { roundSkipped++; continue; } // round collider hugs the body, not the bbox
    if (propReported.has(box.type)) continue;
    const ms = meshSize(c, mapScale, assetDims);
    if (!ms) {
      unverified++;
      note(`prop "${box.type}" (map ${mapId}): mesh size unverifiable (GLB "${c.model}" not in asset-dims.json)`);
      propReported.add(box.type);
      continue;
    }
    const notSmaller = 2 * box.hx >= ms.w - TOL && 2 * box.hz >= ms.d - TOL && 2 * box.hy >= ms.h - TOL;
    ok(
      notSmaller,
      `prop "${box.type}" collider not smaller than mesh ` +
        `(${(2 * box.hx).toFixed(2)}×${(2 * box.hy).toFixed(2)}×${(2 * box.hz).toFixed(2)} vs mesh ` +
        `${ms.w.toFixed(2)}×${ms.h.toFixed(2)}×${ms.d.toFixed(2)}) — no gap to phase into`
    );
    propReported.add(box.type);
  }
  if (roundSkipped) note(`map ${mapId}: ${roundSkipped} round (cyl/sphere) prop collider(s) hug the body by design — not bbox-checked.`);

  // ---- OPEN MIDDLE: spawns + hunter spawn are stand-able ------------------------------
  // A player must be able to STAND at every spawn and at the hunter spawn (the natural
  // open centre) without their capsule footprint being inside any WORLD collider (walls +
  // static fixtures; the ground slab is below the floor by design, so it's excluded). This
  // is the direct guard against "trapped in a strip / can't reach the middle".
  // WALKABLE FLOORS are excluded too: a floor fixture (kind 'fixture', floor:true) holds
  // its visible top flush at the surface and extends its collider DOWNWARD (bounds.js "fix
  // #5"), so a player STANDS ON it — like the ground slab — rather than being blocked by
  // it. Without this, the capsule-radius vertical padding makes a spawn standing on a floor
  // read as "trapped" (the kitchen floor tiles under the z=-2 restaurant spawns).
  const worldSolids = worldBoxes.filter((b) => b.kind !== 'ground' && !b.floor);
  const standPoints = [...(map.spawns || [])];
  if (map.hunterSpawn) standPoints.push({ ...map.hunterSpawn, _hunter: true });
  for (const s of standPoints) {
    // Sample the capsule across its height; block if any world collider contains it
    // (padded by the capsule radius so we require real clearance, not a tangent).
    const label = s._hunter ? 'hunter spawn' : `spawn (${s.x},${s.z})`;
    let blockedBy = null;
    for (const b of worldSolids) {
      for (const sy of [FLOOR_Y + 0.1, capsuleMidY, capsuleMidY + playerHalfHeight]) {
        if (pointInBox(b, s.x, sy, s.z, playerRadius)) { blockedBy = b.type; break; }
      }
      if (blockedBy) break;
    }
    ok(!blockedBy, `${label} is collider-free (player can stand)${blockedBy ? ` — blocked by ${blockedBy}` : ''}`);
  }

  // ---- OPEN MIDDLE: no absurdly oversized fixture collider ----------------------------
  // A blown-up transform (wrong scale / coordinate space) turns a small fixture into a
  // giant box that encloses the play area. Cap any single static fixture collider's
  // horizontal half-extent well under the arena so such a blow-up fails loudly.
  const maxFixtureHalf = half * 0.5;
  for (const b of fixtureBoxes) {
    if (b.hx > maxFixtureHalf || b.hz > maxFixtureHalf) {
      ok(false, `fixture "${b.type}" collider half-extent (${b.hx.toFixed(1)}×${b.hz.toFixed(1)}) within arena bound (< ${maxFixtureHalf.toFixed(1)}) — not a blown-up transform`);
    }
  }
  ok(true, `no static fixture collider exceeds the arena-size sanity bound (${maxFixtureHalf.toFixed(1)})`);
}

console.log('');
if (notes.length) {
  console.log('notes:');
  for (const n of notes) console.log('  • ' + n);
  console.log('');
}
if (unverified) console.log(`(${unverified} size(s) unverifiable — GLBs not in asset-dims.json; these keep the authored primitive footprint, which equals the drawn mesh by construction.)\n`);

if (fails) {
  console.error(`physics alignment check FAILED (${fails} invariant${fails > 1 ? 's' : ''} violated)`);
  process.exit(1);
}
console.log('physics alignment check passed');
