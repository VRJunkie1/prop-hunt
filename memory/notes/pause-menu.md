# Pause menu + rapid fire + mouse lock (2026-07-12, VRmike)

## Pause-menu additions (2026-07-17, VRmike — team switch / room copy / leak fix)
Full detail: `notes/team-switch-flipped-rounds.md`. Three pause-menu-facing changes:
- **Switch teams** (`#pauseSwitch`) → `main.js ui.onPauseSwitch` sends `C2S.SWITCH_TEAM` + `closePause(true)`.
  Host respawns you FRESH on the opposite team (`applySwitchTeam` → `_spawnOnTeam`) + a public log line.
  No cooldown/anti-abuse (accepted). The new `ROLE` re-runs `applyRoleView`/`applyToolView` + banner.
- **Room code + Copy link** (`#pauseRoomCode` set by `ui.setPauseRoom(state.room)` in `openPause`;
  `#pauseCopyRoom` labelled "Copy link" → `main.js ui.onPauseCopyRoom`) — so friends can be added
  mid-game (mid-round joins land on the smaller team). **Copies the FULL JOIN LINK, not the raw code**
  (2026-07-18, VRmike): tapping it copies `buildJoinLink(state.room)` = `<origin><path>#CODE`, so pasting
  the URL drops someone straight into the room via `tryJoinFromHash` on load — no "open the site, type
  X7K2". `navigator.clipboard` inside the tap handler (mobile gesture rule) with a feed fallback that
  shows the link. The raw code stays on-screen (`#pauseRoomCode`) for anyone who'd rather type it.
  **Join-link format lives in ONE place** — `buildJoinLink(code)` + `parseRoomFromHash()` in `main.js`
  are used by BOTH the builders (lobby `#copyLinkBtn` "Copy invite link" AND this pause button) and the
  parser (`tryJoinFromHash`, auto-join on boot), so build-side and parse-side can't drift.
- **Disguise-leak fix in the scoreboard:** `ui.updatePauseScoreboard(players, selfId, selfIsHunter)` shows a
  prop's disguise label ONLY to a PROP viewer; a HUNTER sees "prop" (and disguised props arrive name-blanked
  from the host — `hunterSafeSnapshot` — so they render anonymously as "a prop"). `main.js` passes
  `state.role === ROLE.HUNTER` from both `openPause` (showPause) and the live snapshot refresh.

## PC pause is ESCAPE-ONLY — ambient focus loss never pauses (2026-07-13, VRmike)

**The rule:** on desktop, ONLY an explicit Escape pauses. Losing pointer lock by itself —
Alt-Tab, the Windows key, clicking another window — must NOT pause or blur. The game keeps
rendering; it just stops turning the camera (mouse uncaptured) until the player clicks back in.
(Before this, ANY pointer-lock loss opened the pause menu, whose `backdrop-filter: blur(3px)`
made the screen blurry/useless when the player only wanted to switch windows.)

**The sneaky browser fact it hinges on:** pressing Escape while the mouse is captured does NOT
arrive as a keypress — the browser delivers it as "pointer lock lost" (`pointerlockchange`),
the SAME event an Alt-Tab produces. So we can't listen for the Escape key. The reliable tell:
- **Escape** releases the lock while the game window KEEPS focus → `document.hasFocus() === true`.
- **Ambient focus loss** releases it WITHOUT focus → `document.hasFocus() === false`, and a
  `window 'blur'` fired.

`main.js unlockWasEscape()` = `document.hasFocus() && !(blur within the last 250 ms)`. The blur
recency (`_lastWindowBlurAt`, set by a `window 'blur'` listener) is a backstop for browsers that
fire `pointerlockchange` a tick before focus settles. In `onLockChange`'s unlocked branch: if
`state.hasLocked && !unlockWasEscape()` → **do nothing** (no pause, no overlay, no blur, keep
rendering) and return; otherwise Escape → pause (or the never-captured first-entry prompt).

**Stuck-key guard (`input.js`):** since ambient focus loss no longer pauses, a key held when
focus left would "stick down" (its keyup lands in the other window) and keep the avatar walking/
firing. A `window 'blur'` handler calls `input._releaseHeldInput()` (clears `keys`, `jump`,
`rotUnlock`, `primaryHeld`); look angles are untouched (absolute, not held). Control resumes the
instant the player clicks back in.

**Touch/phone are untouched** — no pointer lock there; the `#pauseBtn` (☰) path is unchanged.

## Pause menu (an OVERLAY, not a real pause)

Prop hunt is multiplayer with a host-authoritative referee, so the world must keep running —
the pause menu is a **local overlay only**. Nothing on the referee changes; the sim runs on.

- **Open:** desktop — Escape releases pointer lock (browser-native), which fires
  `input.onLockChange(false)`; `main.js` opens the menu IFF the pointer had been captured this
  game (`state.hasLocked`) AND the unlock was an actual Escape (`unlockWasEscape()`, above —
  ambient focus loss is filtered out). The FIRST unlock in a match still shows the "Click to
  play" entry prompt; a later Escape shows the pause menu. Touch — a `#pauseBtn` (☰, top-right)
  calls `openPause()` directly (no pointer lock exists on touch).
- **Close / Resume:** `closePause(true)` re-requests pointer lock on desktop (a user gesture, so
  it survives the browser's post-Escape lock cooldown); the lock-regained event hides the menu.
  On touch it just hides.
- **Esc TOGGLES (2026-07-16, Jie, branch build/116).** Previously Esc only OPENED pause (a second Esc
  did nothing — `openPause()` early-returns when already paused). Now `input.onRequestPause` DERIVES the
  action from live state: taunt menu open → `closeTauntMenu(true)`; pause open → `closePause(true)`
  (re-locks); else `openPause()`. This works because Esc reaches this handler ONLY while the mouse is
  already free (pause/menu open ⇒ pointer unlocked), so the Esc keydown isn't swallowed by the browser's
  lock-release — that swallow only affects the OPEN-from-play path, which still routes through
  `pointerlockchange`→`onLockChange`→`openPause`. Locked (playing) and unlocked (paused) are mutually
  exclusive, so the keydown and lock-change routes can't double-fire the same toggle.
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
