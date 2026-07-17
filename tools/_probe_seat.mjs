// scratch probe — real collider heights (halfExtentsFor) + seated results for the restaurant map.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { halfExtentsFor } from '../shared/physics.js';
import { groundMapData, seatMapData } from '../shared/grounding.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const maps = cfg('maps.json'), props = cfg('props.json'), fixtures = cfg('fixtures.json');
const assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) { if (!b || !(b.w > 0 && b.h > 0 && b.d > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (props[t]) props[t].measured = m; if (fixtures[t]) fixtures[t].measured = m; }
for (const [t, h] of Object.entries(hullDefs)) { if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue; if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; } if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; } }
const catalog = { ...props, ...fixtures };

const types = ['stove', 'stove_plain', 'stove_single', 'table_food', 'prep_sink', 'table_sink', 'shelf', 'dishrack', 'kitchen_table', 'counter', 'round_table', 'large_table', 'small_table', 'pot_a', 'stew_pot', 'stew', 'pan', 'oven', 'fridge', 'cabinet_corner'];
console.log('type            collHeight  src');
for (const t of types) {
  const c = catalog[t]; if (!c) { console.log(t, 'MISSING'); continue; }
  const he = halfExtentsFor(c);
  const src = (c.hullVerts && c.hullAabb) ? 'hull' : (c.measured ? 'measured' : 'prim');
  console.log(t.padEnd(15), (2 * he.hy).toFixed(3).padStart(8), '  ', src, '  primH=', c.h ?? c.r);
}

// Seat the restaurant map and report every moved item.
const map = JSON.parse(JSON.stringify(maps.restaurant));
groundMapData(map, catalog);
const changes = seatMapData(map, catalog);
console.log(`\nseatMapData moved ${changes.length} items:`);
for (const c of changes.sort((a, b) => (b.to - b.from) - (a.to - a.from))) {
  console.log(`  ${c.type.padEnd(16)} (${c.x},${c.z})  ${c.from.toFixed(2)} -> ${c.to.toFixed(2)}  (${(c.to - c.from >= 0 ? '+' : '') + (c.to - c.from).toFixed(2)})`);
}
