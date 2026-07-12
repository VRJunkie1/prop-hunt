#!/usr/bin/env node
// Offline acceptance check for the HUNTER BLINDFOLD + the render-loop contract.
// AUTHORING-ONLY — never imported by the page or shipped to a browser (like
// tools/check-physics-feel.mjs / measure-glbs.mjs). Run from a shell:
//
//     node tools/check-blindfold.mjs
//
// WHY THIS EXISTS (bugfix attempt #2, 2026-07-11). VRmike's playtest: a PROP in the
// HUNT phase saw a solid dark blue/purple screen — the HUD ticked but the 3D world
// never drew, for EVERYONE. Root cause was NOT the blindfold (its gate + overlay were
// correct). It was js/main.js's render loop calling scene.aimedDisguiseTarget() and
// scene.highlightProp() — methods that did NOT exist in js/scene.js (a half-landed
// crosshair-disguise refactor). The throw fired every frame BEFORE scene.render() and
// the requestAnimationFrame re-arm, so the loop died while the network-driven HUD kept
// updating. The never-rendered transparent canvas showed the body's dark CSS gradient.
//
// A headless check can't "see" the screen, so it asserts the DECISIONS + the CONTRACT:
//   1) every scene.* method the render loop calls actually exists in scene.js (the
//      exact regression that broke this — a static guard that would have caught it);
//   2) (a) a PROP during HIDING computes NOT blindfolded, (b) a HUNTER during HIDING
//      computes blindfolded, (c) the same HUNTER after HUNTING computes NOT blindfolded;
//   3) (d) the server withholds prop data ONLY from a blinded hunter and resumes full
//      data at HUNTING (blindHunterSnapshot + the referee's gate spelling).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE, PHASE } from '../shared/protocol.js';
import { blindHunterSnapshot } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('blindfold + render-loop acceptance check');

// ---------------------------------------------------------------------------
// 1) RENDER-LOOP CONTRACT: every scene.<method>() called in main.js must be
//    defined in scene.js. This is the exact bug — a call to a missing scene method
//    throws each frame and kills rendering for everyone. Catch it statically.
// ---------------------------------------------------------------------------
const mainSrc = read('js', 'main.js');
const sceneSrc = read('js', 'scene.js');
// js/debug.js (?debug=1 menu) also calls scene.* methods (setFreeCam / updateFreeCam /
// debugPick / setFocusBox). The original blindfold bug — a call to a scene method that
// didn't exist blanking the render loop — can just as easily land from debug.js, which the
// old check didn't scan. Widen the guard to cover it. debug.js uses a `scene` local (const
// scene = this.getScene()), so the same alias regex catches its calls.
const debugSrc = read('js', 'debug.js');

// Collect method-call names on the scene object (`scene.NAME(` and the `s.NAME(`
// alias from ensureScene().then((s) => s.NAME(...)). Property reads without a call
// (scene.thirdPerson, s.renderer) are excluded by requiring a following `(`.
const called = new Set();
for (const src of [mainSrc, debugSrc]) {
  for (const m of src.matchAll(/(?:^|[^\w.])(?:scene|s)\.([a-zA-Z_]\w*)\s*\(/g)) called.add(m[1]);
}

// A method is "defined" in scene.js if it appears as a class-method declaration:
// `  NAME(args) {` (not preceded by a dot, which would be a call).
const definedInScene = (name) =>
  new RegExp('(^|[^\\w.])' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm').test(sceneSrc);

ok(called.size > 0, `found scene method calls in main.js (${[...called].join(', ')})`);
for (const name of called) ok(definedInScene(name), `scene.${name}() is defined in js/scene.js`);
// Name the two that regressed explicitly, so the intent is obvious in the output.
ok(definedInScene('aimedDisguiseTarget'), 'crosshair disguise: scene.aimedDisguiseTarget() exists');
ok(definedInScene('highlightProp'), 'crosshair disguise: scene.highlightProp() exists');
// Debug menu (?debug=1) scene seams — the free cam + focus box + inspect entry points
// js/debug.js drives. A missing one would blank the render loop exactly like the original bug.
ok(definedInScene('setFreeCam'), 'debug menu: scene.setFreeCam() exists');
ok(definedInScene('updateFreeCam'), 'debug menu: scene.updateFreeCam() exists');
ok(definedInScene('debugPick'), 'debug menu: scene.debugPick() exists');
ok(definedInScene('setFocusBox'), 'debug menu: scene.setFocusBox() exists');

// ---------------------------------------------------------------------------
// 2) BLINDFOLD DECISION (client). main.js derives it fresh every snapshot/phase
//    event as (role === HUNTER && phase === HIDING). Assert the exact expression is
//    still in the code, then evaluate the three required cases through that same rule.
// ---------------------------------------------------------------------------
ok(
  /state\.role === ROLE\.HUNTER && state\.phase === PHASE\.HIDING/.test(mainSrc),
  'main.js updateBlindfold derives (role === HUNTER && phase === HIDING)'
);
// The exact rule the client uses, evaluated here against the real protocol constants.
const computeBlind = (role, phase) => role === ROLE.HUNTER && phase === PHASE.HIDING;
ok(computeBlind(ROLE.PROP, PHASE.HIDING) === false, '(a) PROP during HIDING -> NOT blindfolded (sees the world)');
ok(computeBlind(ROLE.HUNTER, PHASE.HIDING) === true, '(b) HUNTER during HIDING -> blindfolded');
ok(computeBlind(ROLE.HUNTER, PHASE.HUNTING) === false, '(c) HUNTER after HUNTING starts -> NOT blindfolded');
// Props are never blindfolded in ANY phase; a late joiner / role swap re-derives fresh.
ok(computeBlind(ROLE.PROP, PHASE.HUNTING) === false, 'PROP is never blindfolded in HUNTING either');
ok(computeBlind(ROLE.HUNTER, PHASE.LOBBY) === false, 'HUNTER not blindfolded in the lobby');

// ---------------------------------------------------------------------------
// 3) DATA HALF (server, authoritative). blindHunterSnapshot strips prop-role players
//    and all dynamic-prop transforms; the referee applies it ONLY for a hunter during
//    HIDING (gate spelling asserted statically) and hands out the full stream otherwise.
// ---------------------------------------------------------------------------
const full = {
  t: 'snapshot',
  phase: PHASE.HIDING,
  timeLeft: 5,
  players: [
    { id: 'h1', hunter: true, x: 0, y: 0, z: 0 },
    { id: 'p1', hunter: false, disguise: 'crate', x: 3, y: 0, z: 3 },
    { id: 'p2', hunter: false, x: -4, y: 0, z: 2 },
  ],
  props: [{ id: 1, x: 3, y: 0, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 }],
};
const blinded = blindHunterSnapshot(full);
ok(blinded.props.length === 0, '(d) blinded hunter snapshot withholds ALL prop transforms');
ok(blinded.players.every((p) => p.hunter), '(d) blinded hunter snapshot strips every PROP-role player');
ok(blinded.players.some((p) => p.id === 'h1'), '(d) blinded hunter snapshot keeps hunter entries');
ok(full.props.length === 1 && full.players.length === 3, '(d) blindHunterSnapshot does not mutate the full snapshot');

const refSrc = read('shared', 'referee.js');
ok(
  /p\.role === ROLE\.HUNTER && this\.phase === PHASE\.HIDING/.test(refSrc),
  '(d) referee gate withholds prop data only for HUNTER during HIDING (full stream resumes at HUNTING)'
);

// ---------------------------------------------------------------------------
// 4) VISUAL HALF wiring — the overlay must exist and be a plain, non-latched toggle
//    so a prop's blind=false always hides it (the original attempt-1 crash was a
//    missing setBlindfold + overlay). Cheap structural guards.
// ---------------------------------------------------------------------------
const html = read('index.html');
ok(/id="blindfold"/.test(html) && /id="blindfoldTimer"/.test(html), 'index.html has the #blindfold overlay + #blindfoldTimer');
const uiSrc = read('js', 'ui.js');
ok(/setBlindfold\s*\(/.test(uiSrc) && /classList\.toggle\('hidden',\s*!blind\)/.test(uiSrc), 'ui.setBlindfold is a plain show/hide (never latches)');
const css = read('css', 'style.css');
ok(/\.hidden\s*\{\s*display:\s*none\s*!important/.test(css), 'css .hidden uses !important (beats .blindfold display so a prop is truly hidden)');

// ---------------------------------------------------------------------------
// 5) HUNTER MODEL + FIRST-PERSON + CENTERED RETICLE/RAYCAST (this build). Static
//    guards for the three fixes that can't be seen headless (owed a live 2-player
//    pass): the model is MEASURED not magic-numbered, hunters are first-person, the
//    reticle is dead-centre, and the disguise ray fires from the camera centre.
// ---------------------------------------------------------------------------
// (a) The hunter model's scale + foot-offset come from a MEASURED bounding box of the
//     loaded GLB, not a hardcoded fallback. Assert the measurement path is present:
//     a Box3.setFromObject, a scale derived from the measured height (targetH / size.y),
//     and a foot offset from the measured min-y (-box2.min.y). If someone replaced these
//     with a constant scale / y-offset, these regexes go dark.
const buildHunter = (sceneSrc.match(/_buildHunterModel\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
ok(/setFromObject\(inner\)/.test(buildHunter), 'scene _buildHunterModel measures the loaded GLB (Box3.setFromObject)');
ok(/targetH\s*\/\s*size\.y/.test(buildHunter), 'scene hunter SCALE derives from measured bbox height (targetH / size.y), not a magic number');
ok(/-box2\.min\.y/.test(buildHunter), 'scene hunter FOOT offset derives from the measured bbox min-y (-box2.min.y), not a hardcoded lift');
ok(/heightMeters/.test(read('shared', 'config', 'character-models.json')), 'character-models.json supplies the target heightMeters the measured scale matches');

// (b) FIRST-PERSON HUNTERS. main.js drives the view off role (HUNTER => first-person,
//     i.e. setThirdPerson(false)); scene only draws the self body when third-person OR
//     the free cam is flying (so a first-person hunter shows no own body, but the debug
//     fly-cam still reveals it).
ok(/setThirdPerson\(state\.role !== ROLE\.HUNTER\)/.test(mainSrc), 'main.js makes HUNTERS first-person (setThirdPerson false for the hunter role)');
ok(/_wantSelfMesh\s*\(\)\s*\{[\s\S]*?thirdPerson\s*\|\|\s*this\._freeCam/.test(sceneSrc), 'scene draws the own body only in third-person OR free cam (first-person hunter = no self body; fly-cam still shows it)');

// (c) ONE CENTERED RETICLE. The #crosshair is fixed dead-centre by CSS, and nothing
//     floats it any more (the old aimScreenPoint pathway is gone from both files).
const crossRule = (css.match(/#crosshair\s*\{[\s\S]*?\}/) || [''])[0];
ok(/top:\s*50%/.test(crossRule) && /left:\s*50%/.test(crossRule) && /translate\(-50%,\s*-50%\)/.test(crossRule),
  'css #crosshair is pinned to the exact screen centre (top/left 50% + translate(-50%,-50%))');
ok(!/aimScreenPoint/.test(mainSrc) && !/aimScreenPoint/.test(sceneSrc), 'the floating-reticle path (aimScreenPoint) is fully removed — one crosshair system');

// (d) DISGUISE RAY FROM CAMERA CENTRE. aimedDisguiseTarget raycasts through SCREEN_CENTER
//     (the shared screen-centre NDC, same as debugPick), not a player-origin cast.
const aimTgt = (sceneSrc.match(/aimedDisguiseTarget\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
ok(/setFromCamera\(SCREEN_CENTER/.test(aimTgt), 'scene aimedDisguiseTarget fires from the CAMERA CENTRE (setFromCamera(SCREEN_CENTER)) — through the reticle');
ok(/const SCREEN_CENTER = new THREE\.Vector2\(0, 0\)/.test(sceneSrc), 'scene defines the shared SCREEN_CENTER (0,0 NDC) used by both the disguise pick and debugPick');
ok(/setFromCamera\(SCREEN_CENTER/.test((sceneSrc.match(/debugPick\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0]), 'debugPick uses the SAME SCREEN_CENTER ray (unified crosshair/raycast)');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nblindfold check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nblindfold check passed');
