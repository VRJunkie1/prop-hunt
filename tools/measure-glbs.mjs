#!/usr/bin/env node
// measure-glbs.mjs — AUTHORING TOOL, never shipped to players.
//
// Reads every .glb in assets/restaurant/ and records its true native bounding
// box (width/height/depth, in the model's own world units) by parsing the GLB
// binary container directly — NO rendering, NO Three.js, NO external deps.
//
// Why parse instead of eyeball: a GLB's JSON chunk lists, per mesh POSITION
// attribute, an accessor with exact `min`/`max` arrays (the local-space AABB of
// that vertex stream). That is enough to size a model without ever touching the
// binary vertex data. The one subtlety — and it MATTERS — is that FBX2glTF (the
// generator for this pack) bakes a `scale:[100,100,100]` (and sometimes a
// translation) onto each mesh's NODE. The accessor min/max are in the mesh's
// LOCAL space, BEFORE that node transform. So we must walk the node hierarchy,
// compose each node's world matrix, and transform the 8 AABB corners by it before
// accumulating — exactly what THREE.Box3().setFromObject(scene) does at runtime.
// Reading the raw accessor numbers alone would report a door as 0.016 units wide
// instead of its real 1.6. (Verified: door.glb accessor max.x=0.016, node
// scale=100 -> real width 1.6.)
//
// Output: shared/config/asset-dims.json — { "restaurant/<file>.glb": {w,h,d} }.
// Committed so map edits and the (future) physics/collider bake read MEASURED
// sizes instead of guessing. Re-run after adding/replacing any restaurant GLB:
//
//     node tools/measure-glbs.mjs
//
// This runs at AUTHORING time only. The game never imports it and never measures
// at page boot — the baked numbers live in the committed data files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'assets', 'restaurant');
const OUT = path.join(ROOT, 'shared', 'config', 'asset-dims.json');

// ---- tiny mat4 helpers (column-major, glTF convention) ---------------------
function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function fromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
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
  const t = n.translation || [0, 0, 0];
  const q = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  return fromTRS(t, q, s);
}
function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// ---- GLB container parsing --------------------------------------------------
function readGltfJson(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)'); // 'glTF'
  // header: magic(4) version(4) length(4); then chunks: length(4) type(4) data
  let off = 12;
  const chunkLen = buf.readUInt32LE(off);
  const chunkType = buf.readUInt32LE(off + 4);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON'); // 'JSON'
  const json = buf.slice(off + 8, off + 8 + chunkLen).toString('utf8');
  return JSON.parse(json);
}

// Accumulate the whole scene's world-space AABB from accessor min/max + node xforms.
function measure(gltf) {
  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];
  const accessors = gltf.accessors || [];
  const sceneIdx = gltf.scene || 0;
  const roots = (gltf.scenes && gltf.scenes[sceneIdx] && gltf.scenes[sceneIdx].nodes) || [];

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let any = false;

  const visit = (idx, parent) => {
    const n = nodes[idx];
    if (!n) return;
    const world = multiply(parent, nodeLocalMatrix(n));
    if (typeof n.mesh === 'number' && meshes[n.mesh]) {
      for (const prim of meshes[n.mesh].primitives || []) {
        const posIdx = prim.attributes && prim.attributes.POSITION;
        if (typeof posIdx !== 'number') continue;
        const acc = accessors[posIdx];
        if (!acc || !acc.min || !acc.max) continue;
        const lo = acc.min, hi = acc.max;
        // Transform all 8 corners of the local AABB by the node's world matrix.
        for (let cx = 0; cx < 2; cx++)
          for (let cy = 0; cy < 2; cy++)
            for (let cz = 0; cz < 2; cz++) {
              const p = transformPoint(world, [cx ? hi[0] : lo[0], cy ? hi[1] : lo[1], cz ? hi[2] : lo[2]]);
              for (let a = 0; a < 3; a++) {
                if (p[a] < min[a]) min[a] = p[a];
                if (p[a] > max[a]) max[a] = p[a];
              }
              any = true;
            }
      }
    }
    for (const child of n.children || []) visit(child, world);
  };
  for (const r of roots) visit(r, identity());

  if (!any) return null;
  const round = (v) => Math.round(v * 10000) / 10000;
  return { w: round(max[0] - min[0]), h: round(max[1] - min[1]), d: round(max[2] - min[2]) };
}

// ---- main -------------------------------------------------------------------
function main() {
  const files = fs.readdirSync(ASSET_DIR).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
  const out = {};
  let ok = 0, bad = 0;
  for (const f of files) {
    try {
      const gltf = readGltfJson(fs.readFileSync(path.join(ASSET_DIR, f)));
      const dims = measure(gltf);
      if (dims) {
        out['restaurant/' + f] = dims;
        ok++;
      } else {
        bad++;
        console.warn('  no POSITION accessor bounds:', f);
      }
    } catch (e) {
      bad++;
      console.warn('  failed:', f, '-', e.message);
    }
  }
  const header = {
    _comment:
      'GENERATED by tools/measure-glbs.mjs — do not hand-edit. Native bounding box ' +
      '(w=x, h=y, d=z) of every restaurant GLB in the model\'s own world units, ' +
      'measured from the GLB JSON chunk (accessor POSITION min/max transformed by ' +
      'node world matrices). These are the ground-truth sizes the map/prop scales ' +
      'are derived from: applied world size = native * map.modelScale (0.75). Re-run ' +
      'the tool after changing any GLB. Measured at authoring time, never at page boot.',
  };
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  fs.writeFileSync(OUT, JSON.stringify({ ...header, ...sorted }, null, 2) + '\n');
  console.log(`measured ${ok} GLB(s) -> ${path.relative(ROOT, OUT)}${bad ? ` (${bad} skipped)` : ''}`);
}

main();
