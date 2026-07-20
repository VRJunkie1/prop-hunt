# In-game debug menu (ON BY DEFAULT as of 2026-07-12)

**2026-07-20 (check-repair) — `check-debug-menu.mjs` onLockError regex loosened.** The pause-menu QoL
pack (commit f6800ad) rewrote `main.js` `input.onLockError` to show a calm "Click to recapture the
mouse" hint — `ui.setClickToPlay(true, 'Click to recapture the mouse', true)` inside a `{ }` block —
instead of the old `ui.setClickToPlay(true, reason)`. The check's regex was hard-pinned to the old
call signature and failed even though the asserted contract (the `!state.uiMode` guard that suppresses
the overlay in UI mode) was still intact. Relaxed the regex to match the guard + `ui.setClickToPlay(true,`
regardless of the trailing args/block. No shipped-code change.


**2026-07-20 (VRmike) — NEW "Held-item alignment" panel (`?debug=1` only).** A human-in-the-loop tuner
to align the rifle/grenade/finder in the hunter's hand + on the character model (attempt 4 — automated
offset guessing kept missing). Per-item tabs (rifle/finder/grenade, `●` = equipped), seven +/− steppers
with live values (pos X/Y/Z, rot pitch/yaw/roll, scale), per-item Reset, and Export (JSON block →
clipboard + selectable box). Gated on `ctx.debugFlag` — a normal launch (menu is on by default) never
builds it or reads its `localStorage` (`ph_debug_item_tuner`). Drives `scene.setItemTuner` live at BOTH
held-item mount sites (first-person viewmodel + third-person model); ships NO default-offset change.
debug.js gained its FIRST import — the pure `shared/item-tuner.js` core (`check-debug-menu.mjs`
invariant relaxed to allow exactly that one). Guard: `tools/check-item-tuner.mjs`. Full detail:
`memory/notes/held-item-tuner.md`.

**2026-07-13 (VRmike) — NEW "True Colliders" toggle (diagnostic).** A SECOND collider toggle in
the view-buttons row, separate from "Colliders" so both can be on at once. "Colliders" draws
box/capsule approximations from `shared/bounds.js`; **"True Colliders"** draws the ACTUAL Rapier
shapes read straight from the live physics world (`scene.setTrueColliderView`/`updateTrueColliders`,
`debug._toggleTrueColliders`/`_trueWorld`), in a distinct magenta, so a mesh/convex collider that
disagrees with the box helper (VRmike's counter bug) is visible. Also this build: the EXISTING
"Colliders" view now includes the LOCAL player's own capsule (was remote-only). Detail:
`memory/notes/collider-debug.md`. Guards: `check-debug-menu.mjs` §7 + `check-true-colliders.mjs`
(new, live-Rapier) + `check-blindfold.mjs` (the two new `scene.*` seams).

**2026-07-12 (VRmike) — LAYOUT: DEBUG button in the top row, panel below the HUD.** The DEBUG
button used to sit at fixed `top:8/left:8` and COVER the top-left role pill, and the OPEN panel
started at `top:58` and COVERED the health bar. Fixes (all in `js/debug.js` injected styles + one
method): (1) `#dbgToggle` is now a PILL at `top:12/left:12` (matching `.hud-top`), and
`document.body.classList.add('dbg-present')` + `body.dbg-present .hud-top{padding-left:104px}`
reserve room so the role/timer/props/health pills flow to its RIGHT (no overlap — the button reads
as the first pill in the row). (2) `_positionPanel()` (called on every open in `_toggleCollapse`)
measures `.hud-top`'s live `getBoundingClientRect().bottom` and drops the OPEN panel just below it
(default `top:96px` fallback clears two wrapped rows), so no HUD readout is covered. z-index 52/51
are UNCHANGED (still above the pause menu — the `check-debug-menu` z-order regex expects
`z-index:52`/`z-index:51` with no space). Style is still injected only by the module (style.css
stays debug-free); the reserve padding applies whenever the default-on menu is present.

**2026-07-12 (Jie) — REACHABLE MID-GAME ON PC.** Two fixes so the panel is actually usable during a
desktop match: (1) the injected overlay z-index was raised above the pause menu — `#dbgToggle` 46→52,
`#dbgPanel` 45→51, both now over `.pause-menu` (z 50) — so the DEBUG button + open panel are clickable
from BOTH the pause menu (Esc→pause) and the new backtick UI mode. (2) A new desktop **"UI mode"** on
the `` ` `` key releases the pointer lock WITHOUT opening the pause menu (`state.uiMode`), so the mouse
is free to click DEBUG and the "Click to play" overlay is suppressed (state-driven). Clicking the game
canvas re-locks and resumes; the resume click can't fire the rifle (mousedown gated on lock). Full
flow: `memory/notes/pause-menu.md` + `input-mouselook.md`. Guard: `check-debug-menu.mjs` section 6.


**2026-07-12 (VRmike) upgrades:** (a) the menu now **starts COLLAPSED** — only the small
`DEBUG ▸` button shows top-left; the panel opens on click (`_buildDom` sets `_collapsed=true`
and hides `#dbgPanel`). (b) A new **"Colliders" toggle** (`_toggleColliders`) drives a new
`scene.setColliderView(on)` that BUILDS/TEARS DOWN the full collider wireframe overlay live —
props, players (CAPSULES, new geometry sized from the same collider source as physics), static
fixtures, and world architecture — reusing the exact `shared/bounds.js` source + `_wireBox`/
`_buildStaticColliderDebug`/`_addPropColliderWire` builders the `?debug=1` load-time overlay
uses (so "the overlay can't lie" holds). The button seeds ON under `?debug=1` (the overlay is
already built at load). Guards: `check-debug-menu.mjs` (collapsed default + toggle +
`setColliderView`/`_addPlayerColliderWire` defined); `check-blindfold.mjs` covers the new
`scene.setColliderView` seam.

Added 2026-07-11 (requested by Jie). A lightweight in-game developer/debug panel.

**2026-07-12 (VRmike): the MENU is now ON BY DEFAULT — no `?debug=1` needed.** `main.js`
constructs `DebugMenu` unconditionally (still a lazy `import()`). `?debug=1` is UNCHANGED and
still governs the *separable heavier* features it always did: the collider wireframe overlay
(read directly in `scene.js`, `notes/collider-debug.md`) and the referee's host-authoritative debug-command gate
(`referee.debugEnabled`, from the HOST tab's `?debug=1`). So a visible-by-default panel still
CAN'T tamper with a normal match — team/reset/morph are dropped unless the host loaded `?debug=1`
(the panel notes this). The two deploy links now genuinely differ: normal link = the menu;
`?debug=1` link = the menu PLUS collider wireframes + ping + accepted host debug commands.
`index.html`/`style.css` still ship ZERO debug DOM/CSS (the module injects its own overlay), so
default-on adds only that injected overlay.

## How to open / use

The **DEBUG** button appears top-left automatically (no URL flag). Tap it to expand/collapse the
panel — phone-usable (thumb-sized toggle, collapsible, scrollable, never covers the whole screen).
Add **`?debug=1`** (e.g. `https://<hash>.prop-hunt.pages.dev/?debug=1`) to ALSO get the collider
wireframes + ping + host-authoritative debug commands.

Sections:

- **Actions**
  - **Be PROP / Be HUNTER** — switch your team mid-round. Host-authoritative (routes through
    the referee). A guest's tap sends a request the host honors *only in debug mode*.
  - **Reset game** — host restarts the round (reset-to-lobby then immediately re-start; solo
    works since `minPlayers=1`). Guests send the request; only a debug host acts.
  - **Exit game** — leave cleanly back to the menu (purely local; the existing back-to-menu
    path). Never a network command.
  - **Free cam** (toggle) — detach the camera and fly it. Drag-to-look + WASD/joystick to
    move, JUMP/Space = up, Shift = down. LOCAL-only: the physics player is frozen (main.js
    stops predicting it and sends zeroed movement), nothing crosses the network.
  - **Focus box** (toggle) — draw a magenta wireframe around whatever entity is under the
    crosshair (raycast from camera centre). Distinct colour from the green disguise highlight
    and the yellow/cyan/red collider-debug wires. Also live-updates the Inspector.
  - **Force morph ▾** — pick any prop type from the catalog to force-disguise as it (routes
    through the referee's `setPlayerCollider` so the physics capsule resizes correctly;
    bypasses the range/aimed-prop checks — the point of a debug morph).
  - **Inspect ⌖** — one-shot inspect of the entity under the crosshair (see Inspector).
- **HUD** — smoothed FPS, live player coordinates (x/y/z), velocity estimate.
- **Local player** — role, phase, disguise, grounded, frozen/blindfolded, alive, capsule
  radius/half (read from the local prediction body), velocity.
- **Players / ping** — roster (name · role/disguise, dead struck through) + per-peer RTT
  ("you" for self, "—" if not measurable).
- **Inspector** — id, type, catalog entry, position, rotation°, static/dynamic, sleeping
  state, and — for a player — role/alive and **whether it's a disguised player** (a debug
  tool reveals disguises on purpose). Sleeping shows **host-only**: per-entity sleep lives in
  the host's authoritative physics world; guests' prediction props are fixed colliders, so
  it isn't exposed client-side in this pass.

## The host-side gate rule (important)

The `debug:` message family (`C2S.DEBUG`, `{action:'team'|'reset'|'morph'}`) is dropped by
the referee unless **the HOST itself** loaded with `?debug=1`. The referee ALWAYS runs in the
host's browser tab, so `referee.debugEnabled` (read from the host tab's URL) is exactly "does
the host have debug on". A random/tampered guest can send `C2S.DEBUG` all day, but a normal
match's host ignores it. When the host IS in debug mode, the whole table has opted into a dev
session. "Exit game" and the local view features (free cam / focus box / inspect) never touch
the network, so they work for any debug client regardless of the host.

## Where it lives

- `js/debug.js` — the whole panel (`DebugMenu`). NO imports (pure DOM/logic); all THREE work
  is delegated to `scene.js` seams. `main.js` constructs it ONLY under `?debug=1` (lazy
  `import('./debug.js')`), defaults `debugMenu = null`, and null-guards every hook
  (`onSnapshot`, per-frame `frame`).
- `shared/referee.js` — `handleDebug` (gated on `debugEnabled`) + `debugSetTeam` /
  `debugReset` / `debugMorph`.
- `shared/protocol.js` — `C2S.DEBUG`.
- `js/net.js` — `__ping`/`__pong` intercept + `pings` map. **(2026-07-19 CONNECTION LIVENESS)** the
  keepalive is now ALWAYS on (`_startKeepalive()`, ~1Hz both directions — it carries connection liveness,
  not just debug RTT), so the per-peer RTT the panel reads is a free by-product with NO `?debug=1` gate.
  See `notes/netcode.md`.
- `js/scene.js` — `setFreeCam` / `updateFreeCam` (fly cam; `setCamera` early-returns while
  on), `debugPick` (centre raycast → entity info + focus box), `setFocusBox`. Props/fixtures/
  players are tagged with `userData` (propId / debugFixtureType / debugPlayerId) so a hit maps
  back to its entity. The focus box is its own LineSegments, re-added after `scene.clear()`,
  never in `scene.colliders`.

## Guard rails (run after any change here)

The project's worst repeat bug is "code calls a `scene.*` method that doesn't exist → dark
screen for everyone". Steps 5–6 add new `scene.*` calls **from `js/debug.js`**, which the old
static guard only scanned in `main.js`. So:

- **`node tools/check-blindfold.mjs`** — widened to also scan `debug.js`'s `scene.*()` calls
  (every one must be defined in `scene.js`), plus the new seams named explicitly.
- **`node tools/check-debug-menu.mjs`** (new) — asserts `debug.js` parses + exports, ships
  ZERO debug DOM/CSS without the flag, main.js gates construction/ping behind `?debug=1` with
  null-guarded hooks, the referee gate drops the family unless the host has debug, and the
  protocol/netcode plumbing is wired. This is the "boots clean WITHOUT `?debug=1`" smoke check.

Run both after any change to debug.js / the scene seams / the referee debug family. Both were
authored + hand-traced against source; the sandbox has no shell to execute them — run them
plus a live browser pass to close.

## Not verified headless (owed a live pass)

A headless check can't open a browser. Still owed on a real device: panel renders + is
phone-usable; team/reset/morph apply on host and guest (with a debug host); free cam flies
while the body stays put; focus box + inspect pick the right entity and reveal a disguised
player; ping shows plausible RTT; and — the acceptance bar — loading WITHOUT `?debug=1` shows
zero debug UI and a clean console.
