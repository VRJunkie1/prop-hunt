# netcode

## Two layers (P2P over PeerJS)
1. **Peer introduction** — PeerJS's **free public broker** (0.peerjs.com). It
   mints/pairs peers by id and relays the WebRTC handshake (SDP + ICE). We run
   NOTHING for this and there is no signaling protocol of ours. PeerJS handles it
   internally; `net.js` only uses the PeerJS client API.
2. **Game transport** — a PeerJS `DataConnection` from each guest to the host, OR
   (for the host's own client) a local loopback. The referee
   (`shared/referee.js`) runs in the host's tab and speaks the unchanged C2S/S2C
   protocol over whichever transport a given player has.

All of this lives behind `client/js/net.js` (`Session`). `main.js` only calls
`session.create/join/send`, reads `session.ready`, and sets `session.onMessage`
/ `session.onStatus`. It cannot tell host from guest — by design.

## How PeerJS is loaded (do NOT re-ESM-import it)
PeerJS is pulled in as a **self-contained UMD `<script>` tag in `index.html`**
(`https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js`) that exposes a
`Peer` global; `net.js` reads it via `const Peer = window.Peer` (the classic
script runs before the deferred module, so it's defined in time). This is
deliberate and load-bearing for the automated **headless load check**: the old
`import { Peer } from 'https://esm.sh/peerjs@1.5.4'` was a two-request esm.sh
wrapper/redirect chain (top URL re-exports from a sub-path) that failed the check
with `net::ERR_FAILED` — the EXACT same failure mode three.js hit before it moved
to a single jsDelivr build file. PeerJS can't be a zero-import ESM file (it has
bundled runtime deps), so the UMD build (all deps inlined, single request, no
sub-requests) is the robust choice — and it's peerjs.com's own documented CDN
usage. If you ever switch back to an ESM import, re-run the headless load check.

## Room codes & connecting (PeerJS)
- **Room id = `prophunt-<CODE>`** on the shared public broker. The 4-char CODE
  (unambiguous alphabet, minted client-side in `net.js` `makeCode`) is the only
  thing players exchange. The `prophunt-` prefix namespaces us off other PeerJS
  apps that share the broker.
- **Host** does `new Peer('prophunt-<CODE>')`. If the id is taken, PeerJS fires
  error `unavailable-id` and `net.js` retries with a fresh code (up to 6×).
- **Guest** does `new Peer()` (broker assigns a random id) then
  `peer.connect('prophunt-<CODE>', { reliable:true, serialization:'json',
  metadata:{name} })`. A bad code → PeerJS error `peer-unavailable` → surfaced as
  "Room not found".
- A peer's id **doubles as its game player id** (host id = the room id; each guest
  = its random PeerJS id), so ids thread straight into the referee.
- Connections are **reliable + ordered** (`reliable:true` — PeerJS's reliable
  channels are ordered). The match-start ordering (STARTED/ROLE/first SNAPSHOT)
  depends on this. `serialization:'json'` ships plain objects both ways, so
  `send(obj)` / `on('data', obj)` need no manual JSON.parse/stringify.
- The host bridges a guest into the referee on the connection's `open`
  (`referee.addPlayer`, reading the guest name from `conn.metadata`) and out on
  `close`/`error` (`referee.removePlayer`). **DataConnection `close` — not any
  broker event — is the authoritative "player left"/"host left" signal.**

## Game protocol (`C2S`/`S2C`) — UNCHANGED across both rebuilds
Same message shapes as the old server model; only the pipe changed. `C2S.CREATE`
/`C2S.JOIN` no longer exist (they were already dead after the P2P rebuild;
connecting is now entirely PeerJS's job, in `net.js`).
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
`PEER_CONFIG.iceServers` in `net.js` (the successor to the old `ICE_SERVERS`) =
free public STUN only, handed to PeerJS. That covers most home NATs.
Strict/symmetric NATs need a **TURN relay** (paid, always-on, carries live
traffic) — currently **NO-GO / not configured**, so some players can't connect.
This is the claim the whole design rests on and is **not yet playtested across
real networks** (see project-state). Add a `turn:` entry to
`PEER_CONFIG.iceServers` to enable a relay.

## Gotchas for future sessions
- Movement formula is duplicated referee + client and MUST match (see
  architecture.md "Movement convention").
- STARTED, ROLE, and the first SNAPSHOT can arrive close together; ROLE is sent
  per-player *before* the STARTED broadcast in `startMatch`. The ordered channel
  now guarantees delivery order, but handlers stay order-tolerant anyway.
- A `Session` is single-use: it destroys its PeerJS `Peer` (which closes every
  connection under it and unregisters the room id from the broker) when a match
  ends. `main.js` builds a fresh one via `newSession()` on return to menu.
- Two browser tabs on one machine connect fine via loopback/localhost STUN, but
  that does NOT test real NAT traversal — only two different homes does.
