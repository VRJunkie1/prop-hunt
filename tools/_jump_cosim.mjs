#!/usr/bin/env node
// tools/_jump_cosim.mjs — TEMPORARY co-simulation of the FULL client+host loop to reproduce
// VRmike's "5-inch hop" prop-jump bug. Scratch probe, NOT a build gate. Models main.js's
// prediction/reconciliation (60fps predict, 20Hz input send, seq/ack) against a referee-like
// host (30Hz tick, 15Hz snapshots), with configurable latency, and measures the peak height
// the CLIENT actually displays. The pure-physics probe (_jump_probe.mjs) shows full height for
// every case, so any shortfall here is a prediction/reconciliation defect, not the engine.
let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; }
catch { console.log('SKIP: rapier not installed'); process.exit(3); }
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const SELF = 'me';
const catalog = { crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 } };

// Faithful port of main.js reconcilePredict + predictStep for the SELF body.
function makeClient(disguise) {
  const predict = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [], catalog, { dynamicProps: false, rules, feel });
  predict.addPlayer(SELF, { x: 0, y: 0, z: 0 });
  if (disguise) predict.setPlayerCollider(SELF, disguise);
  const state = { self: { x: 0, y: 0, z: 0 }, corr: { x: 0, y: 0, z: 0 }, grounded: true, pending: [], seq: 0, spawned: true, predict };
  function predictStep(input, dt) {
    predict.setPlayerInput(SELF, { mx: input.mx, mz: input.mz, yaw: input.yaw, jump: input.jump });
    predict.step(dt);
    const p = predict.getPlayer(SELF);
    if (p) { state.self.x = p.x; state.self.y = p.y; state.self.z = p.z; state.grounded = !!p.grounded; }
  }
  function reconcilePredict(me) {
    const dispY = state.self.y + state.corr.y;
    const dispX = state.self.x + state.corr.x, dispZ = state.self.z + state.corr.z;
    const ack = Number.isFinite(me.ack) ? me.ack : 0;
    if (!state.grounded) {
      const bigTeleport = Math.hypot(me.x - state.self.x, me.z - state.self.z) > 2.5 || Math.abs((me.y || 0) - state.self.y) > 2.5;
      if (!bigTeleport) { state.pending = state.pending.filter((p) => p.seq > ack); return; }
    }
    state.pending = state.pending.filter((p) => p.seq > ack);
    predict.setPlayerPosition(SELF, { x: me.x, y: me.y || 0, z: me.z });
    for (const p of state.pending) predictStep(p, p.dt);
    const now = predict.getPlayer(SELF);
    if (!now) return;
    state.self.x = now.x; state.self.y = now.y; state.self.z = now.z;
    state.corr.x = dispX - now.x; state.corr.y = dispY - now.y; state.corr.z = dispZ - now.z;
    if (Math.hypot(state.corr.x, state.corr.z) > 2.5 || Math.abs(state.corr.y) > 2.5) state.corr.x = state.corr.y = state.corr.z = 0;
  }
  return { state, predictStep, reconcilePredict };
}

// Referee-like host: one PhysicsWorld, 30Hz ticks, applies the latest received input, 15Hz snapshots.
function makeHost(disguise) {
  const w = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer(SELF, { x: 0, y: 0, z: 0 });
  if (disguise) w.setPlayerCollider(SELF, disguise);
  const input = { mx: 0, mz: 0, yaw: 0, jump: false };
  let lastInputSeq = 0;
  return {
    applyInput(msg) { input.mx = msg.mx; input.mz = msg.mz; input.yaw = msg.yaw; input.jump = !!msg.jump; if (msg.seq > lastInputSeq) lastInputSeq = msg.seq; },
    tick(dt) { w.setPlayerInput(SELF, { ...input }); w.step(dt); },
    snapshot() { const t = w.getPlayer(SELF); return { x: t.x, y: t.y, z: t.z, ack: lastInputSeq }; },
    peakY() { return w.getPlayer(SELF).y; },
    w,
  };
}

// Run one jump. jumpMs = how long input.jump is held. lagMs = one-way network latency.
function run({ jumpMs, lagMs, walk = false, label, jumpStart = 200, silent = false, disguise = null }) {
  const cli = makeClient(disguise);
  const host = makeHost(disguise);
  const dtFrame = 1 / 60;      // 60fps client render
  const c2s = [];              // {arriveMs, msg}
  const s2c = [];              // {arriveMs, msg}
  let lastSend = -1000, lastTick = -1000, lastSnap = -1000;
  let cliPeak = -Infinity, hostPeak = -Infinity, restY = 0;
  const totalMs = 2500;
  // settle
  for (let i = 0; i < 90; i++) { host.tick(1 / 60); cli.predictStep({ mx: 0, mz: 0, yaw: 0, jump: false }, 1 / 60); }
  restY = cli.state.self.y;
  cli.state.grounded = true;

  for (let ms = 0; ms < totalMs; ms += 1000 * dtFrame) {
    const jumping = ms >= jumpStart && ms < jumpStart + jumpMs;
    const walking = walk;
    const curInput = { mx: walking ? 1 : 0, mz: 0, yaw: 0, jump: jumping };

    // --- CLIENT FRAME (60fps): predict ---
    cli.state.seq++;
    const inp = { seq: cli.state.seq, mx: curInput.mx, mz: curInput.mz, yaw: 0, jump: curInput.jump, dt: dtFrame };
    cli.state.pending.push(inp);
    cli.predictStep(inp, dtFrame);
    const dispY = cli.state.self.y + cli.state.corr.y;
    cliPeak = Math.max(cliPeak, dispY);
    // decay corr like the frame loop
    cli.state.corr.x *= 0.85; cli.state.corr.y *= 0.75; cli.state.corr.z *= 0.85;

    // --- CLIENT INPUT SEND (20Hz): latest seq + CURRENT jump (main.js startInputLoop) ---
    if (ms - lastSend >= 50) { lastSend = ms; c2s.push({ arriveMs: ms + lagMs, msg: { seq: cli.state.seq, mx: curInput.mx, mz: curInput.mz, yaw: 0, jump: curInput.jump } }); }

    // --- HOST: deliver due C2S, tick 30Hz, snapshot 15Hz ---
    while (c2s.length && c2s[0].arriveMs <= ms) host.applyInput(c2s.shift().msg);
    if (ms - lastTick >= 1000 / 30) { lastTick = ms; host.tick(1 / 30); hostPeak = Math.max(hostPeak, host.peakY()); }
    if (ms - lastSnap >= 1000 / 15) { lastSnap = ms; const snap = host.snapshot(); s2c.push({ arriveMs: ms + lagMs, msg: snap }); }

    // --- CLIENT: deliver due S2C, reconcile ---
    while (s2c.length && s2c[0].arriveMs <= ms) cli.reconcilePredict(s2c.shift().msg);
  }
  const cliH = cliPeak - restY, hostH = hostPeak - restY;
  if (!silent) {
    const bad = cliH < 1.0;
    console.log(`${bad ? 'FAIL' : ' ok '} ${label.padEnd(42)} client peak=${cliH.toFixed(3)}m (${(cliH * 39.37).toFixed(1)}in)  host peak=${hostH.toFixed(3)}m`);
  }
  cli.state.predict.destroy(); host.w.destroy();
  return { cliH, hostH };
}

// Sweep the jump-press START PHASE (relative to the frame/send/tick cadences) to expose
// timing-aliasing failures. VRmike: "usually fail" while standing, "works" while moving.
function sweep({ jumpMs, lagMs, walk, disguise = null }) {
  let fails = 0, worst = Infinity, best = -Infinity, hostFails = 0;
  const N = 24;
  for (let k = 0; k < N; k++) {
    const r = run({ jumpMs, lagMs, walk, disguise, jumpStart: 200 + k * (1000 / 60) / N, silent: true });
    if (r.cliH < 1.0) fails++;
    if (r.hostH < 1.0) hostFails++;
    worst = Math.min(worst, r.cliH); best = Math.max(best, r.cliH);
  }
  const tag = (walk ? 'MOVING ' : 'STANDING') + (disguise ? ` [${disguise}]` : '');
  console.log(`  ${tag.padEnd(18)} jump ${String(jumpMs).padStart(3)}ms  lag ${String(lagMs).padStart(2)}ms:  client-fail ${fails}/${N}  (worst ${worst.toFixed(2)}m best ${best.toFixed(2)}m)  host-fail ${hostFails}/${N}`);
}
console.log('CO-SIM sweep: fraction of jump phases that FAIL (client peak < 1.0m). jumpSpeed=%s (full ≈ 1.45m)\n', rules.jumpSpeed);
for (const lagMs of [0, 30, 80]) {
  for (const jumpMs of [50, 80, 120]) {
    sweep({ jumpMs, lagMs, walk: false });
    sweep({ jumpMs, lagMs, walk: false, disguise: 'crate' });
    sweep({ jumpMs, lagMs, walk: true, disguise: 'crate' });
  }
  console.log('');
}
