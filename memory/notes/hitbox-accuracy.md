# Hitbox accuracy — disguise-shaped shot sensor + collider/visual audit

Landed 2026-07-13 (`build/69-hitbox-accuracy-fix-requested`, Jie). Read this before touching the
shot raycast, the disguise collider, or the prop catalog dims.

## The problem
Shots re-cast on the host (`referee.applyShot` → `physics.raycastShot` → `describeCollider`) tested
against the MOVEMENT capsule. A disguised player's capsule is a person-shaped capsule grown to the
disguise's smaller horizontal half-extent (capped 0.55) with height held at ~1.8 m — so:
- shots at a table disguise's visible CORNERS whiffed (round capsule ≠ square table); and
- shots ABOVE a low disguise hit air-that-reads-as-player (the 1.8 m capsule pokes over a 0.75 m table).

## The fix — a second, shot-only SENSOR collider (`shared/physics.js`)
Each player carries `p.shotCollider` on the SAME kinematic body as the movement capsule:
- Built by `_buildShotColliderDesc(type)`: disguised → `shapeFor()` of the real prop (the SAME
  cuboid/cylinder/ball/cone the world prop uses, from catalog/measured dims), translated so its BASE
  rests on the foot (`halfH - _pCenterY`), exactly like the drawn disguise mesh; undisguised → a
  capsule matching the base body. ALWAYS `setSensor(true)`.
- `setShotCollider(id,type)` builds/replaces it (no-op if unchanged); `setShotColliderYaw(id,yaw)`
  rotates it about +Y to track `dispYaw` (via `setRotationWrtParent`, verified present in
  rapier-compat 0.14) so a turned box is shot at its TRUE corners.
- A SENSOR produces no contact forces and is excluded from EVERY movement/depenetration query
  (`computeColliderMovement`, `_isPenetrating`, `rotationWouldCollide` all pass EXCLUDE_SENSORS;
  `_depenetrateFromProps` uses a props-only predicate) — so it can never block/push/bump a body or
  another player. **The movement capsule (`setPlayerCollider`) is byte-for-byte unchanged.**

### Shot ray reads the sensor, never the capsule
`raycastShot` now passes a `castRay` filterPredicate that EXCLUDES every player's movement capsule
(only when that player has a live sensor — a build failure falls back to the capsule). So a player is
hit ONLY through their sensor → "what you see is what you shoot", and there is no capsule+sensor
double-hit (castRay returns the single nearest anyway; the shooter's own body+sensor are excluded via
`filterExcludeRigidBody`). `describeCollider` classifies the sensor as `{kind:'player',id}`.

### Who wires it (HOST referee only — the client prediction world never raycasts shots)
`applyDisguise`, `debugMorph`, `debugSetTeam→hunter`, `addPlayer` (mid-game), the `_buildPhysics`
load-race, and the integrate join-race all call `setShotCollider(id, disguise||null)`. `integrate`
calls `setShotColliderYaw(id, dispYaw)` each tick for disguised players (right after
`updateDisguiseRotation`). Guarded everywhere (`if (physics.setShotCollider)`), so the 2D fallback is a no-op.

## Debug visibility (`js/scene.js`)
`_addPlayerShotWire(entry)` draws the shot hitbox as an ORANGE (`0xff8c1a`) wire, distinct from the
GREEN (`0x7be38b`) movement-capsule wire, parented to the (yawed) player mesh so it tracks the
disguise. Added wherever `_addPlayerColliderWire` is (buildColliderView + syncPlayers rebuild), cleared
in `_clearColliderView`. Sized from the SAME `halfExtentsFor` the sensor bakes from. Toggle via ?debug=1
or the debug menu "Colliders". (Only REMOTE players get wires — self is first-person; use free cam.)

## The audit (`tools/check-collider-visual.mjs`) + the catalog fixes
Parses each referenced GLB's native bbox from the GLB binary (inlined copy of measure-glbs's parser),
computes the RENDERED size via `bounds.meshSize(c, 0.75, freshNativeDims)` (native × map.modelScale, or
`modelDims`), compares to the collider footprint (`halfExtentsFor`). FAILS a BOX entry whose collider
under-covers on any axis by >5 cm AND >8%; for ROUND entries the horizontal is inscribed-by-design
(reported), the height is asserted. 31 offenders were found and widened in props.json/fixtures.json to
cover the rendered model (WYSIWYG). See `notes/asset-dims.md` for the modelScale-vs-modelSize quirk and
the asset-dims.json staleness this surfaced.

## Verify (`tools/check-combat.mjs` section G — live Rapier)
Stands up the REAL `PhysicsWorld` with a box "table" disguise and fires rays: corner/edge → player;
just-outside + above-the-low-silhouette → miss; rotated-45° corner → player (yaw tracking); post-
undisguise → sensor tracks the current shape. Skips (never fails) if Rapier isn't installed. Damage-
vs-CURRENT-disguise stays proven in section E. `@dimforge/rapier3d-compat@0.14.0` added to
devDependencies (+ package-lock) so `npm install` lets the live sections run headless.

## Invariants a future change must not break
- The movement capsule and `setPlayerCollider` sizing/behaviour stay exactly as-is (physics passes #3–#5).
- The sensor is HOST-only, never enters movement/depenetration, never collides.
- The shot ray hits sensors, not capsules; no double-hit; host stays authoritative.
- NO trimesh colliders (phone-host perf) — primitives matched to visuals only.
