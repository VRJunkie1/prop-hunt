// js/lighting-tiers.js — PURE lighting-quality config (no THREE, no DOM).
//
// LIGHTING OVERHAUL (VRmike, 2026-07-19). This is the "effect switchboard": every lighting
// feature is an INDEPENDENT on/off switch, and the four quality TIERS (T0–T3) are just preset
// bundles of those switches. Keeping the presets as a plain data table means retuning a tier
// later is a one-line edit here, not surgery in the renderer.
//
// This module is deliberately dependency-free so the headless guard (tools/check-lighting.mjs)
// and future sessions can import + assert the tier math, the device heuristic, the tonemap
// resolution, and the SH-coefficient override path WITHOUT a browser / THREE / GL. The THREE
// side (building the actual lights / shadows / post passes / SH probe) lives in js/lighting.js.
//
// See memory/notes/lighting.md.

// ---------------------------------------------------------------------------
// Effect switches — each is independently toggleable inside the renderer. Tiers below
// are just preset bundles of these. Adding a new effect = one key here + one branch in
// js/lighting.js applyTierConfig(); every tier that doesn't mention it defaults to off.
// ---------------------------------------------------------------------------
export const EFFECT_KEYS = ['shProbe', 'contactShadow', 'angledFill', 'ssao', 'bloom'];

export const MIN_TIER = 0;
export const MAX_TIER = 3;

// The preset table. shadowMapSize 0 == no shadow-casting light for that tier.
//  T0 — current lighting, no shadows (potato mode; exactly today's look).
//  T1 — + SH ambient probe fill + ONE straight-down shadow-casting directional light
//       (contact shadows under props/players for jump accuracy), tight 512 shadow map.
//  T2 — + angled non-shadow fill light + SSAO, 1024 shadow map.
//  T3 — + bloom (UnrealBloomPass), 2048 shadow map.
export const TIERS = {
  0: { shProbe: false, contactShadow: false, angledFill: false, ssao: false, bloom: false, shadowMapSize: 0 },
  1: { shProbe: true,  contactShadow: true,  angledFill: false, ssao: false, bloom: false, shadowMapSize: 512 },
  2: { shProbe: true,  contactShadow: true,  angledFill: true,  ssao: true,  bloom: false, shadowMapSize: 1024 },
  3: { shProbe: true,  contactShadow: true,  angledFill: true,  ssao: true,  bloom: true,  shadowMapSize: 2048 },
};

// localStorage keys — same "prophunt.*" pattern as the mouse-sensitivity setting (B4).
export const TIER_KEY = 'prophunt.lightingTier';        // number 0..3, or 'auto' when unset by hand
export const TIER_USERSET_KEY = 'prophunt.lightingUserSet'; // '1' once the player picks manually (outranks auto-tuner)
export const TONEMAP_KEY = 'prophunt.tonemap';          // 'multiply' | 'filmic'
export const EXPOSURE_KEY = 'prophunt.exposure';        // number, pre-tonemap multiplier

export function clampTier(t) {
  const n = Math.round(Number(t));
  if (!Number.isFinite(n)) return MIN_TIER;
  return Math.max(MIN_TIER, Math.min(MAX_TIER, n));
}

// Resolve a tier index to its full effect config. PURE — one source of truth for what each
// tier turns on. Returns a fresh object so callers can't mutate the shared preset table.
export function resolveTierConfig(tier) {
  const t = clampTier(tier);
  const preset = TIERS[t];
  return {
    tier: t,
    shProbe: preset.shProbe,
    contactShadow: preset.contactShadow,
    angledFill: preset.angledFill,
    ssao: preset.ssao,
    bloom: preset.bloom,
    shadowMapSize: preset.shadowMapSize,
    // Does this tier need an EffectComposer (post pipeline) at all? Only SSAO/bloom do; the
    // cheap tiers render straight to the canvas (no composer allocation on old phones).
    usesComposer: preset.ssao || preset.bloom,
  };
}

// ---------------------------------------------------------------------------
// Device heuristic — the FIRST guess before the runtime FPS probe refines it. Deterministic +
// pure so the guard can pin the buckets. hints: { gpu, deviceMemory, cores, screenPx }.
//   gpu         — WEBGL_debug_renderer_info UNMASKED_RENDERER_WEBGL string (lowercased ok)
//   deviceMemory — navigator.deviceMemory (GB), or 0/undefined if unavailable
//   cores        — navigator.hardwareConcurrency, or 0
//   screenPx     — device-pixel width*height (screen.width*height*dpr), or 0
// The FPS probe (js/auto-tier.js) is the real authority; this just avoids booting a potato at T3.
// ---------------------------------------------------------------------------
export function guessTierFromDevice(hints = {}) {
  const gpu = String(hints.gpu || '').toLowerCase();
  const mem = Number(hints.deviceMemory) || 0;
  const cores = Number(hints.cores) || 0;
  const px = Number(hints.screenPx) || 0;

  // Software / emulated renderers can barely composite — floor them at T0.
  if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(gpu)) return 0;

  const mobileGpu = /adreno|mali|powervr|apple gpu|apple a\d|tegra|videocore/.test(gpu);
  const integratedGpu = /intel|uhd graphics|hd graphics|iris|gma|microsoft direct3d/.test(gpu);
  const discreteGpu = /geforce|rtx|gtx|radeon|\brx ?\d{3,}\b|quadro|nvidia|\barc a\d|instinct/.test(gpu);

  let tier;
  if (mobileGpu) tier = 1;            // phones: contact shadows are the point — start at T1
  else if (discreteGpu) tier = 3;     // desktop discrete GPU: go high
  else if (integratedGpu) tier = 2;   // laptop iGPU: middle
  else tier = 2;                      // unknown: neutral middle, let the FPS probe correct it

  // Memory pressure steps down. deviceMemory caps at 8 in most browsers, so treat >=8 as "plenty".
  if (mem && mem <= 2) tier -= 1;
  if (cores && cores <= 2) tier -= 1;

  // High resolution on a non-discrete GPU is a lot of pixels to shade — nudge down.
  if (px >= 2500000 && !discreteGpu) tier -= 1;

  // Plenty of memory + a discrete GPU keeps the top tier.
  if (mem >= 8 && discreteGpu) tier = 3;

  return clampTier(tier);
}

// ---------------------------------------------------------------------------
// Tonemap A/B — the flat "multiply" (RGB multiply screen effect) vs "Filmic" (ACES) with an
// exposure slider. exposure is the PRE-tonemap multiplier (so filmic+exposure covers the hybrid
// look). Implemented on the renderer, not a shader pass, so it works on EVERY tier incl. T0:
//   multiply → THREE.LinearToneMapping (a flat `saturate(exposure*color)`) with exposure baked
//              to MULTIPLY_FACTOR× the slider (the flat multiply at slider=1).
//   filmic   → THREE.ACESFilmicToneMapping with the slider as toneMappingExposure directly.
// resolveTonemap returns a THREE-agnostic descriptor; js/lighting.js maps `toneMapping` to the
// real THREE constant. PURE so the guard can pin the exposure math.
//
// LIGHTING TUNING ROUND 2 (VRmike, 2026-07-19): 'multiply' is the DEFAULT (normalizeTonemapMode
// falls back to it) — VRmike far prefers it to ACES filmic. Both knobs were pushed ~30% hotter so
// the look can be cranked further: the multiply factor 1.25 → 1.6, and the exposure ceiling 2.0 →
// 2.6 (the index.html slider `max` mirrors this). MULTIPLY the default stays, A/B toggle + persist.
// ---------------------------------------------------------------------------
export const TONEMAP_MODES = ['multiply', 'filmic'];
export const MULTIPLY_FACTOR = 1.6; // the flat multiply at exposure 1.0 (was 1.25 — pushed ~30% hotter)
export const EXPOSURE_RANGE = { min: 0.4, max: 2.6, default: 1.0 }; // max 2.0 → 2.6 (~30% higher ceiling)

export function clampExposure(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return EXPOSURE_RANGE.default;
  return Math.max(EXPOSURE_RANGE.min, Math.min(EXPOSURE_RANGE.max, n));
}

export function normalizeTonemapMode(mode) {
  return TONEMAP_MODES.includes(mode) ? mode : 'multiply';
}

export function resolveTonemap(mode, exposure) {
  const m = normalizeTonemapMode(mode);
  const exp = clampExposure(exposure);
  if (m === 'filmic') {
    return { mode: 'filmic', exposure: exp, toneMapping: 'aces', toneMappingExposure: exp };
  }
  // multiply: flat RGB multiply = LinearToneMapping with the 1.25× factor folded into exposure.
  return { mode: 'multiply', exposure: exp, toneMapping: 'linear', toneMappingExposure: MULTIPLY_FACTOR * exp };
}

// ---------------------------------------------------------------------------
// AMBIENT INTENSITY — the one tunable that scales EVERY flat "fill from everywhere" light so the
// directional light + its down-shadows actually read (VRmike hotfix, 2026-07-19). Two ambient
// sources stack in the scene: the base HemisphereLight (scene.js, all tiers) and the SH ambient
// probe (js/lighting.js, T1+). BOTH were at full strength (1.0), which flooded the floor near-white
// and washed the contact shadows out — defeating the whole point of the overhead shadow light
// (props' down-shadows are the jump-accuracy cue). This single scalar drives both, default LOW, and
// is per-map overridable via `map.ambientIntensity` in the map JSON so a specific map can go
// brighter/moodier without touching code. PURE so the guard can pin the clamp + override path.
// ---------------------------------------------------------------------------
export const AMBIENT_INTENSITY_DEFAULT = 0.3; // LOW on purpose — shadows must read; was effectively 1.0+1.0
export const AMBIENT_INTENSITY_RANGE = { min: 0, max: 2 };

export function clampAmbientIntensity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return AMBIENT_INTENSITY_DEFAULT;
  return Math.max(AMBIENT_INTENSITY_RANGE.min, Math.min(AMBIENT_INTENSITY_RANGE.max, n));
}

// Resolve the ambient intensity for a map: the per-map `ambientIntensity` override if present +
// valid, else the LOW default. One source of truth for both the HemisphereLight (scene.js) and the
// SH probe (js/lighting.js).
export function resolveAmbientIntensity(map) {
  if (map && typeof map === 'object' && map.ambientIntensity != null) {
    return clampAmbientIntensity(map.ambientIntensity);
  }
  return AMBIENT_INTENSITY_DEFAULT;
}

// ---------------------------------------------------------------------------
// BUILD-GEOMETRY BRIGHTNESS (LIGHTING TUNING ROUND 2, VRmike, 2026-07-19). The primitive/procedural
// geometry OUR builds add — the beige floor, boundary walls, columns, canisters, and any prop whose
// catalog entry has no asset-pack GLB — is drawn with flat MeshLambertMaterials coloured straight
// from the map/catalog JSON. Under the new hotter default lighting those albedos blew out to
// near-white while the Kenney asset-pack GLBs (their own baked materials) sat fine right beside them
// (see screenshots). This ONE scalar multiplies every build-added primitive's base colour DOWN so it
// reads at the same visual level as the asset-pack props. Asset-pack GLB materials are NEVER touched
// (they load their own materials via GLTFLoader). One source of truth so future build-added geometry
// inherits the corrected level instead of bleaching again. PURE (just a number) — scene.js applies it
// via THREE.Color.multiplyScalar; the guard pins that it's a darkening (<1) factor.
// ---------------------------------------------------------------------------
export const BUILD_GEOMETRY_BRIGHTNESS = 0.6; // multiply non-asset-pack primitive albedo down to match the GLB props

// ---------------------------------------------------------------------------
// SSAO DISTANCE FALLOFF (LIGHTING TUNING ROUND 2, VRmike, 2026-07-19). three r161's SSAOPass
// min/maxDistance are NORMALIZED depth deltas in [0,1] over the camera near..far span — NOT meters.
// The shader only counts a sample as occlusion when `minDistance < (sampleDepth - realDepth) <
// maxDistance`. With our camera far plane at 500, the old maxDistance = 0.1 meant AO kept
// contributing across ~0.1 × (500 − 0.1) ≈ 50 m of depth — so ambient occlusion was visibly
// darkening geometry dozens of meters away (VRmike's report). We express the AO range as WORLD-SPACE
// meters here (tunable) and convert to the normalized deltas the pass wants at build time via
// ssaoDistanceRange(near, far), so AO only darkens close-up crevices. PURE so the guard can pin the
// meters→normalized math without a GL context.
// ---------------------------------------------------------------------------
export const AO_MAX_DISTANCE_METERS = 1.5;  // occlusion ignored beyond ~1.5 m depth difference (near-range only)
export const AO_MIN_DISTANCE_METERS = 0.02; // noise floor: ignore <2 cm self-occlusion (avoids acne)
export const AO_KERNEL_RADIUS_METERS = 0.8; // sampling-sphere radius in view space (already near-range; kept)

// Convert the world-space AO range (meters) to three SSAOPass's normalized [0,1] depth deltas for a
// given camera near/far. viewZToOrthographicDepth maps [-near,-far] LINEARLY onto [0,1], so a depth
// difference of `d` meters is `d / (far - near)` in normalized space. Clamped into [0,1]. PURE.
export function ssaoDistanceRange(near, far) {
  const span = Math.max(1e-6, (Number(far) || 0) - (Number(near) || 0));
  const norm = (m) => Math.max(0, Math.min(1, (Number(m) || 0) / span));
  return { minDistance: norm(AO_MIN_DISTANCE_METERS), maxDistance: norm(AO_MAX_DISTANCE_METERS) };
}

// ---------------------------------------------------------------------------
// SH ambient override — a map JSON may carry PRE-BAKED spherical-harmonic coefficients (9 SH
// bands × RGB = 27 numbers) to skip the per-map cube bake. Accepts either a flat length-27 array
// [r0,g0,b0, r1,g1,b1, …] or a nested length-9 array of [r,g,b] triples. Returns a normalized
// length-9 array of {x,y,z}-less plain [r,g,b] triples, or null if malformed (→ fall back to
// baking). PURE so the guard can pin the load/override path with no renderer.
// ---------------------------------------------------------------------------
export function parseSHCoefficients(input) {
  if (!Array.isArray(input)) return null;
  let triples;
  if (input.length === 27 && input.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    triples = [];
    for (let i = 0; i < 27; i += 3) triples.push([input[i], input[i + 1], input[i + 2]]);
  } else if (input.length === 9 && input.every((t) => Array.isArray(t) && t.length === 3 && t.every((n) => Number.isFinite(n)))) {
    triples = input.map((t) => [t[0], t[1], t[2]]);
  } else {
    return null;
  }
  return triples;
}

// Pull SH coefficients off a map object if it carries a manual override. Looks at `map.sh` or
// `map.shCoefficients`. Returns the parsed length-9 triples or null (→ bake at load).
export function mapSHOverride(map) {
  if (!map || typeof map !== 'object') return null;
  return parseSHCoefficients(map.sh != null ? map.sh : map.shCoefficients);
}
