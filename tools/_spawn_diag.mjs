// DIAGNOSTIC (throwaway): clearance margin from every spawn to the nearest solid collider
// (walls + static fixtures + prop/knockable colliders). A spawn with a tiny/negative margin
// is a trap: the failsafe teleports a wedged player back to spawn, and if spawn is inside a
// solid the depenetration loops forever -> "move a little, snapped back" at the far side.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { worldColliderBoxes, propColliderBoxes, WALL_INSET } from '../shared/bounds.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const rules = cfg('rules.json');
let hullDefs = {};
try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = h.aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };
const pr = rules.playerRadius ?? 0.4;

// horizontal signed distance from point to a yaw-rotated box footprint (neg = inside)
function boxDist(b, px, pz) {
  const dx = px - b.cx, dz = pz - b.cz;
  const rot = b.rot || 0, c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = Math.abs(dx * c - dz * s) - b.hx;
  const lz = Math.abs(dx * s + dz * c) - b.hz;
  const ox = Math.max(lx, 0), oz = Math.max(lz, 0);
  const outside = Math.hypot(ox, oz);
  return outside > 0 ? outside : Math.max(lx, lz); // neg inside
}

for (const [mapId, map] of Object.entries(maps)) {
  console.log(`\n=== ${mapId} (size ${map.size}) ===`);
  const solids = [
    ...worldColliderBoxes(map, catalog, rules).filter((b) => b.kind !== 'ground' && !b.floor).map((b) => ({ ...b, src: b.kind })),
    ...propColliderBoxes(map, catalog).map((b) => ({ ...b, src: 'prop' })),
  ];
  const walkBound = map.size / 2 - WALL_INSET - pr;
  const stand = [...(map.spawns || []).map((s) => ({ ...s, label: `spawn (${s.x},${s.z})` }))];
  if (map.hunterSpawn) stand.push({ ...map.hunterSpawn, label: 'hunterSpawn' });
  for (const s of stand) {
    let best = Infinity, who = '';
    for (const b of solids) {
      const d = boxDist(b, s.x, s.z) - pr; // subtract capsule radius: clearance for the body
      if (d < best) { best = d; who = `${b.src}:${b.type}`; }
    }
    const inBounds = Math.abs(s.x) <= walkBound && Math.abs(s.z) <= walkBound;
    const flag = best < 0 ? ' <<< OVERLAP' : best < 0.3 ? ' <-- tight' : '';
    console.log(`  ${s.label}: nearest ${who} clearance ${best.toFixed(2)}m  ${inBounds ? '' : 'OUT-OF-BOUNDS'}${flag}`);
  }
}
