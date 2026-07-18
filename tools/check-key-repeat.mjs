#!/usr/bin/env node
// tools/check-key-repeat.mjs — GUARD for the key auto-repeat bug (Jie, 2026-07-18).
// AUTHORING-ONLY, never shipped. Runs from the sandbox node runner:
//     node tools/check-key-repeat.mjs
//
// The bug it guards: on PC, HOLDING a toggle key (T = taunt menu, ESC = pause) fires the OS
// key auto-repeat, so the browser delivers a burst of keydown events (event.repeat===true).
// Our menu toggles treated every repeat as a fresh press => the menu strobed open/closed.
// The fix: a single AUTO-REPEAT GUARD at the top of Input.onKeyDown ignores repeat keydowns,
// so every toggle / one-shot action fires EXACTLY ONCE on the initial press.
//
// This test drives the REAL Input class from js/input.js with a minimal mocked DOM, then:
//   1. simulates a HELD toggle key (1 real press + a burst of repeats) and asserts the
//      toggle fired exactly ONCE — for the taunt menu, the pause menu, view, and tool-select.
//   2. asserts that a HELD MOVEMENT key is NOT repeat-filtered — the player keeps moving for
//      the whole hold and stops on release — so we can never accidentally break held movement.

// ---- minimal DOM mock (desktop wiring: precise pointer, no touch) ---------------------------
const bags = { window: {}, document: {}, canvas: {} };
const wire = (bag) => ({
  addEventListener: (type, fn) => { (bag[type] ||= []).push(fn); },
  removeEventListener: () => {},
});
const fire = (bag, type, ev) => { for (const fn of bag[type] || []) fn(ev); };

const canvas = { ...wire(bags.canvas), style: {}, requestPointerLock() {} };
// NB: `navigator` is a read-only global in Node — don't assign it. The desktop classification
// below resolves from matchMedia (pointer: fine) before ever consulting navigator.maxTouchPoints.
globalThis.window = {
  ...wire(bags.window),
  // Desktop classification: a precise pointer with hover, no touch.
  matchMedia: (q) => ({ matches: ['(pointer: fine)', '(hover: hover)'].includes(q) }),
};
globalThis.document = {
  ...wire(bags.document),
  pointerLockElement: null, // set to `canvas` to simulate a captured (locked) pointer
  activeElement: null, // null => not typing in a field
};

const { Input } = await import('../js/input.js');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};
// Dispatch a keydown through the SAME window listener the game wired.
const keydown = (code, repeat = false) =>
  fire(bags.window, 'keydown', { code, repeat, preventDefault() {}, ctrlKey: false, metaKey: false });
const keyup = (code) => fire(bags.window, 'keyup', { code, preventDefault() {} });

console.log('key auto-repeat guard check');

const input = new Input(canvas);
ok(input.touch === false, 'test rig wired the DESKTOP scheme (keyboard live)');

// Helper: count how many times a callback fires across 1 real press + N held repeats.
const heldPressCount = (code, wireCb) => {
  let n = 0;
  wireCb(() => { n += 1; });
  keydown(code, false); // the initial, genuine press
  for (let i = 0; i < 8; i++) keydown(code, true); // OS auto-repeat burst while held
  keyup(code); // release does nothing for a toggle
  return n;
};

// --- 1. TAUNT MENU (the reported bug): T toggles the prop taunt menu. Held T must fire ONCE. ---
ok(heldPressCount('KeyT', (cb) => { input.onToggleTaunt = cb; }) === 1,
  'held T (taunt menu)      => toggle fires EXACTLY once');

// --- 2. PAUSE (ESC while unlocked): the other menu Jie called out. Held ESC must fire ONCE. ---
input.locked = false; // Esc pause only fires while the pointer is NOT locked
ok(heldPressCount('Escape', (cb) => { input.onRequestPause = cb; }) === 1,
  'held Esc (pause menu)    => request fires EXACTLY once');

// --- 3. VIEW TOGGLE (V) — a locked-gate one-shot, to prove the guard covers post-lock actions. ---
input.locked = true;
globalThis.document.pointerLockElement = canvas;
ok(heldPressCount('KeyV', (cb) => { input.onToggleView = cb; }) === 1,
  'held V (1st/3rd person)  => toggle fires EXACTLY once');

// --- 4. TOOL SELECT (number key) — holding 1 must NOT spam-select the tool. ---
let toolSelects = 0;
input.onSelectTool = () => { toolSelects += 1; };
keydown('Digit1', false);
for (let i = 0; i < 8; i++) keydown('Digit1', true);
ok(toolSelects === 1, 'held 1 (tool select)     => selects EXACTLY once');

// --- 5. MOVEMENT (WASD) is NOT repeat-filtered: the player keeps moving for the WHOLE hold and
//        stops only on release. Movement is read every frame off `this.keys`, so a held key must
//        keep it active across the repeat burst — this is the "don't break movement" guard. ---
input.keys.clear();
keydown('KeyW', false); // start moving forward
const afterPress = input.moveVector().mz;
for (let i = 0; i < 8; i++) keydown('KeyW', true); // OS auto-repeat while W is held
const duringHold = input.moveVector().mz;
keyup('KeyW'); // release
const afterRelease = input.moveVector().mz;
ok(afterPress === 1 && duringHold === 1,
  'held W (movement)        => keeps moving through the whole hold (NOT repeat-filtered)');
ok(afterRelease === 0, 'release W                => movement stops on keyup');

if (fails) {
  console.error(`\nkey auto-repeat check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nkey auto-repeat check passed');
