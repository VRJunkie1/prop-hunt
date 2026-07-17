#!/usr/bin/env node
// FLOATING-FIXED-PROPS GUARD (round 4, 2026-07-17, VRmike). Proves that NOTHING in any map is a
// fixed, immovable collider unless it is genuinely world ARCHITECTURE or WALL-ATTACHED — and that
// every dynamic prop spawns RESTING on the collider beneath it, never embedded in a taller hull
// where it would launch. AUTHORING-ONLY: never imported by the page or shipped to a browser (like
// the other tools/check-*.mjs). Pure, zero-dependency, runs on a bare `node` with no install and no
// network, so it is a real pre-ship gate.
//
// WHY THIS EXISTS. Round 4 of the physics saga. 75c900e made everything a physics object but kept a
// `pinClutterAboveY` PIN: any prop authored to rest above 0.5 m (plates, food, dishes, condiments on
// counters/tables) stayed a FIXED collider hanging at its authored height. VRmike's screenshot: those
// plates hung in mid-air (a player could stand on them) and jittered nearby dynamic bodies (a fixed
// body is an infinite-mass obstacle the solver keeps fighting). VRmike's standing instruction is the
// opposite: EVERYTHING non-architecture is a dynamic body that falls; only wall/architecture-attached
// pieces (doors, vents, structural pillars) stay fixed. This guard, keyed to the physics classifier
// (shared/physics.js isFixedBodyEntry) — NOT the disguise list — fails the build if that rule is ever
// violated, so round 5 can't happen silently.
//
// It reads the SAME collider footprints the engine uses (halfExtentsFor) and the SAME load pipeline
// js/config.js runs (groundMapData then seatMapData), so "the check", "what loads" and "what the
// engine builds" cannot drift. It asserts:
//
//   (A) NO STOWAWAY FIXED BODIES — no object is a fixed collider unless isFixedBodyEntry (architecture
//       OR wall-attached). Run with --assume-pin=<y> to simulate main's pin and watch it name every
//       surface prop the pin would freeze (the demonstration the request asks for).
//   (B) NO FLOATING FIXED PIECES — a floor-standing fixed piece (a pillar) rests on the floor, not in
//       the air. Architecture (headers/ceilings) + mounted door/vent are trusted and exempt.
//   (C) NOTHING SPAWNS EMBEDDED — after seating, no dynamic item's base sits inside the collider
//       beneath it (which would launch it out as a rigid body). This is what the seating pass buys.
//   (D) THE CHECK PROVES ITSELF — a synthetic map with a known floating fixed prop, a known embedded
//       prop, a correctly-seated prop, a floor-standing pillar and a mounted vent shows the inspectors
//       flag exactly the two broken pieces and clear the good ones. So it can never "pass by checking
//       nothing".
//
// Run:  node tools/check-floating-props.mjs                 (the shipping build — must PASS)
//       node tools/check-floating-props.mjs --assume-pin=0.5 (simulate main's pin — must FAIL, names plates)
// Exit: 0 = clean, 1 = a stowaway/floating/embedded piece or a broken inspector.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  groundMapData, seatMapData, findFloatingProps, findEmbedded, SEAT_TOL, GROUND_TOL,
} from '../shared/grounding.js';
import { isFixedBodyEntry, isArchEntry, isWallAttachedEntry } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (name) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', name), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const rules = cfg('rules.json');
const assetDims = cfg('asset-dims.json');

// Attach the SAME measured + convex-hull seams js/config.js attaches, so halfExtentsFor sees the
// shipping collider footprints — otherwise the guard would reason about primitive fallbacks the
// game never uses. (Identical to tools/check-grounding.mjs.)
let hullDefs = {};
try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch { hullDefs = {}; }
const dims = (assetDims && assetDims.dims) || {};
for (const [type, box] of Object.entries(dims)) {
  if (!box || !(box.w > 0 && box.h > 0 && box.d > 0)) continue;
  const m = { w: box.w, h: box.h, d: box.d };
  if (props[type]) props[type].measured = m;
  if (fixtures[type]) fixtures[type].measured = m;
}
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb || !(h.aabb.w > 0 && h.aabb.h > 0 && h.aabb.d > 0)) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = h.aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };

// --assume-pin=<y>: simulate a y-threshold pin (as main ships in rules.pinClutterAboveY) so the
// demonstration run can watch the guard name the plates it would freeze. Absent => read the live
// config (the shipping build has no pin, so the guard passes).
const argPin = process.argv.slice(2).map((a) => /^--assume-pin=(.+)$/.exec(a)).find(Boolean);
const pinY = argPin ? Number(argPin[1]) : (rules && rules.pinClutterAboveY != null ? rules.pinClutterAboveY : null);

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

console.log('floating-fixed-props check (nothing non-architecture is a fixed collider; nothing spawns embedded)');
if (pinY != null) console.log(`  [simulating a y>${pinY} pin — expecting failures that name the frozen surface props]`);
console.log('');

for (const [mapId, map] of Object.entries(maps)) {
  console.log(`map "${mapId}":`);
  // Same load pipeline as js/config.js: ground first, then evaluate the pin against the pre-seat
  // heights (main pinned before any seating existed), then seat, then check embedding.
  groundMapData(map, catalog);
  const bad = findFloatingProps(map, catalog, { pinY });
  const pinned = bad.filter((b) => b.kind === 'pinned');
  const floating = bad.filter((b) => b.kind === 'floating');

  // (A) no stowaway fixed bodies.
  if (pinned.length === 0) {
    ok(true, `(A) every fixed collider is architecture or wall-attached — nothing else is frozen`);
  } else {
    for (const b of pinned) {
      ok(false, `(A) STOWAWAY FIXED "${b.type}" @ (${b.x},${b.z}) y=${b.base.toFixed(2)} — ${b.reason}`);
    }
    console.log(`     (${pinned.length} surface prop${pinned.length > 1 ? 's' : ''} would hang FIXED in mid-air — must be dynamic)`);
  }

  // (B) no floating floor-standing fixed pieces.
  if (floating.length === 0) {
    ok(true, `(B) every floor-standing fixed piece (pillars) rests on the floor`);
  } else {
    for (const b of floating) {
      ok(false, `(B) FLOATING FIXED "${b.type}" @ (${b.x},${b.z}) y=${b.base.toFixed(2)} floor=${b.floor.toFixed(2)} — ${b.reason}`);
    }
  }

  // (C) nothing spawns embedded (would launch). Evaluated AFTER seating.
  seatMapData(map, catalog);
  const embedded = findEmbedded(map, catalog);
  if (embedded.length === 0) {
    ok(true, `(C) every dynamic item spawns resting on its support (nothing embedded > ${SEAT_TOL} m)`);
  } else {
    for (const e of embedded) {
      ok(false, `(C) EMBEDDED "${e.type}" @ (${e.x},${e.z}) base=${e.base.toFixed(2)} sits ${e.embed.toFixed(2)} m INSIDE the collider top (${e.supportTop.toFixed(2)}) — would launch`);
    }
  }
}

// ---- (D) the inspectors actually detect + the pass fixes (self-test) --------------------------
console.log('\nself-test (synthetic map):');
const testCatalog = {
  wall: { shape: 'box', w: 2, h: 3, d: 0.4, arch: true },              // architecture, any height
  pillar_t: { shape: 'box', w: 0.5, h: 3, d: 0.5, wallAttached: true }, // floor-standing fixed
  vent_t: { shape: 'box', w: 1, h: 0.6, d: 1, wallAttached: true, noGround: true }, // mounted, exempt
  tabletall: { shape: 'box', w: 2, h: 1.4, d: 2 },                     // dynamic, tall hull
  plate_t: { shape: 'cylinder', r: 0.4, h: 0.1 },                      // dynamic clutter
};
// Build a fresh map each assertion (seat mutates in place).
const mk = () => ({
  size: 20,
  fixtures: [
    { type: 'wall', x: -8, z: 0, y: 2.0 },        // arch mounted high -> NOT flagged (B)
    { type: 'pillar_t', x: 8, z: 8, y: 1.5 },     // floor-standing fixed hanging -> FLAG (B)
    { type: 'vent_t', x: 0, z: -8, y: 2.0 },      // mounted noGround -> NOT flagged (B)
    { type: 'tabletall', x: 0, z: 0 },            // top at 1.4
    { type: 'plate_t', x: 0, z: 0, y: 0.8 },      // authored INSIDE the tall hull -> EMBED (C), and pinned (A) if pinY
  ],
});

// (A) with a pin, the plate (y=0.8 > 0.5) is a stowaway fixed body.
const mA = mk(); groundMapData(mA, testCatalog);
const aPinned = findFloatingProps(mA, testCatalog, { pinY: 0.5 }).filter((b) => b.kind === 'pinned');
ok(aPinned.length === 1 && aPinned[0].type === 'plate_t', '(A) a y>pin surface prop is flagged as a stowaway fixed body');
// ...and with NO pin it is clean (it is just a dynamic body).
const aClean = findFloatingProps(mk(), testCatalog, { pinY: null }).filter((b) => b.kind === 'pinned');
ok(aClean.length === 0, '(A) with no pin, the same surface prop is NOT flagged (it is dynamic)');

// (B) the hanging pillar is caught; the high wall + mounted vent are not. Run on the RAW map (no
// grounding) — groundMapData would otherwise auto-drop the orphan pillar before the inspector sees
// it (in the real pipeline that auto-fix is exactly why floor-standing fixed pieces never float).
const bFloat = findFloatingProps(mk(), testCatalog, { pinY: null }).filter((b) => b.kind === 'floating');
ok(bFloat.length === 1 && bFloat[0].type === 'pillar_t', '(B) a floor-standing fixed piece hanging in the air is flagged');
ok(!bFloat.some((b) => b.type === 'wall' || b.type === 'vent_t'), '(B) high architecture + a mounted vent are NOT flagged');

// (C) before seating the plate is embedded; seatMapData raises it onto the hull top; then clean.
const mC = mk(); groundMapData(mC, testCatalog);
const beforeSeat = findEmbedded(mC, testCatalog);
ok(beforeSeat.length === 1 && beforeSeat[0].type === 'plate_t', '(C) an embedded prop is detected before seating');
const seated = seatMapData(mC, testCatalog);
ok(seated.some((s) => s.type === 'plate_t' && Math.abs(s.to - 1.4) < 1e-6), '(C) seatMapData raises the embedded plate onto the hull top (0.8 -> 1.4)');
ok(findEmbedded(mC, testCatalog).length === 0, '(C) after seating, nothing is embedded');
ok(seatMapData(mC, testCatalog).length === 0, '(C) seating is idempotent (a second pass moves nothing)');

// ---- exemption-set sanity: the fixed set is exactly architecture + wall-attached ---------------
console.log('\nclassification sanity (real catalog):');
const fixedTypes = Object.entries(catalog).filter(([, c]) => c && isFixedBodyEntry(c)).map(([t]) => t).sort();
const wallAtt = Object.entries(catalog).filter(([, c]) => isWallAttachedEntry(c)).map(([t]) => t).sort();
const badFixed = fixedTypes.filter((t) => !(isArchEntry(catalog[t]) || isWallAttachedEntry(catalog[t])));
ok(badFixed.length === 0, `every fixed catalog entry is architecture or wall-attached (fixed: ${fixedTypes.join(', ')})`);
ok(wallAtt.length > 0, `wall-attached pieces are tagged (${wallAtt.join(', ') || 'none'})`);

console.log('');
if (fails) {
  console.error(`floating-fixed-props check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('floating-fixed-props check passed');
