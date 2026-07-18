#!/usr/bin/env node
// tools/check-pc-controls.mjs — guard for B4 PC FEEL/CONTROLS (VRmike, 2026-07-18).
// AUTHORING-ONLY, never shipped. Run:  node tools/check-pc-controls.mjs
//
// Three separable, low-risk pieces — this asserts the load-bearing INVARIANTS of each so a
// future edit can't silently break them:
//   1) RUN SPEED is a CONFIG knob (rules.moveSpeed), read by host + client, never hardcoded in
//      the JS movement paths — so a retune stays one number and can't desync.
//   2) MOUSE SENSITIVITY is a live-scaled multiplier (1.0× == the historical 0.0022 feel),
//      persisted to localStorage (not cookies), restored on boot, PC-only.
//   3) The PC CONTROLS REFERENCE panel exists, is built from the SAME rows as the pause "Controls"
//      panel (one source of truth), and is hidden on touch.
// These are SOURCE + RANGE assertions (like check-taunts §C / check-input-mode) — cheap, no browser.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SENSITIVITY_RANGE } from '../js/input.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('PC feel/controls check (B4)');

// ---------------------------------------------------------------------------
// 1. RUN SPEED — config knob, config-driven everywhere.
// ---------------------------------------------------------------------------
const rules = JSON.parse(read('shared/config/rules.json'));
const inputSrc = read('js/input.js');
const mainSrc = read('js/main.js');
const uiSrc = read('js/ui.js');
const physSrc = read('shared/physics.js');
const refSrc = read('shared/referee.js');
const html = read('index.html');

console.log('\n [1] RUN SPEED (config knob)');
ok(typeof rules.moveSpeed === 'number' && rules.moveSpeed > 0,
  `rules.moveSpeed is a positive number (= ${rules.moveSpeed})`);
// It was raised +50% (6 -> 9) this build; assert it's ABOVE the old 6 so a silent revert is caught,
// but DON'T freeze the exact value (it's hot-tunable — VRmike will retune).
ok(rules.moveSpeed >= 6, `rules.moveSpeed >= 6 (retunable; currently ${rules.moveSpeed})`);
// Read from config on BOTH the host (referee + physics) AND the client (main.js) — never a literal.
ok(/rules\.moveSpeed/.test(mainSrc), 'js/main.js reads rules.moveSpeed (client prediction)');
ok(/this\.rules\.moveSpeed/.test(physSrc), 'shared/physics.js reads this.rules.moveSpeed (host substep)');
ok(/this\.rules\.moveSpeed/.test(refSrc), 'shared/referee.js reads this.rules.moveSpeed (host 2D fallback)');

// ---------------------------------------------------------------------------
// 2. MOUSE SENSITIVITY — live multiplier, persisted, PC-only.
// ---------------------------------------------------------------------------
console.log('\n [2] MOUSE SENSITIVITY (slider + persistence)');
ok(SENSITIVITY_RANGE && SENSITIVITY_RANGE.min > 0 && SENSITIVITY_RANGE.max > SENSITIVITY_RANGE.min,
  `SENSITIVITY_RANGE is a valid band (${SENSITIVITY_RANGE.min}×–${SENSITIVITY_RANGE.max}×)`);
ok(SENSITIVITY_RANGE.default === 1, `default is 1.0× (matches historical feel) (= ${SENSITIVITY_RANGE.default})`);
ok(SENSITIVITY_RANGE.min <= 0.2 && SENSITIVITY_RANGE.max >= 3,
  `range covers at least 0.2×–3× (VRmike's ask) (= ${SENSITIVITY_RANGE.min}–${SENSITIVITY_RANGE.max})`);
// input.js: base constant + multiplier applied in setSensitivity; mousemove uses this.sensitivity.
ok(/BASE_SENSITIVITY\s*=\s*0\.0022/.test(inputSrc), 'input.js keeps BASE_SENSITIVITY = 0.0022 (1.0× == old feel)');
ok(/setSensitivity\s*\(/.test(inputSrc), 'input.js exposes setSensitivity(mult)');
ok(/this\.sensitivity\s*=\s*BASE_SENSITIVITY\s*\*/.test(inputSrc),
  'input.js scales sensitivity = BASE × multiplier');
ok(/movementX\s*\*\s*this\.sensitivity/.test(inputSrc), 'desktop mouse-look uses this.sensitivity');
// touch drag-look must stay a SEPARATE, untouched knob (this slider is PC mouse-look only).
ok(/touchLookSens/.test(inputSrc), 'touch drag-look (touchLookSens) still a separate knob (untouched)');

// main.js: localStorage (NOT cookie) save/load + apply on boot + wire live change with persist.
ok(/const\s+SENS_KEY\s*=\s*['"]prophunt\.sensitivity['"]/.test(mainSrc), 'main.js has a SENS_KEY localStorage key');
ok(/localStorage\.setItem\(SENS_KEY/.test(mainSrc), 'main.js saves sensitivity to localStorage');
ok(/localStorage\.getItem\(SENS_KEY/.test(mainSrc), 'main.js loads sensitivity from localStorage');
ok(!/document\.cookie/.test(mainSrc), 'main.js does NOT use cookies (localStorage only, per spec)');
ok(/input\.setSensitivity\(/.test(mainSrc), 'main.js applies the loaded value to input.setSensitivity');
ok(/onSensitivityChange\s*=/.test(mainSrc) && /saveSensitivity\(/.test(mainSrc),
  'main.js wires live slider change → apply + persist');

// ui.js: label render, PC-only gating (same prefersTouchControls check), live 'input' event.
ok(/setSensitivityValue\s*\(/.test(uiSrc), 'ui.js exposes setSensitivityValue()');
ok(/pauseSensRow[\s\S]{0,120}prefersTouchControls\(\)[\s\S]{0,60}add\(['"]hidden['"]\)/.test(uiSrc)
  || /prefersTouchControls\(\)\)\s*this\.el\.pauseSensRow\.classList\.add\(['"]hidden['"]\)/.test(uiSrc),
  'ui.js hides the sensitivity row on touch (PC-only)');
ok(/pauseSens\.addEventListener\(['"]input['"]/.test(uiSrc),
  "ui.js updates sensitivity live on the slider's 'input' event (drag)");

// index.html: the slider element with the right bounds.
ok(/id="pauseSens"[^>]*type="range"/.test(html), 'index.html has the #pauseSens range slider');
ok(/id="pauseSens"[^>]*min="0\.2"[^>]*max="3"/.test(html), 'index.html slider bounds are 0.2–3');
ok(/id="pauseSensRow"/.test(html) && /id="pauseSensVal"/.test(html), 'index.html has the row + value label');

// ---------------------------------------------------------------------------
// 3. PC CONTROLS REFERENCE panel — present, single-source, touch-hidden.
// ---------------------------------------------------------------------------
console.log('\n [3] PC CONTROLS REFERENCE panel');
ok(/id="controlsRef"/.test(html), 'index.html has the #controlsRef panel');
ok(/id="controlsRefToggle"/.test(html) && /id="controlsRefBody"/.test(html),
  'index.html has the collapse toggle + body');
// It starts with class "hidden" in HTML; ui.buildControlsRef reveals it on PC / keeps it hidden on touch.
ok(/id="controlsRef"[^>]*class="[^"]*\bhidden\b/.test(html),
  'the panel is .hidden in markup (revealed by ui.buildControlsRef on PC)');
ok(/buildControlsRef\s*\(/.test(uiSrc), 'ui.js has buildControlsRef()');
// ONE source of truth: the corner panel is populated from the SAME _controlsHtml() rows as the pause
// "Controls" panel, so the two lists can't drift.
ok(/buildControlsRef[\s\S]{0,300}_controlsHtml\(\)/.test(uiSrc),
  'buildControlsRef populates from _controlsHtml() (single source of truth)');
ok(/buildControlsRef[\s\S]{0,300}prefersTouchControls\(\)/.test(uiSrc),
  'buildControlsRef hides the panel on touch (mobile shows its own buttons)');
ok(/ui\.buildControlsRef\(\)/.test(mainSrc), 'main.js calls ui.buildControlsRef() at boot');
// The desktop control rows cover every binding VRmike listed (move/jump/tools/fire/taunt/pause).
const rows = uiSrc.slice(uiSrc.indexOf('_controlsHtml'));
for (const [needle, label] of [
  ['WASD', 'move'], ['Space', 'jump'], ['1 / 2 / 3', 'tools 1/2/3'],
  ['Left-click', 'fire'], ['T', 'taunt (T)'], ['Esc', 'pause (Esc)'],
]) {
  ok(rows.includes(needle), `controls list includes ${label} binding ("${needle}")`);
}

if (fails) {
  console.error(`\nPC feel/controls check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nPC feel/controls check passed');
