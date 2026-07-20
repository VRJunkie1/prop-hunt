#!/usr/bin/env node
// Offline acceptance check for the HUNTER CHARACTER MODEL v1 (the animated SWAT
// soldier other players see for a remote hunter). AUTHORING-ONLY — never imported by
// the page or shipped to a browser (like tools/check-blindfold.mjs). Run from a shell:
//
//     node tools/check-hunter-model.mjs
//
// HONEST SCOPE (per the approved plan, step 8): the sandbox can't open a 3D model or
// run animations headless, so this asserts the STATIC contract only — the two GLBs are
// present + registered + look like real glTF binaries, the character-model registry is
// wired and self-consistent, the configured clip suffixes are real clips from the
// pack, and every new scene method + the rig-safe (SkeletonUtils) clone + the main.js
// wiring exist. REAL load-and-animate verification needs a live browser after deploy.

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const readJSON = (...p) => JSON.parse(read(...p));

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('hunter character model (v1) acceptance check');

// ---------------------------------------------------------------------------
// 1) REGISTRY: character-models.json parses, is separate from props/fixtures, and
//    declares the hunter body + rifle + the five movement clips + a grip offset.
// ---------------------------------------------------------------------------
let reg = null;
try { reg = readJSON('shared', 'config', 'character-models.json'); } catch (e) { /* handled below */ }
ok(!!reg, 'shared/config/character-models.json exists and parses');
const hunter = reg && reg.hunter;
ok(!!hunter, 'registry has a `hunter` entry');
ok(hunter && typeof hunter.model === 'string' && hunter.model.endsWith('.glb'), 'hunter.model points to a .glb');
ok(hunter && hunter.heightMeters > 0, 'hunter.heightMeters is set (sized to the capsule)');
const clips = (hunter && hunter.clips) || {};
for (const s of ['idle', 'forward', 'backward', 'left', 'right']) {
  ok(typeof clips[s] === 'string' && clips[s].length > 0, `hunter.clips.${s} is declared (${clips[s] || 'MISSING'})`);
}
const weapon = (hunter && hunter.weapon) || {};
ok(typeof weapon.model === 'string' && weapon.model.endsWith('.glb'), 'hunter.weapon.model points to a .glb');
ok(typeof weapon.attachBone === 'string' && weapon.attachBone.length > 0, `hunter.weapon.attachBone is set (${weapon.attachBone})`);
ok(weapon.position && weapon.rotationDeg, 'hunter.weapon has a hot-tunable position + rotation grip offset');
// The soldier must NOT leak into the disguise/collider pipeline.
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
ok(!props.hunter && !fixtures.hunter, 'hunter is NOT in props.json / fixtures.json (never disguisable / collider-baked)');

// ---------------------------------------------------------------------------
// 2) REMOTE RIFLE ANIMATIONS (2026-07-12 fix). Parse the ACTUAL clip list out of the hunter
//    GLB (a .glb is a 12-byte header + chunks; chunk 0 is a plain-text JSON block whose
//    `animations[].name` are the clip names — no 3D math needed) and assert:
//      (a) every configured clip suffix resolves to a real clip in THIS GLB (the same
//          suffix rule scene._resolveClip uses — guards a typo the matcher silently eats);
//      (b) every configured idle/movement clip is a RIFLE/AIM clip (name carries Gun or
//          Shoot), so a remote hunter is NEVER shown the arms-at-sides plain run. This is
//          the static half of the bug fix — the runtime half (mixer plays it) needs a live
//          browser, but a regression that points a movement state back at 'Run'/'Run_Back'
//          (arms-down) now fails the build here.
// ---------------------------------------------------------------------------
// Pull the animation clip names straight out of a .glb's JSON chunk.
function glbClipNames(file) {
  const buf = readFileSync(join(root, 'assets', file));
  if (buf.toString('ascii', 0, 4) !== 'glTF') return null; // not a GLB
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.toString('ascii', 16, 20);
  if (chunkType !== 'JSON') return null;
  let json;
  try { json = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen)); } catch { return null; }
  return (json.animations || []).map((a) => a.name || '');
}
// Match a configured suffix against the GLB's clip names exactly the way scene._resolveClip
// does (exact, then endsWith '|'+suffix, then endsWith suffix).
const resolvesTo = (names, suffix) =>
  names.find((n) => n === suffix) ||
  names.find((n) => n.endsWith('|' + suffix)) ||
  names.find((n) => n.endsWith(suffix)) ||
  null;
// A rifle/aim clip keeps the gun raised — its name carries "Gun" or "Shoot" in this pack.
const isRifleClip = (name) => /gun|shoot/i.test(name || '');

const clipNames = hunter && hunter.model ? glbClipNames(hunter.model) : null;
ok(Array.isArray(clipNames) && clipNames.length > 0, `hunter GLB parses and lists its animation clips (${clipNames ? clipNames.length : 0} found)`);
if (clipNames) {
  for (const s of ['idle', 'forward', 'backward', 'left', 'right']) {
    const name = clips[s];
    const resolved = resolvesTo(clipNames, name);
    ok(!!resolved, `clip "${name}" for ${s} exists in the hunter GLB (resolves to "${resolved || 'NONE'}")`);
    ok(!!resolved && isRifleClip(resolved), `clip for ${s} is a RIFLE/AIM clip (gun stays up), not the arms-at-sides run — "${resolved || name}"`);
  }
}

// ---------------------------------------------------------------------------
// 3) ASSETS present on disk, look like real glTF binaries, and are in the manifest.
// ---------------------------------------------------------------------------
const manifest = readJSON('assets', 'manifest.json');
const inManifest = (file) => manifest.assets.some((a) => a.file === 'assets/' + file);
const looksLikeGlb = (file) => {
  try {
    const p = join(root, 'assets', file);
    if (statSync(p).size < 1000) return false; // a real character/weapon GLB is far bigger
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    return buf.toString('ascii') === 'glTF'; // glb magic
  } catch { return false; }
};
for (const file of [hunter && hunter.model, weapon && weapon.model].filter(Boolean)) {
  ok(looksLikeGlb(file), `assets/${file} exists and is a real glTF binary (glTF magic, non-trivial size)`);
  ok(inManifest(file), `assets/${file} is recorded in assets/manifest.json`);
}

// ---------------------------------------------------------------------------
// 4) CODE WIRING: config loads the registry; scene defines every new method + does a
//    RIG-SAFE clone (SkeletonUtils, not a plain .clone); main.js drives the mixers and
//    passes the registry into buildWorld. (The generic "every scene.X() called in
//    main.js is defined" guard lives in check-blindfold.mjs and covers updateAnimations.)
// ---------------------------------------------------------------------------
const cfgSrc = read('js', 'config.js');
ok(/character-models\.json/.test(cfgSrc) && /characterModels/.test(cfgSrc), 'js/config.js loads character-models.json into cfg.characterModels');

const sceneSrc = read('js', 'scene.js');
const defines = (name) => new RegExp('(^|[^\\w.])' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm').test(sceneSrc);
for (const m of ['_loadCharacterModels', '_loadCharacterGlb', '_hunterModelReady', '_buildHunterModel', '_resolveClip', '_playHunterState', 'updateAnimations', 'setWeaponVisible']) {
  ok(defines(m), `js/scene.js defines ${m}()`);
}
ok(/_skeletonUtils\.clone\s*\(/.test(sceneSrc), 'js/scene.js uses SkeletonUtils.clone (rig-safe skinned-mesh clone, not a plain .clone)');
ok(/SkeletonUtils\.js/.test(sceneSrc), 'js/scene.js lazily imports three/addons SkeletonUtils');
ok(/new THREE\.AnimationMixer/.test(sceneSrc), 'js/scene.js builds an AnimationMixer per hunter');
// Suffix guard against the 'CharacterArmature|' prefix must be present in the resolver.
ok(/endsWith\('\|'\s*\+\s*suffix\)/.test(sceneSrc) || /endsWith\(suffix\)/.test(sceneSrc), 'js/scene.js resolves clips by SUFFIX (guards the CharacterArmature| prefix)');
// Only remote players get the animated model (self stays first-person / capsule).
ok(/animated:\s*true/.test(sceneSrc), 'js/scene.js builds the animated model only for remote players (animated flag)');

const mainSrc = read('js', 'main.js');
ok(/scene\.updateAnimations\(/.test(mainSrc), 'js/main.js drives scene.updateAnimations(dt) each frame');
ok(/buildWorld\([^)]*characterModels\b/.test(mainSrc), 'js/main.js passes the character-model registry into buildWorld');

// ---------------------------------------------------------------------------
// 5) HELD-ITEM FORWARD OFFSET + REMOTE LOOK PITCH (2026-07-19, VRmike). The held item drifted ~0.2 m
//    BEHIND the hand on remote views, and remote hunter models always aimed dead-horizontal. Both are
//    cosmetic-only (remote models); headless can't RENDER them, so assert the config + the wiring that
//    makes the fixes compose (offset is bone-local so it rides the pitched arm).
// ---------------------------------------------------------------------------
// Config: forward offset lives on the weapon block, and the pitch rig on the hunter block.
ok(Number.isFinite(weapon.forwardOffset), `hunter.weapon.forwardOffset is a number (held-item forward nudge, m) — got ${weapon.forwardOffset}`);
ok(hunter.pitch && typeof hunter.pitch === 'object', 'hunter.pitch rig block exists (remote look-pitch config)');
if (hunter.pitch) {
  const p = hunter.pitch;
  ok(typeof p.headBone === 'string' && typeof p.armBone === 'string', `hunter.pitch names the head + arm bones (${p.headBone} / ${p.armBone})`);
  ok(Number.isFinite(p.maxUpDeg) && Number.isFinite(p.maxDownDeg) && p.maxUpDeg > 0 && p.maxDownDeg > 0, 'hunter.pitch clamps up/down (maxUpDeg/maxDownDeg > 0, so extreme pitch cannot fold the model)');
  // The named bones must be REAL joints in the GLB (tolerant of GLTFLoader name sanitization).
  const norm = (s) => String(s || '').replace(/[\s._:|-]/g, '').toLowerCase();
  const buf = readFileSync(join(root, 'assets', hunter.model));
  const jlen = buf.readUInt32LE(12);
  const gj = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const boneNames = new Set((gj.nodes || []).map((n) => norm(n.name)));
  ok(boneNames.has(norm(p.headBone)), `hunter.pitch.headBone "${p.headBone}" is a real bone in the GLB`);
  ok(boneNames.has(norm(p.armBone)), `hunter.pitch.armBone "${p.armBone}" is a real bone in the GLB`);
}
// Referee: the snapshot carries per-hunter look pitch so remote models can tilt to it.
const refSrc2 = read('shared', 'referee.js');
ok(/pitch:\s*p\.role\s*===\s*ROLE\.HUNTER/.test(refSrc2), 'referee broadcasts a hunter look `pitch` in each snapshot player entry');
// Scene: the helpers exist, the forward offset is applied bone-local, and pitch is applied per frame.
for (const m of ['_buildPitchRig', '_applyLookPitch', '_boneLocalDir']) {
  ok(defines(m), `js/scene.js defines ${m}()`);
}
// Held-item offset (2026-07-20 redo): shared bone-local helper + POSE-FIRST. The offset math lives in
// shared/hunter-sizing.js::heldItemBoneOffset (browser + check run the SAME code) and scene.js must
// pose the rig into the aim clip (mixer.update) BEFORE computing it, else the bind-pose bug returns.
// The OUTPUT (down 0.15-0.2 m, forward > 0, grip near hand, holds under yaw) is asserted headless in
// tools/check-held-item-offset.mjs. See memory/notes/hunter-character-model.md.
ok(/heldItemBoneOffset/.test(read('shared', 'hunter-sizing.js')), 'shared/hunter-sizing.js defines heldItemBoneOffset (shared held-item offset math)');
ok(/heldItemBoneOffset\s*\(/.test(sceneSrc), 'js/scene.js applies the held item via the shared heldItemBoneOffset helper');
// POSE-FIRST ordering: the rig must be posed (mixer.update) BEFORE the held-item offset is computed,
// so the offset is derived in the rendered aim pose. Assert by SOURCE ORDER, not a brittle distance.
const poseIdx = sceneSrc.search(/actions\.idle\.play\(\)\s*;\s*mixer\.update\(/);
const offsetIdx = sceneSrc.indexOf('heldItemBoneOffset(');
ok(poseIdx >= 0 && offsetIdx >= 0 && poseIdx < offsetIdx, 'scene.js POSES the rig (plays idle + mixer.update) BEFORE computing the held-item offset (derived in the rendered aim pose, not the bind pose)');
ok(/mixer\.update\([^)]*\)\s*;?[\s\S]{0,400}_applyLookPitch/.test(sceneSrc), 'updateAnimations applies look pitch AFTER mixer.update (adds on top of the pose, no accumulation)');
ok(/targetPitch\s*=\s*Number\.isFinite\(p\.pitch\)/.test(sceneSrc), 'syncPlayers stashes the networked pitch onto the hunter controller (targetPitch)');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nhunter-model check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nhunter-model check passed');
