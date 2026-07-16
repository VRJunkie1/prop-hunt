// DIAGNOSTIC (throwaway): dry-run the real groundMapData over every map and print each
// change (from -> to) so we can confirm the deltas are sensible before shipping / before
// deciding which pieces need a noGround exemption. Also checks idempotence.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { groundMapData, isGroundExempt } from '../shared/grounding.js';

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
const dims = (cfg('asset-dims.json').dims) || {};
for (const [type, box] of Object.entries(dims)) {
  if (!box || !(box.w > 0 && box.h > 0 && box.d > 0)) continue;
  const m = { w: box.w, h: box.h, d: box.d };
  if (props[type]) props[type].measured = m;
  if (fixtures[type]) fixtures[type].measured = m;
}
const catalog = { ...props, ...fixtures };

for (const [mapId, map] of Object.entries(maps)) {
  const changes = groundMapData(map, catalog);
  console.log(`\n=== ${mapId} === (${changes.length} grounded)`);
  changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  for (const c of changes) {
    const dir = c.to > c.from ? 'RAISE' : 'DROP ';
    console.log(`  ${dir} ${c.type}@(${c.x},${c.z}) ${c.from.toFixed(2)} -> ${c.to.toFixed(2)}  (Δ${(c.to - c.from).toFixed(2)})`);
  }
  // idempotence: a second pass must find nothing.
  const again = groundMapData(map, catalog);
  console.log(`  idempotent: ${again.length === 0 ? 'YES' : 'NO (' + again.length + ' more)'}`);
}
