# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. As of the P2P rebuild the
networking model is **peer-to-peer over WebRTC** — players connect directly to
each other; the room creator's browser hosts the referee. A tiny Node
**matchmaker** only mints room codes and relays the WebRTC handshake.

## Status: P2P rebuild implemented in code (plan steps 1–8). NOT playtested.

The networking core was rewritten this session. All game rules/content are
unchanged — only where the referee runs and how messages travel changed.

Implemented:
- [1] **Matchmaker** (`server/index.js`): HTTP static + WebRTC signaling relay
      (room codes, create/join, `SIG.RELAY` handshake, host/peer disconnect
      notices). No game logic/state.
- [2] **Referee ported to the browser** (`shared/referee.js`): the old
      `server/Room.js` logic (phases, movement, tags, disguises, wins), with
      config injected, per-player `send` callbacks, and a `setInterval` tick.
- [3] **Dual-mode network layer** (`client/js/net.js` `Session`): signaling
      WebSocket + WebRTC; host runs the referee + a local loopback for its own
      client + a bridge from each guest's data channel; guest opens one channel
      to the host. `main.js` is identical for host and guest.
- [4] **Reliable + ordered channels** by explicit config
      (`createDataChannel('game', {ordered:true})`); ICE buffered until SDP set.
- [5] **Host self-referee loop** resolved: host inputs go through the loopback
      like everyone else; the reconcile-toward-authoritative nudge is a near-no-op
      for the host (no round trip). Movement math kept identical for guests.
- [6] **Connection fallback**: free public **STUN** in `ICE_SERVERS`. TURN relay
      for strict NATs is an explicit **NO-GO / not configured** (see below).
- [7] **Host lifecycle**: creator is the referee; host leaving ends the match and
      returns everyone to the menu. Host migration deferred.
- [8] Architecture notes updated (authority reversal recorded; see
      architecture.md).

## Open threads / not done — READ BEFORE BUILDING ON THIS

- [9] **NEVER PLAYTESTED — this is the load-bearing gap.** The whole rebuild
      rests on "P2P connections actually form across real home networks." Not
      verified here (no browsers/network in this env). **Do this next:** two
      *different* homes, deliberately including one strict-NAT setup. Two tabs on
      one machine is NOT a valid test (it uses loopback).
- [TURN go/no-go] Without a paid TURN relay, strict/symmetric-NAT players simply
      can't join. Currently NO-GO. If playtest [9] shows failures, the decision is
      whether to run/pay for a TURN server (add a `turn:` entry to `ICE_SERVERS`
      in `net.js`). This is an ongoing operational cost, not just build time.
- **Tombstoned files to physically delete when a shell is available:**
      `server/Room.js` and `server/config.js` are now obsolete stubs (logic moved
      to `shared/referee.js`; matchmaker needs no config). They export nothing and
      nothing imports them. `git rm` both. (Couldn't delete this session — no
      shell/Bash tool available.)
- **Anti-cheat given up.** The host holds full unfiltered state (can see
      undisguised props / tamper). Accepted cost of host authority; no neutral
      referee anymore. See architecture.md.
- **Undisguised props are visible** (render as neutral capsules and move). Fine
      for skeleton; future: auto-disguise at hunt start, or hide/lock undisguised
      props.
- No client-side prediction of collisions; players can overlap props/walls
      (walls are visual; the referee only clamps to map bounds).
- `ready` flag exists in lobby but host can start regardless — intentional.
- Single map (`circus_lot`); map selection UI not built. Adding maps is data-only.
- **Reconnection/host migration**: none. If the host drops, the match is over.

## Key decisions

- **P2P WebRTC, host-authoritative** — this REVERSED the earlier
      server-authoritative / "do not move authority to clients" directive, on
      Manny's instruction. Full rationale + trade-offs in architecture.md. It was
      a product decision, not a technical necessity; a future session may revisit.
- Matchmaker is the only always-on piece and holds no game state. "No server"
      isn't literally achievable (browsers need a rendezvous), but it's now tiny.
- Movement math is duplicated (referee + client prediction) **on purpose** and
      must stay identical — see architecture.md.
- Roles hidden via snapshot shape (`hunter`/`disguise` only) — but the host tab
      still holds everything (see anti-cheat note).
- Theme: colorful circus (art in `assets/`, used on the menu screen).

## Where things live

Referee (host browser): `shared/referee.js`. Matchmaker: `server/index.js`.
Protocol: `shared/protocol.js` (SIG + C2S/S2C). Network layer: `client/js/net.js`.
Tunables: `shared/config/rules.json`. Client entry: `client/js/main.js`. Notes:
`memory/notes/` (netcode, game-loop).
