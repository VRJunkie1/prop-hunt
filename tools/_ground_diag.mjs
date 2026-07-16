// DIAGNOSTIC (throwaway): find objects whose base does NOT rest on a support.
// base(O) = authored O.y ; top(O) = O.y + 2*halfH. A support is any object (incl.
// architecture floors + the ground y=0) whose footprint overlaps O's centre and whose
// top is at/below O's base. gap = base - bestSupportTop:  >0 => FLOATING, <0 => SUNK.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { halfExtentsFor, isArchEntry } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
let hullDefs = {};
try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = h.aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };
const TOL = 0.06;

// centre (px,pz) inside yaw-rotated footprint of o?
function centerIn(o, px, pz, pad = 0) {
  const dx = px - o.x, dz = pz - o.z;
  const c = Math.cos(-(o.rot || 0)), s = Math.sin(-(o.rot || 0));
  const lx = Math.abs(dx * c - dz * s), lz = Math.abs(dx * s + dz * c);
  return lx <= o.hx + pad && lz <= o.hz + pad;
}

for (const [mapId, map] of Object.entries(maps)) {
  const objs = [];
  const add = (o, kind) => {
    const c = catalog[o.type];
    if (!c) return;
    const he = halfExtentsFor(c);
    objs.push({ type: o.type, x: o.x, z: o.z, rot: o.rot || 0, hx: he.hx, hz: he.hz,
      base: o.y || 0, top: (o.y || 0) + 2 * he.hy, arch: isArchEntry(c), kind });
  };
  (map.fixtures || []).forEach((f) => add(f, 'fixture'));
  (map.props || []).forEach((p) => add(p, 'prop'));

  const problems = [];
  for (const o of objs) {
    if (o.arch) continue; // architecture stays put (floors/walls/ceilings), exempt
    let supTop = 0, supWho = 'floor'; // ground
    for (const s of objs) {
      if (s === o) continue;
      if (s.top > o.base + TOL) continue;      // not below us -> can't support
      if (!centerIn(s, o.x, o.z, 0.05)) continue; // our centre not over it
      if (s.top > supTop) { supTop = s.top; supWho = `${s.type}@(${s.x},${s.z})`; }
    }
    const gap = o.base - supTop;
    if (Math.abs(gap) > TOL) problems.push({ o, gap, supWho, supTop });
  }
  console.log(`\n=== ${mapId} === (${objs.length} objects, ${problems.length} not grounded)`);
  problems.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  for (const p of problems) {
    const kind = p.gap > 0 ? 'FLOAT' : 'SUNK ';
    console.log(`  ${kind} ${p.o.type}@(${p.o.x},${p.o.z}) base=${p.o.base.toFixed(2)} support=${p.supWho} top=${p.supTop.toFixed(2)} gap=${p.gap.toFixed(2)}`);
  }
}
