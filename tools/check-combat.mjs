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
  wrongGuessPenalty, playerSizeFromRules,
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
// Inject the LIVE playerSize exactly as the referee does (playerSizeFromRules) so the pivot the
// check asserts is the pivot the game uses — not the module's static default.
dcfg.playerSize = playerSizeFromRules(rules);
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// ---------------------------------------------------------------------------
// A) SIZE → MULTIPLIER CURVE — the SIZE-COMPARISON FACTOR (2026-07-19, VRmike). The disguise
//    multiplier is 1 / (propSize / (playerSize * sizeComparisonFactor)) clamped to [largeMult,
//    smallMult]. Neutral (multiplier 1.0) at propSize == playerSize * sizeComparisonFactor.
//    Same pure damage.js the referee uses.
// ---------------------------------------------------------------------------
console.log('\nA) size → multiplier curve (size-comparison factor)');
ok(dcfg.base > 0 && dcfg.smallMult > dcfg.largeMult, `damage config sane (base ${dcfg.base}, smallMult ${dcfg.smallMult} > largeMult ${dcfg.largeMult})`);
ok(dcfg.sizeComparisonFactor > 0 && dcfg.sizeComparisonFactor <= 2, `sizeComparisonFactor (${dcfg.sizeComparisonFactor}) is set and in a sane band`);
ok(dcfg.playerSize > 0, `playerSize derived from the capsule (${dcfg.playerSize.toFixed(2)} m)`);

// The PIVOT: a prop exactly sizeComparisonFactor× the player's size takes the neutral base multiplier.
const pivotSize = dcfg.playerSize * dcfg.sizeComparisonFactor;
ok(near(sizeMultiplier(pivotSize, dcfg), 1.0, 1e-9), `a prop at the pivot (${pivotSize.toFixed(2)} m = ${dcfg.sizeComparisonFactor}× player) => multiplier 1.0 (base damage)`);

// The exact formula holds where the clamps don't bind (a mid-sized prop between the two anchors).
const probe = pivotSize * 1.3;
ok(near(sizeMultiplier(probe, dcfg), 1 / (probe / pivotSize), 1e-9), 'multiplier == 1 / (propSize / (playerSize * sizeComparisonFactor)) in the unclamped band');

// Guardrail clamps: a prop far below the pivot pins to smallMult (ceiling); far above pins to largeMult (floor).
ok(near(sizeMultiplier(pivotSize / dcfg.smallMult / 2, dcfg), dcfg.smallMult), `a tiny prop clamps to the smallMult ceiling (${dcfg.smallMult})`);
ok(near(sizeMultiplier(pivotSize / dcfg.largeMult * 2, dcfg), dcfg.largeMult), `a huge prop clamps to the largeMult floor (${dcfg.largeMult})`);

// Strict monotonic decrease across a size sweep (bigger prop => never more damage).
let monotonic = true;
let prev = Infinity;
for (let s = 0.3; s <= 3.0 + 1e-9; s += 0.1) {
  const m = sizeMultiplier(s, dcfg);
  if (m > prev + 1e-9) monotonic = false;
  prev = m;
}
ok(monotonic, 'multiplier is monotonically non-increasing as size grows (bigger => tankier)');

// Lowering sizeComparisonFactor makes EVERY (unclamped) prop tankier — the balance lever VRmike asked for.
const tankier = resolveDamageCfg({ ...rules.damage, sizeComparisonFactor: dcfg.sizeComparisonFactor * 0.5 });
tankier.playerSize = dcfg.playerSize;
ok(sizeMultiplier(probe, tankier) < sizeMultiplier(probe, dcfg), 'halving sizeComparisonFactor lowers the multiplier (props get tankier) — the one-knob balance lever');

// Real catalog entries — VRmike's three named cases: burger (tiny) HIGH, ~0.6× player pivot BASE, fridge (big) LOW.
const burgerSize = entrySize(catalog.burger);
const fridgeSize = entrySize(catalog.fridge);
const tableSize = entrySize(catalog.kitchen_table);
ok(burgerSize > 0 && fridgeSize > burgerSize && tableSize > fridgeSize,
  `entrySize reads the physics footprint (burger ${burgerSize.toFixed(2)} < fridge ${fridgeSize.toFixed(2)} < table ${tableSize.toFixed(2)} m)`);

const dmgBurger = damageForPlayerHit('burger', catalog, dcfg);
const dmgFridge = damageForPlayerHit('fridge', catalog, dcfg);
const dmgTable = damageForPlayerHit('kitchen_table', catalog, dcfg);
const dmgDefault = damageForPlayerHit(null, catalog, dcfg); // undisguised player
ok(multiplierForDisguise(null, catalog, dcfg) === dcfg.defaultMult, 'an UNDISGUISED player uses defaultMult (plain base hit)');
ok(hitsToKill(dmgDefault) === Math.ceil(startHealth / dcfg.base), `undisguised player dies in ${hitsToKill(dmgDefault)} base hits`);
// TINY prop (burger, smaller than the pivot) => HIGH damage: takes MORE than base, dies FASTER than an undisguised player.
ok(dmgBurger > dmgDefault && hitsToKill(dmgBurger) < hitsToKill(dmgDefault),
  `tiny disguise (burger, ${dmgBurger.toFixed(1)}/hit) takes HIGH damage — more than base, dies faster than a plain player (${hitsToKill(dmgBurger)} < ${hitsToKill(dmgDefault)} hits)`);
// BIG props (fridge, table — bigger than the pivot) => LOW damage: take LESS than base, soak more bullets.
ok(dmgFridge < dmgDefault && hitsToKill(dmgFridge) > hitsToKill(dmgDefault),
  `big disguise (fridge, ${dmgFridge.toFixed(1)}/hit) takes LOW damage — less than base, soaks more bullets (${hitsToKill(dmgFridge)} > ${hitsToKill(dmgDefault)} hits)`);
ok(dmgTable < dmgFridge, `an even bigger disguise (table, ${dmgTable.toFixed(1)}/hit) takes LESS than the fridge — monotonic by size`);

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
// C) WRONG-GUESS PENALTY — FLAT base, SIZE-INDEPENDENT — vs free-miss ARCHITECTURE.
//    (2026-07-12 tuning: a hunter shooting a disguisable decoy loses a flat `base`, never a
//    size-scaled amount — a burger decoy and a table decoy cost exactly the same.)
// ---------------------------------------------------------------------------
console.log('\nC) wrong-guess penalty (flat base, size-independent) / architecture free miss');
{
  const ref = makeRef();
  ref.phase = PHASE.HUNTING;
  const hunter = addPlayer(ref, 'H', ROLE.HUNTER);
  const flat = wrongGuessPenalty(dcfg);
  ok(near(flat, dcfg.base), `wrong-guess penalty is the FLAT base (${flat}), no size multiplier`);

  // Prop instances the raycast could report (a tiny disguisable decoy + a non-disguisable one).
  ref.props = [
    { id: 1, type: 'burger', disguisable: true },
    { id: 2, type: 'crate', disguisable: false },
  ];

  // Shoot a TINY disguisable decoy PROP → hunter loses exactly the flat base.
  hunter.health = startHealth;
  ref._applyShotDamage(hunter, { kind: 'prop', id: 1 });
  ok(near(hunter.health, startHealth - flat), `shooting a tiny (burger) decoy costs the flat base (${startHealth} → ${hunter.health.toFixed(1)})`);

  // A prop flagged non-disguisable → no self-damage (treated like scenery).
  const afterDecoy = hunter.health;
  ref._applyShotDamage(hunter, { kind: 'prop', id: 2 });
  ok(near(hunter.health, afterDecoy), 'a non-disguisable prop instance does NOT self-damage');

  // A BIG disguisable decoy (table fixture) → the SAME flat base, despite a wildly different
  // size. This is the tuning rule: the penalty NEVER scales with what was shot.
  const bigDecoy = 'kitchen_table';
  hunter.health = startHealth;
  ref._applyShotDamage(hunter, { kind: 'fixture', type: bigDecoy });
  ok(near(hunter.health, startHealth - flat), `shooting a BIG (${bigDecoy}) decoy costs the SAME flat base (${startHealth} → ${hunter.health.toFixed(1)}) — size never scales the penalty`);
  // Sanity: the two decoys really DO have different size multipliers, so an equal, flat
  // penalty is a meaningful assertion (not a coincidence of equal sizes).
  ok(
    !near(multiplierForDisguise('burger', catalog, dcfg), multiplierForDisguise(bigDecoy, catalog, dcfg)),
    `the two decoys have DIFFERENT size multipliers (burger ${multiplierForDisguise('burger', catalog, dcfg).toFixed(2)} vs ${bigDecoy} ${multiplierForDisguise(bigDecoy, catalog, dcfg).toFixed(2)}) — yet the penalty above was identical`
  );
  // 20 wrong guesses = dead at the new flat base.
  ok(hitsToKill(flat, startHealth) === Math.ceil(startHealth / dcfg.base), `${hitsToKill(flat, startHealth)} wrong guesses = dead (flat ${flat}/guess)`);

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
// E) DAMAGE MULTIPLIER RECOMPUTES ON RE-DISGUISE (the confirmed live bug). A prop that goes
//    SMALL then re-disguises LARGE must immediately take LARGE-object damage — never keep the
//    small-object multiplier. This drives the REAL authoritative path (applyDisguise ->
//    _applyShotDamage) through a small->large re-disguise and asserts the per-hit damage
//    tracks the CURRENT prop. This is the single behavioural gate for the bug.
// ---------------------------------------------------------------------------
console.log('\nE) size multiplier recomputes on re-disguise (small -> large)');
{
  const ref = makeRef();
  ref.phase = PHASE.HUNTING;
  const hunter = addPlayer(ref, 'H', ROLE.HUNTER);
  const prop = addPlayer(ref, 'P', ROLE.PROP, { disguise: null, input: {} });
  // Two disguisable props at the player's position (in range): a tiny burger + a big table.
  ref.props = [
    { id: 1, type: 'burger', disguisable: true, x: 0, z: 0 },
    { id: 2, type: 'kitchen_table', disguisable: true, x: 0, z: 0 },
  ];
  ref.propLive = new Map([[1, { x: 0, z: 0 }], [2, { x: 0, z: 0 }]]);

  ref.applyDisguise(prop, 1); // become SMALL
  ok(prop.disguise === 'burger', 'disguises as the small prop (burger)');
  const smallMult = multiplierForDisguise(prop.disguise, catalog, dcfg);
  prop.health = startHealth;
  ref._applyShotDamage(hunter, { kind: 'player', id: 'P' });
  const smallDmg = startHealth - prop.health;

  ref.applyDisguise(prop, 2); // RE-disguise LARGE
  ok(prop.disguise === 'kitchen_table', 're-disguise updates the disguise to the large prop');
  const largeMult = multiplierForDisguise(prop.disguise, catalog, dcfg);
  prop.health = startHealth;
  ref._applyShotDamage(hunter, { kind: 'player', id: 'P' });
  const largeDmg = startHealth - prop.health;

  ok(largeMult < smallMult, `large prop has a smaller size multiplier than small (${largeMult.toFixed(2)} < ${smallMult.toFixed(2)})`);
  ok(near(largeDmg, dcfg.base * largeMult),
    `after re-disguise, per-hit damage matches the CURRENT (large) prop (${largeDmg.toFixed(2)}) — NOT the stale small multiplier`);
  ok(largeDmg < smallDmg,
    `re-disguised large prop now takes LESS per hit than it did while small (${largeDmg.toFixed(2)} < ${smallDmg.toFixed(2)}) — no cached multiplier`);
  // And the referee's own derivation helper agrees (the path applyShot actually uses).
  ok(near(ref._playerHitDamage(prop), dcfg.base * largeMult), 'referee._playerHitDamage derives fresh from the current disguise');
  ref.destroy();
}

// ---------------------------------------------------------------------------
// F) RAPID-FIRE config: the tunable exists, is in a sane full-auto band, and the host derives
//    its authoritative rate cap from it (config check per the plan — not a live fire test).
// ---------------------------------------------------------------------------
console.log('\nF) rapid-fire config');
{
  ok(Number.isFinite(rules.fireRateRpm) && rules.fireRateRpm >= 300 && rules.fireRateRpm <= 1200,
    `rules.fireRateRpm (${rules.fireRateRpm}) is set and in a sane assault-rifle/SMG range (300-1200)`);
  const ref = makeRef();
  const cap = ref._fireCooldownMs();
  ref.destroy();
  ok(cap > 0 && cap < 1000, `host derives a fire cooldown from rpm (${cap}ms between shots)`);
  ok(Math.round(60000 / cap) >= rules.fireRateRpm,
    `host cap admits at least the configured rate (~${Math.round(60000 / cap)} rpm ceiling >= ${rules.fireRateRpm})`);
}

// ---------------------------------------------------------------------------
// G) DISGUISE-SHAPED SHOT SENSOR — LIVE raycast against the REAL PhysicsWorld (HITBOX
//    ACCURACY, 2026-07). A disguised player is shot on a disguise-shaped SENSOR matched to the
//    prop primitive (not the movement capsule). Fire rays at the EDGES of a table disguise and
//    assert player hits; fire just OUTSIDE and above the low silhouette and assert misses. Needs
//    Rapier (WASM): if it's not installed the section SKIPs (never fails a build it can't run).
// ---------------------------------------------------------------------------
console.log('\nG) disguise-shaped shot sensor (live Rapier raycast)');
let RAPIER = null;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; } catch { /* not installed */ }
if (!RAPIER) {
  console.log('  … SKIP: @dimforge/rapier3d-compat not installed (run `npm install`, or `npm i --no-save @dimforge/rapier3d-compat@0.14.0`). Sensor geometry unverified this run.');
} else {
  await RAPIER.init();
  const { PhysicsWorld } = await import('../shared/physics.js');
  // A plain arena; a box "table" disguise (2.25 × 0.75 × 1.5, like kitchen_table) at the origin.
  const map = { size: 40, fixtures: [] };
  const TABLE = { shape: 'box', w: 2.25, h: 0.75, d: 1.5 };
  const cat = { table: TABLE };
  const world = new PhysicsWorld(RAPIER, map, [], cat, { dynamicProps: true, rules, feel: {} });
  world.addPlayer('P', { x: 0, y: 0, z: 0 });     // the (soon-to-be) disguised prop-player
  world.setPlayerCollider('P', 'table');           // movement capsule grows (capped) — UNCHANGED behaviour
  world.setShotCollider('P', 'table');             // NEW: disguise-shaped shot sensor
  world.step(1 / 60);                              // let the kinematic body settle its transform

  // Footprint half-extents (axis-aligned, dispYaw = 0): x∈[-1.125,1.125], y∈[0,0.75], z∈[-0.75,0.75].
  const HW = TABLE.w / 2, HD = TABLE.d / 2, TOP = TABLE.h;
  // Cast straight DOWN from above a point; returns the classified hit (or null).
  const shootDown = (x, z, fromY = 5) => world.raycastShot('HUNTER', { x, y: fromY, z }, { x: 0, y: -1, z: 0 }, 20);
  // Cast horizontally along +x through the player's column at height y.
  const shootAcross = (y) => world.raycastShot('HUNTER', { x: -6, y, z: 0 }, { x: 1, y: 0, z: 0 }, 40);

  const cornerNear = shootDown(HW - 0.06, HD - 0.06); // just INSIDE a table corner (visible surface)
  ok(cornerNear && cornerNear.info && cornerNear.info.kind === 'player' && cornerNear.info.id === 'P',
    `a ray at the table CORNER registers on the player (kind=${cornerNear ? cornerNear.info.kind : 'miss'})`);

  const edgeMid = shootDown(HW - 0.06, 0); // middle of a long edge
  ok(edgeMid && edgeMid.info && edgeMid.info.kind === 'player',
    `a ray at the table EDGE registers on the player (kind=${edgeMid ? edgeMid.info.kind : 'miss'})`);

  const outside = shootDown(HW + 0.4, 0); // just OUTSIDE the footprint (and outside the fat capsule)
  ok(!(outside && outside.info && outside.info.kind === 'player'),
    `a ray just OUTSIDE the table footprint MISSES the player (kind=${outside ? outside.info.kind : 'clean miss'})`);

  // The tall movement capsule (≈1.8 m) pokes far above the 0.75 m table — a ray at 1.4 m through
  // the player's column must NOT register a phantom hit above the visible disguise. This is the
  // core WYSIWYG guarantee (capsule excluded from the shot ray).
  const aboveTop = shootAcross(1.4);
  ok(!(aboveTop && aboveTop.info && aboveTop.info.kind === 'player'),
    `a ray ABOVE the low disguise (y=1.4, capsule height ≈1.8) does NOT phantom-hit the player (kind=${aboveTop ? aboveTop.info.kind : 'clean miss'})`);

  // A ray THROUGH the table's actual height (y=0.4) does register.
  const throughBody = shootAcross(0.4);
  ok(throughBody && throughBody.info && throughBody.info.kind === 'player',
    `a ray through the disguise body (y=0.4) registers on the player (kind=${throughBody ? throughBody.info.kind : 'miss'})`);

  // No double-hit: castRay returns the single nearest collider, and every movement capsule is
  // excluded — so a corner hit is via the SENSOR, and there is exactly one player collider in
  // the returned hit. (Structural: one ray → one hit; asserted implicitly by the single kind above.)

  // ROTATION: a point just beyond the AXIS-ALIGNED footprint in +z (z=0.95 > HD=0.75) misses;
  // after yawing the disguise 45° the same point falls inside the rotated table and registers —
  // proving the sensor tracks dispYaw so a turned table is shot at its TRUE corners.
  const beyondZ = shootDown(0, 0.95);
  ok(!(beyondZ && beyondZ.info && beyondZ.info.kind === 'player'),
    `(axis-aligned) a ray beyond the table's +z edge misses (kind=${beyondZ ? beyondZ.info.kind : 'clean miss'})`);
  world.setShotColliderYaw('P', Math.PI / 4); // turn the disguise 45°
  world.step(1 / 60);
  const rotatedIn = shootDown(0, 0.95);
  ok(rotatedIn && rotatedIn.info && rotatedIn.info.kind === 'player',
    `(rotated 45°) the SAME point now registers on the player — the sensor tracks dispYaw (kind=${rotatedIn ? rotatedIn.info.kind : 'miss'})`);
  world.setShotColliderYaw('P', 0); // restore axis-aligned for the undisguise checks below
  world.step(1 / 60);

  // Damage multiplier keys off the CURRENT disguise even after a live re-shape: undisguise →
  // the sensor becomes capsule-matching and the tall-capsule column is hit again at body height.
  world.setPlayerCollider('P', null);
  world.setShotCollider('P', null);
  world.step(1 / 60);
  const undisguisedTop = shootAcross(1.4); // now the capsule-matching sensor reaches up to ≈1.8
  ok(undisguisedTop && undisguisedTop.info && undisguisedTop.info.kind === 'player',
    `after UNDISGUISE, the capsule-matching sensor is hit at body height (y=1.4) — sensor tracks the CURRENT shape`);
  const undisguisedWide = shootDown(HW - 0.06, 0); // the old table corner is now empty air
  ok(!(undisguisedWide && undisguisedWide.info && undisguisedWide.info.kind === 'player'),
    `after UNDISGUISE, the former table footprint no longer registers (sensor shrank with the disguise)`);

  world.destroy();
  console.log('  (damage multiplier vs CURRENT disguise is proven end-to-end in section E above.)');
}

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\ncombat check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ncombat check passed');
