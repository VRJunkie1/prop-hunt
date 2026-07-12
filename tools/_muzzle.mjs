import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const reg = JSON.parse(readFileSync(join(root, 'shared/config/character-models.json'), 'utf8'));
function loadGlb(file) {
  const buf = readFileSync(join(root, 'assets', file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
}
const g = await loadGlb(reg.hunter.weapon.model);
g.scene.updateMatrixWorld(true);
const bb = new THREE.Box3().setFromObject(g.scene);
const c = new THREE.Vector3(); bb.getCenter(c);
// vertex centroid + cross-section area near each X extreme
let sum = new THREE.Vector3(), n = 0;
let loCount = 0, hiCount = 0; // vertices near -X and +X ends
const v = new THREE.Vector3();
g.scene.traverse((o) => {
  if (!o.isMesh) return;
  const pos = o.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i); v.applyMatrix4(o.matrixWorld);
    sum.add(v); n++;
    if (v.x < bb.min.x + (bb.max.x - bb.min.x) * 0.15) loCount++;
    if (v.x > bb.max.x - (bb.max.x - bb.min.x) * 0.15) hiCount++;
  }
});
sum.multiplyScalar(1 / n);
console.log('bbox min.x/max.x:', bb.min.x.toFixed(2), bb.max.x.toFixed(2), 'center.x:', c.x.toFixed(3));
console.log('vertex centroid.x:', sum.x.toFixed(3));
console.log('verts near -X end:', loCount, ' near +X end:', hiCount);
console.log('=> muzzle (thin barrel = fewer verts) is at', hiCount < loCount ? '+X' : '-X', 'end');
