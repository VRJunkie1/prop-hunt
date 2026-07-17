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
function fpv(c) { if (!c) return 0; const m = c.measured; if (m && m.w > 0) return m.w*m.h*m.d; switch (c.shape) { case 'box': return (c.w||1)*(c.h||1)*(c.d||1); case 'cylinder': case 'cone': return Math.PI*(c.r||.5)**2*(c.h||1); case 'sphere': return 4/3*Math.PI*(c.r||.5)**3; default: return .5; } }
function promote(map) { let id=1; const mk=(o)=>({id:id++,type:o.type,x:o.x,z:o.z,y:o.y||0,rot:o.rot||0}); const dp=(map.props||[]).map(mk); const na=(map.fixtures||[]).filter(f=>{const c=catalog[f.type];return c&&!isArchEntry(c);}); const df=na.filter(f=>!isFixedBodyEntry(catalog[f.type])).map(mk); const sf=na.filter(f=>isFixedBodyEntry(catalog[f.type])).map(mk); return [...[...dp,...df].sort((a,b)=>fpv(catalog[b.type])-fpv(catalog[a.type])),...sf]; }
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
// FULL vertical extent, horizontal inset 0.9 (avoid catching side neighbours). Cast from center down.
function gap(b) {
  const t = b.body.translation(); const he = halfExtentsFor(catalog[typeById.get(b.id)]);
  const shape = new RAPIER.Cuboid(Math.max(he.hx*0.9,0.02), he.hy, Math.max(he.hz*0.9,0.02));
  const hit = world.world.castShape({x:t.x,y:t.y,z:t.z},{x:0,y:0,z:0,w:1},{x:0,y:-1,z:0}, shape, 0, 50, true, undefined, undefined, b.body.collider(0));
  if (!hit) return Infinity; const toi = hit.toi != null ? hit.toi : hit.time_of_impact; return typeof toi === 'number' ? toi : 0;
}
const gaps = bodies.map(gap).filter(g => g !== Infinity).sort((a,b)=>a-b);
const infs = bodies.filter(b => gap(b) === Infinity).length;
const buckets = { '0': 0, '0-0.01': 0, '0.01-0.03': 0, '0.03-0.05': 0, '0.05-0.1': 0, '>0.1': 0 };
for (const g of gaps) { if (g <= 0.001) buckets['0']++; else if (g<=0.01) buckets['0-0.01']++; else if (g<=0.03) buckets['0.01-0.03']++; else if (g<=0.05) buckets['0.03-0.05']++; else if (g<=0.1) buckets['0.05-0.1']++; else buckets['>0.1']++; }
console.log(`CAP=${CAP} SLEEP=${SLEEP} bodies=${bodies.length} inf=${infs}`);
console.log('  gap buckets:', JSON.stringify(buckets));
console.log('  max gap:', gaps[gaps.length-1]?.toFixed(3), ' p95:', gaps[Math.floor(gaps.length*0.95)]?.toFixed(3), ' median:', gaps[Math.floor(gaps.length/2)]?.toFixed(3));
world.destroy();
