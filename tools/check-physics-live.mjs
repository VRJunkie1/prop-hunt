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

// ---- 6. Shot impulse (2026-07, VRmike): a shot on a DYNAMIC prop must KICK it along the
//         shot direction (velocity changes from rest) and WAKE a sleeping body. On a guest
//         predictor (fixed props, no dynamic body) it must be a clean no-op.
{
  const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'crate', x: 5, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: true, rules, feel });
  const pb = w.propBodies[0].body;
  for (let i = 0; i < 300; i++) w.step(H); // let the crate settle (and fall asleep)
  const sleptBefore = pb.isSleeping ? pb.isSleeping() : 'n/a';
  const vBefore = pb.linvel();
  const speedBefore = Math.hypot(vBefore.x, vBefore.y, vBefore.z);
  const kick = rules.shotImpulse != null ? rules.shotImpulse : 1.5;
  const applied = w.applyShotImpulse(1, { x: 5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, kick);
  const vAfter = pb.linvel();
  const speedAfter = Math.hypot(vAfter.x, vAfter.y, vAfter.z);
  check('shot-impulse-applied', applied === true, `returned ${applied}`);
  check('shot-impulse-changes-velocity', speedAfter > speedBefore + 0.2 && vAfter.x > 0.1,
    `slept=${sleptBefore} v: ${speedBefore.toFixed(3)} -> (${vAfter.x.toFixed(2)},${vAfter.y.toFixed(2)},${vAfter.z.toFixed(2)})`);
  check('shot-impulse-wakes-body', pb.isSleeping ? pb.isSleeping() === false : true, 'body is awake after the kick');

  const w2 = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'crate', x: 5, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: false, rules, feel });
  check('shot-impulse-noop-on-guest', w2.applyShotImpulse(1, { x: 5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, kick) === false,
    'guest predictor has no dynamic body — nothing to kick');
  // Degenerate inputs on the host world are safe no-ops (never throw, never move the prop).
  check('shot-impulse-guards-bad-input',
    w.applyShotImpulse(1, { x: 5, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 }, kick) === false &&
    w.applyShotImpulse(999, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, kick) === false &&
    w.applyShotImpulse(1, { x: 5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, 0) === false,
    'zero dir / unknown prop id / zero speed => false (no-op)');
  w.destroy(); w2.destroy();
}

// ---- 7. DISGUISE COLLIDER REPLACEMENT (Part 1, 2026-07-13, VRmike). A disguised player's
//         MOVEMENT body must BE the prop's true collider shape (cuboid/cylinder/…), NOT a
//         person capsule — so they fit where the prop fits and stand where it stands. Verify:
//         (a) the movement collider's Rapier shape matches the disguise primitive; (b) there
//         is NO residual full-size capsule on that body; (c) grounding + stepping still work
//         with the non-capsule body (walks, stays grounded, foot rests on the floor); and
//         (d) un-disguising restores the base capsule.
{
  const dcat = {
    crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 },
    barrel: { shape: 'cylinder', r: 0.5, h: 1.2 },
    ball_prop: { shape: 'sphere', r: 0.6 },
    canister: { shape: 'cylinder', r: 0.22, h: 0.6 }, // a TINY prop — the pink-capsule bug case
  };
  const shapeKind = (col) => {
    const s = col.shape;
    if (!s) return 'none';
    if (s.halfExtents) return 'cuboid';
    if (s.radius != null && s.halfHeight != null) {
      if (s.type === 10 || s.type === 14) return 'cylinder';
      if (s.type === 11 || s.type === 15) return 'cone';
      return 'capsule';
    }
    if (s.radius != null) return 'ball';
    return 'other';
  };
  // Count how many colliders on a player's body are movement (non-sensor) capsules.
  const bodyShapes = (w, id) => {
    const p = w.players.get(id);
    const out = [];
    for (let i = 0; i < p.body.numColliders(); i++) {
      const col = p.body.collider(i);
      out.push({ kind: shapeKind(col), sensor: col.isSensor ? col.isSensor() : false });
    }
    return out;
  };
  const dmap = { size: 40, fixtures: [] };
  const w = new PhysicsWorld(RAPIER, dmap, [], dcat, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });

  // (a)+(b) each disguise type → its own shape as the MOVEMENT collider, no residual capsule.
  for (const [type, want] of [['crate', 'cuboid'], ['barrel', 'cylinder'], ['ball_prop', 'ball'], ['canister', 'cylinder']]) {
    w.setPlayerCollider('p', type);
    const move = w.players.get('p').collider;
    check(`disguise-move-collider-is-prop-shape (${type})`, shapeKind(move) === want, `movement collider = ${shapeKind(move)} (want ${want})`);
    // No leftover person-capsule movement collider on the body (a sensor capsule is fine — that
    // is the shot-sensor path, not built here). The only movement (non-sensor) collider is the prop shape.
    const moveCaps = bodyShapes(w, 'p').filter((s) => !s.sensor && s.kind === 'capsule').length;
    check(`disguise-no-residual-capsule (${type})`, moveCaps === 0, `${moveCaps} residual movement capsule(s)`);
  }

  // (c) grounding + walking with a NON-capsule body: disguise as the tiny canister, drop onto
  //     the floor, walk, and require the foot to rest on the floor (y≈0) and grounded to hold.
  w.setPlayerCollider('p', 'canister');
  w.setPlayerPosition('p', { x: 0, y: 0.5, z: 0 });
  let gsum = 0, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 300; i++) {
    w.setPlayerInput('p', { mx: 1, mz: 0, yaw: 0, jump: false });
    w.step(H);
    const pp = w.players.get('p');
    if (i > 120) { if (pp.grounded) gsum++; const y = w.getPlayer('p').y; minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  check('disguise-shape-grounds-stably', gsum > 150, `grounded ${gsum}/180 substeps after settle`);
  check('disguise-shape-foot-on-floor', Math.abs(minY) < 0.06 && Math.abs(maxY) < 0.06, `foot y range [${minY.toFixed(3)},${maxY.toFixed(3)}] (want ≈0)`);
  const walkedX = w.getPlayer('p').x;
  check('disguise-shape-can-walk', walkedX > 3, `walked to x=${walkedX.toFixed(2)} (open floor, 6 u/s)`);

  // (d) un-disguise → base capsule restored, offset reset.
  w.setPlayerCollider('p', null);
  const base = w.players.get('p');
  check('undisguise-restores-capsule', shapeKind(base.collider) === 'capsule' && (base.colliderOffsetY || 0) === 0,
    `collider=${shapeKind(base.collider)} offsetY=${base.colliderOffsetY}`);
  w.destroy();
}

// CONVEX-HULL DISGUISE MOVEMENT (2026-07-13, VRmike — collider overhaul option 1). A player
// disguised as a HULLED prop gets a convex-HULL movement collider (through the same
// _buildMoveColliderDesc/shapeFor path). Prove the KinematicCharacterController drives a hull
// body correctly: it grounds stably, its foot rests on the floor, and it can walk — the movement
// catch for a degenerate/inside-out hull (which would make the player fall through or wedge).
{
  const isHull = (col) => { const s = col && col.shape; return !!(s && s.vertices && !s.halfExtents && s.radius == null); };
  let hullDoc = { hulls: {} };
  try { hullDoc = JSON.parse(fs.readFileSync(new URL('../shared/config/hulls.json', import.meta.url), 'utf8')); } catch {}
  const type = 'diner_chair';
  const h = hullDoc.hulls && hullDoc.hulls[type];
  if (!h) {
    console.log(`  (skip hull-disguise movement — ${type} not in hulls.json)`);
  } else {
    const hcat = { [type]: { shape: 'box', w: 1, h: 1, d: 1, hullVerts: h.v, hullAabb: h.aabb } };
    const w = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [], hcat, { dynamicProps: true, rules, feel });
    w.addPlayer('p', { x: 0, y: 0, z: 0 });
    w.setPlayerCollider('p', type);
    check('hull-disguise-move-collider-is-hull', isHull(w.players.get('p').collider), `movement collider hull=${isHull(w.players.get('p').collider)}`);
    w.setPlayerPosition('p', { x: 0, y: 0.5, z: 0 });
    let gsum = 0, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 300; i++) {
      w.setPlayerInput('p', { mx: 1, mz: 0, yaw: 0, jump: false });
      w.step(H);
      const pp = w.players.get('p');
      if (i > 120) { if (pp.grounded) gsum++; const y = w.getPlayer('p').y; minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    check('hull-disguise-grounds-stably', gsum > 150, `grounded ${gsum}/180 substeps after settle`);
    check('hull-disguise-foot-on-floor', Math.abs(minY) < 0.08 && Math.abs(maxY) < 0.08, `foot y range [${minY.toFixed(3)},${maxY.toFixed(3)}] (want ≈0)`);
    check('hull-disguise-can-walk', w.getPlayer('p').x > 3, `walked to x=${w.getPlayer('p').x.toFixed(2)}`);
    w.destroy();
  }
}

if (failures) {
  console.error(`\nphysics live-sim check FAILED (${failures} problem${failures > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nphysics live-sim check passed');
