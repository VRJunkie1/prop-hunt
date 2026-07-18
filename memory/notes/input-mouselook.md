# input & mouse-look (pointer lock)

How the first-person mouse-look capture works, and the overlay-swallows-click bug
fixed 2026-07. **This whole note is the DESKTOP scheme.** `Input` now picks its
scheme once by `isTouchDevice()`; everything below is wired only when that's false
(`_wireDesktop`). The TOUCH scheme (joystick + drag-to-look + tap buttons +
"Tap to play") is a separate lane — see `memory/notes/touch-controls.md`. Both
emit the same `moveVector()`/yaw/pitch/`onAction` shape, so nothing downstream
changed.

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

## Desktop "UI mode" (backtick `) — mid-game debug/UI access (2026-07-12, Jie)

Third input state so a PC player can reach the DEBUG menu without the pointer lock trapping the
mouse. Full flow in `memory/notes/pause-menu.md`. Input-layer contract only, here:
- `input.js` fires `onToggleUiMode` on the ` (Backquote) key, handled FIRST (before the pointer-lock
  action gate, like Ctrl+E) so it works while unlocked too. `onRequestPause` fires on Esc **only while
  `!this.locked`** (UI mode) — a LOCKED Esc still goes through the browser's native pointer-lock
  release, so that path is unchanged and never double-handled.
- Both are gated by `input._isTyping()` (INPUT/TEXTAREA focus) so a backtick in a name/room field is a
  plain character (we return WITHOUT preventDefault) — and both are no-ops on touch.
- The overlay decision moved to `js/main.js` and is now STATE-DRIVEN off `state.uiMode`/`state.paused`
  (not the event that fired) — see the pause-menu note. `main.js` owns the `uiMode` flag; `input.js`
  only reports the key + the lock state.

## Key auto-repeat guard — held toggle keys (2026-07-18, Jie)

Bug: HOLDING a toggle key on PC (T = taunt menu, Esc = pause) fires the OS key auto-repeat, so the
browser delivers a burst of `keydown` events. Each was treated as a fresh press, so the menu strobed
open/closed. Fix is one CHOKE POINT at the top of `Input.onKeyDown`:
```js
if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
```
- `KeyboardEvent.repeat === true` marks an OS auto-repeat (well supported in all modern browsers). We
  ignore ALL of them, so EVERY toggle / one-shot below the guard (editor Ctrl/Cmd+E, UI-mode `,
  pause Esc, taunt T, disguise E, view V, tool-select 1..9) fires EXACTLY ONCE on the initial press.
  A future toggle key added below the guard inherits the fix automatically — don't re-check per-key.
- CONTINUOUS held inputs (WASD movement, Space jump) are UNAFFECTED: movement is read every frame off
  `this.keys`, and jump off the `this.jump` flag — both set by the FIRST keydown and cleared on keyup,
  so they never needed the repeats. The Space carve-out only keeps its page-scroll `preventDefault`
  alive while held.
- The Esc-while-LOCKED pause path is NOT a keydown — it fires from `pointerlockchange` after the
  browser releases the lock — so auto-repeat can't reach it; only Esc-while-unlocked goes through the
  guard. Both are fine.
- The level editor (`js/editor.js#_onKey`) has its OWN separate window keydown listener; it got the
  same `if (e.repeat) return;` guard so holding a number key can't spam-spawn props and holding `?`
  can't strobe the help panel. (Side effect: hold-to-nudge on R / +/- now needs repeated presses —
  intended; a stuck key no longer runs away.)
- Headless guard: `tools/check-key-repeat.mjs` drives the real `Input` with a mocked DOM, asserts a
  held T/Esc/V/number fires its toggle exactly once, and asserts held W keeps moving through the burst
  (movement is NOT repeat-filtered). Run: `node tools/check-key-repeat.mjs`.
