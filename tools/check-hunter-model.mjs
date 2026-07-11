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
// 2) CONFIGURED CLIP SUFFIXES must be real clips from the pack (guards a typo the
//    suffix-matcher would silently miss). This is the VERIFIED clip list from the
//    asset (names sans the 'CharacterArmature|' prefix).
// ---------------------------------------------------------------------------
const PACK_CLIPS = new Set([
  'Idle', 'Idle_Gun', 'Idle_Gun_Pointing', 'Idle_Gun_Shoot', 'Gun_Shoot',
  'Run', 'Run_Back', 'Run_Left', 'Run_Right', 'Run_Shoot', 'Walk', 'Death', 'HitRecieve',
]);
for (const s of ['idle', 'forward', 'backward', 'left', 'right']) {
  const name = clips[s];
  ok(!name || PACK_CLIPS.has(name), `clip suffix "${name}" for ${s} is a real pack clip`);
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
ok(/buildWorld\([^)]*characterModels\)/.test(mainSrc), 'js/main.js passes the character-model registry into buildWorld');

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nhunter-model check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nhunter-model check passed');
