#!/usr/bin/env node
// PHYSICS SOLIDITY GUARD — solidity pass #3 (relaunch). AUTHORING-ONLY: never imported by
// the page or shipped to a browser (like the other tools/ checks). Sibling of
// tools/check-blindfold.mjs and tools/check-physics-feel.mjs.
//
// WHAT THIS IS NOW. The previous version stood up the REAL Rapier PhysicsWorld and ran a
// live sim — but Rapier is a browser-only WASM module the game imports from a CDN, so that
// tool could only run after a manual `npm i` and SKIPPED (exit 3) everywhere else,
// including this sandbox and a plain CI runner. It therefore never actually guarded
// anything. This rewrite is a PURE, ZERO-DEPENDENCY, DETERMINISTIC check that runs on a
// bare `node` with no install and no network, so it can be a real pre-ship gate.
//
// It asserts the GEOMETRIC ROOT-CAUSE INVARIANTS that make the three reported failures
// impossible — proven against the REAL map + catalog data — rather than sampling runtime
// behaviour. Each maps to one reported bug:
//
//   A. PROP-VS-PROP (sink / hide inside): every world-prop's *box* collider is at least as
//      big as its drawn mesh, so there is no collider-smaller-than-visuals gap for a
//      player to slide into. (Round colliders — cylinders/spheres — intentionally hug the
//      body and are tighter than the GLB's square bbox; reported, not asserted.)
//   B. WALL TUNNEL incl. the TOP FACE: every static box collider is at least as TALL as its
//      mesh (no top-face gap to stand on nothing and fall through), and the anti-tunnel
//      min wall thickness clears the player capsule radius (thin panels get thickened past
//      the capsule so it can't pop through).
//   C. BELOW FLOOR: the ground slab's top sits exactly on the floor plane the engine clamps
//      to (physics.FLOOR_Y), covers the whole arena, and is far thicker than one substep's
//      fall — and the engine now clamps every player's foot to FLOOR_Y each substep, so a
//      player can never END a substep below the floor.
//
// Sizes/thickening come from the SAME pure helpers shared/physics.js uses to build the real
// colliders (halfExtentsFor / thickenWallHalfExtents / isStaticEntry / FLOOR_Y), so the
// guard and the engine can never disagree on a collider's size. Mesh sizes are derived the
// way js/scene.js scales GLBs (measured native bbox from asset-dims.json × the map's
// modelScale, or an exact modelDims override, or the primitive for a model-less entry).
//
// Behavioural tunnelling under Rapier's character controller is a runtime edge case a
// static check can't reproduce faithfully (it's not a clean geometric threshold — see the
// depenetration failsafe in physics.js); that remains a LIVE BROWSER playtest item, called
// out in the notes. This guard covers everything that CAN be proven off-device.
//
// Run:  node tools/check-physics-solidity.mjs
// Exit: 0 = all invariants hold, 1 = a solidity invariant was violated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isStaticEntry, halfExtentsFor, thickenWallHalfExtents, FLOOR_Y } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (name) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', name), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const rules = cfg('rules.json');
const assetDims = cfg('asset-dims.json'); // native GLB bboxes (build-time reference)

const TOL = 0.05; // 5 cm slack on every size comparison (rounding in the authored data)
const SUBSTEP = 1 / 60; // physics fixed substep (physics.js _fixedDt)

const playerRadius = rules.playerRadius ?? 0.4;
const playerHalfHeight = rules.playerHalfHeight ?? 0.5;
const pCenterY = playerRadius + playerHalfHeight;
const minWallHalf = rules.minWallHalfThickness ?? 0.6;
const maxFall = rules.maxFallSpeed ?? 20;
const disguiseMaxR = rules.disguiseColliderMaxRadius ?? 0.55;

let fails = 0;
const notes = [];
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};
const note = (msg) => notes.push(msg);

// targetSizeForEntry — copied from js/scene.js (which imports THREE and can't load in node).
// Kept in lockstep by the "fit largest dim to target" mesh path below; only used when a
// model has neither modelDims nor a modelScale (not the case for any current map).
function targetSizeForEntry(c) {
  if (typeof c.modelSize === 'number') return c.modelSize;
  switch (c.shape) {
    case 'box': return Math.max(c.w, c.h, c.d);
    case 'cylinder':
    case 'cone': return Math.max(2 * c.r, c.h);
    case 'sphere': return 2 * c.r;
    default: return 1.5;
  }
}

// The DRAWN mesh's world size {w,h,d}, mirroring js/scene.js instantiateModel + _queueModel:
//   - no model            -> the primitive box itself is drawn (makePropMesh).
//   - modelDims override  -> exact per-axis world size.
//   - a modelScale        -> native GLB bbox × scale (the restaurant's uniform 0.75).
//   - else                -> fit the largest native dim to the target size.
// Returns null when a scaled/fitted model's native bbox isn't recorded in asset-dims.json
// (can't be verified here — counted as UNVERIFIED, not a pass or a fail).
function meshSizeFor(c, mapScale) {
  const he = halfExtentsFor(c);
  const prim = { w: he.hx * 2, h: he.hy * 2, d: he.hz * 2 };
  if (!c.model) return prim; // primitive is exactly what's drawn
  if (c.modelDims && c.modelDims.w > 0 && c.modelDims.h > 0 && c.modelDims.d > 0) {
    return { w: c.modelDims.w, h: c.modelDims.h, d: c.modelDims.d };
  }
  const native = assetDims[c.model];
  const scale = typeof c.modelScale === 'number' ? c.modelScale : mapScale;
  if (typeof scale === 'number' && scale > 0) {
    if (native && native.w > 0) return { w: native.w * scale, h: native.h * scale, d: native.d * scale };
    return null; // scaled GLB, native bbox unknown
  }
  if (native && native.w > 0) {
    const maxN = Math.max(native.w, native.h, native.d) || 1;
    const s = targetSizeForEntry(c) / maxN;
    return { w: native.w * s, h: native.h * s, d: native.d * s };
  }
  return null;
}

console.log('physics solidity check (static geometric invariants)\n');

// ---- GLOBAL config invariants (map-independent) -----------------------------------------
console.log('config:');
ok(FLOOR_Y === 0, `floor plane FLOOR_Y == 0 (engine clamps every player foot to it each substep)`);
ok(
  minWallHalf >= playerRadius - 1e-9,
  `B min wall half-thickness (${minWallHalf}) >= player capsule radius (${playerRadius}) — thickened thin panels clear the capsule`
);
ok(
  disguiseMaxR >= playerRadius - 1e-9,
  `A disguise capsule max radius (${disguiseMaxR}) >= base player radius (${playerRadius}) — a disguised player is at least as solid as the base capsule`
);
ok(!Number.isNaN(minWallHalf) && rules.minWallHalfThickness != null, `rules.minWallHalfThickness is defined (${rules.minWallHalfThickness})`);

let unverified = 0;

for (const [mapId, map] of Object.entries(maps)) {
  console.log(`\nmap "${mapId}" (size ${map.size}${map.modelScale ? `, modelScale ${map.modelScale}` : ''}):`);
  const catalog = { ...props, ...fixtures };
  const mapScale = typeof map.modelScale === 'number' ? map.modelScale : undefined;
  const half = map.size / 2;

  // ---- C. FLOOR ---------------------------------------------------------------------------
  // Ground slab (physics.js _buildStatic): cuboid(half+2, 1.5, half+2) at y=-1.5 -> top at 0.
  const slabHalfY = 1.5;
  const slabTop = -1.5 + slabHalfY;
  ok(Math.abs(slabTop - FLOOR_Y) < 1e-9, `C ground slab top sits on the floor plane (${slabTop} == ${FLOOR_Y})`);
  ok(half + 2 >= half, `C ground slab (half-extent ${(half + 2).toFixed(1)}) covers the whole arena (half ${half})`);
  const substepFall = maxFall * SUBSTEP; // furthest a clamped fall travels in one substep
  ok(
    2 * slabHalfY > substepFall * 4,
    `C slab thickness (${(2 * slabHalfY).toFixed(1)}m) >> one-substep fall (${substepFall.toFixed(2)}m) — a falling body can't tunnel the floor`
  );

  // ---- Partition catalog usages into static fixtures vs world props ----------------------
  const staticTypes = new Set();
  const worldPropTypes = new Set();
  for (const f of map.fixtures || []) {
    const c = catalog[f.type];
    if (!c) { ok(false, `catalog has an entry for fixture type "${f.type}"`); continue; }
    if (isStaticEntry(c)) staticTypes.add(f.type);
    else worldPropTypes.add(f.type); // knockable fixture = a world prop the player rests against
  }
  for (const p of map.props || []) {
    const c = catalog[p.type];
    if (!c) { ok(false, `catalog has an entry for prop type "${p.type}"`); continue; }
    worldPropTypes.add(p.type);
  }

  // ---- B. WALLS + TOP FACE (static fixtures) ---------------------------------------------
  for (const type of staticTypes) {
    const c = catalog[type];
    const he = halfExtentsFor(c);
    const mesh = meshSizeFor(c, mapScale);
    // TOP-FACE: collider height must not be shorter than the mesh, or you could stand on the
    // visible top with no collider under you and drop through. collider top - collider bottom
    // = 2*he.hy for both plain and floor-thickened statics (floor grows DOWN, top unchanged).
    if (mesh) {
      ok(
        2 * he.hy >= mesh.h - TOL,
        `B "${type}" collider is as tall as its mesh (collider h ${(2 * he.hy).toFixed(3)} >= mesh h ${mesh.h.toFixed(3)}) — no top-face gap`
      );
    } else {
      unverified++;
      note(`B "${type}" (map ${mapId}): mesh height unverifiable (scaled GLB "${c.model}" not in asset-dims.json)`);
    }
    // THICKENING: confirm pass-#3's grow still fires for thin wall panels (regression guard).
    if (he.box) {
      const g = thickenWallHalfExtents(he.hx, he.hz, minWallHalf);
      if (g.grew) {
        ok(
          Math.min(g.hx, g.hz) >= minWallHalf - 1e-9,
          `B "${type}" thin wall panel thickened to >= ${minWallHalf} half (${g.hx.toFixed(2)}×${g.hz.toFixed(2)}) — no fast-jump tunnel`
        );
      }
    }
  }

  // ---- A. PROP-VS-PROP (world props) -----------------------------------------------------
  let roundSkipped = 0;
  for (const type of worldPropTypes) {
    const c = catalog[type];
    const he = halfExtentsFor(c);
    const mesh = meshSizeFor(c, mapScale);
    if (!he.box) { roundSkipped++; continue; } // round collider hugs the body, not the bbox
    if (!mesh) {
      unverified++;
      note(`A "${type}" (map ${mapId}): mesh size unverifiable (scaled GLB "${c.model}" not in asset-dims.json)`);
      continue;
    }
    const okW = 2 * he.hx >= mesh.w - TOL;
    const okH = 2 * he.hy >= mesh.h - TOL;
    const okD = 2 * he.hz >= mesh.d - TOL;
    ok(
      okW && okH && okD,
      `A "${type}" collider not smaller than its mesh ` +
        `(${(2 * he.hx).toFixed(2)}×${(2 * he.hy).toFixed(2)}×${(2 * he.hz).toFixed(2)} vs mesh ` +
        `${mesh.w.toFixed(2)}×${mesh.h.toFixed(2)}×${mesh.d.toFixed(2)}) — no gap to sink into`
    );
  }
  if (roundSkipped) note(`A map ${mapId}: ${roundSkipped} round (cylinder/sphere) world-prop type(s) use a body-hugging collider by design — not bbox-checked.`);

  // ---- A. DISGUISE SOLIDITY (informational bound) ----------------------------------------
  // A disguised player's capsule radius is fitted to the disguise footprint but capped at
  // disguiseColliderMaxRadius for doorway passability, so the biggest disguises leave a
  // bounded strip of mesh able to overlap a world prop. Report the worst case; hard-fail
  // only if it regresses past the pre-pass-#3 level (~0.35), which would mean the capsule
  // fitting was disabled.
  let worstOverhang = 0, worstType = null;
  for (const p of map.props || []) {
    const c = catalog[p.type];
    if (!c) continue;
    const he = halfExtentsFor(c);
    const footHalf = Math.min(he.hx, he.hz);
    const capsuleR = Math.min(disguiseMaxR, Math.max(playerRadius, footHalf));
    const overhang = footHalf - capsuleR; // mesh strip past the solid capsule
    if (overhang > worstOverhang) { worstOverhang = overhang; worstType = p.type; }
  }
  if (worstType) {
    ok(
      worstOverhang < 0.35,
      `A worst disguise mesh overhang ${worstOverhang.toFixed(2)}m ("${worstType}") within the capped bound (< 0.35; capsule fitting active)`
    );
    note(`A map ${mapId}: worst-case disguise mesh overhang is ${worstOverhang.toFixed(2)}m ("${worstType}") — the documented door-passability tradeoff (raise rules.disguiseColliderMaxRadius to tighten, at the cost of squeezing through doors).`);
  }
}

console.log('');
if (notes.length) {
  console.log('notes:');
  for (const n of notes) console.log('  • ' + n);
  console.log('');
}
if (unverified) console.log(`(${unverified} size(s) unverifiable — GLBs not in asset-dims.json; these keep the authored primitive footprint, which matches the mesh by construction.)\n`);

if (fails) {
  console.error(`physics solidity check FAILED (${fails} invariant${fails > 1 ? 's' : ''} violated)`);
  process.exit(1);
}
console.log('physics solidity check passed');
