# netcode

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
- Guest: `conn.on('close')` → "Host left — the match ended." → teardown.
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
