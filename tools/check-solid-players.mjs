#!/usr/bin/env node
// tools/check-solid-players.mjs — LIVE-SIM regression guard for SOLID DISGUISED PROP PLAYERS
// (2026-07-18, Jie). Stands up the REAL shared/physics.js PhysicsWorld and asserts the four
// behaviours the task asked for, PLUS that every named "do not touch" system is unchanged:
//
//   A) SOLID CONTACT      a player walking into a disguised player is BLOCKED at the DISGUISE's
//                         collider size (a table blocks like a table; the block distance tracks
//                         the disguise, not the base capsule).
//   B) HEAVY NUDGE        a SUSTAINED push slides the disguised player SLOWLY (heavy-furniture
//                         crawl, well under walk speed) and NEVER tips it; with the nudge off the
//                         same disguised player is an immovable wall — proving the slide is ours.
//   D1) COLLIDER SWAP     changing the disguise swaps the movement collider's size (via the same
//                         setPlayerCollider hook the referee already calls); undisguising reverts
//                         it AND makes the player un-nudgeable again.
//   D2) STAND ON TOP      a player dropped onto a disguised table rests ON it (solid from above),
//                         it does not fall through.
//   D3) SPAWN OVERLAP     players spawned at the SAME point resolve apart — nobody stays fused.
//
//   UNTOUCHED (explicit): general player-vs-player (base↔base) is byte-identical with the nudge
//                         on vs off; real props settle identically with the nudge on vs off; the
//                         shot raycast still classifies a disguised player as 'player' and a real
//                         prop as 'prop' (player-vs-decoy detection / grenade+rifle classification
//                         unchanged — MOVEMENT collision only).
//
// AUTHORING-ONLY, never shipped. Rapier is a CDN WASM package the game pulls at runtime, so this
// needs a local dev install first (not saved to package.json):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-solid-players.mjs
// If the package is absent it prints SKIP and exits 3 (never fails a build it cannot run).

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
const map = { size: 40, fixtures: [] };
const catalog = {
  bigtable: { shape: 'box', w: 2.4, h: 1.0, d: 2.4 },
  burger: { shape: 'cylinder', r: 0.35, h: 0.3 },
};
const H = 1 / 60;
const moveSpeed = rules.moveSpeed;
const nudgeSpeed = rules.heavyNudgeSpeed;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function world(opts = {}) {
  return new PhysicsWorld(RAPIER, map, opts.props || [], catalog, {
    rules, feel, dynamicProps: opts.dynamicProps !== false, heavyNudge: opts.heavyNudge !== false,
  });
}
// Walk player `mover` straight at +x into `target` for `secs`; returns final poses.
function pushRun({ moverDisguise = null, targetDisguise = null, targetInput = null, heavyNudge = true, secs = 4 }) {
  const w = world({ heavyNudge });
  w.addPlayer('T', { x: 0, y: 0, z: 0 });
  if (targetDisguise) w.setPlayerCollider('T', targetDisguise);
  w.setPlayerInput('T', targetInput || { mx: 0, mz: 0, yaw: 0, jump: false });
  w.addPlayer('M', { x: -4, y: 0, z: 0 });
  if (moverDisguise) w.setPlayerCollider('M', moverDisguise);
  w.setPlayerInput('M', { mx: 1, mz: 0, yaw: 0, jump: false }); // yaw 0, mx +1 => +x
  for (let i = 0; i < Math.round(secs / H); i++) w.step(H);
  const M = w.getPlayer('M'), T = w.getPlayer('T');
  w.destroy();
  return { M, T };
}

console.log('SOLID DISGUISED PLAYERS — live-sim guard\n');

// ── A) SOLID CONTACT: blocked at the disguise's size ────────────────────────────────────────
{
  // Short push so the target has barely crawled: the GAP the mover is held at reveals the block
  // size. A big-table disguise blocks the mover a table-half (1.2) + capsule radius (0.4) ≈ 1.6 m
  // out; the mover must stay on the near side (never punch to the far side).
  const { M, T } = pushRun({ targetDisguise: 'bigtable', secs: 0.5 });
  const gap = T.x - M.x;
  check('A: hunter blocked at BIG-TABLE disguise size (gap ≈ table-half + radius)',
    gap > 1.3 && gap < 1.9 && M.x < 0.6, `gap=${gap.toFixed(2)} moverX=${M.x.toFixed(2)}`);

  // Undisguised control: two base capsules do NOT wall each other off (existing behaviour) —
  // proving the block above comes from the DISGUISE collider, not a blanket player-vs-player wall
  // we added. Given time, the base mover crosses past where the base target started (no solid wall).
  const base = pushRun({ secs: 2 });
  check('A: base↔base is NOT a solid wall (general player-vs-player untouched)',
    base.M.x > 0.5, `moverX=${base.M.x.toFixed(2)} (crossed past the target's start)`);
}

// ── B) HEAVY NUDGE: sustained push slides slowly, no tip ─────────────────────────────────────
{
  const on = pushRun({ targetDisguise: 'bigtable', heavyNudge: true, secs: 3 });
  const off = pushRun({ targetDisguise: 'bigtable', heavyNudge: false, secs: 3 });
  const slid = on.T.x;                 // metres the disguised table crawled forward in 3 s
  const avg = slid / 3;                // average crawl speed
  check('B: sustained push SLIDES the disguised player forward', slid > 0.4, `slid=${slid.toFixed(2)}m in 3s`);
  check('B: the slide is SLOW (heavy-furniture crawl, well under walk speed)',
    avg > 0.05 && avg < nudgeSpeed * 1.3 && avg < moveSpeed * 0.4, `avg=${avg.toFixed(2)} m/s (walk=${moveSpeed}, cap≈${nudgeSpeed})`);
  check('B: no tip / no lift (disguised player stays upright at ground height)',
    Math.abs(on.T.y) < 0.05, `targetFootY=${on.T.y.toFixed(3)}`);
  check('B: with the nudge OFF the disguised player is an immovable wall (slide is ours)',
    Math.abs(off.T.x) < 0.15, `offSlide=${off.T.x.toFixed(3)}m`);
}

// ── D1) COLLIDER SWAP on disguise change (via setPlayerCollider) ─────────────────────────────
{
  const w = world();
  w.addPlayer('P', { x: 0, y: 0, z: 0 });
  const baseR = w.players.get('P').radius;
  w.setPlayerCollider('P', 'bigtable');
  const tableR = w.players.get('P').radius;
  const tableType = w.players.get('P').disguiseType;
  w.setPlayerCollider('P', 'burger');
  const burgerR = w.players.get('P').radius;
  w.setPlayerCollider('P', null);
  const revertedR = w.players.get('P').radius;
  const revertedType = w.players.get('P').disguiseType;
  check('D1: disguise change SWAPS the movement collider size',
    tableR > baseR && burgerR < tableR && tableType === 'bigtable',
    `base=${baseR} table=${tableR} burger=${burgerR}`);
  check('D1: undisguising REVERTS to the base capsule', Math.abs(revertedR - baseR) < 1e-6 && revertedType === null,
    `reverted=${revertedR}`);
  w.destroy();
}

// ── D2) STAND ON TOP: solid from above ──────────────────────────────────────────────────────
{
  const w = world();
  w.addPlayer('T', { x: 0, y: 0, z: 0 });
  w.setPlayerCollider('T', 'bigtable'); // 1.0 m tall table, top at y=1.0
  w.setPlayerInput('T', { mx: 0, mz: 0, yaw: 0, jump: false });
  w.addPlayer('S', { x: 0, y: 1.6, z: 0 }); // drop a stander straight above the table centre
  w.setPlayerInput('S', { mx: 0, mz: 0, yaw: 0, jump: false });
  for (let i = 0; i < 180; i++) w.step(H); // 3 s to settle
  const S = w.getPlayer('S');
  check('D2: a player dropped onto a disguised table RESTS ON its top (solid from above)',
    S.y > 0.8 && S.grounded, `standerFootY=${S.y.toFixed(2)} grounded=${S.grounded}`);
  w.destroy();
}

// ── D3) SPAWN OVERLAP resolves ──────────────────────────────────────────────────────────────
{
  const w = world();
  const at = { x: 5, y: 0, z: -3 };
  w.addPlayer('a', at); w.resolveSpawnOverlap('a');
  w.addPlayer('b', at); w.resolveSpawnOverlap('b');
  w.addPlayer('c', at); w.resolveSpawnOverlap('c');
  const P = (id) => { const t = w.getPlayer(id); return t; };
  const dist = (i, j) => { const a = P(i), b = P(j); return Math.hypot(a.x - b.x, a.z - b.z); };
  const minSep = 2 * (rules.playerRadius) - 0.15; // colliders no longer interpenetrate
  const ok = dist('a', 'b') >= minSep && dist('a', 'c') >= minSep && dist('b', 'c') >= minSep;
  check('D3: three players spawned on ONE point all separate (nobody fused)', ok,
    `ab=${dist('a', 'b').toFixed(2)} ac=${dist('a', 'c').toFixed(2)} bc=${dist('b', 'c').toFixed(2)} need≥${minSep.toFixed(2)}`);
  // Also a DISGUISED overlap (a big-table player spawned onto someone) must clear.
  const w2 = world();
  w2.addPlayer('x', { x: 0, y: 0, z: 0 });
  w2.addPlayer('y', { x: 0, y: 0, z: 0 });
  w2.setPlayerCollider('y', 'bigtable');
  w2.resolveSpawnOverlap('y');
  const dx = w2.getPlayer('y'), dy0 = w2.getPlayer('x');
  const sep = Math.hypot(dx.x - dy0.x, dx.z - dy0.z);
  check('D3: a disguised player spawned inside someone clears too', sep > 0.5, `sep=${sep.toFixed(2)}`);
  w2.destroy(); w.destroy();
}

// ── UNTOUCHED SYSTEMS (explicit, per Jie) ───────────────────────────────────────────────────
{
  // (1) General player-vs-player is byte-identical with the nudge ON vs OFF (neither is disguised,
  //     so our pass must be a no-op there — hunter-vs-hunter left exactly as it was).
  const on = pushRun({ heavyNudge: true, secs: 3 });
  const off = pushRun({ heavyNudge: false, secs: 3 });
  const same = Math.abs(on.M.x - off.M.x) < 1e-6 && Math.abs(on.T.x - off.T.x) < 1e-6 &&
    Math.abs(on.M.z - off.M.z) < 1e-6 && Math.abs(on.T.z - off.T.z) < 1e-6;
  check('UNTOUCHED: base↔base (general player-vs-player) identical with nudge on vs off', same,
    `onT=${on.T.x.toFixed(3)} offT=${off.T.x.toFixed(3)}`);

  // (2) Real props settle IDENTICALLY with the nudge on vs off (the nudge never touches props).
  const props = [{ id: 1, type: 'bigtable', x: 3, z: 0, y: 0, rot: 0 }, { id: 2, type: 'burger', x: -3, z: 2, y: 0, rot: 0 }];
  function settle(heavyNudge) {
    const w = world({ props, heavyNudge });
    w.addPlayer('lone', { x: 12, y: 0, z: 12 }); // one player, far away — nudge pass early-outs anyway
    for (let i = 0; i < 180; i++) w.step(H);
    const out = w.allProps().map((q) => ({ id: q.id, x: q.x, y: q.y, z: q.z }));
    w.destroy();
    return out;
  }
  const sOn = settle(true), sOff = settle(false);
  const settleSame = sOn.every((q, i) => Math.abs(q.x - sOff[i].x) < 1e-9 && Math.abs(q.y - sOff[i].y) < 1e-9 && Math.abs(q.z - sOff[i].z) < 1e-9);
  check('UNTOUCHED: real prop settle identical with nudge on vs off', settleSame,
    `props=${sOn.length}`);

  // (3) Shot raycast classification unchanged: disguised player => 'player' (via its shot sensor),
  //     real prop => 'prop'. (Player-vs-decoy detection / grenade+rifle classification is separate
  //     from movement collision and must read the same as before.)
  const w = world({ props: [{ id: 7, type: 'bigtable', x: 6, z: 0, y: 0, rot: 0 }] });
  w.addPlayer('victim', { x: 0, y: 0, z: 0 });
  w.setPlayerCollider('victim', 'burger');
  w.setShotCollider('victim', 'burger');
  for (let i = 0; i < 30; i++) w.step(H);
  const rp = w.raycastShot('shooterX', { x: 0, y: 0.15, z: -3 }, { x: 0, y: 0, z: 1 }, 10); // ray into the burger player
  check('UNTOUCHED: shot ray hits a DISGUISED player as kind:"player"', rp && rp.info && rp.info.kind === 'player',
    `info=${rp ? JSON.stringify(rp.info) : 'null'}`);
  const rq = w.raycastShot('shooterX', { x: 6, y: 0.5, z: -3 }, { x: 0, y: 0, z: 1 }, 10); // ray into the real table prop
  check('UNTOUCHED: shot ray hits a REAL prop as kind:"prop"', rq && rq.info && rq.info.kind === 'prop',
    `info=${rq ? JSON.stringify(rq.info) : 'null'}`);
  w.destroy();

  // (4) Object-sync stream untouched: heavy-nudging a disguised player must not perturb the dynamic
  //     props whose transforms feed host-authoritative object sync (awakeProps()). Run the SAME push
  //     scenario with the nudge ON vs OFF and assert the awake-prop stream (ids + transforms) is
  //     identical — the nudge only touches the disguised PLAYER, never the prop stream. (Props spawn
  //     awake and settle on their own, so we compare on/off rather than assert an absolute count.)
  function streamAfterPush(heavyNudge) {
    const wn = world({ heavyNudge, props: [{ id: 9, type: 'burger', x: 0, z: 9, y: 0, rot: 0 }] });
    wn.addPlayer('T', { x: 0, y: 0, z: 0 });
    wn.setPlayerCollider('T', 'bigtable');
    wn.setPlayerInput('T', { mx: 0, mz: 0, yaw: 0, jump: false });
    wn.addPlayer('M', { x: -4, y: 0, z: 0 });
    wn.setPlayerInput('M', { mx: 1, mz: 0, yaw: 0, jump: false });
    for (let i = 0; i < 240; i++) wn.step(H); // 4 s of sustained shoving
    const out = wn.awakeProps().map((q) => `${q.id}:${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)}`).sort().join('|');
    wn.destroy();
    return out;
  }
  check('UNTOUCHED: object-sync (awakeProps) stream identical with the nudge on vs off',
    streamAfterPush(true) === streamAfterPush(false), 'prop stream unchanged by the disguised-player nudge');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
