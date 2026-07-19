#!/usr/bin/env node
// tools/check-prop-mass.mjs — LIVE-SIM regression guard for SIZE-BASED PROP WEIGHT + KNOCKABILITY
// (balance tweak, VRmike, #devbot 2026-07-19). Big props should be HARD to shove/fling, small props
// EASY to yeet — but EVERY prop must ALWAYS budge at least a little from any hit (a fridge is sluggish,
// never immovable). This stands up the REAL shared/physics.js PhysicsWorld and asserts, on the real
// impulse code paths (applyShotImpulse + applyBlastImpulse) plus the mass it bakes from setDensity:
//
//   cubic-mass                mass = propDensity × collider VOLUME, so doubling every dimension ≈ 8×
//                             the mass (the cubic real-world density law VRmike asked for).
//   mass-tracks-disguise      a prop body built from a bigger footprint gets a proportionally bigger
//                             mass immediately (so a burger-body and a fridge-body differ by their
//                             size, not a shared constant — the "get fridge mass on swap" intent).
//   burger-flies-fridge-resists  the SAME shot / the SAME grenade fling moves a small (burger) prop
//                             far and a big (fridge) prop only a little — the velocity change scales
//                             inversely with mass, and real travel distance follows.
//   everything-budges         the minimum-nudge floor guarantees even the heaviest prop still gets a
//                             visible velocity change (≥ minNudgeSpeed, capped) from any hit — a fridge
//                             is never immovable.
//   floor-not-amplified       the floor never exceeds the hit's OWN intended speed, so a weak far-edge
//                             grenade shove is not amplified into a launch.
//   hunter-mass-untouched     characterMass is unchanged by this build (hunters stay the same).
//
// AUTHORING-ONLY, never shipped. Rapier is a WASM package the page pulls from a CDN; this needs the
// local dev install (devDependencies):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-prop-mass.mjs
// If the package is absent it prints SKIP and exits 3 — it never fails a build it cannot run.
//
// CHAOS CAVEAT: Rapier is not bit-reproducible across processes, so exact travel varies run to run.
// Every assertion here is an INVARIANT the size-weight math enforces (mass ratio, inverse-mass Δv, the
// floor), asserted as ratios / lower bounds that hold in every run — not brittle absolute positions.

let RAPIER;
try {
  RAPIER = (await import('@dimforge/rapier3d-compat')).default;
} catch {
  console.log('SKIP: @dimforge/rapier3d-compat not installed. Run: npm i --no-save @dimforge/rapier3d-compat@0.14.0');
  process.exit(3);
}
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');

await RAPIER.init();
const readJSON = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const rules = readJSON('../shared/config/rules.json');
const feel = readJSON('../shared/config/physics-feel.json');
const realProps = readJSON('../shared/config/props.json');
const realFixtures = readJSON('../shared/config/fixtures.json');

const H = 1 / 60;
const map = { size: 40, fixtures: [] }; // plain arena — this behaviour is map-independent
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// Synthetic props so the cubic-mass ratio is exact and controllable, plus the real fridge footprint.
// small_box → big_box doubles every dimension (0.5 → 1.0), so volume ×8 and mass ×8.
const catalog = {
  small_box: { shape: 'box', w: 0.5, h: 0.5, d: 0.5 },   // vol 0.125 m³
  big_box: { shape: 'box', w: 1.0, h: 1.0, d: 1.0 },     // vol 1.0 m³  (2× dims → 8× vol)
  fridge_box: { shape: 'box', w: 1.5, h: 1.88, d: 1.68 }, // real fridge footprint (~4.74 m³)
  // Real catalog entries VRmike names: a burger (small) and a kitchen table (big, dynamic).
  burger: realProps.burger,
  kitchen_table: realFixtures.kitchen_table,
};

// Build a single free-standing dynamic prop of `type` at the origin and return its world + body.
function spawnProp(type) {
  const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type, x: 0, y: 0, z: 0, rot: 0 }], catalog,
    { dynamicProps: true, rules, feel });
  return { w, body: w.propBodies[0].body };
}
const massOf = (type) => { const { w, body } = spawnProp(type); const m = body.mass(); w.destroy(); return m; };

// Apply one horizontal hit and measure BOTH the instantaneous velocity change (precise, for the
// floor/ratio invariants) and the real horizontal travel over ~2 s (the "flies vs barely moves" story).
function hitAndMeasure(type, kind, speed) {
  const { w, body } = spawnProp(type);
  for (let i = 0; i < 90; i++) w.step(H); // let it settle + fall asleep on the floor
  const before = body.translation();
  if (kind === 'shot') w.applyShotImpulse(1, { x: before.x, y: before.y, z: before.z }, { x: 1, y: 0, z: 0 }, speed);
  else w.applyBlastImpulse(1, { x: before.x - 1, y: before.y, z: before.z }, speed); // centre offset -x → shove +x
  const v = body.linvel();
  const dv = Math.hypot(v.x, v.y, v.z);
  for (let i = 0; i < 120; i++) w.step(H); // 2 s of travel (friction + damping slow it)
  const after = body.translation();
  const travel = Math.hypot(after.x - before.x, after.z - before.z);
  w.destroy();
  return { dv, travel };
}

console.log('SIZE-BASED PROP WEIGHT + KNOCKABILITY: live-sim acceptance check');
console.log(`  (propDensity=${rules.propDensity}, minNudgeSpeed=${rules.minNudgeSpeed}, shotImpulse=${rules.shotImpulse}, flingSpeed=${rules.grenade.flingSpeed})`);

// ---------------------------------------------------------------------------
// 1) CUBIC MASS: mass = density × volume, so 2× the size ≈ 8× the mass.
// ---------------------------------------------------------------------------
const mSmall = massOf('small_box');
const mBig = massOf('big_box');
const mFridge = massOf('fridge_box');
const mBurger = massOf('burger');
const mTable = massOf('kitchen_table');
console.log(`\nmasses: small_box=${mSmall.toFixed(3)} big_box=${mBig.toFixed(3)} fridge_box=${mFridge.toFixed(2)} burger=${mBurger.toFixed(3)} kitchen_table=${mTable.toFixed(2)}`);
check('cubic-mass (2× size ≈ 8× mass)', Math.abs(mBig / mSmall - 8) < 0.4, `big/small mass ratio = ${(mBig / mSmall).toFixed(2)} (want ≈8)`);
check('mass = density × volume', Math.abs(mSmall - rules.propDensity * 0.125) < 1e-3 && Math.abs(mBig - rules.propDensity * 1.0) < 1e-3,
  `small=${mSmall.toFixed(3)} (=${(rules.propDensity * 0.125).toFixed(3)}), big=${mBig.toFixed(3)} (=${(rules.propDensity * 1.0).toFixed(3)})`);

// mass-tracks-disguise: a body built from a bigger footprint carries a bigger mass immediately, so a
// prop (re)built for a different disguise takes the new size's mass with no shared constant.
check('mass-tracks-disguise (bigger footprint => bigger mass)', mBurger < mTable && mTable < mFridge * 5,
  `burger ${mBurger.toFixed(3)} < table ${mTable.toFixed(2)} (small disguises stay light, big ones heavy)`);

// ---------------------------------------------------------------------------
// 2) IDENTICAL SHOT: a burger flies, a fridge barely scoots — both budge.
// ---------------------------------------------------------------------------
console.log('\n2) identical rifle shot: small prop flies, big prop resists, both budge');
const shot = rules.shotImpulse != null ? rules.shotImpulse : 1.5;
const sBurger = hitAndMeasure('burger', 'shot', shot);
const sFridge = hitAndMeasure('fridge_box', 'shot', shot);
const sTable = hitAndMeasure('kitchen_table', 'shot', shot);
console.log(`  shot Δv: burger=${sBurger.dv.toFixed(2)} fridge=${sFridge.dv.toFixed(2)} table=${sTable.dv.toFixed(2)} m/s | travel: burger=${sBurger.travel.toFixed(2)} fridge=${sFridge.travel.toFixed(2)} table=${sTable.travel.toFixed(2)} m`);
check('shot: burger gets a much bigger velocity change than a fridge', sBurger.dv > sFridge.dv * 2.5,
  `burger Δv ${sBurger.dv.toFixed(2)} vs fridge Δv ${sFridge.dv.toFixed(2)} (${(sBurger.dv / sFridge.dv).toFixed(1)}×)`);
check('shot: burger travels much farther than a fridge', sBurger.travel > sFridge.travel * 2,
  `burger ${sBurger.travel.toFixed(2)} m vs fridge ${sFridge.travel.toFixed(2)} m`);
// A shot's Δv on a fridge-sized prop is the floored ~minNudgeSpeed; friction bleeds most of it in the
// first frames, so a few mm of real travel is the visible "slight scoot" — the invariant is the non-zero
// velocity change, with travel asserted only loosely (it is friction-dependent, not a brittle absolute).
check('shot: the fridge STILL budges (never immovable)', sFridge.dv > 0.05 && sFridge.travel > 0.003,
  `fridge Δv ${sFridge.dv.toFixed(3)} m/s, travel ${sFridge.travel.toFixed(3)} m (a slight scoot)`);

// ---------------------------------------------------------------------------
// 3) IDENTICAL GRENADE FLING: same story, harder hit.
// ---------------------------------------------------------------------------
console.log('\n3) identical grenade fling: small prop flies, big prop resists, both budge');
const fling = rules.grenade.flingSpeed;
const fBurger = hitAndMeasure('burger', 'fling', fling);
const fFridge = hitAndMeasure('fridge_box', 'fling', fling);
console.log(`  fling Δv: burger=${fBurger.dv.toFixed(2)} fridge=${fFridge.dv.toFixed(2)} m/s | travel: burger=${fBurger.travel.toFixed(2)} fridge=${fFridge.travel.toFixed(2)} m`);
check('fling: burger gets a much bigger velocity change than a fridge', fBurger.dv > fFridge.dv * 3,
  `burger Δv ${fBurger.dv.toFixed(2)} vs fridge Δv ${fFridge.dv.toFixed(2)} (${(fBurger.dv / fFridge.dv).toFixed(1)}×)`);
check('fling: the fridge STILL budges (never immovable)', fFridge.dv > 0.01 && fFridge.travel > 0.01,
  `fridge Δv ${fFridge.dv.toFixed(3)} travel ${fFridge.travel.toFixed(3)} m`);

// ---------------------------------------------------------------------------
// 4) THE MINIMUM-NUDGE FLOOR: a heavy prop gets ≈ minNudgeSpeed from a strong hit (not less),
//    and a WEAK hit is NOT amplified up to the floor.
// ---------------------------------------------------------------------------
console.log('\n4) minimum-nudge floor: heavy props still scoot, but weak hits are not amplified');
const minNudge = rules.minNudgeSpeed != null ? rules.minNudgeSpeed : 0.6;
// A strong hit (shotImpulse >= minNudge) on a very heavy prop → Δv floored to ≈ minNudge (never below).
check('floor: a heavy fridge floored to ≈ minNudgeSpeed on a strong hit', sFridge.dv >= minNudge * 0.9,
  `fridge shot Δv ${sFridge.dv.toFixed(3)} ≥ ~minNudgeSpeed ${minNudge}`);
// A WEAK hit (speed well below minNudge) on the fridge must NOT be amplified up to the floor: Δv ≤ speed.
const weak = minNudge * 0.25; // clearly below the floor
const fWeak = hitAndMeasure('fridge_box', 'fling', weak);
check('floor: a weak hit is NOT amplified above its own intended speed', fWeak.dv <= weak * 1.15 + 1e-3,
  `weak fling speed=${weak} → fridge Δv ${fWeak.dv.toFixed(3)} (≤ speed, not floored up to ${minNudge})`);

// ---------------------------------------------------------------------------
// 5) HUNTERS UNTOUCHED: characterMass is unchanged by this balance build.
// ---------------------------------------------------------------------------
console.log('\n5) hunters untouched by the prop-weight change');
check('hunter mass (characterMass) is still present and unchanged (3.0)', rules.characterMass === 3.0,
  `characterMass=${rules.characterMass}`);

if (failures) {
  console.error(`\nprop-mass check FAILED (${failures} problem${failures > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nprop-mass check passed');
