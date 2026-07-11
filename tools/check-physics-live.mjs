#!/usr/bin/env node
// tools/check-physics-live.mjs — LIVE-SIM regression guard for the player-collision bugs
// fixed in physics pass #5 (2026-07-11 playtest: bobbing while standing on props, walking
// into/through props, hiding inside a larger prop, the out-of-arena perimeter "glitched
// mode"). Unlike the static geometry checks (check-physics.mjs / check-physics-solidity.mjs),
// this stands up the REAL shared/physics.js PhysicsWorld and SIMULATES the reported
// scenarios with PASS/FAIL assertions — the checks that used to require a live playtest.
//
// AUTHORING-ONLY, never shipped. Rapier is a WASM package the page pulls from a CDN, so
// this tool needs a local dev install first (not saved to package.json):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-physics-live.mjs
// If the package is absent the tool prints SKIP and exits 3 (same convention the old
// solidity check used) — it never fails a build it cannot run.
//
// CHAOS CAVEAT: Rapier runs are not bit-reproducible across processes, so scenario
// outcomes (how a shoved prop tumbles) vary run to run. Every assertion here is an
// INVARIANT the pass-#5 code enforces actively every substep (push-out, recovery clamp,
// ground stick), so they hold in every run of the fixed engine — while the pre-pass-#5
// engine violated each of them reproducibly:
//   embedded-player-recovers   a capsule teleported inside a prop stayed inside forever
//                              (the hide-inside-a-prop bug; "fix #5 Bug B" was dead code).
//   bulldoze-no-penetration    shoving a big prop, TRUE capsule-to-hull penetration
//                              reached a full capsule radius and the capsule could end
//                              up across/atop the collapsing prop.
//   grounded-stable-on-prop    standing still on a dynamic crate, computedGrounded()
//                              flipped ~every other substep (593×/600 — the bob + flaky
//                              jump through 15 Hz quantised snapshots).
//   prop-stays-above-floor     the shoved prop was driven INTO the ground slab (centre
//                              y=-0.56) and pinned there by the kinematic capsule.
//   escape-from-inside-wall    anchor-poisoning guard: a capsule starting inside a
//                              boundary wall must still walk free.
//   predict-prop-sync          a prediction world's fixed prop colliders must follow
//                              live transforms (they used to stay at spawn forever).

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
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const map = { size: 40, fixtures: [] }; // plain arena: these bugs are map-independent
const catalog = {
  crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 },
  bigtable: { shape: 'box', w: 2.4, h: 1.0, d: 2.4 },
};
const H = 1 / 60;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
// TRUE capsule-vs-prop penetration (m): capsule radius minus the closest distance from
// any capsule-axis sample point to the nearest PROP surface — the same projectPoint the
// engine's own push-out uses, so guard and engine measure identically. Negative = clear.
function propPenetration(w, p) {
  const t = p.body.translation();
  const propsOnly = (col) => w._propHandles.has(col.handle);
  let minD = Infinity;
  for (const oy of [-p.half, 0, p.half]) {
    const pt = { x: t.x, y: t.y + oy, z: t.z };
    const proj = w.world.projectPoint(pt, false, undefined, undefined, undefined, undefined, propsOnly);
    if (!proj || !proj.point) continue;
    const d = Math.hypot(proj.point.x - pt.x, proj.point.y - pt.y, proj.point.z - pt.z) * (proj.isInside ? -1 : 1);
    minD = Math.min(minD, d);
  }
  return p.radius - minD;
}
console.log('physics live-sim acceptance check');

// ---- 1. Embedded-player recovery (the direct guard on the pass-#5 push-out). Teleport
//         the capsule INSIDE a big prop — exactly what a bad reconcile or a mid-shove
//         overlap used to leave behind — and require it OUT within 2 s, on both the
//         host's world (dynamic props) and a prediction world (fixed props), from both
//         a deep-centre start (must surface on top) and a near-face start (must eject
//         out the face). Pre-pass-#5: stayed embedded forever in all four cases.
for (const dyn of [true, false]) {
  for (const embedX of [4.6, 4.1]) {
    const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'bigtable', x: 5, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: dyn, rules, feel });
    w.addPlayer('p', { x: 0, y: 0, z: 0 });
    w.setPlayerPosition('p', { x: embedX, y: 0, z: 0 });
    w.setPlayerInput('p', { mx: 0, mz: 0, yaw: 0, jump: false });
    for (let i = 0; i < 120; i++) w.step(H);
    const pen = propPenetration(w, w.players.get('p'));
    const fin = w.getPlayer('p');
    check(`embedded-player-recovers (${dyn ? 'host' : 'predict'}, embed@${embedX})`, pen < 0.06,
      `penetration=${pen.toFixed(3)} final=(${fin.x.toFixed(2)},${fin.y.toFixed(2)},${fin.z.toFixed(2)})`);
    w.destroy();
  }
}

// ---- 2. Bulldoze a free-standing big prop for 5.5 s: TRUE penetration must stay under
//         the push-out's working band (skin 0.03 + one substep of approach 0.1) at every
//         substep. Riding over or sliding around the tumbling prop is legal; sinking
//         into its volume is the bug.
{
  const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'bigtable', x: 5, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });
  const p = w.players.get('p');
  const pb = w.propBodies[0].body;
  w.setPlayerInput('p', { mx: 1, mz: 0, yaw: 0, jump: false });
  let maxPen = 0, propMinY = Infinity;
  for (let i = 0; i < 330; i++) {
    w.step(H);
    maxPen = Math.max(maxPen, propPenetration(w, p));
    propMinY = Math.min(propMinY, pb.translation().y);
  }
  check('bulldoze-no-penetration', maxPen < 0.15, `max true penetration=${maxPen.toFixed(3)}`);
  check('prop-stays-above-floor', propMinY > 0.3, `prop centre min y=${propMinY.toFixed(2)} (rest 0.5; <0 = inside ground slab)`);
  w.destroy();
}

// ---- 3. Stand still on a dynamic crate for 8 s: grounded must be stable and the player
//         must not drift vertically (the bob + flaky jump).
{
  const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'crate', x: 0, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 1.2, z: 0 });
  let flips = 0, prev = null, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 600; i++) {
    w.setPlayerInput('p', { mx: 0, mz: 0, yaw: 0, jump: false });
    w.step(H);
    const g = w.players.get('p').grounded;
    if (i > 120) {
      if (prev !== null && g !== prev) flips++;
      const y = w.getPlayer('p').y;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    prev = g;
  }
  check('grounded-stable-on-prop', flips < 20, `grounded flips in 8s standing still: ${flips}`);
  check('no-vertical-drift-on-prop', maxY - minY < 0.05, `y amplitude=${(maxY - minY).toFixed(3)}`);
  w.destroy();
}

// ---- 4. Wall-escape recovery: a capsule that somehow starts INSIDE the boundary wall
//         must be able to walk back to the middle (static depenetration anchor guard).
{
  const w = new PhysicsWorld(RAPIER, map, [], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 19.9, y: 0, z: 0 }); // wall slab spans x 19.5..21.0
  w.setPlayerInput('p', { mx: -1, mz: 0, yaw: 0, jump: false });
  for (let i = 0; i < 300; i++) w.step(H);
  const p = w.getPlayer('p');
  check('escape-from-inside-wall', p.x < 19.0, `x=${p.x.toFixed(2)} after 5s walking toward centre`);
  w.destroy();
}

// ---- 5. Guest predictor prop sync: fixed prop colliders must follow live transforms
//         (syncPropTransforms) so local prediction collides where props actually are.
{
  const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'bigtable', x: 5, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: false, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });
  // Host says the table was shoved out of the way: local movement must now pass x=5...
  w.syncPropTransforms([{ id: 1, x: 12, y: 0.5, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }]);
  w.setPlayerInput('p', { mx: 1, mz: 0, yaw: 0, jump: false });
  for (let i = 0; i < 180; i++) w.step(H); // 3 s @ 6 u/s ≈ 18 m unobstructed
  const x = w.getPlayer('p').x;
  check('predict-prop-sync', x > 6.5 && x < 10.8 - 0.2, `x=${x.toFixed(2)} (must pass 5, stop before the new face at 10.8)`);
  w.destroy();
}

if (failures) {
  console.error(`\nphysics live-sim check FAILED (${failures} problem${failures > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nphysics live-sim check passed');
