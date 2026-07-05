# prop-hunt — architecture ground truth

Updated by dev sessions whenever a change alters the design.

## Shape

The whole thing is a **static site** (no server of ours, no build step). Browser
clients play **peer-to-peer over WebRTC**. The room creator's browser is the
**host**: it runs the referee (authoritative game state) in-tab. Browsers find
each other through **PeerJS's free public broker** (a third-party shared
rendezvous service) — it relays the WebRTC handshake only, holds no game state,
and sees no gameplay.

```
guest browser  --PeerJS DataConnection-->  HOST browser (referee)
  Three.js render                            owns true game state
  sends INTENT only                          decides ALL outcomes
  predicts self locally                      broadcasts snapshots
                                             host's OWN client talks to the
                                             referee via a local loopback
        \                                   /
         \  --PeerJS public broker---------/
          third-party: relays WebRTC offer/answer/ICE only (no server of ours)
```

Host generates a 4-char room code client-side; the PeerJS peer id is
`prophunt-<CODE>`. Guests connect to that id (typed code, or clicked `#CODE`
invite link).

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
  most home NATs; strict/symmetric NATs need a **TURN relay** to connect. This is
  now **CONFIGURED** — `ICE_SERVERS` in `js/net.js` carries TURN entries (OpenRelay
  free public relay) so those players relay through TURN. Direct links stay the
  first choice (`iceTransportPolicy` left at default `'all'`), so the relay is
  fallback-only. Trade-offs: it's a *shared* community relay with a modest free
  quota (swap for your own account creds for a dedicated one), and the relay
  password necessarily ships in the public client code (accepted — only risk is
  quota drain). Still the biggest thing to playtest (see project-state [9]).
- **Cost — depends on shared third-party services.** Browsers can't find each
  other unaided. Since the static-Pages fix (2026-07) we no longer run our own
  matchmaker at all — the WebRTC handshake goes through **PeerJS's free public
  broker**, and strict NATs relay through the **free public TURN**. "No server"
  is now literally true *for us*, but we lean on two shared community services;
  if either has a bad day, joining hiccups until retry. Fine for 2–8 friends.
- **Cost — anti-cheat given up.** The host's browser holds the full unfiltered
  state (including who's an undisguised prop). A determined host can inspect or
  tamper with it. Guests still get filtered snapshots; guest *input* is still
  clamped/judged by the host. There is no longer a neutral referee.
- **Benefit — no central game server to run/pay for during play.** Live traffic
  is peer-to-peer; the matchmaker is cheap and idle-friendly.

If a future session considers moving back, that's a legitimate call — this
reversal was a product decision, not a technical necessity.

## Signaling (PeerJS public broker) — REPLACED the Node matchmaker 2026-07

There is no `server/` anymore (it's tombstoned; see project-state). Cloudflare
Pages serves static files only, so a Node matchmaker can't run there — the deploy
404'd on the old nested layout. The fix: flatten to the repo root and swap
signaling to **PeerJS's free public broker**.

- **Host** creates a `Peer` with a fixed id `prophunt-<CODE>` (4-char code minted
  client-side). If the id is taken (`unavailable-id`), it retries with a new code.
- **Guest** creates an anonymous `Peer`, then `peer.connect('prophunt-<CODE>',
  {reliable:true, metadata:{name}})`. `peer-unavailable` == no such room.
- The broker only carries the WebRTC handshake; once the DataConnection opens, all
  gameplay is peer-to-peer and the broker is idle. **No game logic, no state.**
- Join/leave are PeerJS events now, not matchmaker messages: `conn.on('close')`
  is the authoritative "player left" (host drops the peer; guest ends the match).

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

## Client (repo root: `index.html`, `js/`, `css/`)

No build step. Served from the repo **root** (flattened 2026-07 so static Pages
finds `index.html`). Three.js **and PeerJS** load from CDN (jsDelivr) — Three via
the HTML importmap, PeerJS via a direct `/+esm` import in `js/net.js`. (Both were
on unpkg/esm.sh; moved to jsDelivr's prebuilt ESM after esm.sh's runtime transpile
failed a headless page load — see netcode.md.) All internal refs are root-absolute
(`/js/…`, `/css/…`, `/shared/…`, `/assets/…`).

- `js/main.js` — glue + render loop + light client-side prediction for the local
  player (integrates own movement each frame, reconciles toward the authoritative
  pos at 0.08/frame). Sends INPUT at 20 Hz via `session.send`. Identical code for
  host and guest. Also: **join-by-link** (`#CODE` in the URL auto-joins on boot)
  and the lobby "Copy invite link" button.
- `js/net.js` — the **dual-mode network layer** (`Session`), now on **PeerJS**: a
  `Peer` to the public broker, plus either (host) an in-tab `Referee` + loopback
  link + a bridge from each guest's `DataConnection` into the referee, or (guest)
  one reliable `DataConnection` to the host. Channels are **reliable + ordered**
  via PeerJS's `{reliable:true}`. ICE servers (STUN **+ TURN relay**) are injected
  through the `Peer` `config` option. `detectRelayed()`/`_reportLink()` read
  `conn.peerConnection.getStats()` to tell the UI direct vs relayed. ~10s connect
  give-up timer preserved.
- `js/input.js` — WASD + pointer-lock mouse look; emits action events.
- `js/scene.js` — all Three.js. Builds world from config, reconciles player meshes
  to snapshots, interpolates others, first-person camera for self.
- `js/ui.js` — DOM screens (menu/lobby/game), HUD, feed. No game logic. Paints a
  `direct`/`relayed` diagnostic badge per lobby row from `setLink()` — the
  connection-type is *detected* in `net.js`, never here.
- `js/config.js` — fetches `shared/config`; the host passes it into the `Referee`.

## Shared (`shared/`)

- `protocol.js` — **one protocol** now: `C2S`/`S2C`/`PHASE`/`ROLE` (client ↔
  referee). Dependency-free ESM. (The old `SIG` matchmaker-signaling protocol was
  deleted with the matchmaker; PeerJS's own connect/disconnect events replace it.)
- `referee.js` — the authoritative referee (see above). Browser-only, transport-
  agnostic (unchanged by the PeerJS swap — it only ever saw `send` callbacks).
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
