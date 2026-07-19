# PC feel/controls — mouse sensitivity + controls reference (B4)

**Build:** B4 — PC FEEL/CONTROLS (2026-07-18, VRmike, branch build/144-b4-pc-feel-controls).
Three PC/keyboard-side playtest fixes; the mobile touch UI is deliberately untouched. The RUN
SPEED knob half of B4 lives in `notes/balance-tuning.md` (it's a balance value). This note covers
the two UI pieces: the mouse-sensitivity slider and the always-visible controls reference panel.

## 1. Mouse sensitivity slider (PC only)

**Feel:** desktop mouse-look was a hard-coded `this.sensitivity = 0.0022` in `js/input.js`. Now it's
`BASE_SENSITIVITY (0.0022) × multiplier`, so **1.0× reproduces the old feel byte-for-byte**. The
slider ranges **0.2×–3×** (VRmike's ask), default 1×, step 0.05.

**Where the pieces live (each owns one concern):**
- `js/input.js` — the MODEL + application. Module consts `BASE_SENSITIVITY = 0.0022` and the
  exported `SENSITIVITY_RANGE = {min:0.2, max:3, default:1, step:0.05}`. `setSensitivity(mult)`
  clamps to the range, sets `this.sensitivity = BASE × mult`, stores `this.sensitivityMult`, and
  returns the applied (post-clamp) value. Applied LIVE — the next `mousemove` uses it, so dragging
  the slider changes feel instantly, no Apply button / restart. input.js is storage-free (stays
  unit-testable); it only APPLIES the value. **Touch drag-look (`touchLookSens`) is a SEPARATE knob
  and is untouched** — this slider is desktop mouse-look only.
- `js/main.js` — PERSISTENCE (localStorage, NOT cookies, per spec). `SENS_KEY =
  'prophunt.sensitivity'`; `saveSensitivity(mult)` / `loadSensitivity()` mirror the existing
  `saveName`/`loadSavedName` pattern. `loadSensitivity()` parses the stored value and **silently
  falls back to 1.0× on anything missing / corrupted / out of range** (clamped to `SENSITIVITY_RANGE`
  so a hand-edited localStorage value can't push it out of band). At boot: load → `input.setSensitivity`
  → `ui.setSensitivityValue`, then wire `ui.onSensitivityChange = (mult) => saveSensitivity(input.setSensitivity(mult))`
  (persist the post-clamp value input actually applied).
- `js/ui.js` — the WIDGET. Elements `#pauseSensRow` / `#pauseSens` (range input) / `#pauseSensVal`
  (the "1.00×" label). The slider's `input` event (fires continuously while dragging) updates the
  label + calls `onSensitivityChange`. `setSensitivityValue(mult)` reflects a value into slider +
  label. **PC-only gate:** in the constructor, `if (prefersTouchControls()) #pauseSensRow → .hidden`
  — the SAME device check the control scheme uses, so the mobile pause menu is untouched.
- `index.html` — `#pauseSensRow` block in the pause card (between room-code and scoreboard):
  `<input id="pauseSens" type="range" min="0.2" max="3" step="0.05" value="1">`.
- `css/style.css` — `.pause-sens*` (slider full-width, `accent-color` matches the theme pink).

**Persistence contract (the check):** survives a reload AND future sessions (localStorage, not
session/cookie). Reload → `loadSensitivity()` restores it → applied before first look input.

## 2. PC controls reference panel (always-visible, PC only)

An unobtrusive **bottom-right corner** list of every keyboard/mouse binding, **visible by default**,
with a tiny **▾/▸ collapse toggle** (collapses to just the header). So a PC player never has to open
the pause menu to check controls.

- `index.html` — `#controlsRef` panel inside `#game` (so it only shows during a match, not on the
  menu/lobby): header (`.controls-ref-title` + `#controlsRefToggle`) + `#controlsRefBody`. Ships
  with class `hidden`; revealed by `buildControlsRef()` on PC.
- `js/ui.js` — `buildControlsRef()` (called once from main.js boot): on touch → leave `.hidden` and
  return (phones already show their on-screen buttons); on PC → populate `#controlsRefBody` from
  **`_controlsHtml()`** and unhide. **Single source of truth:** the corner panel and the pause
  "Controls" panel render from the SAME `_controlsHtml()` rows (kept next to where the desktop
  bindings are described), so the list can't quietly drift out of date. `_toggleControlsRef()`
  flips a `.collapsed` class + swaps the toggle glyph.
- `css/style.css` — `.controls-ref*`: fixed corner, semi-transparent (opacity 0.82, → 1 on hover),
  z-index 38 (below toolbar/pause, above world). `.controls-ref.collapsed .controls-ref-body {
  display:none }`.

The desktop rows cover everything VRmike listed: move (WASD/Arrows), look (Mouse), fire/disguise
(Left-click), turn-disguise (Right-click), Jump (Space), disguise (E), tools (1/2/3), taunt (T),
view (V), free-mouse (`` ` ``), pause (Esc).

## 3. ROLE-FILTERED controls list (B8, 2026-07-18, VRmike)

**Complaint:** the panel showed BOTH prop AND hunter controls merged into one list (e.g. one row
"Left-click — Hunter: rapid-fire · Prop: disguise"). Now it shows ONLY the current player's role.

- `js/ui.js _controlsHtml()` was rewritten to build FOUR row groups per scheme (touch/PC): `common`
  (move/look/jump/menu — and `` ` ``/Esc on PC), `hunter` (fire · 1/2/3 tools · V), `prop`
  (disguise · turn-disguise · E · T taunt · V), and `spectator` (fly-cam + player-switch). It composes
  by `this._controlsRole`: `'spectator'` → spectator rows; `'hunter'`/`'prop'` → `common` + that role;
  `null` (lobby / pre-spawn) → `common` only. **Single source of truth preserved** — the always-visible
  corner panel (`buildControlsRef`) and the pause "Controls" panel (`_togglePauseHelp`) both render from
  `_controlsHtml()`, so they can't drift.
- `ui.setControlsRole(mode)` stores the mode and, IDEMPOTENTLY (no-op if unchanged → no DOM churn),
  re-renders the corner panel if visible + the pause panel if open.
- `js/main.js` pushes the mode on EVERY event that changes what you are, via `updateControlsList()`
  (`controlsMode()` = `state.spectate.on ? 'spectator' : role`): from `applyRole` (role assign /
  snapshot self-heal / **round flip** / team switch), the onSnapshot **alive-flip** (death → spectator,
  respawn → role), and `setSpectating`. So the list re-filters live on team switch, round flip, and death.
- **Guard compatibility:** `check-pc-controls.mjs` §3 and `check-spectator.mjs` slice the `_controlsHtml`
  SOURCE and look for literal needles (`WASD`, `Space`, `1 / 2 / 3`, `Left-click`, `T`, `Esc`,
  `Spectating`) — all four groups live in the function body, so every literal is still present and both
  checks stay green. The role FILTERING itself isn't headless-visible (DOM at runtime); owed to the live
  pass. Touch vs PC classification (`prefersTouchControls`) is unchanged.

## Verify

- **Guard:** `tools/check-pc-controls.mjs` (new, B4) — source + range asserts: moveSpeed is a
  config knob read by host+client (never hardcoded in the JS movement paths); sensitivity is a
  live multiplier persisted to localStorage (not cookies) with a 0.2–3 / default-1 range;
  the controls panel exists, is built from `_controlsHtml()` (single source), hidden on touch, and
  its list covers move/jump/tools/fire/taunt/pause. GREEN.
- `tools/check-input-mode.mjs` GREEN (the `prefersTouchControls` gate the PC-only hiding relies on).
- `tools/check-solid-players.mjs` GREEN at `moveSpeed = 9` (it reads the knob relationally).
- Page boots clean (0 console errors, desktop).

## OWED — live pass
- **Desktop:** open pause → drag the sensitivity slider → look feel changes live (no restart);
  reload the page → the setting is still there; the controls panel sits in the bottom-right, reads
  clearly, and the ▾/▸ toggle collapses/expands it.
- **Mobile:** the pause menu shows NO sensitivity slider and the corner controls panel is ABSENT
  (touch buttons unchanged).
- **Run speed:** confirm +50% feels right (or dial `rules.moveSpeed` back — one number) — see
  `notes/balance-tuning.md`.
