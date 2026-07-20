#!/usr/bin/env node
// Offline acceptance check for the HELD-ITEM ALIGNMENT TUNER (attempt 4, human-in-the-loop, VRmike
// 2026-07-20). AUTHORING-ONLY — never imported by the page or shipped (like check-tool-visibility.mjs /
// check-blindfold.mjs). Run:
//
//     node tools/check-item-tuner.mjs
//
// WHY THIS EXISTS. Automated offset guessing (builds #190/#208/#212) kept missing because the rifle/
// grenade/finder are placed by TWO independent code paths reading DIFFERENT numbers (first-person
// viewmodel vs third-person character model). Instead of a 5th blind guess, VRmike gets a live tuner in
// the ?debug=1 menu. A headless check CANNOT render, so — honestly — it does NOT prove the item looks
// right (that's VRmike's eyeball, the whole point of human-in-the-loop). It proves the WIRING:
//   1) the pure merge/normalize/export core behaves (override layers over defaults; export round-trips);
//   2) BOTH mount sites read the override object (source/wiring assertion — the values REACH both paths);
//   3) with no override the shipped placement is untouched (a normal launch is byte-for-byte unchanged);
//   4) the debug UI is gated on ?debug=1 and persists via localStorage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

// Pull out a named function/method body: from `NAME(...) {` to the matching close brace.
function extractFn(src, name) {
  const m = new RegExp('(?:function\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!m) return '';
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return src.slice(m.index);
}

console.log('held-item alignment tuner acceptance check');

// ---------------------------------------------------------------------------
// 1) THE PURE CORE (real logic, exercised — not just "code exists"). shared/item-tuner.js is the
//    single source of truth for merge/normalize/serialize that debug.js + scene.js + this check share.
// ---------------------------------------------------------------------------
const tuner = await import('../shared/item-tuner.js');
const { TUNER_ITEMS, zeroTuning, normalizeItem, normalizeTuning, isDefaultTuning, exportTuning, importTuning } = tuner;

ok(Array.isArray(TUNER_ITEMS) && ['rifle', 'finder', 'grenade'].every((id) => TUNER_ITEMS.includes(id)),
  'TUNER_ITEMS covers rifle + finder + grenade (each tuned independently)');

// zeroTuning = the shipped-defaults-untouched layer.
const z = zeroTuning();
ok(z.position.x === 0 && z.position.y === 0 && z.position.z === 0 &&
   z.rotationDeg.pitch === 0 && z.rotationDeg.yaw === 0 && z.rotationDeg.roll === 0 && z.scale === 1,
  'zeroTuning() is a no-op layer (0 offset, 0 rotation, scale 1)');

// normalizeItem: garbage in → safe defaults; scale must stay > 0 (a 0/negative can't collapse/mirror).
const g = normalizeItem({ position: { x: 'nope', y: 2 }, rotationDeg: { yaw: 'x', roll: 5 }, scale: 0 });
ok(g.position.x === 0 && g.position.y === 2 && g.rotationDeg.yaw === 0 && g.rotationDeg.roll === 5,
  'normalizeItem coerces non-finite fields to 0 and keeps valid numbers');
ok(g.scale === 1, 'normalizeItem forces a non-positive scale back to 1 (no collapsed/mirrored mesh)');
ok(normalizeItem(undefined).scale === 1 && normalizeItem(null).position.z === 0, 'normalizeItem tolerates undefined/null');

// normalizeTuning always yields every item present (scene.js reads item ids directly).
const full = normalizeTuning({ rifle: { position: { z: 0.1 } } });
ok(TUNER_ITEMS.every((id) => full[id] && full[id].position && full[id].rotationDeg && 'scale' in full[id]),
  'normalizeTuning returns every item present + normalized (partial override → others zeroed)');
ok(full.rifle.position.z === 0.1 && full.finder.position.z === 0 && full.grenade.scale === 1,
  'a per-item override does NOT bleed into the other items (independent tuning)');

// merge-over-defaults / no-override discipline.
ok(isDefaultTuning(null) === true && isDefaultTuning({}) === true && isDefaultTuning(normalizeTuning(null)) === true,
  'isDefaultTuning: no override (null/empty/all-zero) reads as DEFAULT → shipped placement untouched');
ok(isDefaultTuning({ grenade: { scale: 1.2 } }) === false && isDefaultTuning({ rifle: { position: { y: 0.03 } } }) === false,
  'isDefaultTuning: any nudge (position/rotation/scale, any item) reads as NON-default');

// export round-trips to VALID, bakeable config.
const store = normalizeTuning({ rifle: { position: { x: 0.02, z: -0.05 }, rotationDeg: { yaw: 12 }, scale: 1.1 }, grenade: { position: { y: -0.03 } } });
const text = exportTuning(store);
let parsed = null;
try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
ok(parsed && typeof parsed === 'object', 'exportTuning produces VALID JSON');
ok(parsed && parsed.heldItemTuning && TUNER_ITEMS.every((id) => parsed.heldItemTuning[id]),
  'exported block is shaped for shared/config (heldItemTuning with every item)');
ok(parsed && typeof parsed._comment === 'string' && /bake/i.test(parsed._comment),
  'exported block self-documents how to bake it in (a _comment, like the other config files)');
const back = importTuning(text);
ok(back.rifle.position.x === 0.02 && back.rifle.position.z === -0.05 && back.rifle.rotationDeg.yaw === 12 &&
   Math.abs(back.rifle.scale - 1.1) < 1e-9 && back.grenade.position.y === -0.03,
  'importTuning(exportTuning(x)) round-trips the tuned values exactly');
ok(importTuning(JSON.stringify(store)).rifle.rotationDeg.yaw === 12, 'importTuning also accepts a bare item map (not just the wrapped block)');

// ---------------------------------------------------------------------------
// 2) BOTH MOUNT SITES READ THE OVERRIDE. The two independent placement paths (first-person viewmodel +
//    third-person character model) each layer the override on top of their shipped-default transform.
//    Source assertions (headless can't render) — proves the values REACH both paths, per the plan.
// ---------------------------------------------------------------------------
const sceneSrc = read('js', 'scene.js');

// The override store lives on the scene and defaults to null (no override installed → defaults).
ok(/this\._itemTuner\s*=\s*null/.test(sceneSrc), 'scene: _itemTuner defaults to null (no override until ?debug=1 installs one)');
const setTuner = extractFn(sceneSrc, 'setItemTuner');
ok(setTuner.length > 0, 'scene: defines setItemTuner() (the debug-menu entry point)');
ok(/this\._itemTuner\s*=\s*overrides/.test(setTuner), 'scene: setItemTuner stores the override store');
ok(/this\._applyItemTunerToViewModel\(\)/.test(setTuner), 'scene: setItemTuner re-applies to the FIRST-PERSON viewmodel');
ok(/entry\.hunterCtl/.test(setTuner) && /_applyItemTunerToCtl/.test(setTuner), 'scene: setItemTuner re-applies to every THIRD-PERSON hunter model');

// Mount site A — third-person character model (_buildHunterModel).
const buildHunter = extractFn(sceneSrc, '_buildHunterModel');
ok(/m\.userData\.tunerBase\s*=/.test(buildHunter), '_buildHunterModel records each held mesh\'s SHIPPED-DEFAULT transform (tunerBase)');
ok(/gripFrame\s*=\s*\{[^}]*qiBuild/.test(buildHunter), '_buildHunterModel captures the build-time wrist frame (character-space → bone-local conversion)');
ok(/grip:\s*gripFrame/.test(buildHunter), '_buildHunterModel stores the grip frame on the controller');
ok(/this\._applyItemTunerToCtl\(ctl\)/.test(buildHunter), '_buildHunterModel applies the override at build (so a respawn/round flip keeps the tuning)');
const applyCtl = extractFn(sceneSrc, '_applyItemTunerToCtl');
ok(applyCtl.length > 0, 'scene: defines _applyItemTunerToCtl()');
ok(/m\.userData\.tunerBase/.test(applyCtl) && /this\._tunerFor\(/.test(applyCtl), '_applyItemTunerToCtl layers the override over the recorded base');
ok(/base\.pos/.test(applyCtl) && /base\.quat/.test(applyCtl) && /base\.scale/.test(applyCtl), '_applyItemTunerToCtl drives position + rotation + scale');

// Mount site B — first-person viewmodel (setViewModel / _buildViewModel).
const setVM = extractFn(sceneSrc, 'setViewModel');
ok(/g\.userData\.tunerBase\s*=/.test(setVM), 'setViewModel records the viewmodel\'s SHIPPED-DEFAULT transform (tunerBase)');
ok(/this\._applyItemTunerToViewModel\(\)/.test(setVM), 'setViewModel applies the override so a tool switch keeps the tuning');
const applyVM = extractFn(sceneSrc, '_applyItemTunerToViewModel');
ok(applyVM.length > 0, 'scene: defines _applyItemTunerToViewModel()');
ok(/this\._tunerFor\(this\._viewModelTool\)/.test(applyVM), '_applyItemTunerToViewModel reads the override for the equipped viewmodel tool');
ok(/base\.pos/.test(applyVM) && /base\.scale/.test(applyVM), '_applyItemTunerToViewModel layers over the recorded base (defaults untouched when zero)');

// _tunerFor is the single read of the override store (never returns null → callers stay branch-free).
const tunerFor = extractFn(sceneSrc, '_tunerFor');
ok(/this\._itemTuner/.test(tunerFor) && /position/.test(tunerFor) && /rotationDeg/.test(tunerFor), '_tunerFor reads _itemTuner and defaults to a zeroed override');

// ---------------------------------------------------------------------------
// 3) THE DEBUG UI: gated on ?debug=1, persisted in localStorage, exports through the shared core.
// ---------------------------------------------------------------------------
const debugSrc = read('js', 'debug.js');
ok(/import\s*\{[^}]*\}\s*from\s*'[^']*item-tuner\.js'/.test(debugSrc), 'debug.js imports the shared item-tuner core (no copy-paste of the merge/export logic)');
ok(/import\s*\{[^}]*\}\s*from\s*'[^']*item-tuner\.js'/.test(sceneSrc), 'scene.js imports the shared item-tuner core (setItemTuner normalizes through it)');
ok(/this\._tunerOn\s*=\s*!!\(ctx\s*&&\s*ctx\.debugFlag\)/.test(debugSrc), 'debug.js gates the tuner on ctx.debugFlag (?debug=1) — a normal launch never builds it');
ok(/if\s*\(this\._tunerOn\)\s*this\._buildTunerSection/.test(debugSrc), 'debug.js only builds the tuner section when the flag is on');
ok(/ph_debug_item_tuner/.test(debugSrc), 'debug.js persists tuning under a debug-only localStorage key');
const loadT = extractFn(debugSrc, '_loadTuner');
ok(/localStorage/.test(loadT) && /normalizeTuning/.test(loadT), '_loadTuner reads localStorage and normalizes it (survives respawn/reload)');
const pushT = extractFn(debugSrc, '_pushTuner');
ok(/scene\.setItemTuner\(this\._tuner\)/.test(pushT), '_pushTuner pushes the override into the live scene');
ok(/scene\s*!==\s*this\._tunerScene/.test(extractFn(debugSrc, 'frame')), 'frame() re-pushes on a scene identity change (page reload / new match)');
const stepT = extractFn(debugSrc, '_tunerStep');
ok(/this\._saveTuner\(\)/.test(stepT) && /this\._pushTuner\(\)/.test(stepT), 'a stepper nudge saves + pushes live (see it update in both views)');
ok(/this\.ctx\.state\.tool|state\.tool/.test(extractFn(debugSrc, '_renderTuner')) || /state\.tool/.test(debugSrc), 'the tuner tracks the currently-equipped tool');
const exportT = extractFn(debugSrc, '_exportTuner');
ok(/exportTuning\(this\._tuner\)/.test(exportT), '_exportTuner serializes through the shared core');
ok(/select\(\)/.test(exportT) && /clipboard/.test(exportT), '_exportTuner shows a selectable box AND tries the clipboard (phone-safe)');

// main.js already passes debugFlag into the debug menu ctx.
const mainSrc = read('js', 'main.js');
ok(/debugFlag:\s*DEBUG/.test(mainSrc), 'main.js passes debugFlag (?debug=1) into the debug-menu ctx');

// ---------------------------------------------------------------------------
// 4) DEFAULTS UNTOUCHED. This build must not change the shipped held-item numbers in the config.
// ---------------------------------------------------------------------------
const cm = JSON.parse(read('shared', 'config', 'character-models.json'));
const w = cm.hunter && cm.hunter.weapon;
ok(w && w.forwardOffset === 0.22 && w.downOffset === 0.17 && w.scale === 1.0 && w.worldLength === 0.8,
  'character-models.json shipped weapon offsets are UNCHANGED (tuner only, no default change)');
ok(!/heldItemTuning/.test(read('shared', 'config', 'character-models.json')),
  'no baked override committed to config (this build ships the tuner + export only)');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nheld-item tuner check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nheld-item tuner check passed');
