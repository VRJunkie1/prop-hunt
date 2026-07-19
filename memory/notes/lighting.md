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
  or a manual pick (`userSet`) wins, **else `ensureScene()` seeds `MAX_TIER` (T3) on EVERY device**
  (round-2 flip — see below; `guessTierFromDevice` is still computed for the perf HUD but NO LONGER
  seeds the start tier). The FPS probe steps DOWN if it lags.
- `applyLightingToScene()` pushes tier + tonemap onto the scene + refreshes the pause-menu highlight.
- `setLightingTierManual()` (pause pick) sets `userSet`, saves, and `autoTier.disable()` — manual
  always wins. `setTonemapMode` / `setExposure` persist + apply live.
- `AutoTier` created in `ensureScene()` only when `!userSet`; its `setTier(t, save)` applies + persists
  (auto-save is `userSet=false`, tier-only), `setRenderScale` → `scene.setRenderScale`.
- Frame loop: `perf.beginFrame(now)` at the top of `frame()`, `perf.endCpu(after)` + `autoTier.tick(
  after, perf)` right after `frameBody()` (which contains `scene.render()`).

## Pause menu (`js/ui.js` + `index.html` + `css/style.css`)

- "Lighting Quality" row: 4 tier buttons (T0 Potato / T1 Shadows / T2 SSAO / T3 Bloom) in a row.
  "Tonemap" row: `1.6× Multiply` (DEFAULT) / `Filmic (ACES)` buttons + an exposure slider (0.4–2.6).
  Shown on ALL devices (unlike the PC-only sensitivity slider). Event-delegated; highlight re-pushed
  from state via `ui.setLightingTier(tier)` / `ui.setTonemap(mode, exposure)`. (Multiply factor + slider
  ceiling were pushed ~30% hotter in round 2 — see below.)

## Perf readout (`js/debug.js`, the ?debug=1 overlay — NOT the pause menu)

- New "Perf" section: framerate, CPU frame ms, inferred GPU ms, active lighting tier (`(manual)` /
  `(auto…)`), CPU/GPU-bound verdict. Reads `ctx.getPerf()` (PerfMon) + `ctx.getLighting()` (tier +
  verdict; verdict prefers the auto-tuner's conclusion, else `perfmon.verdict()`).

## Scene integration (`js/scene.js`)

- Constructor builds `this.lighting`; `render()` delegates to it; `resize()` calls `lighting.onResize`;
  `setRenderScale(scale)` scales the pixel ratio for the auto-tier probe. `buildWorld()` ends with
  `_reattachLighting(map)` (scene.clear() drops the rig's lights, so they're re-added + the SH probe
  re-baked from THIS map's center behind the "Get ready…" banner). `_applyShadowFlags()` pushes
  cast/receive-shadow onto every mesh AT buildWorld/tier-change time; `preparePlayerModel` (the one
  player-mesh choke point) sets `castShadow` AND `receiveShadow` from a module flag (`PLAYER_SHADOWS`)
  so a mesh built later (mid-join / disguise swap) inherits BOTH — a primitive-disguised prop then
  catches other players' shadows too, not just the GLB disguises. **Async map GLBs** (tiled floor +
  asset-pack meshes) swap in AFTER that
  traversal, so `instantiateModel` (the shared world-GLB choke point) sets `castShadow` AND
  `receiveShadow` directly — otherwise loaded meshes cast but can't receive (the regression fixed
  2026-07-19; see the SHADOW RECEIVING REGRESSION section).
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

## TUNING ROUND 2 — flipped tier default, hotter tonemap, build-geometry darken, SSAO near-range (VRmike, 2026-07-19, follows c07bafa)

Four playtest items. All presentation-layer; gameplay/netcode/anti-cheat untouched.

1. **Flipped tier default (T3-first).** `guessTierFromDevice` was TOO CONSERVATIVE — VRmike's high-end
   phone defaulted to the bottom tiers yet runs T3 fine. Now `main.js` seeds `MAX_TIER` (T3) on ALL
   devices when there's no saved/manual choice; the runtime FPS probe (`js/auto-tier.js`) is the safety
   net that steps DOWN if the frame actually lags (GPU-bound). A saved/manual pick STILL wins. The
   device guess is still computed (perf HUD) but no longer picks the start tier. Tradeoff: a genuinely
   weak phone may stutter for the ~10 s warmup before the probe demotes it — accepted cost of looking
   great by default. `lightingState.tier` also inits to `MAX_TIER`. Guard §5 pins the MAX_TIER seed.

2. **Tonemap defaults + range (both ~30% hotter).** `multiply` is (and stays) the DEFAULT — VRmike far
   prefers it to ACES filmic. `MULTIPLY_FACTOR` 1.25 → **1.6**; `EXPOSURE_RANGE.max` 2.0 → **2.6** (the
   `index.html` `#exposureSlider max` mirrors it, and the button label is now `1.6× Multiply`). A/B
   toggle + persistence unchanged. Guard §4c pins the factor, ceiling, slider-max mirror, and default.

3. **Build-geometry darken (anti-bleach).** OUR build-added primitives (beige floor, boundary walls,
   columns, canisters, and any catalog entry WITHOUT an asset-pack GLB — all flat `MeshLambertMaterial`
   coloured from map/catalog JSON) blew out to near-white under the hotter light, while Kenney GLB props
   sat fine beside them. ONE shared scalar `BUILD_GEOMETRY_BRIGHTNESS = 0.6` (in `lighting-tiers.js`)
   multiplies those albedos DOWN. Applied in `scene.js` at the THREE-color choke points:
   `makePropMesh` (every primitive prop/fixture/disguise-fallback), the ground plane, and the boundary
   walls — via `new THREE.Color(...).multiplyScalar(BUILD_GEOMETRY_BRIGHTNESS)`. **Asset-pack GLB
   materials are NEVER touched** (they load their own materials through GLTFLoader; the primitive is only
   a pre-swap fallback). One source of truth so future build-added geometry inherits the fix. Guard §4c
   pins it's a darkening (<1) factor + the scene.js wiring.

4. **SSAO near-range falloff.** AO was darkening geometry dozens of meters away. three r161 SSAOPass
   `min/maxDistance` are NORMALIZED depth deltas over the camera near..far span (NOT meters): the shader
   counts occlusion only when `minDistance < (sampleDepth − realDepth) < maxDistance`. With our camera
   far = 500, the old `maxDistance = 0.1` ⇒ ~0.1×499.9 ≈ **50 m** of bleed. Now expressed as WORLD-SPACE
   meters (`AO_MAX_DISTANCE_METERS = 1.5`, `AO_MIN_DISTANCE_METERS = 0.02`, `AO_KERNEL_RADIUS_METERS =
   0.8`) and converted per-camera by `ssaoDistanceRange(near, far)` (`d / (far−near)`, clamped [0,1]) in
   `lighting.js _buildComposer`. At far=500, 1.5 m → normalized 0.0030 — near-range only. Guard §4c pins
   the meters→normalized math + the lighting.js wiring.

**Verified:** `check-lighting.mjs` all green (incl. new §4c); `js/lighting-selftest.js` via
`browser_check` — all 4 tiers render (no black screen) with shadows reading on desktop AND phone
profiles under the new hotter default; the floor now sits at a controlled mid-grey instead of bleaching.

## SHADOW RECEIVING REGRESSION + BIAS TUNING (VRmike, 2026-07-19, follows f53143f)

Two playtest bugs, both surfaced by round-2's T3-first default (shadows are now ON by default for
everyone, so latent shadow bugs became visible).

### 1) Cast shadows only landed on the beige primitive floor — REGRESSION (root cause + fix)
Symptom: the hunter's cast shadow showed on the build-created beige `ground` plane but NOT on the tiled
kitchen floor or any asset-pack GLB. AO showed everywhere. **Root cause (found via git, not guessing):**
`receiveShadow` was ONLY set by `scene._applyShadowFlags()`, which runs as a ONE-SHOT `scene.traverse`
at the end of `buildWorld()` (and on tier changes). But every loaded map GLB — the tiled floor + all
asset-pack meshes — swaps in **asynchronously** via `_loadModels()` → `_applyModel()` → `instantiateModel()`,
which fires AFTER that traversal has already run. `instantiateModel` set `castShadow = true` but never
`receiveShadow`, so the async GLBs cast but couldn't RECEIVE. The synchronously-built primitives (beige
ground, walls, primitive props) got `receiveShadow` from the buildWorld traversal — hence "only the beige
floor." This was latent since the shadow system landed (bb40a2e); f53143f's T3-default made it visible.
**Fix (one line at the shared choke point):** `instantiateModel` now also sets `o.receiveShadow = true`
in its mesh traversal — the ONE path every world GLB (game + editor) routes through. Harmless when the
tier has shadows off (`shadowMap.enabled=false`); a later tier change's `_applyShadowFlags()` still
re-syncs the whole scene (belt AND suspenders). Guard §4d asserts the receiveShadow set survives.
`preparePlayerModel` (the player-mesh choke point) got the matching treatment — it now sets
`receiveShadow` alongside `castShadow` off `PLAYER_SHADOWS`, so a late-built primitive/capsule player
mesh (mid-join / disguise swap) also receives; GLB disguises already inherit it via `instantiateModel`.

### 2) White spots in shadow centers at close ground contact (bias tuning)
Symptom: a bright hole in the shadow blob under a prop/player right where the model nearly touches the
ground. That's the anti-acne `normalBias` pushed too high — it offsets the shadow lookup along the
surface normal, and past a point it LEAKS light through the shadow at contact. The right value scales
with shadow-map RESOLUTION (smaller texels ⇒ less offset needed), and everyone now defaults to the 2048
top tier where the fixed old value (`normalBias 0.02`, `bias −0.0006`) over-shot. **Fix:**
`shadowBiasFor(shadowMapSize)` in `lighting-tiers.js` scales both bases by `min(1, 1024/size)` — so the
2048 tier is **halved** (`normalBias 0.01`, `bias −0.0003`, killing the contact leak) while the 512/1024
tiers stay at their prior known-good values (`factor = 1`). `lighting.js` sets the contact light's
`shadow.bias`/`shadow.normalBias` from it per-tier. Starting point per VRmike ("roughly halve it");
retune the two bases (`SHADOW_BIAS_BASE`, `SHADOW_NORMAL_BIAS_BASE`) or the `SHADOW_BIAS_REF_MAPSIZE`
reference in one place. Guard §4d pins the halving math + the lighting.js wiring.

**TRAP for the next lighting pass:** a material/darkening pass that CLONES or REPLACES materials does
NOT lose `receiveShadow` (it's a mesh property, not a material one) — but any code that builds map meshes
must route through `instantiateModel` (or otherwise set `receiveShadow`) because `_applyShadowFlags`
only runs at buildWorld/tier-change, never when an async GLB pops in. Don't "fix" contact white-spots by
cranking shadow darkness — it's the bias.

## Guard

`tools/check-lighting.mjs` — headless: tier resolution, device heuristic, tonemap, SH override, AMBIENT
intensity tunable (§4b), round-2 tuning (§4c), the shadow-receiving regression guard + resolution-aware
bias math (§4d), persistence+wiring incl. the two hotfix source guards (RenderPass-before-SSAO,
ambient routing) in §5, the LightingRig THREE mapping (mock renderer), PerfMon, and the AutoTier state
machine. Run: `node tools/check-lighting.mjs`. The VISUAL half rides `js/lighting-selftest.js` via
`browser_check` (see above) — headless GL can't be exercised from node.
