#!/usr/bin/env node
// DISGUISE-ANYTHING eligibility check (Part B). AUTHORING-ONLY: never imported by the
// page. Pure, zero-dependency, deterministic — runs on a bare `node`, no install/network.
//
//     node tools/check-disguise-eligibility.mjs
//
// A player may disguise as ANY object they aim at EXCEPT world ARCHITECTURE. This asserts
// the ONE shared rule the referee builds its disguise pool from (physics.isDisguisableEntry
// = "has a renderable mesh AND not architecture"), on the real catalogs and the real map:
//   - vent (extractor), counter, oven, PILLAR, fridge, cabinets, sinks, shelves, doors,
//     tables, chairs and food ARE eligible;
//   - floor / wall / wall-panel / ceiling entries are NOT (isArchEntry);
//   - and the capsule max-radius cap keeps even giant disguises (counter/fridge/pillar)
//     narrow enough to pass through the 1.2 m doorways.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDisguisableEntry, isArchEntry, isStaticEntry, halfExtentsFor } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cfg = (name) => JSON.parse(readFileSync(join(root, 'shared', 'config', name), 'utf8'));
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const rules = cfg('rules.json');
const maps = cfg('maps.json');
const catalog = { ...props, ...fixtures };

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('disguise-anything eligibility check (renderable mesh AND not architecture)\n');

// ---- 1) The rule on named catalog entries --------------------------------------------
console.log('eligible (explicitly requested by VRmike — incl. pillars):');
const ELIGIBLE = [
  'extractor',   // the kitchen vent / extractor hood
  'counter', 'oven', 'stove', 'fridge', 'cabinet', 'cabinet_corner',
  'prep_sink', 'table_sink', 'shelf', 'door',
  'pillar', 'pillar_b', // pillars — yes, on purpose
  'kitchen_table', 'table_food', 'round_table', 'large_table', // tables
  'food_burger', 'raw_ham', 'onion_rings', // food
  'dishrack', 'pot_a', 'plate_small', // cookware / dishes
];
for (const t of ELIGIBLE) {
  const c = catalog[t];
  ok(c && isDisguisableEntry(c), `"${t}" IS disguisable`);
}

console.log('\nfrom the disguise props catalog (chairs, food, crates):');
for (const t of ['diner_chair', 'kitchen_stool', 'food_crate', 'burger', 'tomato', 'cheese']) {
  ok(catalog[t] && isDisguisableEntry(catalog[t]), `"${t}" IS disguisable`);
}

console.log('\nNOT eligible — architecture (floors / walls / panels):');
const ARCH = ['floor_kitchen', 'kitchen_wall', 'wall_post', 'wall_header'];
for (const t of ARCH) {
  const c = catalog[t];
  ok(c && isArchEntry(c), `"${t}" is flagged architecture (isArchEntry)`);
  ok(c && !isDisguisableEntry(c), `"${t}" is NOT disguisable`);
}

// A synthetic ceiling entry must also be rejected (the rule covers ceilings even though no
// map ships one yet) — guards the classifier, not just the current catalog.
ok(!isDisguisableEntry({ shape: 'box', ceiling: true }), 'a `ceiling:true` entry is NOT disguisable');
ok(isArchEntry({ wall: true }), 'a `wall:true` entry counts as architecture');

// ---- 2) End-to-end on the restaurant map: the referee's promoted pool ----------------
// Mirror referee.startMatch: the disguise pool = map.props + every NON-architecture
// map.fixture. Assert the requested types surface as disguisable and NO architecture does.
console.log('\nrestaurant map disguise pool (mirrors referee.startMatch promotion):');
const map = maps.restaurant;
const poolTypes = new Set();
let archLeaked = 0;
for (const p of map.props || []) if (isDisguisableEntry(catalog[p.type])) poolTypes.add(p.type);
for (const f of map.fixtures || []) {
  const c = catalog[f.type];
  if (!c) continue;
  if (isDisguisableEntry(c)) poolTypes.add(f.type);
  if (isArchEntry(c) && isDisguisableEntry(c)) archLeaked++; // must never happen
}
for (const t of ['extractor', 'counter', 'oven', 'pillar', 'pillar_b', 'fridge', 'door']) {
  ok(poolTypes.has(t), `restaurant pool includes "${t}"`);
}
for (const t of ARCH) {
  ok(!poolTypes.has(t), `restaurant pool EXCLUDES architecture "${t}"`);
}
ok(archLeaked === 0, 'no architecture entry is ever both arch AND disguisable (rule is airtight)');

// ---- 3) Capsule max-radius cap keeps giant disguises passable through doorways --------
// setPlayerCollider caps the disguised capsule radius at min(disguiseColliderMaxRadius,
// pCenterY-0.1); this mirrors that derivation and asserts the resulting DIAMETER clears the
// narrowest passage (the 1.2 m door). A pillar is visually much taller than the capsule —
// accepted + intentional (physics footprint only, per the plan).
console.log('\ncapsule cap keeps giant disguises passable:');
const baseR = rules.playerRadius ?? 0.4;
const pCenterY = (rules.playerRadius ?? 0.4) + (rules.playerHalfHeight ?? 0.5);
const cap = Math.min(rules.disguiseColliderMaxRadius ?? 0.55, pCenterY - 0.1);
const doorW = catalog.door.w; // 1.2 m — the canonical doorway width
ok(2 * cap <= doorW, `capsule cap diameter ${(2 * cap).toFixed(2)}m ≤ doorway ${doorW}m (any disguise fits)`);
for (const t of ['counter', 'fridge', 'pillar', 'oven', 'table_food']) {
  const he = halfExtentsFor(catalog[t]);
  const r = Math.min(cap, Math.max(baseR, Math.min(he.hx, he.hz)));
  ok(2 * r <= doorW, `"${t}" disguise capsule diameter ${(2 * r).toFixed(2)}m ≤ doorway ${doorW}m — passable`);
}

console.log('');
if (fails) {
  console.error(`disguise-eligibility check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('disguise-eligibility check passed');
