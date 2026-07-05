# prop-hunt — architecture ground truth

Updated by dev sessions whenever a change alters the design.

## Shape

Browser clients play **peer-to-peer over WebRTC**. The room creator's browser is
the **host**: it runs the referee (authoritative game state) in-tab. A tiny Node
**matchmaker** serves the static client and relays the WebRTC handshake; it holds
no game state and sees no gameplay.

```
guest browser  --RTCDataChannel-->  HOST browser (referee)
  Three.js render                     owns true game state
  sends INTENT only                   decides ALL outcomes
  predicts self locally               broadcasts snapshots
                                       host's OWN client talks to the
                                       referee via a local loopback
        \                             /
         \  --WebSocket (signaling)--/
          matchmaker: room codes + relay WebRTC offer/answer/ICE only
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
- **Cost — "no server" is not literally true.** Browsers can't find each other
  unaided; the matchmaker is a small always-on service. It's just tiny now.
- **Cost — anti-cheat given up.** The host's browser holds the full unfiltered
  state (including who's an undisguised prop). A determined host can inspect or
  tamper with it. Guests still get filtered snapshots; guest *input* is still
  clamped/judged by the host. There is no longer a neutral referee.
- **Benefit — no central game server to run/pay for during play.** Live traffic
  is peer-to-peer; the matchmaker is cheap and idle-friendly.

If a future session considers moving back, that's a legitimate call — this
reversal was a product decision, not a technical necessity.

## Matchmaker (`server/`)

- `index.js` — HTTP static file server (serves `client/`, `/shared/`, `/assets/`)
  + a `ws` WebSocketServer for **signaling only**. Mints 4-char room codes
  (unambiguous alphabet), pairs peers (create/join), and relays WebRTC handshake
  blobs (`SIG.RELAY`) between a host and each guest by peer id. On host
  disconnect it tells everyone (`SIG.HOST_LEFT`) and drops the room; on guest
  disconnect it tells the host (`SIG.PEER_LEFT`). **No game logic, no tick, no
  config.** (The old `Room.js` and `config.js` were deleted; rules moved to
  `shared/referee.js`.)

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

No build step. Three.js loaded from CDN via `<script type="importmap">`.

- `main.js` — glue + render loop + light client-side prediction for the local
  player (integrates own movement each frame, reconciles toward the authoritative
  pos at 0.08/frame). Sends INPUT at 20 Hz via `session.send`. Identical code for
  host and guest.
- `net.js` — the **dual-mode network layer** (`Session`): a signaling WebSocket
  to the matchmaker, plus either (host) an in-tab `Referee` + loopback link + a
  bridge from each guest's `RTCDataChannel` into the referee, or (guest) one
  `RTCDataChannel` to the host. Data channels are configured **reliable +
  ordered** explicitly. ICE servers (STUN; TURN placeholder) live here.
- `input.js` — WASD + pointer-lock mouse look; emits action events.
- `scene.js` — all Three.js. Builds world from config, reconciles player meshes
  to snapshots, interpolates others, first-person camera for self.
- `ui.js` — DOM screens (menu/lobby/game), HUD, feed. No game logic.
- `config.js` — fetches `shared/config`; the host passes it into the `Referee`.

## Shared (`shared/`)

- `protocol.js` — **two protocols**: `SIG` (client ↔ matchmaker signaling) and
  the unchanged `C2S`/`S2C`/`PHASE`/`ROLE` (client ↔ referee). Dependency-free
  ESM, loaded by both runtimes.
- `referee.js` — the authoritative referee (see above). Browser-only in practice
  (the matchmaker never imports it).
- `config/` — **content as data**: `rules.json` (timers, speeds, ratios),
  `maps.json` (size, colors, spawns, prop placements), `props.json` (prop-type
  catalog). Adding maps/props needs no engine change.

## Movement convention (must stay in sync between referee & client prediction)

yaw about Y. forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
`vx = -sin*mz + cos*mx`, `vz = -cos*mz - sin*mx`, normalized if len>1, then
`pos += v * moveSpeed * dt`, clamped to `±(map.size/2 - mapMargin)`. Three.js
camera uses `YXZ` rotation order (yaw then pitch). Both `Referee.integrate` and
`main.js` frame loop use this exact formula — change both together. For the host,
reconciliation is a near-no-op (its authoritative pos tracks its prediction with
no round trip); guests still predict against real latency.

## Phase state machine (referee-owned, in `shared/referee.js`)

LOBBY → (host START, ≥minPlayers) → HIDING (hunters frozen) → HUNTING → ENDING
→ LOBBY. Timers via `phaseEndsAt`. Hunters win when all props eliminated; props
win if the hunt timer expires with any prop alive.

## Role/identity hiding

Snapshots expose `hunter: bool` (seekers are meant to be visible) and `disguise`
(the prop type a prop chose). They never expose which players are undisguised
props **to guests**. Own role comes via a private `ROLE` message. Two caveats,
both by design now: (1) the **host** holds the full state in its own tab, so it
can see undisguised props — an accepted cost of host authority; (2) an
undisguised prop still renders as a neutral capsule and so is visible while
moving — acceptable for the skeleton; see project-state open threads.
