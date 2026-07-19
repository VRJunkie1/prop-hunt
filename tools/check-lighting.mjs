#!/usr/bin/env node
// tools/check-lighting.mjs — guard for the LIGHTING OVERHAUL (VRmike, 2026-07-19).
// AUTHORING-ONLY, never shipped. Run:  node tools/check-lighting.mjs
//
// Covers the HEADLESS-checkable halves of the overhaul (the visual effects themselves get a
// boot-clean browser_check, B4-style, on desktop + phone profiles):
//   1) TIER config resolution — the 4 presets are the documented switch bundles, monotonic, and
//      each effect is independently readable (the "switchboard").
//   2) DEVICE heuristic — software→T0, mobile→<=T1, discrete→T3, clamped in-band.
//   3) TONEMAP resolution — multiply == LinearToneMapping w/ the 1.25× fold, filmic == ACES,
//      exposure clamped; the pre-tonemap-multiplier math is exact.
//   4) SH override/load path — flat-27 and nested-9 both parse; garbage → null (→ bake fallback).
//   5) PERSISTENCE + wiring — the settings use localStorage (not cookies) with the prophunt.*
//      keys, and main.js/ui.js actually read the module (source wiring, like check-pc-controls).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  EFFECT_KEYS, TIERS, MIN_TIER, MAX_TIER, clampTier, resolveTierConfig,
  guessTierFromDevice, resolveTonemap, clampExposure, EXPOSURE_RANGE, MULTIPLY_FACTOR,
  normalizeTonemapMode, TONEMAP_MODES, parseSHCoefficients, mapSHOverride,
  TIER_KEY, TIER_USERSET_KEY, TONEMAP_KEY, EXPOSURE_KEY,
  resolveAmbientIntensity, clampAmbientIntensity, AMBIENT_INTENSITY_DEFAULT, AMBIENT_INTENSITY_RANGE,
  BUILD_GEOMETRY_BRIGHTNESS, AO_MAX_DISTANCE_METERS, AO_MIN_DISTANCE_METERS, ssaoDistanceRange,
} from '../js/lighting-tiers.js';
import { PerfMon } from '../js/perfmon.js';
import { AutoTier } from '../js/auto-tier.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('Lighting overhaul check (VRmike 2026-07-19)');

// ---------------------------------------------------------------------------
// 1. TIER CONFIG RESOLUTION — the switchboard presets.
// ---------------------------------------------------------------------------
console.log('\n [1] TIER config resolution');
ok(Array.isArray(EFFECT_KEYS) && EFFECT_KEYS.length === 5, `EFFECT_KEYS lists the 5 switches (${EFFECT_KEYS.join(',')})`);
ok(MIN_TIER === 0 && MAX_TIER === 3, 'tier band is 0..3');

// T0 = potato: everything off, no shadow map.
const t0 = resolveTierConfig(0);
ok(!t0.shProbe && !t0.contactShadow && !t0.angledFill && !t0.ssao && !t0.bloom && t0.shadowMapSize === 0 && !t0.usesComposer,
  'T0 = current lighting, no shadows (all effects off)');

// T1 = SH fill + one straight-down shadow light @512, tight, no post.
const t1 = resolveTierConfig(1);
ok(t1.shProbe && t1.contactShadow && !t1.angledFill && !t1.ssao && !t1.bloom && t1.shadowMapSize === 512 && !t1.usesComposer,
  'T1 = SH probe + contact-shadow light @512, no SSAO/bloom, no composer');

// T2 = + angled fill + SSAO @1024, composer on.
const t2 = resolveTierConfig(2);
ok(t2.shProbe && t2.contactShadow && t2.angledFill && t2.ssao && !t2.bloom && t2.shadowMapSize === 1024 && t2.usesComposer,
  'T2 = + angled fill + SSAO @1024 (composer on)');

// T3 = + bloom @2048.
const t3 = resolveTierConfig(3);
ok(t3.shProbe && t3.contactShadow && t3.angledFill && t3.ssao && t3.bloom && t3.shadowMapSize === 2048 && t3.usesComposer,
  'T3 = + bloom @2048');

// Monotonic: each effect, once ON, stays on at higher tiers (presets are cumulative bundles).
let monotonic = true;
for (const k of ['shProbe', 'contactShadow', 'angledFill', 'ssao', 'bloom']) {
  let seenOn = false;
  for (let t = 0; t <= 3; t++) {
    const on = resolveTierConfig(t)[k];
    if (seenOn && !on) monotonic = false;
    if (on) seenOn = true;
  }
}
ok(monotonic, 'effects are cumulative up the tiers (never toggled back off)');
// Shadow map sizes are non-decreasing.
ok(t0.shadowMapSize <= t1.shadowMapSize && t1.shadowMapSize <= t2.shadowMapSize && t2.shadowMapSize <= t3.shadowMapSize,
  'shadow-map size is non-decreasing (512→1024→2048)');
// Clamp out-of-band + garbage.
ok(clampTier(9) === 3 && clampTier(-4) === 0 && clampTier('x') === 0 && clampTier(1.6) === 2,
  'clampTier clamps/ rounds out-of-band + garbage into 0..3');

// ---------------------------------------------------------------------------
// 2. DEVICE HEURISTIC.
// ---------------------------------------------------------------------------
console.log('\n [2] DEVICE heuristic (initial guess)');
ok(guessTierFromDevice({ gpu: 'Google SwiftShader' }) === 0, 'software renderer → T0');
ok(guessTierFromDevice({ gpu: 'Adreno (TM) 640', deviceMemory: 4, cores: 8 }) <= 1, 'mobile Adreno → <= T1');
ok(guessTierFromDevice({ gpu: 'Apple GPU', deviceMemory: 4 }) <= 1, 'Apple mobile GPU → <= T1');
ok(guessTierFromDevice({ gpu: 'ANGLE (NVIDIA GeForce RTX 3070)', deviceMemory: 8, cores: 16 }) === 3, 'discrete RTX + 8GB → T3');
ok(guessTierFromDevice({ gpu: 'ANGLE (Intel(R) UHD Graphics 620)', deviceMemory: 8, cores: 8 }) === 2, 'laptop iGPU → T2');
ok(guessTierFromDevice({}) === 2, 'unknown device → neutral T2');
// A low-memory mobile at 4K steps down but never leaves the band.
const stressed = guessTierFromDevice({ gpu: 'Mali-G72', deviceMemory: 2, cores: 2, screenPx: 3686400 });
ok(stressed >= 0 && stressed <= 1, `stressed phone stays low + in-band (= T${stressed})`);

// ---------------------------------------------------------------------------
// 3. TONEMAP resolution.
// ---------------------------------------------------------------------------
console.log('\n [3] TONEMAP A/B + exposure');
ok(TONEMAP_MODES.join(',') === 'multiply,filmic', 'two modes: multiply, filmic');
const mul = resolveTonemap('multiply', 1.0);
ok(mul.toneMapping === 'linear' && Math.abs(mul.toneMappingExposure - MULTIPLY_FACTOR) < 1e-9,
  `multiply @1.0 = LinearToneMapping w/ exposure ${MULTIPLY_FACTOR} (the flat multiply factor)`);
const mul2 = resolveTonemap('multiply', 1.5);
ok(Math.abs(mul2.toneMappingExposure - MULTIPLY_FACTOR * 1.5) < 1e-9,
  'multiply folds the slider into the pre-tonemap multiplier (MULTIPLY_FACTOR × exposure)');
const fil = resolveTonemap('filmic', 1.2);
ok(fil.toneMapping === 'aces' && Math.abs(fil.toneMappingExposure - 1.2) < 1e-9,
  'filmic = ACESFilmicToneMapping, slider IS the exposure');
ok(normalizeTonemapMode('bogus') === 'multiply', 'unknown mode → multiply default');
ok(clampExposure(99) === EXPOSURE_RANGE.max && clampExposure(-1) === EXPOSURE_RANGE.min && clampExposure('x') === EXPOSURE_RANGE.default,
  'exposure clamps/ defaults out-of-band + garbage');

// ---------------------------------------------------------------------------
// 4. SH override / load path.
// ---------------------------------------------------------------------------
console.log('\n [4] SH ambient override (manual pre-bake)');
const flat27 = Array.from({ length: 27 }, (_, i) => i * 0.01);
const p27 = parseSHCoefficients(flat27);
ok(p27 && p27.length === 9 && p27[0].length === 3 && Math.abs(p27[1][0] - 0.03) < 1e-9,
  'flat length-27 array → 9 [r,g,b] triples in order');
const nested9 = Array.from({ length: 9 }, (_, i) => [i, i + 0.1, i + 0.2]);
const p9 = parseSHCoefficients(nested9);
ok(p9 && p9.length === 9 && Math.abs(p9[8][2] - 8.2) < 1e-9, 'nested length-9 [r,g,b] array parses');
ok(parseSHCoefficients([1, 2, 3]) === null, 'wrong-length array → null (→ bake fallback)');
ok(parseSHCoefficients('nope') === null && parseSHCoefficients(null) === null, 'non-array → null');
ok(parseSHCoefficients(flat27.map((n, i) => (i === 5 ? NaN : n))) === null, 'NaN in the array → null');
ok(mapSHOverride({ sh: flat27 }) && mapSHOverride({ shCoefficients: nested9 }) && mapSHOverride({}) === null,
  'mapSHOverride reads map.sh / map.shCoefficients, null when absent');

// ---------------------------------------------------------------------------
// 4b. AMBIENT intensity tunable (VRmike hotfix, 2026-07-19) — the LOW default + per-map override
//     that keeps the SH probe + HemisphereLight from washing the floor out / drowning the shadows.
// ---------------------------------------------------------------------------
console.log('\n [4b] AMBIENT intensity (washout fix)');
ok(AMBIENT_INTENSITY_DEFAULT <= 0.5, `ambient default is LOW (=${AMBIENT_INTENSITY_DEFAULT}, was effectively ~1.0+1.0)`);
ok(resolveAmbientIntensity(null) === AMBIENT_INTENSITY_DEFAULT && resolveAmbientIntensity({}) === AMBIENT_INTENSITY_DEFAULT,
  'no map / no override → the LOW default');
ok(resolveAmbientIntensity({ ambientIntensity: 0.8 }) === 0.8, 'per-map ambientIntensity override wins');
ok(resolveAmbientIntensity({ ambientIntensity: 99 }) === AMBIENT_INTENSITY_RANGE.max
  && resolveAmbientIntensity({ ambientIntensity: -5 }) === AMBIENT_INTENSITY_RANGE.min
  && resolveAmbientIntensity({ ambientIntensity: 'x' }) === AMBIENT_INTENSITY_DEFAULT,
  'override clamps out-of-band + falls back on garbage');
ok(clampAmbientIntensity(1.5) === 1.5 && clampAmbientIntensity(NaN) === AMBIENT_INTENSITY_DEFAULT, 'clampAmbientIntensity clamps/defaults');

// ---------------------------------------------------------------------------
// 4c. LIGHTING TUNING ROUND 2 (VRmike, 2026-07-19) — tonemap defaults/range pushed hotter, the
//     build-geometry brightness scalar, and the SSAO world-space distance falloff.
// ---------------------------------------------------------------------------
console.log('\n [4c] ROUND 2 tuning (tonemap defaults/range, build-geometry, SSAO falloff)');
// Tonemap: MULTIPLY is the default, and both knobs are ~30% hotter than round 1 (1.25 / 2.0).
ok(normalizeTonemapMode(undefined) === 'multiply' && normalizeTonemapMode(null) === 'multiply',
  'multiply is the DEFAULT tonemap mode (VRmike prefers it over ACES)');
ok(Math.abs(MULTIPLY_FACTOR - 1.6) < 1e-9, `multiply factor pushed to ${MULTIPLY_FACTOR} (was 1.25, ~30% hotter)`);
ok(EXPOSURE_RANGE.max >= 2.6 - 1e-9, `exposure ceiling raised to ${EXPOSURE_RANGE.max} (was 2.0, ~30% higher)`);
// index.html's slider max must mirror EXPOSURE_RANGE.max so the UI can actually reach the ceiling.
{
  const htmlSrc = read('index.html');
  const m = htmlSrc.match(/id="exposureSlider"[\s\S]*?max="([0-9.]+)"/);
  ok(m && Math.abs(parseFloat(m[1]) - EXPOSURE_RANGE.max) < 1e-9,
    `index.html exposure slider max (${m && m[1]}) mirrors EXPOSURE_RANGE.max (${EXPOSURE_RANGE.max})`);
}
// Build-geometry brightness: a darkening (<1) scalar, applied in scene.js to the primitive albedo.
ok(BUILD_GEOMETRY_BRIGHTNESS > 0 && BUILD_GEOMETRY_BRIGHTNESS < 1,
  `BUILD_GEOMETRY_BRIGHTNESS is a darkening factor (=${BUILD_GEOMETRY_BRIGHTNESS})`);
{
  const sc = read('js/scene.js');
  ok(/BUILD_GEOMETRY_BRIGHTNESS/.test(sc) && /multiplyScalar\(BUILD_GEOMETRY_BRIGHTNESS\)/.test(sc),
    'scene.js darkens build-added primitive albedo via multiplyScalar(BUILD_GEOMETRY_BRIGHTNESS)');
}
// SSAO distance falloff: meters → normalized [0,1] depth deltas for the camera near/far; near-range only.
{
  const r = ssaoDistanceRange(0.1, 500); // the real game camera (near 0.1, far 500)
  ok(Math.abs(r.maxDistance - AO_MAX_DISTANCE_METERS / 499.9) < 1e-6,
    `ssaoDistanceRange maps ${AO_MAX_DISTANCE_METERS} m to normalized ${r.maxDistance.toFixed(5)} at far=500`);
  ok(r.maxDistance < 0.01 && r.maxDistance > 0, `AO max range is near (${r.maxDistance.toFixed(5)} ≪ the old 0.1 ≈ 50 m)`);
  ok(r.minDistance >= 0 && r.minDistance < r.maxDistance, 'AO min noise-floor is below the max range');
  ok(AO_MIN_DISTANCE_METERS < AO_MAX_DISTANCE_METERS && AO_MAX_DISTANCE_METERS <= 2,
    `AO max distance is ~1-2 m (=${AO_MAX_DISTANCE_METERS} m), tunable`);
  const rlo = ssaoDistanceRange(NaN, NaN); // garbage near/far → clamped, never NaN
  ok(rlo.minDistance >= 0 && rlo.minDistance <= 1 && rlo.maxDistance >= 0 && rlo.maxDistance <= 1,
    'ssaoDistanceRange clamps garbage near/far into [0,1]');
  ok(/ssaoDistanceRange\(this\.camera\.near, this\.camera\.far\)/.test(read('js/lighting.js')),
    'lighting.js sets SSAO min/maxDistance from ssaoDistanceRange(camera.near, camera.far)');
}

// ---------------------------------------------------------------------------
// 5. PERSISTENCE + source wiring.
// ---------------------------------------------------------------------------
console.log('\n [5] PERSISTENCE + wiring');
ok(TIER_KEY.startsWith('prophunt.') && TONEMAP_KEY.startsWith('prophunt.') && EXPOSURE_KEY.startsWith('prophunt.') && TIER_USERSET_KEY.startsWith('prophunt.'),
  `localStorage keys follow the prophunt.* pattern (${TIER_KEY}, ${TONEMAP_KEY}, ${EXPOSURE_KEY})`);
const mainSrc = read('js/main.js');
const uiSrc = read('js/ui.js');
const html = read('index.html');
const sceneSrc = read('js/scene.js');
ok(/lighting-tiers\.js/.test(mainSrc), 'js/main.js imports the pure lighting-tiers module');
ok(/localStorage\.setItem\(TIER_KEY/.test(mainSrc) && /saveLightingTier/.test(mainSrc),
  'main.js persists the tier to localStorage (TIER_KEY via saveLightingTier)');
ok(/localStorage\.setItem\(TONEMAP_KEY/.test(mainSrc) && /localStorage\.setItem\(EXPOSURE_KEY/.test(mainSrc),
  'main.js persists the tonemap + exposure to localStorage');
ok(/scene\.setLightingTier/.test(mainSrc) && /scene\.setTonemap/.test(mainSrc),
  'main.js pushes tier + tonemap onto the scene');
ok(/ui\.onLightingTier/.test(mainSrc) && /ui\.onTonemapMode/.test(mainSrc),
  'main.js wires the pause-menu lighting callbacks');
// ROUND 2: default START at the TOP tier — the no-saved/no-manual branch seeds MAX_TIER, NOT the
// device guess (the FPS probe steps down if it lags). A saved/manual pick still wins (loaded above it).
ok(/!lightingState\.userSet && !lightingState\.hasSaved\) lightingState\.tier = MAX_TIER/.test(mainSrc),
  'main.js defaults the starting tier to MAX_TIER (T3) on all devices (flipped strategy)');
ok(/exposureSlider|exposureVal/.test(html), 'index.html carries the exposure slider');
ok(/lighting\.js|LightingRig|_lighting/.test(sceneSrc), 'js/scene.js wires the LightingRig');
ok(/lightingTier|lightingRow|Lighting Quality/i.test(html), 'index.html carries the Lighting Quality pause-menu row');
ok(/tonemap|Tonemap|Filmic/i.test(html), 'index.html carries the tonemap A/B toggle');

// HOTFIX (2026-07-19) source guards so the two fixes can't silently regress:
const lightingSrc = read('js/lighting.js');
//  a) BLACK-SCREEN: the composer chain MUST add a RenderPass BEFORE the SSAOPass (SSAOPass.Default
//     reads the beauty from readBuffer.texture — with no RenderPass ahead of it the frame is black).
{
  const build = lightingSrc.slice(lightingSrc.indexOf('_buildComposer'));
  const rpAt = build.indexOf('new M.RenderPass');
  const ssaoAt = build.indexOf('new M.SSAOPass');
  ok(rpAt !== -1 && ssaoAt !== -1 && rpAt < ssaoAt,
    'lighting.js _buildComposer adds RenderPass BEFORE SSAOPass (no black-screen regression)');
}
//  b) AMBIENT: both ambient sources route through the ONE tunable — the HemisphereLight (scene.js)
//     and the SH probe intensity (lighting.js), so a washout can't creep back via either.
ok(/resolveAmbientIntensity/.test(sceneSrc) && /HemisphereLight\([^)]*ambient/.test(sceneSrc),
  'scene.js drives the base HemisphereLight off resolveAmbientIntensity (LOW ambient)');
ok(/resolveAmbientIntensity/.test(lightingSrc) && /_probe\.intensity = this\._ambient/.test(lightingSrc),
  'lighting.js drives the SH probe intensity off the resolved ambient (not a flat 1.0)');

// ---------------------------------------------------------------------------
// 6. LightingRig THREE mapping — headless with a MOCK renderer + REAL THREE objects. Can't render
//    (no GL), but exercises the switchboard→THREE object graph: probe/lights added+removed per tier,
//    shadow-map size applied to the light, tonemap written to the renderer. Catches an API typo
//    (wrong THREE constructor / property) the boot-clean check can only see in a live match.
// ---------------------------------------------------------------------------
console.log('\n [6] LightingRig (THREE object mapping)');
try {
  const THREE = await import('three');
  const { LightingRig } = await import('../js/lighting.js');
  const countLights = (scene) => scene.children.filter((c) => c.isLight).length;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera();
  const renderer = {
    shadowMap: { type: null, enabled: false, needsUpdate: false },
    toneMapping: null, toneMappingExposure: 1,
    getContext: () => null, getPixelRatio: () => 1, render: () => {},
  };
  const rig = new LightingRig(renderer, scene, cam);
  const map = { size: 36, sh: flat27 }; // SH override → probe set synchronously (no async GL bake)
  rig._postLoading = true;              // block the async post-import in this GL-less harness

  rig.setTierConfig(resolveTierConfig(0)); rig.reattach(map);
  ok(!rig._probe && !rig.shadowsOn && countLights(scene) === 0, 'T0 rig: no probe, no effect lights, shadows off');

  rig.setTierConfig(resolveTierConfig(1)); rig.reattach(map);
  ok(rig._probe && rig._probe.parent === scene, 'T1 rig: SH probe added (from map override, no bake)');
  ok(rig._contactLight && rig._contactLight.castShadow && rig._contactLight.shadow.mapSize.x === 512, 'T1 rig: contact light casts @512');
  ok(rig.shadowsOn && renderer.shadowMap.enabled === true, 'T1 rig: renderer shadows enabled');
  ok(!rig._angledLight, 'T1 rig: no angled fill yet');

  rig.setTierConfig(resolveTierConfig(2)); rig.reattach(map);
  ok(rig._angledLight && rig._angledLight.parent === scene, 'T2 rig: angled fill added');
  ok(rig._contactLight.shadow.mapSize.x === 1024, 'T2 rig: shadow map grew to 1024');

  rig.setTonemap('filmic', 1.3);
  ok(renderer.toneMapping === THREE.ACESFilmicToneMapping && Math.abs(renderer.toneMappingExposure - 1.3) < 1e-9,
    'filmic tonemap → ACES on the renderer w/ exposure 1.3');
  rig.setTonemap('multiply', 1.0);
  ok(renderer.toneMapping === THREE.LinearToneMapping && Math.abs(renderer.toneMappingExposure - MULTIPLY_FACTOR) < 1e-9,
    `multiply tonemap → Linear on the renderer w/ exposure ${MULTIPLY_FACTOR}`);

  rig.setTierConfig(resolveTierConfig(0)); rig.reattach(map);
  ok(!rig._probe && !rig._contactLight && !rig._angledLight && renderer.shadowMap.enabled === false,
    'step back to T0: probe + effect lights + shadows torn down');
} catch (e) {
  console.error('  ✗ LightingRig harness threw:', e && e.stack ? e.stack : e);
  fails++;
}

// ---------------------------------------------------------------------------
// 7. PERFMON — CPU/GPU attribution (spec item 4). Feed synthetic frame + CPU times, assert the
//    smoothed fps / cpuMs / inferred gpuMs + the per-frame verdict.
// ---------------------------------------------------------------------------
console.log('\n [7] PerfMon (CPU/GPU attribution)');
{
  // GPU-bound-ish: 60fps cadence, cheap 5ms CPU → most of the frame is GPU/vsync.
  const pm = new PerfMon(0.5); // high alpha → converges fast in the test
  let t = 0;
  for (let i = 0; i < 60; i++) { pm.beginFrame(t); pm.endCpu(t + 5); t += 1000 / 60; }
  ok(Math.abs(pm.fps - 60) < 3, `fps tracks the frame cadence (= ${pm.fps.toFixed(1)})`);
  ok(Math.abs(pm.cpuMs - 5) < 0.6, `cpuMs tracks the measured CPU cost (= ${pm.cpuMs.toFixed(2)})`);
  ok(pm.gpuMs > 0 && pm.gpuMs < pm.frameMs, `gpuMs inferred = frameMs - cpuMs (= ${pm.gpuMs.toFixed(2)})`);
  ok(pm.verdict() === 'gpu', 'cheap CPU + full frame → GPU-bound verdict');

  // CPU-bound: 15ms CPU inside a ~16.7ms frame → CPU dominates.
  const pm2 = new PerfMon(0.5);
  t = 0;
  for (let i = 0; i < 60; i++) { pm2.beginFrame(t); pm2.endCpu(t + 15); t += 1000 / 60; }
  ok(pm2.verdict() === 'cpu', 'CPU ≈ whole frame → CPU-bound verdict');
  ok(pm2.warmedUp, 'warmedUp after enough frames');
}

// ---------------------------------------------------------------------------
// 8. AUTO-TIER state machine (spec item 3). Drive the pure controller with synthetic perf + clock.
// ---------------------------------------------------------------------------
console.log('\n [8] AutoTier (FPS-probe ratchet)');
const makeCtx = (startTier) => {
  const s = { tier: startTier, saved: null, scale: 1, cpuBound: false, verdict: null };
  s.ctx = {
    getTier: () => s.tier,
    setTier: (t, save) => { s.tier = t; if (save) s.saved = t; },
    setRenderScale: (sc) => { s.scale = sc; },
    markCpuBound: () => { s.cpuBound = true; },
    onVerdict: (v) => { s.verdict = v; },
  };
  return s;
};
const OPT = { warmupMs: 1000, settleMs: 1000, probeMs: 500 };
const GPU = { fps: 30, cpuMs: 5, gpuMs: 28, frameMs: 33, warmedUp: true };
const CPU = { fps: 30, cpuMs: 30, gpuMs: 3, frameMs: 33, warmedUp: true };
const AMB = { fps: 30, cpuMs: 15, gpuMs: 16, frameMs: 33, warmedUp: true };
const FINE = { fps: 60, cpuMs: 5, gpuMs: 8, frameMs: 16.7, warmedUp: true };

// A) GPU-bound, the step helps → keep + SAVE, cooldown.
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, GPU);            // start warmup
  at.tick(1001, GPU);         // warmup done → clear GPU → step down to T2, settle
  ok(s.tier === 2, 'A: GPU-bound → stepped T3→T2');
  const IMP = { fps: 55, cpuMs: 5, gpuMs: 12, frameMs: 18, warmedUp: true };
  at.tick(2002, IMP);         // settle done → improved → keep + save
  ok(s.saved === 2 && at.phase === 'done' && !at.enabled, 'A: improvement kept + SAVED, cooldown');
}
// B) CPU-bound → NO step, mark CPU-bound, cooldown (don't touch lighting).
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, CPU);
  at.tick(1001, CPU);
  ok(s.tier === 3 && s.cpuBound && at.phase === 'done', 'B: CPU-bound → no downstep, marked, cooldown');
}
// C) Ambiguous → render-scale probe → FPS jumps → GPU-bound → step down; scale restored.
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, AMB);
  at.tick(1001, AMB);         // decide → ambiguous → resprobe, dropped scale
  ok(s.scale < 1 && at.phase === 'resprobe', 'C: ambiguous → dropped render scale for the probe');
  const PROBED = { fps: 45, cpuMs: 15, gpuMs: 5, frameMs: 22, warmedUp: true };
  at.tick(1502, PROBED);      // probe done → fps jumped → GPU-bound → step down
  ok(s.scale === 1 && s.tier === 2, 'C: probe restored scale + stepped down (GPU-bound)');
}
// C2) Ambiguous → probe → FPS does NOT jump → CPU-bound → no step.
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, AMB);
  at.tick(1001, AMB);
  const NOJUMP = { fps: 31, cpuMs: 15, gpuMs: 16, frameMs: 32, warmedUp: true };
  at.tick(1502, NOJUMP);
  ok(s.scale === 1 && s.tier === 3 && s.cpuBound && at.phase === 'done', 'C2: probe no-jump → CPU-bound, no step');
}
// D) Step down that does NOT help → revert + mark CPU-bound (no yo-yo).
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, GPU);
  at.tick(1001, GPU);         // step T3→T2, settle
  ok(s.tier === 2, 'D: stepped down');
  at.tick(2002, GPU);         // still laggy after settle → revert + cpu-bound
  ok(s.tier === 3 && s.cpuBound && at.phase === 'done' && s.saved === null, 'D: no improvement → reverted, marked, NOT saved');
}
// E) Not lagging → done, no change.
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, FINE);
  at.tick(1001, FINE);
  ok(s.tier === 3 && at.phase === 'done', 'E: fps ok → done, tier untouched');
}
// F) Manual disable mid-flight → stops, never adjusts.
{
  const s = makeCtx(3);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, GPU);
  at.disable('manual override');
  at.tick(1001, GPU);
  ok(!at.enabled && at.phase === 'done' && s.tier === 3, 'F: manual disable → auto-tuner stops, tier untouched');
}
// G) Already at min tier → can't step, done.
{
  const s = makeCtx(0);
  const at = new AutoTier(s.ctx, OPT);
  at.tick(0, GPU);
  at.tick(1001, GPU);
  ok(s.tier === 0 && at.phase === 'done', 'G: GPU-bound at T0 → nothing to drop, done');
}

// ---------------------------------------------------------------------------
console.log(`\n${fails === 0 ? 'ALL GREEN' : fails + ' FAILED'}`);
process.exitCode = fails ? 1 : 0;
