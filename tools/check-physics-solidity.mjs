#!/usr/bin/env node
// LIVE physics-solidity guard — solidity pass #3. AUTHORING-ONLY: never imported by
// the page or shipped to a browser (like the other tools/ checks). This is the SIBLING
// of tools/check-blindfold.mjs and tools/check-physics-feel.mjs, but where those do
// STATIC code/config assertions, this one stands up the REAL shared PhysicsWorld and
// runs three live simulations — the exact reports this pass targets:
//
//   A. a player-controlled prop CANNOT penetrate / hide inside a world prop;
//   B. a player at JUMP SPEED cannot cross a thin wall panel;
//   C. a player NEVER ends a run below floor level.
//
// Run:  node tools/check-physics-solidity.mjs
//
// RAPIER IN NODE — read this before you conclude "it's broken". shared/physics.js pulls
// Rapier as an ESM module from a CDN URL (great in a browser, the game's only runtime).
// Node cannot `import()` an https URL without a loader, so this tool ALSO tries a local
// dev install first. To run it headless, from the repo root:
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
// (dev-only — it is NOT added to the shipped app, which keeps using the CDN.) If neither
// path yields Rapier, the tool prints a clear SKIP and exits 3 (inconclusive, not a
// failure) so CI can tell "couldn't run" from "ran and failed".
//
// Exit codes: 0 = all pass, 1 = a solidity test FAILED, 3 = could not load Rapier.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PhysicsWorld, loadRapier } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (name) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', name), 'utf8'));
const rules = cfg('rules.json');
const feel = cfg('physics-feel.json');

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

// Try a local dev install first (npm i --no-save @dimforge/rapier3d-compat), then the
// game's CDN path (loadRapier). Either yields an inited RAPIER namespace, or we skip.
async function getRapier() {
  try {
    const mod = await import('@dimforge/rapier3d-compat');
    const R = mod.default || mod;
    await R.init();
    return R;
  } catch {
    /* not installed locally — fall through to the CDN path the game uses */
  }
  try {
    return await loadRapier();
  } catch {
    return null;
  }
}

// Forward/right convention matches the sim: yaw 0, mz=-1 drives toward +z.
const DRIVE_PLUS_Z = { mx: 0, mz: -1, yaw: 0 };

function makeWorld(RAPIER, { fixtures = [], props = [], catalog = {} }) {
  const map = { size: 48, fixtures };
  const merged = { ...catalog };
  return new PhysicsWorld(RAPIER, map, props, merged, { dynamicProps: true, rules, feel });
}

// Step the world, driving player `id`, recording min y and max z reached.
function run(world, id, input, steps) {
  const dt = 1 / 60;
  let minY = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < steps; i++) {
    world.setPlayerInput(id, input);
    world.step(dt);
    const p = world.getPlayer(id);
    if (p) {
      if (p.y < minY) minY = p.y;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  return { pose: world.getPlayer(id), minY, maxZ };
}

async function main() {
  console.log('physics solidity check (live sim)');
  const RAPIER = await getRapier();
  if (!RAPIER) {
    console.log('\n  ⚠ SKIPPED: Rapier not available in this runtime.');
    console.log('    Install it dev-only, then re-run:  npm i --no-save @dimforge/rapier3d-compat@0.14.0');
    console.log('    (The shipped game loads Rapier from a CDN and is unaffected.)');
    process.exit(3);
  }

  // ---- A. prop-vs-prop: a disguised player must REST AGAINST a world prop, not sink in.
  // A solid, immovable world block so the test measures blocking, not shove-and-follow.
  {
    const catalog = {
      block: { shape: 'box', w: 1.5, h: 1.5, d: 1.5, static: true },
      // Real disguise footprint from props.json (a big crate — the worst case for the
      // old fixed tiny capsule).
      food_crate: { shape: 'box', w: 1.5, h: 0.72, d: 1.5 },
    };
    const fixtures = [{ type: 'block', x: 0, z: 3 }];
    const world = makeWorld(RAPIER, { fixtures, catalog });
    world.addPlayer('P', { x: 0, z: 0 });
    world.setPlayerCollider('P', 'food_crate'); // grow the capsule to the disguise
    const { pose } = run(world, 'P', DRIVE_PLUS_Z, 200);
    // Expected stand-off: disguise capsule radius (0.55, from disguiseColliderMaxRadius)
    // + block half-extent (0.75) = 1.30, minus the controller offset + a little slack.
    const capR = Math.min(rules.disguiseColliderMaxRadius ?? 0.55, 0.75);
    const blockHalf = 0.75;
    const gap = pose.z; // block is at z=3; player pushed from z<3 toward it
    const nearFace = 3 - blockHalf; // z of the block's near face = 2.25
    const surfaceGap = nearFace - (gap + capR); // capsule surface to block face; >=~0 solid
    ok(
      surfaceGap > -(0.02 + 0.08),
      `A. disguised prop rests against world prop (capsule surface gap ${surfaceGap.toFixed(3)}m, no deep penetration)`
    );
    ok(pose.z < nearFace + 0.05, `A. disguised prop did not pass into the world prop (z=${pose.z.toFixed(2)} < ${nearFace})`);
    world.destroy();
  }

  // ---- B. wall tunnel: a player at jump speed must NOT cross a thin wall panel.
  {
    const catalog = { panel: { shape: 'box', w: 6, h: 3, d: 0.4, static: true } };
    const fixtures = [{ type: 'panel', x: 0, z: 3 }];
    const world = makeWorld(RAPIER, { fixtures, catalog });
    world.addPlayer('P', { x: 0, z: 0 });
    const { maxZ } = run(world, 'P', { ...DRIVE_PLUS_Z, jump: true }, 240);
    // The panel centre is z=3; a solid wall stops the capsule near z ~2.4 (near face
    // 2.8 after the min-thickness grow, minus radius). It must never reach the far side.
    ok(maxZ < 3, `B. player at jump speed never crossed the wall (max z reached ${maxZ.toFixed(2)} < 3)`);
    world.destroy();
  }

  // ---- C. floor: a player never ends up below floor level (drop + wall-slam runs).
  {
    // C1: hard drop onto the floor from 5m — must settle at ~0, never sink below.
    const world = makeWorld(RAPIER, {});
    world.addPlayer('P', { x: 0, y: 5, z: 0 });
    const { pose, minY } = run(world, 'P', { mx: 0, mz: 0, yaw: 0 }, 200);
    ok(minY > -0.5, `C1. player never dropped through the floor while falling (min y ${minY.toFixed(3)})`);
    ok(Math.abs(pose.y) < 0.3, `C1. player settled at floor level (final y ${pose.y.toFixed(3)} ≈ 0)`);
    world.destroy();
  }
  {
    // C2: slamming a wall at speed must not knock the player below the floor either.
    const catalog = { panel: { shape: 'box', w: 6, h: 3, d: 0.4, static: true } };
    const world = makeWorld(RAPIER, { fixtures: [{ type: 'panel', x: 0, z: 2 }], catalog });
    world.addPlayer('P', { x: 0, z: 0 });
    const { minY } = run(world, 'P', { ...DRIVE_PLUS_Z, jump: true }, 240);
    ok(minY > -0.5, `C2. wall slam at jump speed never put the player below the floor (min y ${minY.toFixed(3)})`);
    world.destroy();
  }

  if (fails) {
    console.error(`\nphysics solidity check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
    process.exit(1);
  }
  console.log('\nphysics solidity check passed');
}

main().catch((e) => {
  console.error('physics solidity check ERRORED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
