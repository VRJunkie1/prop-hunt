// DEV BALANCE-TABLE DUMP (authoring-only, never shipped). Prints every prop's footprint size,
// size-multiplier, per-hit rifle damage %, and hits-to-kill — sorted small→large — using config
// loaded the SAME way the client does (merging hull AABB + measured onto catalog entries) so
// entrySize matches the live game. Handy for eyeballing where a balance boundary should sit.
// Run: node tools/_repro_smallest.mjs   (the pass/fail GUARD is tools/check-smallest-prop.mjs)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveDamageCfg, entrySize, sizeMultiplier, damageForPlayerHit, playerSizeFromRules } from '../shared/damage.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

const rules = readJSON('shared', 'config', 'rules.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
let hulls = {};
try { hulls = readJSON('shared', 'config', 'hulls.json'); } catch {}
let assetDims = {};
try { assetDims = readJSON('shared', 'config', 'asset-dims.json'); } catch {}

// Merge measured dims (asset-dims) — mirror js/config.js
const dims = (assetDims && assetDims.dims) || assetDims || {};
for (const [type, box] of Object.entries(dims)) {
  if (!box || !(box.w > 0)) continue;
  const measured = { w: box.w, h: box.h, d: box.d };
  if (props[type]) props[type].measured = measured;
  if (fixtures[type]) fixtures[type].measured = measured;
}
// Merge hull verts + aabb — mirror js/config.js
const hullDefs = (hulls && hulls.hulls) || {};
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12) continue;
  const aabb = h.aabb && h.aabb.w > 0 && h.aabb.h > 0 && h.aabb.d > 0 ? { w: h.aabb.w, h: h.aabb.h, d: h.aabb.d } : null;
  if (!aabb) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = aabb; }
}

const catalog = { ...props, ...fixtures };
const dcfg = resolveDamageCfg(rules.damage);
dcfg.playerSize = playerSizeFromRules(rules);
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

console.log(`base=${dcfg.base} playerSize=${dcfg.playerSize} factor=${dcfg.sizeComparisonFactor} pivot=${(dcfg.playerSize*dcfg.sizeComparisonFactor).toFixed(3)} clamps=[${dcfg.largeMult}, ${dcfg.smallMult}] startHealth=${startHealth}`);

const rows = Object.keys(props).map((t) => {
  const size = entrySize(catalog[t]);
  const mult = sizeMultiplier(size, dcfg);
  const dmg = damageForPlayerHit(t, catalog, dcfg);
  return { t, size, mult, dmg, pct: (dmg / startHealth) * 100, hits: Math.ceil(startHealth / dmg) };
}).sort((a, b) => a.size - b.size);

for (const r of rows) {
  console.log(`${r.t.padEnd(16)} size=${r.size.toFixed(3)}m mult=${r.mult.toFixed(3)} dmg=${r.dmg.toFixed(2)} = ${r.pct.toFixed(1)}%/hit  hits-to-kill=${r.hits}`);
}
