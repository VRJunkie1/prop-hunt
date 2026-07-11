# physics (Rapier)

Landed in the big physics + netcode pass (2026-07-09, `physics-net`). Read this
before touching movement, collision, or the disguise orientation lock.

## 2026-07-11 PHYSICS FEEL TUNING (on `main`) — Jie's three dials + anti-bob
Small focused feel pass after a live playtest reported: players push deep INTO props
before they react; standing on objects causes constant up/down bobbing; everything
feels bouncy/jello. NO architecture change — only tuning constants + one minimal
controller-grounding tweak. **Feel itself is NOT verified (can't be, headless)** — the
values below are the starting point for Jie's next live playtest.

- **NEW config file `shared/config/physics-feel.json`** — physics-owned tunables so a
  feel-test can retune without a rebuild. Put here (NOT `rules.json`, which is the
  referee's game rules) because these are physics internals. `config.js` fetches it
  (tolerant of absence) into the shared `cfg.feel`; that ONE object flows to BOTH the
  host's authoritative world (`referee.js` → `PhysicsWorld({feel})`) and every client's
  prediction world (`main.js buildPredict` → `PhysicsWorld({feel})`), so the two sims
  can never derive mismatched feel and rubber-band. `shared/physics.js` `resolveFeel()`
  is the ONE derivation point (defaults baked in; null-safe if the file is missing).
- **Dial 1 — restitution 0 on ALL colliders.** `feel.restitution` (0) applied
  explicitly to the ground slab, boundary walls, static + floor fixtures, dynamic prop
  colliders, AND the static-overflow prop colliders. Rapier's default is already 0, so
  this is belt-and-suspenders + a single future dial. The player capsule is KINEMATIC —
  restitution is meaningless on it, so it's deliberately not "set" there (no pretend
  edit). Swept the tree: the only pre-existing `setRestitution` was the dynamic prop
  line (already 0.0) — now sourced from config; no stray non-zero values anywhere.
- **Dial 2 — solver stiffness.** `world.integrationParameters.numSolverIterations`
  raised 4→**12** and `numAdditionalFrictionIterations` set to **4** (Rapier 0.14 is
  TGS-soft, so these are the right knob names — verified against the pinned
  `@dimforge/rapier3d-compat@0.14.0` API, not guessed). FEATURE-DETECTED via `'x' in ip`
  before writing, with a pre-TGS `maxVelocity/maxPositionIterations` fallback, so an API
  mismatch silently no-ops instead of throwing. This is the main fix for both
  sink-into-props penetration and most of the bobbing. **Perf watch:** higher iterations
  cost CPU every frame — if a PHONE HOST dips below 60fps, this is the FIRST dial to back
  down (try 8). Applies to host + client identically.
- **Dial 3 — prop damping.** Dynamic props now read `feel.propLinearDamping` (**0.4**)
  and `feel.propAngularDamping` (**0.4**, was hardcoded 0.7) so a nudged prop settles
  instead of oscillating. Linear was 0.5 → 0.4. Player capsule unaffected (kinematic).
- **Dial 3b — standing-on-prop anti-bob (`_substep`).** The reported standing bob is a
  feedback loop: a kinematic capsule resting on a dynamic prop pushes it down via the
  controller's impulses, the prop springs back next frame, snap-to-ground chases it. Fix
  (`feel.capGroundedImpulse`, default ON): when a player is grounded AND standing still
  (`len < 1e-3`, not jumping), `setApplyImpulsesToDynamicBodies(false)` for that player's
  compute — no push-down → no bob. While MOVING, impulses stay ON so walking into a prop
  still shoves it (the prop-vs-disguise TELL is preserved). Toggled per-player right
  before its `computeColliderMovement` (the controller is shared but used serially);
  method-guarded. Simpler than tracking which body is underfoot, and can only ADD
  stability (never introduces instability).
- **Invariant lock (headless-verifiable) — `tools/check-physics-feel.mjs`** (NEW,
  authoring-only, never shipped/imported, like `measure-glbs.mjs`). Runs the SAME
  `resolveFeel()` both sims use, asserts host==client derivation, that empty config
  degrades to rigid defaults, and range-checks the dials (restitution 0, iterations
  8..16, damping 0.2..0.8). Feel can't be tested headless; config PARITY between the two
  sims can — a future mismatch fails this check instead of desyncing a match. Run:
  `node tools/check-physics-feel.mjs`.
- **Files:** `shared/config/physics-feel.json` (new), `js/config.js`,
  `shared/physics.js` (`resolveFeel` + integration params + restitution/damping/anti-bob
  wiring), `shared/referee.js` (`this.feel` → opts), `js/main.js` (feel → predict world),
  `tools/check-physics-feel.mjs` (new).
- **STILL NEEDS A LIVE FEEL-TEST (Jie):** do props now stop sinking / resolve rigidly;
  is the standing-on-a-crate bob gone; do shoved props settle without wobble; does a real
  shove still read as a tell. Bring a PHONE — if the host phone drops below 60fps with
  12 solver iterations, lower `numSolverIterations` first.

---

## 2026-07-10 PLAYTEST FIX PASS (on `main`) — anti-tunnel, failsafe, static flags
Post-merge punch-list fixes (VRmike+Jie). Structural-verified; feel owed a playtest.

- **STATIC FLAGS WERE MISSING on `main` (the real fix #1).** `fixtures.json` shipped
  with NO `static`/`decor` flags, so `isStaticEntry()` was false for every fixture →
  the referee promoted floors/walls/pillars/doors/appliances into the DYNAMIC prop
  stream (biggest-first, so they claimed the cap and the room collapsed; tables sank
  into jittering dynamic floor tiles). Re-added `"static": true` to the genuine
  built-ins ONLY: `floor_kitchen`, `kitchen_wall`, `pillar`/`pillar_b`, `door`,
  `wall_post`/`wall_header` (new divider), `oven`, `stove`/`stove_plain`/`stove_single`,
  `fridge`, `cabinet`/`cabinet_corner`, `extractor`, `counter`, `prep_sink`/`table_sink`,
  `shelf`. Everything else stays unflagged = dynamic: **all tables** (round/kitchen/
  table_food/large/small), dishrack, and every plate/bowl/pot/pan/lid/dish/food/
  condiment/canister. `isStaticEntry` (`c.static || c.decor`) is unchanged — only the
  DATA was missing.
- **Thick floors + outer walls (fix #5, `_buildStatic`).** Ground slab is now 3 m thick
  extended DOWN (top still y=0). Boundary walls are 1.5 m thick pushed OUTWARD (inner
  arena-facing face unchanged, so player collision is identical) and 5 m tall (base y0,
  no jump/fly-over). Fixtures flagged `"floor": true` get a ≥1 m collider extended
  DOWNWARD, visible top held flush (top = 2·halfH + f.y → centre drops by half the
  added depth). `halfExtentXZ()` helper reads the floor's w/d. Render meshes untouched.
- **CCD (fix #6).** `body.enableCcd(true)` on the kinematic character capsule (swept vs
  tunneled) and `RigidBodyDesc.setCcdEnabled(true)` on dynamic prop bodies. Both
  method-guarded so an older Rapier build can't throw.
- **Fall-through failsafe (fix #4).** `PhysicsWorld.respawnEscaped(minY)` teleports any
  dynamic prop whose centre fell below `minY` back to a stored spawn transform
  (`propBodies[].spawn = {x,y,z,q}`), velocities zeroed. The player half lives in the
  referee (host-authoritative, ~0.5 s throttle) using `setPlayerPosition`. See
  `referee.js` integrate + notes.

---
(Everything below documents the earlier passes and is still current.)

## 2026-07-10 FIX PASS (physics-net) — controller, knockable world, calm start
Playtest-driven fixes. All in `shared/physics.js` + `shared/referee.js` + the two
readers (`js/scene.js`, `js/main.js`) + catalog flags (`shared/config/*`).

- **DIAGNOSIS CORRECTION (honest):** the "clips in then shoots off like a bullet"
  hypothesis was *translate-first + penetration recovery*. The shipped branch code
  did NOT do that — `_substep` already calls `computeColliderMovement()` and applies
  the CORRECTED delta (never translates first). And prediction already uses the SAME
  `PhysicsWorld` as the host (main.js `buildPredict`), so "one shared mover" was
  already true. What WAS broken and is now fixed:
  - **Jump jitter (real):** `enableSnapToGround` was always on, so snapping fought
    every ascending jump. Now toggled per-substep: snap OFF while `vy > 0`, ON when
    `vy <= 0`. (`_substep`.)
  - **Shoving props:** added `setCharacterMass` (rules.characterMass 3.0) so walking
    into a chair shoves it via `setApplyImpulsesToDynamicBodies` at a sane weight
    instead of flinging a near-massless body. Prop density raised 0.6→1.0
    (rules.propDensity). Both need a LIVE feel-test.
  - **Fixed timestep:** `step(dt)` now banks time in `_acc` and runs ONLY whole
    `_fixedDt` (1/60) substeps — no variable partial tail (was `world.timestep=sub`).
    Deterministic replay; `world.timestep` is constant. Render interpolation of the
    LOCAL predicted pose is NOT separately added (pose read fresh post-step; at
    60/30 fps the substep count is stable, so no visible stepping) — feel-test item.
  - Controller offset 0.02 (rules.controllerOffset), autostep 0.5→0.3, snap distance
    0.3 (rules.snapDistance). `disableSnapToGround` call is method-guarded.
- **STATIC/DYNAMIC FLIP (fix #2):** the world defaults to KNOCKABLE now. A single
  classifier `isStaticEntry(catalogEntry)` (exported from physics.js) returns static
  only for catalog entries flagged `"static"` (bolted built-ins: floor, walls,
  pillars, doors, extractor/hood, counters, cabinets, oven, fridge, sinks, shelves)
  or `"decor"` (tiny fixed dressing — thin cut-food/garnish, lids, the shelf paper
  towel — kept static so they don't form unstable micro-stacks or spawn inside a tall
  fixture's cuboid). EVERYTHING else — tables, cookware, plates, dishes, whole food,
  condiments — is a dynamic rigid body. Flags live on the CATALOG entry
  (`fixtures.json`), read identically by physics (`_buildStatic` skips non-static),
  scene (`buildWorld` skips non-static; they render via the prop stream), and the
  referee.
  - **Decoupled dynamic-ness from the disguise pool.** The referee now builds ONE
    prop stream = `map.props` (disguisable:true, the disguise pool — unchanged) PLUS
    every non-static `map.fixtures` entry (disguisable:false — shovable but never
    wearable). Both get ids + rigid bodies + scene containers + awake-sync for free.
    `applyDisguise` (host) and `tryDisguise` (client) skip `disguisable:false`.
  - Dynamic-body cap raised 60→130 (rules.maxDynamicProps). Restaurant ≈ 136 dynamic
    candidates → ~6 smallest overflow to static. Props are listed biggest-first after
    the disguise pool so the cap spends budget on furniture; overflow degrades to
    solid static colliders (collidable, not shovable). **Phone HOST perf is the
    flagged risk** — lean on aggressive sleeping; lower the cap if a warm phone hitches.
- **DISGUISE READS LIVE POSITIONS (fix #2):** props move now, so `applyDisguise`
  measures range against a prop's LIVE x/z (`referee.propLive`, seeded at spawn,
  updated from awake transforms each tick), not its map position. Tag already used
  live *player* positions, so it was unaffected. Disguised PLAYERS stay kinematic /
  script-driven — never shoved.
- **MID-JOIN CATCH-UP (fix #8):** a knockable world means a late joiner must get the
  CURRENT prop transforms or they'd see kicked chairs back at spawn. `admitMidGame`
  now sends `_propsCatchup()` — each prop's live centre + quaternion from
  `PhysicsWorld.allProps()` (awake OR asleep). STARTED prop entries are spawn-form
  `{id,type,disguisable,x,y,z,rot}` OR live-form `{…,x,y,z,qx,qy,qz,qw}` (presence of
  `qx` marks live). scene.buildWorld + physics._buildProps both branch on it.
- **CALM MATCH START (fix #3):** dynamic bodies spawn `SPAWN_EPS` (0.02) above their
  rest height so nothing begins interpenetrating (which the solver would eject).
  Bodies settle in the first frames, then sleep. Nothing overlaps at spawn by
  construction (map places items apart; stacked items have increasing y). The
  start-of-match settle of ~130 bodies is the perf/feel item to watch live.
- **MERGE BLOCKER (honest):** the task asked to FIRST `git merge origin/main` for the
  bbox-normalized layout + populated `asset-dims.json`. There is NO shell here (by
  design), so I could not run the merge, and main's populated blobs are zlib git
  objects the file tools can't inflate. BUT the measured-bounds CONSUMPTION path is
  already wired on physics-net (`shapeFor`→`c.measured`, scene→`c.measured`, config.js
  attaches it) with a graceful fallback to authored footprints. So once that data
  lands via a shell-side merge, colliders bake from measured bounds automatically with
  no further code change. `asset-dims.json` is still `dims:{}` here → authored
  footprints in use. Someone with a shell must do the merge before/with this branch.

## Engine + where it runs
- **Rapier** (`@dimforge/rapier3d-compat`, WASM) via `shared/physics.js`
  (`PhysicsWorld` + `loadRapier()`).
- **Lazy loaded**, exactly like three/PeerJS/nipplejs: the dynamic
  `import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm')`
  + `RAPIER.init()` only runs at MATCH START (host `startMatch` → `_buildPhysics`;
  guest `STARTED` → `buildPredict`). A bare landing page fetches nothing, so the
  headless load check stays clean. The compat build inlines its WASM as base64 —
  no separate `.wasm` request.
- **Two independent worlds exist during a match:**
  1. **Authoritative** — one `PhysicsWorld({dynamicProps:true})` in the HOST's
     referee. All players are kinematic character bodies; all `map.props` are
     dynamic rigid bodies that can be shoved. This is the truth.
  2. **Prediction** — one `PhysicsWorld({dynamicProps:false})` in EVERY client
     (host + guests) holding just the LOCAL player against static geometry +
     props-as-fixed-obstacles. Drives instant, collision-correct local movement.
     (Yes, the host runs both; it needs local prediction because its own
     authoritative pose only arrives via 15 Hz loopback snapshots.)

## Bodies & colliders
- **Players**: `kinematicPositionBased` capsule (radius `playerRadius` 0.4,
  half-height `playerHalfHeight` 0.5 → rests base at y=0, centre at 0.9 — matches
  the render capsule). Moved by one reusable `KinematicCharacterController`
  (autostep, snap-to-ground, slide, `setApplyImpulsesToDynamicBodies(true)` so a
  walking player shoves props). Players **cannot be knocked over** — kinematic
  bodies ignore impulses entirely.
- **Static fixtures / walls / ground**: solo (parent-less = fixed) colliders,
  cheap. Ground is a thin slab with its top at y=0; boundary walls match the
  renderer's enclosing box; each `map.fixtures[]` entry becomes one collider.
- **Dynamic props**: `dynamic` rigid bodies (host only) with damping so they
  settle + sleep. Small props are light (density × small volume) so they fly;
  big props resist — a free lean toward the roadmap's size/damage idea.
  **Phone-safety cap** (`rules.maxDynamicProps`, default 60): only the first N
  props become dynamic rigid bodies; extras become solid STATIC colliders (still
  collidable, just not shovable). Restaurant (~56 props) is under the cap → no
  change today; protects future dense maps + phone hosts. Guests build ALL props
  static regardless (they don't own prop motion). See `_buildProps`.
- **Collider source — measured bounds first, primitive footprint fallback**
  (`shapeFor`):
  1. If `c.measured` (a normalized world-space `{w,h,d}` box from
     `shared/config/asset-dims.json`, attached by `config.js`) is present, bake a
     **cuboid from the measured bounds** — the design intent, real sizes not
     guessed. See `notes/asset-dims.md`.
  2. Else fall back to the **catalog primitive** cuboid/cylinder/cone/ball
     (hand-authored `w/h/d/r`). This is what ships until the bounding-box build
     populates `asset-dims.json` (currently EMPTY → fallback path everywhere).
  NOT convex hulls baked from the GLBs — deliberate: GLBs load async and can fail,
  so hull-from-mesh would make the collision shape non-deterministic and race the
  sim. Upgrading dynamic props to convex hulls (once their GLB is cached) is a
  future refinement, not v1.

## Movement / jump
- Same forward/right formula as the referee + client (`architecture.md` Movement
  convention). Horizontal desired = `moveSpeed·dt` in look-yaw space; vertical is
  a per-player `vy` integrated by `gravity` (rules.json, 22), with `jumpSpeed` (8)
  applied only when `computedGrounded()`. Fixed 1/60 substeps, capped at 4 per
  `step(dt)` (mobile spiral guard).
- **Jump** input: Space (desktop) / JUMP button (touch), held. Physics only jumps
  when grounded (bunny-hop on hold — fine).

## Disguise orientation lock (the "fake nudge" precursor)
- A disguised prop keeps a FIXED facing while it moves (`player.dispYaw`, frozen
  in `applyDisguise` at the current look yaw). Holding **right-click** (desktop) /
  **ROTATE** (touch) sets `rotUnlock`, which lets `dispYaw` follow look yaw again —
  yaw ONLY, it never tips (players are kinematic capsules; there is no pitch/roll
  to leak). Snapshots broadcast `dispYaw` as the player's `yaw` when disguised, so
  every other client sees the lock; `main.js` mirrors it on the local own-model via
  `scene.setCamera(..., selfDispYaw)`.
- Movement direction still follows the look yaw — only the VISUAL orientation is
  locked. That's the intended "prop slides without turning" tell-softener.

## Netcode coupling (see netcode.md for the full story)
- Host broadcasts only **awake** prop transforms (`PhysicsWorld.awakeProps()` skips
  sleeping bodies) → near-zero bandwidth when nothing's moving.
- Guests predict the local player and **reconcile**: each snapshot carries per-
  player `ack` (last `INPUT.seq` the host applied); the client rewinds its predict
  body to the authoritative pose and replays unacked inputs, easing the residual
  via a decaying `corr` offset (snap if > 2.5 m).
- Remote players + awake props are **interpolated** from snapshots (`scene`).

## Graceful degrade (important)
- If Rapier can't load (CDN blocked / headless), BOTH sides fall back to the old
  flat 2D movement — no walls, no jump, no props, but fully playable. Never a hard
  stop. Host: `referee.integrate` has a 2D branch. Guest: `main.frame` has a 2D
  prediction branch. This is why the game still runs even if `+esm` breaks.

## Known caveats / untested
- **Cannot be feel-tested headless.** Prediction/reconciliation jitter, prop
  shove rubber-band (guest predicts props as fixed; host shoves them → reconcile),
  and jump smoothness all need a LIVE multiplayer playtest with real pings.
- Prediction samples input at 60 fps but the host applies 20 Hz-sampled input, so
  replay is finer than the host — small residual, absorbed by `corr` each snapshot.
- Restaurant map is collider-heavy (~90 fixtures + ~56 dynamic props). Fine on
  desktop; a phone HOST runs the full dynamic sim + could be heavy. Substep cap +
  sleeping props mitigate; watch it in the playtest.
- Props placed with a y-offset (food on tables) are now dynamic: at match start
  they settle onto the table/counter collider beneath them (or fall to the floor
  if none) instead of floating. Minor start-of-match jitter for those few items.
- The player capsule is player-sized, not disguise-sized — a player disguised as a
  big crate has a small collider (can clip the crate silhouette into a wall a bit).
  Accepted; matches the design (capsule matches the player).
