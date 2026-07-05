# input & mouse-look (pointer lock)

How the first-person mouse-look capture works, and the overlay-swallows-click bug
fixed 2026-07.

## The handshake

Browsers only let a page turn the view with the mouse after **pointer lock** is
granted, and lock can only be *requested* from a user gesture (a click). The
"Click to play" overlay (`#clickToPlay`) is that gesture prompt.

Ownership (kept strictly in lane):
- **`js/input.js` owns all pointer-lock logic.** Constructor: `new Input(canvas,
  lockTrigger)`. It attaches a `click`→`requestPointerLock()` handler to BOTH the
  canvas and the `lockTrigger`, and listens for the browser's own signals:
  - `pointerlockchange` → sets `this.locked` and fires `onLockChange(locked)`.
  - `pointerlockerror` → fires `onLockError(reason)` (browser refused/dropped).
- **`js/main.js` wires input→ui.** Passes `ui.el.clickToPlay` as `lockTrigger`,
  binds `onLockChange`/`onLockError` to `ui.setClickToPlay(...)`, and shows the
  overlay when a match starts (`S2C.STARTED`).
- **`js/ui.js` only shows/hides** the overlay via `setClickToPlay(visible, msg?)`.
  No lock logic; no polling.

Overlay visibility is therefore driven by the browser's *confirmed* state:
- capture confirmed → overlay hides;
- capture released (Esc, alt-tab) → `pointerlockchange` with `locked=false` →
  overlay returns, clickable again to re-capture;
- capture refused → `pointerlockerror` → overlay shows a human-readable message.

## The bug that was fixed (why the overlay never went away)

`#clickToPlay` is `.overlay { position:absolute; inset:0; cursor:pointer }` with
**no `pointer-events:none`**, painted after the canvas in the `#game` DOM — so it
sat on top and **swallowed every click**. The old code only requested pointer
lock from the *canvas* `click`, which never fired while the overlay covered it.
Lock never engaged, so the (then per-frame) `ui.setClickToPlay(!input.locked)`
kept the overlay up permanently. WASD still worked because keydown listens on
`window`, not the canvas — which is exactly the symptom VRmike reported.

Fix: request lock from the overlay's own click (via `lockTrigger`), and drive the
overlay off `onLockChange`/`onLockError` events instead of polling. Do **not**
just add `pointer-events:none` to the overlay — it needs to *receive* the click.

## Gotchas for future changes

- Requesting lock immediately after exiting it is throttled by Chrome (~1s) and
  raises `pointerlockerror`; the surfaced message tells the user to click again.
- Keep the canvas `click` handler too: once locked the overlay is hidden, so a
  later click (e.g. after Esc, before the overlay repaints) can still re-request.
- `moveVector()` / yaw / pitch and the action keys (E disguise, F/Space tag,
  left-click primary) are unchanged by this fix.
- The stale `client/` copy of `input.js` is dead code (served root is the repo
  root) — don't sync fixes into it; it's awaiting `git rm`.
