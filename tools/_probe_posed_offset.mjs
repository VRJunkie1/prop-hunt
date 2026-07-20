#!/usr/bin/env node
// AUTHORING-ONLY diagnostic (never shipped). Proves WHERE the held-item offset actually lands
// once the rig is POSED in the shipped aim clip — the thing the static check never verified.
//
// The build (js/scene.js::_buildHunterModel) computes the forward+down offset from the wrist
// bone's world orientation AT BUILD TIME, i.e. the BIND (A-)pose, then bakes it into the item's
// bone-local position. But the item is rendered while the mixer poses the rig in Idle_Gun_Pointing
// (arm raised, aiming forward) — a very different wrist orientation. A bone-local vector that is
// "forward+down" in the bind pose points somewhere else entirely in the aim pose. This script
// measures both so we can see the discrepancy and derive the correct posed-frame offset.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import { sizeHunterRig, findBone } from '../shared/hunter-sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

const reg = readJSON('shared', 'config', 'character-models.json');
const hunter = reg.hunter;
const wcfg = hunter.weapon;

function loadGlb(file) {
  const buf = readFileSync(join(root, 'assets', file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(ab, '', resolve, reject);
  });
}

const gltf = await loadGlb(hunter.model);
const inner = skeletonClone(gltf.scene);
const res = sizeHunterRig(THREE, inner, hunter);
const group = res.group;
const scene = new THREE.Scene();
scene.add(group);
scene.updateMatrixWorld(true);

const bone = findBone(inner, wcfg.attachBone);

// helper: bone-local direction for a group-frame axis, exactly like scene._boneLocalDir
const boneLocalDir = (b, gx, gy, gz) => {
  const q = b.getWorldQuaternion(new THREE.Quaternion());
  return new THREE.Vector3(gx, gy, gz).applyQuaternion(q.invert()).normalize();
};
const boneWorldScale = (b) => {
  const bs = new THREE.Vector3();
  b.getWorldScale(bs);
  return (Math.abs(bs.x) + Math.abs(bs.y) + Math.abs(bs.z)) / 3 || 1;
};

const fwd = wcfg.forwardOffset, down = wcfg.downOffset;
const invScale = 1 / boneWorldScale(bone);

// ---- (A) BIND POSE: what the current build computes ----
const offBind = new THREE.Vector3();
offBind.add(boneLocalDir(bone, 0, 0, -1).multiplyScalar(fwd * invScale));
offBind.add(boneLocalDir(bone, 0, -1, 0).multiplyScalar(down * invScale));

// Attach a marker at that bone-local offset (a child of the wrist, like the held item).
const marker = new THREE.Object3D();
marker.position.copy(offBind);
bone.add(marker);
scene.updateMatrixWorld(true);
const wristBind = bone.getWorldPosition(new THREE.Vector3());
const markerBindWorld = marker.getWorldPosition(new THREE.Vector3());
const dispBind_bindpose = markerBindWorld.clone().sub(wristBind);

console.log('=== HELD-ITEM OFFSET DIAGNOSTIC ===');
console.log(`config: forwardOffset=${fwd} downOffset=${down}  invBoneScale=${invScale.toExponential(3)}`);
console.log('world axes: forward = -Z, down = -Y, right = +X\n');
console.log('(A) BIND POSE — offset baked by current build, measured in BIND pose:');
console.log(`    wrist world:  [${wristBind.toArray().map(n=>n.toFixed(3)).join(', ')}]`);
console.log(`    item displacement (world): [${dispBind_bindpose.toArray().map(n=>n.toFixed(3)).join(', ')}]  |len|=${dispBind_bindpose.length().toFixed(3)}m`);

// ---- Now POSE the rig in the shipped idle aim clip and re-measure the SAME baked offset ----
const clipName = hunter.clips.idle; // Idle_Gun_Pointing
const clips = gltf.animations || [];
const resolveClip = (suffix) =>
  clips.find((c) => c.name === suffix) ||
  clips.find((c) => c.name.endsWith('|' + suffix)) ||
  clips.find((c) => c.name.endsWith(suffix)) || null;
const clip = resolveClip(clipName);
const mixer = new THREE.AnimationMixer(inner);
mixer.clipAction(clip).play();
mixer.update(0.5); // advance into the pose
scene.updateMatrixWorld(true);

const wristPosed = bone.getWorldPosition(new THREE.Vector3());
const markerPosedWorld = marker.getWorldPosition(new THREE.Vector3());
const dispBind_posed = markerPosedWorld.clone().sub(wristPosed);

console.log(`\n(B) POSED (${clip.name}) — SAME baked (bind-pose) offset, now rendered in aim pose:`);
console.log(`    wrist world:  [${wristPosed.toArray().map(n=>n.toFixed(3)).join(', ')}]`);
console.log(`    item displacement (world): [${dispBind_posed.toArray().map(n=>n.toFixed(3)).join(', ')}]  |len|=${dispBind_posed.length().toFixed(3)}m`);
console.log(`    --> forward comp (-Z): ${(-dispBind_posed.z).toFixed(3)}m   down comp (-Y): ${(-dispBind_posed.y).toFixed(3)}m`);
console.log(`    (want forward>0 and down>0; if forward<0 the item is pushed BEHIND the hand)`);

// ---- (C) CORRECT approach: derive the offset in the POSED frame ----
const offPosed = new THREE.Vector3();
offPosed.add(boneLocalDir(bone, 0, 0, -1).multiplyScalar(fwd * invScale));
offPosed.add(boneLocalDir(bone, 0, -1, 0).multiplyScalar(down * invScale));
const marker2 = new THREE.Object3D();
marker2.position.copy(offPosed);
bone.add(marker2);
scene.updateMatrixWorld(true);
const marker2World = marker2.getWorldPosition(new THREE.Vector3());
const dispPosed = marker2World.clone().sub(wristPosed);
console.log(`\n(C) POSED-frame-derived offset (the fix), measured in the same aim pose:`);
console.log(`    item displacement (world): [${dispPosed.toArray().map(n=>n.toFixed(3)).join(', ')}]  |len|=${dispPosed.length().toFixed(3)}m`);
console.log(`    --> forward comp (-Z): ${(-dispPosed.z).toFixed(3)}m   down comp (-Y): ${(-dispPosed.y).toFixed(3)}m`);

// ---- Hand target: is there a hand/finger bone forward of the wrist? ----
console.log('\n(D) Nearby bones (world pos, m) to locate the actual hand/palm target:');
const norm = (s) => String(s||'').replace(/[\s._:|-]/g,'').toLowerCase();
inner.updateMatrixWorld(true);
const wanted = ['wristr','handr','palmr','indexr','middler','ringr','lowerarmr','fingersr'];
inner.traverse((o) => {
  if (!o.isBone) return;
  const n = norm(o.name);
  if (wanted.some((w) => n.includes(w) || w.includes(n))) {
    const p = o.getWorldPosition(new THREE.Vector3());
    console.log(`    ${o.name.padEnd(20)} [${p.toArray().map(v=>v.toFixed(3)).join(', ')}]`);
  }
});
