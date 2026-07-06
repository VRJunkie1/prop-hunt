# Mobile / touch controls

Added 2026-07 ("BUILD IT" ship pass, plan step 7). Before this the game was
keyboard+mouse only and unplayable on phones — the group mostly plays on phones,
so this was the load-bearing buildable gap. Nothing about the netcode, referee,
or movement math changed; touch is purely a new *input source* that feeds the
same intent the keyboard/mouse already produced.

## The one-intent rule (why this stays clean)

The rest of the game must never care which device you're on. So the touch layer
only writes into the existing `Input` fields the game already reads:

- virtual joystick → `input.touchMove {mx, mz}` (folded into `input.moveVector()`)
- look drag        → `input.applyLookDelta(dx, dy)` (mutates `yaw`/`pitch`, same
                     clamp as the mouse path)
- JUMP / CROUCH    → `input.touchJump` / `input.touchCrouch` (OR'd into the
                     `jump`/`crouch` getters — held-state, exactly like the keys)
- ACTION           → `input.onAction('primary')` (main.js routes 'primary' to
                     tag or disguise by role — identical to left-click)

`main.js`, `referee.js`, movement math: all untouched. Do NOT add a second
movement/look path for touch — extend these fields instead.

## Where it lives

- `client/js/touch.js` — `setupTouchControls(input, ui)`. All the DOM/gesture
  wiring. Isolated from `input.js` on purpose (keyboard/mouse stays lean, desktop
  is provably unaffected).
- `client/js/input.js` — small hooks only: `isTouch`, `touchMove/touchJump/
  touchCrouch`, the fold-in inside `moveVector()`/`jump`/`crouch`, and
  `applyLookDelta()`.
- `index.html` — `#touch` block inside `#game`: `#touchLook` (full-screen look
  capture), `#joystick`+`#joyKnob`, and `#btnAction/#btnJump/#btnCrouch`.
- `client/css/style.css` — `.touch*` / `.joystick` / `.touch-btn` rules.
- `client/js/ui.js` — `enableTouch()` + `show()` toggles `#touch` with the game
  screen. `touchEnabled` gates it so desktop never sees the controls.
- `client/js/main.js` — boot calls `setupTouchControls` only when `input.isTouch`;
  the click-to-play prompt is skipped when `input.isTouch` (no pointer lock on
  phones, so the prompt would just block the on-screen controls).

## Design choices / gotchas

- **Detection:** `'ontouchstart' in window || navigator.maxTouchPoints > 0`.
  Hybrid laptops (touch + mouse) count as touch: controls show and the click-to-
  play prompt is suppressed, but mouse-look via pointer lock still works if they
  click the canvas. Acceptable for the target (phones).
- **Multi-touch:** look and joystick each latch onto one touch `identifier`, so
  move + look + a button press work simultaneously without hijacking each other.
- **Look layer:** `#touchLook` fills the screen at a low z-index; the joystick and
  buttons sit above it (higher z-index, `pointer-events:auto`) and are separate
  DOM siblings, so a touch on a widget never reaches the look layer.
- **No scroll/zoom during play:** `touch-action:none` on the touch widgets +
  `preventDefault` in the handlers. The page viewport meta was left alone so the
  menu/lobby forms stay zoomable/accessible.
- **Blindfold still wins:** `#blindfold` is z-index 10, above `#touch` (z 8), so a
  hunter in HIDING can't peek or move — same as before (they're frozen anyway).
- **Jump can't spam-hop:** held-state button + the referee only jumps when
  grounded, identical to holding Space.

## NOT yet playtested on a real phone

Same standing caveat as the rest of the game (see project-state). Sensitivity
(`applyLookDelta` default 0.004) and the joystick `RADIUS`/button sizes in
`touch.js`/CSS are first guesses — tune on a real device. Verify each of: move,
look, jump, crouch, tag (hunter), and disguise (prop: drag to aim the crosshair
at a prop, then ACTION). Check the documented disguise edge cases on touch too
(crouched, mid-jump, max range, prop partly behind another).
