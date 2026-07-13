#!/usr/bin/env node
// tools/check-input-mode.mjs — UNIT TEST for the input-mode classifier (VRmike, 2026-07).
// AUTHORING-ONLY, never shipped. Runs from the sandbox node runner:
//     node tools/check-input-mode.mjs
//
// The bug it guards: a Windows PC with a touchscreen was classified as a PHONE (because it
// "can be touched") and got the touch scheme — no pointer lock, no Escape pause, no
// left-click hold-fire. The fix decides the PRIMARY control mode by POINTER CAPABILITY
// (a precise pointer / hover => desktop, even when touch is also present). That decision
// lives in prefersTouchControls() in js/input.js, which is PURE + injectable — so here we
// drive it with mocked matchMedia / maxTouchPoints / ontouchstart and assert the truth
// table the plan pins:  touchscreen PC => desktop, phone => touch, plain desktop => desktop.

import { prefersTouchControls } from '../js/input.js';

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

// Build a fake matchMedia from a set of media queries that should report matches:true.
const mmFrom = (trueQueries) => (q) => ({ matches: trueQueries.includes(q) });

console.log('input-mode classification check');

// --- 1. TOUCHSCREEN PC (the actual bug): a mouse AND a touchscreen. any-pointer:fine +
//        hover:hover match; touch is also present. MUST be desktop (false). ---
ok(prefersTouchControls({
  matchMedia: mmFrom(['(any-pointer: fine)', '(hover: hover)', '(any-pointer: coarse)', '(pointer: coarse)']),
  maxTouchPoints: 10,
  hasOntouchstart: true,
}) === false, 'touchscreen PC (fine pointer + touch)  => DESKTOP wiring');

// --- 2. PHONE: coarse pointer only, no hover, touch present. MUST be touch (true). ---
ok(prefersTouchControls({
  matchMedia: mmFrom(['(any-pointer: coarse)', '(pointer: coarse)']),
  maxTouchPoints: 5,
  hasOntouchstart: true,
}) === true, 'phone (coarse pointer only, no hover)   => TOUCH controls');

// --- 3. PLAIN DESKTOP: fine pointer + hover, no touch at all. MUST be desktop (false). ---
ok(prefersTouchControls({
  matchMedia: mmFrom(['(any-pointer: fine)', '(hover: hover)', '(pointer: fine)']),
  maxTouchPoints: 0,
  hasOntouchstart: false,
}) === false, 'plain desktop (fine pointer, no touch)   => DESKTOP wiring');

// --- 4. TABLET: coarse pointer, no hover (a big phone). MUST be touch (true). ---
ok(prefersTouchControls({
  matchMedia: mmFrom(['(any-pointer: coarse)']),
  maxTouchPoints: 5,
  hasOntouchstart: true,
}) === true, 'tablet (coarse pointer, no hover)        => TOUCH controls');

// --- 5. HYBRID laptop with a stylus + trackpad: fine present alongside coarse. Desktop. ---
ok(prefersTouchControls({
  matchMedia: mmFrom(['(any-pointer: fine)', '(any-pointer: coarse)', '(hover: hover)']),
  maxTouchPoints: 10,
  hasOntouchstart: true,
}) === false, 'hybrid laptop (fine + coarse pointers)   => DESKTOP wiring');

// --- 6. FALLBACK, no matchMedia, touch present (very old mobile browser) => touch. ---
ok(prefersTouchControls({
  matchMedia: null, maxTouchPoints: 5, hasOntouchstart: true,
}) === true, 'no matchMedia + touch present            => TOUCH controls (safe fallback)');

// --- 7. FALLBACK, no matchMedia, no touch (very old desktop browser) => desktop. ---
ok(prefersTouchControls({
  matchMedia: null, maxTouchPoints: 0, hasOntouchstart: false,
}) === false, 'no matchMedia + no touch                 => DESKTOP wiring (safe fallback)');

// --- 8. matchMedia THROWS (hostile/stub environment) => falls back to the touch signal. ---
ok(prefersTouchControls({
  matchMedia: () => { throw new Error('boom'); }, maxTouchPoints: 0, hasOntouchstart: false,
}) === false, 'matchMedia throws + no touch             => DESKTOP wiring (never throws)');

if (fails) {
  console.error(`\ninput-mode check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ninput-mode check passed');
