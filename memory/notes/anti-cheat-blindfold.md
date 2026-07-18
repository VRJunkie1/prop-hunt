# Hunter blindfold (anti-cheat)

At the start of a map, while props scatter, hunters are **blindfolded** during the
`HIDING` phase so they can't watch where props hide. It clears the instant the host
flips `HIDING → HUNTING`. **Props are never blindfolded**; they see the world normally
at all times.

The feature has three cooperating halves — a hacked client that deletes the visual half
still gets nothing to peek at, because the data half is enforced server-side.

## 1. Visual half — screen blackout (client)
- `index.html`: `#blindfold` overlay div (title + `#blindfoldTimer` countdown) inside `#game`.
- `css/style.css`: `.blindfold` — near-opaque dark blackout + `backdrop-filter: blur`,
  `z-index:12` (above `.overlay`=10 and touch controls=5), `pointer-events:none`.
- `js/ui.js` `setBlindfold(blind, seconds)`: plain show/hide + timer text. **Not a latched
  toggle** — it just reflects whatever `blind` it's handed.
- `js/main.js` `updateBlindfold(seconds)`: **derives** the state fresh every time from
  `blind = state.role === ROLE.HUNTER && state.phase === PHASE.HIDING`, then calls
  `ui.setBlindfold(blind, seconds)` and `input.lookFrozen = blind`. Called from both the
  `SNAPSHOT` handler (`msg.timeLeft`) and the `phase` event (`msg.seconds`) — driving it
  off the phase event too means a hunter's overlay drops the instant HUNTING starts,
  without waiting for the next snapshot. Also force-cleared with `setBlindfold(false)` on
  `backToMenu` and return-to-lobby.

Because it's **derived from live role+phase**, it can never get stuck on: props always
compute `false`; a mid-phase joiner gets the correct current state; solo/host-start (lone
player is a prop) is never blindfolded — all for free, no special-casing.

## 2. Look freeze (client)
`js/input.js` `lookFrozen` — set to the same `blind` value in `updateBlindfold`. Freezes
yaw/pitch so a blindfolded hunter can't pre-aim. Movement is frozen separately by the
referee.

## 3. Data half — position withholding (server, authoritative)
`shared/referee.js` per-recipient snapshot dispatch: `if (p.role === ROLE.HUNTER &&
this.phase === PHASE.HIDING) send(blindHunterSnapshot(full)) else send(full)`.
`blindHunterSnapshot(full)` strips every prop-role player entry and all dynamic-prop
transforms (`props: []`), keeping hunter entries and the propsAlive/propsTotal counts.
Full prop data resumes automatically at `HUNTING`. This gate is gated on the same
`role === HUNTER && phase === HIDING` rule as the client, so the two stay in lockstep.

## 4. Object-sync rides the SAME gate (2026-07-17)
The host-authoritative dynamic-object sync (see `notes/netcode.md`) flows through this exact
withholding rule — it EXTENDS the gate, never bypasses it:
- **Stream:** already covered — `blindHunterSnapshot` sets `props:[]` for a HIDING hunter.
- **Mid-join catch-up:** `referee._propsCatchup(blind)` returns SPAWN-form props (no live shoved
  positions) when `blind`; `admitMidGame` passes `blind = role===HUNTER && phase===HIDING`. So a
  hunter joining mid-HIDING can't peek where props were pushed (the screen-blackout half can't stop a
  data peek if a client deletes the overlay — the data half must).
- **Release = catch-up:** the instant `setPhase(HIDING→HUNTING)` fires, every hunter receives a
  one-time `S2C.EVENT kind:'world'` full snapshot of all dynamic-body transforms. This IS the
  "hunter released from the hide phase sees the current world" case — withheld until the precise
  moment the hunter is allowed to see it. Props (never blindfolded) don't get it.

Guard: `tools/check-object-sync.mjs` (d) asserts a HIDING hunter gets zero object transforms (stream
AND catch-up) then the full world at HUNTING, while a prop gets the transform during HIDING.

## Bug history
Originally the **visual half was entirely missing**: `ui.setBlindfold` was called from
main.js but never defined in `js/ui.js` (no overlay div / CSS either). So *every* client —
props included — threw `ui.setBlindfold is not a function` on the first snapshot, breaking
the game for everyone (read by humans as "everyone stuck on a blindfold screen"). The
server data half and main.js's derived gate were already correct and were left untouched;
the fix only added the missing visual overlay. See project-state.md.

### Attempt #2 (2026-07-11): "still broken" was NOT the blindfold at all
VRmike reported the same symptom AFTER attempt #1 — a **PROP** in the **HUNT** phase
seeing a solid dark blue/purple screen, HUD ticking fine. It looked like a stuck
blindfold but was a completely separate bug, and the blindfold pieces above were all
verified **correct** (overlay present, gate derived fresh, `.hidden { … !important }`
beats `.blindfold`, referee data-half gated right). The screenshot's tells — HUD alive
(DOM, driven by network snapshots) while the 3D scene is frozen dark for **everyone,
any role, any phase** — point at the RENDER LOOP dying, not an overlay.

Root cause: `js/main.js` `frame()` called `scene.aimedDisguiseTarget(...)` (PROP branch)
and `scene.highlightProp(...)` (else branch) — the crosshair-disguise API — but **neither
method existed in `js/scene.js`** (a half-landed refactor: main.js updated, scene.js not).
The `TypeError` fired every frame BEFORE `scene.render()` and the tail
`requestAnimationFrame(frame)`, so the loop ran once and died; the network kept feeding
the HUD. A never-rendered `WebGLRenderer` canvas is transparent → the body's dark
`radial-gradient(#4a2a7a → #1a1030)` CSS background showed through = the "dark blue/purple
screen". The blue/purple was CSS, not a blackout.

Fix (this session): implemented the two missing methods in `js/scene.js` —
`aimedDisguiseTarget(pos,yaw,pitch,range)` (raycasts the look ray against DISGUISABLE prop
primitives, returns the hit prop id; client-side SELECTION aid only — the host's
`applyDisguise` stays authoritative) and `highlightProp(id)` (a single reused wireframe
box fitted to the target's world bounds; no shared-material tint/leak). Prop records now
carry `disguisable` + the primitive is tagged `userData.propId`. NO blindfold/referee/
netcode change.

**Lesson / guard:** the real class of bug is "main.js calls a `scene.*` method that
doesn't exist" → silent per-frame throw → dark world, live HUD. `tools/check-blindfold.mjs`
now statically asserts every `scene.<method>()` main.js calls is defined in scene.js
(plus the blindfold decision a/b/c and the referee data-half d). Run it on any
render-loop or scene-API change: `node tools/check-blindfold.mjs`.
