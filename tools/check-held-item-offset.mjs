#!/usr/bin/env node
// HELD-ITEM OFFSET — OUTPUT verification (the piece builds #188/#190 skipped, so they shipped a
// fix that never showed in-game). AUTHORING-ONLY: never imported by the page. Run:
//
//     npm install            # once, to get `three` locally (dev-only; the game uses the CDN)
//     node tools/check-held-item-offset.mjs
//
// WHY THIS EXISTS. The remote hunter's rifle/grenade/finder floated off the hand. #188 added a
// FORWARD nudge, #190 a DOWN nudge — but both computed the offset ABOVE the animation mixer, i.e.
// from the wrist's BIND (A-)pose orientation, then baked it into the item's fixed bone-local
// position. The item RENDERS in the aim pose (arm raised, wrist rotated ~90°), so the bind-pose
// "down" tipped to UP and the correction never landed. The old check only asserted the offset CODE
// existed, not its OUTPUT — so the miss shipped twice.
//
// This check LOADS the real GLB, runs the SHIPPED sizing (shared/hunter-sizing.js) AND the SHIPPED
// offset math (shared/hunter-sizing.js::heldItemBoneOffset — the exact function scene.js calls),
// POSES the rig into the shipped idle-aim clip exactly like _buildHunterModel, then asserts on the
// RESULT — including with the model YAWED, the case a bind-pose / world-space bug fails:
//   (a) the applied DOWN offset lands in the requested 0.15–0.20 m band on the model's vertical;
//   (b) the FORWARD component is genuinely > 0 along the character's facing (item is NOT behind);
//   (c) the item's grip sits on the HAND side of the wrist (toward the forearm→hand direction),
//       within a few cm of the hand-scale target — not floating off it;
//   (d) all of the above still hold when the model is rotated (yaw-independent, as designed).
// A violation FAILS the build.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import { sizeHunterRig, findBone, heldItemBoneOffset } from '../shared/hunter-sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('held-item offset OUTPUT check (loads the real GLB, poses the rig, runs the shipped math)\n');

const reg = readJSON('shared', 'config', 'character-models.json');
const hunter = reg.hunter;
const wcfg = hunter.weapon || {};

// --- config sanity: the requested spec band -------------------------------------------------
ok(Number.isFinite(wcfg.forwardOffset) && wcfg.forwardOffset > 0,
  `weapon.forwardOffset is a positive number (${wcfg.forwardOffset}) — item pushed toward the hand`);
ok(Number.isFinite(wcfg.downOffset) && wcfg.downOffset >= 0.15 && wcfg.downOffset <= 0.20,
  `weapon.downOffset ${wcfg.downOffset} m is in the requested 0.15–0.20 m band`);

// --- load + size the rig exactly like scene._buildHunterModel -------------------------------
function loadGlb(file) {
  const buf = readFileSync(join(root, 'assets', file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject));
}

let gltf;
try { gltf = await loadGlb(hunter.model); }
catch (e) { console.error(`  ✗ failed to load assets/${hunter.model}:`, e && e.message ? e.message : e); process.exit(1); }

const inner = skeletonClone(gltf.scene);
const { group } = sizeHunterRig(THREE, inner, hunter);
const scene = new THREE.Scene();
scene.add(group);
scene.updateMatrixWorld(true);

const bone = findBone(inner, wcfg.attachBone);
ok(!!bone, `weapon attachBone "${wcfg.attachBone}" resolves to a rig bone`);
if (!bone) { console.error('\ncannot continue without the wrist bone'); process.exit(1); }

// --- POSE-FIRST: pose the rig into the idle aim clip, exactly like the build ------------------
const resolveClip = (suffix) =>
  (gltf.animations || []).find((c) => c.name === suffix) ||
  (gltf.animations || []).find((c) => c.name.endsWith('|' + suffix)) ||
  (gltf.animations || []).find((c) => c.name.endsWith(suffix)) || null;
const idleClip = resolveClip(hunter.clips.idle);
ok(!!idleClip, `idle aim clip "${hunter.clips.idle}" resolves in the GLB (${idleClip ? idleClip.name : 'NONE'})`);
const mixer = new THREE.AnimationMixer(inner);
if (idleClip) mixer.clipAction(idleClip).play();
mixer.update(0.2);
group.updateMatrixWorld(true);

// --- compute + apply the SHIPPED offset, attach a grip marker like the held item -------------
const off = heldItemBoneOffset(THREE, bone, group, wcfg);
const marker = new THREE.Object3D();
marker.position.copy(off);
bone.add(marker);

// Hand direction from the rig: forearm(elbow) -> wrist points along the hand/palm reach.
const elbow = findBone(inner, 'LowerArm.R');

// Measure the grip displacement relative to the wrist, in the character's LOCAL frame (undo the
// group yaw), so "forward"/"down" are the model's own axes whatever way it happens to face.
function measure(label, yawRad) {
  group.rotation.y = yawRad || 0;
  mixer.update(0.05);
  group.updateMatrixWorld(true);
  const wrist = bone.getWorldPosition(new THREE.Vector3());
  const grip = marker.getWorldPosition(new THREE.Vector3());
  const dispWorld = grip.clone().sub(wrist);
  // Rotate the world displacement back into the character frame (group is only yawed about Y).
  const local = dispWorld.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -(yawRad || 0));
  const forward = -local.z; // group -Z = facing
  const downC = -local.y;   // group -Y = model-vertical down
  // Forearm->wrist (hand reach) in the same character frame.
  let handDot = null;
  if (elbow) {
    const e = elbow.getWorldPosition(new THREE.Vector3());
    const reachWorld = wrist.clone().sub(e);
    const reachLocal = reachWorld.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -(yawRad || 0)).normalize();
    handDot = local.clone().normalize().dot(reachLocal);
  }
  console.log(`\n  [${label}] grip vs wrist (character frame): forward=${forward.toFixed(3)}m down=${downC.toFixed(3)}m |disp|=${local.length().toFixed(3)}m` +
    (handDot === null ? '' : `  hand-dir dot=${handDot.toFixed(2)}`));
  ok(forward > 0.05, `  forward component ${forward.toFixed(3)} m is positive (item in FRONT of the wrist, not behind)`);
  ok(forward > wcfg.forwardOffset - 0.05 && forward < wcfg.forwardOffset + 0.05,
    `  forward component ${forward.toFixed(3)} m matches weapon.forwardOffset ${wcfg.forwardOffset} m (±0.05)`);
  ok(downC >= 0.15 && downC <= 0.20,
    `  DOWN component ${downC.toFixed(3)} m lands in the requested 0.15–0.20 m band (drops INTO the hand, not floating above)`);
  ok(local.length() > 0.15 && local.length() < 0.40,
    `  total grip displacement ${local.length().toFixed(3)} m is hand-scale (a few cm from the wrist/palm target)`);
  if (handDot !== null) {
    ok(handDot > 0, `  grip is on the HAND side of the wrist (dot with forearm→hand = ${handDot.toFixed(2)} > 0)`);
  }
}

// (1) facing forward (yaw 0) and (2) rotated — a bind-pose / world-space bug fails the rotated case.
measure('facing 0°', 0);
measure('yawed 115°', 115 * Math.PI / 180);
measure('yawed -80°', -80 * Math.PI / 180);

console.log('');
if (fails) {
  console.error(`held-item offset check FAILED (${fails} problem${fails > 1 ? 's' : ''}) — the grip is off the hand; do NOT ship.`);
  process.exit(1);
}
console.log('held-item offset check passed — grip sits forward+down in the hand across facings.');
