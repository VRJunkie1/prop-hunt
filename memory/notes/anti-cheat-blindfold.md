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

## 5. SPECTATORS ride the SAME gate (2026-07-18, B6)
A DEAD player becomes a spectator with a fly cam + player switching (see `notes/spectator-mode.md`).
A dead teammate can still TALK to living hunters on voice, so a spectator watching props scatter during
HIDING is the exact leak this blindfold guards. The gate was EXTENDED from *hunter-during-HIDING* to
*hunter-OR-dead-during-HIDING* — it does NOT bypass the blindfold, it widens who rides it:
- **Snapshot dispatch** (`broadcastSnapshot`): `if (phase===HIDING && (role===HUNTER || !alive))` →
  `blindHunterSnapshot`. So a dead prop during HIDING is now withheld all prop positions too (was: full).
- **Release catch-up** (`setPhase(HUNTING)`): the one-time `kind:'world'` snapshot now goes to
  `role===HUNTER || !alive`, so a spectator withheld through HIDING gets the world the instant they're
  allowed to see it (else the fly cam shows the factory-fresh map).
- **HUNTING onward:** a spectator sees EVERYTHING including disguised props' names — a dead hunter falls
  through to the FULL feed, NOT the name-blanked `hunterSafeSnapshot` (that stays for LIVING hunters only).
  Decided, not accidental (plan rev 2): they're a dead teammate on voice anyway = normal spectating.
Guard: `tools/check-spectator.mjs`. The `tools/check-blindfold.mjs` referee-gate assertion was updated to
this extended spelling.

## 6. ROUND-2 "permanent blindfold / unspawned" — the flip seam (2026-07-18, B8)
Playtest: the hunter was "permanently blindfolded / unspawned on ROUND 2, every time". Root-caused
across the round-flip lifecycle (endless flipped rounds chain ENDING→HIDING with NO lobby round-trip):
- **The message/state logic is already correct.** `_launchRound` resets `alive=true` for EVERY player
  before the round-2 HIDING snapshots, the blindfold is DERIVED fresh (`role===HUNTER && phase===HIDING`,
  never latched), and the HUNTING release hands the world catch-up to `role===HUNTER || !p.alive`. A
  faithful headless client reducer over the REAL referee's captured stream RELEASES the round-2 hunter
  every time — including the caught-prop-in-round-1 (dead spectator) → round-2-hunter path that B6's
  widened data gate made the prime suspect. So none of the three specced suspects (dead-flag starvation,
  release racing the rebuild, stale-role release) is a live server/logic defect. Proven by
  `tools/check-round-flip-blindfold.mjs` (scenarios A caught-prop-flip + B no-death-flip).
- **The real residual was a BROWSER-ONLY transient.** Between round-2 `STARTED`/`phase(HIDING)` and the
  first round-2 snapshot, stale round-1 view-state — the spectator fly-cam (`state.spectate.on`), the
  blindfold overlay, and `input.lookFrozen` — wasn't explicitly cleared at the fresh-round seam. The
  frame loop kept running `updateSpectatorCamera` (fly/follow) or a frozen-look blackout until the next
  snapshot self-healed (~66 ms) — brief, but exactly "blindfolded/unspawned on round 2" to a player.
- **Fix (js/main.js `S2C.STARTED` handler):** reset `ui.setBlindfold(false)` + `input.lookFrozen=false`
  + `setSpectating(false)` at STARTED (the one seam a brand-new round begins), mirroring the existing
  backToMenu / resetToLobby resets. This clears STALE local view-state only; the CORRECT blindfold is
  still derived from role+phase by the HIDING phase event that immediately follows (a round-2 hunter
  re-blinds for HIDING, then releases at HUNTING). **The server data gate is UNTOUCHED** — no
  anti-cheat weakening; this is a client view-state reset.
- Guard: `tools/check-round-flip-blindfold.mjs` locks the full round-flip→blindfold→release sequence
  (server alive-reset + data-gate hold during HIDING + world catch-up at release + the client reducer
  ending RELEASED + a source guard that STARTED clears blindfold/lookFrozen/spectator). Run it on any
  round-flip / blindfold / spectator change.

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
