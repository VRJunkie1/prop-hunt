// THROWAWAY DIAGNOSTIC (_-prefixed, like the other probes). Measures, for every fixture/prop,
// its collider base vs the floor surface directly under it, so we can SEE how far the counters
// (and anything else) sit below the tile/ground they stand on. Not a build gate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { halfExtentsFor, isArchEntry } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (name) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', name), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const assetDims = cfg('asset-dims.json');
let hullDefs = {};
try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [type, box] of Object.entries(dims)) {
  if (!box || !(box.w > 0 && box.h > 0 && box.d > 0)) continue;
  const m = { w: box.w, h: box.h, d: box.d };
  if (props[type]) props[type].measured = m;
  if (fixtures[type]) fixtures[type].measured = m;
}
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = h.aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };

function footprint(o, c) {
  const he = halfExtentsFor(c);
  const rot = o.rot || 0;
  const co = Math.abs(Math.cos(rot)), si = Math.abs(Math.sin(rot));
  return { hx: he.hx * co + he.hz * si, hz: he.hx * si + he.hz * co, height: 2 * he.hy };
}

for (const [mapId, map] of Object.entries(maps)) {
  const items = [];
  const collect = (arr, kind) => {
    for (const o of arr || []) {
      const c = catalog[o.type];
      if (!c) continue;
      const fp = footprint(o, c);
      items.push({ o, kind, type: o.type, x: o.x, z: o.z, hx: fp.hx, hz: fp.hz, height: fp.height, base: o.y || 0, isFloor: !!c.floor, arch: isArchEntry(c) });
    }
  };
  collect(map.fixtures, 'fixture');
  collect(map.props, 'prop');

  // floor surface under an item (top of highest floor fixture whose footprint contains centre, else 0)
  const floorUnder = (item) => {
    let top = 0;
    for (const s of items) {
      if (!s.isFloor || s === item) continue;
      if (Math.abs(item.x - s.x) > s.hx || Math.abs(item.z - s.z) > s.hz) continue;
      const sTop = s.base + s.height;
      if (sTop > top) top = sTop;
    }
    return top;
  };

  console.log(`\n=== map "${mapId}" ===`);
  const byType = {};
  for (const it of items) {
    if (it.isFloor || it.arch) continue;
    const floor = floorUnder(it);
    const gap = it.base - floor; // <0 means base is BELOW the floor it stands on (sunk)
    const rec = byType[it.type] || (byType[it.type] = { n: 0, minGap: Infinity, maxGap: -Infinity, sunk: 0 });
    rec.n++; rec.minGap = Math.min(rec.minGap, gap); rec.maxGap = Math.max(rec.maxGap, gap);
    if (gap < -0.005) rec.sunk++;
  }
  for (const [type, r] of Object.entries(byType).sort((a, b) => a[1].minGap - b[1].minGap)) {
    const flag = r.minGap < -0.005 ? '  <-- SUNK below its floor' : '';
    console.log(`  ${type.padEnd(16)} n=${String(r.n).padStart(3)}  gap[min=${r.minGap.toFixed(3)} max=${r.maxGap.toFixed(3)}]  sunk=${r.sunk}${flag}`);
  }
}
