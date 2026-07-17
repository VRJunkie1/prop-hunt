#!/usr/bin/env node
// tools/_probe_settle5.mjs — THROWAWAY diagnostic (physics settle round 5). Confirms the
// sleeper/spawn-gap/overflow mechanism against the REAL world before writing the gate.
let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; }
catch { console.log('SKIP: rapier not installed'); process.exit(3); }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { PhysicsWorld, isArchEntry, isFixedBodyEntry, halfExtentsFor } = await import('../shared/physics.js');
const { groundMapData, seatMapData } = await import('../shared/grounding.js');
await RAPIER.init();
const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json'), feel = cfg('physics-feel.json'), maps = cfg('maps.json');
const props = cfg('props.json'), fixtures = cfg('fixtures.json'), assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) { if (!(b && b.w > 0 && b.h > 0 && b.d > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (props[t]) props[t].measured = m; if (fixtures[t]) fixtures[t].measured = m; }
for (const [t, h] of Object.entries(hullDefs)) { if (!(h && Array.isArray(h.v) && h.v.length >= 12 && h.aabb)) continue; if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; } if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; } }
const catalog = { ...props, ...fixtures };
function footprint(c) { if (!c) return 0; const m = c.measured; if (m && m.w > 0) return m.w * m.h * m.d; switch (c.shape) { case 'box': return (c.w||1)*(c.h||1)*(c.d||1); case 'cylinder': case 'cone': return Math.PI*(c.r||0.5)*(c.r||0.5)*(c.h||1); case 'sphere': return (4/3)*Math.PI*Math.pow(c.r||0.5,3); default: return 0.5; } }
function promote(map) { let id = 1; const mk = (o) => ({ id: id++, type: o.type, x: o.x, z: o.z, y: o.y||0, rot: o.rot||0 }); const disguiseProps = (map.props||[]).map(mk); const nonArch = (map.fixtures||[]).filter((f)=>{const c=catalog[f.type];return c&&!isArchEntry(c);}); const dynFixtures = nonArch.filter((f)=>!isFixedBodyEntry(catalog[f.type])).map(mk); const staticFixtures = nonArch.filter((f)=>isFixedBodyEntry(catalog[f.type])).map(mk); const dynamicCandidates = [...disguiseProps, ...dynFixtures].sort((a,b)=>footprint(catalog[b.type])-footprint(catalog[a.type])); return [...dynamicCandidates, ...staticFixtures]; }

const map = JSON.parse(JSON.stringify(maps.restaurant));
groundMapData(map, catalog);
seatMapData(map, catalog);
const inst = promote(map);
const nonFixed = inst.filter((p) => !isFixedBodyEntry(catalog[p.type]));
console.log(`total promoted instances: ${inst.length}`);
console.log(`non-fixed (should-be-dynamic) instances: ${nonFixed.length}`);
console.log(`maxDynamicProps cap: ${rules.maxDynamicProps}`);

const world = new PhysicsWorld(RAPIER, map, inst, catalog, { dynamicProps: true, rules: { ...rules, maxDynamicProps: 150 }, feel });
const bodies = world.propBodies;
const dynIds = new Set(bodies.map((b) => b.id));
const typeById = new Map(inst.map((p) => [p.id, p.type]));
console.log(`dynamic bodies built: ${bodies.length}`);
const overflow = nonFixed.filter((p) => !dynIds.has(p.id));
const overflowCounts = {};
for (const p of overflow) overflowCounts[p.type] = (overflowCounts[p.type]||0)+1;
console.log(`\nOVERFLOW-STATIC (refuse to fall even when hit) — ${overflow.length} instances:`);
console.log('  ' + Object.entries(overflowCounts).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${t}×${n}`).join(', '));

// Shape-cast helper: drop the body's UPRIGHT AABB cuboid straight down (excluding self) and read
// the time-of-impact = how far the whole FOOTPRINT can still fall before hitting a support. Robust
// to edge-rests/tilt that a single center raycast misses. toi≈0 => resting; toi>eps => floating gap.
function gapBelow(b) {
  const t = b.body.translation();
  const c = catalog[typeById.get(b.id)];
  const he = halfExtentsFor(c);
  const shape = new RAPIER.Cuboid(Math.max(he.hx * 0.95, 0.02), Math.max(he.hy * 0.95, 0.02), Math.max(he.hz * 0.95, 0.02));
  const ownCol = b.body.collider(0);
  const hit = world.world.castShape(
    { x: t.x, y: t.y, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0 },
    shape, 0, 50, true, undefined, undefined, ownCol
  );
  if (!hit) return { gap: Infinity };
  return { gap: hit.toi };
}

world.step(1/60); // prime query pipeline
// Shape-cast EVERY non-fixed prop where it sits — INCLUDING the overflow-static ones (which are the
// sauce bottles / cylinders VRmike sees hanging). Use collider translation for statics.
function gapAt(pos, type) {
  const he = halfExtentsFor(catalog[type]);
  const shape = new RAPIER.Cuboid(Math.max(he.hx * 0.95, 0.02), Math.max(he.hy * 0.95, 0.02), Math.max(he.hz * 0.95, 0.02));
  const hit = world.world.castShape(pos, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0 }, shape, 0, 50, true);
  return hit ? hit.toi : Infinity;
}
let staticFloat = [];
for (const p of overflow) {
  const col = world._fixedPropColliders.get(p.id); if (!col) continue;
  const t = col.translation();
  const g = gapAt({ x: t.x, y: t.y, z: t.z }, p.type);
  if (g > 0.05) staticFloat.push(`${p.type} +${g === Infinity ? 'inf' : g.toFixed(2)}`);
}
console.log(`\nOVERFLOW-STATIC props FOOTPRINT-FLOATING (cap ${rules.maxDynamicProps}) >0.05m: ${staticFloat.length}/${overflow.length}`);
console.log('  ' + staticFloat.slice(0, 40).join('; '));
process.exit(0);
const sleeping = bodies.filter((b) => b.body.isSleeping()).length;
console.log(`  sleeping at spawn: ${sleeping}/${bodies.length}`);

// Step WITHOUT waking — faithful to game (nothing touches them at spawn).
let done = 0;
for (const mark of [120, 300, 600, 900]) {
  for (; done < mark; done++) world.step(1/60);
  let floatAfter = [];
  for (const b of bodies) { const { gap } = gapBelow(b); if (gap > 0.05) floatAfter.push(`${typeById.get(b.id)} gap=${gap === Infinity ? 'inf' : gap.toFixed(2)}`); }
  const asleep = bodies.filter((b) => b.body.isSleeping()).length;
  console.log(`\nAFTER ${(mark/60).toFixed(1)}s — floating(shape-cast) >0.05m: ${floatAfter.length}; asleep ${asleep}/${bodies.length}`);
  console.log('  ' + floatAfter.slice(0, 30).join('; '));
}
world.destroy();
