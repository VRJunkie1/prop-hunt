// Full-orientation solve: find weapon.rotationDeg so the rifle barrel points forward and
// the gun is upright, using the shoot/aim wrist pose family (Idle_Gun_Pointing / Run_Shoot).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { sizeHunterRig, findBone } from '../shared/hunter-sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const reg = JSON.parse(readFileSync(join(root, 'shared/config/character-models.json'), 'utf8'));
const hunter = reg.hunter;
function loadGlb(file) {
  const buf = readFileSync(join(root, 'assets', file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
}
const body = await loadGlb(hunter.model);
const f = (v) => v.toArray().map((x) => x.toFixed(2)).join(',');

function boneQuatFor(clipName, t) {
  const inner = skeletonClone(body.scene);
  const { group } = sizeHunterRig(THREE, inner, hunter);
  const clip = body.animations.find((a) => a.name.endsWith(clipName));
  const mixer = new THREE.AnimationMixer(inner);
  mixer.clipAction(clip).play();
  mixer.update(t || 0);
  const scene = new THREE.Scene(); scene.add(group); scene.updateMatrixWorld(true);
  const bone = findBone(inner, hunter.weapon.attachBone);
  const q = new THREE.Quaternion(); bone.getWorldQuaternion(q);
  return q;
}

// Reference wrist orientation = Idle_Gun_Pointing (static aim). Solve so:
//   barrel(rifle local +X) -> world forward (0,0,-1)
//   gun-up (rifle local +Y) -> world up (0,1,0)
const boneQ = boneQuatFor('Idle_Gun_Pointing', 0);
const boneInv = boneQ.clone().invert();

function solve(muzzleSign, upSign) {
  // desired world basis for the rifle local (X=barrel, Y=up, Z=side)
  const wX = new THREE.Vector3(0, 0, -1).multiplyScalar(muzzleSign); // barrel -> forward
  const wY = new THREE.Vector3(0, 1, 0).multiplyScalar(upSign);      // gun up -> world up
  const wZ = new THREE.Vector3().crossVectors(wX, wY).normalize();
  const wYo = new THREE.Vector3().crossVectors(wZ, wX).normalize();  // re-orthogonalize
  // bone-local targets
  const lX = wX.clone().applyQuaternion(boneInv);
  const lY = wYo.clone().applyQuaternion(boneInv);
  const lZ = wZ.clone().applyQuaternion(boneInv);
  const m = new THREE.Matrix4().makeBasis(lX, lY, lZ);
  const R = new THREE.Quaternion().setFromRotationMatrix(m);
  const e = new THREE.Euler().setFromQuaternion(R, 'XYZ');
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  return { R, deg: { x: deg(e.x), y: deg(e.y), z: deg(e.z) } };
}

function verify(clipName, R) {
  const q = boneQuatFor(clipName, 0);
  const barrel = new THREE.Vector3(1, 0, 0).applyQuaternion(R).applyQuaternion(q).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(R).applyQuaternion(q).normalize();
  return `barrel=[${f(barrel)}] up=[${f(up)}]`;
}

// muzzle=+X forward, up=+Y up
for (const [ms, us, label] of [[1, 1, 'muzzle+X, up+Y'], [-1, 1, 'muzzle-X, up+Y'], [1, -1, 'muzzle+X, up-Y']]) {
  const s = solve(ms, us);
  console.log(`\n[${label}] rotationDeg=${JSON.stringify(s.deg)}`);
  for (const c of ['Idle_Gun_Pointing', 'Run_Shoot', 'Gun_Shoot', 'Idle_Gun_Shoot']) {
    console.log(`   ${c.padEnd(18)} ${verify(c, s.R)}`);
  }
}
console.log('\nGoal: barrel ~ (0,0,-1) forward, up ~ (0,1,0). Pick the variant that achieves it.');
