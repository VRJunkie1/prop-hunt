#!/usr/bin/env node
// Offline acceptance check for HOST-DISCONNECT HANDLING + the STALE-SESSION GHOST fix
// (VRmike 2026-07-19).
//
// THE BUG. A guest whose host dies SILENTLY — host tab suspended, phone locks, WebRTC stalls with
// NO PeerJS 'close'/'error' — stops receiving the 15 Hz snapshot heartbeat and keeps rendering the
// LAST snapshot forever. Every reported symptom flows from that one stall: the HUD ticks its last
// anchor down to 0:00 and clamps (frozen timer), remote players (the uncontrolled hunter) are pure
// interpolation toward the last snapshot so they stand as a collision-less statue (only the host
// simulates their physics), and disguise/interact inputs post into a dead pipe and do nothing.
//
// THE FIX. A client-side snapshot-staleness WATCHDOG (js/host-watchdog.js) declares the host dead
// after a multiple of the documented snapshot interval and boots the guest to the menu via the
// SHARED return path (main.js backToMenu). The LOUD signals (PeerJS close, AND — newly — a
// post-ready DataConnection error, which used to be swallowed) route to that same place.
//
// AUTHORING-ONLY — never imported by the page / shipped. Run under the sandboxed node:
//
//     node tools/check-host-disconnect.mjs
//
// WHY THIS EXISTS. This is netcode a headless page boot never exercises (no peers, no host death).
// So we (A) unit-test the PURE HostWatchdog against silent-stall / heartbeat / background-grace
// timelines, (B) assert the timeout is DERIVED from the documented rate (not hardcoded), (C) run a
// faithful mini-client through BOTH disconnect paths (silent stall AND explicit close) and assert
// each ends in clean lobby state via the ONE shared reset, and (D) assert the client + net.js
// wiring that ties it together. The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HostWatchdog } from '../js/host-watchdog.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('HOST-DISCONNECT — snapshot-staleness watchdog + shared boot-to-lobby: acceptance check');

const rules = readJSON('shared', 'config', 'rules.json');

// ---------------------------------------------------------------------------
// A) PURE HostWatchdog — timing + fire-once latch, over realistic timelines.
// ---------------------------------------------------------------------------
console.log('\nA) HostWatchdog: heartbeat keeps it alive, silence trips it exactly once');
{
  const T = 5000; // timeout ms for the test

  // Not armed => inert (a menu / lobby / host client never false-kicks).
  const idle = new HostWatchdog(T);
  ok(idle.poll(1e9) === false, 'not armed: poll() never trips');
  ok(idle.silenceFor(1e9) === 0, 'not armed: silenceFor() is 0');
  idle.feed(1e9);
  ok(idle.poll(1e9 + 999999) === false, 'not armed: feed() does nothing, still never trips');

  // Armed + a steady 15 Hz-ish heartbeat => never trips (a healthy match).
  const wd = new HostWatchdog();
  wd.arm(0, T);
  ok(wd.armed === true && wd.tripped === false, 'arm(): armed, not yet tripped');
  let tripped = false;
  for (let t = 0; t <= 60000; t += 66) { wd.feed(t); if (wd.poll(t)) tripped = true; }
  ok(!tripped, 'a continuous 66 ms snapshot heartbeat never trips across 60 s');

  // Last snapshot at t0; then silence. Trips just after the timeout, NOT before.
  const s = new HostWatchdog(T);
  s.arm(0, T);
  s.feed(1000); // last heartbeat at 1 s
  ok(s.poll(1000 + T) === false, 'at exactly the timeout it has NOT tripped yet (needs to EXCEED it)');
  ok(s.poll(1000 + T + 1) === true, 'one ms past the timeout it trips (declares the host dead)');
  ok(s.tripped === true, 'the trip is latched');
  ok(s.poll(1000 + T + 5000) === false, 'it fires ONCE — a later poll does not re-trip (single boot)');
  ok(Math.abs(s.silenceFor(1000 + T + 1) - (T + 1)) < 1e-9, 'silenceFor() reports the elapsed silence');

  // disarm() fully resets (leaving the match / between-rounds lobby).
  s.disarm();
  ok(s.armed === false && s.tripped === false && s.poll(1e12) === false, 'disarm(): inert again');

  // re-arm clears a prior trip (a flipped round starts a fresh watch).
  const r = new HostWatchdog(T);
  r.arm(0, T); r.feed(0);
  ok(r.poll(T + 1) === true, 'first match: trips on stall');
  r.arm(100000, T); // flipped round re-arms
  ok(r.tripped === false && r.poll(100000 + 10) === false, 're-arm resets the latch + clock (fresh round is watched anew)');
}

// A2) FALSE-ALARM GUARD — our own tab was backgrounded (frame loop throttled): resume() grants a
// fresh grace window so a returning player is not instantly kicked.
console.log('\nA2) background-grace: returning to the foreground does not instantly kick');
{
  const T = 5000;
  const wd = new HostWatchdog(T);
  wd.arm(0, T);
  wd.feed(1000);
  // Tab hidden 0.5..30.5 s: no polls run while hidden (rAF paused). On return at 30500 the raw gap
  // is ~29.5 s >> T, which WOULD trip — but resume() re-seeds the clock (main.js visibilitychange).
  wd.resume(30500);
  ok(wd.poll(30500) === false, 'right after returning from a 30 s background, it does NOT trip (grace granted)');
  ok(wd.poll(30500 + T + 1) === true, 'but if the host is really dead, it trips one timeout after return');
}

// ---------------------------------------------------------------------------
// B) TIMEOUT DERIVATION — pinned to the documented netcode rate, not a hardcoded hunch.
// ---------------------------------------------------------------------------
console.log('\nB) timeout derived from the documented snapshot rate + host leave-timeout');
{
  ok(Number(rules.snapshotRate) === 15, 'rules.snapshotRate is the documented 15 Hz (~66 ms/snapshot)');
  ok(Number.isFinite(Number(rules.leaveTimeoutSeconds)), 'rules.leaveTimeoutSeconds exists (the host silent-drop threshold)');
  const main = readText('js', 'main.js');
  ok(/function hostSilenceMs\(\)/.test(main), 'main.js has hostSilenceMs() (one place derives the timeout)');
  ok(/leaveTimeoutSeconds/.test(main.match(/function hostSilenceMs\(\)[\s\S]{0,400}?\}/)[0]),
     'hostSilenceMs() derives from rules.leaveTimeoutSeconds (mirrors the host silent-sweep threshold)');
  ok(/Math\.max\(3000,/.test(main), 'hostSilenceMs() floors the timeout so a tiny misconfig cannot false-kick');
  // The derived value at ship config is a sane multi-second window (many snapshot intervals).
  const derived = Math.max(3000, (Number(rules.leaveTimeoutSeconds) || 5) * 1000);
  const snapIntervalMs = 1000 / Number(rules.snapshotRate);
  ok(derived >= 3000 && derived / snapIntervalMs >= 30,
     `derived timeout ${derived}ms = ~${Math.round(derived / snapIntervalMs)} missed snapshots (>=30, unambiguously dead)`);
}

// ---------------------------------------------------------------------------
// C) INTEGRATION — a faithful mini-client through BOTH disconnect paths lands in clean lobby
//    state via the ONE shared reset. Mirrors main.js: arm on STARTED, feed on snapshot, poll each
//    (visible) frame, and the shared backToMenu reset used by the watchdog AND the 'closed' status.
// ---------------------------------------------------------------------------
console.log('\nC) both disconnect paths => clean lobby via the shared reset');
function makeClient(timeoutMs) {
  const wd = new HostWatchdog();
  return {
    wd,
    screen: 'menu',
    inMatch: false,
    message: null,
    sessionClosed: false,
    resets: 0,
    // main.js S2C.STARTED (guest): arm the watchdog + enter the game view.
    started(now) { this.inMatch = true; this.screen = 'game'; wd.arm(now, timeoutMs); },
    // main.js onSnapshot: prove the link is alive.
    snapshot(now) { wd.feed(now); },
    // main.js frame loop (visible tab): trip => shared reset + tear the dead session down.
    tick(now) { if (wd.poll(now)) { this.sessionClosed = true; this.reset('Lost connection to host.'); } },
    // main.js handleStatus('closed'): the LOUD path (graceful close / post-ready error).
    onClosed(msg) { this.reset(msg); },
    // THE ONE shared reset (backToMenu): drop to menu, show the message, disarm the watchdog.
    reset(msg) { this.inMatch = false; this.screen = 'menu'; this.message = msg; this.resets++; wd.disarm(); },
  };
}

// C1 — SILENT STALL: snapshots flow, then stop; the client must flag disconnect within the timeout
// and reset to a clean menu/lobby state exactly once.
{
  const T = 5000;
  const c = makeClient(T);
  c.started(0);
  // Healthy stream for 3 s at 15 Hz, then the host silently dies (no more snapshots, no event).
  let lastSnap = 0;
  for (let t = 0; t <= 3000; t += 66) { c.snapshot(t); lastSnap = t; c.tick(t); }
  ok(c.inMatch && c.screen === 'game' && c.resets === 0, 'C1: healthy stream — still in the match, no false kick');
  // Frame loop keeps running (rAF) with NO snapshots arriving.
  let flaggedAt = null;
  for (let t = lastSnap + 66; t <= lastSnap + 20000; t += 16) {
    c.tick(t);
    if (c.resets && flaggedAt === null) flaggedAt = t;
  }
  ok(c.resets === 1, 'C1: the silent stall flags disconnect exactly once (one boot, not a loop)');
  ok(c.screen === 'menu' && c.inMatch === false, 'C1: client ended in clean lobby/menu state (no zombie world)');
  ok(/lost connection to host/i.test(c.message || ''), 'C1: with a clear "lost connection to host" message');
  ok(c.sessionClosed === true, 'C1: the dead session was torn down (no leaked Peer)');
  ok(flaggedAt !== null && (flaggedAt - lastSnap) <= T + 50,
     `C1: flagged within the timeout window (~${flaggedAt - lastSnap}ms after the last snapshot, <= ${T}ms)`);
  // After the boot the watchdog is inert — no second trip.
  c.tick(lastSnap + 999999);
  ok(c.resets === 1, 'C1: no further trips after the boot (watchdog disarmed by the reset)');
}

// C2 — EXPLICIT CLOSE: a PeerJS close / post-ready error surfaces as onStatus('closed'); it must
// land in the SAME reset, and the watchdog must not then also fire (one boot total).
{
  const T = 5000;
  const c = makeClient(T);
  c.started(0);
  for (let t = 0; t <= 2000; t += 66) { c.snapshot(t); c.tick(t); }
  c.onClosed('Lost connection to host.'); // the loud path
  ok(c.resets === 1 && c.screen === 'menu' && c.inMatch === false, 'C2: explicit close resets to clean menu state');
  // Even if the frame loop runs once more before teardown, the disarmed watchdog cannot double-boot.
  for (let t = 2100; t <= 2100 + 20000; t += 16) c.tick(t);
  ok(c.resets === 1, 'C2: the watchdog does not also trip after an explicit close (single boot)');
}

// ---------------------------------------------------------------------------
// D) SOURCE WIRING — the client + net.js plumbing that ties the module in.
// ---------------------------------------------------------------------------
console.log('\nD) source: client + net.js wiring');
{
  const main = readText('js', 'main.js');
  ok(/import \{ HostWatchdog \} from '\.\/host-watchdog\.js'/.test(main), 'main.js imports HostWatchdog');
  ok(/const hostWatchdog = new HostWatchdog\(\)/.test(main), 'main.js constructs the watchdog');
  ok(/hostWatchdog\.feed\(nowMs\(\)\)/.test(main), 'main.js feeds the watchdog on every snapshot');
  ok(/if \(session && !session\.isHost\) hostWatchdog\.arm\(/.test(main),
     'main.js arms on STARTED for a GUEST only (never the host — solo host is a valid game)');
  ok((main.match(/hostWatchdog\.disarm\(\)/g) || []).length >= 2,
     'main.js disarms on BOTH the menu return and the between-rounds lobby return');
  ok(/document\.visibilityState === 'visible'\)? && hostWatchdog\.poll\(/.test(main),
     'the frame loop polls the watchdog gated on tab visibility (no false kick while backgrounded)');
  ok(/hostWatchdog\.poll\(now\)\) \{[\s\S]{0,200}?session\.close\(\)[\s\S]{0,200}?backToMenu\(/.test(main),
     'a trip tears the session down AND returns via the shared backToMenu path');
  ok(/hostWatchdog\.resume\(nowMs\(\)\)/.test(main), 'main.js grants a grace window on visibilitychange -> visible');
  // The reset REUSES the existing return path — it does not build a second teardown.
  ok(/function backToMenu\(msg\)/.test(main), 'the shared return-to-menu path (backToMenu) exists and is reused');

  const net = readText('js', 'net.js');
  ok(/close\(\)\s*\{\s*this\._teardown\(\);\s*\}/.test(net), 'net.js exposes a public close() for the silent-stall teardown');
  // The guest DataConnection error handler now acts AFTER the link is live, not only before.
  const errBlock = net.match(/conn\.on\('error', \(err\) => \{[\s\S]*?\}\);/);
  ok(errBlock && /this\.onStatus\('closed'/.test(errBlock[0]),
     "net.js routes a post-ready guest conn error to onStatus('closed') (was swallowed — the loud-signal gap)");
  ok(/conn\.on\('close', \(\) => \{[\s\S]{0,120}?this\.onStatus\('closed'/.test(net),
     "net.js still routes a graceful host close to onStatus('closed') (both loud signals, one place)");

  // CONNECTION LIVENESS VIA KEEPALIVE PINGS (2026-07-19, VRmike). The watchdog is now fed by PINGS
  // as well as snapshots, so a throttled-but-alive host that briefly stalls its snapshot stream is
  // still held up by its ~1Hz keepalive — only a GENUINELY dead link (pings stopped) boots the guest.
  ok(/session\.onKeepalive\s*=\s*\(\)\s*=>\s*hostWatchdog\.feed\(/.test(main),
     'main.js feeds the host watchdog from keepalive PINGS as well as snapshots (onKeepalive → hostWatchdog.feed)');
  ok(/_startKeepalive\s*\(\)\s*\{/.test(net), 'net.js runs an always-on ~1Hz keepalive (_startKeepalive), both directions');
  ok(/_markAlive\s*\(peerId\)/.test(net) && /this\.onKeepalive\(\)/.test(net),
     'net.js stamps liveness on an incoming ping/pong (_markAlive → guest onKeepalive)');
  ok(/this\.referee\.markSeen\(/.test(net), 'net.js host path stamps guest liveness via referee.markSeen on incoming pings');
  const ref = readText('shared', 'referee.js');
  ok(/markSeen\s*\(id\)\s*\{[\s\S]{0,160}?_lastSeen\s*=\s*Date\.now\(\)/.test(ref),
     'referee.markSeen(id) stamps the SAME _lastSeen the silent-player sweep reads (pings, not input, are the liveness signal)');

  const wdSrc = readText('js', 'host-watchdog.js');
  ok(!/document|window|import /.test(wdSrc), 'host-watchdog.js is PURE (no DOM / no imports) so it is unit-testable + host-safe');
  ok(/export class HostWatchdog/.test(wdSrc), 'host-watchdog.js exports HostWatchdog');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll host-disconnect + ghost-session checks passed.');
process.exit(fails ? 1 : 0);
