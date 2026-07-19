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
  rest of the game is input-agnostic. Two schemes, chosen once by
  `prefersTouchControls()` (2026-07-12: decides by POINTER CAPABILITY —
  `matchMedia('(any-pointer: fine)')`/`'(hover: hover)'` ⇒ desktop even with a
  touchscreen; only a no-fine-pointer device ⇒ touch. Fixes "touchscreen PC got
  phone controls". Pure+injectable, unit-tested in `tools/check-input-mode.mjs`):
  - **Desktop** — WASD + pointer-lock mouse look. **Owns the whole pointer-lock
    handshake**: requests capture on click of the `lockTrigger` (the "Click to
    play" overlay, which covers the canvas and swallows its clicks) and drives the
    overlay off the browser's real `pointerlockchange`/`pointerlockerror` signals
    (`onLockChange`/`onLockError`) — never a guess. Untouched by the touch work.
    **Mouse sensitivity (B4, 2026-07-18):** desktop look = `BASE_SENSITIVITY` (0.0022, the
    historical feel) × a multiplier; `setSensitivity(mult)` scales it LIVE (clamped to the exported
    `SENSITIVITY_RANGE` 0.2×–3×, default 1×). input.js only APPLIES it — `main.js` persists the
    multiplier to `localStorage` (`prophunt.sensitivity`) and restores it at boot. Touch drag-look
    (`touchLookSens`) is a separate, untouched knob. Detail: `notes/pc-feel-controls.md`.
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
  `memory/notes/hunter-character-model.md`. **Flicker/strobe fix (2026-07-13):** every
  PLAYER-ATTACHED mesh (skinned hunter, disguise GLB/primitive, capsule) is built through
  the ONE choke point `meshForPlayer` → module-level `preparePlayerModel(root)`, which
  traverses and sets `frustumCulled=false` + recomputes geometry bounds. This stops
  three.js from culling (blinking) a skinned mesh whose animation swings limbs outside the
  bind-pose sphere, and a disguise clone whose bounds lag its runtime rescale. WORLD
  props/scenery keep normal culling (surgical — only the handful of player objects opt
  out). Guarded by `tools/check-flicker.mjs`. Detail: `memory/notes/flicker-culling.md`.
  **LIGHTING OVERHAUL (VRmike, 2026-07-19):** scene.js owns a `LightingRig` (`this.lighting`, from
  `js/lighting.js`) that drives a 4-tier quality system (T0 potato → T3 bloom). `render()` delegates
  to the rig (direct render on T0/T1, an SSAO/bloom `EffectComposer` on T2/T3, falling back to direct
  while the addon passes lazy-import). Each lighting feature is an INDEPENDENT switch (SH ambient
  probe, straight-down contact-shadow light, angled fill, SSAO, bloom, shadow-map size); tiers are
  preset bundles resolved by the PURE `js/lighting-tiers.js`. `buildWorld()` ends with
  `_reattachLighting(map)` (scene.clear() drops the rig's lights → re-add + **bake the SH ambient
  probe** from the room center with a 64px `CubeCamera`→`LightProbeGenerator`, unless the map JSON
  carries pre-baked `sh` coefficients). Tonemap A/B (flat `LinearToneMapping` 1.25× multiply vs
  `ACESFilmicToneMapping`) + exposure ride the renderer so they work on every tier. A NEW
  `webglcontextrestored` handler rebuilds the composer + shadow map + re-bakes the probe (phones lose
  render state on tab-switch). `setRenderScale()` scales the pixel ratio for the auto-tier probe.
  Full detail: `memory/notes/lighting.md`.
- `js/lighting-tiers.js` (PURE) + `js/lighting.js` (THREE `LightingRig`) + `js/perfmon.js`
  (allocation-free CPU/GPU frame-cost stopwatch) + `js/auto-tier.js` (runtime FPS-probe controller —
  steps the tier DOWN once when GPU-bound, keeps+SAVEs if it helps else reverts + marks CPU-bound, then
  cools down; a manual pause pick always wins). `js/main.js` persists tier/tonemap/exposure to
  localStorage (`prophunt.lighting*` / `.tonemap` / `.exposure`), seeds the initial tier from
  `guessTierFromDevice` (GPU string via `WEBGL_debug_renderer_info`), instruments the frame loop
  (`perf.beginFrame`/`endCpu`), and drives the auto-tuner. The pause menu (`js/ui.js`/`index.html`)
  carries the "Lighting Quality" tier row + tonemap A/B + exposure slider; the `?debug=1` overlay
  (`js/debug.js`) shows the perf readout (FPS, CPU ms, inferred GPU ms, tier, CPU/GPU verdict). Guard:
  `tools/check-lighting.mjs` (8 headless sections incl. the rig THREE-mapping + the auto-tier state
  machine). Detail: `memory/notes/lighting.md`.
- `js/ui.js` — DOM screens (menu/lobby/game), HUD, feed. No game logic. **PC feel/controls
  (B4, 2026-07-18):** the pause menu carries a **mouse-sensitivity slider** (`#pauseSens`, 0.2×–3×)
  shown only on PC (`#pauseSensRow` hidden on touch via `prefersTouchControls()`); its `input` event
  fires `onSensitivityChange` LIVE while dragging (main.js applies + persists), and
  `setSensitivityValue()` reflects the restored value. An always-visible **PC controls reference**
  panel (`#controlsRef`, bottom-right, collapsible) is built by `buildControlsRef()` from the SAME
  `_controlsHtml()` rows the pause "Controls" panel uses (one source of truth — can't drift), hidden
  on touch. **ROLE-FILTERED (B8, 2026-07-18):** `_controlsHtml()` renders ONLY the current player's
  controls (prop OR hunter, or spectator while dead, or the shared move rows pre-role) off
  `ui._controlsRole`; `main.js` re-pushes it via `updateControlsList()` on every role change (round
  flip / team switch / death / respawn). Detail: `notes/pc-feel-controls.md`. The **HUD countdown
  timer is TICKED LOCALLY (2026-07-18, B1):** `setHud`/`setTimer` render via `formatClock` from
  the PURE `js/hud-timer.js` (`HudTimer`), which `main.js` re-anchors on every snapshot + phase
  event and ticks each frame — so a snapshot stall can't freeze/drift the clock (Jie's "5s left"
  while the host hit 0). Clamps at 0:00; round END stays host-authoritative. The HUD **health
  readout is a filled BAR** (2026-07-12, `#hudHealth` = `.health-fill` + centred `.health-label`;
  green→amber→red): `.hud-top` spans the row and `flex-wrap`s so the bar fills the spare width on
  PC and drops to its own full-width row on mobile portrait — two fixed CSS layouts, no runtime
  measurement. `setHealth(pct)` sets the fill width + label + warn/crit class. The
  "Click to play" overlay is shown/hidden by `setClickToPlay(visible, msg?)`, but the
  DECISION is **state-driven** in `main.js` (2026-07-12): the overlay shows only when the
  pointer is unlocked AND not `state.paused` AND not `state.uiMode` (desktop "UI mode" —
  backtick `` ` `` frees the mouse for the DEBUG menu WITHOUT opening pause; see
  `notes/pause-menu.md`). `msg` explains a lock refusal. This killed the old event-order
  race where whichever pointer-lock event fired last decided the overlay. **PC pause is
  ESCAPE-ONLY (2026-07-13):** `onLockChange` opens the pause menu only when the unlock was a
  real Escape (`unlockWasEscape()` = `document.hasFocus()` + no very-recent `window 'blur'`); an
  ambient pointer-lock loss (Alt-Tab / Windows key / other-window click) does NOTHING — no pause,
  no overlay, no blur; the game keeps rendering and just stops turning the camera until the player
  clicks back in. `input._releaseHeldInput()` (on `window 'blur'`) drops stuck held keys so
  focus-loss can't walk the avatar off. **Esc TOGGLES (2026-07-16):** `input.onRequestPause`
  derives the action from live state — taunt menu open → close it; pause open → `closePause` (was
  open-only, a second Esc did nothing); else `openPause`. Works because Esc reaches that handler only
  while the mouse is already free (pause/menu open ⇒ unlocked); the open-from-play path still routes
  through the browser lock-release. Touch untouched. See `notes/pause-menu.md`. Also paints a
  `direct`/`relayed` diagnostic badge per lobby row from `setLink()` — the
  connection-type is *detected* in `net.js`, never here. Also owns the hunter
  **blindfold** overlay via `setBlindfold(blind, seconds)` — a plain show/hide of the
  `#blindfold` blackout that `main.js` drives from a fresh
  `role === HUNTER && phase === HIDING` derivation (never latched). **Round-flip hardening
  (B8, 2026-07-18):** `main.js`'s `S2C.STARTED` handler resets blindfold + `lookFrozen` +
  spectator at the fresh-round seam so stale round-1 view-state can't bleed into a flipped
  round 2 (the "permanently blindfolded/unspawned on round 2" report); the server data gate is
  unchanged. Guard: `tools/check-round-flip-blindfold.mjs`. Anti-cheat detail:
  `memory/notes/anti-cheat-blindfold.md` (§6).
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
  box). **HELD-TOOL VISIBILITY (B7, 2026-07-18):** the SELECTED tool is now also synced so OTHER
  players see the right item in the hunter's hands on their third-person model (was: always a
  rifle). Host-authoritative RELAY: the client reports its selection (`C2S.SELECT_TOOL`, deduped,
  living-hunter-only), the referee validates (living hunter + `HUNTER_TOOL_IDS`) and rides a
  coerced `tool` in each player's snapshot entry; `scene._buildHunterModel` pre-builds all three
  held meshes (rifle GLB + cheap grenade/finder primitives) on the `Wrist.R` bone and
  `_applyHeldTool` toggles which is visible per hunter each snapshot. Purely cosmetic — the FIRE
  path (`SHOOT`/`FIND`/`GRENADE`) is unchanged and still client-driven. New meshes route through
  the `preparePlayerModel` anti-flicker choke point. Guard: `tools/check-tool-visibility.mjs`.
  Detail: `notes/hunter-tool-visibility.md`.
- **The rifle is host-authoritative** (same client-suggests/host-validates model as
  disguising). Client sends only its aim DIRECTION (`C2S.SHOOT`, from `scene.aimDirection()`
  = the SAME screen-centre ray as the disguise pick). `referee.applyShot` re-casts from the
  shooter's authoritative eye in the host's Rapier world (`physics.raycastShot` → `castRay`,
  own capsule excluded) and `physics.describeCollider` classifies the hit
  (player / prop / static-fixture-by-type / world) via handle→entity maps built at world
  construction. Everyone sees the tracer via `EVENT kind:'shot'` → `scene.spawnTracer`.
  **HITBOX ACCURACY (2026-07-13):** a player is hit through a disguise-shaped SHOT SENSOR
  (`physics.setShotCollider`, the same `shapeFor()` primitive the real prop uses), NOT the
  movement capsule — `raycastShot` excludes every movement capsule so "what you see is what
  you shoot" (a table disguise's corners hit; the tall capsule over a low disguise can't
  phantom-hit; no capsule+sensor double-hit). The sensor is a `setSensor(true)` collider on
  the same kinematic body, host-wired on disguise/undisguise + yaw-tracked to `dispYaw`, and
  is excluded from ALL movement/depenetration queries (movement capsule + `setPlayerCollider`
  unchanged). Full detail: `notes/hitbox-accuracy.md`.
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
- **SPECTATOR MODE (B6, 2026-07-18)** — a dead player gets a client-side **free-fly camera** +
  **player switching**. Fly (`scene.updateSpectateFly`) reuses the debug free-cam math clamped to the
  map bounds; follow (`scene.spectateFollow`) reuses the third-person orbit (`scene._orbitCameraTo`,
  extracted from `setCamera`) pointed at a watched live player; `js/main.js` `updateSpectatorCamera`
  drives it, `spectateCycle` rings `[free-fly, ...live players]` (PC click / Space, phone ◀/FLY/▶). The
  physics body stays dead/frozen; the ONLY server change is the anti-cheat gate: the blindfold's
  HIDING-phase withholding was extended from *hunter* to *hunter-OR-dead* (`broadcastSnapshot` +
  `setPhase` world catch-up), so a dead teammate on voice can't watch props hide — from HUNTING onward a
  spectator sees the full feed (disguised-prop names included). Docs: a "Spectating" block in
  `_controlsHtml` + an on-death hint. Guard: `tools/check-spectator.mjs`. Detail:
  `notes/spectator-mode.md` + `notes/anti-cheat-blindfold.md` (§5).
- **PROP FINDER (hunter tool #2, 2026-07-17)** — the second selectable tool beside the rifle
  (grenades come later). Unlike the rifle's client-only fire, activating the finder is
  **host-authoritative**: `C2S.FIND` → `referee.applyFind` (a LIVING HUNTER in HUNTING, off its
  PER-HUNTER cooldown `player._lastFindAt`) forces a RANDOM UNCANCELLABLE taunt out of every living
  prop within `rules.finderRadius` (8 m, **2D** distance — the AOE cylinder is effectively infinite
  height so height is ignored) by reusing the pre-existing `referee.forceTaunt` hook — the taunt
  system is otherwise UNTOUCHED. The victims taunt positionally for everyone through the existing 3D
  taunt path. Cooldown `rules.finderCooldownSeconds` (20 s) is host-enforced (a hacked client can't
  skip it) and reset to ready in `startMatch`/`resetToLobby`. The host replies `S2C.EVENT kind:'find'`
  privately to the acting hunter (`ok:true` cooldownMs/hits, or `ok:false` remainMs). **SOUND FOR ALL
  (2026-07-18):** a successful activation ALSO broadcasts `S2C.EVENT kind:'finderPing' {by,x,y,z}`
  (position only, no prop data) so EVERY client plays the ping positionally through the combat-SFX /
  master-limiter path (`case 'finderPing'`); the activating hunter ignores its own echo (`by===selfId`)
  and keeps the instant local ping. Client
  (`js/main.js`): `tryFinder` (LEFT-CLICK / mobile fire button while selected), a translucent AOE
  cylinder that follows the hunter (`scene.updateFinderZone`, green ready / grey cooling), the
  "Finder (14s)" countdown on the tool button (`ui.setToolCooldown`), a synthesized denied buzz on a
  cooldown click (`assets/finder/deny.wav` via `tools/gen-finder-deny.mjs`, played by
  `scene.playUiSound`), and a PROP taunt-UI LOCK while a forced (uncancellable) taunt plays
  (`ui.setTauntLocked` + `state.tauntLocked` gating open/send). Both knobs hot-tunable in
  `rules.json`. Guard: `tools/check-finder.mjs`. Detail: `notes/prop-finder.md`.
- **HUNTER GRENADES (hunter tool #3, 2026-07-17)** — the third selectable tool beside the rifle +
  finder, built on the finder's tool-selection infra (`HUNTER_TOOLS` gains `{id:'grenade',key:'3'}`;
  selectable on PC via key 3 / the tool bar AND on mobile by tapping the same button — the data-driven
  bar needs no separate mobile UI). Like the rifle it is **host-authoritative** and sends ONLY the
  aim direction: `C2S.GRENADE {dx,dy,dz}` → `referee.applyGrenade` (a LIVING HUNTER in HUNTING, NO
  cooldown) raycasts the aim through its own world (reusing the rifle's `raycastShot`) and explodes
  INSTANTLY at the first hit (no arc/travel/fuse). The client never sends a hit point, so a hacked
  client can't move the blast to fake a kill or dodge backfire. `_resolveGrenadeBlast(hunter,center)`:
  prop PLAYERS in range take `baseDamage×size-multiplier×falloff` (same `multiplierForDisguise` curve
  the rifle uses, so tiny props take proportionally more); the THROWING hunter takes BACKFIRE off
  non-player DECOY props only (disguisable, non-arch prop instances — the same objects the rifle
  backfires on), FLAT `baseDamage×falloff` with NO size mult so ~3 direct decoy hits are lethal
  (math, not hardcoded); NO friendly fire (other hunters never targeted) and NO direct self-damage.
  **REDEMPTION RULE (ordering is load-bearing):** compute all prop-player damage + all backfire → apply
  prop damage → if any prop PLAYER died, the thrower is restored to FULL HP and the backfire is forgiven;
  only if nobody died does the backfire land (may kill the hunter). Reuses `_damagePlayer` (incl. its
  prop-kill refill) + `describeCollider`. Config `rules.grenade` (`baseDamage` 0.45 = 45% of full
  health, `fullDamageRadius` 1, `falloffDistance` 2) is hot-tunable and authored as **1 + 2**, NOT a
  stored outer of 3 (VRmike's ask); pure `grenadeFalloff` in `shared/damage.js` (d≤1 full, d=2 half,
  d=2.99 ~0, d≥3 zero). Broadcasts `S2C.EVENT kind:'grenade'` for everyone's 3D explosion
  (`scene.spawnExplosion`) + a distance-scaled local screen flash (`scene.blastFlashAt` →
  `ui.flashScreen`). **FLING (2026-07-18):** step (4) of `_resolveGrenadeBlast` also shoves every loose
  DYNAMIC prop in range OUTWARD via NEW `physics.applyBlastImpulse(id,center,flingSpeed×falloff)` —
  speed LINEAR to the damage (close=big fling, edge=nudge), mass-scaled (+0.35 up bias), reusing the
  same `outer`/`grenadeFalloff` (no new balance math); host-authoritative on the Rapier bodies, rides
  the existing awake-prop snapshot stream (no new netcode). Disguised PLAYERS are kinematic → never
  flung (only world objects fly). `rules.grenade.flingSpeed` (8; 0 disables). Guard: `tools/check-grenade.mjs`. Detail: `notes/hunter-grenades.md`.

## Shared (`shared/`)

- `damage.js` — **HUNTER-TOOLS v1 damage math (PURE).** Imports only `physics.halfExtentsFor`
  (no Rapier/DOM) so the host referee and the offline guard run identical numbers. Lerps a
  size multiplier between `rules.damage` anchors over each disguise's collider footprint —
  ONE size source, auto-upgrades to measured `asset-dims` bounds when populated. Also holds the
  **grenade** helpers (`resolveGrenadeCfg`/`grenadeOuterRadius`/`grenadeFalloff`) — same PURE,
  shared-by-referee-and-guard pattern; outer radius is derived `fullDamageRadius + falloffDistance`.
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
  `notes/disguise-anything.md`.
  **EVERYTHING-IS-PHYSICS (2026-07-16, VRmike attempt #3):** the built-ins are no longer `static` —
  `oven/stove(s)/fridge/cabinet/cabinet_corner/counter/prep_sink/table_sink/shelf` are now shovable
  DYNAMIC bodies. ONLY architecture (floor/walls), the structural PILLARS, the DOOR and the
  vent/`extractor` stay `static`. Removing `static:true` flips a fixture cleanly (dynamic body in
  `_buildProps`, no `_buildStatic` collider, still rendered + disguisable — one flag, no double
  collider). Surface clutter (authored y>`rules.pinClutterAboveY`=0.5) is `pinned` → a FIXED collider
  even under the cap (else it launches out of a taller-than-visual hull like `table_food`). The
  referee orders dynamic candidates GLOBALLY biggest-first so `maxDynamicProps` (now 150) spends on
  the largest objects; the smallest scraps degrade to fixed colliders. Kitchen fixtures are seated on
  the 0.06 m `floor_kitchen` tile (bottom face on the tile). Guard: `tools/check-settle.mjs` (spawn
  the full map, step, assert nothing launches/sinks/drifts/tips). Detail: `notes/physics.md` +
  `notes/grounding.md` (2026-07-16).
  **FLOATING FIXED PROPS — round 4 (2026-07-17, VRmike, `build/118`):** the `pinClutterAboveY` PIN
  above is REMOVED — it froze surface clutter (plates/food/dishes) as FIXED colliders hanging in
  mid-air (VRmike's exact bug). The fixed-vs-dynamic rule is now the ONE predicate
  `physics.isFixedBodyEntry(c) = isArchEntry(c) || isWallAttachedEntry(c)`: FIXED iff architecture OR
  wall-attached (NEW `wallAttached` flag on door/vent/pillars — kept SEPARATE from the disguise list so
  those stay both disguisable AND immovable). EVERYTHING else is dynamic. Anti-launch is now at the
  source: `grounding.js seatMapData` seats each dynamic item on the collider beneath it (no
  interpenetration), and props spawn SEATED + ASLEEP (`body.sleep()`) so the dense map is quiet and
  clutter rests-until-shoved (wakes on contact). Degenerate hulls that misbehaved as dynamic bodies
  (`shelf`, `stove_plain`) carry a NEW `noHull` flag → symmetric primitive box. Guards:
  `tools/check-floating-props.mjs` (NEW, fail-first) + `check-settle.mjs` (rewritten). Detail:
  `notes/physics.md` + `notes/grounding.md` (2026-07-17).
  Adding maps/props needs no engine change; the lobby map picker renders
  any new map automatically. **`physics-feel.json`** (2026-07-11) holds the physics
  FEEL tunables (restitution / solver iterations / prop damping / anti-bob) — a
  physics-owned file, NOT `rules.json` (which is the referee's game rules);
  `config.js` loads it into `cfg.feel` and both the host world and every client
  prediction world derive feel from that ONE object via `physics.js resolveFeel()`,
  so tuning can never desync a match.
- `grounding.js` (2026-07-16) — **object grounding pass (PURE, physics-free).** `config.js`
  `loadConfig` runs `groundMapData(map, catalog)` on every map AFTER the measured+hull seams
  attach and BEFORE anything consumes the maps, mutating each fixture/prop `y` IN PLACE. So the
  host referee, every client prediction world, the renderer, the bounds/debug overlay and the
  disguise system all read the ONE grounded height — deterministic over the JSON, identical on
  every client (no per-machine physics settle → no desync). DELIBERATELY conservative: it only
  corrects orphan floaters (nothing beneath → drop to floor/kitchen-tile) and below-floor sinkers;
  a piece resting on any support is left byte-identical (several restaurant GLB hulls do NOT equal
  their flat working surface — `table_food` 1.39 m, `stove_plain` 0.20 m — so hull-top grounding
  would break correct placements). Exempt: architecture + `noGround` (the `extractor` vent, `door`).
  A NO-OP on the current maps; a safety-net + regression gate for future edits. Guard:
  `tools/check-grounding.mjs`. Detail: `notes/grounding.md`.
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
  still drives the Rapier world unchanged:** architecture + wall-attached fixtures become STATIC
  colliders (`_buildStatic`; `_buildProps` skips `isFixedBodyEntry` props so nothing is built
  twice — round 4, was `isStaticEntry`), everything else becomes DYNAMIC rigid bodies. See the Physics + netcode section below. Detail:
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
- **Load-time hide-spot removal (2026-07-16, VRmike — widened).** At match start the host
  deterministically deletes `rules.mapRandomizeSkip` (now **0.25**) of everything DISGUISABLE
  — `map.props` AND non-architecture `map.fixtures` (knockable + bolted-in built-ins), same
  `isDisguisableEntry` rule as the disguise pool; architecture is never removed. Props are
  trimmed via the concrete `STARTED{props}` list as before; fixtures via a new
  `STARTED{removedFixtures}` index set (also in the mid-join catch-up). Because built-ins
  render their mesh + static collider from LOCAL `map.fixtures`, every consumer keys off that
  one set — `scene.buildWorld` (skip mesh), `physics._buildStatic` (skip collider),
  `bounds.worldColliderBoxes` (skip debug wire) — so a removed built-in loses BOTH mesh and
  collider (no invisible wall / no ghost mesh). Detail: `notes/map-randomization.md`.

## Physics + netcode (Rapier, host-authoritative prediction) — 2026-07 `physics-net`

Full detail in `notes/physics.md` + `notes/netcode.md`. The one-paragraph shape:

- **Engine:** Rapier (`@dimforge/rapier3d-compat`, WASM), in `shared/physics.js`.
  Lazy-loaded at match start only (headless load check stays clean). NOT
  cross-platform deterministic — which is exactly why netcode is host-authoritative
  with reconciliation, not lockstep.
- **Players** are kinematic capsule character bodies (run/jump, real collide-and-
  slide vs walls/fixtures — FIXES the old pass-through gap — shove dynamic props,
  can never be knocked over). A disguised player's MOVEMENT collider IS the disguise's
  real prop shape (Part 1, `_buildMoveColliderDesc`/`setPlayerCollider`, the same
  `shapeFor()` cuboid/cylinder/cone/ball/hull the world prop uses, **uncapped** — the
  `disguiseColliderMaxRadius` cap only shrank the retired `_capsuleDimsFor` fallback),
  so a table-disguised player is solid AT TABLE SIZE and other players collide against
  that footprint (this IS the "solid shell" — there is no separate outward collider).
- **SOLID DISGUISED PLAYERS (2026-07-18, Jie).** A disguised player is kinematic
  (infinite mass), so a shove that slides a REAL dynamic prop stops dead against the
  disguised one — an immovable-wall tell. `PhysicsWorld._applyHeavyNudges` (host-only,
  end of each substep) lets a SUSTAINED push from another player slide a **disguised**
  target SLOWLY (`rules.heavyNudgeSpeed` 0.8 m/s, warm-up `heavyNudgeWarmupFrames`)
  along the push, resolved THROUGH the target's own controller (collide-and-slide vs
  walls, horizontal-only ⇒ no tip), so a disguised prop shoves like the real prop it
  imitates. Capped + host-authoritative ⇒ can't teleport-abuse; clients reconcile via
  the existing player-sync (no new netcode). Gated to disguised targets ⇒ hunter-vs-
  hunter / general player-vs-player is byte-identical (nudge-off == nudge-on there).
  `PhysicsWorld.resolveSpawnOverlap(id)` (called by the referee at the spawn choke
  points `_spawnOnTeam` / `_buildPhysics` / join-race) nudges a freshly spawned player
  out of anyone it materialised inside (shared hunter spawn, team switch, mid-join),
  wall-clamped, so nobody spawns fused. Guard: `tools/check-solid-players.mjs`. Detail:
  `notes/solid-disguised-players.md`. **Architecture + wall-attached pieces
  (pillars / door / vent, `isFixedBodyEntry`)** are static colliders; **everything else** (all props,
  ALL surface clutter, AND the un-`static` built-ins: counters/appliances/tables/chairs/crates) are
  **dynamic** rigid bodies that get shoved (the TELL: real props tumble, a kinematic disguised player
  doesn't). Round 4 (2026-07-17): the old `pinned` surface-clutter exception is GONE (it was the
  floating-fixed-props bug); clutter is dynamic, seated on its support, and spawns asleep. A
  phone-safety cap (`rules.maxDynamicProps`, now 150; ordered biggest-first) keeps the smallest overflow
  props as static colliders (seated, so resting not floating). See `notes/physics.md` (2026-07-17).
- **Collider shapes** are chosen by the ONE selector `physics.shapeFor()` in this order:
  **convex hull → measured cuboid → primitive**. (1) HULL: model-bearing, non-`arch`,
  box-shaped props/fixtures use a `ColliderDesc.convexHull` baked from the model's real mesh
  verts at final world scale — point clouds committed in `shared/config/hulls.json`
  (generated by `tools/build-hulls.mjs`, attached by `config.js` as `c.hullVerts`/`hullAabb`),
  so the collider hugs the real furniture. Deterministic + synchronous (baked, not generated
  from async GLB loads). Round items keep their primitive. Also covers a disguised player's
  movement + shot colliders (same selector). Detail: `notes/convex-hull-colliders.md`.
  (2) MEASURED: `shared/config/asset-dims.json` normalized world-space bounds → cuboid, when
  populated (ships EMPTY today). (3) PRIMITIVE: hand-authored `w/h/d/r` footprints in
  `props.json`/`fixtures.json`. A degenerate hull falls through to (2)/(3). Detail:
  `notes/asset-dims.md`.
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
  fallback. Remote players + awake props interpolate. **Object sync + world snapshot on
  release/join (2026-07-17):** a body that just fell asleep sends ONE final rest transform then
  the stream stops (`physics.awakeProps()` awake→asleep edge, part D). Because a blindfolded HUNTER
  is fed `props:[]` all through HIDING and everything has settled asleep by HUNTING, the instant
  `setPhase(HIDING→HUNTING)` fires every hunter gets a ONE-TIME `S2C.EVENT kind:'world'` full
  snapshot of all dynamic-body transforms (`scene.applyWorldSnapshot` SNAPS the render + prediction
  colliders) — else they'd see the factory-fresh map ("still upright"). The mid-join catch-up
  (`_propsCatchup(blind)`) is blindfold-gated the same way. All object data rides the SAME anti-cheat
  door the blindfold guards. Guard: `tools/check-object-sync.mjs`. Detail: `notes/netcode.md`.
  **Vertical reconciliation is FROZEN while the local player is airborne (2026-07-13 jump-judder fix):** the jump
  arc is deterministic from the shared gravity/jumpSpeed, so reconciling Y against
  15Hz phase-shifted, 1cm-quantised snapshots only injected a sawtooth camera judder
  (even on the host — the two worlds step out of phase). While `!state.grounded` the
  reconcile is skipped (a real >2.5m teleport still snaps); grounded play unchanged.
  Detail: `notes/netcode.md`.
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
together. **`moveSpeed` is the ONE run-speed knob (`rules.moveSpeed`)** read by all three,
so retuning it (B4, 2026-07-18: 6 → 9 m/s, +50%) speeds host + client in lockstep — no
desync, and no "moving too fast" sanity check to update (movement is host-authoritative from
input INTENT, never client positions). Hot-tunable; see `notes/balance-tuning.md`. With physics active the horizontal displacement is fed to the character
controller (collide-and-slide) instead of applied raw, and a vertical `vy`
(gravity/jump) is added — but the input→direction mapping is the same. For the
host, reconciliation is near-a-no-op (authoritative pos tracks its prediction via
instant loopback); guests predict + reconcile against real latency.

## Phase state machine (referee-owned, in `shared/referee.js`)

LOBBY → (host START, ≥minPlayers) → HIDING (hunters frozen) → HUNTING → ENDING
→ LOBBY. Timers via `phaseEndsAt`. Hunters win when all props eliminated; props
win if the hunt timer expires with any prop alive.

**Leaving is leave-proof (B2, 2026-07-18).** A player who leaves — GRACEFULLY (WebRTC close →
`net.js → removePlayer`) or via a SILENT TIMEOUT (a locked/dropped phone swept by `tick →
_sweepSilentPlayers`, `rules.leaveTimeoutSeconds`, active phases only, host never swept) — is fully
removed (physics body despawned, dropped from roster/snapshots/counts, public "X left" line). The
shared `checkRoundOver` recount reads per-round `_roundHad{Hunters,Props}` flags so a departed LAST
prop → hunters win and a departed LAST hunter → props win (a ghost can't keep a round alive or strand
it), while a hunter-less solo round still runs on the timer. Detail: `notes/netcode.md`.

**`minPlayers` is 1 (solo launch)** — the host can start alone. Role math keeps
≥1 prop (`hunterCount = min(max(1,round(n*hunterRatio)), n-1)`), so a solo host is
a prop; a zero-hunter round has no instant win and just runs on the timer.

**Mid-game join** (smaller-team, 2026-07-17): `addPlayer` is the single gate for
everyone (host loopback + each guest DataConnection). During HIDING/HUNTING it
routes to `admitMidGame`, which assigns the newcomer to the team with **fewer
players** (coin-flip on a tie — was "always hunter"), spawns them FRESH via the
shared `_spawnOnTeam` routine, broadcasts a public `kind:'log'` line, and sends the
SAME filtered catch-up every guest gets (`STARTED` + private `ROLE` + current
phase/clock + normal snapshots) — never the host's full state. Guest side is pure
presentation (`STARTED` drops it into the running game). See
`memory/notes/game-loop.md` + `team-switch-flipped-rounds.md`.

**Pause-menu TEAM SWITCH** (2026-07-17): `C2S.SWITCH_TEAM` → `applySwitchTeam`
respawns the sender FRESH on the opposite team via the same `_spawnOnTeam` routine
+ a public `kind:'log'` line. Host-authoritative, active-round only, NO
cooldown/anti-abuse (accepted per VRmike). `_spawnOnTeam` is the ONE shared
fresh-spawn-onto-a-team routine (team switch + mid-join can't drift).

**Endless flipped rounds** (2026-07-17): a round END no longer returns to the
lobby — `tick()`'s ENDING-expiry calls `startFlippedRound()` (flip every team, then
the shared `_launchRound()`) instead of `resetToLobby()`. `startMatch` was
refactored into assign-roles + `_launchRound()`; `_launchRound()` is the shared
round-start flow (props build, fresh spawn-by-role, ROLEs, STARTED, HIDING,
physics). `resetToLobby()` remains the empty-room fallback. `lastResult`/`S2C.LOBBY`
still exist for the (now first-round-only) lobby path.

## Lobby map selection (host-authoritative, single gate)

The host picks the round's map from the lobby. `C2S.PICK_MAP{mapId}` →
`Referee.setMapId(id, byId)` is the ONE validation point (host-only, LOBBY-only,
map must exist); the stored `Referee.mapId` is then trusted by `startMatch` and
`integrate` with no re-check. `mapId` rides `S2C.LOBBY` so late joiners see the
pick; `resetToLobby` deliberately keeps it (a map is a lobby setting, not
per-player state). Picker UI (`js/ui.js`) renders from `maps.json` and holds no
game logic — non-host disable is cosmetic. Detail: `memory/notes/map-selection.md`.

## Lobby name changes (host-authoritative, any player)

Any player — host or invite-link guest — can rename themselves from the lobby at any time.
Your OWN lobby row is an editable field (`ui.js _buildSelfNameField`); everyone else's is
read-only. Commit → `ui.onRename` → `session.rename(name)` → `C2S.RENAME{name}` → the ONE
gate `Referee.applyRename` (LOBBY-only; trims/caps-16/rejects-empty/de-dupes via
`_uniqueName`) → `broadcastLobby()` (the same rebroadcast a join fires, so late joiners
update live). Names already ride every snapshot/`STARTED`, and there are no nameplates in
`scene.js`, so the chosen name carries into the scoreboard/feed with no scene change. Renames
are ignored mid-round (scoreboards stay stable); the name is saved to localStorage
(`main.js saveName`) and pre-fills next time. Guard: `tools/check-lobby-rename.mjs`. Detail:
`memory/notes/lobby-rename.md`.

## Audio taunts (props, host-authoritative relay) — 2026-07-16

A prop plays an audio taunt as DIRECTIONAL 3D audio at its own world position for EVERYONE
(hunters locate props by ear — taunting is a deliberate self-snitch, allowed in any active
phase). Same host-authoritative relay pattern as `C2S.SHOOT`: client sends `C2S.TAUNT{id}` →
`Referee.applyTaunt` accepts only a LIVING PROP in HIDING/HUNTING with a real manifest id →
broadcasts `S2C.EVENT kind:'taunt'{by,id,uncancellable}`; every client plays the clip at that
prop's live position via `THREE.PositionalAudio`. `C2S.STOP_TAUNT` → `applyStopTaunt` relays
`kind:'tauntStop'{by}` unless the taunt was forced uncancellable. **`Referee.forceTaunt(propId)`**
is a dormant FINDER-TOOL HOOK (one line to wire) that forces a random uncancellable taunt.
- **Data-driven:** `assets/taunts/manifest.json` ({id,label,file}); adding the ~50 real clips
  later is data-only (drop files + manifest lines, ZERO code). `js/config.js` loads it into
  `cfg.taunts.taunts` (absent/empty tolerated); the referee validates against the SAME list.
- **Client:** `js/taunts.js` (`TauntLibrary`) lazy-loads + caches clips (fetch on first play,
  background `prefetch()` on menu-open; NEVER at join). `js/scene.js` holds the audio engine
  (`AudioListener` on the camera; one `PositionalAudio` emitter per taunter, keyed by id,
  repositioned each frame in `updateTauntEmitters`; per-emitter CUT-OFF — a prop's new taunt
  stops its previous one, different props overlap; INVERSE-SQUARE falloff tuned to `map.size` —
  exponential model + rolloff 2, refDistance = `size*√0.03` → 3% at one map width, knobs in
  `playTaunt`, never truly silent by design; **HRTF binaural panning** — each emitter's underlying
  PannerNode (`sound.panner`) gets `panningModel='HRTF'` for true front/back on headphones, guarded +
  fail-silent, from a CLIENT-SIDE `TAUNT_PANNING` knob `{model:'HRTF',fallback:'equalpower'}` — NOT in
  `shared/config/`, flip per-platform if mobile CPU ever stutters). `js/ui.js`
  owns the scrolling menu (STAYS OPEN across picks — spam is the feature) + taunt/stop buttons.
  Desktop `T` key / on-screen button open it (`state.tauntMenuOpen` frees the mouse like UI mode);
  iOS audio unlocked in the gesture (`scene.unlockAudio`). Guard: `tools/check-taunts.mjs`.
  **PC UX (2026-07-16, Jie):** the menu docks LEFT with NO background tint/blur (world stays visible),
  carries a discoverable `T / Esc to close` hint (hidden on touch), and an in-menu STOP button that
  silences your taunt without closing the menu; `T`/`Esc` close + re-lock. Detail:
  `memory/notes/audio-taunts.md`.
- **MASTER AUDIO LIMITER (2026-07-18, Jie).** ALL game audio (positional taunts + `playUiSound` UI
  blips + any future sound) sums at THREE's ONE shared `AudioListener` gain node before the speakers,
  so overlapping loud sounds can exceed 0dBFS and clip. `shared/audio-limiter.js` `installMasterLimiter`
  splices a headroom trim + near-brickwall `DynamicsCompressor` into the listener's single output hop
  (`listener.gain → preGain(0.7) → limiter(-6dB, ratio 20) → destination`), installed once from
  `scene._ensureAudioListener`. Pure Web Audio (no THREE) so the game + `tools/check-audio-limiter.mjs`
  (mock ctx) run the same code. Fail-silent: null/restores the direct connection on any failure — audio
  never breaks the game; iOS `unlockAudio` untouched. Web Audio has no true lookahead → a real one is a
  deferred AudioWorklet follow-up. Detail: `memory/notes/audio-limiter.md`.
- **COMBAT SFX (2026-07-18, VRmike B5).** Four synthesized combat sounds — gunshot, grenade blast,
  finder activation ping, and ONE shared prop "ouch" — hooked onto EXISTING broadcast events in
  `js/main.js onEvent` (shot / grenade / find-ok / hurt), NO gameplay/damage/netcode change. They reuse
  the taunt audio engine: `js/scene.js playPositionalSound(pos,buffer,opts)` plays a fire-and-forget
  POSITIONAL one-shot at a fixed world point through the SAME `AudioListener → master limiter` path
  (inverse-square falloff + HRTF), with an optional `playbackRate`. The shooter's own gunshot is
  non-positional (`playUiSound`) so it isn't self-panned. The prop ouch is PITCH-SHIFTED by prop size:
  `shared/damage.js ouchPlaybackRate`/`ouchRateForDisguise` derive the rate from the SAME
  `entrySize`/`halfExtentsFor` footprint the damage curve scales by (tiny = high squeak, big = low
  groan) — one size source, so pitch + damage can't drift. Sounds are our own generator scripts under
  `tools/` (like `gen-finder-deny.mjs`), fail-silent throughout. Detail: `memory/notes/combat-sfx.md`;
  guard `tools/check-combat-sfx.mjs`.

## Role/identity hiding

Snapshots expose `hunter: bool` (seekers are meant to be visible) and `disguise`
(the prop type a prop chose). They never expose which players are undisguised
props **to guests**. Own role comes via a private `ROLE` message — but as of the
**ROLE-CONVERGENCE fix (2026-07-18, B1)** that message is no longer load-bearing:
the client also derives its OWN role from its snapshot entry's `hunter` flag every
snapshot and self-heals to the host on any mismatch (`applyRole()` in `js/main.js`),
so a missed/mis-ordered ROLE across a flip / team switch / mid-join converges within
one snapshot instead of stranding the player as the wrong role. A recipient is always
present in its own snapshot (incl. the blindfolded-hunter + hunter-safe variants).
Guard: `tools/check-sync-convergence.mjs`. Two caveats,
both by design now: (1) the **host** holds the full state in its own tab, so it
can see undisguised props — an accepted cost of host authority; (2) an
undisguised prop still renders as a neutral capsule and so is visible while
moving — acceptable for the skeleton; see project-state open threads. Mid-game
joiners are guests too: `admitMidGame` sends them the same filtered
`STARTED`/`ROLE`/snapshot path, so late entry doesn't leak the host's full state.

**DISGUISE-INFO LEAK FIX** (2026-07-17): the pause-menu roster used to reveal what
every prop is disguised as ("VRmike — burger") to EVERYONE incl. hunters. The
render-facing `disguise` field MUST stay for hunters (a prop disguised as a burger
has to draw AS a burger on the hunter's screen — `scene.meshForPlayer` reads it), so
we can't strip it. Instead `broadcastSnapshot` sends HUNTER recipients (in HUNTING)
`hunterSafeSnapshot(full)` — identical EXCEPT every DISGUISED prop entry has its
`name` BLANKED. So a hunter's data keeps the render shape byte-for-byte but never
pairs a real NAME with a disguise (the roster leak). During HIDING the blindfold
already withholds all prop entries. Client `updatePauseScoreboard(…, selfIsHunter)`
also hides disguise labels from hunter viewers (belt-and-suspenders). Detail:
`memory/notes/team-switch-flipped-rounds.md`.
