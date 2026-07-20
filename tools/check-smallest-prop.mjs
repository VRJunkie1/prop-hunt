#!/usr/bin/env node
// SMALLEST-PROP RIFLE DAMAGE — permanent guard (2026-07-20, VRmike, balance tweak, #devbot).
// AUTHORING-ONLY (never imported by the page / shipped). Run:
//
//     node tools/check-smallest-prop.mjs
//
// WHY THIS EXISTS. VRmike: the mustard bottle (the smallest disguise) was ~9%/hit (~11 rifle
// hits to kill) — far too tanky for the tiniest prop. The size-comparison hyperbola compresses
// the smallest props toward the pivot, so a mustard bottle never got the fragility it should.
// The fix: props whose footprint size is <= damage.smallPropSize take the smallMult multiplier
// FLAT (base 5 × 11 = 55% health/hit => dead in 2 rifle hits). This guard PROVES:
//   1) a mustard-disguised prop-player loses EXACTLY 55% health on a rifle hit and dies on hit 2,
//      driving the REAL host path (referee._applyShotDamage), config loaded like the live game;
//   2) MEDIUM + LARGE props are byte-for-byte UNCHANGED (their multiplier stays on the old curve)
//      — the boundary only lifts the smallest props, nothing else moved;
//   3) the boundary is coherent: every prop <= smallPropSize gets the flat smallMult, and the
//      smallest prop ABOVE the boundary still follows the untouched hyperbola.
// A future formula tweak that silently re-squashes tiny props (or drags a medium prop across the
// boundary) FAILS this build. Belt-and-suspenders alongside tools/check-combat.mjs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE, PHASE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';
import {
  resolveDamageCfg, entrySize, sizeMultiplier, playerSizeFromRules,
} from '../shared/damage.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('SMALLEST-PROP rifle damage acceptance check');

// Real shipping config.
const rules = readJSON('shared', 'config', 'rules.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');

// Load the collider footprint EXACTLY like the live client (js/config.js): merge each baked hull's
// AABB (and measured dims when present) onto the catalog entry, so entrySize here == entrySize in
// the running game. Without this the guard would judge the mustard by its raw cylinder primitive
// rather than the hull the game actually sizes it by.
let hulls = {};
try { hulls = readJSON('shared', 'config', 'hulls.json'); } catch { /* optional */ }
let assetDims = {};
try { assetDims = readJSON('shared', 'config', 'asset-dims.json'); } catch { /* optional */ }
const dims = (assetDims && assetDims.dims) || assetDims || {};
for (const [type, box] of Object.entries(dims)) {
  if (!box || !(box.w > 0)) continue;
  const measured = { w: box.w, h: box.h, d: box.d };
  if (props[type]) props[type].measured = measured;
  if (fixtures[type]) fixtures[type].measured = measured;
}
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
const boundary = dcfg.smallPropSize;

// ---------------------------------------------------------------------------
// A) THE RULING — a mustard-disguised prop loses 55% health per rifle hit and dies on hit 2,
//    through the REAL authoritative path (referee._applyShotDamage), not a hand-computed number.
// ---------------------------------------------------------------------------
console.log('\nA) mustard bottle: 55%/hit, dead in 2 rifle hits (real referee path)');
ok(catalog.mustard != null, 'catalog has the mustard bottle prop');
const mustardSize = entrySize(catalog.mustard);
ok(mustardSize > 0 && mustardSize <= boundary,
  `mustard footprint (${mustardSize.toFixed(3)} m) is at/below the smallPropSize boundary (${boundary} m) — it counts as a smallest prop`);

const ref = new Referee({ rules, maps: { test: {} }, props, fixtures, feel: {} }, 'TEST');
ref.phase = PHASE.HUNTING;
const hunter = { id: 'H', name: 'H', role: ROLE.HUNTER, alive: true, health: startHealth, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, disguise: null, send: () => {} };
const prop = { id: 'P', name: 'P', role: ROLE.PROP, alive: true, health: startHealth, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, disguise: 'mustard', send: () => {} };
ref.players.set('H', hunter);
ref.players.set('P', prop);
ref.props = [];

ref._applyShotDamage(hunter, { kind: 'player', id: 'P' });
const lossPct = ((startHealth - prop.health) / startHealth) * 100;
ok(near(prop.health, startHealth - 0.55 * startHealth),
  `1st rifle hit removes EXACTLY 55% health (${startHealth} → ${prop.health.toFixed(1)}, ${lossPct.toFixed(1)}% loss)`);
ok(prop.alive === true, 'mustard survives the 1st hit (still alive with 45% health)');

ref._applyShotDamage(hunter, { kind: 'player', id: 'P' });
ok(prop.alive === false, '2nd rifle hit eliminates the mustard bottle — dead in exactly 2 hits');
ref.destroy();

// ---------------------------------------------------------------------------
// B) MEDIUM + LARGE props are UNCHANGED — their multiplier is the untouched hyperbola. These are
//    the "must not move" reference values (recorded from the pre-change curve).
// ---------------------------------------------------------------------------
console.log('\nB) medium + large props unchanged (untouched hyperbola)');
const pivot = dcfg.playerSize * dcfg.sizeComparisonFactor; // the neutral pivot 1.08 m
// The pure hyperbola value a prop ABOVE the boundary must still produce (never the flat smallMult).
const pureCurve = (size) => Math.min(dcfg.smallMult, Math.max(dcfg.largeMult, pivot / size));
const REFERENCE = ['burger', 'plate', 'cheese', 'crate', 'fridge', 'kitchen_table'];
for (const type of REFERENCE) {
  const e = catalog[type];
  if (!e) { ok(false, `reference prop ${type} present in catalog`); continue; }
  const size = entrySize(e);
  const got = sizeMultiplier(size, dcfg);
  const want = pureCurve(size);
  ok(size > boundary, `${type} (${size.toFixed(3)} m) is ABOVE the smallPropSize boundary (untouched)`);
  ok(near(got, want),
    `${type} multiplier is the ORIGINAL curve value ${want.toFixed(3)} (not the flat smallMult ${dcfg.smallMult}) — medium/large did not move`);
}

// ---------------------------------------------------------------------------
// C) BOUNDARY COHERENCE — every prop <= smallPropSize takes the flat smallMult; the smallest prop
//    just ABOVE the boundary is still on the hyperbola. No prop straddles the boundary ambiguously.
// ---------------------------------------------------------------------------
console.log('\nC) boundary coherence (props <= smallPropSize flat; above => hyperbola)');
const propRows = Object.keys(props)
  .filter((t) => !t.startsWith('_'))
  .map((t) => ({ t, size: entrySize(catalog[t]) }))
  .filter((r) => r.size > 0)
  .sort((a, b) => a.size - b.size);

let flatOk = true;
let curveOk = true;
for (const r of propRows) {
  const m = sizeMultiplier(r.size, dcfg);
  if (r.size <= boundary) {
    if (!near(m, dcfg.smallMult)) { flatOk = false; console.error(`    ${r.t} (${r.size.toFixed(3)} m) <= boundary but mult ${m.toFixed(3)} != smallMult ${dcfg.smallMult}`); }
  } else if (!near(m, pureCurve(r.size))) {
    curveOk = false; console.error(`    ${r.t} (${r.size.toFixed(3)} m) > boundary but mult ${m.toFixed(3)} != curve ${pureCurve(r.size).toFixed(3)}`);
  }
}
ok(flatOk, `every prop <= ${boundary} m takes the flat smallMult (${dcfg.smallMult}) — the smallest props all die in ~2 hits`);
ok(curveOk, 'every prop above the boundary stays on the untouched size-comparison hyperbola');

// The boundary sits in a genuine size GAP (nothing perched right on it), so a hull re-bake jittering
// a prop's size by a mm can't silently flip it across. Assert a comfortable margin either side.
const largestSmall = Math.max(...propRows.filter((r) => r.size <= boundary).map((r) => r.size));
const smallestMedium = Math.min(...propRows.filter((r) => r.size > boundary).map((r) => r.size));
ok(boundary - largestSmall > 0.02 && smallestMedium - boundary > 0.02,
  `boundary ${boundary} m sits in a clear size gap (largest small ${largestSmall.toFixed(3)} m, smallest medium ${smallestMedium.toFixed(3)} m) — robust to hull jitter`);

// Monotonic: bigger prop is never MORE fragile, even across the flat-boundary seam.
let monotonic = true;
let prev = Infinity;
for (const r of propRows) {
  const m = sizeMultiplier(r.size, dcfg);
  if (m > prev + 1e-9) monotonic = false;
  prev = m;
}
ok(monotonic, 'multiplier stays monotonically non-increasing across the boundary seam (bigger => never more fragile)');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nsmallest-prop check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nsmallest-prop check passed');
