# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. As of the P2P rebuild the
networking model is **peer-to-peer over WebRTC** — players connect directly to
each other; the room creator's browser hosts the referee. A tiny Node
**matchmaker** only mints room codes and relays the WebRTC handshake.

## Status: Gameplay update (blindfold, jump, crouch, team lobby, round loop, aim-to-disguise) implemented in code. NOT playtested.

Most recent session (2026-07, aim-to-disguise) made disguise **aim-based instead
of proximity-based** — a prop now disguises as the prop under its crosshair, not
the nearest one. No server change (all in the host referee + client). Details:
- **Stable prop ids** in `maps.json` (`id` per placement); referee `beginRound`
  builds `this.props` from them (dropped the runtime `nextPropId` counter). Ids
  are the shared language between client scene and referee.
- **Client raycast** (`scene.propUnderCrosshair`, `THREE.Raycaster` from crosshair,
  first hit within `disguiseRange` = occlusion for free). `main.js` `tryDisguise`
  sends `{ propId }`; `updateDisguiseTarget` highlights the mesh (`highlightProp`)
  + shows a hint (`ui.setTargetHint`, new `#targetHint` DOM/CSS).
- **Referee** `applyDisguise` re-checks loosely: range + yaw cone
  (`disguiseAngleDeg`) + crouch-aware vertical gate (`disguiseVertPad`, via new
  `propHeight` helper reusing the tag gate's `eyeHeight`). Client-strict /
  referee-loose asymmetry is intentional — see `memory/notes/disguise.md`.
- New tunables: `disguiseAngleDeg` 45, `disguiseVertPad` 1.0 in `rules.json`.

Earlier session (2026-07, "clank" task) added, on top of the P2P rebuild —
all rule changes live in the host's referee, no server change:
- **Hunter blindfold during HIDING** — data (referee sends hunters only
  themselves in the snapshot) + screen (black 🙈 overlay w/ countdown,
  `ui.setBlindfold`). `shared/referee.js` `broadcastSnapshot`; `main.js`
  `updateBlindfold`.
- **Jump** (Space) + **crouch** (Ctrl/C): vertical `pos.y`+gravity and crouch
  speed/eye-height/hitbox, added identically in `Referee.integrate` and `main.js`
  frame loop. Tag became a 3D ray gate so crouch/jump affect it. New tunables in
  `rules.json` (gravity, jumpSpeed, crouch*, stand*/tag vert pad). **Tag rebind:
  Space→jump, so tag is now F / left-click only.**
- **Lobby team pickers** replace the Ready button — two columns (Hunters left,
  Props right), click to join, names move live. `C2S.PICK_TEAM`; referee owns
  `canStart`. `index.html` + `ui.js` `renderLobby` + `style.css`.
- **Round loop**: ENDING → next round with **teams swapped** (`nextRoundOrLobby`
  / `computeSwappedTeams`), staying in-game. Lobby only on host-leave or a team
  emptying (`bailIfTeamEmpty`, one `removePlayer` path). Round one uses picked
  teams (`hunterRatio` now unused).

### Earlier: P2P rebuild (plan steps 1–8). Also NOT playtested.
The networking core was rewritten. All game rules/content were unchanged then —
only where the referee runs and how messages travel changed.

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
      (walls are visual; the referee only clamps to map bounds). Jump has no
      ceiling/roof logic either — you just arc back to y=0.
- **Controls are keyboard-only.** No touch controls exist at all (mouse-look +
      WASD + Space/Ctrl). Prop hunt is unplayable on phones today; a mobile layer
      (virtual joystick, look-drag, on-screen jump/crouch/tag buttons) is a real
      separate project — not started.
- **Crouch tag tuning is untested feel.** `tagVertPad` 0.35 makes a level-aiming
      hunter miss a crouched prop at close range but still tag standing/jumping
      ones. Numbers are a first guess — verify in playtest, tune in `rules.json`.
- **Aim-to-disguise not playtested / untested feel.** `disguiseAngleDeg` 45 and
      `disguiseVertPad` 1.0 are first guesses for the referee's loose facing gate;
      the client ray is exact. Playtest the edge cases where "valid on my screen"
      and "referee says yes" could drift: disguise while crouched, mid-jump, aiming
      at a prop partly behind another, and right at the range limit. Tune in
      `rules.json`. Note: the client ray currently ignores walls/other players as
      occluders (tests static props only) — acceptable, matches "first prop hit".
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
