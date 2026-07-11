// shared/bounds.js — ONE shared source of truth for the WORLD-SPACE bounds of every
// physics collider and every visible mesh. Three things read from HERE and therefore can
// never drift from each other (the drift between "the check" and "the real world" is
// exactly why physics took four attempts):
//   1. the ?debug=1 collider wireframe view          (js/scene.js)
//   2. the headless misalignment guard               (tools/check-physics.mjs)
//   3. numeric diagnosis (collider vs mesh, by hand or in the guard)
//
// Collider SIZES come from the SAME pure helpers shared/physics.js uses to build the real
// colliders (halfExtentsFor / thickenWallHalfExtents / isStaticEntry / FLOOR_Y), so this
// module and the engine can never disagree on a collider's size. The static-collider
// PLACEMENT math below is a faithful, line-for-line mirror of shared/physics.js
// _buildStatic — if you change one, change the other; tools/check-physics.mjs cross-checks
// the wall/ground constants so an accidental divergence fails the build.

import { halfExtentsFor, thickenWallHalfExtents, FLOOR_Y } from './physics.js';

// ---- constants shared with physics.js _buildStatic (MUST stay in lockstep) --------------
export const GROUND_SLAB_HALF_Y = 1.5; // slab is 3 m thick; its TOP sits on FLOOR_Y
export const WALL_INSET = 0.5; // inner boundary-wall face sits this far inside the map edge
export const WALL_HALF_THICK = 0.75; // boundary walls are 1.5 m thick
export const WALL_HALF_HEIGHT = 2.5; // boundary walls are 5 m tall (base at y=0)

// X or Z half-extent of a catalog entry's footprint (measured bounds first, else primitive
// w/d) — mirrors physics.js halfExtentXZ. Only meaningful for box/measured fixtures.
function xzHalf(c, axis) {
  const m = c && c.measured;
  if (m && m.w > 0 && m.d > 0) return (axis === 'w' ? m.w : m.d) / 2;
  return ((axis === 'w' ? c.w : c.d) || 1) / 2;
}

// The largest world dim a model-less-scaled GLB is fit to — mirrors scene.js
// targetSizeForEntry. Only used when a model has neither modelDims nor a modelScale.
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

// Every STATIC WORLD collider (ground slab, boundary walls, static fixtures) as a
// world-space box: { kind, type, cx,cy,cz, hx,hy,hz, rot, floor?, thickened? }. A faithful
// mirror of shared/physics.js _buildStatic — same sizes, same placements, same thin-wall
// thickening. Boxes are yaw-rotated about +Y by `rot` (like the real colliders).
export function worldColliderBoxes(map, catalog, rules) {
  const half = map.size / 2;
  const minHalf = rules && rules.minWallHalfThickness != null ? rules.minWallHalfThickness : 0.6;
  const boxes = [];

  // Ground slab: cuboid(half+2, 1.5, half+2) at y=-1.5 → top at FLOOR_Y.
  boxes.push({ kind: 'ground', type: '(ground)', cx: 0, cy: FLOOR_Y - GROUND_SLAB_HALF_Y, cz: 0, hx: half + 2, hy: GROUND_SLAB_HALF_Y, hz: half + 2, rot: 0 });

  // Boundary walls (pushed OUTWARD; inner face unchanged).
  const cOut = half - WALL_INSET + WALL_HALF_THICK;
  const along = half + WALL_HALF_THICK;
  boxes.push({ kind: 'wall', type: '(wall -z)', cx: 0, cy: WALL_HALF_HEIGHT, cz: -cOut, hx: along, hy: WALL_HALF_HEIGHT, hz: WALL_HALF_THICK, rot: 0 });
  boxes.push({ kind: 'wall', type: '(wall +z)', cx: 0, cy: WALL_HALF_HEIGHT, cz: cOut, hx: along, hy: WALL_HALF_HEIGHT, hz: WALL_HALF_THICK, rot: 0 });
  boxes.push({ kind: 'wall', type: '(wall -x)', cx: -cOut, cy: WALL_HALF_HEIGHT, cz: 0, hx: WALL_HALF_THICK, hy: WALL_HALF_HEIGHT, hz: along, rot: 0 });
  boxes.push({ kind: 'wall', type: '(wall +x)', cx: cOut, cy: WALL_HALF_HEIGHT, cz: 0, hx: WALL_HALF_THICK, hy: WALL_HALF_HEIGHT, hz: along, rot: 0 });

  // Static fixtures (ONLY c.static — knockable fixtures are promoted to props by the
  // referee and built by _buildProps, so they are prop colliders, below).
  for (const f of map.fixtures || []) {
    const c = catalog[f.type];
    if (!c || !c.static) continue;
    const halfH = halfExtentsFor(c).hy; // == shapeFor's halfH
    if (c.floor) {
      // Floor piece: ~1 m thick, extended DOWNWARD, visible top held flush (fix #5).
      const top = 2 * halfH + (f.y || 0);
      const thick = Math.max(1.0, 2 * halfH);
      boxes.push({ kind: 'fixture', type: f.type, cx: f.x, cy: top - thick / 2, cz: f.z, hx: xzHalf(c, 'w'), hy: thick / 2, hz: xzHalf(c, 'd'), rot: f.rot || 0, floor: true });
      continue;
    }
    // Thin-wall PANEL thickening (Bug 2): grow only the thin horizontal axis, symmetric
    // about the centre. All current static fixtures are boxes.
    const isBox = c.shape === 'box' || (c.measured && c.measured.w > 0 && c.measured.d > 0);
    const hx0 = xzHalf(c, 'w');
    const hz0 = xzHalf(c, 'd');
    const grown = isBox ? thickenWallHalfExtents(hx0, hz0, minHalf) : { hx: hx0, hz: hz0, grew: false };
    boxes.push({ kind: 'fixture', type: f.type, cx: f.x, cy: halfH + (f.y || 0), cz: f.z, hx: grown.hx, hy: halfH, hz: grown.hz, rot: f.rot || 0, thickened: grown.grew });
  }
  return boxes;
}

// Every PROP collider (the disguise pool `map.props` + knockable non-static `map.fixtures`)
// as a world-space box at its AUTHORED rest position. { kind:'prop', type, cx,cy,cz,
// hx,hy,hz, rot, box }. `box` is false for round colliders (cylinder/cone/sphere) that hug
// the body rather than the GLB's square bbox. Mirrors physics.js _buildProps rest placement
// (cy = halfH + p.y); shoved props move at runtime (the debug view tracks that live).
export function propColliderBoxes(map, catalog) {
  const boxes = [];
  const push = (type, p) => {
    const c = catalog[type];
    if (!c) return;
    const he = halfExtentsFor(c);
    boxes.push({ kind: 'prop', type, cx: p.x, cy: he.hy + (p.y || 0), cz: p.z, hx: he.hx, hy: he.hy, hz: he.hz, rot: p.rot || 0, box: he.box });
  };
  for (const f of map.fixtures || []) {
    const c = catalog[f.type];
    if (c && !c.static) push(f.type, f);
  }
  for (const p of map.props || []) push(p.type, p);
  return boxes;
}

// The DRAWN mesh's world size { w, h, d }, mirroring js/scene.js instantiateModel +
// _queueModel: no model → the primitive box; modelDims/measured → exact per-axis size; a
// modelScale → native GLB bbox × scale; else fit-largest-native-dim-to-target. Returns null
// when a scaled/fitted GLB's native bbox isn't recorded in `assetDims` (UNVERIFIABLE — not
// a pass or a fail). `assetDims` is the raw asset-dims.json map (keys are GLB paths, e.g.
// "restaurant/door.glb"; values {w,h,d} native bboxes).
export function meshSize(c, mapScale, assetDims) {
  if (!c) return null;
  const he = halfExtentsFor(c);
  if (!c.model) return { w: he.hx * 2, h: he.hy * 2, d: he.hz * 2 }; // primitive IS the mesh
  if (c.measured && c.measured.w > 0 && c.measured.h > 0 && c.measured.d > 0) {
    return { w: c.measured.w, h: c.measured.h, d: c.measured.d };
  }
  if (c.modelDims && c.modelDims.w > 0 && c.modelDims.h > 0 && c.modelDims.d > 0) {
    return { w: c.modelDims.w, h: c.modelDims.h, d: c.modelDims.d };
  }
  const native = assetDims && assetDims[c.model];
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

// Is world-space point (px,pz) inside box b's footprint at height py? Yaw-aware: rotates
// the point into the box's local frame first (boxes can carry a `rot`). Used by the
// open-middle-clear + spawn-clear checks.
export function pointInBox(b, px, py, pz, pad = 0) {
  const dx = px - b.cx;
  const dz = pz - b.cz;
  const rot = b.rot || 0;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  return (
    Math.abs(lx) <= b.hx + pad &&
    Math.abs(lz) <= b.hz + pad &&
    py >= b.cy - b.hy - pad &&
    py <= b.cy + b.hy + pad
  );
}
