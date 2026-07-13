#!/usr/bin/env node
// tools/_jumpdiag.mjs — TEMPORARY diagnostic harness for the "jerky first-person jump"
// bug (VRmike, 2026-07-13). NOT shipped, NOT a build gate. Reproduces the HOST case:
// one authoritative PhysicsWorld (referee) + one prediction PhysicsWorld (state.predict),
// driven through the REAL net cadence (60fps predict loop, 20Hz input send, 30Hz referee
// tick, 15Hz snapshot + reconcile, y quantised to 1cm). Traces, every render frame, the
// displayed camera height (self.y + corr.y) vs the authoritative height — the exact number
// scene.setCamera feeds camera.position.y. A sawtooth in the displayed column that is NOT
// in the authoritative column IS the judder.
//
//   npm i --no-save @dimforge/rapier3d-compat@0.14.0 && node tools/_jumpdiag.mjs [fix]
//
// argv "fix" applies the candidate root-cause fix (freeze reconciliation while airborne).

let RAPIER;
try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; }
catch { console.log('SKIP: rapier not installed'); process.exit(3); }
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();

const MODE = process.argv[2] || 'baseline';
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const map = { size: 40, fixtures: [] };
const catalog = {};
const round2 = (v) => Math.round(v * 100) / 100;

// Host = authoritative world (dynamic props) + a local prediction world for the SAME player.
const auth = new PhysicsWorld(RAPIER, map, [], catalog, { rules, feel, dynamicProps: true });
const predict = new PhysicsWorld(RAPIER, map, [], catalog, { rules, feel, dynamicProps: false });
const SELF = 'self';
const spawn = { x: 0, y: 0, z: 0 };
auth.addPlayer(SELF, spawn);
predict.addPlayer(SELF, spawn);

// Referee-side player record.
const ref = { input: { mx: 0, mz: 0, jump: false }, yaw: 0, lastInputSeq: 0, pos: { x: 0, y: 0, z: 0 } };

// Client-side prediction state (mirrors js/main.js state.*).
const self = { x: 0, y: 0, z: 0 };
const corr = { x: 0, y: 0, z: 0 };
let pending = [];
let seq = 0;
let airborneClient = false; // for the candidate fix

function predictStep(inp, dt) {
  predict.setPlayerInput(SELF, { mx: inp.mx, mz: inp.mz, yaw: inp.yaw, jump: inp.jump });
  predict.step(dt);
  const p = predict.getPlayer(SELF);
  if (p) { self.x = p.x; self.y = p.y; self.z = p.z; airborneClient = !p.grounded; }
}
function reconcile(me) {
  const dispY = self.y + corr.y;
  const dispX = self.x + corr.x, dispZ = self.z + corr.z;
  const ack = Number.isFinite(me.ack) ? me.ack : 0;
  pending = pending.filter((p) => p.seq > ack);
  predict.setPlayerPosition(SELF, { x: me.x, y: me.y || 0, z: me.z });
  for (const p of pending) predictStep(p, p.dt);
  const now = predict.getPlayer(SELF);
  if (!now) return;
  self.x = now.x; self.y = now.y; self.z = now.z;
  corr.x = dispX - now.x; corr.y = dispY - now.y; corr.z = dispZ - now.z;
  if (Math.hypot(corr.x, corr.z) > 2.5 || Math.abs(corr.y) > 2.5) corr.x = corr.y = corr.z = 0;
}

// virtual clock
const T = 2200;
const jumpOn = (t) => t >= 500 && t < 560; // single short press
let lastFrame = 0, lastInput = 0, lastTick = 0, lastSnapshot = 0;
const frameH = 1000 / 60, inputH = 1000 / 20, tickH = 1000 / 30, snapH = 1000 / 15;
const rows = [];

for (let t = 0; t <= T; t++) {
  // Referee tick (30Hz)
  if (t - lastTick >= tickH - 1e-9) {
    const dt = Math.min(0.1, (t - lastTick) / 1000);
    lastTick = t;
    auth.setPlayerInput(SELF, { mx: ref.input.mx, mz: ref.input.mz, yaw: ref.yaw, jump: ref.input.jump });
    auth.step(dt);
    const g = auth.getPlayer(SELF);
    if (g) { ref.pos.x = g.x; ref.pos.y = g.y; ref.pos.z = g.z; }
    // Snapshot (15Hz) — produced inside the tick, delivered to the host's own client instantly.
    if (t - lastSnapshot >= snapH - 1e-9) {
      lastSnapshot = t;
      const me = { x: round2(ref.pos.x), y: round2(ref.pos.y), z: round2(ref.pos.z), ack: ref.lastInputSeq };
      if (MODE === 'fix' && airborneClient) {
        // CANDIDATE FIX: don't reconcile vertical while the local player is airborne.
      } else {
        reconcile(me);
      }
    }
  }
  // Input send (20Hz)
  if (t - lastInput >= inputH - 1e-9) {
    lastInput = t;
    const jmp = jumpOn(t);
    // loopback: referee consumes immediately
    ref.input = { mx: 0, mz: 0, jump: jmp };
    ref.yaw = 0;
    if (seq > ref.lastInputSeq) ref.lastInputSeq = seq;
  }
  // Render frame (60Hz)
  if (t - lastFrame >= frameH - 1e-9) {
    const dt = Math.min(0.05, (t - lastFrame) / 1000);
    lastFrame = t;
    seq++;
    const inp = { seq, mx: 0, mz: 0, yaw: 0, jump: jumpOn(t), dt };
    pending.push(inp);
    if (pending.length > 300) pending.shift();
    predictStep(inp, dt);
    corr.x *= 0.85; corr.y *= 0.75; corr.z *= 0.85;
    const dispY = self.y + corr.y;
    rows.push({ t, dispY, authY: ref.pos.y, selfY: self.y, corrY: corr.y });
  }
}

// Report: per-frame displayed Y and the frame-to-frame delta. A jump is a smooth arc;
// judder shows as sign flips / spikes in dDisp that the authoritative arc doesn't have.
console.log(`MODE=${MODE}`);
console.log('  t   dispY   dDisp   authY  dAuth   corrY   selfY');
let prevD = null;
let maxCorr = 0;          // biggest vertical correction offset injected (the judder driver)
let againstArcAscent = 0; // frames where the DISPLAY moves DOWN while the true arc is rising
let againstArcDescent = 0;// frames where the DISPLAY moves UP while the true arc is falling
for (const r of rows) {
  const dD = prevD == null ? 0 : r.dispY - prevD;
  if (r.t >= 480 && r.t <= 1600) {
    console.log(
      `${String(r.t).padStart(4)} ${r.dispY.toFixed(3).padStart(7)} ${dD.toFixed(3).padStart(7)} ${r.authY.toFixed(3).padStart(7)} ${r.corrY.toFixed(3).padStart(7)} ${r.selfY.toFixed(3).padStart(7)}`
    );
  }
  if (r.t >= 500 && r.t <= 1240) {
    if (Math.abs(r.corrY) > maxCorr) maxCorr = Math.abs(r.corrY);
    // ASCENT window (true arc clearly rising) — any downward display frame is judder.
    if (r.t >= 520 && r.t <= 820 && dD < -0.002) againstArcAscent++;
    // DESCENT window (true arc clearly falling) — any upward display frame is judder.
    if (r.t >= 900 && r.t <= 1200 && dD > 0.002) againstArcDescent++;
  }
  prevD = r.dispY;
}
console.log(`\nSUMMARY MODE=${MODE}: max |vertical correction| in-arc = ${maxCorr.toFixed(3)} m; ` +
  `against-arc frames (visible jerks) = ${againstArcAscent} ascending + ${againstArcDescent} descending`);
