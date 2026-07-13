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
  and the lobby "Copy invite link" button. Owns the **screen wake lock** during a
  match (`navigator.wakeLock`, re-acquired on `visibilitychange`; a sleeping host
  kills the match for everyone) and the touch glue (`input.enterGame/exitGame`,
  `onTouchPlay` → dismiss the "Tap to play" overlay).
- `js/net.js` — the **dual-mode network layer** (`Session`), now on **PeerJS**: a
  `Peer` to the public broker, plus either (host) an in-tab `Referee` + loopback
  link + a bridge from each guest's `DataConnection` into the referee, or (guest)
  one reliable `DataConnection` to the host. Channels are **reliable + ordered**
  via PeerJS's `{reliable:true}`. ICE servers (STUN **+ TURN relay**) are injected
  through the `Peer` `config` option. `detectRelayed()`/`_reportLink()` read
  `conn.peerConnection.getStats()` to tell the UI direct vs relayed. ~10s connect
  give-up timer preserved.
- `js/input.js` — **owns EVERY control scheme** and funnels them all into one
  output shape (movement `mx,mz` + look `yaw,pitch` + action callbacks), so the
  rest of the game is input-agnostic. Two schemes, chosen once by `isTouchDevice()`:
  - **Desktop** — WASD + pointer-lock mouse look. **Owns the whole pointer-lock
    handshake**: requests capture on click of the `lockTrigger` (the "Click to
    play" overlay, which covers the canvas and swallows its clicks) and drives the
    overlay off the browser's real `pointerlockchange`/`pointerlockerror` signals
    (`onLockChange`/`onLockError`) — never a guess. Untouched by the touch work.
  - **Touch** — nipplejs virtual joystick (lazy-loaded from jsDelivr, like
    Three/PeerJS — nothing at boot), hand-rolled drag-to-look via pointer events on
    the canvas (no pointer lock on phones, so it REPLACES mouse-look), and an
    on-screen action button. A "Tap to play" path parallel to (not faked into) the
    desktop lock path: `onTouchPlay` + `enterGame()`/`exitGame()`. Audio unlock for
    iOS happens in the first tap handler here (glue layer, not `ui.js`). Full
    detail: `memory/notes/touch-controls.md`.
- `js/scene.js` — all Three.js. Builds world from config, reconciles player meshes
  to snapshots, interpolates others. The local player uses a **third-person
  follow camera** that orbits behind/above them off the same yaw/pitch;
  it renders the player's OWN model (via the shared disguise/role path) and is
  collision-aware (a raycast against walls+props pulls it in, snap-in/ease-out
  smoothing). `setThirdPerson(false)` is the classic first-person eye view. **View is
  role-driven (2026-07-11):** `main.js applyRoleView()` puts HUNTERS in first-person
  (no own body drawn; remote players still see their animated soldier) and PROPS in
  third-person; desktop V still toggles manually. The self body draws when
  `_wantSelfMesh()` = `thirdPerson || _freeCam` (so a first-person hunter's body
  reappears under the debug free cam). The aim **reticle is a fixed centre crosshair**
  (CSS only — the old floating `aimScreenPoint` is gone); disguise targeting raycasts
  from the CAMERA CENTRE through it (`aimedDisguiseTarget` → `setFromCamera(SCREEN_CENTER)`,
  the same 0,0-NDC point `debugPick` uses — ONE crosshair/raycast system). Detail:
  `memory/notes/third-person-camera.md`. Pixel ratio is capped at 2 (phones);
  re-measures on `orientationchange`; `preventDefault`s `webglcontextlost` so a
  mobile GPU hiccup can restore instead of white-screening. **Real GLB meshes:** a
  catalog entry may carry a `model` path; `buildWorld` renders the primitive first,
  then `_loadModels` **lazily** imports a CDN `GLTFLoader` (once, at match start)
  and swaps the real mesh in over the primitive (which stays as an invisible camera
  collider). Missing/failed GLB → primitive stays visible (per-item fallback). Only
  the active map's referenced GLBs load, only on the viewing client, never at boot
  (the `three/addons/` importmap entry only declares). Detail:
  `memory/notes/restaurant-map.md`. **Animated hunter model (2026-07-11):** a REMOTE
  hunter renders as an animated SWAT soldier (what props see) via a self-contained
  subsystem here — rig-safe `SkeletonUtils.clone` per hunter, an `AnimationMixer` whose
  idle/run state machine is driven by velocity DERIVED from successive snapshots, and a
  rifle parented to the `Wrist.R` bone. The LOCAL hunter never renders it (stays
  first-person). Registry: `cfg.characterModels`. Detail:
  `memory/notes/hunter-character-model.md`.
- `js/ui.js` — DOM screens (menu/lobby/game), HUD, feed. No game logic. The HUD **health
  readout is a filled BAR** (2026-07-12, `#hudHealth` = `.health-fill` + centred `.health-label`;
  green→amber→red): `.hud-top` spans the row and `flex-wrap`s so the bar fills the spare width on
  PC and drops to its own full-width row on mobile portrait — two fixed CSS layouts, no runtime
  measurement. `setHealth(pct)` sets the fill width + label + warn/crit class. The
  "Click to play" overlay is shown/hidden by `setClickToPlay(visible, msg?)`, but the
  DECISION is **state-driven** in `main.js` (2026-07-12): the overlay shows only when the
  pointer is unlocked AND not `state.paused` AND not `state.uiMode` (desktop "UI mode" —
  backtick `` ` `` frees the mouse for the DEBUG menu WITHOUT opening pause; see
  `notes/pause-menu.md`). `msg` explains a lock refusal. This killed the old event-order
  race where whichever pointer-lock event fired last decided the overlay. Also paints a
  `direct`/`relayed` diagnostic badge per lobby row from `setLink()` — the
  connection-type is *detected* in `net.js`, never here. Also owns the hunter
  **blindfold** overlay via `setBlindfold(blind, seconds)` — a plain show/hide of the
  `#blindfold` blackout that `main.js` drives from a fresh
  `role === HUNTER && phase === HIDING` derivation (never latched). Anti-cheat detail:
  `memory/notes/anti-cheat-blindfold.md`.
- `js/config.js` — fetches `shared/config`; the host passes it into the `Referee`.
- `js/editor.js` — **in-game level editor (desktop debug tool)**, toggled by
  **Ctrl+E** (`input.js` fires `onToggleEdit`; `main.js` gates + wires). A
  **client-local SANDBOX**: it steps the client OUT of the game loop into its own
  `THREE.Scene` + free-fly camera loaded fresh from map config, and **never touches
  the referee, netcode, or match flow** (they keep ticking; the editor ignores
  them). Gated to solo/local play (never mid-multiplayer). Reuses the game's single
  `WebGLRenderer` and `scene.js`'s exported mesh helpers (`makePropMesh`,
  `instantiateModel`, `targetSizeForEntry`) so edited objects size exactly like the
  game; own isolated GLTF loader. Uses a **free cursor + right-drag look (no pointer
  lock)** so it never contends with input.js's lock path. Select/move/rotate/scale/
  spawn/delete(+undelete); exports the edited layout as a drop-in `maps.json`.
  Detail: `memory/notes/level-editor.md`.
- `js/debug.js` — **in-game debug menu (ON BY DEFAULT as of 2026-07-12)**. Constructed by
  `main.js` UNCONDITIONALLY (still a lazy `import()`); it self-injects its overlay so
  `index.html`/`style.css` ship zero debug DOM/CSS. `?debug=1` is UNCHANGED and still gates the
  separable heavy features — the collider wireframe overlay (read directly in `scene.js`),
  per-peer ping, and the referee's host-authoritative debug-command gate — so the visible-by-
  default panel still can't tamper with a normal match (team/reset/morph dropped unless the HOST
  loaded `?debug=1`). A plain, phone-usable DOM overlay (thumb toggle + collapsible panel, styles
  self-injected). Read-only displays (FPS, coords, local-player states, roster, per-peer
  ping) read live client state. Host-authoritative actions (change team, reset, force-
  morph) go through the referee's gated **`C2S.DEBUG`** family (see below). Local
  rendering features — **free cam**, **focus box**, **click-to-inspect** — go through
  explicit `scene.js` seams (`setFreeCam`/`updateFreeCam`/`debugPick`/`setFocusBox`), so
  scene math stays in scene.js. The focus box is a magenta wireframe, its OWN box instance
  (distinct from the green disguise highlight + the collider-debug wires) and NEVER added
  to `scene.colliders`. Free cam is rendering-only: `main.js` freezes the physics player
  (skips prediction, sends zeroed movement) while it's on. `tools/check-blindfold.mjs` was
  widened to scan debug.js's `scene.*()` calls too (the "missing scene method blanks the
  render loop" guard now covers this module). Detail: `memory/notes/debug-menu.md`.

## Hunter tools + health/damage (HUNTER-TOOLS v1, 2026-07-12)

Full detail: `notes/hunter-tools-combat.md` + `DECISIONS.md` #1. Shape:

- **Tool framework is CLIENT-ONLY and NOT networked** (`js/main.js` `HUNTER_TOOLS`,
  `state.tool`). An always-on `#toolbar` for a live hunter (tap / click / number keys 1–2,
  current highlighted). Tool switching is made visible to the first-person shooter by a
  weapon **viewmodel** parented to the camera (`scene.setViewModel`: rifle GLB or a ~0.3 m
  box). Only the FIRE event crosses the wire; which tool a hunter holds is deliberately not
  synced in v1.
- **The rifle is host-authoritative** (same client-suggests/host-validates model as
  disguising). Client sends only its aim DIRECTION (`C2S.SHOOT`, from `scene.aimDirection()`
  = the SAME screen-centre ray as the disguise pick). `referee.applyShot` re-casts from the
  shooter's authoritative eye in the host's Rapier world (`physics.raycastShot` → `castRay`,
  own capsule excluded) and `physics.describeCollider` classifies the hit
  (player / prop / static-fixture-by-type / world) via handle→entity maps built at world
  construction. Everyone sees the tracer via `EVENT kind:'shot'` → `scene.spawnTracer`.
- **Health/damage lives entirely on the host** (`shared/referee.js`), sized from the SAME
  footprint physics uses. `shared/damage.js` (PURE) is the one size→multiplier source
  (`entrySize` via `physics.halfExtentsFor`, lerped over `rules.damage` anchors), imported by
  both the referee and `tools/check-combat.mjs`. Player hit → base×disguise-size (prop-PLAYERS
  scale by size); a disguisable **decoy** → the hunter takes a **FLAT wrong-guess penalty**
  (`damage.wrongGuessPenalty` = `base`, NEVER size-scaled — a small and a big decoy cost the
  same; 2026-07-12); architecture/world → free miss; a prop kill refills the hunter. Base is
  **5** (5%/hit; undisguised = 20 hits) and `smallMult` is 10 (a small disguise still ≈ 2 hits at
  base 5). Health rides every snapshot player entry (HUD only, no secret).
- **Hunters do NOT respawn** (DECISIONS.md #1): a dead player spectates; `checkRoundOver`
  ends the round PROPS-WIN when a round's hunters are all dead.

## Shared (`shared/`)

- `damage.js` — **HUNTER-TOOLS v1 damage math (PURE).** Imports only `physics.halfExtentsFor`
  (no Rapier/DOM) so the host referee and the offline guard run identical numbers. Lerps a
  size multiplier between `rules.damage` anchors over each disguise's collider footprint —
  ONE size source, auto-upgrades to measured `asset-dims` bounds when populated.
- `protocol.js` — **one protocol** now: `C2S`/`S2C`/`PHASE`/`ROLE` (client ↔
  referee). Dependency-free ESM. (The old `SIG` matchmaker-signaling protocol was
  deleted with the matchmaker; PeerJS's own connect/disconnect events replace it.)
  **`C2S.DEBUG`** (2026-07-11) is the debug-menu family (`{action:'team'|'reset'|'morph'}`):
  routed like any other message, but the referee DROPS it unless the HOST loaded with
  `?debug=1` (`referee.debugEnabled`, read from the host tab's URL — the referee only ever
  runs in the host tab). So a tampered guest can't inject debug commands into a normal
  match. `js/net.js` also carries a debug-only `__ping`/`__pong` control pair (intercepted
  BEFORE the referee; enabled only under `?debug=1` via `session.enablePing()`) that fills
  a per-peer RTT map the debug panel reads — zero ping traffic in normal play.
- `referee.js` — the authoritative referee (see above). Browser-only, transport-
  agnostic (unchanged by the PeerJS swap — it only ever saw `send` callbacks).
- `config/` — **content as data**: `rules.json` (timers, speeds, ratios),
  `maps.json` (size, colors, spawns, prop placements — `circus_lot`,
  `toy_workshop`, `restaurant`), `props.json` (the **disguise catalog** — movable
  items only: box/cylinder/cone/sphere + color, plus an optional `model` GLB path
  for the restaurant), and `fixtures.json` (the **static building-piece catalog**:
  same shape format + `model`/`modelSize`). **DISGUISE-ANYTHING (2026-07-11):** a player
  can disguise as ANY object EXCEPT world ARCHITECTURE. `physics.isArchEntry` /
  `isDisguisableEntry` ("renderable mesh AND not architecture") is the one rule; the 4
  architecture fixtures (floor + walls) carry `"arch": true`. `referee.startMatch` promotes
  every non-arch fixture (tables, food, counters, oven, fridge, cabinets, sinks, shelves,
  vent, doors, **pillars**) into the disguise pool; only architecture stays out. props.json
  vs fixtures.json is still a useful split (movable vs built-in, and character models stay
  fully separate — see below), but a fixture is no longer barred from the pool. Detail:
  `notes/disguise-anything.md`. Adding maps/props needs no engine change; the lobby map picker renders
  any new map automatically. **`physics-feel.json`** (2026-07-11) holds the physics
  FEEL tunables (restitution / solver iterations / prop damping / anti-bob) — a
  physics-owned file, NOT `rules.json` (which is the referee's game rules);
  `config.js` loads it into `cfg.feel` and both the host world and every client
  prediction world derive feel from that ONE object via `physics.js resolveFeel()`,
  so tuning can never desync a match.
- **`character-models.json`** (2026-07-11) — the **character-model registry** for
  animated third-person PLAYER models (the SWAT hunter). DELIBERATELY separate from
  `props.json`/`fixtures.json`: those feed the collider-baking + measured-bounds physics
  pipeline, which a player character must never enter (it would grow a collider it
  shouldn't). Holds body/weapon GLB paths, capsule-match height, movement clip suffixes,
  anim tunables, and the hot-tunable rifle grip offset + facing (`yawOffsetDeg`).
  `config.js` loads it into `cfg.characterModels`; ONLY `scene.js` consumes it (view
  only — no referee/physics/protocol involvement). Detail:
  `notes/hunter-character-model.md`.
- **Static vs dynamic in a map** (added with the `restaurant` map): a map may
  carry an optional **`fixtures[]`** array (immovable building pieces — walls,
  counters, appliances, sinks, large tables) *alongside* **`props[]`** (the movable
  disguise pool). **As of disguise-anything (2026-07-11)** every NON-architecture fixture
  is also promoted into the disguise pool (referee), and static built-ins ride the prop
  stream as INVISIBLE aim proxies in `scene.js` (visible mesh still from the scenery loop);
  only architecture (`isArchEntry`) is never disguisable. **The 2026-07 physics pass split
  still drives the Rapier world unchanged:** fixtures + walls + ground become STATIC
  colliders (`_buildStatic`; `_buildProps` skips `isStaticEntry` props so nothing is built
  twice), props become DYNAMIC rigid bodies. See the Physics + netcode section below. Detail:
  `notes/restaurant-map.md`, `notes/disguise-anything.md`.
- **Per-object placement fields.** Each fixture/prop entry carries `type`, `x`, `z`
  and optional `y` (surface offset), `rot` (yaw radians), and — added with the level
  editor (2026-07-10) — `scale` (uniform, default 1). `scale` is applied **VISUAL-ONLY**
  in `scene.js` (fixture + prop meshes); prop `scale` reaches the renderer via a
  client-side index-zip in `main.js` (STARTED) onto the referee's prop instances.
  **`shared/` is untouched** (referee/protocol/physics) — so a scaled object renders
  exact but its Rapier collider stays base-size (documented gap; per the approved
  "client-side fix" scope). Every field is inert/absent on the existing maps. Detail:
  `notes/level-editor.md`.

## Physics + netcode (Rapier, host-authoritative prediction) — 2026-07 `physics-net`

Full detail in `notes/physics.md` + `notes/netcode.md`. The one-paragraph shape:

- **Engine:** Rapier (`@dimforge/rapier3d-compat`, WASM), in `shared/physics.js`.
  Lazy-loaded at match start only (headless load check stays clean). NOT
  cross-platform deterministic — which is exactly why netcode is host-authoritative
  with reconciliation, not lockstep.
- **Players** are kinematic capsule character bodies (run/jump, real collide-and-
  slide vs walls/fixtures — FIXES the old pass-through gap — shove dynamic props,
  can never be knocked over). A disguised player's capsule GIRTH is grown to the
  disguise footprint (solidity pass #3, `PhysicsWorld.setPlayerCollider`, capped at
  `rules.disguiseColliderMaxRadius` for doorway fit; total height kept constant) so a
  big disguise is solid instead of clipping into world props. **Map fixtures/walls/ground** are static colliders.
  **Dynamic props** are rigid bodies that get shoved (the TELL: real props tumble,
  a kinematic disguised player doesn't). A phone-safety cap
  (`rules.maxDynamicProps`, default 60) keeps extra props as static colliders.
- **Collider sizes** come from `shared/config/asset-dims.json` (measured normalized
  world-space bounds → cuboid) when populated, else from the hand-authored primitive
  footprints in `props.json`/`fixtures.json`. The measured file is the output of the
  bounding-box normalization build; it currently ships EMPTY (footprint fallback
  everywhere) with the wiring ready. Detail: `notes/asset-dims.md`.
- **ONE shared bounds source — `shared/bounds.js`** (pass #4). The world-space bounds
  of every collider and every mesh are derived HERE (reusing the same size helpers
  `physics.js` builds real colliders from). Three consumers read it so they can never
  drift: the `?debug=1` in-world collider wireframe (`scene.js`), the headless
  misalignment guard (`tools/check-physics.mjs`), and numeric diagnosis. Static-collider
  placement math mirrors `physics.js _buildStatic` (constants live in `bounds.js`). This
  is the structural answer to "the check passed but the game was broken" (see
  `notes/collider-debug.md` + `notes/physics.md` pass #4).
- **Depenetration failsafe is STATIC-ONLY** (pass #4). `_isPenetrating` (the anti-tunnel
  snap-back) queries only `PhysicsWorld._staticHandles` (ground/walls/static fixtures),
  never props — so a player shoving a knockable prop is never yanked back off it (that
  was the "bouncy invisible wall" regression). Collide-and-slide still blocks + shoves
  props; wall-top/floor tunnel recovery is preserved.
- **Host** runs the one authoritative world; broadcasts player transforms + AWAKE
  prop transforms at 15 Hz with an `ack` seq per player. **Guests + host** each run
  a local prediction world for their OWN player and reconcile (rewind to the
  authoritative pose, replay unacked inputs, ease/snap the residual) — this is full
  prediction + reconciliation, the target design, NOT the interpolation-only
  fallback. Remote players + awake props interpolate.
- **Disguise orientation lock:** a disguised prop keeps a fixed facing while moving
  unless right-click / ROTATE is held (yaw-only, never tips). Referee-authoritative
  via `dispYaw` in the snapshot.
- **Graceful degrade:** if Rapier fails to load, both host and client revert to the
  pre-physics flat 2D movement (no collision/jump/props) — playable, never a hard
  stop. The old map-edge clamp survives as a backstop behind the wall colliders.
- **Unverifiable headless:** the bot check is a load test. Netcode/physics FEEL
  needs a live multiplayer playtest (real people, real pings). Do not call it done
  until then.

## Movement convention (must stay in sync EVERYWHERE it's duplicated)

yaw about Y. forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
`vx = -sin*mz + cos*mx`, `vz = -cos*mz - sin*mx`, normalized if len>1, then
`pos += v * moveSpeed * dt`, clamped to `±(map.size/2 - mapMargin)`. Three.js
camera uses `YXZ` rotation order (yaw then pitch).

This exact horizontal formula now appears in THREE places and must stay identical:
`Referee.integrate` (2D fallback), `main.js` frame loop (2D fallback), and
`PhysicsWorld._substep` (the Rapier path both host + client use). Change all three
together. With physics active the horizontal displacement is fed to the character
controller (collide-and-slide) instead of applied raw, and a vertical `vy`
(gravity/jump) is added — but the input→direction mapping is the same. For the
host, reconciliation is near-a-no-op (authoritative pos tracks its prediction via
instant loopback); guests predict + reconcile against real latency.

## Phase state machine (referee-owned, in `shared/referee.js`)

LOBBY → (host START, ≥minPlayers) → HIDING (hunters frozen) → HUNTING → ENDING
→ LOBBY. Timers via `phaseEndsAt`. Hunters win when all props eliminated; props
win if the hunt timer expires with any prop alive.

**`minPlayers` is 1 (solo launch)** — the host can start alone. Role math keeps
≥1 prop (`hunterCount = min(max(1,round(n*hunterRatio)), n-1)`), so a solo host is
a prop; a zero-hunter round has no instant win and just runs on the timer.

**Mid-game join**: `addPlayer` is the single gate for everyone (host loopback +
each guest DataConnection). During HIDING/HUNTING it routes to `admitMidGame`,
which slots the newcomer in as a **hunter**, spawns them, and sends the SAME
filtered catch-up every guest gets (`STARTED` + private `ROLE` + current
phase/clock + normal snapshots) — never the host's full state. Guest side is pure
presentation (`STARTED` drops it into the running game). See
`memory/notes/game-loop.md`.

**Persistent lobby**: nothing tears down between rounds — peers stay open, players
survive, host stays host, map stays picked. `endRound` stores `lastResult`, which
rides `S2C.LOBBY` so the lobby shows the previous winner for back-to-back rounds.

## Lobby map selection (host-authoritative, single gate)

The host picks the round's map from the lobby. `C2S.PICK_MAP{mapId}` →
`Referee.setMapId(id, byId)` is the ONE validation point (host-only, LOBBY-only,
map must exist); the stored `Referee.mapId` is then trusted by `startMatch` and
`integrate` with no re-check. `mapId` rides `S2C.LOBBY` so late joiners see the
pick; `resetToLobby` deliberately keeps it (a map is a lobby setting, not
per-player state). Picker UI (`js/ui.js`) renders from `maps.json` and holds no
game logic — non-host disable is cosmetic. Detail: `memory/notes/map-selection.md`.

## Role/identity hiding

Snapshots expose `hunter: bool` (seekers are meant to be visible) and `disguise`
(the prop type a prop chose). They never expose which players are undisguised
props **to guests**. Own role comes via a private `ROLE` message. Two caveats,
both by design now: (1) the **host** holds the full state in its own tab, so it
can see undisguised props — an accepted cost of host authority; (2) an
undisguised prop still renders as a neutral capsule and so is visible while
moving — acceptable for the skeleton; see project-state open threads. Mid-game
joiners are guests too: `admitMidGame` sends them the same filtered
`STARTED`/`ROLE`/snapshot path, so late entry doesn't leak the host's full state.
