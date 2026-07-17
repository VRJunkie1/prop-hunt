// scratch — per-body settle detail: what moves, by how much, and its size class.
let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; } catch { console.log('SKIP: no rapier'); process.exit(3); }
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
for (const [t, b] of Object.entries(dims)) { if (!b || !(b.w > 0 && b.h > 0 && b.d > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (props[t]) props[t].measured = m; if (fixtures[t]) fixtures[t].measured = m; }
for (const [t, h] of Object.entries(hullDefs)) { if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue; if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; } if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; } }
const catalog = { ...props, ...fixtures };
function footprint(c) { if (!c) return 0; const m = c.measured; if (m && m.w > 0) return m.w * m.h * m.d; switch (c.shape) { case 'box': return (c.w || 1) * (c.h || 1) * (c.d || 1); case 'cylinder': case 'cone': return Math.PI * (c.r || 0.5) ** 2 * (c.h || 1); case 'sphere': return (4 / 3) * Math.PI * (c.r || 0.5) ** 3; default: return 0.5; } }
function promote(map) { let id = 1; const mk = (o) => ({ id: id++, type: o.type, x: o.x, z: o.z, y: o.y || 0, rot: o.rot || 0 }); const dp = (map.props || []).map(mk); const na = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c); }); const df = na.filter((f) => !isFixedBodyEntry(catalog[f.type])).map(mk); const sf = na.filter((f) => isFixedBodyEntry(catalog[f.type])).map(mk); return [...[...dp, ...df].sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type])), ...sf]; }

const map = JSON.parse(JSON.stringify(maps.restaurant));
groundMapData(map, catalog); seatMapData(map, catalog);
const insts = promote(map);
const world = new PhysicsWorld(RAPIER, map, insts, catalog, { dynamicProps: true, rules, feel });
const bodies = world.propBodies;
const typeById = new Map(insts.map((p) => [p.id, p.type]));
const spawn = new Map(); for (const b of bodies) { const t = b.body.translation(); spawn.set(b.id, { x: t.x, y: t.y, z: t.z }); }
for (let i = 0; i < 360; i++) world.step(1 / 60);
const upY = (q) => 1 - 2 * (q.x * q.x + q.z * q.z);
const rows = [];
for (const b of bodies) {
  const s = spawn.get(b.id), t = b.body.translation(), q = b.body.rotation();
  const type = typeById.get(b.id);
  const fp = footprint(catalog[type]);
  rows.push({ type, fp, dy: t.y - s.y, horiz: Math.hypot(t.x - s.x, t.z - s.z), up: upY(q), sleep: b.body.isSleeping() });
}
// group by type: worst dy, horiz, min up, count
const byType = new Map();
for (const r of rows) {
  const g = byType.get(r.type) || { type: r.type, fp: r.fp, n: 0, moved: 0, worstDy: 0, worstH: 0, minUp: 1, awake: 0 };
  g.n++; if (Math.abs(r.dy) > 0.25 || r.horiz > 0.35 || r.up < 0.906) g.moved++;
  if (r.dy < g.worstDy) g.worstDy = r.dy; if (r.horiz > g.worstH) g.worstH = r.horiz; if (r.up < g.minUp) g.minUp = r.up;
  if (!r.sleep) g.awake++;
  byType.set(r.type, g);
}
console.log('type              fp     n  bad  worstDy  worstH  minUp  awake');
for (const g of [...byType.values()].filter((g) => g.moved || g.awake).sort((a, b) => b.fp - a.fp)) {
  console.log(g.type.padEnd(17), g.fp.toFixed(2).padStart(6), String(g.n).padStart(3), String(g.moved).padStart(4), g.worstDy.toFixed(2).padStart(8), g.worstH.toFixed(2).padStart(7), g.minUp.toFixed(2).padStart(6), String(g.awake).padStart(5));
}
console.log(`\ntotal dynamic ${bodies.length}, asleep ${rows.filter((r) => r.sleep).length}`);
world.destroy();
