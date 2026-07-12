#!/usr/bin/env node
// HUNTER MODEL SIZE — OUTPUT verification (the piece the last two builds skipped).
// AUTHORING-ONLY: never imported by the page or shipped to a browser. Run from a shell:
//
//     npm install            # once, to get `three` locally (dev-only; the game uses the CDN)
//     node tools/check-hunter-model-size.mjs
//
// WHY THIS EXISTS. The SWAT hunter shipped tiny + orbiting TWICE because the sizing code
// measured the model's RAW skinned geometry (stored ~3.6 mm tall in this GLB) instead of
// the SKELETON that inflates it to human size via a baked [100,100,100] bone scale. The
// previous checks only asserted "the code exists" — not that its OUTPUT is a correctly
// sized, correctly planted model. So this check LOADS THE ACTUAL GLB with three +
// GLTFLoader, runs the SAME sizing function the game ships (shared/hunter-sizing.js — no
// copy-paste), and asserts on the RESULT:
//   - final bone-derived world height within ±10% of the configured target (~1.8 m);
//   - feet centroid within 0.1 m of y=0 (stands on the floor, not floating/buried);
//   - x/z centroid within 0.1 m of the group origin (planted on the player's spot, not on
//     a lever arm that would orbit as the player yaws — the exact live symptom).
// A violation FAILS the build.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import { sizeHunterRig, measureRigBones, findBone } from '../shared/hunter-sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('hunter model SIZE check (loads the real GLB, runs the shipped sizing code)\n');

const reg = readJSON('shared', 'config', 'character-models.json');
const hunter = reg.hunter;
if (!hunter || !hunter.model) {
  console.error('  ✗ character-models.json has no hunter.model — cannot check');
  process.exit(1);
}
const targetH = hunter.heightMeters > 0 ? hunter.heightMeters : 1.8;

// ---- load the real GLB with GLTFLoader (headless: this pack has 0 image textures) ------
function loadGlb(file) {
  const buf = readFileSync(join(root, 'assets', file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(ab, '', (gltf) => resolve(gltf), (err) => reject(err));
  });
}

let gltf;
try {
  gltf = await loadGlb(hunter.model);
} catch (e) {
  console.error(`  ✗ failed to load assets/${hunter.model} with GLTFLoader:`, e && e.message ? e.message : e);
  process.exit(1);
}
ok(!!gltf.scene, `loaded assets/${hunter.model} (${(gltf.animations || []).length} clips)`);

// Rig-safe clone — exactly what scene.js does before sizing.
const inner = skeletonClone(gltf.scene);

// Sanity: the rig actually has bones (else the fix can't work and the fallback would fire).
const preBones = measureRigBones(THREE, inner);
ok(!!preBones && preBones.count >= 10, `rig has a real skeleton (${preBones ? preBones.count : 0} bones)`);
if (preBones) {
  console.log(`      raw bone span (pre-scale): height=${preBones.height.toFixed(3)} footY=${preBones.footY.toFixed(3)} ` +
    `cx=${preBones.cx.toFixed(3)} cz=${preBones.cz.toFixed(3)}`);
}

// ---- run the SHIPPED sizing function --------------------------------------------------
const res = sizeHunterRig(THREE, inner, hunter);
ok(!res.degenerate, 'sizing used the BONE measurement (not the degenerate-geometry fallback)');
console.log(`      sizeHunterRig: trueHeight=${res.trueHeight.toFixed(3)} scale=${res.scale.toFixed(4)} ` +
  `finalHeight(arith)=${res.finalHeight.toFixed(3)}`);

// ---- assert on the REAL OUTPUT: re-measure the placed group in world space -------------
// Add the group to a scene, refresh world matrices, and measure the bones as they will
// actually render. This is the output the previous builds never checked.
const scene = new THREE.Scene();
scene.add(res.group);
scene.updateMatrixWorld(true);
const out = measureRigBones(THREE, res.group);
ok(!!out, 'placed model still has measurable bones');

if (out) {
  const height = out.height;
  const footY = out.footY;
  const cx = out.cx;
  const cz = out.cz;
  console.log(`      PLACED bone bounds: height=${height.toFixed(3)}m footY=${footY.toFixed(3)}m ` +
    `cx=${cx.toFixed(3)}m cz=${cz.toFixed(3)}m (target ${targetH}m)`);

  const heightTol = 0.10 * targetH; // ±10%
  ok(Math.abs(height - targetH) <= heightTol,
    `final bone height ${height.toFixed(3)}m is within ±10% of target ${targetH}m`);
  ok(Math.abs(footY) <= 0.1,
    `feet centroid ${footY.toFixed(3)}m is within 0.1m of the floor (y=0)`);
  ok(Math.abs(cx) <= 0.1 && Math.abs(cz) <= 0.1,
    `x/z centroid (${cx.toFixed(3)}, ${cz.toFixed(3)}) is within 0.1m of the group origin ` +
    `(no lever arm — model won't orbit the player)`);
}

// ---- weapon: the configured wrist bone must exist (the rifle parents to it) ------------
const wcfg = hunter.weapon || {};
if (wcfg.attachBone) {
  // Same tolerant lookup the game uses — GLTFLoader sanitizes "Wrist.R" to "WristR".
  const b = findBone(inner, wcfg.attachBone);
  ok(!!b, `weapon attachBone "${wcfg.attachBone}" resolves to a rig bone (rifle can attach) — matched "${b ? b.name : 'NONE'}"`);
}
if (wcfg.model) {
  try {
    const wg = await loadGlb(wcfg.model);
    const wb = new THREE.Box3().setFromObject(wg.scene);
    const ws = new THREE.Vector3();
    wb.getSize(ws);
    ok(ws.length() > 0, `weapon GLB assets/${wcfg.model} loads with real geometry (world-length-normalised at runtime)`);
  } catch (e) {
    ok(false, `weapon GLB assets/${wcfg.model} failed to load: ${e && e.message ? e.message : e}`);
  }
}

console.log('');
if (fails) {
  console.error(`hunter model SIZE check FAILED (${fails} problem${fails > 1 ? 's' : ''}) — the model is mis-sized/mis-placed; do NOT ship.`);
  process.exit(1);
}
console.log('hunter model SIZE check passed');
