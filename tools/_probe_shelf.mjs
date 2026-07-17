// scratch — does the shelf tip ALONE (bad hull), or only with clutter/neighbours?
let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; } catch { console.log('SKIP'); process.exit(3); }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { PhysicsWorld, halfExtentsFor } = await import('../shared/physics.js');
await RAPIER.init();
const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json'), feel = cfg('physics-feel.json');
const props = cfg('props.json'), fixtures = cfg('fixtures.json'), assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) { if (!b || !(b.w > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (fixtures[t]) fixtures[t].measured = m; if (props[t]) props[t].measured = m; }
for (const [t, h] of Object.entries(hullDefs)) { if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue; if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; } if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; } }
const catalog = { ...props, ...fixtures };

for (const type of ['shelf', 'small_table', 'large_table', 'fridge', 'oven', 'cabinet_corner']) {
  const he = halfExtentsFor(catalog[type]);
  const map = { size: 36, props: [], fixtures: [{ type, x: 0, z: 0, y: 0 }] };
  const insts = [{ id: 1, type, x: 0, z: 0, y: 0, rot: 0 }];
  const world = new PhysicsWorld(RAPIER, map, insts, catalog, { dynamicProps: true, rules, feel });
  const b = world.propBodies[0];
  const s = b.body.translation();
  for (let i = 0; i < 300; i++) world.step(1 / 60);
  const t = b.body.translation(), q = b.body.rotation();
  const up = 1 - 2 * (q.x * q.x + q.z * q.z);
  console.log(`${type.padEnd(15)} he(${he.hx.toFixed(2)},${he.hy.toFixed(2)},${he.hz.toFixed(2)})  dy=${(t.y - s.y).toFixed(3)}  horiz=${Math.hypot(t.x - s.x, t.z - s.z).toFixed(3)}  up=${up.toFixed(3)}  sleep=${b.body.isSleeping()}`);
  world.destroy();
}
