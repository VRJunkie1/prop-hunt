# netcode

## Transport
WebSocket only. Client (`net.js`) connects to `location.host` with `ws://` or
`wss://` chosen from the page protocol — i.e. the same origin that served the
page. The server (`server/index.js`) runs `WebSocketServer({ server })` on the
*same* http.Server, so one port does static + realtime. This is what keeps the
"connect outward, no port forward" property: there's exactly one public endpoint.

## Message protocol (`shared/protocol.js`)
Single JSON object per message, discriminated by `t`.

Client → Server (`C2S`): `create{name}`, `join{name,room}`, `ready{ready}`,
`start{}`, `input{mx,mz,yaw,pitch}`, `disguise{propId}`, `tag{}`.

Server → Client (`S2C`):
- `joined{id,room,host}` — your player id.
- `lobby{room,hostId,players[],phase}` — lobby list; also how the client learns
  it's back in LOBBY (snapshots are NOT sent during lobby).
- `started{mapId,props[]}` — authoritative prop instances for the match. Client
  renders these; shapes come from `props.json` catalog it already fetched.
- `role{role}` — private; the only place a client learns its own role.
- `snapshot{phase,timeLeft,propsAlive,propsTotal,players[]}` — sent at
  `rules.snapshotRate` during a match. Player entry:
  `{id,name,x,z,yaw,alive,hunter,disguise}`. Positions rounded to cut bytes.
- `event{kind,...}` — discrete: `phase`, `eliminated`, `miss`, `disguised`,
  `roundOver`.
- `error{msg}`.

## Authority & trust
Server integrates all movement and judges disguise range + tag hits. Client input
is clamped server-side (`mx/mz` to [-1,1], `pitch` bounded). Nothing a client
sends is trusted for outcomes — the aim-cone tag check runs entirely on the
server from server-held positions/orientations.

## Client-side prediction
`main.js` predicts only the *local* player: integrate own movement each frame
using the same formula as the server, then reconcile toward `serverSelf` at
0.08/frame. First snapshot of a match snaps the camera to the spawn
(`state.spawned`). Other players are interpolated toward their latest snapshot
position at 0.25/frame in `scene.interpolate`. No rollback, no input buffering —
keep it simple; add if jitter becomes a problem.

## Rates
`tickRate` 30 Hz (sim), `snapshotRate` 15 Hz (broadcast), client INPUT send 20 Hz
(hardcoded in `main.js` startInputLoop — consider moving to rules.json later).

## Gotchas for future sessions
- Movement formula is duplicated client+server and MUST match (see
  architecture.md "Movement convention").
- STARTED, ROLE, and the first SNAPSHOT can arrive close together; ROLE is sent
  per-player *before* the STARTED broadcast in `startMatch`. Client handlers are
  written to be order-tolerant, but don't assume STARTED arrives first.
