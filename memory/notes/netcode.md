# netcode

## 2026-07-19 CONNECTION LIVENESS VIA DEDICATED PINGS — input-based liveness is GONE (VRmike, #192)
Implements the fix direction from `notes/disconnect-diagnosis.md`. **Pings are now the SINGLE source of
truth for "connected."** An AFK-but-connected player (idle in the bathroom, no inputs) must NEVER be
removed; only a genuinely dead connection is.

**WHY (the diagnosis).** The two 5s silence timers added the day before — the host's `_sweepSilentPlayers`
and the guest's `HostWatchdog` — judged liveness off the INPUT / SNAPSHOT `setInterval` streams (20Hz /
15Hz). A backgrounded browser tab holding a live WebRTC connection throttles those to ~1Hz *with
multi-second jitter spikes*; a single spike >5s tripped a timer, so "backgrounded / not moving" was
mistaken for "disconnected" and someone got kicked every round or two. Input is the wrong signal.

**THE MODEL NOW.**
- **Dedicated keepalive ping, both directions, ~1Hz, always-on.** Repurposed the pre-existing
  `__ping`/`__pong` control frames in `js/net.js` (they were debug-only RTT before) into the liveness
  heartbeat. `Session._startKeepalive()` starts a 1Hz `setInterval` the moment the link opens — host
  pings each guest, guest pings the host — sending a tiny `{t:'__ping',ts}`. `_sendPings()` is
  FAIL-SILENT (try/catch): a send into a half-closed channel must never crash the loop. A backgrounded
  WebRTC-active tab still fires setInterval ~1Hz (never frozen — see the diagnosis), so the heartbeat
  keeps flowing while the app is backgrounded. `enablePing()`/`_pingOn` are gone; the debug panel's RTT
  is now a free by-product of the always-on keepalive (still reads `session.pings`).
- **Liveness = LAST MESSAGE OF ANY KIND (ping OR any C2S), never input.** `_handlePingPong` intercepts
  the ping/pong before the referee (as before) but now calls `_markAlive(peerId)` on every incoming
  ping/pong. Host → `referee.markSeen(id)` (NEW referee method) stamps the SAME `player._lastSeen` the
  sweep reads; guest → `onKeepalive()`. `referee.handleMessage` still stamps `_lastSeen` on any C2S too.
  So `_sweepSilentPlayers` removes a peer ONLY when the ping stream (and all other traffic) has stopped.
- **Guest watchdog fed by pings AND snapshots.** `main.js` sets `session.onKeepalive = () =>
  hostWatchdog.feed(nowMs())`. A throttled host whose 15Hz snapshot stream briefly stalls is still held
  up by its ~1Hz keepalive, so the guest doesn't false-boot to the lobby.
- **Threshold 5→15s, one knob in rules.json.** `rules.leaveTimeoutSeconds` 5 → **15** drives BOTH sides:
  the host sweep (`referee._leaveTimeoutMs`) and the guest watchdog (`main.js hostSilenceMs()` =
  `max(3000, leaveTimeoutSeconds*1000)`). 15s absorbs the backgrounded-tab jitter; a truly dead link
  (tab closed / phone asleep past wake-lock / network drop) stops pinging and crosses the line, so
  cleanup still works — host sweeps, guest boots with "Lost connection to host." HOT-TUNABLE.

**ANTI-CHEAT.** Pings carry NO positions/game data — the blindfold + spectator snapshot gates are
byte-identical (check-blindfold / check-spectator GREEN). No new protocol message (the ping was already a
control frame intercepted below the referee). No physics/damage/render/referee-gameplay change.

**GUARDS.** `tools/check-lifecycle.mjs` §A′ (markSeen stamps liveness; AFK-with-pings-only survives 5
simulated minutes; ping-silence past 15s still sweeps + announces the leave; a peer 0.5s under the
threshold is NOT swept). `tools/check-host-disconnect.mjs` §D (onKeepalive→watchdog feed, always-on
`_startKeepalive`, `_markAlive`, `referee.markSeen` wiring). `tools/check-debug-menu.mjs` (keepalive is
always-on; RTT is a by-product).

## 2026-07-19 HOST-DISCONNECT → BOOT TO LOBBY + STALE-SESSION GHOST FIX (VRmike)
Playtest: two windows both spawned as PROPS, an uncontrolled hunter stood in the world that players
passed straight through, player 2 couldn't affect anything / transform, and the round timer was
stuck at 0:00 — while player 1 (the host) kept playing normally. Guard: `tools/check-host-disconnect.mjs`.

**DIAGNOSIS — one bug in four costumes (the whole ghost session is a silent snapshot stall).** Every
symptom flows from the host's snapshot stream simply STOPPING while the client kept rendering the
last one it got:
- **Frozen 0:00 timer** — the HUD ticks the local `HudTimer` (B1) off the last snapshot's anchor and
  CLAMPS at 0; with snapshots stopped it counted its last anchor down to 0:00 and sat there.
- **Ghost hunter with no collision** — remote players are PURE interpolation toward the latest
  snapshot (`scene.interpolate`); they are NOT in the local prediction world (it holds only walls +
  props). With snapshots stopped the hunter is a frozen statue, and since only the HOST simulates
  player-vs-player collision, everyone walks through it.
- **Can't transform / interact** — `C2S.DISGUISE` + INPUT post into a dead `DataConnection`; the host
  never applies them, so nothing happens.
- **Both spawned as PROPS + a stuck hunter** — the client is simply painting a stale early snapshot.

**ROOT CAUSE — no detection of a SILENT host death.** PeerJS `conn.on('close')`/`'error'` cover a
LOUD disconnect, but a host whose tab is suspended / phone locks (the exact playtest setup: two
windows, one backgrounded) tears nothing down — no event fires, snapshots just stop. The client had
NO "how long since the last snapshot?" watchdog, so it stalled forever. Also, the guest's
`conn.on('error')` only acted *before* the link opened (`!ready`); a post-ready transport error was
SWALLOWED — a second silent-ish path with no teardown.

**FIX — client-side snapshot watchdog + wire the loud signals to one place. Host UNCHANGED (solo host
is a valid game).**
- **`js/host-watchdog.js` (NEW, PURE — like `hud-timer.js`).** `HostWatchdog` owns only the timing +
  a fire-ONCE latch: `arm(now, timeoutMs)` / `disarm()` / `feed(now)` (snapshot heartbeat) /
  `resume(now)` (tab-foreground grace) / `poll(now)` → true at most once when silence exceeds the
  timeout. No DOM/imports → unit-testable + host-safe.
- **`js/main.js` wiring.** Armed GUEST-ONLY at `S2C.STARTED` (`!session.isHost`; a flipped round
  re-arms with a fresh clock), fed in `onSnapshot`, polled each frame in `frameBody` GATED on
  `document.visibilityState==='visible'` (a backgrounded *own* tab throttles rAF, so that gap isn't
  the host's fault — `visibilitychange→visible` calls `resume()` for a fresh grace period). On a trip:
  `session.close()` (tear the dead Peer down — no PeerJS event did it for us) then the SHARED
  `backToMenu('Lost connection to host.')` — the SAME reset the graceful-close path already used
  (clears blindfold, spectator cam, frozen look, wake lock, HUD timer, predict world; builds a fresh
  Session). Disarmed on `backToMenu` AND the between-rounds `S2C.LOBBY` return (no snapshots stream in
  the lobby → must stop watching).
- **`js/net.js`.** The guest `conn.on('error')` now routes a POST-READY error to
  `onStatus('closed','Lost connection to host.')` + teardown (was swallowed), so both loud signals
  (close + mid-match error) land in the same `handleStatus('closed')→backToMenu` path. New public
  `Session.close()` = `_teardown()` for the watchdog's silent-stall teardown (the close/error paths
  teardown internally; the watchdog fires with no PeerJS event, so it needs this).

**TIMEOUT — derived from the documented rate, not hardcoded.** `main.js hostSilenceMs()` =
`max(3000, rules.leaveTimeoutSeconds*1000)` = **5 s** at ship config. That reuses the SAME "no traffic
= genuinely gone" threshold the HOST already applies to sweep silent guests (`referee
._sweepSilentPlayers`, B2), which at `snapshotRate` 15 Hz (~66 ms/snapshot) is ≈ 75 missed snapshots —
unambiguously dead, floored so a misconfigured tiny value can't false-kick a brief hiccup. One shared
silence threshold, both directions (host→guest sweep and guest→host watchdog).

**Scope.** Auto-*reconnect*/rejoin-in-place is deliberately OUT — rejoining from the menu is the
recovery path (small + safe; easy follow-up if wanted). Host detecting total peer loss is NOT added
(host alone is valid). No protocol change; no host/referee change.

## 2026-07-19 LOOK PITCH — snapshot gains `pitch` (VRmike)
Remote hunter models aimed dead-horizontal (yaw was networked, pitch wasn't). NEW snapshot player
field `pitch` (radians, host-authoritative — already stored as `player.pitch` from `C2S.INPUT`,
clamped ±1.5 in `applyInput`; broadcast for HUNTERS only, null otherwise — props render as their
disguise). One small float/player, negligible bandwidth, no new C2S message (pitch already rode
INPUT). Rides all snapshot variants free (they spread `...full` players). Purely cosmetic on the
remote soldier: `scene.js` tilts its head + arm to it (see `notes/hunter-character-model.md`) —
hitboxes/aim stay host-authoritative. Guard: `tools/check-hunter-model.mjs` §5.

## 2026-07-18 HELD-TOOL SYNC — snapshot gains `tool` (B7, VRmike)
The hunter's selected tool now travels over the wire so others render the right held item.
NEW `C2S.SELECT_TOOL {tool}` (client → host, deduped, living-hunter-only) + NEW snapshot player
field `tool` (host-authoritative: validated against `HUNTER_TOOL_IDS`, coerced, null for
non-hunters). Rides all snapshot variants free (`blindHunterSnapshot`/`hunterSafeSnapshot` spread
`...full` players). Purely cosmetic — no gameplay/damage; the fire path is unchanged. Full detail:
`notes/hunter-tool-visibility.md`.

## 2026-07-18 GHOST PLAYERS — leave detection + recount (B2, VRmike)
A player who LEFT used to persist as an uncontrolled GHOST until a new game. Two gaps, both fixed
HOST-SIDE in `shared/referee.js` (no protocol change); guard: `tools/check-lifecycle.mjs`.

**Two leave paths, one removal.** GRACEFUL close/error already ran `net.js → referee.removePlayer`
(unchanged). The SILENT case — a phone locks / signal drops with NO WebRTC `'close'` — never fired
that, so the ghost lingered. Now the referee times it out itself:
- Every C2S message stamps `player._lastSeen` (`handleMessage`); `addPlayer` seeds it.
- `tick()` calls `_sweepSilentPlayers(now)` ONLY during HIDING/HUNTING, where every live client
  streams INPUT at 20Hz (`main.js startInputLoop` is phase-gated) — so a peer silent for
  `rules.leaveTimeoutSeconds` (5s) has genuinely dropped, not just gone idle in the lobby. It
  removes them via the SAME `removePlayer` path. The HOST id is never swept (the referee lives in
  its tab; if it were gone nothing would run) and the sweep is off if the timeout is 0.
- `removePlayer(id, reason)` now: despawns the physics body+collider (already did), drops them from
  the roster (so they vanish from every snapshot + `propsTotal/propsAlive`), broadcasts a public
  `kind:'log'` "X left" line (new — mirrors the join/switch lines; `reason` adds "(timed out)"),
  then recounts. Called with one arg from `net.js` → plain "X left".

**Recount is leave-proof (both teams).** A leave removes the player from the roster, which erased the
roster-count proof that their team existed — so the old `checkRoundOver` (`props.length > 0 && …`)
could NOT fire a win when the LAST prop left, leaving the round to limp to the timer with zero props
(a stuck/ghost-kept-alive round). Fix: per-round flags `_roundHadHunters`/`_roundHadProps` set at
round start (`_launchRound`) and kept monotonically true whenever a player joins/switches onto a team
(`_spawnOnTeam`, `debugSetTeam`). `checkRoundOver` now resolves if EITHER side has no living members
AND that team `_roundHad*`: last prop gone (caught OR left) → hunters win; last hunter gone → props
win. A hunter-less SOLO round (`_roundHadHunters` false) still never false-resolves — it runs on the
timer. Flags fall back to the live roster count when unset, so a manually-driven test harness (that
skips `_launchRound`) keeps the original death-only behaviour (check-combat still passes). Flipped-round
assignment was already leave-safe (it iterates the post-removal roster); verified it doesn't crash on a
shrunk roster. See also `notes/spawn-system.md` (the spawn-embedding half of B2) + `game-loop.md`.

## 2026-07-18 SYNC BUGS: ROLE DESYNC + GAME TIMER DESYNC (B1, VRmike)
Two playtest-reported sync-integrity bugs. Both fixed CLIENT-SIDE (no protocol change — the data
was already on the wire); guard: `tools/check-sync-convergence.mjs`.

**1) ROLE DESYNC — a player saw THEMSELVES as a HUNTER while the host had them a PROP (and a real
hunter killed them).** Root cause: the client's OWN role came ONLY from the one-time private
`S2C.ROLE` message. Round start, flipped rounds (`startFlippedRound`), team switch (`applySwitchTeam`
→ `_spawnOnTeam`) and mid-join (`admitMidGame` → `_spawnOnTeam`) each fire a fresh ROLE, but if that
single announcement is ever missed/mis-applied during the flip/switch churn, the client stays the
WRONG role forever — rendering + behaving (view, tool bar, blindfold, disguise) as the opposite team
while the host (and hunters) treat it as the real, opposite role.
- **Fix — role is authoritative-and-ACKNOWLEDGED, not announce-once.** Role already rides EVERY
  snapshot as each player's own `hunter` flag (`broadcastSnapshot`: `hunter: p.role===HUNTER`), and a
  recipient is ALWAYS present in its own snapshot — in ALL three variants: `full`, `blindHunterSnapshot`
  (keeps hunters ⇒ a blindfolded hunter still sees itself), `hunterSafeSnapshot` (keeps everyone). So
  `js/main.js onSnapshot` now derives `serverRole = me.hunter ? HUNTER : PROP` and, on any mismatch with
  `state.role`, self-heals via the ONE `applyRole()` path (HUD pill + role view + tool bar). Converges
  within one snapshot (~1/`snapshotRate` = 66 ms). The private `S2C.ROLE` rail stays (belt-and-
  suspenders) but is no longer load-bearing. `applyRole()` is shared by the ROLE handler + the snapshot
  self-heal; it does NOT touch `state.alive` (alive is snapshot-owned; the ROLE handler still sets it on
  a fresh spawn). The blindfold's role-based data withholding rides the SAME now-self-healing role, so
  it keys correctly.

**2) GAME TIMER DESYNC (~4s; Jie saw 5s left while the host hit 0 and ended the round).** Root cause:
the HUD rendered each snapshot's `timeLeft` DIRECTLY (`ui.setHud`), so the countdown only moved when a
snapshot arrived — a snapshot stall FROZE it and it could drift seconds.
- **Fix — local tick between snapshots.** New PURE `js/hud-timer.js` (`HudTimer` + `formatClock`, no
  DOM/imports). On every snapshot AND every phase event the client re-anchors `endsAt = nowMs +
  timeLeft*1000` (`hudTimer.anchor`); the frame loop ticks `ui.setTimer(hudTimer.remaining(now))` each
  frame. Display can't freeze and can't drift more than one snapshot interval; re-syncs on every fresh
  anchor. **Round END stays host-authoritative:** `remaining()` clamps at 0 — the ticker waits at 0:00
  for the host's phase/`roundOver` event; no client ends a round on its own clock. `hudTimer.stop()` on
  the lobby + menu transitions so a stale anchor can't paint the HUD. `ui.setHud`/`ui.setTimer` both
  format via `formatClock` (one source of truth). `nowMs()` is the shared `performance.now()` clock the
  frame loop already uses, so anchor + tick are in one time domain.

## 2026-07-17 HOST-AUTHORITATIVE OBJECT SYNC + WORLD SNAPSHOT ON RELEASE/JOIN (VRmike)
**Symptom:** one player knocks an object over; others — ESPECIALLY hunters spawning in after the
hide phase — still see it UPRIGHT.

**AUDIT (the plan demanded it before writing): the object stream already existed.** The host writes
its live physics transforms into the snapshot every tick (`referee.broadcastSnapshot` → `props:
this.awakePropTransforms` = `physics.awakeProps()`), clients apply/interpolate them (`scene.syncProps`
+ `scene.interpolate`; the guest predict world's fixed prop colliders are repositioned by
`physics.syncPropTransforms`), and a mid-round joiner gets a full LIVE catch-up in STARTED
(`referee._propsCatchup()` via `physics.allProps()`). So a *continuously-connected, non-blindfolded*
client already sees objects move correctly. **The desync lived entirely in the blindfold path:**
- A HUNTER is fed `props:[]` all through HIDING (`blindHunterSnapshot`, anti-cheat data-half).
- By the time HUNTING starts, every object a hiding prop shoved has settled ASLEEP, and the per-tick
  stream carries only AWAKE props — so it never resends them.
- ⇒ the just-released hunter renders the FACTORY-FRESH map (props at spawn = "still upright").

**FIX — three surgical changes, NO new parallel channel (extend the existing snapshot props form):**
1. **World snapshot on blindfold release.** `referee.setPhase(HUNTING)` sends every HUNTER a ONE-TIME
   `S2C.EVENT kind:'world' {props: _propsCatchup()}` (every dynamic body's current transform, same
   live-form entries STARTED's catch-up uses). Client `main.js onEvent 'world'` →
   `scene.applyWorldSnapshot(list)` SNAPS each MOVED prop's container to its transform (never-moved =
   spawn-form, no `qx`, already correct → skipped) and `state.predict.syncPropTransforms(list)` snaps
   the local prediction colliders. HIDING→HUNTING is the ONLY path into HUNTING, so no double-fire.
   Props aren't blindfolded (they tracked the awake stream live) → they don't get it.
2. **Mid-join catch-up is blindfold-gated.** `_propsCatchup(blind)` returns SPAWN-form props when
   `blind` (no live positions leak); `admitMidGame` computes `blind = role===HUNTER &&
   phase===HIDING`. A hunter joining mid-HIDING sees the factory-fresh map (their screen is blacked
   out anyway) and gets the real world at the HUNTING release above — the two are ONE mechanism.
3. **Final rest transform on sleep (part D).** `physics.awakeProps()` emits ONE last transform on the
   awake→asleep EDGE (per-body `_wasAwake` flag, initialised `!isSleeping()`), then goes silent. A
   body that STAYS asleep streams nothing (steady-state near-zero, unchanged); this just stops a
   continuously-connected client from keeping a pose captured a hair before the body truly stopped.

**Anti-cheat invariant preserved:** all object data still flows through the SAME withholding rule the
blindfold enforces — withheld from a HIDING hunter (stream AND join-catch-up), released the instant
HUNTING starts. We extended that gate; we never bypassed or reworked `blindHunterSnapshot`.

**Guard:** `tools/check-object-sync.mjs` (needs the dev Rapier, like check-settle) drives a real Rapier
world + a real Referee: knocks an object over, asserts (a) a late joiner's catch-up carries the moved
transform, (b) an asleep body streams nothing, (c) the final rest frame arrives on sleep then stops,
(d) a HIDING hunter gets zero object transforms (stream + catch-up) then the full world at HUNTING.

**NOT done — (B) client prediction of the object you're directly pushing (OWED, deferred by design).**
The brief's (B) asks for local dynamic sim + reconcile of the object under your hands, for
responsiveness. It is deliberately NOT in this session: (i) a guest's shove ALREADY propagates
correctly — the guest's kinematic avatar shoves the *real* dynamic body on the host, which streams
back, so it's correct if slightly latency-lagged, not broken; (ii) it's the riskiest surface (it would
make the predict world's props DYNAMIC for touched bodies only + add a `C2S` interaction message +
smooth reconciliation), touching the settle/predict code the no-touch list guards. Design for a
follow-up: on local shove, (a) simulate the touched body locally for instant feedback, (b) send the
host a compact "I hit body X ~this hard at this point" event (one new C2S type; host applies it to its
sim → wakes the body → it enters the awake stream), (c) blend the local body gently toward the host's
incoming transforms (corrections smeared over a few frames, never a snap). Same philosophy as player
prediction/reconciliation.

## 2026-07-13 JUMP-JUDDER FIX — vertical reconciliation is frozen while airborne (VRmike)
**Symptom:** in FIRST person your own jump arc juddered (repeated downward jerks) — but
watching OTHER players jump was perfectly smooth, and it happened even for the HOST.

**Root cause (diagnosed, not guessed — `tools/_jumpdiag.mjs` host-case trace):** the local
prediction world and the authoritative world compute the fast jump arc slightly OUT OF PHASE.
They step on different cadences (60 fps predict loop vs 30 fps referee tick draining a fixed
1/60 substep accumulator) and the snapshot `y` is 1 cm-quantised. The 15 Hz reconcile then
snapped the local VERTICAL position onto that phase-shifted authoritative value every snapshot,
injecting a large decaying `corr.y` offset (measured up to **~0.45 m**) — a sawtooth on
`camera.position.y`. Because remote players are pure interpolation of the smooth authoritative
arc they never juddered; because the two Rapier worlds step out of phase, even the HOST (zero
network latency) showed it. NOT ground-snap (already disabled while `vy>0`) and NOT horizontal
reconciliation. The harness reduced the injected correction from 0.449 m → **0.000 m** and the
against-arc jerk frames from 3 → **0**.

**Fix (`reconcilePredict` in `main.js`):** while the LOCAL player is airborne
(`!state.grounded`, read back from the predict world each `predictStep`), SKIP reconciliation
entirely — local prediction OWNS the jump. The vertical arc is deterministic from the SAME
shared physics both sides run (gravity + jumpSpeed from `rules.json`), so there is nothing to
correct; only quantisation/phase noise. Exceptions & safety:
- A genuine **large teleport while airborne** (respawn / anti-tunnel escape / hard desync,
  horizontal or vertical > 2.5 m from the predicted pose) STILL falls through to the normal
  snap-reconcile, so a real correction is never swallowed.
- `pending` is still trimmed by `ack` while airborne (bounded history); we just don't replay.
- Horizontal drift during the sub-second airborne window is negligible (host ≈ 0; guest ≪ the
  2.5 m snap threshold) and eases out on the first grounded reconcile. GROUNDED play — walking,
  standing, wall-slide, prop-shove reconciliation — is completely unchanged.

`state.grounded` is the local prediction's grounded flag (the snapshot carries no grounded
field). Diagnostic harness kept at `tools/_jumpdiag.mjs` (authoring-only, not shipped, not a
build gate): `npm i --no-save @dimforge/rapier3d-compat@0.14.0 && node tools/_jumpdiag.mjs [fix]`
re-runs the baseline-vs-fix trace for any future regression.

## 2026-07-10 FIX PASS — STARTED payload now carries live prop state
Because the world became knockable (see physics.md fix pass), the `S2C.STARTED`
prop list changed, and mid-game join changed DELIBERATELY:
- Each prop entry now carries `disguisable` (false for knockable fixtures — solid +
  shovable but not wearable) so the client's disguise picker skips them.
- A MID-ROUND joiner's STARTED carries each prop's LIVE transform (`x,y,z` = body
  centre + `qx,qy,qz,qw` quaternion) instead of spawn positions, so they see kicked
  chairs/tables where they actually rest, not back at spawn (fix #8). Fresh-match
  STARTED still sends spawn-form entries (`x/z` floor pos, `y` surface offset, `rot`).
  Presence of `qx` marks the live form. Referee: `_propsCatchup()` via
  `PhysicsWorld.allProps()`. Readers: scene.buildWorld + physics._buildProps branch
  on `qx`.
- Per-tick SNAPSHOT is UNCHANGED: still only AWAKE dynamic props ride it
  (`{id,x,y,z,qx,qy,qz,qw}`), sleeping ones omitted. There are just more potential
  dynamic props now (tables/dishes/food), so a big collision cascade streams more for
  a moment — still near-zero at rest.
- Prediction/reconciliation logic itself is UNCHANGED (same rewind/replay); it still
  needs a live playtest since the shared mover's timestep changed to strict fixed
  substeps (see physics.md). No protocol change to C2S or the snapshot player entry.

## PHYSICS PASS UPDATE (2026-07-09, `physics-net`) — prediction + reconciliation
The netcode grew from "predict the local player's flat 2D position" to full
**client-side prediction + server reconciliation over a Rapier sim**. Architecture
that SHIPPED (the target, not the interpolation-only fallback), stated honestly:

- **Host** runs the one authoritative Rapier world (see physics.md). Each snapshot
  (15 Hz) now also carries: per-player `y` (jump height) + `ack` (the last
  `INPUT.seq` the host consumed from that player), and a `props[]` array of the
  transforms of **awake** dynamic props only (`{id,x,y,z,qx,qy,qz,qw}` quantised) —
  sleeping props are omitted (they haven't moved).
- **Guests (and the host)** predict the LOCAL player with their own Rapier world
  (`main.buildPredict`, `{dynamicProps:false}`): real collide-and-slide vs walls /
  fixtures, instant response. Every predicted frame gets a `seq`, stored with its
  input in `state.pending`, and the current `seq` rides each `C2S.INPUT`.
- **Reconcile** (`reconcilePredict`, per snapshot): drop `pending` with
  `seq <= ack`, teleport the predict body to the authoritative pose, **replay** the
  remaining inputs, then fold the residual into a decaying `corr` offset (eased over
  a few frames; SNAP if > 2.5 m — teleport/tag/hard desync). This is the
  rewind/replay loop, not a smoothing-only nudge.
- **Remote players + awake props** interpolate toward the latest snapshot in
  `scene.interpolate` / `scene.syncProps` (props move a container Group whose origin
  is the body centre; a swapped GLB is offset to sit on the floor).
- **Input** now carries `seq, jump, rotUnlock` too. `jump` → physics jump (grounded
  only); `rotUnlock` → disguise yaw-rotate (orientation lock, see physics.md).
- **Graceful degrade:** if Rapier can't load, both sides revert to the pre-physics
  flat 2D prediction (the code branches on `state.predict` / `referee.physics`).
  The old 0.08/frame reconcile-toward-serverSelf lives on in that fallback branch.
- **CANNOT be verified headless** — the auto-check is a load test. Prediction feel,
  rubber-band on prop shoves, and jitter under real ping need a live playtest.

## Two layers (since the static-Pages fix, on PeerJS)
1. **Signaling** — a **PeerJS `Peer`** talks to PeerJS's **free public broker**
   only to find the other browser and pass the WebRTC handshake. No gameplay ever
   crosses it. (This replaced a Node matchmaker + hand-rolled RTCPeerConnection
   code — Cloudflare Pages can't run a Node server, so the deploy 404'd. See
   project-state.)
2. **Game transport** — a PeerJS **`DataConnection`** from each guest to the host,
   OR (for the host's own client) a local loopback. The referee
   (`shared/referee.js`) runs in the host's tab and speaks the unchanged C2S/S2C
   protocol over whichever transport a given player has.

All of this lives behind `js/net.js` (`Session`). `main.js` only calls
`session.create/join/send`, reads `session.ready`, and sets `session.onMessage`
/ `session.onStatus`. It cannot tell host from guest — by design.

## Room codes & peer ids
Host mints a 4-char code client-side (unambiguous alphabet, was the matchmaker's
job). PeerJS ids are one global namespace on the shared broker, so the actual id
is **`prophunt-<CODE>`** (`PEER_PREFIX` in `net.js`) to avoid colliding with
other PeerJS apps. Users only ever see/type the 4-char code.

## Signaling / handshake (who does what) — all via PeerJS
- **Host**: `new Peer('prophunt-'+code, {config:{iceServers}})`. On `'open'` it
  builds the `Referee` and adds itself via the loopback. `peer.on('connection',
  conn)` fires per guest → bridge `conn` into the referee on `conn.on('open')`.
  If the id is taken, PeerJS errors `unavailable-id` → retry with a fresh code
  (up to 5×).
- **Guest**: `new Peer({config:{iceServers}})` (anonymous id). On `'open'`,
  `peer.connect('prophunt-'+code, {reliable:true, metadata:{name}})`. Error
  `peer-unavailable` == no host under that code ("room not found").
- **PeerJS owns the offer/answer/ICE dance** — we no longer touch SDP or ICE
  candidates directly. We just inject `iceServers` via the `Peer` `config` option
  and read the result.
- Guest name travels in `conn.metadata.name` (replaces the old matchmaker
  `PEER_JOIN` name). Host reads it in `_hostAccept` to label the lobby row.

## Reliable + ordered
`peer.connect(..., {reliable: true})`. **PeerJS defaults to UNRELIABLE**, which
can drop/reorder — the match-start ordering (STARTED/ROLE/first SNAPSHOT) depends
on reliable+ordered, so the flag is mandatory. (Host doesn't pass options on its
side; the guest side's `reliable` governs the channel.) Handlers stay
order-tolerant anyway.

## Data format
We send **plain JS objects** via `conn.send(obj)` and receive objects in
`conn.on('data', obj)` — PeerJS serializes (BinaryPack) for us, so there's no
`JSON.stringify`/`parse` at this layer anymore. The referee's per-player `send`
callback is just `conn.send(obj)` (guest) or a direct call (host loopback).

## Join/leave = PeerJS events (no more SIG messages)
- Host: `conn.on('close')`/`'error'` → `referee.removePlayer(guestId)`. This is
  the authoritative "player left" signal.
- Guest: `conn.on('close')` → "Host left — the match ended." → teardown. **As of
  2026-07-19** a POST-READY `conn.on('error')` also routes to `onStatus('closed',
  'Lost connection to host.')` + teardown (before that it was swallowed once the link
  opened). Both loud signals land in `handleStatus('closed')→backToMenu`.
- **SILENT host death fires NO PeerJS event** (tab suspended / phone locks): caught by
  the client-side snapshot watchdog, not here — see the 2026-07-19 section above.
- There is a ~10s **give-up timer** each side (`CONNECT_TIMEOUT_MS`): guest timer
  set in `_startGuest`, cleared on `conn.on('open')`; host per-peer timer in
  `_hostAccept`. Bounds WebRTC's own much slower failure.

## Game protocol (`C2S`/`S2C`) — UNCHANGED
Same message shapes as ever; only the pipe changed. `SIG` and the dead
`C2S.CREATE/JOIN` were removed from `shared/protocol.js`. Snapshot player entry:
`{id,name,x,z,yaw,alive,hunter,disguise}`, positions rounded. `hunter`/`disguise`
are the only role leakage to guests.

## Host authority & the loopback
The host's own client sends C2S straight into the referee
(`referee.handleMessage(selfId, msg)`) and the referee replies via a callback that
calls `session.onMessage` — a zero-latency loopback that behaves exactly like the
wire. The host's reconcile-toward-authoritative nudge in `main.js` (0.08/frame)
converges to a near-no-op because its authoritative position tracks its prediction
with no round trip. Guests still predict against real latency — keep the movement
math identical for both.

Trust: the host clamps every guest's `mx/mz`/`pitch` and judges all tags/disguises
from host-held positions. Guests are untrusted for outcomes. But the HOST itself
is authority — no neutral referee (see architecture.md).

## Client-side prediction
`main.js` predicts only the *local* player: integrate own movement each frame with
the same formula as the referee, then reconcile toward `serverSelf` at 0.08/frame.
First snapshot of a match snaps the camera to spawn (`state.spawned`). Others
interpolate toward latest snapshot at 0.25/frame. No rollback/input buffer.

## Rates
`tickRate` 30 Hz (sim), `snapshotRate` 15 Hz (broadcast), client INPUT send 20 Hz
(hardcoded in `main.js` startInputLoop).

## NAT traversal / connection reality (still the migration's big risk)
`ICE_SERVERS` in `js/net.js` = free public **STUN + TURN**, injected via the
PeerJS `Peer` `config` option. STUN covers most home NATs directly.
Strict/symmetric NATs fall back to a **TURN relay** (OpenRelay free public relay,
user/cred `openrelayproject`). Swap those three `turn:` entries for your own
Metered/OpenRelay account creds for a dedicated quota. **Direct-first is
preserved** — PeerJS leaves `iceTransportPolicy` at default `'all'`, so the ICE
agent prefers the cheapest working pair and TURN is fallback-only.

**Connection-type diagnostic (direct vs relayed).** On `conn.on('open')`,
`net.js` calls `_reportLink(conn.peerConnection, id)` → `detectRelayed(pc)`, which
reads `pc.getStats()`, finds the selected candidate pair, and checks whether the
*local* candidate is a `relay` candidate. **Key PeerJS detail:** the underlying
`RTCPeerConnection` is exposed as `conn.peerConnection` — that's how we still reach
`getStats()`. It emits `onStatus('link', {id, relayed})`; `main.js` forwards to
`ui.setLink`, which paints the badge. Each player labels only its OWN connection.

## Gotchas for future sessions
- **PeerJS default is unreliable** — the guest MUST pass `{reliable:true}`.
- Movement formula is duplicated referee + client and MUST match (architecture.md
  "Movement convention").
- `conn.peerConnection` is PeerJS-specific — if you swap transports, re-find the
  RTCPeerConnection for the direct/relayed badge.
- A `Session` is single-use: `_teardown()` closes conns + `peer.destroy()`.
  `main.js` builds a fresh one via `newSession()` on return to menu.
- Two browser tabs on one machine connect fine via loopback, but that does NOT
  test real NAT traversal — only two different homes does.
- We depend on shared free services (PeerJS broker + OpenRelay TURN). If joining
  gets flaky, suspect one of those before the code.
- **CDN for the PeerJS lib is LAZY-LOADED**: `net.js` no longer top-level-imports
  PeerJS. `loadPeer()` does a **dynamic** `import('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm')`
  the first time `create()`/`join()` runs, caching the `Peer` ctor. `_startHost`/
  `_startGuest` are therefore `async` and `await loadPeer()` (with a graceful
  onStatus error if the CDN is unreachable). **Why:** the headless load check runs
  in a sandbox with NO outbound network, so ANY boot-time external fetch =
  `net::ERR_FAILED`. Switching CDN providers (esm.sh → jsDelivr) did NOT fix it —
  the fix is to not fetch at page load AT ALL. three.js got the same treatment:
  `main.js` lazy-imports `scene.js` in `ensureScene()` (built on first match start,
  not at boot). A bare landing page now makes zero external requests. Constraint
  still satisfied — CDN import, no build step; the download just happens on demand.
  This is the *library* download only; unrelated to the PeerJS *broker* (still the
  free public one).
