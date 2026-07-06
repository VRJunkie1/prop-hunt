# prop-hunt — architecture ground truth

Updated by dev sessions whenever a change alters the design.

## Shape

Browser clients play **peer-to-peer over WebRTC**. The room creator's browser is
the **host**: it runs the referee (authoritative game state) in-tab. The app is
**fully static** — no backend of ours. Peer introduction (room codes + WebRTC
handshake relay) is done by **PeerJS's free public broker**; we run nothing.

```
guest browser  --RTCDataChannel-->  HOST browser (referee)
  Three.js render                     owns true game state
  sends INTENT only                   decides ALL outcomes
  predicts self locally               broadcasts snapshots
                                       host's OWN client talks to the
                                       referee via a local loopback
        \                             /
         \  --PeerJS broker (0.peerjs.com, free/public)--/
          introduces peers by id + relays SDP/ICE only; not ours to run
```

## The load-bearing decision — REVERSED 2026-07 (P2P rebuild)

**History:** the original design was server-authoritative — every client opened
an *outbound* WebSocket to one shared server that was both the single public
endpoint (so **no port forwarding**, guaranteed) and a **neutral referee** (the
basis for future anti-cheat). The directive was "do not move authority to
clients."

**This was deliberately reversed** on Manny's instruction to rebuild as P2P
WebRTC ("no server"). Authority now lives on the **host client**. What that
bought and cost, stated plainly so nobody re-discovers it the hard way:

- **Cost — port forwarding is back (partially).** WebRTC + public STUN traverses
  most home NATs, but strict/symmetric NATs need a **TURN relay** to connect —
  a paid, always-on server carrying live game traffic. Currently **NO-GO / not
  configured**, so some networks can't join. This is the single biggest risk and
  the thing to playtest (see project-state).
- **Cost — we depend on a third-party broker.** Browsers can't find each other
  unaided. That introduction is now done by PeerJS's **free public broker**
  (0.peerjs.com) — we don't run it, but it's a shared best-effort service we
  don't control (it can rate-limit or go down; room ids share a global
  namespace, so we prefix them `prophunt-`). No server of ours is the point.
- **Cost — anti-cheat given up.** The host's browser holds the full unfiltered
  state (including who's an undisguised prop). A determined host can inspect or
  tamper with it. Guests still get filtered snapshots; guest *input* is still
  clamped/judged by the host. There is no longer a neutral referee.
- **Benefit — no central game server to run/pay for during play.** Live traffic
  is peer-to-peer; the matchmaker is cheap and idle-friendly.

If a future session considers moving back, that's a legitimate call — this
reversal was a product decision, not a technical necessity.

## Peer introduction (PeerJS public broker — nothing of ours)

- There is **no `server/` anymore.** Peer discovery + WebRTC handshake relay is
  done by PeerJS's free public broker. `client/js/net.js` just uses the PeerJS
  client library (imported from esm.sh). Room codes are minted client-side (the
  host claims the peer id `prophunt-<CODE>`; a collision on the shared broker
  fires `unavailable-id` and it retries with a new code). Host-left / guest-left
  are detected from **DataConnection `close`**, not a broker event.
- `server/` still physically exists as **tombstones** (`index.js`, `Room.js`,
  `config.js`) only because this environment has no file-deletion tool. Nothing
  imports or runs them. `git rm -r server/` when a shell is available.
- The static files (`index.html` at the repo root, `client/`, `shared/`,
  `assets/`) are served by any static host — set up for **Cloudflare Pages**,
  no build step, output dir = repo root. See README.

## Referee (`shared/referee.js`) — runs in the HOST browser

- A port of the old server `Room`: same rules, same movement math, same phase
  machine. What changed: **config is injected** (the client already fetched it),
  each player carries a **`send(obj)` callback** instead of a socket, and the
  tick uses `setInterval` (works in the browser). It speaks the unchanged
  C2S/S2C protocol regardless of transport.
- The host adds **itself** as a player whose `send` loops straight back into its
  own client (no round trip); each guest is added when its DataChannel opens,
  with `send` = a channel write. From the referee's view all players are
  identical.

## Client (`client/`)

No build step. Three.js loaded from CDN via `<script type="importmap">` — from
**esm.sh** (`https://esm.sh/three@0.161.0`), the same origin as PeerJS in
`net.js`. It was on unpkg (`build/three.module.js`) until 2026-07, when unpkg's
redirect started failing the headless load check (`net::ERR_FAILED`); esm.sh
serves it reliably, so both third-party modules now come from one CDN.
`index.html` lives at the **repo root** (static hosts serve it as the index) and
references the game code by absolute path (`/client/css`, `/client/js`,
`/shared`, `/assets`); the JS/CSS themselves stay under `client/`.

- `main.js` — glue + render loop + light client-side prediction for the local
  player (integrates own movement each frame, reconciles toward the authoritative
  pos at 0.08/frame). Sends INPUT at 20 Hz via `session.send`. Identical code for
  host and guest.
- `net.js` — the **dual-mode network layer** (`Session`), now built on **PeerJS**
  (imported from esm.sh): either (host) claim `prophunt-<CODE>` on the broker,
  build an in-tab `Referee` + loopback link, and bridge each guest's
  `DataConnection` into the referee, or (guest) open one `DataConnection` to the
  host. Connections are opened **reliable + ordered** (`reliable:true`) with
  `serialization:'json'`. ICE config (STUN; TURN placeholder) is `PEER_CONFIG`
  here — the successor to the old `ICE_SERVERS`. Guest name reaches the host via
  the connection's `metadata`. PeerJS does all SDP/ICE plumbing internally.
- `input.js` — WASD + pointer-lock mouse look; emits action events. Also holds
  the small touch hooks (`isTouch`, `touchMove/touchJump/touchCrouch`,
  `applyLookDelta`) that the mobile layer writes into — so the game reads one
  intent regardless of device.
- `touch.js` — **mobile on-screen controls** (`setupTouchControls`): a left
  virtual joystick → `input.touchMove`, a full-screen look-drag layer →
  `input.applyLookDelta`, and JUMP/CROUCH (held) + ACTION (fires `onAction
  ('primary')`) buttons. Isolated from `input.js`; wired only when `input.isTouch`.
  Adds NO new movement/look/referee path — it feeds the existing intent fields.
  Full detail in `memory/notes/mobile.md`.
- `scene.js` — all Three.js. Builds world from config, reconciles player meshes
  to snapshots, interpolates others, first-person camera for self.
- `ui.js` — DOM screens (menu/lobby/game), HUD, feed. No game logic.
- `config.js` — fetches `shared/config`; the host passes it into the `Referee`.

## Shared (`shared/`)

- `protocol.js` — **one protocol**: `C2S`/`S2C`/`PHASE`/`ROLE` (client ↔
  referee). Dependency-free ESM. The old `SIG` signaling protocol is gone —
  PeerJS's broker owns peer introduction, so there's no signaling of ours.
- `referee.js` — the authoritative referee (see above). Browser-only.
- `config/` — **content as data**: `rules.json` (timers, speeds, ratios),
  `maps.json` (size, colors, spawns, prop placements), `props.json` (prop-type
  catalog). Adding maps/props needs no engine change.

## Movement convention (must stay in sync between referee & client prediction)

yaw about Y. forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
`vx = -sin*mz + cos*mx`, `vz = -cos*mz - sin*mx`, normalized if len>1, then
`pos += v * moveSpeed * dt`, clamped to `±(map.size/2 - mapMargin)`. Three.js
camera uses `YXZ` rotation order (yaw then pitch).

**Crouch + jump extend this (added 2026-07) and the same "two places, identical
math" rule applies — now to THREE axes:**
- **Crouch** (held Ctrl/C): horizontal speed × `crouchSpeedMult`, camera eye
  height eased to `crouchEyeHeight`, avatar squashed (`CROUCH_SCALE` in scene.js),
  and — critically — the referee's **tag hitbox** uses `crouchBodyHeight`.
- **Jump** (held Space): `pos.y` gains a vertical axis. `grounded = pos.y<=0`;
  `if (grounded && jump) vy = jumpSpeed; vy -= gravity*dt; pos.y += vy*dt;` then
  clamp `pos.y` to ≥0. jump/crouch travel as **held-state booleans** in the INPUT
  message (edge-triggering would desync 20 Hz send vs 60 fps predict); the referee
  only acts on `jump` when grounded, so holding Space doesn't spam hops.

`Referee.integrate` and the `main.js` frame loop implement all of the above
identically — change both together. For the host, reconciliation is a near-no-op
(its authoritative pos tracks its prediction with no round trip); guests still
predict against real latency.

**Tag is now a 3D ray gate** (`applyTag`): unchanged horizontal distance + yaw
cone, PLUS a vertical check — the aim ray height at the target's distance
(`eyeY + tan(pitch)*dist`) must land inside the target's body column
(`[footY, footY+bodyHeight] ± tagVertPad`). This is what makes crouch/jump matter
to tags and keeps "you tag what you aim at" true. eyeY/bodyHeight come from the
same crouch-aware helpers the camera + avatar use.

## Disguise is aim-based (added 2026-07)

A prop disguises as **the prop under its crosshair**, not the nearest one. Props
carry a **stable id** in `maps.json`; both the client scene and the referee build
from that file, so the id is the shared language. The client raycasts
(`scene.propUnderCrosshair`, first hit within `disguiseRange` = occlusion for
free) and sends `{ propId }`; the referee re-checks the id **loosely** — range +
facing (yaw cone + crouch-aware vertical gate) only, **no occlusion geometry**.

This client-strict / referee-loose split is **intentional and inverse to the
movement-math rule**: for movement we duplicate the math so both sides agree; for
disguise we deliberately DON'T duplicate the occlusion geometry — the referee only
needs to reject "aimed across the map" cheats, not re-simulate the scene. A future
session must not "fix" the mismatch by porting Three.js raycasting into the
referee. Full rationale + the crosshair-feedback layering in
`memory/notes/disguise.md`.

## Phase state machine (referee-owned, in `shared/referee.js`)

LOBBY → (host START) → HIDING (hunters frozen **and blindfolded**) → HUNTING →
ENDING (scoreboard, `endingSeconds`) → **next round with teams SWAPPED**
(`nextRoundOrLobby` → `beginRound`), looping HIDING→…→ENDING→next round. Timers
via `phaseEndsAt`. Hunters win when all props eliminated; props win if the hunt
timer expires with any prop alive.

**The loop only returns to LOBBY via one referee decision**, in two cases:
(1) the host leaves — the network layer tears the whole match down; (2) a
disconnect empties a whole team mid-round (`bailIfTeamEmpty`, called from the
single `removePlayer` path) or a swap would leave a side empty
(`nextRoundOrLobby`). There is exactly one place each decides "lobby vs keep
playing." `resetToLobby(reason)` clears roles/teams and broadcasts a `toLobby`
event + a fresh lobby.

**Teams (round assignment).** Round one uses the players' **own lobby picks**
(`player.team`), not a random ratio. Each later round swaps: last round's hunters
become props and vice-versa (`computeSwappedTeams`); mid-match joiners (role
null) fold into the smaller side so they play the next round.

## Blindfold (hunters can't cheat during HIDING) — two halves

1. **Data:** `broadcastSnapshot` sends each recipient a tailored player list; a
   hunter during HIDING gets a list containing **only themselves**, so even dev-
   tools poking reveals nothing. (Host caveat below still applies.)
2. **Screen:** a full black "🙈 eyes closed" overlay with the countdown, wired the
   same show/hide way as the click-to-play overlay — `ui.setBlindfold()` flipped
   from `main.js` `updateBlindfold()` on role+phase. No game logic in the UI.

## Lobby team pickers (replaces the Ready button)

Two clickable columns — **Hunters left, Props right** (`index.html` + `ui.js`
`renderLobby`). Clicking a column sends `C2S.PICK_TEAM {team}`; clicking your
current team unpicks. **Picking IS readying** — the Ready button is gone. The
referee owns the truth: `broadcastLobby` computes `canStart` (everyone picked +
≥1 per side + ≥minPlayers) and the lobby only *displays* teams + gates Start on
it. `startMatch` re-validates before beginning.

## Lobby map selection (host-only, added 2026-07)

The host picks which map is played from a list rendered straight from `maps.json`
(every client already downloaded it). Four load-bearing rules, all so the choice
travels exactly one road:

- **The referee knows who the host is.** The network layer (`net.js`
  `_becomeHost`) adds its own loopback player with `host: true`; `addPlayer` uses
  that flag to set `hostId` (falling back to first-added if absent). This is the
  single source of truth for "who may pick the map / start" — the referee still
  treats all players identically otherwise.
- **One selected-map setting**: `referee.mapId`, defaulting to the first map in
  the file (single-map builds play with zero clicks). `beginRound`/`integrate`
  already read it, so the choice flows into spawns/props/bounds for free.
- **`C2S.PICK_MAP {mapId}` with three gates**, silently dropped on any failure:
  sender is `hostId`, phase is LOBBY, and `maps[mapId]` exists. The referee is the
  truth, not the buttons — a guest faking the message via dev tools gets nowhere.
- **The lobby broadcast (`S2C.LOBBY.mapId`) is the SOLE carrier.** Each client
  remembers the latest id it saw (`state.selectedMapId`) and builds its 3D scene
  from it at match start. `S2C.STARTED` deliberately **no longer carries mapId** —
  two copies of the same value is how "props on my screen, not yours" desyncs are
  born. Referee props (from `mapId` in `beginRound`) and client scene (from the
  remembered id) both derive from the same value delivered in one message.

Rendering: `ui.renderMaps` lists every map (name + size), marks the selected one
for everyone, and makes rows interactive only for the host (guest rows are
`locked`, click ignored in `main.js` and re-rejected by the referee anyway). Full
detail in `memory/notes/map-selection.md`.

## Role/identity hiding

Snapshots expose `hunter: bool` (seekers are meant to be visible) and `disguise`
(the prop type a prop chose). They never expose which players are undisguised
props **to guests**. Own role comes via a private `ROLE` message. Two caveats,
both by design now: (1) the **host** holds the full state in its own tab, so it
can see undisguised props — an accepted cost of host authority (the HIDING
blindfold's data half is likewise honor-system for the host); (2) an undisguised
prop still renders as a neutral capsule and so is visible while moving —
acceptable for the skeleton; see project-state open threads.
