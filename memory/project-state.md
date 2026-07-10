# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. It's a **static site**
(deployable to Cloudflare Pages — no server, no backend, no build step). Play is
**peer-to-peer over WebRTC**; the room creator's browser hosts the referee.
Browsers are introduced by **PeerJS's free public broker** (no matchmaker of
ours). Strict NATs relay through a free public TURN.

## Status: IN-GAME LEVEL EDITOR (debug mode) BUILT (2026-07-10, vrmike). Desktop-only, not live-tested (headless).

A lightweight edit mode baked into the client so a human can fix placement/rotation/
scale by eye instead of iterating blind builds. **Ctrl+E** (desktop) toggles it. Full
detail: `memory/notes/level-editor.md`. Highlights:

- **Client-local SANDBOX, not a paused match** — the honest reason it's genuinely
  client-only. Ctrl+E steps OUT of the game loop into `Editor` (`js/editor.js`), which
  owns its own THREE scene + free-fly camera and loads the map fresh from config. The
  referee/netcode/match-flow are never touched (they keep ticking; the editor ignores
  them). Gated to solo/local play (`canEnterEditor`): desktop only, blocked as a guest
  or as a host with guests. Frame loop + input loop early-return while `state.editing`.
- **Reuses ONE renderer + scene.js mesh helpers** (`makePropMesh`, `instantiateModel`,
  `targetSizeForEntry` now exported) so edited objects size EXACTLY like the game.
  Own isolated GLTF loader (game renderer untouched). NO pointer lock — free cursor,
  right-drag to look — so it never contends with input.js's desktop lock path.
- **Controls:** WASD+Space/Shift fly; click select (outline + inspector: name/pos/rotY/
  scale/REAL bbox size from asset-dims.json, lazy-fetched); left-drag move (Shift=up/
  down), G snap-to-floor; R rotate 15° (Shift fine, Alt reverse); +/− scale 0.1–5×;
  palette (click / 1–9) spawns at crosshair ground point at normalized scale; Del
  delete + **U undelete** (restore stack); footer map dropdown; Copy/Download full
  `maps.json` (edited map's fixtures/props replaced, others byte-identical).
- **Prerequisite that landed with it — per-object `scale` (VISUAL-ONLY).** The loader
  read y/rot but NOT scale. Added additive, inert-for-existing-maps `scale` support in
  `scene.js` only (fixture + prop visuals), plus a CLIENT-side zip in `main.js` STARTED
  that reattaches authored prop `scale` onto the referee's prop instances by index. Per
  the approved "client-side fix" scope + constraint 9, `shared/physics.js` and
  `shared/referee.js` are UNTOUCHED — so scaled objects render exact but their COLLIDERS
  stay base-size (documented gap; most edits are at scale 1).
- **Touched files:** `js/editor.js` (new), `js/main.js`, `js/input.js` (Ctrl+E →
  `onToggleEdit` only), `js/scene.js`, `css/style.css`. NO change to shared/ (referee/
  protocol/net/physics). **Zero boot fetches** (editor + its dims fetch are lazy).
- **Playtest owed:** Ctrl+E in lobby → fly/select/transform/spawn/delete/undelete →
  export → paste back into maps.json → reload → layout matches incl. rot + scale; and
  confirm Ctrl+E refuses during a real multiplayer match.

## Status: RESTAURANT BOUNDING-BOX NORMALIZATION — measured scales (2026-07-10, vrmike). Not playtested (headless).

Stops guessing per-object scales; every restaurant GLB is sized from its MEASURED
native bounding box. Prereq for the physics build (colliders bake from these bounds).
Full detail: `memory/notes/restaurant-map.md` (top "THIRD PASS"). Highlights:
- **Measurement step** `tools/measure-glbs.mjs` (authoring-only, never shipped/imported):
  parses each GLB's JSON chunk, transforms POSITION accessor min/max by node world
  matrices (FBX2glTF bakes ×100 on the mesh node — must apply it). Output committed to
  `shared/config/asset-dims.json` (build-time reference; NOT fetched at page boot →
  headless load stays green).
- **One measured scale.** The KayKit pack is internally consistent, so a single world
  scale normalises all of it: `restaurant.modelScale = 0.75` (door 2.8→2.1, fridge
  2.5→1.88, chair 1.21→0.9, counters/tables→0.75). scene.js `_instantiateModel` gained a
  `scale` branch (native×scale, base flush at y=0); `map.modelScale`/per-entry
  `modelScale` feed it; disguises worn at the same scale (burger-sized, not player-sized).
- **Fixed the actual bugs:** floor podium (native tile 0.5 thick → modelDims `8×0.06×8`,
  flush); ankle-height counters + dollhouse walls were multi-module KITS
  (`modular_kitchen_parts` = 12 modules across ~15u; `modular_walls` = panel variants)
  fit-to-target into one tiny blob → `counter` now uses `kitchen_cabinet.glb`,
  `kitchen_wall` is a primitive box. Chairs flipped +π to face inward (pass-2 note
  predicted the +z front). Food `y` re-derived from new surface tops.
- **Physics bounds** (primitive w/h/d — what `physics.shapeFor` bakes colliders from) set
  to native×0.75 for measured items. Loader/fallback/referee/protocol untouched;
  circus_lot/toy_workshop untouched (no modelScale key → legacy path).
- **Playtest owed:** pick restaurant → floor at ground level, full-height walls,
  hip-height counters/sinks, player-scale door/fridge, chairs facing tables, food ON
  surfaces. Verify the two kit GLBs no longer appear. circus/toy still load.

## Status: PHYSICS + MULTIPLAYER NETCODE — THE BIG PASS (2026-07-09, on `physics-net`). NOT playtested (can't be, headless).

The single-pass "yolo" build VRmike approved: Rapier physics + host-authoritative
netcode with full client-side prediction + reconciliation, all at once. Full detail
in `memory/notes/physics.md` + `netcode.md`. **Which architecture shipped: the
TARGET** (prediction + rewind/replay reconciliation for the local player), NOT the
interpolation-only fallback. Honest status below.

- **Rapier engine** (`shared/physics.js`, `PhysicsWorld` + `loadRapier`): WASM,
  lazy-loaded at match start (zero boot fetch — headless load check stays green).
  Cuboid/cyl/cone/ball colliders from the catalog primitive footprint (NOT convex
  hulls from the GLBs — deliberate: GLBs load async/can fail; documented).
- **Players** = kinematic capsule character bodies (run, JUMP, real collide-and-
  slide vs walls/fixtures — fixes the old clip-through-everything gap — shove
  dynamic props, never knocked over). **Fixtures/walls/ground** = static colliders.
  **Props** = dynamic rigid bodies that get shoved (the TELL vs kinematic disguises).
- **Host** runs the one authoritative world (`referee.integrate` → physics.step),
  broadcasts player transforms + AWAKE-only prop transforms at 15 Hz with per-player
  `ack` seq. **Guests + host** predict their own player in a local Rapier world and
  reconcile (rewind to authoritative + replay unacked inputs + ease/snap residual).
  Remote players + awake props interpolate.
- **Disguise orientation lock**: disguised prop keeps a fixed facing while moving;
  hold right-click (desktop) / ROTATE (touch) to yaw-rotate — never tips. This is
  the roadmap "locked orientation" + the fake-nudge precursor.
- **Jump**: Space / JUMP button. Input protocol gained `seq, jump, rotUnlock`;
  snapshot gained `y, ack` per player + `props[]`.
- **GRACEFUL DEGRADE**: if Rapier can't load, BOTH sides fall back to the old flat
  2D movement (no collision/jump/props) — playable, never a hard stop.
- **Regression-safe**: circus_lot/toy_workshop (no fixtures) build ground+walls+
  dynamic props only; solo play = host-only physics (no netcode); mid-game join adds
  a physics body; persistent lobby tears the world down on reset. Rules/referee phase
  machine unchanged. 2D fallback preserves exact prior behaviour.
- **UNTESTED — the load-bearing caveat**: the bot check is a headless LOAD test; it
  CANNOT feel-test physics/netcode. Prediction jitter, prop-shove rubber-band, jump
  smoothness, and the reconcile snap threshold all need a LIVE multiplayer playtest
  with real people + real pings. Expect a tuning pass. Files: `shared/physics.js`
  (new), `shared/referee.js`, `shared/protocol.js`, `js/main.js`, `js/scene.js`,
  `js/input.js`, `css/style.css`, `shared/config/rules.json`.

## Status: RESTAURANT MAP — SECOND PASS / LAYOUT FIX (2026-07-09, on `vrmike/dev`). Not yet playtested.

The `restaurant` map got a full layout rework on the SAME footprint (size 36 — density
by ADDING objects, never shrinking bounds). Full detail: `memory/notes/restaurant-map.md`
(top "SECOND PASS" section). Highlights:
- **Floor slab clipping FIXED** via a new non-uniform `modelDims:{w,h,d}` scale path in
  `js/scene.js _instantiateModel` — the floor was scaling uniformly to width 8, which
  inflated its thickness into a ~2-foot checkerboard slab. `floor_kitchen` now forces
  8×0.2×8 (flush, thin) regardless of the GLB's native proportions.
- **Prop `y` offset** added (referee `this.props` build → `STARTED` → scene props loop),
  mirroring the existing `rot` pass-through, so a disguisable food item can sit ON a
  table. Disguise range is x/z-only, so y is purely visual.
- **Kitchen/dining split** by a divider counter line at z=−4.5 (two walkways). Kitchen
  gear along the back + a prep row; dining = 6 round tables (chairs each rotated to face
  their table via `rot=atan2(dx,dz)`) + large/small tables. ~90 fixtures, ~56 props.
- **Food on surfaces** (fixtures with y), most decorative food is fixed (non-disguisable,
  zero bandwidth); only ~6 disguisable food props remain, on tables.
- **All pack assets now referenced** (menu, knife, planks, towels, jars, dinner, extra
  stoves/crates/dishes/raw+cut foods). New catalog entries in fixtures.json + props.json.
- **Pass-2 FINISH (this session):** every remaining catalog GLB that was defined-but-
  never-placed (~27) is now instanced as a decorative FIXTURE — side cook-line
  (stove_plain/stove_single), a modular_walls panel per kitchen side, all leftover
  prepped/raw food + whole produce on kitchen surfaces, and ketchup+mustard PAIRS on
  every dining table. Props-catalog keys (ketchup, mustard, pan, plate, whole veg)
  referenced from fixtures[] render via the merged catalog but never join the disguise
  pool (built from props[] only) — zero bandwidth, non-disguisable. DATA-ONLY append to
  the restaurant map object; no engine change; other two maps untouched. Req 3 (use ALL
  assets) now fully closed. Detail: `memory/notes/restaurant-map.md` (pass-2 finish).
- ONLY three tiny engine changes (`modelDims` non-uniform scale, prop `y` thread, dims
  pass-through); circus_lot/toy_workshop untouched (no `fixtures`/`modelDims`/prop-`y`
  keys → same code paths as before). ⚠️ Playtest note: if chairs face OUTWARD, chair
  GLB native front is +z not −z → add π to every chair `rot`. See restaurant-map.md.

## Status: RESTAURANT REAL GLB MESHES WIRED IN (first pass, 2026-07-09, on `vrmike/dev`). Superseded by the layout fix above.

The `restaurant` map now renders the real CC0 "Restaurant Bits" GLB meshes (Kay
Lousberg) instead of primitive boxes. An earlier bulk fetch had downloaded the GLBs
into `assets/restaurant/` but never hooked them into rendering (and left scratch
junk behind); this session did the wiring + cleanup handoff.

- **Map rebuilt from the real GLBs** (`shared/config/maps.json` → `restaurant`): a
  coherent small restaurant — tiled kitchen (floor_kitchen, fridge/oven/stove/
  extractor/counter/sink/cabinets/shelf along the back, counter islands +
  kitchen_table), a modular_walls + pillars divider with passages, a dining room
  (round/large/small tables), and a door. Static geometry → `fixtures[]`; small
  movable items → `props[]`.
- **Two catalogs now** (requirement 3, defense-in-depth): `props.json` is the
  disguise catalog (movable items ONLY) and the new `shared/config/fixtures.json`
  holds the static building pieces. Kept in separate files so a fixture can never
  enter the disguise pool. Each entry carries a `model:` path to the clean GLB name,
  keeping the primitive shape as fallback + size target. `config.js` loads both;
  `scene.js` merges them (`{...cfg.props, ...cfg.fixtures}`) purely for rendering.
  The referee still builds the pool from `map.props` only — it never reads either
  catalog.
- **Lazy client-side GLTFLoader** in `js/scene.js`: primitives render instantly at
  match start, then the referenced GLBs load (CDN import, deduped) and swap in over
  them; the primitive stays as an invisible camera collider. Missing/failed GLB →
  primitive stays visible (per-item fallback). Disguises wear the real mesh once
  cached. `index.html` importmap gained a `three/addons/` entry (declares only — no
  boot fetch). Referee untouched (still builds the pool from `map.props` only).
  Full detail: `memory/notes/restaurant-map.md`.
- **CLEANUP OWED — needs a shell (this sandbox has none).** The bulk fetch dumped
  junk that is inert but still on `main` and could NOT be deleted here (no shell /
  rm; Write is text-only; there is no file-delete tool). Nothing references any of
  it. Delete from a shell session:
  ```
  git rm -r _meshwork
  git rm bundle.html fetch_meshes.sh assets/restaurant/manifest.json
  # 18 hash-suffixed GLB duplicates (each has a clean twin that is KEPT). Do NOT use
  # a `*_??????????.glb` glob — it would also match the legit shelf_papertowel.glb
  # (`papertowel` is exactly 10 chars). Enumerate them:
  git rm assets/restaurant/tomato_EVTveOjwHG.glb \
         assets/restaurant/round_table_KZXCuGx1WZ.glb \
         assets/restaurant/round_table_oravj1kSy2.glb \
         assets/restaurant/door_MSIuI2jpqb.glb \
         assets/restaurant/pan_O5t9nVpPjd.glb \
         assets/restaurant/kitchen_cabinet_corner_Pieyzl60FA.glb \
         assets/restaurant/kitchen_cabinet_sS6Llv1TG5.glb \
         assets/restaurant/potato_acwBoZQNdm.glb \
         assets/restaurant/stove_cT99QUoCCn.glb \
         assets/restaurant/chair_eGccH9cqom.glb \
         assets/restaurant/kitchen_table_hM1OMnevjc.glb \
         assets/restaurant/kitchen_table_jrwQfpN0LV.glb \
         assets/restaurant/kitchen_table_ocdwmd2IKZ.glb \
         assets/restaurant/dishrack_phJwmk2B4X.glb \
         assets/restaurant/stew_rPa4vEsC9c.glb \
         assets/restaurant/shelf_papertowel_uJ60T0cGEG.glb \
         assets/restaurant/lettuce_yC6B73sG9s.glb \
         assets/restaurant/pot_of_stew_zXG0jZ4QiC.glb
  ```
  `assets/restaurant/manifest.json` and `_meshwork/fetch.log` are the fetch script's
  own artifacts (they list the dupes above) — removed by the lines above. NOTE:
  `kitchentable_sink_la.glb` has a 2-char suffix and is NOT a dup — KEEP it. The map
  references only clean names, so no config reference fix is needed. `fetch.log`
  confirms all 111 downloads succeeded (fail=0), so every clean GLB the map uses is
  a real, non-empty binary.

## Status: EARLIER restaurant map build (primitive stand-ins) — superseded by the GLB wiring above.

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
- **[HISTORICAL] GLBs were unfetchable in the two prior sessions** (no shell /
  network / binary-write in that sandbox), so the map shipped on primitive
  stand-ins and reported it honestly. That is now RESOLVED: a later bulk fetch put
  the real GLBs on disk, and the 2026-07-09 wiring session (top of file) hooked them
  into rendering. The prediction held — no client code assumptions changed; only the
  assets had been missing, plus the lazy-loader wiring the notes had pre-scoped.
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
- ~~No client-side prediction of collisions; players can overlap props/walls.~~
  RESOLVED by the physics pass (`physics-net`): players now collide-and-slide vs
  walls/fixtures/props via a local Rapier prediction world, reconciled to the host.
  (Prediction of DYNAMIC prop motion is host-authoritative only — guests treat props
  as fixed obstacles and reconcile; a guest shoving a prop can rubber-band slightly.)
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
`js/scene.js`. **Level editor (desktop debug tool)**: `js/editor.js` (toggled by
Ctrl+E; a client-local sandbox that never touches the referee/netcode). Tunables:
`shared/config/rules.json`. Notes: `memory/notes/` (netcode, game-loop,
input-mouselook, map-selection, touch-controls, third-person-camera, level-editor). Dead code awaiting `git rm`: `client/`, `server/`.

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
