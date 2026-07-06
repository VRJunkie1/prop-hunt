# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. The networking model is
**peer-to-peer over WebRTC** — players connect directly to each other; the room
creator's browser hosts the referee. Peer introduction (room codes + WebRTC
handshake) is done by **PeerJS's free public broker**; we run **no backend**. The
app is fully static and deploys to **Cloudflare Pages**.

## Status: DEPLOYABLE now (PeerJS swap done). Gameplay complete in code. STILL NOT PLAYTESTED.

Most recent session (2026-07, "BUILD IT" / deployability) removed the last thing
blocking deploy: the always-on Node matchmaker. Static Cloudflare Pages can't run
it, so nobody could ever connect. Swapped it for PeerJS's free public broker —
all client-side, no backend. This is the build half of the plan (steps 1–4);
steps 5–7 are the human playtest + tuning, which no code replaces. Details:
- **`net.js` rewritten on PeerJS** (`import { Peer } from esm.sh/peerjs`). Host
  claims peer id `prophunt-<CODE>` (retries on `unavailable-id` collision); guest
  `peer.connect`s to it with `reliable:true` + `serialization:'json'` + name in
  `metadata`. **All the host-authority wiring was deliberately carried over**: the
  loopback self-player with `host:true`, the per-guest bridge into the referee,
  and reliable+ordered delivery. Referee/rules/gameplay untouched.
- **Dead signaling swept out**: the `SIG` protocol block and dead `C2S.CREATE`/
  `C2S.JOIN` deleted from `shared/protocol.js`; the hand-rolled WebSocket + ICE
  buffering in `net.js` is gone (PeerJS does it). Old `ICE_SERVERS` → `PEER_CONFIG`.
- **`index.html` moved to the repo root** (static hosts serve it as the index);
  it references code by absolute path (`/client/...`, `/shared/...`, `/assets/...`).
  `client/` and `shared/` stay as subfolders — only a couple of path prefixes changed.
- **`package.json`** stripped of the `ws` dep + server scripts (nothing to run).
  **README** rewritten for the static/PeerJS/Cloudflare-Pages model.
- ⚠️ **Deletion blocked again**: this environment has NO file-deletion tool
  (confirmed via a subagent — the only shell tool errors "Stream closed"). So
  `server/` (index.js/Room.js/config.js) and the old `client/index.html` could
  not be `rm`'d. They're now **inert tombstones** (server files export nothing;
  `client/index.html` redirects to `/`) — harmless to the static deploy, but
  **`git rm -r server/ client/index.html` when a shell is available.**

### Earlier: Gameplay update (blindfold, jump, crouch, team lobby, round loop, aim-to-disguise, host map picker) implemented in code. NOT playtested.

Most recent session (2026-07, host map picker) added **host-only lobby map
selection** as groundwork for multiple maps (still one map today, so it's invisible
until a second is added to `maps.json`). No matchmaker change — all in the host
referee + client. Details:
- **Referee learns who the host is**: `net.js` `_becomeHost` adds its loopback
  player with `host: true`; `referee.addPlayer` sets `hostId` from that flag
  (falls back to first-added). Single source of truth for host-only actions.
- **`referee.mapId` is the selected map** (defaults to first map). New
  `C2S.PICK_MAP {mapId}` gated by host + LOBBY phase + id-exists, silently dropped
  otherwise. `broadcastLobby` now carries `mapId`.
- **One carrier rule**: `S2C.LOBBY.mapId` is the SOLE source of the choice; clients
  remember it (`state.selectedMapId`) and build the scene from it at match start.
  `S2C.STARTED` **no longer sends mapId** (was a second copy → desync risk).
- **UI**: `ui.renderMaps` lists maps (name + size), marks the selected one for all,
  host rows clickable / guest rows `locked`. `.maps-panel` in `index.html`,
  `.map-*` styles in `style.css`, click delegated in `main.js`.
- **Rename**: "Start match" → "Start game". Full detail: `memory/notes/map-selection.md`.

Earlier session (2026-07, aim-to-disguise) made disguise **aim-based instead
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
- [1] **Matchmaker** (`server/index.js`): HTTP static + WebRTC signaling relay.
      **SUPERSEDED** — replaced by PeerJS's public broker this session; the file
      is now a tombstone.
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
- [6] **Connection fallback**: free public **STUN** (now in `PEER_CONFIG`, handed
      to PeerJS). TURN relay for strict NATs is an explicit **NO-GO / not
      configured** (see below).
- [7] **Host lifecycle**: creator is the referee; host leaving ends the match and
      returns everyone to the menu. Host migration deferred.
- [8] Architecture notes updated (authority reversal recorded; see
      architecture.md).

## Open threads / not done — READ BEFORE BUILDING ON THIS

- [9] **NEVER PLAYTESTED — this is the load-bearing gap, and now the ONLY thing
      between here and a real game.** The whole design rests on "P2P connections
      actually form across real home networks" — now via PeerJS's broker + public
      STUN. Not verifiable in this env (no browsers/network). **Do this next
      (plan step 5):** two *different* homes, deliberately including one fussy
      network (phone hotspot / strict router). Two tabs on one machine is NOT a
      valid test (loopback). Checklist edge cases: disguise while crouched,
      mid-jump, at max range; the map picker.
- [DEPLOY — plan step 4] Not done from here (no Cloudflare access). Point
      Cloudflare Pages at the repo, **no build command, output dir = repo root**.
      Confirm: page loads, Create gives a code, a second browser Joins. See README.
- [TURN go/no-go — plan step 7a] Without a paid TURN relay, strict/symmetric-NAT
      players simply can't join. Currently NO-GO. If playtest [9] shows failures,
      the decision is whether to run/pay for a TURN server — now a `turn:` entry
      in **`PEER_CONFIG.iceServers`** in `net.js` (the old `ICE_SERVERS` is gone).
      Ongoing operational cost, so it's a group decision.
- **Tombstoned files to physically `git rm` when a shell is available:** the whole
      `server/` dir (`index.js` now also a tombstone after the PeerJS swap,
      `Room.js`, `config.js`) and `client/index.html` (moved to repo root). All
      inert — nothing imports/serves them — but they should be removed. This
      environment has **no file-deletion tool** (confirmed via subagent: the only
      shell tool fails with "Stream closed"), which is why they persist.
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
- Single map (`circus_lot`). **Host map-picker UI now exists** (lobby list,
      host-only selection); adding a real second map is data-only (add to
      `maps.json`) and the picker/referee pick it up automatically. See
      `memory/notes/map-selection.md`. Picker itself NOT playtested.
- **Reconnection/host migration**: none. If the host drops, the match is over.

## Key decisions

- **P2P WebRTC, host-authoritative** — this REVERSED the earlier
      server-authoritative / "do not move authority to clients" directive, on
      Manny's instruction. Full rationale + trade-offs in architecture.md. It was
      a product decision, not a technical necessity; a future session may revisit.
- **No backend of ours at all.** Browsers still need a rendezvous, but that's
      now PeerJS's free public broker (third-party, shared, best-effort) instead
      of a matchmaker we host. Trade recorded in architecture.md.
- Movement math is duplicated (referee + client prediction) **on purpose** and
      must stay identical — see architecture.md.
- Roles hidden via snapshot shape (`hunter`/`disguise` only) — but the host tab
      still holds everything (see anti-cheat note).
- Theme: colorful circus (art in `assets/`, used on the menu screen).

## Where things live

Site entry: `index.html` (repo ROOT). Referee (host browser): `shared/referee.js`.
Peer introduction: PeerJS public broker (no file of ours; used in
`client/js/net.js`). Protocol: `shared/protocol.js` (C2S/S2C only). Network layer:
`client/js/net.js`. Tunables: `shared/config/rules.json`. Maps:
`shared/config/maps.json`. Client entry: `client/js/main.js`. Lobby UI:
`client/js/ui.js`. Notes: `memory/notes/` (netcode, game-loop, disguise,
map-selection). `server/` = tombstones only (delete when a shell exists).
