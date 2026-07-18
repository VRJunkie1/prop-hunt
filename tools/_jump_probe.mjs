#!/usr/bin/env node
// tools/_jump_probe.mjs — TEMPORARY instrumentation harness for the PROP JUMP bug
// (VRmike, #devbot 2026-07-18). NOT a build gate; a scratch probe used to root-cause the
// "standing jump is a 5-inch hop instead of a 5-foot jump, but works against a wall".
// Stands up the REAL shared/physics.js PhysicsWorld and logs the jump frame-by-frame.
//   npm i --no-save @dimforge/rapier3d-compat@0.14.0 ; node tools/_jump_probe.mjs
let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; }
catch { console.log('SKIP: rapier not installed'); process.exit(3); }
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const H = 1 / 60;

const catalog = {
  canister: { shape: 'cylinder', r: 0.22, h: 0.6 },     // tiny (soda can)
  crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 },       // medium
  shelf: { shape: 'box', w: 1.8, h: 2.2, d: 0.5 },       // large/tall
};

// Settle a player on the floor, then hold jump for `holdTicks` (physics substeps) and let
// it rise+fall. Returns { peak, log } where peak is the max foot-height reached.
function jumpTest({ disguise = null, wallAt = null, holdSubsteps = 20, label, move = null }) {
  const map = { size: 40, fixtures: wallAt ? [wallAt] : [] };
  const w = new PhysicsWorld(RAPIER, map, [], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });
  if (disguise) w.setPlayerCollider('p', disguise);
  // settle
  for (let i = 0; i < 120; i++) { w.setPlayerInput('p', { mx: 0, mz: 0, yaw: 0, jump: false }); w.step(H); }
  const restY = w.getPlayer('p').y;
  let peak = -Infinity;
  const log = [];
  const total = 240;
  for (let i = 0; i < total; i++) {
    const jump = i < holdSubsteps;
    // If testing "against a wall", also walk into it (+x) so there is a side contact.
    const mx = move != null ? move : (wallAt ? 1 : 0);
    w.setPlayerInput('p', { mx, mz: 0, yaw: 0, jump });
    w.step(H);
    const pl = w.getPlayer('p');
    const pp = w.players.get('p');
    peak = Math.max(peak, pl.y);
    if (i < 14) log.push(`  t${String(i).padStart(2)} jump=${jump ? 1 : 0} grounded=${pp.grounded ? 1 : 0} vy=${pp.vy.toFixed(3).padStart(7)} y=${pl.y.toFixed(4)}`);
  }
  const height = peak - restY;
  console.log(`\n== ${label} ==  restY=${restY.toFixed(4)}  PEAK ABOVE REST = ${height.toFixed(4)} m  (${(height * 39.37).toFixed(1)} in)`);
  console.log(log.join('\n'));
  w.destroy();
  return height;
}

console.log('JUMP PROBE — gravity=%s jumpSpeed=%s moveSpeed=%s', rules.gravity, rules.jumpSpeed, rules.moveSpeed);
// Theoretical full jump height with continuous integration: v^2/(2g) = 8^2/(2*22) = 1.45 m
console.log('theoretical peak = jumpSpeed^2/(2*gravity) = %s m', (rules.jumpSpeed ** 2 / (2 * rules.gravity)).toFixed(3));

// The co-sim narrowed it to DISGUISED + MOVING. Isolate here in pure physics (no netcode):
jumpTest({ label: 'crate disguise, STANDING (mx=0)', disguise: 'crate', holdSubsteps: 20, move: 0 });
jumpTest({ label: 'crate disguise, MOVING (mx=1)', disguise: 'crate', holdSubsteps: 20, move: 1 });
jumpTest({ label: 'UNDISGUISED, MOVING (mx=1)', holdSubsteps: 20, move: 1 });
jumpTest({ label: 'canister disguise, MOVING (mx=1)', disguise: 'canister', holdSubsteps: 20, move: 1 });
jumpTest({ label: 'shelf disguise, MOVING (mx=1)', disguise: 'shelf', holdSubsteps: 20, move: 1 });
