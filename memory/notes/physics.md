# physics (Rapier)

Landed in the big physics + netcode pass (2026-07-09, `physics-net`). Read this
before touching movement, collision, or the disguise orientation lock.

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
- **Colliders are cuboid/cylinder/cone/ball approximations of the catalog
  primitive** (`shapeFor`), NOT convex hulls baked from the GLBs. Deliberate: the
  GLBs load async and can fail, so hull-from-mesh would make the collision shape
  non-deterministic and race the sim. The primitive footprint is already the
  design's size target, so the box is faithful enough. Upgrading dynamic props to
  convex hulls (once their GLB is cached) is a future refinement, not v1.

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
