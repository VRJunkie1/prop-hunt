# In-game debug menu (`?debug=1`)

Added 2026-07-11 (requested by Jie). A lightweight in-game developer/debug panel. It is
**OFF for normal play** and only appears when the page is loaded with the existing
**`?debug=1`** flag — the SAME single switch that turns on the collider wireframe view
(`notes/collider-debug.md`). One debug switch for everything.

## How to open / use

Append **`?debug=1`** to the game URL (e.g. `https://<hash>.prop-hunt.pages.dev/?debug=1`).
A **DEBUG** button appears top-left; tap it to expand/collapse the panel. It's phone-usable
(thumb-sized toggle, collapsible, scrollable, never covers the whole screen).

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
- `js/net.js` — `enablePing()` + `__ping`/`__pong` intercept + `pings` map (debug-only; no
  ping traffic in normal play).
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
