// One-off probe (authoring-only, never shipped): compute the REST-POSE world position of the
// hunter's right-wrist bone (the held-item anchor) and the arm chain, straight from the GLB node
// hierarchy, so the held-item DOWN+FORWARD offset (build #190) is anchored to real geometry instead
// of a blind number. It walks the glTF node tree applying each node's TRS, measures the full bone
// span for the true rendered height, then reports the wrist relative to the shoulder in METRES after
// the model is scaled to heightMeters. See memory/notes/hunter-character-model.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cm = JSON.parse(readFileSync(join(root, 'shared', 'config', 'character-models.json'), 'utf8'));
const buf = readFileSync(join(root, 'assets', cm.hunter.model));
const chunkLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen));

// --- tiny 4x4 (column-major, like THREE/glMatrix) TRS + multiply ------------------------------
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
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
};
const nodeLocal = (n) => (n.matrix ? n.matrix.slice() : trs(n.translation, n.rotation, n.scale));
const posOf = (m) => [m[12], m[13], m[14]];

// --- walk the scene node tree, recording each node's world matrix -----------------------------
const nodes = json.nodes || [];
const nameToWorld = new Map();
const walk = (idx, parent) => {
  const n = nodes[idx];
  const world = mul(parent, nodeLocal(n));
  if (n.name) nameToWorld.set(n.name, world);
  for (const c of n.children || []) walk(c, world);
};
const I = trs();
const scene = json.scenes[json.scene || 0];
for (const r of scene.nodes) walk(r, I);

// --- bone span → true height → scale to heightMeters -----------------------------------------
// The armature bakes a large node scale; the rig is later scaled by targetH/trueHeight (see
// shared/hunter-sizing.js). We replicate that here so distances come out in RENDERED metres.
let minY = Infinity, maxY = -Infinity;
for (const [, m] of nameToWorld) { const y = m[13]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
const trueHeight = maxY - minY;
const targetH = cm.hunter.heightMeters || 1.8;
const scale = trueHeight > 1e-6 ? targetH / trueHeight : 1;

const get = (name) => {
  // tolerant match (GLTFLoader sanitizes "Wrist.R" -> "WristR")
  const norm = (s) => String(s).replace(/[\s._:|-]/g, '').toLowerCase();
  for (const [k, v] of nameToWorld) if (norm(k) === norm(name)) return v;
  return null;
};

console.log('hunter held-item hand-offset probe (rest pose, native glTF frame)');
console.log(`  bone span (native units): ${trueHeight.toFixed(4)}  -> scale to ${targetH} m = ×${scale.toFixed(5)}`);
console.log('');

const bones = ['UpperArm.R', 'LowerArm.R', 'Wrist.R', 'Head'];
const P = {};
for (const b of bones) {
  const m = get(b);
  if (!m) { console.log(`  ${b}: NOT FOUND`); continue; }
  P[b] = posOf(m).map((v) => v * scale); // rendered metres, model origin at native origin
}
const fmt = (p) => `[${p.map((v) => v.toFixed(3)).join(', ')}]`;
for (const b of bones) if (P[b]) console.log(`  ${b} world (m, ×scale): ${fmt(P[b])}`);

// Arm reach: shoulder -> wrist, and forearm length — sanity anchors for a 0.1-0.2 m nudge.
if (P['UpperArm.R'] && P['Wrist.R']) {
  const d = P['Wrist.R'].map((v, i) => v - P['UpperArm.R'][i]);
  const len = Math.hypot(...d);
  console.log('');
  console.log(`  shoulder->wrist span: ${fmt(d)}  |len| = ${len.toFixed(3)} m`);
}
if (P['LowerArm.R'] && P['Wrist.R']) {
  const d = P['Wrist.R'].map((v, i) => v - P['LowerArm.R'][i]);
  console.log(`  forearm (elbow->wrist) len: ${Math.hypot(...d).toFixed(3)} m`);
}
console.log('');
console.log('  NOTE: rest pose only — the shipped pose is Idle_Gun_Pointing/Run_Shoot, which raises');
console.log('  the arm. Values here anchor MAGNITUDE (a ~0.15-0.20 m nudge vs arm length), not the');
console.log('  exact live grip point; direction is guaranteed by the group-frame axes in scene.js.');
