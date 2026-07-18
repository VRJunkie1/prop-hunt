#!/usr/bin/env node
// Offline acceptance check for the TWO SYNC-INTEGRITY FIXES (B1, VRmike 2026-07-18):
//   1) ROLE DESYNC — a client that missed its private ROLE message during a round flip / team
//      switch / mid-join used to stay stuck as the WRONG role (a player saw themselves as a
//      HUNTER while the host had them as a PROP, and a real hunter could kill them). The fix
//      makes role AUTHORITATIVE-AND-ACKNOWLEDGED: it rides EVERY snapshot as each player's own
//      `hunter` flag, and the client self-heals to it every snapshot.
//   2) GAME TIMER DESYNC — the HUD showed the latest snapshot's timeLeft directly, so a snapshot
//      stall froze it (Jie saw 5s while the host hit 0). The fix TICKS the countdown LOCALLY off
//      a per-snapshot anchor (HudTimer), clamped at 0 (round END stays host-authoritative).
//
// AUTHORING-ONLY — never imported by the page / shipped. Run under the sandboxed node:
//
//     node tools/check-sync-convergence.mjs
//
// WHY THIS EXISTS. Both are netcode fixes a headless page boot never exercises (no peers, no
// Rapier, no THREE, no DOM). So we (A) drive the REAL shared referee and assert the CONVERGENCE
// DATA the client needs is present + correct across flip/switch/mid-join — SIMULATING A MISSED
// ROLE MESSAGE by deriving role from the SNAPSHOT ALONE (exactly the client's self-heal), (B)
// unit-test the PURE HudTimer against a stalled-snapshot timeline, and (C) assert the client
// wiring that ties both rails together. The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';
import { HudTimer, formatClock } from '../js/hud-timer.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};
const approx = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

console.log('SYNC CONVERGENCE — role authoritative-and-acknowledged + local timer tick: acceptance check');

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// Shared harness (mirrors tools/check-team-flip.mjs): a referee with a captured mailbox per
// player, roles/positions set directly. Physics is STUBBED OUT so the round-launch runs Rapier-
// free and deterministic — we only assert referee OUTPUTS (the snapshot each player receives).
function makeRef() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
  ref._buildPhysics = async () => {}; // no Rapier in the sandbox; the logic under test is physics-free
  const inbox = new Map();
  const mk = (id, role, extra = {}) => {
    inbox.set(id, []);
    const p = {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
      lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false },
      send: (obj) => inbox.get(id).push(obj),
    };
    Object.assign(p, extra);
    return p;
  };
  const add = (id, role, extra = {}) => { const p = mk(id, role, extra); ref.players.set(id, p); if (!ref.hostId) ref.hostId = id; return p; };
  const msgs = (id) => inbox.get(id) || [];
  // The LAST snapshot a player received (the freshest one the client would render from).
  const lastSnap = (id) => { const s = msgs(id).filter((m) => m.t === S2C.SNAPSHOT); return s[s.length - 1] || null; };
  return { ref, mk, add, msgs, lastSnap };
}

// THE CLIENT'S CONVERGENCE RULE, verbatim (js/main.js onSnapshot): derive OUR role from OUR own
// entry's `hunter` flag in the snapshot we received — ignoring the private ROLE message entirely
// (that is the "missed ROLE" simulation). Returns null if we're absent from our own snapshot,
// which would be a fatal hole (the client could not converge).
function convergedRole(snap, selfId) {
  if (!snap) return null;
  const me = snap.players.find((pl) => pl.id === selfId);
  if (!me) return null;
  return me.hunter ? ROLE.HUNTER : ROLE.PROP;
}

// ---------------------------------------------------------------------------
// A) ROLE CONVERGENCE — the snapshot alone carries each player's true role, across
//    flip / switch / mid-join, in EVERY snapshot variant (full / blindfold / hunter-safe).
// ---------------------------------------------------------------------------
console.log('\nA) role rides every snapshot — client converges to host authority (missed-ROLE simulation)');

// A1 — FLIPPED ROUND. After a flip, phase is HIDING (hunters are blindfolded → the most
// aggressively filtered snapshot). Every player must still find THEMSELVES with the correct flag.
{
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  t.ref.phaseEndsAt = Date.now() + 30000;
  const H1 = t.add('H1', ROLE.HUNTER);
  const H2 = t.add('H2', ROLE.HUNTER, { alive: false, health: 0 });
  const P1 = t.add('P1', ROLE.PROP, { disguise: 'burger' });
  const P2 = t.add('P2', ROLE.PROP, { disguise: 'crate' });

  t.ref.startFlippedRound(); // roles flip; new round enters HIDING
  ok(t.ref.phase === PHASE.HIDING, 'flip lands in HIDING (hunters blindfolded — the filtered-snapshot case)');
  t.ref.broadcastSnapshot();

  for (const p of [H1, H2, P1, P2]) {
    const snap = t.lastSnap(p.id);
    const derived = convergedRole(snap, p.id);
    ok(derived != null, `${p.id}: present in its OWN snapshot after the flip (client CAN converge)`);
    ok(derived === p.role, `${p.id}: snapshot-derived role (${derived}) == host authority (${p.role}) — self-heals a missed ROLE`);
  }
  // The private ROLE rail still exists (belt-and-suspenders) — but the point above is that the
  // snapshot ALONE is sufficient, so a dropped ROLE can't strand the client.
  ok(t.msgs('P1').some((m) => m.t === S2C.ROLE && m.role === ROLE.HUNTER), 'a private ROLE was ALSO sent (both rails present)');
  t.ref.destroy();
}

// A2 — TEAM SWITCH (HUNTING → the hunter-safe snapshot variant). The switcher's own flag flips.
{
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  t.ref.phaseEndsAt = Date.now() + 30000;
  const H = t.add('H', ROLE.HUNTER);
  const P = t.add('P', ROLE.PROP, { disguise: 'burger' });

  t.ref.applySwitchTeam(P); // prop → hunter
  t.ref.broadcastSnapshot();
  ok(convergedRole(t.lastSnap('P'), 'P') === ROLE.HUNTER, 'after a switch prop→hunter, P converges to HUNTER from its snapshot');
  ok(convergedRole(t.lastSnap('H'), 'H') === ROLE.HUNTER, 'the unaffected hunter still converges correctly');

  t.ref.applySwitchTeam(P); // hunter → prop, back again
  t.ref.broadcastSnapshot();
  ok(convergedRole(t.lastSnap('P'), 'P') === ROLE.PROP, 'switching back hunter→prop, P converges to PROP from its snapshot');
  t.ref.destroy();
}

// A3 — MID-ROUND JOIN. The newcomer is assigned to the smaller team; its very first snapshot
// after joining must carry its role so the client converges even if its ROLE was missed.
{
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  t.ref.phaseEndsAt = Date.now() + 30000;
  t.add('H0', ROLE.HUNTER);
  t.add('H1', ROLE.HUNTER);
  t.add('P0', ROLE.PROP, { disguise: 'burger' }); // 2 hunters, 1 prop → newcomer joins PROPS
  const nc = t.mk('NEW', null);
  t.ref.addPlayer(nc);
  ok(nc.role === ROLE.PROP, 'mid-join newcomer assigned to the smaller team (PROP)');
  t.ref.broadcastSnapshot();
  ok(convergedRole(t.lastSnap('NEW'), 'NEW') === ROLE.PROP, 'the newcomer converges to PROP from its first snapshot (missed-ROLE safe)');
  t.ref.destroy();
}

// A4 — a HUNTER during HIDING is blindfolded (blindHunterSnapshot strips PROP entries). Confirm
// the hunter STILL sees ITSELF (else it could never converge while blindfolded) but NOT the props.
{
  const t = makeRef();
  t.ref.phase = PHASE.HIDING;
  t.ref.phaseEndsAt = Date.now() + 30000;
  const H = t.add('H', ROLE.HUNTER);
  const P = t.add('P', ROLE.PROP, { disguise: 'burger' });
  t.ref.broadcastSnapshot();
  const hSnap = t.lastSnap('H');
  ok(convergedRole(hSnap, 'H') === ROLE.HUNTER, 'a blindfolded hunter still finds ITSELF in its snapshot (can converge)');
  ok(!hSnap.players.some((pl) => pl.id === 'P'), 'the blindfold still hides prop entries from the hunter (anti-cheat intact)');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// B) LOCAL TIMER TICK — HudTimer counts down between (stalled) snapshots and clamps at 0.
// ---------------------------------------------------------------------------
console.log('\nB) local timer tick — ticks through a snapshot stall, clamps at 0, re-syncs on a fresh anchor');
{
  const timer = new HudTimer();
  const t0 = 100000; // an arbitrary local-clock ms (Date.now/performance.now are irrelevant — pure math)

  // A snapshot said "150s left" at t0. Then NO more snapshots arrive (the stall).
  timer.anchor(150, t0);
  ok(approx(timer.remaining(t0), 150), 'at the anchor instant the display equals the host time (150s)');
  ok(approx(timer.remaining(t0 + 1000), 149), 'without any new snapshot the display TICKS DOWN (149s after 1s)');
  ok(approx(timer.remaining(t0 + 4000), 146), 'across a 4s snapshot STALL it keeps ticking (146s) — never freezes');

  // THE REPORTED BUG, reproduced: the last snapshot said 5s; then a stall while the host runs to 0.
  const s = new HudTimer();
  s.anchor(5, t0);
  ok(approx(s.remaining(t0 + 3000), 2), 'Jie case: last snapshot 5s → 2s after a 3s stall (not frozen at 5)');
  ok(s.remaining(t0 + 5000) === 0, 'Jie case: at the host end the local clock is 0, not stuck at 5');
  ok(s.remaining(t0 + 200000) === 0, 'CLAMPS at 0 forever (never negative) — round END waits for the host event');

  // RE-SYNC: a fresh snapshot re-anchors and snaps the display back to the host truth.
  timer.anchor(120, t0 + 10000); // host now says 120 (e.g. a re-sync or a new phase)
  ok(approx(timer.remaining(t0 + 10000), 120), 're-anchoring on a fresh snapshot re-syncs the display (snaps to 120)');
  ok(approx(timer.remaining(t0 + 10500), 119.5), 'and continues ticking from the new anchor');

  // STOP: leaving a match halts the ticker so a stale anchor can't paint the lobby HUD.
  timer.stop();
  ok(timer.active === false && timer.remaining(t0 + 99999) === 0, 'stop() halts the ticker (0, inactive)');

  // A malformed (non-finite) timeLeft must not blank/NaN the clock — anchor ignores it.
  const g = new HudTimer();
  g.anchor(30, t0);
  g.anchor(NaN, t0 + 1000);
  ok(approx(g.remaining(t0 + 1000), 29), 'a non-finite timeLeft is ignored (keeps the last good anchor, no NaN)');
}
{
  // formatClock: m:ss, clamped at 0:00, ceil so a partial second reads as the higher number.
  ok(formatClock(150) === '2:30', 'formatClock(150) = 2:30');
  ok(formatClock(5) === '0:05', 'formatClock(5) = 0:05 (zero-padded)');
  ok(formatClock(0) === '0:00', 'formatClock(0) = 0:00');
  ok(formatClock(0.4) === '0:01', 'formatClock(0.4) = 0:01 (ceil — a partial second still shows)');
  ok(formatClock(-5) === '0:00', 'formatClock(-5) = 0:00 (clamped, never negative)');
}

// ---------------------------------------------------------------------------
// C) SOURCE — client wiring that ties both rails together.
// ---------------------------------------------------------------------------
console.log('\nC) source: client wiring (main.js / ui.js / hud-timer.js)');
{
  const main = readText('js', 'main.js');
  // ROLE convergence.
  ok(/function applyRole\(/.test(main), 'main.js has a single applyRole() role-application path');
  ok(/case S2C\.ROLE:[\s\S]{0,220}applyRole\(msg\.role\)/.test(main), 'the private S2C.ROLE handler applies role via applyRole()');
  ok(/serverRole\s*=\s*me\.hunter\s*\?\s*ROLE\.HUNTER\s*:\s*ROLE\.PROP/.test(main), 'onSnapshot derives serverRole from the self entry’s hunter flag');
  ok(/if \(serverRole !== state\.role\)[\s\S]{0,120}applyRole\(serverRole\)/.test(main), 'onSnapshot self-heals to the host role on a mismatch (converges)');
  // TIMER.
  ok(/import \{ HudTimer \} from '\.\/hud-timer\.js'/.test(main), 'main.js imports HudTimer');
  ok(/const hudTimer = new HudTimer\(\)/.test(main), 'main.js constructs the HudTimer');
  ok(/hudTimer\.anchor\(msg\.timeLeft, nowMs\(\)\)/.test(main), 'main.js re-anchors the timer on every snapshot');
  ok(/hudTimer\.anchor\(msg\.seconds, nowMs\(\)\)/.test(main), 'main.js re-anchors the timer on every phase event');
  ok(/ui\.setTimer\(hudTimer\.remaining\(now\)\)/.test(main), 'the frame loop ticks the HUD timer locally each frame');
  ok((main.match(/hudTimer\.stop\(\)/g) || []).length >= 2, 'main.js stops the timer on lobby + menu transitions');

  const ui = readText('js', 'ui.js');
  ok(/import \{ formatClock \} from '\.\/hud-timer\.js'/.test(ui), 'ui.js imports formatClock (one source of truth for the clock format)');
  ok(/setTimer\(seconds\)\s*\{[\s\S]{0,120}formatClock\(seconds\)/.test(ui), 'ui.setTimer renders via formatClock');
  ok(/setHud\(\{[^}]*\}\)\s*\{[\s\S]{0,160}this\.setTimer\(timeLeft\)/.test(ui), 'ui.setHud delegates the clock to setTimer');

  const timer = readText('js', 'hud-timer.js');
  ok(/export class HudTimer/.test(timer) && /export function formatClock/.test(timer), 'hud-timer.js exports HudTimer + formatClock');
  ok(!/document|window|import /.test(timer), 'hud-timer.js is PURE (no DOM / no imports) so it is unit-testable + host-safe');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll role-convergence + timer-tick checks passed.');
process.exit(fails ? 1 : 0);
