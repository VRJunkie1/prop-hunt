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
| T0   | –       | –                   | –         | –    | –     |  potato mode (no shadows); base HemisphereLight now LOW ambient too (2026-07-19 washout fix), so slightly darker than the original build's T0
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

- The RENDER PATH is now verified per-tier on desktop + phone via `js/lighting-selftest.js` (all four
  tiers render, not black; shadows read on T1+) — see the HOTFIX section. Still owes a human PLAYTEST
  in a real match (a real map's props/players, the actual "Get ready…" SH bake, disguise swaps): the
  tonemap A/B + exposure feel, bloom (T3) on real emissive-ish surfaces, and the auto-tier FPS probe
  actually stepping a slow phone down + saving. Also confirm an OLD phone survives T0/T1 and the phone
  tab-switch context-loss path rebuilds shadows + the probe. If T1 tanks on a phone, auto-tiering
  demotes to T0 (nobody gets stuck).

## HOTFIX — black screen on T2/T3 + ambient washout (VRmike, 2026-07-19, follows bb40a2e)

Two playtest-blocking bugs from the first build, both purely visual (a headless check can't see them):

### 1) BLACK SCREEN on the top two tiers (T2/T3) — ROOT CAUSE + FIX
Symptom: T2/T3 rendered normally for ~1s then went SOLID BLACK (UI/DOM stayed up → 3D only).
- The ~1s is the LAZY CDN import of the postprocessing addons; until it resolves `render()` falls back
  to a direct `renderer.render()` (fine). The instant the composer built and took over → black.
- **Root cause:** `_buildComposer()` used `SSAOPass` as the FIRST pass with NO `RenderPass` ahead of
  it. In three **r161**, `SSAOPass.OUTPUT.Default` does **not** render the scene beauty — it reads the
  incoming colour from `readBuffer.texture` and composites AO over it (verified against the r161
  SSAOPass source + the official `webgl_postprocessing_ssao` example, which is RenderPass → SSAOPass →
  OutputPass). With nothing feeding `readBuffer`, the beauty was an empty (black) buffer → whole frame
  black.
- **Fix:** `_buildComposer()` now ALWAYS adds `RenderPass` first, then `SSAOPass` (if `ssao`), then
  bloom, then `OutputPass`. Guarded by `check-lighting.mjs` §5 (RenderPass index < SSAOPass index).
- **Tier-switch rebuild is safe:** `autoTier.tick()` runs at the END of `frame()` AFTER
  `scene.render()`, so tier changes (manual or auto) happen BETWEEN frames, never mid-frame, and the
  rebuilt composer always leads with a RenderPass. The old "one frame then black" was the lazy import
  completing into a structurally-broken chain, NOT a mid-frame rebuild.

### 2) AMBIENT washout — the floor was near-white, shadows drowned
Inventory of every "flat fill from everywhere" source found (there were TWO, both at full 1.0):
- the base **HemisphereLight** in `scene.buildWorld()` (intensity 1.0, all tiers), and
- the **SH ambient probe** in `lighting.js` (`_probe.intensity = 1`, T1+).
(There is NO `AmbientLight`, `scene.environment`, or material `envMap` — those were checked and ruled
out. The `sun`/contact/angled lights are DIRECTIONAL, not ambient.)
- **Fix:** ONE tunable — `AMBIENT_INTENSITY_DEFAULT = 0.3` (LOW) in `lighting-tiers.js`, per-map
  overridable via `map.ambientIntensity` (`resolveAmbientIntensity(map)`, clamped 0..2). BOTH ambient
  sources route through it: `scene.buildWorld` sets the HemisphereLight intensity from it, and
  `LightingRig` stores `this._ambient` per-reattach and uses it for the SH probe intensity (override +
  bake paths). Editor preview (`editor.js`) uses the same helper so it matches the game.
- **Shadow readability:** the contact (straight-down, shadow-casting) light was bumped **0.5 → 1.0** so
  the down-shadow — the only shadow, and the whole point of that light — reads CLEARLY once ambient is
  low (a soft 0.5 was drowned by the fill lights). Straight-down = the shadow sits under a resting prop
  (mostly hidden) and separates onto the floor when the prop is AIRBORNE — that's the jump-accuracy cue.

### Render self-test — `js/lighting-selftest.js` (DEV-ONLY, gated `?lightingtest=…`)
Because both bugs are visual, `main.js` lazy-loads this harness ONLY when `?lightingtest` is in the URL
(never in normal play). It boots the real `Scene3D` render path, forces each tier for >3s (past the
composer's lazy-import window), then READS BACK canvas pixels and asserts (a) not-black (`mean>20`,
`fracBlack<0.9`) on all four tiers and (b) shadows read on T1+ (lit floor − shadowed floor > 16, using
grey-only pixels inside the projected prop-ring so the bright sky / empty floor can't mask a washout).
The test props FLOAT (`p.y` offset) so their straight-down shadows land on open floor — the jump case.
`?lightingtest=all` sweeps T0–T3; `?lightingtest=2` holds one tier for a screenshot. Failures →
`console.error` (surfaced by `browser_check`). VERIFIED: 4/4 tiers pass on desktop + phone profiles.

## Guard

`tools/check-lighting.mjs` — headless: tier resolution, device heuristic, tonemap, SH override, AMBIENT
intensity tunable (§4b), persistence+wiring incl. the two hotfix source guards (RenderPass-before-SSAO,
ambient routing) in §5, the LightingRig THREE mapping (mock renderer), PerfMon, and the AutoTier state
machine. Run: `node tools/check-lighting.mjs`. The VISUAL half rides `js/lighting-selftest.js` via
`browser_check` (see above) — headless GL can't be exercised from node.
