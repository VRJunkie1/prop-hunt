# netcode

## Two layers since the P2P rebuild
1. **Signaling** — a WebSocket from each client to the matchmaker
   (`server/index.js`). Used ONLY to mint/join a room and relay the WebRTC
   handshake. No gameplay ever crosses it.
2. **Game transport** — an `RTCDataChannel` from each guest to the host, OR (for
   the host's own client) a local loopback. The referee (`shared/referee.js`)
   runs in the host's tab and speaks the unchanged C2S/S2C protocol over whichever
   transport a given player has.

All of this lives behind `client/js/net.js` (`Session`). `main.js` only calls
`session.create/join/send`, reads `session.ready`, and sets `session.onMessage`
/ `session.onStatus`. It cannot tell host from guest — by design (plan step 3).

## Signaling protocol (`SIG` in `shared/protocol.js`)
Client → matchmaker: `sig-create{name}`, `sig-join{name,room}`,
`sig-relay{to,payload}`.
Matchmaker → client: `sig-created{room,id}` (you're host), `sig-joined{room,id,
hostId}` (you're a guest), `sig-peer-join{id,name}` (to host: new guest inbound),
`sig-relay{from,payload}`, `sig-peer-left{id}`, `sig-host-left{}`, `sig-error{msg}`.
`payload` is an opaque WebRTC blob: `{sdp}` (offer/answer) or `{ice}` (candidate).
`id` doubles as the game player id, so ids thread through both layers.

## WebRTC handshake (who does what)
- Guest joins → matchmaker replies `sig-joined` to the guest AND `sig-peer-join`
  to the host.
- **Host is the offerer.** On `sig-peer-join` it creates the `RTCPeerConnection`,
  creates the data channel (`createDataChannel('game', {ordered:true})`), makes an
  offer, and relays it. Guest answers. ICE candidates relay both ways.
- Data channels are **reliable + ordered by explicit config** (`{ordered:true}`,
  no `maxRetransmits`/`maxPacketLifeTime`). WebRTC defaults to neither; the
  match-start ordering (STARTED/ROLE/first SNAPSHOT) depends on this (plan step 4).
- ICE candidates are **buffered until the remote description is set**, then
  flushed — candidates can outrun the SDP.
- The host bridges a guest into the referee on `channel.onopen`
  (`referee.addPlayer`) and out on `channel.onclose`/pc `failed`
  (`referee.removePlayer`). Channel close — not the signaling socket — is the
  authoritative "player left" signal.

## Game protocol (`C2S`/`S2C`) — UNCHANGED by the rebuild
Same message shapes as the old server model; only the pipe changed. See the
protocol file for the full list (create/join are gone from C2S — they're SIG now).
Snapshot player entry: `{id,name,x,y,z,yaw,alive,crouch,hunter,disguise}`,
positions rounded (`y` = jump height, `crouch` bool for the squash + hitbox).
`hunter`/`disguise` are the only role leakage to guests.
INPUT now carries `{mx,mz,yaw,pitch,jump,crouch}` (jump/crouch held-state bools).
`READY` is gone — replaced by `PICK_TEAM {team:'hunter'|'prop'|null}`; LOBBY now
carries `players:[{id,name,team}]` + `canStart`.

### Per-recipient snapshots (blindfold)
`broadcastSnapshot` no longer sends one identical message to all. It builds the
full player list once, then `send()`s each player their own view: a **hunter
during HIDING receives only themselves** (the data half of the blindfold);
everyone else gets the full list. Keep this per-recipient loop if you touch
snapshot code.

## Host authority & the loopback
The host's own client sends C2S straight into the referee
(`referee.handleMessage(selfId, msg)`) and the referee replies via a callback
that calls `session.onMessage` — a zero-latency loopback that behaves exactly
like the wire. **Verify when touching this:** the host's reconcile-toward-
authoritative nudge in `main.js` (0.08/frame) converges to a near-no-op because
its authoritative position tracks its prediction with no round trip. Guests still
predict against real latency — keep the movement math identical for both.

Trust: the host clamps every guest's `mx/mz`/`pitch` and judges all tags/disguises
from host-held positions. Guests are still untrusted for outcomes. But the HOST
itself is now authority — no neutral referee anymore (see architecture.md).

## Client-side prediction
`main.js` predicts only the *local* player: integrate own movement each frame
using the same formula as the referee, then reconcile toward `serverSelf` at
0.08/frame. First snapshot of a match snaps the camera to spawn (`state.spawned`).
Others interpolate toward latest snapshot at 0.25/frame. No rollback/input buffer.

## Rates
`tickRate` 30 Hz (sim), `snapshotRate` 15 Hz (broadcast), client INPUT send 20 Hz
(hardcoded in `main.js` startInputLoop).

## NAT traversal / connection reality (the migration's big risk)
`ICE_SERVERS` in `net.js` = free public STUN only. That covers most home NATs.
Strict/symmetric NATs need a **TURN relay** (paid, always-on, carries live
traffic) — currently **NO-GO / not configured**, so some players can't connect.
This is the claim the whole rebuild rests on and is **not yet playtested across
real networks** (see project-state). Add a `turn:` entry to `ICE_SERVERS` to
enable a relay.

## Gotchas for future sessions
- Movement formula is duplicated referee + client and MUST match (see
  architecture.md "Movement convention").
- STARTED, ROLE, and the first SNAPSHOT can arrive close together; ROLE is sent
  per-player *before* the STARTED broadcast in `startMatch`. The ordered channel
  now guarantees delivery order, but handlers stay order-tolerant anyway.
- A `Session` is single-use: it tears down peers + signaling when a match ends.
  `main.js` builds a fresh one via `newSession()` on return to menu.
- Two browser tabs on one machine connect fine via loopback/localhost STUN, but
  that does NOT test real NAT traversal — only two different homes does.
