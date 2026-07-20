#!/usr/bin/env node
// tools/check-grenade-surface.mjs — LIVE-SIM guard for GRENADE BLAST → NEAREST SURFACE DISTANCE
// (playtest bug, VRmike, 2026-07-20). The offline tools/check-grenade.mjs proves the REFEREE wires
// surface distance into damage/fling (with a mock physics + the bounding-box fallback); THIS check
// stands up the REAL shared/physics.js PhysicsWorld and proves the Rapier query itself
// (PhysicsWorld.nearestPropSurfaceDistance / nearestPlayerSurfaceDistance) returns the true
// closest-point-on-the-collider distance — the mechanism the host actually uses in a match.
//
// AUTHORING-ONLY, never shipped. Rapier is a WASM package the page pulls from a CDN, so this tool
// needs a local dev install first (same convention as check-physics-live.mjs):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-grenade-surface.mjs
// If the package is absent it prints SKIP and exits 3 — it never fails a build it cannot run.
//
// THE BUG: a grenade "3 m from a fridge" was measured 3 m from the fridge's PIVOT, so a blast on the
// fridge's side (pivot metres away) did nothing. The fix measures to the nearest point on the actual
// collider. Asserted invariants (each an exact property of the projectPoint query, so they hold every run):
//   prop-surface-inside-zero      a blast at the prop's centre => surface distance ~0 (full damage).
//   prop-surface-off-pivot        a blast 3 m from the pivot of a 2.4 m-wide table measures to its SIDE
//                                 (~1.8 m), well under the 3 m centre distance — the exact bug, fixed.
//   prop-surface-monotonic        surface distance grows as the blast moves away from the shell.
//   prop-surface-unknown-null     an unknown prop id => null (referee then uses its box fallback).
//   player-surface-off-pivot      a player DISGUISED as the big table is measured from the table's side
//                                 too (a fridge-player is no more bomb-proof than a real fridge).

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
const map = { size: 40, fixtures: [] }; // plain arena — surface distance is map-independent
const catalog = {
  crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 },
  bigtable: { shape: 'box', w: 2.4, h: 1.0, d: 2.4 }, // half-width 1.2 m
};
const H = 1 / 60;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
console.log('grenade nearest-surface distance live-sim acceptance check');

// ---- 1. PROP surface distance (a dynamic big table). Let it settle, then query its live collider.
{
  const w = new PhysicsWorld(RAPIER, map, [{ id: 1, type: 'bigtable', x: 5, z: 0, y: 0, rot: 0 }], catalog, { dynamicProps: true, rules, feel });
  for (let i = 0; i < 120; i++) w.step(H); // settle onto the floor
  const t = w.propBodies[0].body.translation();
  const HALFW = 1.2; // bigtable half-width

  const dInside = w.nearestPropSurfaceDistance(1, { x: t.x, y: t.y, z: t.z });
  check('prop-surface-inside-zero', dInside !== null && dInside < 0.05, `centre => surface distance=${dInside == null ? 'null' : dInside.toFixed(3)} (~0 = full damage)`);

  const dSide = w.nearestPropSurfaceDistance(1, { x: t.x + 3, y: t.y, z: t.z });
  const centreDist = 3;
  check('prop-surface-off-pivot', dSide !== null && dSide > 0 && dSide < centreDist - 0.5,
    `3 m from the PIVOT measures to the SIDE: surface=${dSide == null ? 'null' : dSide.toFixed(2)} m << centre ${centreDist} m`);
  check('prop-surface-matches-halfwidth', dSide !== null && Math.abs(dSide - (centreDist - HALFW)) < 0.25,
    `surface ≈ centre − half-width = ${centreDist} − ${HALFW} = ${(centreDist - HALFW).toFixed(2)} (got ${dSide == null ? 'null' : dSide.toFixed(2)})`);

  const d2 = w.nearestPropSurfaceDistance(1, { x: t.x + 2, y: t.y, z: t.z });
  const d4 = w.nearestPropSurfaceDistance(1, { x: t.x + 4, y: t.y, z: t.z });
  check('prop-surface-monotonic', d2 !== null && d4 !== null && d2 < d4, `surface grows with distance (@2m=${d2?.toFixed(2)} < @4m=${d4?.toFixed(2)})`);

  check('prop-surface-unknown-null', w.nearestPropSurfaceDistance(999, { x: t.x + 3, y: t.y, z: t.z }) === null,
    'an unknown prop id => null (referee falls back to the bounding box)');
  w.destroy();
}

// ---- 2. PLAYER surface distance (a player DISGUISED as the big table). Its movement collider is the
//         table's true box, so a fridge/table player is measured from its side exactly like a real one.
{
  const w = new PhysicsWorld(RAPIER, map, [], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });
  w.setPlayerCollider('p', 'bigtable'); // wear the big box collider
  w.setPlayerInput('p', { mx: 0, mz: 0, yaw: 0, jump: false });
  for (let i = 0; i < 8; i++) w.step(H); // settle + populate the query BVH (projectPoint reads it)
  const p = w.players.get('p');
  const t = p.body.translation();
  const cy = t.y + (p.colliderOffsetY || 0); // the disguise box centre

  const dInside = w.nearestPlayerSurfaceDistance('p', { x: t.x, y: cy, z: t.z });
  check('player-surface-inside-zero', dInside !== null && dInside < 0.15, `centre => surface distance=${dInside == null ? 'null' : dInside.toFixed(3)} (~0 = full damage)`);

  const dSide = w.nearestPlayerSurfaceDistance('p', { x: t.x + 3, y: cy, z: t.z });
  check('player-surface-off-pivot', dSide !== null && dSide > 0 && dSide < 3 - 0.5,
    `a table-DISGUISED player is measured from the box side (surface=${dSide == null ? 'null' : dSide.toFixed(2)} m << centre 3 m) — no bomb-proof pivot`);

  check('player-surface-unknown-null', w.nearestPlayerSurfaceDistance('nobody', { x: 0, y: 0, z: 0 }) === null,
    'an unknown player id => null (referee falls back to the bounding box)');
  w.destroy();
}

console.log(failures ? `\nFAILED (${failures})` : '\nAll grenade surface-distance live checks passed.');
// Set the exit CODE and let Node drain naturally rather than a hard process.exit() — the Rapier WASM
// runtime can still be closing async handles at that instant (a Windows libuv UV_HANDLE_CLOSING abort),
// which would mask a clean pass with a spurious crash code.
process.exitCode = failures ? 1 : 0;
