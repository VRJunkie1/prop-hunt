#!/usr/bin/env node
// tools/check-jump.mjs — STANDING/MOVING JUMP-HEIGHT regression guard (VRmike, #devbot
// 2026-07-18: "prop jump broken — 5-inch hop instead of a full jump, but works against a
// wall"). Stands up the REAL shared/physics.js PhysicsWorld and measures the peak height a
// player reaches from a standing jump AND a moving jump, for EVERY disguise body size plus
// the undisguised hunter, and asserts each clears the full-jump bar.
//
// ROOT CAUSE this guards (fixed 2026-07-18): a disguised player's DEPENETRATION proxy capsule
// (radius/half in _buildMoveColliderDesc) is a bounding-capsule approximation for the anti-tunnel
// failsafe. For a WIDE-SHORT disguise (crate 1.5w × 1.0h → horizontal half 0.75 > half-height 0.5)
// the old `radius = min(hx,hz)` made a fat sphere whose BOTTOM sat ~0.2 m BELOW the foot/floor.
// While the body was perfectly still Rapier's broad-phase was stale and missed the overlap (jump
// worked); the instant the body MOVED the query refreshed, _isPenetrating fired, the failsafe
// snapped the body back and ZEROED vy — the jump collapsed to a single substep (~0.13 m = 5 in).
// Fix: cap the proxy radius at the shape half-height so the capsule stays inscribed in the shape
// and never dips below the foot. This guard fails if that regresses (or any other jump-killer).
//
// AUTHORING-ONLY, never shipped. Rapier is a browser-CDN WASM package, so run a dev install first:
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0 ; node tools/check-jump.mjs
// Absent => prints SKIP and exits 3 (same convention as the other live-sim checks).

let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; }
catch { console.log('SKIP: @dimforge/rapier3d-compat not installed. Run: npm i --no-save @dimforge/rapier3d-compat@0.14.0'); process.exit(3); }
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();

const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const H = 1 / 60;

// Disguise bodies spanning the size range a prop can wear. The crate/counter (WIDE & SHORT) are
// the exact shapes that broke; canister (tall-narrow) and shelf (tall) never did — all must pass.
const catalog = {
  canister: { shape: 'cylinder', r: 0.22, h: 0.6 },   // tiny soda-can — tall-narrow
  crate:    { shape: 'box', w: 1.5, h: 1.0, d: 1.5 },  // medium — WIDE-SHORT (the failure case)
  counter:  { shape: 'box', w: 1.5, h: 0.75, d: 0.78 },// low counter — EVEN wider vs its height
  table:    { shape: 'box', w: 2.25, h: 0.75, d: 1.5 },// big table — wide-short
  shelf:    { shape: 'box', w: 1.8, h: 2.2, d: 0.5 },  // tall shelf
};

// Full jump = jumpSpeed²/(2·gravity). Require the peak to clear most of it (a broken jump collapses
// to one substep ≈ jumpSpeed/60 ≈ 0.13 m, far under this bar, so the threshold is unambiguous).
const jumpSpeed = rules.jumpSpeed != null ? rules.jumpSpeed : 8;
const gravity = rules.gravity != null ? rules.gravity : 22;
const FULL = jumpSpeed * jumpSpeed / (2 * gravity);
const MIN_JUMP = FULL * 0.9; // 90% of the analytic peak (substep discretisation loses a hair)

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// Settle a player (optionally disguised), then hold jump while STANDING (move=0) or MOVING
// (move=1, walking horizontally) and return the peak foot-height above the resting height.
// Optional brokenProxy forces the pre-fix proxy dims to PROVE this guard bites (self-test).
function jumpHeight({ disguise = null, move = 0, brokenProxy = false }) {
  const w = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });
  if (disguise) w.setPlayerCollider('p', disguise);
  const p = w.players.get('p');
  if (brokenProxy) { p.radius = Math.max(0.05, Math.min(p.radius * 0 + 0.75, 0.75)); p.half = 0.05; } // old crate dims
  for (let i = 0; i < 90; i++) { w.setPlayerInput('p', { mx: 0, mz: 0, yaw: 0, jump: false }); w.step(H); }
  const restY = w.getPlayer('p').y;
  let peak = -Infinity;
  for (let i = 0; i < 240; i++) {
    w.setPlayerInput('p', { mx: move, mz: 0, yaw: 0, jump: i < 40 }); // hold ~0.66 s (well past the apex)
    w.step(H);
    peak = Math.max(peak, w.getPlayer('p').y);
  }
  w.destroy();
  return peak - restY;
}

console.log(`jump-height check — jumpSpeed=${jumpSpeed} gravity=${gravity}  full≈${FULL.toFixed(2)}m, require ≥${MIN_JUMP.toFixed(2)}m\n`);

// The hunter (undisguised) and every disguise size must reach full height BOTH standing and moving.
for (const disguise of [null, 'canister', 'crate', 'counter', 'table', 'shelf']) {
  const label = disguise || 'hunter (undisguised)';
  for (const move of [0, 1]) {
    const h = jumpHeight({ disguise, move });
    check(`${label.padEnd(20)} ${move ? 'MOVING ' : 'STANDING'} jump reaches full height`, h >= MIN_JUMP,
      `peak ${h.toFixed(3)}m (${(h * 39.37).toFixed(1)} in)`);
  }
}

// SELF-TEST: the guard must actually bite. Re-inject the pre-fix (over-fat) crate proxy and confirm
// the MOVING jump collapses — proving this check measures the real failure mechanism, not nothing.
console.log('');
const broken = jumpHeight({ disguise: 'crate', move: 1, brokenProxy: true });
check('SELF-TEST: pre-fix proxy DOES collapse the moving jump (guard bites)', broken < 0.5,
  `broken-proxy moving peak ${broken.toFixed(3)}m (< 0.5 confirms the guard would catch a regression)`);

if (failures) {
  console.error(`\njump-height check FAILED (${failures} problem${failures > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\njump-height check passed');
