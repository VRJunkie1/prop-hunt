// THROWAWAY (_-prefixed) budget diagnostic. Counts how the rules.maxDynamicProps cap is spent
// on the restaurant map now that the built-ins are dynamic — under the CURRENT referee order
// (disguise-pool props first, then biggest-first fixtures) vs a GLOBAL biggest-first order.
// Pre-removal (worst case a phone sees). Informs whether counters/appliances actually get a
// dynamic body (shovable) or degrade to a static collider.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isArchEntry, isStaticEntry } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const maps = cfg('maps.json'), props = cfg('props.json'), fixtures = cfg('fixtures.json');
const assetDims = cfg('asset-dims.json'), rules = cfg('rules.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) { if (!b || !(b.w > 0)) continue; const m = { w: b.w, h: b.h, d: b.d }; if (props[t]) props[t].measured = m; if (fixtures[t]) fixtures[t].measured = m; }
const catalog = { ...props, ...fixtures };
const cap = rules.maxDynamicProps;

function footprint(c) {
  if (!c) return 0;
  const m = c.measured; if (m && m.w > 0 && m.h > 0 && m.d > 0) return m.w * m.h * m.d;
  switch (c.shape) {
    case 'box': return (c.w || 1) * (c.h || 1) * (c.d || 1);
    case 'cylinder': case 'cone': return Math.PI * (c.r || 0.5) * (c.r || 0.5) * (c.h || 1);
    case 'sphere': return (4 / 3) * Math.PI * Math.pow(c.r || 0.5, 3);
    default: return 0.5;
  }
}

const map = maps.restaurant;
const disguiseProps = (map.props || []).map((p) => ({ type: p.type }));
const dynFixtures = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c) && !isStaticEntry(c); }).map((f) => ({ type: f.type }));
const staticFixtures = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c) && isStaticEntry(c); }).map((f) => ({ type: f.type }));

console.log(`cap = ${cap}   (pre-removal; removal ~${(rules.mapRandomizeSkip * 100) | 0}% thins the live count)`);
console.log(`disguise-pool props: ${disguiseProps.length}   dynamic-candidate fixtures: ${dynFixtures.length}   static-kept (door/vent): ${staticFixtures.length}`);
console.log(`total dynamic candidates: ${disguiseProps.length + dynFixtures.length}\n`);

const report = (label, list) => {
  const dyn = list.slice(0, cap), stat = list.slice(cap);
  const count = (arr) => { const m = {}; for (const o of arr) m[o.type] = (m[o.type] || 0) + 1; return m; };
  const statC = count(stat);
  console.log(`--- ${label} ---`);
  console.log(`  DYNAMIC (shovable): ${dyn.length}   STATIC overflow (collidable, NOT shovable): ${stat.length}`);
  // Is a given interesting type fully dynamic?
  for (const t of ['counter', 'fridge', 'oven', 'stove', 'cabinet', 'cabinet_corner', 'prep_sink', 'table_sink', 'shelf', 'kitchen_table', 'round_table', 'pot_a', 'crate_veg', 'diner_chair', 'kitchen_stool']) {
    const total = list.filter((o) => o.type === t).length;
    if (!total) continue;
    const inStatic = statC[t] || 0;
    console.log(`    ${t.padEnd(15)} ${total - inStatic}/${total} dynamic${inStatic ? `  (${inStatic} static)` : ''}`);
  }
  if (stat.length) console.log(`  overflow types: ${Object.entries(statC).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(', ')}`);
  console.log('');
};

// CURRENT order: disguiseProps (map order) ++ dynFixtures (biggest-first)
const currentOrder = [...disguiseProps, ...dynFixtures.slice().sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]))];
report('CURRENT ORDER (disguise props first, then biggest fixtures)', currentOrder);

// PROPOSED: global biggest-first over all dynamic candidates
const globalOrder = [...disguiseProps, ...dynFixtures].sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]));
report('GLOBAL BIGGEST-FIRST (proposed)', globalOrder);
