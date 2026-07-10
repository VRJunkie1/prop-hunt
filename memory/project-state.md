# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. It's a **static site**
(deployable to Cloudflare Pages — no server, no backend, no build step). Play is
**peer-to-peer over WebRTC**; the room creator's browser hosts the referee.
Browsers are introduced by **PeerJS's free public broker** (no matchmaker of
ours). Strict NATs relay through a free public TURN.

## Status: RESTAURANT MAP BUILT (this session, on `vrmike/dev`). Not yet playtested.

A third selectable map (`restaurant`) + the small engine seam for STEP 3's
static/dynamic split. Data-driven, so it's host-selectable through the existing
picker with no new wiring.

- **New `map.fixtures[]` seam** — maps can now carry immovable **fixtures**
  (walls, counters, stove, oven, fridge, cabinets, sinks, large/anchored tables)
  separately from **props** (the movable disguise pool: chairs, stools, crates,
  pots, pans, plates, bowls, cutting boards, food/burgers). Fixtures render +
  join `scene.colliders` client-side but the referee never treats them as
  disguisable (it still builds the pool from `map.props` only). ONE engine change:
  a `for (const f of map.fixtures || [])` loop in `js/scene.js buildWorld` — older
  maps (no `fixtures` key) are untouched. No protocol/referee change (every client
  has maps.json locally). Files: `shared/config/props.json` (restaurant shape
  catalog), `shared/config/maps.json` (`restaurant` map), `js/scene.js` (fixtures
  loop). Full detail: `memory/notes/restaurant-map.md`.
- **Honest mapping of "collision + static/dynamic":** this engine has NO
  rigid-body physics and NO player-vs-object collision (players pass through
  everything — documented gap). Its only collision primitive is the third-person
  camera's `scene.colliders` raycast; "give everything collision" = adding it to
  that set, which both fixtures and props now do. Real player collision would be a
  separate, bigger lockstep change (referee `integrate` + client prediction).
- **GLB assets were NOT fetched — reported honestly, not faked.** The task wanted
  the 111 CC0 "Restaurant Bits" GLB meshes (Kay Lousberg,
  https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q). This sandbox has no
  working network/shell tool (shell permission stream fails — same wall prior
  sessions hit; the write tool is text-only), so binary download was impossible.
  No empty/placeholder `.glb` files were created. The map runs on the engine's
  existing **primitive shapes** themed as restaurant items. Attribution + the
  shape→model mapping + the follow-up (add a lazy `GLTFLoader`, keep it firing only
  at match start) are in `/CREDITS.md` and `assets/restaurant/README.md`.
- **[2026-07-09] GLB fetch RE-ATTEMPTED (attempt #2) — STILL BLOCKED, same wall.**
  VRmike believed the binary-fetch capability was now fixed; it is NOT, in this
  sandbox. Ran the make-or-break capability gate (download ONE real GLB before
  touching anything). Precise findings, so nobody re-runs this blind:
  - `Bash` tool → `Error: No such tool available: Bash. Bash exists but is not
    enabled in this context.` (present in the registry but disabled here).
  - `Monitor` (the only other command-shaped tool) → every invocation, both from
    the main loop and a subagent, fails at the permission step with
    `Tool permission request failed: Error: Stream closed` — the command never
    executes (no stdout/stderr/exit code).
  - No web-fetch / HTTP / download tool exists in the tool set (verified by
    multiple `ToolSearch` passes: only `Monitor`/`NotebookEdit` are command-shaped,
    neither does HTTP). `Write` is text/UTF-8 only — cannot reproduce binary bytes.
  - Conclusion: **shell = NO, network = NO, binary-write = NO.** Per the approved
    plan's step 2, STOPPED here — did NOT fake or create placeholder `.glb` files,
    did NOT touch `assets/`. The wiring in step 3 (point `maps.json` fixtures +
    `props.json` props at GLB paths, add a lazy `GLTFLoader` off `S2C.STARTED` with
    primitive fallback) is READY to do the instant real `.glb` files exist — the
    fixtures-vs-props split, the lazy `ensureScene()`/`S2C.STARTED` seam, and the
    attribution docs are all already in place (see Explore map below / notes).
  - **UNBLOCK PATH:** this must run in an environment where either `Bash` is
    enabled OR `Monitor`'s permission stream works, so `curl`/`wget` can pull the
    GLBs. Nothing in the client code needs to change first — only the assets are
    missing.
- **Playtest owed:** pick `restaurant` in lobby → everyone spawns in it; enclosed
  kitchen+dining reads right; disguise into a chair/crate/burger; tag works;
  camera pulls in on fixtures; circus_lot + toy_workshop still load unchanged.

## Status: THIRD-PERSON CAMERA BUILT (earlier session, on `vrmike/dev`). Not yet playtested.

The local player is now **third-person by default** (was first-person). A camera
orbits behind + slightly above them off the existing yaw/pitch; they now see their
OWN model/prop (built via the same disguise/role path other peers are drawn with).
**Camera/view change only** — movement, roles, collision, networking, and the
referee are untouched.

- **Aim decision (the one gotcha):** the referee's tag cone / disguise still
  compute from yaw-forward — NOT touched. Since the third-person eye is off the
  player, the reticle is now driven off that yaw-forward vector
  (`scene.aimScreenPoint` → `ui.setCrosshair`), not screen center, so tag/disguise
  land where the reticle points. First-person recenters the reticle.
- **Collision-aware:** the engine already exposes `THREE.Raycaster` (so pass two
  was cheap). Walls + static props go into `scene.colliders`; a per-frame ray from
  the player pulls the camera in on a hit (min dist 1.2, 0.3 skin). Ground and
  avatars are excluded on purpose. Snap-in / ease-out (0.12) smoothing.
- **Own model:** `syncPlayers` no longer skips self — `_syncSelf` builds the local
  avatar via `meshForPlayer`; positioned each frame from the PREDICTED pos/yaw so
  it tracks the camera without snapshot lag.
- **First-person toggle kept** (it was clean): desktop **V** flips camera +
  own-model + reticle behind one `scene.setThirdPerson()` flag. No touch button.
- Files: `js/scene.js`, `js/main.js`, `js/input.js`, `js/ui.js`. No CSS/HTML/
  referee/protocol/net changes, no new deps. Full detail:
  `memory/notes/third-person-camera.md`. **Playtest owed** (orbit, wall pull-in,
  tag/disguise-under-reticle, V toggle; desktop + phone).

## Status: MULTIPLAYER + MOBILE UPDATE BUILT (earlier session, on `vrmike/dev`). Not yet playtested.

Four things landed together, all against the seams the notes already named:

1. **Solo launch.** `minPlayers` → 1 (`rules.json`). `startMatch` role math now
   keeps ≥1 prop (`hunterCount = min(max(1,round(n*hunterRatio)), n-1)`), so a lone
   host is a **prop** and can walk/disguise while testing a map; a zero-hunter
   round has no instant win and runs on the timer. `checkRoundOver` already only
   ends early when props existed and all died, so no change needed there.
2. **Mid-game join.** `Referee.addPlayer` is the single gate; during HIDING/HUNTING
   it routes to new `admitMidGame(player)`, which slots the newcomer in as a
   **hunter**, spawns them, and sends the SAME filtered catch-up every guest gets
   (`STARTED` + private `ROLE` + current phase/clock + normal snapshots) — never the
   host's full state. `net.js` already called `addPlayer` on every guest connect
   regardless of phase, so no network change was needed. Guest side is pure
   presentation (`STARTED` drops it into the running game).
3. **Persistent lobby.** Already returned ENDING→LOBBY keeping the map; this session
   confirmed nothing else resets (peers stay open, host stays host, list survives)
   and added `lastResult` (rides `S2C.LOBBY`) so the lobby shows the previous
   winner. `main.js` tidies per-round view state on return WITHOUT reconnecting.
4. **Phone / touch controls.** Whole layer in `js/input.js`: nipplejs joystick
   (lazy CDN), hand-rolled drag-to-look, on-screen action button, "Tap to play" +
   iOS audio unlock, portrait/landscape CSS, `touch-action:none`, `100dvh`, DPR cap
   (pre-existing), wake lock (+ phone-host warning), `webglcontextlost` guard. Only
   wired on touch devices — desktop WASD + mouse-look is UNCHANGED. Full detail:
   `memory/notes/touch-controls.md`.

Files touched: `shared/config/rules.json`, `shared/referee.js`, `shared/protocol.js`
(doc), `js/main.js`, `js/input.js`, `js/ui.js`, `js/scene.js`, `index.html`,
`css/style.css`. See `memory/notes/{game-loop,touch-controls,input-mouselook}.md`.

## Status: LOBBY MAP SELECTION BUILT (earlier session, on `vrmike/dev`).

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
- **Phones now IN scope (this session).** Full touch controls added (joystick +
      drag-to-look + tap buttons + "Tap to play", portrait & landscape). Desktop
      WASD + mouse-look untouched. **Playtest owed** (see the mobile checklist in
      the new-work status above and open thread below). Details in
      `memory/notes/touch-controls.md`.
- **PLAYTEST OWED for this session's work.** Do a desktop + phone pass: (a) start
      SOLO on desktop, walk/disguise alone; (b) phone joins MID-ROUND via the invite
      link → confirm it drops into the running game as a hunter and sees only what
      other guests see (never undisguised props); (c) play with touch in BOTH
      portrait and landscape (joystick moves, drag looks, action button
      tags/disguises, "Tap to play" dismisses, no pinch-zoom); (d) finish the round
      and start ANOTHER from the persistent lobby with nobody reconnecting (host
      stays host, map stays picked, last winner shown). Two tabs on one machine is
      still not a valid P2P test.
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
Network layer (PeerJS): `js/net.js`. Client entry: `js/main.js`. Input (all
schemes, incl. touch): `js/input.js`. Rendering + **third-person camera**:
`js/scene.js`. Tunables: `shared/config/rules.json`. Notes: `memory/notes/`
(netcode, game-loop, input-mouselook, map-selection, touch-controls,
third-person-camera). Dead code awaiting `git rm`: `client/`, `server/`.

- The agent loop went live 2026-07-07 (per VRmike). (noted 2026-07-07 by VRmike)

- prop-hunt physics WIP — LATER/suggestion (not v1): "fake nudge" for disguised players. When a hunter shoves a disguised player, play a scripted cosmetic reaction so it mimics a real dynamic prop and preserves the disguise (instead of a hard 100% tell). CONSTRAINT (VRmike): the fake nudge may ONLY translate and rotate on the vertical (yaw) axis — it must NEVER tip over (no pitch/roll). Players stay kinematic and un-knockable; this is purely a visual mimic. The genuine tell then becomes subtle (real dynamic props tumble/settle differently) rather than binary. To be written into the game repo's WIP notes when the physics build runs. (noted 2026-07-09 by VRmike)

- prop-hunt PHYSICS + MULTIPLAYER architecture — DECIDED with VRmike, for the big single-pass "yolo" build (do it all at once; roll back if it fails):
- ENGINE: Rapier (rapier3d, WASM). Lazy-load at match start like three.js/PeerJS — ZERO boot-time network fetch (headless load check must stay clean).
- COLLIDERS: static fixtures (walls/floor/counters/stove/oven/fridge/cabinets/sinks/large tables) = fixed colliders (box/trimesh). Dynamic props (chairs/stools/crates/pots/pans/plates/bowls/cutting boards/food) = dynamic rigid bodies with per-mesh CONVEX HULL colliders (convex decomposition only if a hull isn't enough). Reuse the existing map.fixtures[] vs map.props[] split already in the engine.
- PLAYERS: KINEMATIC character bodies via Rapier KinematicCharacterController. Have colliders; run + jump (manual gravity/vertical velocity); collide-and-slide vs walls/fixtures (FIXES the current pass-through-everything gap); shove dynamic props (applyImpulsesToDynamicBodies); but CANNOT be knocked/tipped over.
- NETWORKING: host-authoritative. TARGET for the yolo build = full client-side PREDICTION + server RECONCILIATION — every client runs a local Rapier sim for instant response; host streams authoritative transforms; clients blend/reconcile toward host (smooth, no hard pops). FALLBACK if that's too much in one pass: host-only sim + guest interpolation (guests don't sim, just interpolate received transforms).
- BANDWIDTH: only sync AWAKE bodies (Rapier sleeping = ~0 traffic when still); quantize transforms (~16 bytes); traffic is bursty. Rapier is NOT a networked engine — all netcode is hand-written.
- DETERMINISM: Rapier deterministic only given identical inputs/order/build; cross-browser drift is expected → reconciliation corrects it. Don't rely on determinism alone to stay synced.
- TELL MECHANIC: real props are physics-driven (get shoved), disguised players are kinematic (don't) = the tell. Fake-nudge softener already noted (later; yaw+translate only, never tip).
- CONSTRAINTS: static site, no build step, P2P WebRTC via PeerJS broker, referee stays authoritative & transport-agnostic, flat repo-root layout, lazy CDN. Build on vrmike/dev.
- VERIFICATION CAVEAT: bot auto-check is a headless LOAD test only — it CANNOT feel-test physics/netcode. This build needs a live multiplayer playtest as real QA. (noted 2026-07-09 by VRmike)

- prop-hunt FEATURE ROADMAP (VRmike's high-level todo list) lives in the prop-hunt repo at memory/notes/roadmap.md — NOT kept in main context. LOAD it (read the repo / read_project_state) whenever discussing prop-hunt plans, and be ready to post it on request and edit it. Written 2026-07-09. (noted 2026-07-09 by VRmike)
