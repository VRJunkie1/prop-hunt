#!/usr/bin/env node
// Offline acceptance check for the physics FEEL config. AUTHORING-ONLY — never
// imported by the page or shipped to a browser (like tools/measure-glbs.mjs). Run
// it from a shell when a physics-feel change lands:  node tools/check-physics-feel.mjs
//
// FEEL cannot be verified headless (it's how the game *feels* in a live playtest).
// What CAN be verified headless is the invariant that keeps a live match from
// desyncing: the host's authoritative world and every client's prediction world must
// derive the *same* feel values from the ONE physics-feel.json — a future mismatch
// should fail here, not rubber-band a real match. This mirrors both sims by running
// the SAME shared resolveFeel() the same way they do, and also range-checks the
// dials so a fat-fingered value (a stray restitution, a 0 iteration count) is caught.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveFeel } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, '..', 'shared', 'config', 'physics-feel.json');

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error('  ✗ ' + msg);
    fails++;
  } else {
    console.log('  ✓ ' + msg);
  }
};

console.log('physics-feel acceptance check');

const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));

// 1) The two sims derive IDENTICAL feel from the one config. Both call resolveFeel
//    with the same object; simulate host + client and deep-compare.
const host = resolveFeel(raw); // referee.js: PhysicsWorld({ feel: config.feel })
const client = resolveFeel(raw); // main.js buildPredict: PhysicsWorld({ feel: state.cfg.feel })
ok(JSON.stringify(host) === JSON.stringify(client), 'host and client derive identical feel (no desync)');

// 2) A missing/empty config must still resolve to sane rigid defaults (graceful
//    degrade — physics.js is null-safe).
const defaults = resolveFeel(undefined);
ok(defaults.restitution === 0, 'default restitution is 0 (nothing bounces)');
ok(defaults.numSolverIterations >= 4, 'default solver iterations >= Rapier default');

// 3) Range-check the shipped dials.
ok(host.restitution === 0, `restitution is 0 (got ${host.restitution})`);
ok(host.numSolverIterations >= 8 && host.numSolverIterations <= 16, `solver iterations in 8..16 (got ${host.numSolverIterations})`);
ok(host.numAdditionalFrictionIterations >= 0 && host.numAdditionalFrictionIterations <= 16, `friction iterations sane (got ${host.numAdditionalFrictionIterations})`);
ok(host.propLinearDamping >= 0.2 && host.propLinearDamping <= 0.8, `prop linear damping in 0.2..0.8 (got ${host.propLinearDamping})`);
ok(host.propAngularDamping >= 0.2 && host.propAngularDamping <= 0.8, `prop angular damping in 0.2..0.8 (got ${host.propAngularDamping})`);

if (fails) {
  console.error(`\nphysics-feel check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nphysics-feel check passed');
