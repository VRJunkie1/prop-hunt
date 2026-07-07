# phone / touch controls

Full mobile playability (portrait + landscape) added on `vrmike/dev`. The whole
touch layer lives in **`js/input.js`** and emits the SAME action/movement/look
values the desktop path emits — so net/referee/scene/desktop notice nothing. This
is the deliberate seam: one input module, many control schemes, one output shape.

## Detection & lane separation
`Input` picks a scheme once at construction: `isTouchDevice()` = `'ontouchstart'
in window || navigator.maxTouchPoints > 0`.
- Touch → `_wireTouch()` only (drag-look + overlay tap). Pointer-lock/mouse
  listeners are NOT attached, so a phone never fires `pointerlockerror`.
- Desktop → `_wireDesktop()` only (the unchanged keyboard + pointer-lock path).
Keyboard listeners are always on (a hybrid laptop), but action keys are gated on
pointer lock, which touch never has — so they're inert on a pure phone.

## The three controls
- **Movement — nipplejs virtual joystick.** MIT lib, **lazy-loaded** from
  jsDelivr's `/+esm` (`loadNipple()`) on first `enterGame()`, NEVER at boot — same
  rule as Three/PeerJS, so the headless load check stays request-free. `mode:
  'dynamic'` (stick appears where the thumb lands inside a bottom-left zone).
  `on('move')` writes `touchMove = {mx: vector.x, mz: vector.y}` (nipple's vector
  is already −1..1; up == forward); `on('end')` zeroes it. `moveVector()` sums
  keyboard + joystick then clamps, so both work on a hybrid device.
- **Look — hand-rolled drag-to-look** (no lib). Pointer events on the CANVAS:
  first pointer down becomes the look finger, `pointermove` deltas drive yaw/pitch
  (`touchLookSens`), released on up/cancel. Phones have **no pointer lock**, so
  this REPLACES mouse-look — it does not imitate it. The joystick zone and action
  button are DOM elements layered over the canvas, so their touches never reach the
  look handler; the uncovered screen IS the look zone.
- **Action — on-screen tap button** (`#touchAction`). `pointerdown` (zero latency,
  `stopPropagation` so it doesn't leak to the look zone) → `onAction('primary')`,
  which `main.js` maps to tag/disguise by role — exactly like desktop left-click.

## "Tap to play" + audio unlock
Desktop's "Click to play" overlay is driven strictly by real pointer-lock signals
— that path is UNTOUCHED. Touch gets a parallel path: `main.js` shows the overlay
with text "Tap to play"; `input.js`'s `lockTrigger` `pointerdown` handler calls
`unlockAudio()` and fires `onTouchPlay()`; `main.js` then hides the overlay AND
calls `input.enterGame()` (controls are shown on the tap, not before, so they can't
sit on top of the overlay and steal it — the overlay is also `z-index:10` above the
controls' `z-index:5`). `ui.js` stays logic-free — it only shows/hides.

**Audio unlock** (`unlockAudio()`): iOS keeps audio muted until it starts inside a
real user gesture. We resume a shared `AudioContext` in that first tap handler.
It lives in the input/glue layer ON PURPOSE (not ui.js). Harmless today (no sounds
yet); the correct home for it so future audio just works on phones.

## Lifecycle
- `input.enterGame()` (async): builds the touch DOM once (`_buildTouchDom`, appended
  to `#game`), shows it, lazy-inits the joystick. Called from `onTouchPlay`.
- `input.exitGame()`: hides controls, zeroes movement/look. Called from `main.js`
  when returning to the persistent lobby and in `backToMenu`. No-ops on desktop.

## Mobile survival details
- **Orientation**: positions are pure CSS (`@media (orientation: …)` in
  `style.css`) anchored to safe-area corners, so a rotate re-flows with NO JS; the
  dynamic joystick recomputes on the next touch. `scene.js` also re-measures on
  `orientationchange` (deferred 200ms — phones report the new size late).
- **`touch-action: none`** on the canvas + control elements (JS and CSS) so
  pinch-zoom / pull-to-refresh don't eat gameplay; `overscroll-behavior: none` +
  `user-scalable=no` back it up.
- **`100dvh`** for html/body height (mobile-safe; excludes dynamic toolbars), with
  a `100%` fallback line above it. Viewport meta has `viewport-fit=cover`.
- **Capped resolution**: `renderer.setPixelRatio(min(devicePixelRatio, 2))`
  (pre-existing) so a high-DPR phone doesn't melt.
- **Wake lock** (`main.js`): `navigator.wakeLock.request('screen')` while in a
  match, released on lobby/menu return, re-acquired on `visibilitychange`. **If the
  HOST's phone sleeps the whole match dies** (referee + WebRTC live in that tab), so
  a phone host also gets a feed warning to keep the screen on.
- **`webglcontextlost`**: `scene.js` `preventDefault()`s it so a phone GPU hiccup
  can restore instead of white-screening permanently (world rebuilds on next
  `buildWorld`).

## Gotchas
- Don't move touch DOM creation or the audio unlock into `ui.js` — house rule keeps
  it logic-free. Input owns controls; UI only shows/hides.
- nipplejs `vector` is already normalized (−1..1); don't re-normalize it (main.js
  clamps the combined keyboard+stick vector and normalizes length before speed).
- The overlay tap listener sits on `#clickToPlay`; when hidden (`display:none`) it
  gets no events, so `onTouchPlay` only fires while the overlay is up — correct.
- The stale `client/js/input.js` copy is dead code (served root is the repo root) —
  don't sync touch changes into it; it's awaiting `git rm`.
