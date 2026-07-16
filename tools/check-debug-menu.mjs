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
// 3b) MENU STARTS COLLAPSED (2026-07-12): only the DEBUG button shows; the panel opens on
//     click. And the menu drives a LIVE collider-view toggle that reuses the scene overlay.
// ---------------------------------------------------------------------------
ok(/this\._collapsed = true/.test(debugSrc) && /_panel\.classList\.add\('hidden'\)/.test(debugSrc),
  'debug menu starts COLLAPSED (panel hidden; only the DEBUG button shows until clicked)');
ok(/_toggleColliders\s*\(\)/.test(debugSrc) && /setColliderView\(/.test(debugSrc),
  'debug menu has a "Colliders" toggle that drives scene.setColliderView (show ALL colliders)');
const sceneSrc2 = read('js', 'scene.js');
ok(/setColliderView\s*\([^)]*\)\s*\{/.test(sceneSrc2), 'scene.js defines setColliderView() — live build/teardown of the collider overlay');
ok(/_addPlayerColliderWire\s*\([^)]*\)\s*\{/.test(sceneSrc2), 'scene.js draws player CAPSULE colliders (new geometry for the all-colliders view)');

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
// 6) DESKTOP "UI MODE" (backtick `) — mid-game debug access on PC (2026-07-12, Jie).
//    A deliberate third state that frees the mouse for the DEBUG menu WITHOUT opening the pause
//    menu. These static asserts lock the careful interaction points the plan flagged:
//    (a) the ` hotkey is text-input-guarded; (b) the "Click to play" overlay decision is
//    STATE-driven off uiMode (not a race); (c) the re-lock click can't route into the fire
//    handler; (d) every resume/pause path clears the flag (never latched); (e) the DEBUG
//    button/panel sit ABOVE the pause menu so debug is reachable from both paths.
// ---------------------------------------------------------------------------
const inputSrc = read('js', 'input.js');

// (a) the hotkey + its typing guard live in input.js.
ok(/onToggleUiMode/.test(inputSrc) && /onRequestPause/.test(inputSrc),
  'input.js declares onToggleUiMode + onRequestPause callbacks');
ok(/e\.code === 'Backquote'/.test(inputSrc) && /this\.onToggleUiMode\(\)/.test(inputSrc),
  'input.js handles the ` (Backquote) key and fires onToggleUiMode');
ok(/Backquote'\)\s*\{\s*if \(this\.touch \|\| this\._isTyping\(\)\) return;/.test(inputSrc),
  'the ` hotkey NO-OPs while typing in a text field (and on touch) — never yanks you out mid-name');
ok(/_isTyping\s*\(\)\s*\{[\s\S]*?INPUT[\s\S]*?TEXTAREA/.test(inputSrc),
  'input._isTyping() detects focus in an INPUT/TEXTAREA (name/room fields)');
ok(/e\.code === 'Escape'[\s\S]*?!this\.locked[\s\S]*?this\.onRequestPause\(\)/.test(inputSrc),
  'input.js opens pause on Esc ONLY while the pointer is unlocked (locked Esc defers to the browser)');

// (c) the re-lock click can't fire the rifle: the canvas mousedown fire path is gated on lock.
ok(/mousedown[\s\S]*?if \(!this\.locked\) return;[\s\S]*?this\.primaryHeld = true; this\.onAction\('primary'\)/.test(inputSrc),
  'canvas mousedown fire/hold is gated on this.locked — the UI-mode resume click never shoots');

// (b) the overlay decision + flag lifecycle live in main.js and key off state.uiMode.
ok(/uiMode: false/.test(mainSrc), 'main.js declares state.uiMode (the third state)');
ok(/function enterUiMode\(\)/.test(mainSrc) && /function exitUiMode\(/.test(mainSrc),
  'main.js defines enterUiMode()/exitUiMode()');
ok(/state\.uiMode = true;[\s\S]*?exitPointerLock\(\)/.test(mainSrc),
  'enterUiMode sets the flag BEFORE releasing the lock (so onLockChange sees it — no race)');
ok(/if \(state\.uiMode\) \{ ui\.setClickToPlay\(false\); return; \}/.test(mainSrc),
  'onLockChange: UI mode suppresses BOTH the Click-to-play overlay AND the pause menu (state-driven)');
ok(/if \(locked\) \{[\s\S]*?state\.uiMode = false;/.test(mainSrc),
  'onLockChange clears uiMode the instant the pointer re-locks (derive/reset, never latch)');
ok(/if \(inGame && !state\.paused && !state\.uiMode\) ui\.setClickToPlay\(true, reason\)/.test(mainSrc),
  'onLockError also suppresses the overlay in UI mode (no stale prompt)');
// (d) every resume/pause path clears the flag. openPause + the two match-exit resets + STARTED
//     + onLockChange-on-lock = at least 5 assignments; require the key ones explicitly.
ok(/function openPause\(\)[\s\S]*?state\.uiMode = false;/.test(mainSrc),
  'openPause() clears uiMode — Esc→pause from UI mode hands over to the pause menu');
const uiModeClears = (mainSrc.match(/state\.uiMode = false;/g) || []).length;
ok(uiModeClears >= 4, `every resume/pause/exit path resets uiMode (${uiModeClears} clears — lock, pause, back-to-menu, lobby, started)`);
// Tolerant of ADDITIONAL halt conditions appended after uiMode (e.g. the taunt menu, 2026-07-16):
// the assertion is "movement halts in UI mode", so it only requires uiMode in the halt term.
ok(/const halt = state\.freeCam \|\| state\.paused \|\| state\.uiMode\b/.test(mainSrc),
  'the input loop halts movement in UI mode (avatar holds still, like pause)');
ok(/state\.role !== ROLE\.HUNTER \|\| !state\.movable \|\| state\.paused \|\| state\.uiMode/.test(mainSrc),
  'tryFire() is blocked in UI mode (belt-and-braces; primaryHeld is already clear while unlocked)');
ok(/input\.onToggleUiMode = \(\) =>/.test(mainSrc) && /input\.onRequestPause = \(\) =>/.test(mainSrc),
  'main.js wires the ` toggle + Esc-pause callbacks into input');

// (e) z-order: the DEBUG button + panel sit above the pause menu overlay.
const pauseZ = parseInt((css.match(/\.pause-menu\s*\{[^}]*z-index:\s*(\d+)/) || [])[1], 10);
const toggleZ = parseInt((debugSrc.match(/#dbgToggle\{[^}]*z-index:(\d+)/) || [])[1], 10);
const panelZ = parseInt((debugSrc.match(/#dbgPanel\{[^}]*z-index:(\d+)/) || [])[1], 10);
ok(Number.isFinite(pauseZ) && Number.isFinite(toggleZ) && toggleZ > pauseZ,
  `DEBUG button z-index (${toggleZ}) sits ABOVE the pause menu (${pauseZ}) — reachable over the pause overlay`);
ok(Number.isFinite(panelZ) && panelZ > pauseZ,
  `open DEBUG panel z-index (${panelZ}) sits ABOVE the pause menu (${pauseZ}) — usable from both paths`);

// The pause controls list documents the new key.
const uiSrc = read('js', 'ui.js');
ok(/\['`',/.test(uiSrc), "pause-menu controls list documents the ` key (free the mouse for debug/UI)");

// ---------------------------------------------------------------------------
// 7) TRUE-COLLIDER DIAGNOSTIC (2026-07-13, VRmike) — the build that lets us SEE the real
//    Rapier collider shapes, plus the fix for the local player's own collider never showing.
//    Two independent paths get checked so a builder can't satisfy the new renderer while
//    leaving VRmike's own-capsule bug in the EXISTING display:
//    (a) a new "True Colliders" toggle exists (separate from the box "Colliders" view);
//    (b) LOCAL and REMOTE colliders are wired into the EXISTING (box/capsule) collider display;
//    (c) LOCAL and REMOTE colliders are wired into the NEW true-Rapier renderer.
// ---------------------------------------------------------------------------
const sceneSrc7 = read('js', 'scene.js');

// (a) the new toggle — a SEPARATE button/handler from _toggleColliders, driving a new
//     scene.setTrueColliderView seam. Distinct so both overlays can be on at once.
ok(/_toggleTrueColliders\s*\(\)\s*\{/.test(debugSrc) && /setTrueColliderView\(/.test(debugSrc),
  '(a) debug menu has a "True Colliders" toggle (_toggleTrueColliders → scene.setTrueColliderView)');
ok(/'True Colliders'/.test(debugSrc),
  '(a) the True Colliders button is labelled + separate from the box "Colliders" view (side-by-side)');
ok(/setTrueColliderView\s*\([^)]*\)\s*\{/.test(sceneSrc7) && /updateTrueColliders\s*\([^)]*\)\s*\{/.test(sceneSrc7),
  '(a) scene.js defines setTrueColliderView() + updateTrueColliders() (the true-shape overlay seams)');

// (b) EXISTING display renders BOTH local + remote. Remote: the players-map loop attaches the
//     capsule wire. Local (the reported bug): selfMesh gets its own wires via _addSelfColliderWires,
//     called from BOTH _syncSelf (live) and _buildColliderView (toggle-on rebuild).
ok(/for \(const entry of this\.players\.values\(\)\)\s*\{[\s\S]*?_addPlayerColliderWire\(entry\)/.test(sceneSrc7),
  '(b) EXISTING display wires REMOTE players (players-map loop → _addPlayerColliderWire)');
ok(/_addSelfColliderWires\s*\(\)\s*\{[\s\S]*?_addPlayerColliderWire\(e\)[\s\S]*?_addPlayerShotWire\(e\)/.test(sceneSrc7),
  '(b) scene defines _addSelfColliderWires (reuses the SAME builders for the LOCAL player)');
ok(/if \(this\._colliderViewOn\) this\._addSelfColliderWires\(\)/.test(sceneSrc7),
  '(b) _syncSelf attaches the LOCAL player collider wire when the view is on (fixes own-capsule never showing)');
ok(/if \(this\.selfMesh\) this\._addSelfColliderWires\(\)/.test(sceneSrc7),
  '(b) _buildColliderView also includes the LOCAL player (toggle-on rebuild path)');

// (c) NEW true renderer covers BOTH. It iterates the live Rapier world's colliders; the world
//     SOURCE is host-authoritative (holds local + remote capsules) or, on a guest, the local
//     prediction world (holds our OWN capsule — the collider set that exists in-browser).
ok(/updateTrueColliders[\s\S]*?forEachCollider\(/.test(sceneSrc7),
  '(c) scene.updateTrueColliders iterates the live Rapier world (world.forEachCollider) — TRUE shapes, not mesh-derived');
ok(/_trueWorld\s*\(\)\s*\{[\s\S]*?isHost[\s\S]*?referee\.physics[\s\S]*?state\.predict/.test(debugSrc),
  '(c) debug _trueWorld() reads the HOST authoritative world (local+remote) else the LOCAL prediction world');
ok(/scene\.updateTrueColliders\(this\._trueWorld\(\)\)/.test(debugSrc),
  '(c) debug frame() feeds the chosen physics world into the true-collider renderer each frame');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\ndebug-menu check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ndebug-menu check passed');
