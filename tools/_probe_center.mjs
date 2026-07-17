#!/usr/bin/env node
let RAPIER; try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; } catch { process.exit(3); }
import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const { PhysicsWorld, isArchEntry, isFixedBodyEntry, halfExtentsFor } = await import('../shared/physics.js');
const { groundMapData, seatMapData } = await import('../shared/grounding.js');
await RAPIER.init();
const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json'), feel = cfg('physics-feel.json'), maps = cfg('maps.json');
const props = cfg('props.json'), fixtures = cfg('fixtures.json'), assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) { if (!(b && b.w > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (props[t]) props[t].measured = m; if (fixtures[t]) fixtures[t].measured = m; }
for (const [t, h] of Object.entries(hullDefs)) { if (!(h && Array.isArray(h.v) && h.v.length >= 12 && h.aabb)) continue; if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; } if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; } }
const catalog = { ...props, ...fixtures };
function fp(c) { if (!c) return 0; const m = c.measured; if (m && m.w > 0) return m.w*m.h*m.d; switch (c.shape) { case 'box': return (c.w||1)*(c.h||1)*(c.d||1); case 'cylinder': case 'cone': return Math.PI*(c.r||.5)**2*(c.h||1); case 'sphere': return 4/3*Math.PI*(c.r||.5)**3; default: return .5; } }
function promote(map) { let id=1; const mk=(o)=>({id:id++,type:o.type,x:o.x,z:o.z,y:o.y||0,rot:o.rot||0}); const dp=(map.props||[]).map(mk); const na=(map.fixtures||[]).filter(f=>{const c=catalog[f.type];return c&&!isArchEntry(c);}); const df=na.filter(f=>!isFixedBodyEntry(catalog[f.type])).map(mk); const sf=na.filter(f=>isFixedBodyEntry(catalog[f.type])).map(mk); return [...[...dp,...df].sort((a,b)=>fp(catalog[b.type])-fp(catalog[a.type])),...sf]; }

const arg = process.argv.slice(2).join(' ');
const CAP = arg.includes('150') ? 150 : 260;
const SLEEP = arg.includes('sleep');
const map = JSON.parse(JSON.stringify(maps.restaurant));
groundMapData(map, catalog); seatMapData(map, catalog);
const inst = promote(map);
const world = new PhysicsWorld(RAPIER, map, inst, catalog, { dynamicProps: true, rules: { ...rules, maxDynamicProps: CAP }, feel });
const bodies = world.propBodies; const typeById = new Map(inst.map(p => [p.id, p.type]));
if (SLEEP) for (const b of bodies) if (b.body.sleep) b.body.sleep();
for (let i = 0; i < 600; i++) world.step(1/60);
// CENTER raycast gap = toi - hy.
function centerGap(b) {
  const t = b.body.translation(); const hy = halfExtentsFor(catalog[typeById.get(b.id)]).hy;
  const ray = new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
  const hit = world.world.castRay(ray, 50, true, undefined, undefined, b.body.collider(0));
  return hit ? hit.timeOfImpact - hy : Infinity;
}
let float = [];
for (const b of bodies) { const g = centerGap(b); if (g > 0.05) float.push(`${typeById.get(b.id)} +${g === Infinity ? 'inf' : g.toFixed(2)}`); }
const asleep = bodies.filter(b => b.body.isSleeping()).length;
console.log(`CAP=${CAP} SLEEP=${SLEEP} — CENTER-raycast floating >0.05m after 10s: ${float.length}/${bodies.length}; asleep ${asleep}`);
console.log('  ' + float.slice(0, 40).join('; '));
world.destroy();
