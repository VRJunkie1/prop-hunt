# Pause menu + rapid fire + mouse lock (2026-07-12, VRmike)

## Pause menu (an OVERLAY, not a real pause)

Prop hunt is multiplayer with a host-authoritative referee, so the world must keep running —
the pause menu is a **local overlay only**. Nothing on the referee changes; the sim runs on.

- **Open:** desktop — Escape releases pointer lock (browser-native), which fires
  `input.onLockChange(false)`; `main.js` opens the menu IFF the pointer had been captured this
  game (`state.hasLocked`) — the FIRST unlock in a match still shows the "Click to play" entry
  prompt, a later unlock shows the pause menu. Touch — a `#pauseBtn` (☰, top-right) calls
  `openPause()` directly (no pointer lock exists on touch).
- **Close / Resume:** `closePause(true)` re-requests pointer lock on desktop (a user gesture, so
  it survives the browser's post-Escape lock cooldown); the lock-regained event hides the menu.
  On touch it just hides. Escape-again works because releasing lock re-opens, Resume re-locks.
- **Contents** (`index.html` `#pauseMenu`, rendered by `ui.js`): a live SCOREBOARD
  (`ui.updatePauseScoreboard` — every player with role/disguise + current health, refreshed from
  each snapshot while open, dead players struck through), a collapsible Controls/help panel
  (`ui._controlsHtml`, desktop vs touch variants), Resume, and Exit-to-menu.
- **Movement while open:** `state.paused` gates local input exactly like the debug free cam —
  the input loop sends ZEROED movement and the frame loop skips prediction, so the avatar holds
  still at the menu while the host keeps simulating everyone else. Cleared on back-to-menu /
  return-to-lobby.

## Rapid fire (hold-to-fire)

- **Config:** `rules.fireRateRpm` (700; 600-800 real assault-rifle/SMG band). ONE tunable.
- **Host cap (authoritative):** `referee._fireCooldownMs()` = `max(10, round(60000/rpm) − 20)`.
  The −20 ms grace stops a legit on-cadence client being throttled BELOW the intended rate by
  timer/network jitter, while still capping a cheat (700 rpm → ~66 ms → ~900 rpm hard ceiling).
  Falls back to legacy `fireCooldownMs` if `fireRateRpm` is absent.
- **Client:** `input.primaryHeld` is set while left-click (desktop) / the touch ACTION button is
  HELD, cleared on release and on pointer-lock loss. `main.js` frame loop auto-repeats `tryFire()`
  every `60000/rpm` ms for a live hunter with the rifle. Damage/bullet is unchanged (5%, host-side).
- Props still single-tap disguise (the held auto-repeat is hunter-only).

## Desktop "UI mode" (backtick `) — mid-game debug/UI access (2026-07-12, Jie)

A deliberate THIRD input state next to playing/paused, so you can reach the DEBUG menu mid-game on
PC without the pointer lock trapping the mouse. `state.uiMode` in `js/main.js`; the ` key toggles it
via `input.onToggleUiMode`.

- **Enter (` mid-game):** `enterUiMode()` sets `uiMode = true` **before** calling
  `document.exitPointerLock()` (so the resulting `onLockChange(false)` sees the flag — no race) and
  hides "Click to play". The mouse is now free; NO pause menu opens.
- **"Click to play" is STATE-DRIVEN** (the key fix): `onLockChange`'s unlocked branch shows the
  overlay only when `!uiMode && !paused` (`if (state.uiMode) { setClickToPlay(false); return; }`),
  and `onLockError` guards `!uiMode` too. No longer "whoever's event fired last wins".
- **Exit / resume:** clicking the game canvas re-locks (input.js canvas click → `requestPointerLock`)
  → `onLockChange(locked=true)` clears `uiMode`. ` again → `exitUiMode(true)` re-locks. Esc while
  unlocked → `input.onRequestPause` → `openPause()` (which also clears `uiMode` — pause takes over).
- **Never latches:** `uiMode` is reset to false on the lock-regained branch, `openPause`, `exitUiMode`,
  back-to-menu, return-to-lobby, and match START — same derive/reset discipline as the blindfold.
- **Resume click can't shoot:** the canvas `mousedown` fire path is gated on `this.locked` (false
  until the lock engages), so the re-lock click never fires the rifle or arms hold-to-fire.
- **Typing guard:** `input._isTyping()` (INPUT/TEXTAREA focus) makes ` and unlocked-Esc no-ops while
  naming a room. Desktop-only (no-op on touch — no pointer lock there).
- **Movement halts** in UI mode like pause (`halt` in the input loop + prediction skip + `tryFire`
  guard), so the avatar holds still while you use the UI.
- **Z-order:** `js/debug.js` bumps `#dbgToggle` (52) / `#dbgPanel` (51) ABOVE `.pause-menu` (z 50), so
  the DEBUG button + panel are reachable from BOTH paths (backtick UI mode OR Esc→pause).
- Controls list documents the key (`ui._controlsHtml` desktop rows). Guard: `check-debug-menu.mjs`
  section 6.

## Mouse lock

Already captured on the in-game canvas click for BOTH roles (props are third-person but still use
pointer-lock mouse-look) — unchanged. The only change here is left-click is now HELD to fire.

## Files

`js/input.js` (primaryHeld), `js/main.js` (openPause/closePause, onLockChange rewrite, fire
scheduler, movement gating, pause wiring), `js/ui.js` (pause DOM methods), `index.html`
(#pauseBtn + #pauseMenu), `css/style.css` (.pause-*), `shared/config/rules.json` (fireRateRpm),
`shared/referee.js` (_fireCooldownMs). Guards: `tools/check-combat.mjs` section F.
