#!/usr/bin/env node
// Offline acceptance check for the FLICKER FIX (2026-07-13, for Jie via VRmike).
// AUTHORING-ONLY — never imported by the page or shipped to a browser (like
// tools/check-blindfold.mjs). Run from a shell:
//
//     node tools/check-flicker.mjs
//
// WHY THIS EXISTS. The hunter and the prop a player is disguised as strobed/blinked
// from certain camera angles. Root cause is three.js FRUSTUM CULLING with stale bounds:
//   (a) the hunter is a SKINNED, animated mesh — the animation swings geometry outside
//       the bind-pose bounding sphere, so mid-stride the renderer judges him "off-screen"
//       and culls (blinks) him;
//   (b) disguise GLBs are cloned + RESCALED at runtime, so their bounding volumes can lag
//       the new scale and cull from oblique angles.
// The fix marks every PLAYER-ATTACHED mesh frustumCulled=false (culling can never skip
// them) and refreshes the geometry bounds after a swap/rescale. World props/scenery keep
// their normal culling. The single choke point is scene.js preparePlayerModel(), which
// meshForPlayer() routes EVERY player mesh (hunter / disguise / capsule) through.
//
// This repo has been burned before by a later refactor silently dropping exactly such a
// rendering flag (see check-blindfold.mjs's story). A headless check can't SEE the strobe,
// so it asserts the CODE PATH that prevents it, statically.

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

console.log('flicker (frustum-cull) acceptance check');

const sceneSrc = read('js', 'scene.js');

// Pull out a named function/method body: from `NAME(...) {` to the matching close at the
// same brace depth. Handles both module-level `export function foo(` and class methods.
function extractFn(src, name) {
  const m = new RegExp('(?:function\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!m) return '';
  let i = m.index + m[0].length - 1; // at the opening brace
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return src.slice(m.index);
}

// ---------------------------------------------------------------------------
// 1) THE CHOKE POINT EXISTS AND DOES BOTH JOBS. preparePlayerModel must (a) traverse
//    the model, (b) turn frustum culling OFF on every mesh, and (c) refresh the geometry
//    bounds — the two-part fix (never-cull + fresh bounds after swap/rescale).
// ---------------------------------------------------------------------------
const prep = extractFn(sceneSrc, 'preparePlayerModel');
ok(prep.length > 0, 'scene.js defines preparePlayerModel()');
ok(/export function preparePlayerModel/.test(sceneSrc), 'preparePlayerModel is exported (shared with the editor / future callers)');
ok(/\.traverse\s*\(/.test(prep), 'preparePlayerModel traverses the WHOLE model (every sub-mesh, not just the root)');
ok(/frustumCulled\s*=\s*false/.test(prep), 'preparePlayerModel sets frustumCulled = false (renderer can never cull an animated/rescaled player mesh)');
ok(/computeBoundingSphere\s*\(/.test(prep), 'preparePlayerModel recomputes the bounding SPHERE (frustum test + fresh after rescale)');
ok(/computeBoundingBox\s*\(/.test(prep), 'preparePlayerModel recomputes the bounding BOX (keeps aim raycast / highlight box accurate)');
ok(/o\.isMesh/.test(prep), 'preparePlayerModel gates on isMesh (skips lights/bones/groups)');

// ---------------------------------------------------------------------------
// 2) EVERY PLAYER MESH IS ROUTED THROUGH IT. meshForPlayer is the ONE builder both the
//    remote path (syncPlayers, animated) and the self path (_syncSelf) use; it must return
//    through preparePlayerModel so the hunter (skinned), the disguise (GLB + primitive) and
//    the capsule are ALL covered by one guarantee no branch can bypass.
// ---------------------------------------------------------------------------
const meshFor = extractFn(sceneSrc, 'meshForPlayer');
ok(meshFor.length > 0, 'scene.js defines meshForPlayer()');
ok(/return\s+preparePlayerModel\s*\(/.test(meshFor), 'meshForPlayer returns through preparePlayerModel (single guaranteed choke point)');
// meshForPlayer must not have OTHER returns that skip the wrapper (a raw `return mesh` would
// leave a player-attached mesh cullable). The builder body was split into _buildPlayerMesh so
// meshForPlayer has exactly the one wrapped return.
const otherReturns = (meshFor.match(/\breturn\b/g) || []).length;
ok(otherReturns === 1, `meshForPlayer has exactly one return, and it is the wrapped one (found ${otherReturns})`);
ok(/_buildPlayerMesh\s*\(/.test(meshFor), 'meshForPlayer delegates construction to _buildPlayerMesh (all appearance branches live there, behind the wrapper)');

// Both consumers go through meshForPlayer (not a private builder) so nothing dodges the flag.
ok(/this\.meshForPlayer\(p,\s*\{\s*animated:\s*true\s*\}\)/.test(sceneSrc), 'syncPlayers builds REMOTE players (incl. the animated hunter) via meshForPlayer');
ok(/this\.selfMesh\s*=\s*this\.meshForPlayer\(p\)/.test(sceneSrc), '_syncSelf builds the LOCAL player (own disguise/body) via meshForPlayer');

// ---------------------------------------------------------------------------
// 3) DEFENCE IN DEPTH on the two hand-built player-attached models the fix targets.
//    Even though (2) already covers them, keep the flag at the rig/viewmodel sites so a
//    future edit that reshapes meshForPlayer can't silently un-fix the strobe.
// ---------------------------------------------------------------------------
// (a) The skinned hunter rig itself marks its meshes never-cull (the (a) root cause).
const buildHunter = extractFn(sceneSrc, '_buildHunterModel');
ok(/frustumCulled\s*=\s*false/.test(buildHunter), '_buildHunterModel marks the SKINNED rig frustumCulled=false (animation can never blink the hunter)');

// (b) The first-person held viewmodel (rifle/box parented to the camera) — the local
//     hunter's own weapon — also never culls (it swings with the camera at the frustum edge).
const buildVM = extractFn(sceneSrc, '_buildViewModel');
ok(/frustumCulled\s*=\s*false/.test(buildVM), '_buildViewModel marks the first-person viewmodel frustumCulled=false');

// (c) B7 HELD-TOOL SWAP: the third-person grenade/finder meshes on the hunter's wrist are new
//     player-attached models — they MUST also opt out of culling or a switched-to tool would
//     blink at the screen edge exactly like the strobe bug. Both the primitive builder and the
//     bone-scaler flag them (belt-and-braces on top of the meshForPlayer choke point).
const buildHeld = extractFn(sceneSrc, '_buildHeldPrimitive');
ok(buildHeld.length > 0, 'scene.js defines _buildHeldPrimitive() (the B7 grenade/finder held meshes)');
ok(/frustumCulled\s*=\s*false/.test(buildHeld), '_buildHeldPrimitive marks the held grenade/finder frustumCulled=false (no strobe on a tool swap)');
const scaleHeld = extractFn(sceneSrc, '_scaleHeldToBone');
ok(/frustumCulled\s*=\s*false/.test(scaleHeld), '_scaleHeldToBone marks the scaled held tool frustumCulled=false (covers the rifle path too)');

// ---------------------------------------------------------------------------
// 4) WORLD PROPS ARE LEFT ALONE (the fix is surgical — only player-attached models opt
//    out of culling; scenery keeps the optimization). The scenery/prop builders and the
//    shared instantiateModel must NOT blanket-disable culling.
// ---------------------------------------------------------------------------
const instModel = extractFn(sceneSrc, 'instantiateModel');
ok(!/frustumCulled/.test(instModel), 'instantiateModel (world decor + disguise share it) does NOT itself disable culling — the player-only flag lives at meshForPlayer, so scenery keeps its optimization');

// ---------------------------------------------------------------------------
// 5) SECONDARY SUSPECT (visibility flap). entry.mesh.visible must be driven by the
//    authoritative `alive` flag, which the referee sets true at spawn and only false on
//    death (monotonic within a round) — so visibility can't strobe between snapshots. Assert
//    the snapshot carries `alive` and the mesh visibility reads it (not some derived toggle).
// ---------------------------------------------------------------------------
const refSrc = read('shared', 'referee.js');
ok(/alive:\s*p\.alive/.test(refSrc), 'referee snapshot carries the authoritative alive flag (never omitted → no undefined→hidden flap)');
ok(/\.visible\s*=\s*p\.alive/.test(sceneSrc), 'scene drives mesh visibility straight off snapshot alive (no per-frame visibility toggling that could strobe)');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nflicker check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nflicker check passed');
