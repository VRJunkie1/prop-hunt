# Held-item alignment tuner (debug menu, ?debug=1)

Built 2026-07-20 (VRmike task "HELD-ITEM ALIGNMENT TUNER IN DEBUG MENU", branch
`build/215-held-item-alignment-tuner`). **Attempt 4** at lining up the rifle/grenade/finder in the
hunter's hand + on the character model. Builds #190/#208/#212 tried to GUESS the offset numbers and
kept missing (#212 also died on infra, not logic). Per VRmike this switches to a **human-in-the-loop**
tuner: give the player live knobs, they nudge until it looks right, Export → paste in chat → a
follow-up build bakes the numbers into `shared/config`. **This build changes NO default offsets** —
it ships only the tuner + export, all behind `?debug=1`.

## The root insight — why 3 blind guesses missed (map first, per the plan)

The held item is placed by **TWO independent code paths reading DIFFERENT numbers**:

- **First-person viewmodel** — `js/scene.js _buildViewModel` / `setViewModel`. A mesh parented to the
  CAMERA. Transforms are **HARDCODED** (rifle scaled to ~0.5 m, `rotation (0, π/2, 0)`, group at
  `(0.32, -0.3, -0.7)`; finder/grenade primitives). It does NOT read `character-models.json`.
- **Third-person character model** — `js/scene.js _buildHunterModel`. The three held meshes parented
  to the `Wrist.R` bone, placed from `character-models.json hunter.weapon.*` (`position`,
  `rotationDeg`, `worldLength`×`scale`, and the bone-local `forwardOffset`/`downOffset` via
  `shared/hunter-sizing.js heldItemBoneOffset`).

Two separate frames, two separate number sets → the classic **"looks right in my hand, floats wrong in
everyone else's view"** signature. The reported bug lives in OTHER players' third-person views, which
the first-person numbers never touched. **Not unified in this build** (its own refactor, its own
regression risk) — the tuner override is wired into BOTH sites instead. Unifying them once the correct
numbers are known is a possible follow-up.

## What ships

A `?debug=1`-gated **"Held-item alignment"** section in the existing debug menu (`js/debug.js`):

- **Per-item tabs** — rifle / finder / grenade, each tuned independently. `●` marks the currently
  equipped tool (read from `state.tool`); the panel starts on it and you can switch tabs to tune any.
- **Seven +/− steppers with live numeric values** — position X/Y/Z (m, step 0.01), rotation
  pitch/yaw/roll (°, step 1), scale (×, step 0.02, floor 0.05). Finger-friendly (no fiddly sliders).
- **Per-item Reset** + **Export ⧉** — Export serializes all items to a copy-pasteable JSON block
  (via the shared core), copies to the clipboard AND shows it in a selectable `<textarea>` (phone
  clipboards are unreliable — the box is the real copy path).

The override is a **LAYER on the shipped defaults** (all-zeros / scale-1 = no change), so a normal
launch is byte-for-byte unchanged. It applies **live at both mount sites**, so a nudge updates in
first-person AND on every character model the client renders (your own via free cam / any hunter a
friend is watching — the point of the exercise).

## How the override reaches both mount sites (js/scene.js)

- **`this._itemTuner`** — the normalized override store `{ rifle, finder, grenade }`, each
  `{ position:{x,y,z}, rotationDeg:{pitch,yaw,roll}, scale }`. **Defaults to `null`** = no override =
  shipped behaviour. Only ever set under `?debug=1`.
- **`setItemTuner(store)`** — installs the override (normalizes through `shared/item-tuner.js
  normalizeTuning`) and re-applies LIVE to the current viewmodel + every hunter model on screen. Called
  by debug.js on load-from-localStorage and on every nudge/reset.
- **`_tunerFor(toolId)`** — the single read of the store; returns a zeroed override when none is
  installed / no entry (never null, so callers stay branch-free → defaults untouched).
- **Third-person (`_buildHunterModel` → `_applyItemTunerToCtl`).** At build, each held mesh records its
  shipped-default local transform (`m.userData.tunerBase = {pos, quat, scale}`) and the wrist's
  BUILD-TIME orientation + inverse scale (`ctl.grip`, captured while the group yaw is 0 — the SAME
  frame `heldItemBoneOffset` bakes the shipped forward/down offset into). `_applyItemTunerToCtl` sets
  `final = base (+) override`: the position offset is authored in **character space** (x=right, y=up,
  z=forward) and converted to bone-local via `ctl.grip.qiBuild`, so "+Y" is world-up on the model and
  the offset rides the arm as the hunter turns/tilts; rotation layers pitch/yaw/roll onto the base;
  scale multiplies. Re-applied at build so a **respawn / round flip / model rebuild** keeps the tuning.
- **First-person (`setViewModel` → `_applyItemTunerToViewModel`).** The viewmodel GROUP records its
  shipped-default transform; the override applies in **camera space** (forward = −Z, so the char-space
  z maps to −z). Same rotation/scale layering. Re-applied on tool switch.

## Persistence (js/debug.js, ?debug=1 only)

- localStorage key **`ph_debug_item_tuner`** (debug-only). `_loadTuner` reads + normalizes it at
  construct (only when `ctx.debugFlag`); every nudge/reset `_saveTuner`s. A tuning session survives
  respawn, round flips, and page reload.
- `frame()` re-pushes the stored override whenever a **fresh scene** appears (`scene !== _tunerScene`
  — page reload / new match). Within one scene, model rebuilds pick it up automatically (build sites
  read `scene._itemTuner`).
- **Gated on `ctx.debugFlag` (`?debug=1`)**: without the flag the tuner section isn't built, storage
  isn't read, and `setItemTuner` is never called → shipped defaults stay exactly as they are.

## Export format (shaped for baking)

`shared/item-tuner.js exportTuning` emits VALID JSON:

```json
{
  "_comment": "HELD-ITEM ALIGNMENT — tuned live via ?debug=1 ... to bake, teach both mount sites ...",
  "heldItemTuning": {
    "rifle":   { "position": {"x":0,"y":0,"z":0}, "rotationDeg": {"pitch":0,"yaw":0,"roll":0}, "scale": 1 },
    "finder":  { ... },
    "grenade": { ... }
  }
}
```

**Baking it in later** (follow-up build, once VRmike's numbers arrive): fold `heldItemTuning[item]`
into the shipped placement at BOTH mount sites (`_buildHunterModel` third-person + `_buildViewModel`
first-person). The clean end-state is per-item config replacing the current single shared `weapon`
block; or unify the two mount sites first (the deferred refactor above). `importTuning` round-trips
the export for a follow-up tool.

## Shared core — `shared/item-tuner.js` (single source of truth)

Pure merge/normalize/serialize (no browser globals, no CDN), imported by BOTH `js/debug.js` (its ONLY
import — via a RELATIVE specifier so it resolves in the browser AND in Node) and `js/scene.js`, and
exercised directly by the headless check. `TUNER_ITEMS`, `zeroTuning`, `normalizeItem`,
`normalizeTuning`, `isDefaultTuning`, `exportTuning`, `importTuning`. `normalizeItem` forces a
non-positive scale back to 1 (no collapsed/mirrored mesh) and coerces non-finite fields to 0.

## Verification

- **`tools/check-item-tuner.mjs`** (NEW, 46 ✓) — exercises the REAL merge/export logic (layers over
  defaults, per-item independence, export→valid config, round-trip), asserts BOTH mount sites read the
  override (source/wiring — headless can't render), the debug UI is `?debug=1`-gated + localStorage-
  persisted, and the shipped `character-models.json` offsets are UNCHANGED.
- `tools/check-debug-menu.mjs` — invariant relaxed: debug.js may import ONLY the pure item-tuner core
  (the Node `await import` of debug.js still proves no browser-only dep sneaks in — that's the real
  guarantee). Regression sweep GREEN: check-blindfold (scene.setItemTuner now in its scene-method
  list), check-tool-visibility, check-hunter-model, check-held-item-offset, check-flicker.
- `browser_check` boots clean (0 console errors) on `?debug=1` and a normal launch.

**OWED — VRmike's eyeball (the human-in-the-loop PREMISE, not a gap).** Headless can't render, so the
ACTUAL alignment is VRmike's to tune. Open `?debug=1`, tune each item until the grip looks right in
first-person AND on the model, Export, paste in chat. The headless check proves the values REACH both
paths, not that the item LOOKS right — that's deliberately the human's job.

## Note on the two-frame override (honest limitation)

ONE override per item drives BOTH views. The first-person (camera) and third-person (bone) frames
differ, so the same numeric offset produces different visual magnitudes in each view — the third-person
(the actual bug) is the one to get right; the first-person moves correlatedly as a preview. If a future
build wants them decoupled, split the store into per-view offsets — but the whole point of attempt 4 is
to fix the THIRD-PERSON placement, which this targets directly.
