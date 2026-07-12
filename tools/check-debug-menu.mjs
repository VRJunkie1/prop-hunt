#!/usr/bin/env node
// Offline acceptance check for the in-game DEBUG MENU (?debug=1). AUTHORING-ONLY — never
// imported by the page or shipped to a browser. Run from a shell:
//
//     node tools/check-debug-menu.mjs
//
// As of 2026-07-12 the debug MENU is ON BY DEFAULT (no ?debug=1 needed); ?debug=1 still
// governs the heavier, separable features (collider wireframe overlay, per-peer ping, and the
// referee's host-authoritative debug-command gate). A headless check can't "boot" a browser,
// so it asserts the contract:
//   1) js/debug.js PARSES and exports DebugMenu (imported here — it has no browser-only
//      top-level code, so it's safe to import in node; DOM access is all inside methods);
//   2) it is self-contained: no import statements, no debug DOM in index.html, no debug
//      CSS in css/style.css (styles are injected by the module only when it runs) — so the
//      default-on menu adds nothing to the shipped HTML/CSS, only its own injected overlay;
//   3) js/main.js constructs the menu UNCONDITIONALLY (default-on), defaults debugMenu to
//      null, null-guards every hook, and still enables ping ONLY under ?debug=1 (so a normal
//      match carries no ping traffic even with the panel visible);
//   4) the referee DROPS the debug: message family unless the HOST loaded with ?debug=1
//      (unchanged — the visible-by-default panel can't tamper with a normal match);
//   5) the protocol + netcode plumbing (C2S.DEBUG, ping/pong intercept) are wired.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('debug-menu acceptance check');

// ---------------------------------------------------------------------------
// 1) debug.js PARSES + exports DebugMenu. It intentionally imports nothing and touches
//    no browser globals at module top level, so importing it in node both proves it
//    parses and confirms the export exists.
// ---------------------------------------------------------------------------
const debugSrc = read('js', 'debug.js');
let mod = null;
try {
  mod = await import(pathToFileURL(join(root, 'js', 'debug.js')).href);
} catch (e) {
  console.error('  ✗ js/debug.js failed to import:', e && e.message);
  fails++;
}
ok(!!mod && typeof mod.DebugMenu === 'function', 'js/debug.js parses and exports class DebugMenu');

// 2) Self-contained: no import statements (so it can never drag a browser-only dep into a
//    headless import), and its DOM ids are all debug-prefixed.
ok(!/^\s*import\s/m.test(debugSrc), 'js/debug.js has no import statements (pure DOM/logic module)');
ok(/#dbgToggle/.test(debugSrc) && /id = 'dbgPanel'/.test(debugSrc), 'debug DOM ids are dbg-prefixed');

// ---------------------------------------------------------------------------
// 3) SHIPPED HTML/CSS STAY CLEAN, MENU IS DEFAULT-ON. No debug DOM ships in index.html; no
//    debug CSS in style.css (the menu injects its own overlay when it runs); main.js builds
//    the menu unconditionally but keeps ping behind ?debug=1.
// ---------------------------------------------------------------------------
const html = read('index.html');
ok(!/dbg[A-Z]/.test(html) && !/debug\.js/.test(html), 'index.html ships ZERO debug DOM / no debug.js tag');
const css = read('css', 'style.css');
ok(!/#dbg/.test(css), 'css/style.css has no debug rules (styles injected by debug.js only when it runs)');

const mainSrc = read('js', 'main.js');
ok(
  /const DEBUG = [^\n]*URLSearchParams[^\n]*['"]debug['"][^\n]*=== '1'/.test(mainSrc),
  "main.js still derives DEBUG from ?debug=1 (governs collider view / ping / referee gate)"
);
ok(/let debugMenu = null/.test(mainSrc), 'main.js defaults debugMenu to null');
// Default-on: the DebugMenu is imported+constructed UNCONDITIONALLY (not inside an if (DEBUG)).
ok(
  /await import\('\.\/debug\.js'\)[\s\S]*?new DebugMenu\(/.test(mainSrc),
  'main.js lazy-imports ./debug.js and constructs DebugMenu'
);
ok(
  !/if \(DEBUG\)\s*\{[\s\S]*?await import\('\.\/debug\.js'\)/.test(mainSrc),
  'DebugMenu construction is NOT gated behind ?debug=1 (menu is ON BY DEFAULT)'
);
ok(/if \(debugMenu\) debugMenu\.onSnapshot\(/.test(mainSrc), 'main.js null-guards the onSnapshot hook');
ok(/if \(debugMenu\) debugMenu\.frame\(/.test(mainSrc), 'main.js null-guards the per-frame hook');
ok(/if \(DEBUG\) session\.enablePing\(\)/.test(mainSrc), 'main.js enables ping ONLY under ?debug=1 (no ping traffic in normal play)');

// ---------------------------------------------------------------------------
// 4) HOST-AUTHORITATIVE GATE. The referee reads the HOST's own ?debug=1 and drops the
//    whole debug family otherwise; the three actions route through it.
// ---------------------------------------------------------------------------
const refSrc = read('shared', 'referee.js');
ok(
  /this\.debugEnabled\s*=[\s\S]*?URLSearchParams[\s\S]*?['"]debug['"][\s\S]*?=== '1'/.test(refSrc),
  'referee.debugEnabled is derived from the host tab\'s ?debug=1'
);
ok(/handleDebug\s*\([^)]*\)\s*\{\s*[\s\S]*?if \(!this\.debugEnabled\) return/.test(refSrc),
  'referee.handleDebug DROPS every debug command unless the host has debug on');
ok(/action === 'team'/.test(refSrc) && /action === 'reset'/.test(refSrc) && /action === 'morph'/.test(refSrc),
  'referee handles all three debug actions (team / reset / morph)');
ok(/debugMorph[\s\S]*?setPlayerCollider\(player\.id, type\)/.test(refSrc),
  'force-morph resizes the capsule via the shared setPlayerCollider path (applyDisguise machinery)');

// ---------------------------------------------------------------------------
// 5) PROTOCOL + NETCODE plumbing.
// ---------------------------------------------------------------------------
const proto = read('shared', 'protocol.js');
ok(/DEBUG:\s*'debug'/.test(proto), 'protocol C2S.DEBUG is defined');

const netSrc = read('js', 'net.js');
ok(/enablePing\s*\(\)\s*\{/.test(netSrc), 'net.js exposes enablePing()');
ok(/_handlePingPong\([\s\S]*?\)\)\s*return;/.test(netSrc), 'net.js intercepts ping/pong BEFORE the referee/onMessage');
ok(/this\.pings\s*=\s*new Map\(\)/.test(netSrc), 'net.js keeps a per-peer pings map');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\ndebug-menu check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ndebug-menu check passed');
