# prop-hunt — architecture ground truth

Updated by dev sessions whenever a change alters the design.

## Shape

Browser client + one authoritative Node server. Single process serves both the
static client (HTTP) and the game (WebSocket) on the same port.

```
client (browser)  --WebSocket-->  server (referee)
  Three.js render                   owns true game state
  sends INTENT only                 decides ALL outcomes
  predicts self locally             broadcasts snapshots
```

## The load-bearing decision: server-authoritative, client connects outward

Players never host. Every client opens an **outbound** WebSocket to the shared
server, which works through any home router → **no port forwarding**. The same
server is the **referee**: it holds authoritative state and judges every action
(movement integration, disguise validity, tag hits, win conditions). Clients are
untrusted; they send intent and render snapshots. This one choice covers both the
networking goal and (later) most anti-cheat. Do not move authority to clients.

## Server (`server/`)

- `index.js` — HTTP static file server (serves `client/`, `/shared/`, `/assets/`)
  + `ws` WebSocketServer on the same port + a room manager (`rooms` Map, 4-char
  codes from an unambiguous alphabet). Routes CREATE/JOIN itself; everything else
  goes to the player's `Room`.
- `Room.js` — **one lobby + one match + its referee.** Runs a fixed-rate tick
  (`setInterval`, `rules.tickRate`). Integrates movement, drives the phase state
  machine, judges tags/disguises, broadcasts snapshots at `rules.snapshotRate`.
- `config.js` — loads `shared/config/*.json`.

## Client (`client/`)

No build step. Three.js loaded from CDN via `<script type="importmap">`.

- `main.js` — glue + render loop + light client-side prediction for the local
  player (integrates own movement each frame, reconciles toward the server pos at
  0.08/frame). Sends INPUT at 20 Hz.
- `net.js` — WebSocket wrapper; picks `ws`/`wss` from page protocol, connects to
  `location.host` (same origin that served the page).
- `input.js` — WASD + pointer-lock mouse look; emits action events.
- `scene.js` — all Three.js. Builds world from config, reconciles player meshes
  to snapshots, interpolates others, first-person camera for self.
- `ui.js` — DOM screens (menu/lobby/game), HUD, feed. No game logic.
- `config.js` — fetches the same `shared/config` the server uses.

## Shared (`shared/`)

- `protocol.js` — `C2S`, `S2C`, `PHASE`, `ROLE` constants. Imported by both
  runtimes unchanged (server: relative path; client: served at `/shared/`).
- `config/` — **content as data**: `rules.json` (timers, speeds, ratios),
  `maps.json` (size, colors, spawns, prop placements), `props.json` (prop-type
  catalog: shape + dimensions + color). Adding maps/props needs no engine change.

## Movement convention (must stay in sync between client & server)

yaw about Y. forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
`vx = -sin*mz + cos*mx`, `vz = -cos*mz - sin*mx`, normalized if len>1, then
`pos += v * moveSpeed * dt`, clamped to `±(map.size/2 - mapMargin)`. Three.js
camera uses `YXZ` rotation order (yaw then pitch). Both `Room.integrate` and
`main.js` frame loop use this exact formula — change both together.

## Phase state machine (server-owned, in Room)

LOBBY → (host START, ≥minPlayers) → HIDING (hunters frozen) → HUNTING → ENDING
→ LOBBY. Timers via `phaseEndsAt`. Hunters win when all props eliminated; props
win if the hunt timer expires with any prop alive.

## Role/identity hiding

Snapshots expose `hunter: bool` (seekers are meant to be visible) and `disguise`
(the prop type a prop chose). They never expose which players are undisguised
props. Own role comes via a private `ROLE` message. Known skeleton gap: an
undisguised prop still renders as a neutral capsule and so is visible while
moving — acceptable for the skeleton; see project-state open threads.
