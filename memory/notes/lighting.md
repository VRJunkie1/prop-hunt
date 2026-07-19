# Lighting overhaul — 4-tier quality + SH ambient + tonemap + perf HUD

VRmike, 2026-07-19, branch `lighting-overhaul`. The renderer gained a quality-tier system, a baked
SH ambient probe, an A/B tonemap, per-frame CPU/GPU cost instrumentation, a runtime auto-tuner, and
a perf readout in the debug menu. This note is the map of the pieces.

## Files

- **`js/lighting-tiers.js` (PURE — no THREE/DOM).** The "effect switchboard" + all the config math:
  - `EFFECT_KEYS` (5 independent switches: `shProbe`, `contactShadow`, `angledFill`, `ssao`, `bloom`),
    `TIERS` preset table, `resolveTierConfig(tier)` → `{tier, <5 booleans>, shadowMapSize, usesComposer}`.
  - `guessTierFromDevice({gpu, deviceMemory, cores, screenPx})` — the initial device heuristic
    (software→T0, mobile→≤T1, discrete+RAM→T3, unknown→T2, clamped).
  - `resolveTonemap(mode, exposure)` — `multiply` → `LinearToneMapping` with exposure folded to
    1.25×slider (the flat "1.25× multiply"); `filmic` → `ACESFilmicToneMapping`, slider = exposure.
    Exposure is the PRE-tonemap multiplier so filmic+exposure covers the hybrid look.
  - `parseSHCoefficients` / `mapSHOverride` — the manual SH-override load path (flat-27 or nested-9).
  - localStorage key constants (`prophunt.lightingTier`, `.lightingUserSet`, `.tonemap`, `.exposure`).
  - Guarded headless by `tools/check-lighting.mjs` §1–5,7,8.
- **`js/lighting.js` (THREE — `LightingRig`).** Maps the resolved config onto real THREE objects,
  owned by `scene.js` as `scene.lighting`. Builds/tears-down the SH LightProbe, the straight-down
  contact-shadow `DirectionalLight` (tight ortho frustum, per-tier shadow-map size), the angled fill
  light, and the SSAO/bloom `EffectComposer` (RenderPass/SSAOPass/UnrealBloomPass/OutputPass, LAZY-
  imported like GLTFLoader). `render()` picks composer vs direct render; tonemap goes on the renderer
  so it works on ALL tiers incl. T0. The sibling import is RELATIVE (`./lighting-tiers.js`) so the
  guard's §6 can load the rig in node with a mock renderer + real THREE objects.
- **`js/perfmon.js` (PURE-ish).** `PerfMon` — allocation-free per-frame stopwatch. `beginFrame(now)`
  records the inter-frame gap (total frame time) + opens the CPU stopwatch; `endCpu(now)` closes it
  (CPU = physics+logic+render submission) and infers GPU = `max(0, frameMs - cpuMs)`. `verdict()` →
  `'cpu'|'gpu'|'even'`. Guard §7.
- **`js/auto-tier.js` (PURE — injectable).** `AutoTier` state machine (warmup→decide→settle/resprobe→
  done). Only steps DOWN, once, when the evidence is GPU-bound; keeps+SAVEs if a step meaningfully
  improves FPS, else reverts + marks CPU-bound; then cools down (disabled — no yo-yo). Ambiguous →
  render-scale probe (`ctx.setRenderScale(0.7)` ~2s, FPS jump ⇒ GPU-bound). `disable()` on a manual
  pick. Guard §8 (7 scenarios A–G).

## Wiring (`js/main.js`)

- `lightingState` mirrors what's applied (tier / userSet / hasSaved / cpuBound / verdict / tonemap /
  exposure). Boot: `loadLightingTier()` + `loadTonemap()` from localStorage; a saved tier (`hasSaved`)
  or a manual pick (`userSet`) wins, else `ensureScene()` seeds from `guessTierFromDevice(deviceHints(
  renderer))` once the GL context exists (GPU string via `WEBGL_debug_renderer_info`).
- `applyLightingToScene()` pushes tier + tonemap onto the scene + refreshes the pause-menu highlight.
- `setLightingTierManual()` (pause pick) sets `userSet`, saves, and `autoTier.disable()` — manual
  always wins. `setTonemapMode` / `setExposure` persist + apply live.
- `AutoTier` created in `ensureScene()` only when `!userSet`; its `setTier(t, save)` applies + persists
  (auto-save is `userSet=false`, tier-only), `setRenderScale` → `scene.setRenderScale`.
- Frame loop: `perf.beginFrame(now)` at the top of `frame()`, `perf.endCpu(after)` + `autoTier.tick(
  after, perf)` right after `frameBody()` (which contains `scene.render()`).

## Pause menu (`js/ui.js` + `index.html` + `css/style.css`)

- "Lighting Quality" row: 4 tier buttons (T0 Potato / T1 Shadows / T2 SSAO / T3 Bloom) in a row.
  "Tonemap" row: `1.25× Multiply` / `Filmic (ACES)` buttons + an exposure slider (0.4–2.0). Shown on
  ALL devices (unlike the PC-only sensitivity slider). Event-delegated; highlight re-pushed from state
  via `ui.setLightingTier(tier)` / `ui.setTonemap(mode, exposure)`.

## Perf readout (`js/debug.js`, the ?debug=1 overlay — NOT the pause menu)

- New "Perf" section: framerate, CPU frame ms, inferred GPU ms, active lighting tier (`(manual)` /
  `(auto…)`), CPU/GPU-bound verdict. Reads `ctx.getPerf()` (PerfMon) + `ctx.getLighting()` (tier +
  verdict; verdict prefers the auto-tuner's conclusion, else `perfmon.verdict()`).

## Scene integration (`js/scene.js`)

- Constructor builds `this.lighting`; `render()` delegates to it; `resize()` calls `lighting.onResize`;
  `setRenderScale(scale)` scales the pixel ratio for the auto-tier probe. `buildWorld()` ends with
  `_reattachLighting(map)` (scene.clear() drops the rig's lights, so they're re-added + the SH probe
  re-baked from THIS map's center behind the "Get ready…" banner). `_applyShadowFlags()` pushes
  cast/receive-shadow onto every mesh; `preparePlayerModel` (the one player-mesh choke point) sets
  `castShadow` from a module flag so a mesh built later (mid-join / disguise swap) inherits it.
- **Context-loss (phones):** a NEW `webglcontextrestored` handler calls `lighting.onContextRestored()`
  (dispose composer + shadow map so they rebuild) then `_reattachLighting()` — the classic way phones
  silently lose new render state after a tab-switch. (`webglcontextlost` preventDefault was already there.)

## Tier presets (retune by editing the TIERS table)

| Tier | shProbe | contactShadow (map) | angledFill | ssao | bloom |
|------|---------|---------------------|-----------|------|-------|
| T0   | –       | –                   | –         | –    | –     |  today's look, potato mode
| T1   | ✓       | ✓ (512)             | –         | –    | –     |  contact shadows for jump accuracy
| T2   | ✓       | ✓ (1024)            | ✓         | ✓    | –     |
| T3   | ✓       | ✓ (2048)            | ✓         | ✓    | ✓     |

## Tonemap trick (why it's on the renderer, not a shader pass)

`multiply` = `LinearToneMapping` (three's `saturate(exposure*color)`) with exposure = 1.25×slider →
a flat RGB multiply that works on EVERY tier with no composer. `filmic` = `ACESFilmicToneMapping`.
Three only tone-maps materials when rendering to SCREEN (r161 WebGLRenderer: `currentRenderTarget ===
null`), so the composer path's RenderPass/SSAOPass render LINEAR into a target and `OutputPass` applies
the same `renderer.toneMapping` at the very end — no double-apply.

## OWED — live pass (visual effects can't be headless-checked)

- Boot-clean verified on desktop + phone profiles (menu). NOT yet verified in a live match: SH probe
  ambient fill on map load, contact shadows under props/players (T1 jump accuracy), SSAO (T2), bloom
  (T3), the tonemap A/B + exposure feel, and the auto-tier FPS probe actually stepping a slow phone
  down + saving. Also: confirm an OLD phone survives T0/T1 (T1's whole justification), and the phone
  tab-switch context-loss path rebuilds shadows + the probe. If T1 tanks on a phone, auto-tiering
  demotes to T0 (nobody gets stuck).

## Guard

`tools/check-lighting.mjs` — 8 sections, all headless: tier resolution, device heuristic, tonemap,
SH override, persistence+wiring (source), the LightingRig THREE mapping (mock renderer), PerfMon, and
the AutoTier state machine. Run: `node tools/check-lighting.mjs`.
