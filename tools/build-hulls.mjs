#!/usr/bin/env node
// build-hulls.mjs — AUTHORING TOOL, never shipped to players.
//
// Bakes a CONVEX-HULL collider point set for every model-bearing catalog entry that
// should get one, from the model's ACTUAL mesh vertices, at the SAME final world-space
// scale the renderer draws it (VRmike's "convex-hull colliders for all props/fixtures",
// option 1 of the collider overhaul). Output: shared/config/hulls.json.
//
// WHY BAKE (vs generate at load time, as the plan's step 3 sketched): the plan wanted
// hulls computed in-browser from the renderer's async-loaded GLB vertices, then swapped
// onto the live physics body. Baking the hull POINTS into a committed data file instead
// (the same pattern as tools/measure-glbs.mjs -> asset-dims.json) gives the identical
// result — hulls from the real mesh verts, at final scale — but is fully DETERMINISTIC
// (every peer loads identical bytes, no dependence on an async GLB download completing),
// SYNCHRONOUS at match start (no spawn-on-primitive-then-swap window), and adds NO new
// runtime collider-swap machinery to the sensitive physics/netcode layer. It rides the
// EXISTING single collider-shape selector (shared/physics.js shapeFor): a hull becomes a
// new FIRST branch there, fed by these baked verts exactly as `measured` feeds the cuboid
// branch. Re-run this tool after adding/replacing any restaurant GLB:
//
//     node tools/build-hulls.mjs
//
// SAFETY SCAN (VRmike's entombment concern — plan step 1). Before hulling anything the
// tool scans every candidate GLB: a single hull of a ROOM SHELL or a MERGED multi-object
// mesh becomes one solid block that would seal players inside. So any model whose scaled
// bounds are room-scale, OR whose mesh is several DISJOINT islands (a kit of separate
// panels), is EXCLUDED (keeps its primitive) and named in the report. The report prints
// "all pieces, no room shells" or the exception list — surfaced in the build summary.
//
// SCOPE. Candidates = catalog entries that (a) reference a GLB `model`, (b) are NOT world
// architecture (`arch` — floors/walls stay cuboids: a box IS the right shape there), and
// (c) use a BOX primitive today. Deliberately ROUND items (cylinder/cone/sphere: barrels,
// balls, stools, plates, pots, bowls) KEEP their primitive — a cylinder hugs a barrel far
// better than a faceted hull, and the plan (step 6) says keep round things round.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

// ---- mat4 helpers (column-major, glTF convention; mirrors measure-glbs.mjs) ---------------
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

// ---- GLB container + binary vertex parse ---------------------------------------------------
// measure-glbs.mjs only needs accessor min/max; here we must read the ACTUAL vertex stream,
// so we also locate the BIN chunk and decode each POSITION accessor's float data.
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  let off = 12;
  const jsonLen = buf.readUInt32LE(off);
  if (buf.readUInt32LE(off + 4) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const json = JSON.parse(buf.slice(off + 8, off + 8 + jsonLen).toString('utf8'));
  off += 8 + jsonLen;
  let bin = null;
  if (off + 8 <= buf.length) {
    const binLen = buf.readUInt32LE(off);
    const binType = buf.readUInt32LE(off + 4);
    if (binType === 0x004e4942) bin = buf.slice(off + 8, off + 8 + binLen); // 'BIN\0'
  }
  return { json, bin };
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// Read a VEC3 FLOAT accessor's vertices as [[x,y,z],...] in the mesh's LOCAL space.
function readVec3Accessor(gltf, bin, accIdx) {
  const acc = gltf.accessors[accIdx];
  if (!acc || acc.type !== 'VEC3') return [];
  if (acc.componentType !== 5126) return []; // POSITION is always float in this pack
  if (acc.sparse) throw new Error('sparse accessor unsupported'); // none in this pack
  const bv = gltf.bufferViews[acc.bufferView];
  const compBytes = COMPONENT_BYTES[acc.componentType];
  const numComp = TYPE_COUNT[acc.type];
  const elemBytes = compBytes * numComp;
  const stride = bv.byteStride || elemBytes;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    out.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
  }
  return out;
}

// Walk the node hierarchy; return an array of PRIMITIVE islands, each = { verts:[[x,y,z]...],
// min, max } in world space (accessor local verts transformed by node world matrices — exactly
// what THREE.Box3().setFromObject + the renderer do). Keeping them per-primitive lets the safety
// scan detect a merged multi-object mesh (disjoint islands).
function extractPrimitives(gltf, bin) {
  const nodes = gltf.nodes || [], meshes = gltf.meshes || [];
  const roots = (gltf.scenes && gltf.scenes[gltf.scene || 0] && gltf.scenes[gltf.scene || 0].nodes) || [];
  const prims = [];
  const visit = (idx, parent) => {
    const n = nodes[idx]; if (!n) return;
    const world = multiply(parent, nodeLocalMatrix(n));
    if (typeof n.mesh === 'number' && meshes[n.mesh]) {
      for (const prim of meshes[n.mesh].primitives || []) {
        const posIdx = prim.attributes && prim.attributes.POSITION;
        if (typeof posIdx !== 'number') continue;
        const local = readVec3Accessor(gltf, bin, posIdx);
        if (!local.length) continue;
        const verts = [];
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const p of local) {
          const w = transformPoint(world, p);
          verts.push(w);
          for (let a = 0; a < 3; a++) { if (w[a] < min[a]) min[a] = w[a]; if (w[a] > max[a]) max[a] = w[a]; }
        }
        prims.push({ verts, min, max });
      }
    }
    for (const child of n.children || []) visit(child, world);
  };
  for (const r of roots) visit(r, identity());
  return prims;
}

// ---- safety scan: disjoint-island (multi-object) detection --------------------------------
// Union-find over primitive AABBs: two primitives merge if their AABBs overlap or nearly touch
// (gap <= GAP native units). A single furniture item — even one built from several primitives
// (seat + legs + back) — collapses to ONE island because the pieces adjoin. A KIT of separate
// wall panels / a room shell stays as MULTIPLE islands => flagged, never hulled as one block.
function islandCount(prims, gapAbs) {
  const n = prims.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const near = (A, B) => {
    for (let a = 0; a < 3; a++) {
      if (A.min[a] - B.max[a] > gapAbs) return false;
      if (B.min[a] - A.max[a] > gapAbs) return false;
    }
    return true;
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (near(prims[i], prims[j])) { parent[find(i)] = find(j); }
  }
  const roots = new Set();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

// ---- hull point reduction (deterministic support-point sampling) --------------------------
// Rapier's ColliderDesc.convexHull() computes the actual hull at runtime; we only need to hand
// it a compact point cloud that CONTAINS the hull vertices. Support-point sampling does that
// deterministically: for each of a fixed set of directions, keep the vertex with the greatest
// dot product (a support point is always ON the hull). Including the 6 AXIS directions
// guarantees the reduced set's AABB EQUALS the full mesh AABB (so the hull covers the visual
// exactly — no shoot-through gap). The extra sphere directions capture the silhouette between
// axes. No randomness (a Fibonacci sphere is fully determined by its count) so re-runs are
// byte-stable. Result: a hull that hugs the model and can only UNDER-approximate slightly
// (stays inside the mesh) — it can never bulge out and entomb.
function sampleDirections(nSphere) {
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], // axes (lock the AABB)
  ];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nSphere; i++) {
    const y = 1 - (i / (nSphere - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dirs.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return dirs;
}
function reduceToHullPoints(verts, dirs) {
  const chosen = new Map(); // "ix,iy,iz" -> [x,y,z], dedups coincident support points
  for (const d of dirs) {
    let best = -Infinity, bv = null;
    for (const v of verts) {
      const dot = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
      if (dot > best) { best = dot; bv = v; }
    }
    if (bv) {
      const key = `${Math.round(bv[0] * 1e5)},${Math.round(bv[1] * 1e5)},${Math.round(bv[2] * 1e5)}`;
      if (!chosen.has(key)) chosen.set(key, bv);
    }
  }
  return [...chosen.values()];
}

// ---- main -----------------------------------------------------------------------------------
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const mapScale = (maps.restaurant && maps.restaurant.modelScale) || 0.75;
const mapSize = (maps.restaurant && maps.restaurant.size) || 36;

// A model is "room-scale" if its largest horizontal footprint at final world scale is a big
// fraction of the arena — a whole-room shell. Individual furniture is far below this.
const ROOM_SCALE = Math.min(8, mapSize / 3);
const ISLAND_GAP = 0.15;   // native units: pieces closer than this count as one object
const N_SPHERE_DIRS = 260; // silhouette-fidelity sample directions (plus the 6 axes)
const ROUND_ = 1e5;

const dirs = sampleDirections(N_SPHERE_DIRS);
const round5 = (v) => Math.round(v * ROUND_) / ROUND_;

const outHulls = {};
const report = { hulled: [], excluded: [], skippedRound: [], skippedFloor: [], unverifiable: [] };

// CODE-BUILT geometry (2026-07-13 round 3, VRmike — "convex hulls for EVERYTHING"). An entry
// with NO `model` is drawn by js/scene.js makePropMesh as a PRIMITIVE straight from the catalog
// (a box => THREE.BoxGeometry(c.w,c.h,c.d) at raw world units — no modelScale). So its ACTUAL
// render geometry is that box, and its convex hull is exactly the box's 8 corners at
// (±w/2,±h/2,±d/2). The renderer and this bake both read the SAME catalog w/h/d, so the collider
// can't drift from the drawn mesh (plan step 2's no-drift guarantee — for a plain box there is no
// separate geometry to extract: the dims ARE the single source). This is what lets the previously
// SKIPPED `arch` walls/columns/archway pieces (kitchen_wall, wall_post, wall_header) get a hull
// that hugs their render box instead of the oversized hand-authored/anti-tunnel collider VRmike's
// debug screenshots show floating outside them. Floors (`floor`) are the ONE exception — they keep
// a deliberately thick-DOWNWARD anti-tunnel slab (visible top flush) built in _buildStatic, which
// a paper-thin 0.06 hull would defeat; reported as an intentional non-hull, not silently dropped.
function bakeBox(catalogName, type, c) {
  const worldW = c.w, worldH = c.h, worldD = c.d;
  if (!(worldW > 0 && worldH > 0 && worldD > 0)) {
    report.unverifiable.push({ type, model: '(code-built box)', why: 'box missing/zero w/h/d' });
    return;
  }
  // SAFETY SCAN (same entombment guard as the GLB path). A single box is one island by
  // construction, so only the room-scale test applies — a room-shell-sized box would seal the
  // arena as one block. Dims are already world units (drawn raw), so no scale factor here.
  if (Math.max(worldW, worldD) > ROOM_SCALE || worldH > ROOM_SCALE) {
    report.excluded.push({ type, model: '(code-built box)', reason: 'room-scale bounds', worldSize: `${worldW.toFixed(2)}x${worldH.toFixed(2)}x${worldD.toFixed(2)}` });
    return;
  }
  // Hull = the 8 box corners, in the COLLIDER-local frame (base at y=0 then AABB centre shifted
  // to the origin => centre at origin): corners at (±w/2, ±h/2, ±d/2). Identical dims to the
  // BoxGeometry(w,h,d) scene.js draws, so by construction the hull can never exceed the render box.
  const hx = worldW / 2, hy = worldH / 2, hz = worldD / 2;
  const flat = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    flat.push(round5(sx * hx), round5(sy * hy), round5(sz * hz));
  }
  outHulls[type] = { v: flat, n: 8, aabb: { w: round5(worldW), h: round5(worldH), d: round5(worldD) } };
  report.hulled.push({ type, from: `${catalogName} (code-built box)`, pts: 8, worldSize: `${worldW.toFixed(2)}x${worldH.toFixed(2)}x${worldD.toFixed(2)}` });
}

function bake(catalogName, type, c) {
  if (type.startsWith('_') || !c) return;
  // FLOORS keep their thick-down anti-tunnel slab (visible top flush) — see _buildStatic + the
  // bakeBox note. Not hulled by design; recorded so the report never looks like a silent skip.
  if (c.floor) { report.skippedFloor.push({ type, model: c.model || '(code-built box)', why: 'floor piece — thick-DOWNWARD anti-tunnel slab, visible top flush; not hulled by design' }); return; }
  // CODE-BUILT (no GLB): hull the primitive the renderer draws directly. Box => real box hull;
  // model-less ROUND primitives (a cylinder canister) keep their primitive — a true Rapier
  // cylinder/ball hugs the drawn 16-gon exactly, so a faceted hull is no improvement (round rule).
  if (!c.model) {
    if (c.shape === 'box') return bakeBox(catalogName, type, c);
    if (c.shape) report.skippedRound.push({ type, why: `model-less ${c.shape} primitive — a true ${c.shape} collider hugs the drawn mesh exactly` });
    return;
  }
  // ROUND primitives are hulled too (change 2026-07-13, VRmike): the original bake kept
  // cylinder/ball/cone props on their hand-authored primitives on the theory a round shape
  // "hugs better than a faceted hull" — in practice the authored dims were guesses and fit
  // badly (plates wearing oversized cylinders), while the 260-direction hull sampler hugs
  // round meshes tightly. Now EVERY model-bearing, non-arch prop gets a hull.
  const scale = typeof c.modelScale === 'number' ? c.modelScale : mapScale;
  const file = join(root, 'assets', c.model);
  if (!existsSync(file)) { report.unverifiable.push({ type, model: c.model, why: 'file missing' }); return; }

  let prims;
  try {
    const { json, bin } = parseGlb(readFileSync(file));
    if (!bin) throw new Error('no BIN chunk');
    prims = extractPrimitives(json, bin);
  } catch (e) {
    report.unverifiable.push({ type, model: c.model, why: e.message });
    return;
  }
  if (!prims.length) { report.unverifiable.push({ type, model: c.model, why: 'no POSITION data' }); return; }

  // Overall native bounds + scaled world bounds.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const pr of prims) for (let a = 0; a < 3; a++) { if (pr.min[a] < min[a]) min[a] = pr.min[a]; if (pr.max[a] > max[a]) max[a] = pr.max[a]; }
  const nativeW = max[0] - min[0], nativeH = max[1] - min[1], nativeD = max[2] - min[2];
  const worldW = nativeW * scale, worldH = nativeH * scale, worldD = nativeD * scale;

  // SAFETY SCAN.
  const islands = islandCount(prims, ISLAND_GAP);
  const roomScale = Math.max(worldW, worldD) > ROOM_SCALE || worldH > ROOM_SCALE;
  if (roomScale) {
    report.excluded.push({ type, model: c.model, reason: 'room-scale bounds', worldSize: `${worldW.toFixed(2)}x${worldH.toFixed(2)}x${worldD.toFixed(2)}` });
    return;
  }
  if (islands > 1) {
    report.excluded.push({ type, model: c.model, reason: `multi-object (${islands} disjoint islands)`, worldSize: `${worldW.toFixed(2)}x${worldH.toFixed(2)}x${worldD.toFixed(2)}` });
    return;
  }

  // Build the hull point cloud, at FINAL world scale, in the COLLIDER's local frame:
  //   scale -> recenter so the base rests at y=0 and x/z are centred (exactly what
  //   scene.js instantiateModel does) -> shift down by worldH/2 so the AABB centre is at the
  //   collider origin (shapeFor's convex-hull collider is centred on the body, base at -halfH,
  //   and the caller translates the body to halfH+f.y => base lands on the floor).
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const scaled = [];
  for (const pr of prims) for (const v of pr.verts) {
    scaled.push([
      (v[0] - cx) * scale,             // x centred on the footprint centre
      (v[1] - min[1]) * scale - worldH / 2, // base at 0 then AABB-centre to origin
      (v[2] - cz) * scale,             // z centred
    ]);
  }
  const pts = reduceToHullPoints(scaled, dirs);
  if (pts.length < 4) { report.unverifiable.push({ type, model: c.model, why: `degenerate (${pts.length} hull pts)` }); return; }

  const flat = [];
  for (const p of pts) { flat.push(round5(p[0]), round5(p[1]), round5(p[2])); }
  outHulls[type] = {
    v: flat,
    n: pts.length,
    aabb: { w: round5(worldW), h: round5(worldH), d: round5(worldD) },
  };
  report.hulled.push({ type, from: catalogName, pts: pts.length, worldSize: `${worldW.toFixed(2)}x${worldH.toFixed(2)}x${worldD.toFixed(2)}` });
}

for (const [type, c] of Object.entries(props)) bake('props', type, c);
for (const [type, c] of Object.entries(fixtures)) bake('fixtures', type, c);

// ---- write output ---------------------------------------------------------------------------
const sortedHulls = {};
for (const k of Object.keys(outHulls).sort()) sortedHulls[k] = outHulls[k];
const doc = {
  _comment:
    'GENERATED by tools/build-hulls.mjs — do not hand-edit. Convex-hull collider point clouds ' +
    'baked from each collidable object\'s ACTUAL render geometry. MODEL-bearing entries: the GLB ' +
    'mesh vertices at final world scale (native * map.modelScale). CODE-BUILT entries (no GLB — ' +
    'walls/columns/archway pieces the renderer draws as a raw BoxGeometry(w,h,d)): the box\'s 8 ' +
    'corners from the SAME catalog w/h/d, so the hull can never drift from the drawn box. Each ' +
    'entry: v = flat [x,y,z,...] hull points in the COLLIDER local frame (AABB centre at origin); ' +
    'n = point count; aabb = world-space bounding box (w,h,d). config.js attaches these onto the ' +
    'matching props/fixtures catalog entry as hullVerts/hullAabb; shared/physics.js shapeFor() ' +
    'bakes ColliderDesc.convexHull(v) as its FIRST branch (hull -> measured cuboid -> primitive), ' +
    'with a degenerate-hull fallback. Floors keep their thick-down slab (not hulled). Re-run after ' +
    'changing any GLB or a code-built fixture\'s dims.',
  scan: {
    verdict: report.excluded.length === 0 ? 'all pieces, no room shells' : `${report.excluded.length} exception(s) kept on primitive`,
    roomScaleThreshold: round5(ROOM_SCALE),
    islandGapNative: ISLAND_GAP,
    excluded: report.excluded,
    skippedFloor: report.skippedFloor,
    skippedRound: report.skippedRound,
    unverifiable: report.unverifiable,
  },
  hulls: sortedHulls,
};
writeFileSync(join(root, 'shared', 'config', 'hulls.json'), JSON.stringify(doc, null, 2) + '\n');

// ---- console report -------------------------------------------------------------------------
console.log('CONVEX-HULL BAKE — safety scan + hull generation\n');
console.log(`  map.modelScale=${mapScale}  room-scale threshold=${ROOM_SCALE.toFixed(2)}m  island-gap=${ISLAND_GAP} native\n`);
console.log(`SAFETY SCAN VERDICT: ${doc.scan.verdict}`);
if (report.excluded.length) {
  console.log('  EXCLUDED (kept on primitive — would entomb as one hull):');
  for (const e of report.excluded) console.log(`    - ${e.type} (${e.model}): ${e.reason} [world ${e.worldSize}]`);
} else {
  console.log('  (every candidate is a single-island, sub-room-scale PIECE — safe to hull)');
}
console.log(`\nHULLED ${report.hulled.length} type(s):`);
for (const h of report.hulled) console.log(`    ${h.type.padEnd(16)} ${String(h.pts).padStart(3)} pts   world ${h.worldSize}   (${h.from})`);
if (report.skippedRound.length) console.log(`\nKEPT ROUND PRIMITIVE ${report.skippedRound.length} type(s): ${report.skippedRound.map((r) => r.type).join(', ')}`);
if (report.skippedFloor.length) console.log(`\nFLOOR (kept thick-down slab, not hulled) ${report.skippedFloor.length}: ${report.skippedFloor.map((r) => r.type).join(', ')}`);
if (report.unverifiable.length) {
  console.log(`\nUNVERIFIABLE ${report.unverifiable.length} (kept on primitive):`);
  for (const u of report.unverifiable) console.log(`    - ${u.type} (${u.model || '?'}): ${u.why}`);
}
console.log(`\nwrote shared/config/hulls.json (${Object.keys(sortedHulls).length} hull entries)`);
