#!/usr/bin/env node
// COLLIDER ↔ VISUAL alignment audit (HITBOX ACCURACY, 2026-07). AUTHORING-ONLY — never
// imported by the page / shipped. Run from a shell:
//
//     node tools/check-collider-visual.mjs
//
// WHY THIS EXISTS. Shots test against physics primitives (the catalog's box/cylinder/cone/
// sphere footprint, via shared/physics.js halfExtentsFor) — and a disguised player's SHOT
// SENSOR is baked from that SAME footprint (shapeFor). If a catalog entry's primitive
// UNDER-COVERS its rendered GLB, bullets at the model's visible edges (a table corner, the
// top of a chair back, a tall fridge) whiff even though you clearly hit the model. This audit
// reads each referenced GLB's TRUE native bounding box directly from the GLB binary (the same
// approach as tools/measure-glbs.mjs / check-hunter-model-size.mjs — parse the JSON chunk,
// transform every mesh POSITION accessor min/max by its node world matrix — NO Three.js, NO
// deps), computes the rendered world size EXACTLY as scene.js does (via shared/bounds.js
// meshSize: modelDims → per-axis; else native × map.modelScale), and compares it against the
// collider footprint (shared/physics.js halfExtentsFor) plus the vertical centre offset.
//
// PASS/FAIL. A BOX collider that under-covers its visual on ANY axis by more than the
// tolerance FAILS (that is a corner/edge/top that can be shot-missed). A ROUND collider
// (cylinder/cone/sphere) is inscribed in the square GLB bbox BY DESIGN, so its HORIZONTAL
// under-coverage is REPORTED not failed — but its HEIGHT is still asserted (a short cylinder
// under a tall model would drop the visible top). Entries whose GLB can't be measured are
// reported UNVERIFIABLE (neither pass nor fail), like the sibling physics checks.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { halfExtentsFor, isArchEntry } from '../shared/physics.js';
import { meshSize } from '../shared/bounds.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

// ---- GLB native-bbox parse (self-contained; mirrors tools/measure-glbs.mjs) ---------------
function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function fromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function nodeLocalMatrix(n) {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix.slice();
  return fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
}
function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
function readGltfJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const chunkLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  return JSON.parse(buf.slice(20, 20 + chunkLen).toString('utf8'));
}
function measureGlb(gltf) {
  const nodes = gltf.nodes || [], meshes = gltf.meshes || [], accessors = gltf.accessors || [];
  const roots = (gltf.scenes && gltf.scenes[gltf.scene || 0] && gltf.scenes[gltf.scene || 0].nodes) || [];
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], any = false;
  const visit = (idx, parent) => {
    const n = nodes[idx]; if (!n) return;
    const world = multiply(parent, nodeLocalMatrix(n));
    if (typeof n.mesh === 'number' && meshes[n.mesh]) {
      for (const prim of meshes[n.mesh].primitives || []) {
        const posIdx = prim.attributes && prim.attributes.POSITION;
        if (typeof posIdx !== 'number') continue;
        const acc = accessors[posIdx];
        if (!acc || !acc.min || !acc.max) continue;
        const lo = acc.min, hi = acc.max;
        for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 2; cz++) {
          const p = transformPoint(world, [cx ? hi[0] : lo[0], cy ? hi[1] : lo[1], cz ? hi[2] : lo[2]]);
          for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
          any = true;
        }
      }
    }
    for (const child of n.children || []) visit(child, world);
  };
  for (const r of roots) visit(r, identity());
  if (!any) return null;
  return { w: max[0] - min[0], h: max[1] - min[1], d: max[2] - min[2] };
}
function nativeBbox(modelPath) {
  const file = join(root, 'assets', modelPath);
  if (!existsSync(file)) return null;
  try { return measureGlb(readGltfJson(readFileSync(file))); } catch { return null; }
}

// ---- config ------------------------------------------------------------------------------
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
// CONVEX-HULL SEAM: attach the baked hull verts/AABB onto each catalog entry exactly as
// js/config.js does at runtime, so halfExtentsFor() returns the HULL footprint (its world AABB)
// for hulled entries — this audit then checks the shipping collider, not the dormant primitive.
let hullDefs = {};
try { hullDefs = (readJSON('shared', 'config', 'hulls.json').hulls) || {}; } catch { hullDefs = {}; }
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = h.aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = h.aabb; }
}
// Every model-bearing catalog entry is referenced by the restaurant map (the only map with
// GLBs). Its modelScale (0.75) is the uniform factor scene.js applies to a scaled GLB.
const mapScale = (maps.restaurant && maps.restaurant.modelScale) || 0.75;

// Tolerance: a collider "under-covers" only when it is BOTH ≥ ABS_TOL (5 cm) AND ≥ REL_TOL
// (8 %) smaller than the visual on that axis — so sub-centimetre rounding never fails, but a
// real shoot-through gap does.
const ABS_TOL = 0.05;
const REL_TOL = 0.08;

let fails = 0, unverifiable = 0, roundReports = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

// Collider footprint bbox (world size) from the shared physics helper — the SAME numbers the
// engine bakes the real collider (and the disguise shot sensor) from.
function colliderSize(c) {
  const he = halfExtentsFor(c);
  return { w: he.hx * 2, h: he.hy * 2, d: he.hz * 2, box: he.box };
}
// under-coverage on one axis (positive = collider smaller than visual by more than tolerance).
function underBy(colDim, visDim) {
  const gap = visDim - colDim;
  if (gap <= ABS_TOL) return 0;
  if (gap / visDim <= REL_TOL) return 0;
  return gap;
}

console.log('COLLIDER ↔ VISUAL alignment audit (shot hitboxes vs rendered GLB bounds)\n');
console.log(`  map.modelScale = ${mapScale}; tolerance = max(${ABS_TOL} m, ${REL_TOL * 100}% of the visual)\n`);

function auditCatalog(label, catalog) {
  console.log(label + ':');
  for (const [type, c] of Object.entries(catalog)) {
    if (type.startsWith('_') || !c) continue; // skip comment keys
    let vis;
    if (c.model) {
      const native = nativeBbox(c.model);
      // assetDims keyed by c.model (what meshSize looks up) — freshly measured from the GLB.
      const assetDims = native ? { [c.model]: native } : {};
      vis = meshSize(c, mapScale, assetDims);
      if (!vis) { console.log(`  ? ${type} — UNVERIFIABLE (could not measure ${c.model})`); unverifiable++; continue; }
    } else if (c.shape === 'box') {
      // CODE-BUILT geometry (round 3): js/scene.js makePropMesh draws a raw BoxGeometry(w,h,d),
      // so the RAW catalog dims ARE the rendered mesh (independent of the baked hull — this is
      // what catches a hull that drifted from the drawn box).
      vis = { w: c.w, h: c.h, d: c.d };
    } else {
      continue; // model-less round primitive (a cylinder/ball) — its true-shape collider hugs by construction
    }
    const col = colliderSize(c);
    const arch = isArchEntry(c);

    // Horizontal coverage.
    const uW = underBy(col.w, vis.w);
    const uD = underBy(col.d, vis.d);
    const uH = underBy(col.h, vis.h);
    // Vertical centre offset: collider base rests on the foot (centre col.h/2 above it); the
    // GLB rests its base on the foot too (centre vis.h/2). A mismatch == a top/bottom gap.
    const centreOff = Math.abs(col.h / 2 - vis.h / 2);

    const dims = `col ${col.w.toFixed(2)}×${col.h.toFixed(2)}×${col.d.toFixed(2)} vs vis ${vis.w.toFixed(2)}×${vis.h.toFixed(2)}×${vis.d.toFixed(2)}`;
    if (col.box) {
      // Box collider: assert coverage on all three axes (a table's corners/top).
      const bad = (uW || uD || uH) && !arch;
      ok(!bad, `${type} (box${arch ? ', arch' : ''}) covers its visual — ${dims}` +
        (bad ? ` — UNDER-COVERS w:${uW.toFixed(2)} h:${uH.toFixed(2)} d:${uD.toFixed(2)} (widen the primitive/measured dims)` : ''));
    } else {
      // Round collider inscribed in a square GLB bbox by design → horizontal under-coverage is
      // EXPECTED (corners are empty air); only assert HEIGHT (a short cylinder drops the top).
      if (uW || uD) { roundReports++; console.log(`  · ${type} (round) horizontal inscribed (expected) — ${dims}`); }
      const bad = uH && !arch;
      ok(!bad, `${type} (round${arch ? ', arch' : ''}) height covers its visual (${col.h.toFixed(2)} vs ${vis.h.toFixed(2)})` +
        (bad ? ' — UNDER-COVERS the visible top (raise h)' : ''));
    }
    if (centreOff > ABS_TOL && (col.h > vis.h + ABS_TOL || vis.h > col.h + ABS_TOL)) {
      // Only meaningful when the height genuinely differs (already flagged above for under);
      // an over-tall collider is a harmless (never a shoot-through) note.
      console.log(`      note: ${type} vertical centre offset ${centreOff.toFixed(2)} m (collider ${col.h > vis.h ? 'taller' : 'shorter'} than visual)`);
    }
  }
  console.log('');
}

auditCatalog('PROPS (disguise pool)', props);
auditCatalog('FIXTURES (built-ins + knockable scenery)', fixtures);

// ---- CONVEX-HULL audit (2026-07-13) --------------------------------------------------------
// For every baked hull, assert its world-space AABB matches the FRESH GLB mesh bbox on all three
// axes — BOTH directions (covers the model AND doesn't bulge past it). A convex hull of the mesh
// verts can only lie ON/INSIDE the mesh bounds; the bake includes the 6 axis support points so the
// AABB should equal the mesh AABB. A mismatch means a SCALE-TRAP (hull baked at the wrong factor)
// or a STALE hull (GLB changed since the bake) — re-run tools/build-hulls.mjs. This is the "hull
// vertices lie on/inside the mesh bounds and cover them" check the collider-overhaul plan called
// for (a hull is not a box, so the box-dims comparison alone isn't enough).
console.log('CONVEX HULLS (hullAABB vs render bounds — GLB mesh, or raw w/h/d for code-built boxes):');
let hullChecked = 0;
for (const catalog of [props, fixtures]) {
  for (const [type, c] of Object.entries(catalog)) {
    if (type.startsWith('_') || !c || !c.hullAabb) continue;
    let vis;
    if (c.model) {
      const native = nativeBbox(c.model);
      vis = native ? meshSize(c, mapScale, { [c.model]: native }) : null;
      if (!vis) { console.log(`  ? ${type} — UNVERIFIABLE (could not measure ${c.model})`); unverifiable++; continue; }
    } else {
      // CODE-BUILT box: the drawn mesh is the raw BoxGeometry(w,h,d); the hull must equal it.
      vis = { w: c.w, h: c.h, d: c.d };
    }
    const a = c.hullAabb;
    const dw = Math.abs(a.w - vis.w), dh = Math.abs(a.h - vis.h), dd = Math.abs(a.d - vis.d);
    const tol = (v) => Math.max(ABS_TOL, v * REL_TOL);
    const good = dw <= tol(vis.w) && dh <= tol(vis.h) && dd <= tol(vis.d);
    hullChecked++;
    ok(good, `${type} hull AABB ${a.w.toFixed(2)}×${a.h.toFixed(2)}×${a.d.toFixed(2)} == mesh ${vis.w.toFixed(2)}×${vis.h.toFixed(2)}×${vis.d.toFixed(2)}` +
      (good ? '' : ` — DRIFT w:${dw.toFixed(2)} h:${dh.toFixed(2)} d:${dd.toFixed(2)} (re-run tools/build-hulls.mjs)`));
  }
}
console.log(`  (${hullChecked} hull entr${hullChecked === 1 ? 'y' : 'ies'} checked)\n`);

console.log(`summary: ${fails} under-coverage failure(s), ${roundReports} round-horizontal report(s), ${unverifiable} unverifiable.\n`);
if (fails) {
  console.error(`collider↔visual audit FAILED (${fails} entr${fails > 1 ? 'ies' : 'y'} under-cover the visible model) — bullets can whiff on the visible edges; widen the offenders in props.json/fixtures.json.`);
  process.exit(1);
}
console.log('collider↔visual audit passed');
