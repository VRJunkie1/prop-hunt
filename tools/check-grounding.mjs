#!/usr/bin/env node
// GROUNDING GUARD — every fixture/prop rests on a real support (nothing floats above a deleted
// support, nothing sinks below the floor). AUTHORING-ONLY: never imported by the page or
// shipped to a browser (like the other tools/check-*.mjs). Pure, zero-dependency, runs on a
// bare `node` with no install and no network, so it is a real pre-ship gate.
//
// WHY THIS EXISTS (VRmike, 2026-07-16). The map-density expansion could leave a prop hovering
// where its counter was moved/deleted, or a piece embedded below the floor — a whole class of
// "floating / sunken object" bugs. This guard reads the SAME collider footprints the engine
// uses (shared/physics.js halfExtentsFor, via shared/grounding.js) and the SAME grounding rule
// js/config.js applies at load, so "the check", "what loads", and "what the engine builds"
// cannot drift. It asserts two things:
//
//   (A) AUTHORED DATA IS CLEAN — no non-exempt piece in maps.json floats (hangs with nothing
//       under it, above its floor) or sinks (base below its floor surface). This FAILS the
//       build on an authoring mistake (e.g. a new canister placed at y=0.75 with no counter
//       beneath) BEFORE the load-time pass silently drops it — so the author fixes the data.
//
//   (B) THE PASS ACTUALLY WORKS — a synthetic map with a known floater, a known sinker, a
//       correctly-supported item and an exempt vent proves groundMapData DROPS the floater,
//       RAISES the sinker, LEAVES the supported item and the vent untouched, and is
//       idempotent. So this guard can never "pass by checking nothing".
//
// EXEMPT (kept as authored): architecture (walls/floors/ceilings) + `noGround` pieces (vents,
// doors). See shared/grounding.js.
//
// Run:  node tools/check-grounding.mjs
// Exit: 0 = grounded + pass verified, 1 = a floater/sinker or a broken pass.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findUngrounded, groundMapData, GROUND_TOL } from '../shared/grounding.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (name) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', name), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const assetDims = cfg('asset-dims.json');

// Attach the SAME measured + convex-hull seams js/config.js attaches, so halfExtentsFor sees
// the shipping collider footprints (heights/AABBs) — otherwise the guard would ground against
// primitive fallbacks the game never uses.
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

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

console.log('grounding check (nothing floats above / sinks below its support)\n');

// ---- (A) authored data is clean ---------------------------------------------------------
for (const [mapId, map] of Object.entries(maps)) {
  const bad = findUngrounded(map, catalog);
  console.log(`map "${mapId}":`);
  if (bad.length === 0) {
    ok(true, `every non-exempt fixture/prop rests on its support (floor/tile or a piece beneath)`);
  } else {
    for (const b of bad) {
      const gap = (b.base - b.floor).toFixed(2);
      ok(false, `${b.kind === 'float' ? 'FLOATING' : 'SUNK'} "${b.type}" @ (${b.x},${b.z}) base=${b.base.toFixed(2)} floor=${b.floor.toFixed(2)} (Δ${gap}m > ${GROUND_TOL}m) — place it on a support or below-tol`);
    }
  }
}

// ---- (B) the pass actually detects + fixes (self-test) ----------------------------------
console.log('\ngrounding-pass self-test (synthetic map):');
const testCatalog = {
  slab: { shape: 'box', w: 2, h: 1, d: 2, static: true },          // a 1m-tall support
  cube: { shape: 'box', w: 0.5, h: 0.5, d: 0.5 },                  // a small groundable prop
  vent: { shape: 'box', w: 1, h: 0.5, d: 1, static: true, noGround: true }, // exempt
};
const testMap = {
  size: 20,
  fixtures: [
    { type: 'slab', x: 5, z: 0 },                     // support @ top y=1
    { type: 'cube', x: 5, z: 0, y: 1 },               // correctly ON the slab -> unchanged
    { type: 'cube', x: -8, z: -8, y: 1.4 },           // ORPHAN floater (nothing under it) -> drop to 0
    { type: 'cube', x: 8, z: 8, y: -0.6 },            // SUNK below floor -> rise to 0
    { type: 'vent', x: 0, z: 0, y: 2.0 },             // exempt -> unchanged even with nothing under
  ],
};
const changes = groundMapData(testMap, testCatalog);
const at = (type, x, z) => testMap.fixtures.find((f) => f.type === type && f.x === x && f.z === z);
ok(Math.abs(at('cube', 5, 0).y - 1) < 1e-9, 'cube resting ON a slab is left untouched (y stays 1.0)');
ok(Math.abs(at('cube', -8, -8).y - 0) < 1e-9, 'orphan floater dropped to the floor (y 1.4 -> 0)');
ok(Math.abs(at('cube', 8, 8).y - 0) < 1e-9, 'sunk piece raised to the floor (y -0.6 -> 0)');
ok(Math.abs(at('vent', 0, 0).y - 2.0) < 1e-9, 'exempt vent left untouched (y stays 2.0)');
ok(changes.length === 2, `exactly the 2 broken pieces were moved (got ${changes.length})`);
const again = groundMapData(testMap, testCatalog);
ok(again.length === 0, 'idempotent: a second pass moves nothing');

// ---- exemption-set sanity: only the intended kinds carry noGround -----------------------
console.log('\nexemption sanity:');
const flagged = Object.entries(catalog).filter(([, c]) => c && c.noGround).map(([t]) => t).sort();
const allowed = new Set(['door', 'extractor']);
const unexpected = flagged.filter((t) => !allowed.has(t));
ok(unexpected.length === 0, `noGround flag only on the intended mounted pieces (${flagged.join(', ') || 'none'})${unexpected.length ? ` — unexpected: ${unexpected.join(', ')}` : ''}`);

console.log('');
if (fails) {
  console.error(`grounding check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('grounding check passed');
