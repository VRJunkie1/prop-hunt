#!/usr/bin/env node
// Offline acceptance check for HUNTER-TOOLS v1 — HEALTH / DAMAGE + the win condition.
// AUTHORING-ONLY (never imported by the page / shipped). Run from a shell:
//
//     node tools/check-combat.mjs
//
// WHY THIS EXISTS. The damage rules and the new "all hunters dead → props win" round-end
// are host-authoritative logic that a headless browser boot can't exercise (no match, no
// Rapier). So this drives the REAL shared code paths directly and asserts the OUTPUTS:
//   A) the size→multiplier LERP (tiny things die in ~2 hits; a table soaks ~3× the default
//      player's bullets; a plain undisguised player takes the base hit);
//   B) a hunter shooting a PLAYER scales damage by that player's disguise size, and a KILL
//      of a prop REFILLS the hunter to full;
//   C) shooting a could-have-been-a-player DECOY (a disguisable prop / non-arch fixture)
//      bounces the damage onto the HUNTER, while real ARCHITECTURE (wall/floor) is a free
//      miss (no damage);
//   D) the WIN CONDITIONS: all hunters dead → PROPS win; all props caught → HUNTERS win.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE, PHASE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';
import { isArchEntry } from '../shared/physics.js';
import {
  resolveDamageCfg, entrySize, sizeMultiplier, multiplierForDisguise, damageForPlayerHit,
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
const hitsToKill = (perHit, hp = 100) => Math.ceil(hp / perHit);

console.log('HUNTER-TOOLS v1: health / damage + win-condition acceptance check');

// Real config so the numbers are the SHIPPING numbers, not invented ones.
const rules = readJSON('shared', 'config', 'rules.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const catalog = { ...props, ...fixtures };
const dcfg = resolveDamageCfg(rules.damage);
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// ---------------------------------------------------------------------------
// A) SIZE → MULTIPLIER LERP (pure damage.js — the same module the referee uses).
// ---------------------------------------------------------------------------
console.log('\nA) size → multiplier curve');
ok(dcfg.base > 0 && dcfg.smallMult > dcfg.largeMult, `damage config sane (base ${dcfg.base}, smallMult ${dcfg.smallMult} > largeMult ${dcfg.largeMult})`);

// Anchor clamps.
ok(near(sizeMultiplier(dcfg.smallSize, dcfg), dcfg.smallMult), `at smallSize (${dcfg.smallSize} m) => smallMult (${dcfg.smallMult})`);
ok(near(sizeMultiplier(dcfg.smallSize / 2, dcfg), dcfg.smallMult), 'below smallSize clamps to smallMult');
ok(near(sizeMultiplier(dcfg.largeSize, dcfg), dcfg.largeMult), `at largeSize (${dcfg.largeSize} m) => largeMult (${dcfg.largeMult})`);
ok(near(sizeMultiplier(dcfg.largeSize * 2, dcfg), dcfg.largeMult), 'above largeSize clamps to largeMult');

// Midpoint lerp value + strict monotonic decrease across a sweep.
const mid = (dcfg.smallSize + dcfg.largeSize) / 2;
ok(near(sizeMultiplier(mid, dcfg), (dcfg.smallMult + dcfg.largeMult) / 2, 1e-6), 'midpoint size => midpoint multiplier (true lerp)');
let monotonic = true;
let prev = Infinity;
for (let s = dcfg.smallSize; s <= dcfg.largeSize + 1e-9; s += (dcfg.largeSize - dcfg.smallSize) / 20) {
  const m = sizeMultiplier(s, dcfg);
  if (m > prev + 1e-9) monotonic = false;
  prev = m;
}
ok(monotonic, 'multiplier is monotonically non-increasing as size grows (smooth lerp)');

// Real catalog entries — the actual gameplay outcomes the brief specified.
const burgerSize = entrySize(catalog.burger);
const tableSize = entrySize(catalog.kitchen_table);
ok(burgerSize > 0 && tableSize > burgerSize, `entrySize reads the physics footprint (burger ${burgerSize.toFixed(2)} m < table ${tableSize.toFixed(2)} m)`);

const dmgBurger = damageForPlayerHit('burger', catalog, dcfg);
const dmgTable = damageForPlayerHit('kitchen_table', catalog, dcfg);
const dmgDefault = damageForPlayerHit(null, catalog, dcfg); // undisguised player
ok(multiplierForDisguise(null, catalog, dcfg) === dcfg.defaultMult, 'an UNDISGUISED player uses defaultMult (plain base hit)');
ok(hitsToKill(dmgDefault) === Math.ceil(startHealth / dcfg.base), `undisguised player dies in ${hitsToKill(dmgDefault)} base hits`);
ok(hitsToKill(dmgBurger) <= 2, `tiny disguise (burger, ${dmgBurger.toFixed(1)}/hit) dies in ~2 hits (${hitsToKill(dmgBurger)})`);
ok(hitsToKill(dmgTable) >= 2.5 * hitsToKill(dmgDefault), `big disguise (table, ${dmgTable.toFixed(1)}/hit) soaks ~3× the default player's bullets (${hitsToKill(dmgTable)} vs ${hitsToKill(dmgDefault)})`);

// ---------------------------------------------------------------------------
// Build a Referee driving the REAL shared code paths (no Rapier, no browser). The
// constructor starts a tick interval + reads no DOM in Node; we destroy() at the end.
// ---------------------------------------------------------------------------
function makeRef() {
  const ref = new Referee({ rules, maps: { test: {} }, props, fixtures, feel: {} }, 'TEST');
  return ref;
}
function addPlayer(ref, id, role, extra = {}) {
  const p = {
    id, name: id, role, alive: true, health: startHealth,
    pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, disguise: null,
    send: () => {}, ...extra,
  };
  ref.players.set(id, p);
  return p;
}
// Pick a real ARCHITECTURE fixture type from the catalog (robust to naming).
const archType = Object.keys(fixtures).find((t) => isArchEntry(fixtures[t]));

// ---------------------------------------------------------------------------
// B) PLAYER HIT scales by disguise size; KILL of a prop REFILLS the hunter.
// ---------------------------------------------------------------------------
console.log('\nB) player damage + kill-refill');
{
  const ref = makeRef();
  ref.phase = PHASE.HUNTING;
  const hunter = addPlayer(ref, 'H', ROLE.HUNTER);
  const propPlain = addPlayer(ref, 'P0', ROLE.PROP, { disguise: null });
  const propBurger = addPlayer(ref, 'P1', ROLE.PROP, { disguise: 'burger' });
  ref.props = [];

  // Undisguised prop-player: base hit.
  ref._applyShotDamage(hunter, { kind: 'player', id: 'P0' });
  ok(near(propPlain.health, startHealth - dcfg.base), `undisguised player takes the base hit (${startHealth} → ${propPlain.health})`);

  // Disguised burger: one big hit (scaled).
  ref._applyShotDamage(hunter, { kind: 'player', id: 'P1' });
  ok(near(propBurger.health, startHealth - dmgBurger), `burger-disguised player takes size-scaled damage (${startHealth} → ${propBurger.health.toFixed(1)})`);

  // Kill a prop: hunter refills to full.
  hunter.health = 40;
  propBurger.health = 5; // one more hit finishes it
  ref._applyShotDamage(hunter, { kind: 'player', id: 'P1' });
  ok(propBurger.alive === false, 'prop reduced to 0 HP is eliminated (alive=false)');
  ok(near(hunter.health, startHealth), `hunter REFILLS to full on a prop kill (40 → ${hunter.health})`);
  ref.destroy();
}

// ---------------------------------------------------------------------------
// C) WRONG-PROP SELF-DAMAGE vs free-miss ARCHITECTURE.
// ---------------------------------------------------------------------------
console.log('\nC) wrong-prop self-damage / architecture free miss');
{
  const ref = makeRef();
  ref.phase = PHASE.HUNTING;
  const hunter = addPlayer(ref, 'H', ROLE.HUNTER);
  // Prop instances the raycast could report (disguisable decoy + a non-disguisable one).
  ref.props = [
    { id: 1, type: 'burger', disguisable: true },
    { id: 2, type: 'crate', disguisable: false },
  ];

  // Shoot a disguisable decoy PROP → hunter takes size-scaled damage.
  hunter.health = startHealth;
  ref._applyShotDamage(hunter, { kind: 'prop', id: 1 });
  ok(hunter.health < startHealth, `shooting a could-be-a-player prop bounces damage onto the HUNTER (${startHealth} → ${hunter.health.toFixed(1)})`);
  const afterDecoy = hunter.health;

  // A prop flagged non-disguisable → no self-damage (treated like scenery).
  ref._applyShotDamage(hunter, { kind: 'prop', id: 2 });
  ok(near(hunter.health, afterDecoy), 'a non-disguisable prop instance does NOT self-damage');

  // A disguisable STATIC fixture (counter) → self-damage.
  hunter.health = startHealth;
  ref._applyShotDamage(hunter, { kind: 'fixture', type: 'counter' });
  ok(hunter.health < startHealth, `shooting a disguisable static fixture (counter) self-damages (${startHealth} → ${hunter.health.toFixed(1)})`);

  // Real ARCHITECTURE fixture → free miss (no damage).
  hunter.health = startHealth;
  if (archType) {
    ref._applyShotDamage(hunter, { kind: 'fixture', type: archType });
    ok(near(hunter.health, startHealth), `architecture (${archType}) is a FREE MISS — no damage`);
  } else {
    ok(false, 'expected at least one architecture fixture in fixtures.json');
  }

  // World geometry (ground/boundary wall) → free miss.
  ref._applyShotDamage(hunter, { kind: 'world' });
  ok(near(hunter.health, startHealth), 'world geometry (ground / boundary wall) is a FREE MISS');
  ref.destroy();
}

// ---------------------------------------------------------------------------
// D) WIN CONDITIONS through checkRoundOver → endRound → lastResult.
// ---------------------------------------------------------------------------
console.log('\nD) win conditions');
{
  // All hunters dead → PROPS win (the new, ruling-1 condition).
  const ref = makeRef();
  ref.phase = PHASE.HUNTING;
  const hunter = addPlayer(ref, 'H', ROLE.HUNTER);
  addPlayer(ref, 'P', ROLE.PROP); // a prop still alive
  ref.props = [];
  ref._damagePlayer(hunter, hunter, startHealth, true); // self-destruct to 0 HP
  ok(hunter.alive === false, 'hunter reaching 0 HP is dead (no respawn)');
  ok(ref.lastResult && ref.lastResult.winner === ROLE.PROP, 'ALL HUNTERS DEAD → props win (round ended)');
  ok(ref.phase === PHASE.ENDING, 'round transitioned to ENDING on the props win');
  ref.destroy();
}
{
  // All props caught → HUNTERS win (pre-existing condition still holds).
  const ref = makeRef();
  ref.phase = PHASE.HUNTING;
  const hunter = addPlayer(ref, 'H', ROLE.HUNTER);
  const prop = addPlayer(ref, 'P', ROLE.PROP, { disguise: null });
  ref.props = [];
  prop.health = dcfg.base; // one base hit finishes it
  ref._applyShotDamage(hunter, { kind: 'player', id: 'P' });
  ok(prop.alive === false, 'the last prop is eliminated');
  ok(ref.lastResult && ref.lastResult.winner === ROLE.HUNTER, 'ALL PROPS CAUGHT → hunters win');
  ref.destroy();
}

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\ncombat check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ncombat check passed');
