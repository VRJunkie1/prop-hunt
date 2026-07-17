// THROWAWAY probe: at spawn (before any stepping), report every DYNAMIC prop whose body centre or
// base sits INSIDE another collider — the interpenetration that makes a dynamic body eject/jitter.
// Identifies the offending host collider (prop type or static fixture type). Informs the fix.
let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; } catch { console.log('SKIP: no rapier'); process.exit(3); }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { PhysicsWorld, isArchEntry, isStaticEntry } = await import('../shared/physics.js');
await RAPIER.init();
const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json'), feel = cfg('physics-feel.json'), maps = cfg('maps.json');
const props = cfg('props.json'), fixtures = cfg('fixtures.json'), assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) { if (!b || !(b.w > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (props[t]) props[t].measured = m; if (fixtures[t]) fixtures[t].measured = m; }
for (const [t, h] of Object.entries(hullDefs)) { if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue; if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; } if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; } }
const catalog = { ...props, ...fixtures };
function footprint(c) { if (!c) return 0; const m = c.measured; if (m && m.w > 0 && m.h > 0 && m.d > 0) return m.w * m.h * m.d; switch (c.shape) { case 'box': return (c.w || 1) * (c.h || 1) * (c.d || 1); case 'cylinder': case 'cone': return Math.PI * (c.r || 0.5) * (c.r || 0.5) * (c.h || 1); case 'sphere': return (4 / 3) * Math.PI * Math.pow(c.r || 0.5, 3); default: return 0.5; } }
const map = JSON.parse(JSON.stringify(maps.restaurant));
let id = 1;
const disguiseProps = (map.props || []).map((p) => ({ id: id++, type: p.type, x: p.x, z: p.z, y: p.y || 0, rot: p.rot || 0 }));
const nonArch = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c); });
const dynF = nonArch.filter((f) => !isStaticEntry(catalog[f.type])).map((f) => ({ id: id++, type: f.type, x: f.x, z: f.z, y: f.y || 0, rot: f.rot || 0 }));
const statF = nonArch.filter((f) => isStaticEntry(catalog[f.type])).map((f) => ({ id: id++, type: f.type, x: f.x, z: f.z, y: f.y || 0, rot: f.rot || 0 }));
const propInstances = [...[...disguiseProps, ...dynF].sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type])), ...statF];
const world = new PhysicsWorld(RAPIER, map, propInstances, catalog, { dynamicProps: true, rules, feel });
const typeById = new Map(propInstances.map((p) => [p.id, p.type]));

const spawn = new Map(world.propBodies.map((b) => { const t = b.body.translation(); return [b.id, { x: t.x, y: t.y, z: t.z }]; }));
// Step a few substeps; embedded bodies eject with high speed almost immediately.
let peak = new Map(world.propBodies.map((b) => [b.id, 0]));
for (let i = 0; i < 5; i++) {
  world.step(1 / 60);
  for (const b of world.propBodies) {
    const v = b.body.linvel();
    const s = Math.hypot(v.x, v.y, v.z);
    if (s > peak.get(b.id)) peak.set(b.id, s);
  }
}
const hot = world.propBodies
  .map((b) => ({ id: b.id, type: typeById.get(b.id), s: spawn.get(b.id), v: peak.get(b.id) }))
  .filter((r) => r.v > 1.0)
  .sort((a, b) => b.v - a.v);
for (const r of hot) console.log(`  ${r.type.padEnd(18)} @(${r.s.x.toFixed(1)},${r.s.z.toFixed(1)},y=${r.s.y.toFixed(2)})  peak speed ${r.v.toFixed(2)} m/s`);
console.log(`\n${hot.length} of ${world.propBodies.length} dynamic bodies eject/accelerate >1 m/s in the first 5 substeps (spawn interpenetration).`);
world.destroy();
