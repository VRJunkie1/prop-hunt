# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. It's a **static site**
(deployable to Cloudflare Pages — no server, no backend, no build step). Play is
**peer-to-peer over WebRTC**; the room creator's browser hosts the referee.
Browsers are introduced by **PeerJS's free public broker** (no matchmaker of
ours). Strict NATs relay through a free public TURN.

## Status: LOBBY MAP SELECTION BUILT (this session, on `vrmike/dev`).

The host can now pick the round's map from the lobby (two maps: `circus_lot` +
`toy_workshop`). One validation gate (`Referee.setMapId`), one new lobby message
(`C2S.PICK_MAP`), a data-driven picker UI, and the pick survives reset-to-lobby.
Full detail: `memory/notes/map-selection.md`. **Not yet playtested** (see the
map-selection checklist under Open threads).

**Why this was a "finish the broken build":** an earlier map-selection attempt
lived on branch **`jie/dev`** (commits "The lobby host should be able to see a list
of available maps to play" + "BUILD IT"). The active branch became `vrmike/dev`,
cut from a point *before* that work, so the partial build was stranded on `jie/dev`
and the working tree looked untouched ("someone broke it by renaming the channel"
= the branch switch). I could not reach `jie/dev`'s file contents (no shell; git
objects are compressed), so I reimplemented cleanly on `vrmike/dev` against the
seam the notes already named, per VRmike's approved plan. **If `jie/dev` is ever
pulled back, diff — do NOT blind-merge; this `vrmike/dev` version is intended.**

## Status: FIRST REAL P2P JOIN CONFIRMED. Earlier session: CDN deps made lazy so the headless load check is clean (no boot-time external fetches).

**2026-07 playtest update (VRmike):** the game launches and **two players joined a
lobby together** — first confirmation the PeerJS/WebRTC join path actually works
across the wire (partly closes gap [9]; a full round still unverified). One bug
found and fixed this session: the "Click to play" overlay never dismissed, so
mouse-look was dead (WASD still worked). See [I] below.

## Status: static-Pages deploy fix + PeerJS signaling done in code.

This session fixed the **broken Cloudflare Pages deploy**. Root cause: the P2P
rebuild left a Node matchmaker in `server/` and the game nested under `client/`.
Pages serves static files only (can't run the matchmaker) and serves from where
`index.html` sits, so the nested layout 404'd. Fix = flatten to the repo root +
retire the matchmaker in favour of PeerJS's public broker. Game rules/referee are
unchanged. **Not yet verified across real networks** — see the playtest gap [9].

### Done this session
- [A] **Flattened to the repo root.** `index.html`, `js/`, `css/` now sit at the
      root alongside `shared/` and `assets/`. All refs are root-absolute, so they
      survived the move. Pages: output dir = repo root, no build.
- [B] **Retired the Node matchmaker.** Signaling is now **PeerJS's free public
      broker**. No server of ours anywhere.
- [C] **Rewrote `js/net.js` onto PeerJS.** Host = `Peer('prophunt-<code>')`;
      guest = anonymous `Peer` + `peer.connect(..., {reliable:true,
      metadata:{name}})`. Reliable+ordered kept via `{reliable:true}`. ICE
      servers injected via the `Peer` `config` option (STUN + TURN preserved).
      Host bridges each guest `DataConnection` into the referee. Referee itself is
      transport-agnostic and was NOT touched.
- [D] **Join/leave now = PeerJS events** (`conn.on('close')`), replacing the old
      SIG host-left/peer-left messages. Deleted the `SIG` protocol and the dead
      `C2S.CREATE/JOIN` from `shared/protocol.js`.
- [E] **Direct/relayed lobby badge preserved** — detection now reads
      `conn.peerConnection.getStats()` (PeerJS exposes the RTCPeerConnection).
- [F] **Join-by-link**: `#CODE` in the URL auto-joins on boot; lobby has a
      "Copy invite link" button. See `main.js` `tryJoinFromHash` / `wireMenu`.
- [G] `package.json` trimmed to a static project (dropped `ws` + node scripts).
      README + all memory notes updated.

### Follow-up session (check-repair)
- [H] **CDN imports moved to jsDelivr** to clear two `net::ERR_FAILED` from the
      automated headless-load check. three.js (`index.html` importmap) and PeerJS
      (`js/net.js`) were the only two boot-time external fetches; esm.sh's runtime
      transpile in particular can cold-start/redirect slowly enough to fail a
      headless load. Now `https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js`
      and `.../peerjs@1.5.4/+esm` — prebuilt ESM, no build step. Broker/TURN
      services unchanged (this was the *library* download only).

### Follow-up session (check-repair — lazy CDN loading)
- [J] **Killed two boot-time `net::ERR_FAILED`s for good by lazy-loading the CDN
      deps.** The headless load check kept flagging the same two external fetches
      (three.js + PeerJS) even after [H] swapped esm.sh → jsDelivr. Root cause: the
      check runs with **no outbound network**, so *any* fetch during page-load
      fails — the CDN *provider* was never the problem, doing the fetch at boot
      was. Fix (small, in-lane):
      - `js/net.js`: removed the top-level `import { Peer }`. New `loadPeer()`
        dynamic-imports PeerJS once on the first `create()`/`join()`; `_startHost`/
        `_startGuest` are now `async` and `await` it (graceful onStatus error if the
        CDN is down).
      - `js/main.js`: removed the top-level `import { Scene3D }`. `scene` starts
        `null`; `ensureScene()` dynamic-imports `scene.js` (which pulls Three.js)
        on the first `STARTED`. All `scene.*` calls are guarded (`if (scene)`), and
        `setSelf` is re-applied when the scene finally builds.
      Result: a bare landing page makes **zero** external requests → the headless
      load is clean. Gameplay still pulls both libs from jsDelivr on demand (CDN
      import, no build step — constraint intact). `index.html` importmap unchanged
      (it declares, doesn't fetch). Details in `memory/notes/netcode.md`.

### Earlier session (mouse-capture fix)
- [I] **Fixed the stuck "Click to play" overlay** (pointer-lock never engaged).
      Root cause: `#clickToPlay` (`.overlay`, `position:absolute; inset:0`, no
      `pointer-events:none`) is painted **over** the canvas and swallowed the
      click, so `canvas`'s `click`→`requestPointerLock()` never fired; the overlay
      then stayed up forever (per-frame poll `!input.locked`). WASD worked because
      keys listen on `window`. Fix, keeping modules in lane:
      - `js/input.js` now takes a second arg `lockTrigger` (the overlay element)
        and requests capture on **its** click, not just the canvas's. It also
        listens for `pointerlockchange`/`pointerlockerror` and broadcasts
        `onLockChange(locked)` / `onLockError(reason)`.
      - `js/main.js` passes `ui.el.clickToPlay` as the trigger, wires the two
        callbacks to `ui.setClickToPlay(...)`, shows the overlay on match start,
        and **removed the per-frame poll**. Overlay now hides only when the browser
        *confirms* lock and reappears on release (Esc/alt-tab) — re-clickable.
      - `js/ui.js` `setClickToPlay(visible, msg?)` can show a refusal message; a
        `pointerlockerror` surfaces "browser blocked mouse capture…" instead of
        silence.
      - CSS: `.overlay` got `text-align/padding/line-height` so a long refusal
        message wraps cleanly.
      Details in `memory/notes/input-mouselook.md`. **Still needs a real 2-player
      re-test**: click through overlay → mouse-look works → Esc → overlay returns →
      re-click re-captures, as both host and guest.

## Open threads / not done — READ BEFORE BUILDING ON THIS

- [TOMBSTONES — physically delete when a shell is available.] I could **not**
      run mutating git/shell commands this session (the Monitor shell tool's
      permission stream failed on every write; read-only commands worked). So the
      flatten was done by **writing the canonical files at the root** and reducing
      the old `client/` and `server/` files to one-line **tombstone stubs**. They
      are dead (nothing loads them — the app is served from the root), but they
      should be removed for real:
      ```
      git rm -r client server
      ```
      Do this first thing next session if you have a shell. Everything canonical
      is at the root; `client/` and `server/` contain only stubs.
- [9] **NEVER PLAYTESTED — still the load-bearing gap, now bigger.** Two things
      are unverified across real networks: (a) the original P2P assumption that
      connections form across home NATs, and (b) the NEW PeerJS wiring. **Do this
      next:** deploy to Pages, open on two computers on *different* networks,
      create a room, **join via the invite link**, play a full round (hide →
      hunt → win screen → back to lobby), and check the direct/relayed badge.
      Include a strict-NAT setup if possible — with TURN configured that player
      should succeed via relay (badge reads `relayed`). Two tabs on one machine is
      NOT a valid test (loopback).
- [PeerJS/TURN are shared free services.] The broker (PeerJS cloud) and TURN
      (OpenRelay) are community services with modest quotas. Fine for 2–8 friends;
      if joining hiccups, suspect a service before the code. For a dedicated TURN
      quota, swap the three `turn:` entries in `js/net.js` for your own
      Metered/OpenRelay creds. The relay password ships in client code
      (unavoidable, backend-less) — only risk is quota drain.
- **Phones out of scope (deliberate).** Controls are keyboard + mouse-look, so
      it's desktop-only regardless of the deploy. Real touch controls are a
      separate project.
- **Anti-cheat given up.** The host holds full unfiltered state (can see
      undisguised props / tamper). Accepted cost of host authority; no neutral
      referee. See architecture.md.
- **Undisguised props are visible** (render as neutral capsules and move). Fine
      for skeleton; future: auto-disguise at hunt start, or hide undisguised props.
- No client-side prediction of collisions; players can overlap props/walls.
- `ready` flag exists in lobby but host can start regardless — intentional.
- **Map selection: BUILT this session** (host picks from the lobby; `circus_lot`
  + `toy_workshop`). Adding more maps stays data-only. **Playtest still owed:**
  host picks a non-default map → everyone spawns in it; a late lobby joiner sees
  the current selection; a non-host's pick attempt is ignored; disguise + tag work
  on the second map; after a reset-to-lobby the pick survives. See
  `memory/notes/map-selection.md`.
- **Reconnection/host migration**: none. If the host drops, the match is over.

## Key decisions

- **Static site + PeerJS public broker** (this session) — the way to keep P2P
      WebRTC with no server of ours, deployable to Cloudflare Pages. Trade-off:
      depends on shared free services (broker + TURN). See architecture.md.
- **P2P WebRTC, host-authoritative** — REVERSED the earlier server-authoritative
      / "do not move authority to clients" directive, on Manny's instruction. Full
      rationale + trade-offs in architecture.md. A future session may revisit.
- Movement math is duplicated (referee + client prediction) **on purpose** and
      must stay identical — see architecture.md.
- Roles hidden via snapshot shape (`hunter`/`disguise` only) — but the host tab
      still holds everything (see anti-cheat note).
- Theme: colorful circus (art in `assets/`, used on the menu screen).

## Where things live

Entry/served root: `index.html` + `js/` + `css/` (flattened). Referee (host
browser): `shared/referee.js`. Protocol: `shared/protocol.js` (C2S/S2C only now).
Network layer (PeerJS): `js/net.js`. Client entry: `js/main.js`. Tunables:
`shared/config/rules.json`. Notes: `memory/notes/` (netcode, game-loop,
input-mouselook, map-selection). Dead code
awaiting `git rm`: `client/`, `server/`.
