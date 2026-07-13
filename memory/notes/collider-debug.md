# collider debug view (`?debug=1`)

Added 2026-07-11 (physics pass #4). The point: physics bugs took four attempts partly because
nobody could SEE the colliders — every diagnosis was guessed from behaviour. Now you can look.

## How to use
Append **`?debug=1`** to the game URL (e.g. `https://<hash>.prop-hunt.pages.dev/?debug=1`) and
start/join a match. Every physics collider is drawn as a wireframe box **over** the world:

- **grey** — the ground slab (its top sits on `FLOOR_Y=0`, extended ~1.5 m down).
- **red** — the four boundary walls (pushed outward; inner face is the real play edge).
- **cyan** — static fixtures (walls, counters, appliances, pillars, door, floor tiles),
  including the thin-wall thickening the anti-tunnel pass applies.
- **yellow** — each prop's collider, parented to the prop's container, so it **tracks the prop
  live** as it's shoved (a moving yellow box = a real dynamic body; the disguise-vs-prop tell).
- **green** — each remote player's MOVEMENT capsule (walk/collision body).
- **orange** — each remote player's SHOT hitbox (the disguise-shaped shot sensor a bullet tests
  against; capsule-matching when undisguised). Added 2026-07-13 (hitbox accuracy). Parented to the
  (yawed) player mesh, so a table disguise's orange box turns with it. If the orange box doesn't hug
  the visible disguise model → that's a collider/visual mismatch (shots would whiff at the gap); the
  headless `tools/check-collider-visual.mjs` gates the same thing. NOTE: wires are drawn for REMOTE
  players only (self is first-person) — use the debug free cam to inspect your own.

If a cyan/red box floats in open space with no mesh under it → that's an invisible wall. If a
prop's mesh sits outside its yellow box → that's the ghost-prop misalignment. Both are now
obvious instead of inferred.

## Where it lives
- Drawn in `js/scene.js`: `_buildStaticColliderDebug()` (static world, from
  `shared/bounds.js worldColliderBoxes`) + `_addPropColliderWire()` (per prop, from
  `physics.js halfExtentsFor`). Gated on `this._colliderDebug`, read once from the URL in the
  constructor. `scene.rules` (set by `main.js ensureScene`) feeds the thin-wall thickening so
  the overlay matches the engine exactly.
- The boxes are `THREE.LineSegments`, NOT added to `scene.colliders`, so they never affect the
  third-person camera raycast or the disguise-aim raycast. `buildWorld`'s `scene.clear()` drops
  them on the next match, so there's no leak.

## Why it can't lie
The overlay reads `shared/bounds.js` — the SAME module `tools/check-physics.mjs` checks and the
SAME collider-size helpers `shared/physics.js` builds real colliders from. So "what you see in
`?debug=1`", "what the guard asserts", and "what the engine simulates" are one source. If they
ever diverge, that's the bug — fix `shared/bounds.js` and `physics.js _buildStatic` together
(the constants and placement math are mirrored there with a "MUST match" comment).

**2026-07-13 (convex-hull round 3):** `worldColliderBoxes` now mirrors `_buildStatic`'s
`hasTrueShape` gate — a fixture with a baked hull (or measured bounds) uses its mesh-hugging shape
and is NOT thickened (the anti-tunnel grow is a fallback for un-hulled primitives only), and the
box footprint comes from `halfExtentsFor` (the hull AABB). So the AABB "Colliders" overlay no
longer draws the oversized loose boxes VRmike reported around the walls/archway; the "True
Colliders" magenta overlay draws the exact convex polyhedron. Both agree with the engine.

## TRUE Rapier collider overlay — "True Colliders" toggle (2026-07-13, VRmike)
The overlay above (and the box/capsule "Colliders" toggle) draws **box/capsule approximations**
built from `shared/bounds.js` — AABBs and capsules sized from the collider source. That is NOT
necessarily the shape Rapier actually simulates. VRmike couldn't stand on some counters as a tiny
prop even though the box helpers showed nothing in the way → the real physics geometry differs
from the boxes. So this build added a SEPARATE **"True Colliders"** debug-menu toggle that reads
the shapes STRAIGHT from the live Rapier world and draws each in its REAL form.

- **Where:** `js/scene.js` `setTrueColliderView(on)` + `updateTrueColliders(physicsWorld)` +
  `_buildTrueColliderWire(col)` + `_trueShapeKey(col)`. Driven by `js/debug.js`
  `_toggleTrueColliders()` (button "True Colliders", separate from "Colliders" so BOTH can be on
  for side-by-side comparison) and refreshed every frame from `debug.frame()`.
- **Reads the engine, not the mesh.** `updateTrueColliders` walks `physicsWorld.world.forEachCollider`
  and, per collider, reads `col.shape` (Rapier `Shape` — `halfExtents` for cuboid, `radius`/
  `halfHeight` for capsule/cylinder/cone, `radius` for ball, `vertices`/`indices` for trimesh/convex)
  and `col.translation()`/`col.rotation()`. Cuboid → box edges; ball/capsule → wireframe; cylinder/
  cone → edges; trimesh/convex hull → the REAL triangle mesh (WireframeGeometry over the vertex/index
  buffers). A "compound" collider is just several colliders on one body, so it appears as several
  wires naturally (no special case). Colour is a distinct **MAGENTA (0xff37e6)** so where the true
  shape and the old box overlay disagree is obvious — exactly VRmike's counter symptom.
- **Which world.** `debug._trueWorld()`: on the **HOST** it uses the authoritative world
  `session.referee.physics` (holds EVERY player capsule — local + remote — plus all props + shot
  sensors); on a **GUEST** it falls back to the LOCAL prediction world `state.predict` (static
  geometry + props + our OWN capsule). Remote players are not simulated in-browser on a guest
  (they're interpolated visual meshes), so their true colliders only appear on the host — an
  inherent limit of the client-prediction model, documented, not a bug.
- **Cost control.** Wire geometry is built ONCE per collider `handle` (a trimesh vertex read is
  expensive) and cached by a shape-key; each frame only the transform is updated. A shape change
  (disguise resize → new capsule radius) rebuilds that one wire; a vanished handle (prop removed,
  match end) is pruned. Torn down on toggle-off and on return-to-menu/lobby (`debug.resetView`),
  and dropped by `buildWorld`'s `scene.clear()` (trackers reset there too).
- **Verified against the real engine:** `tools/check-true-colliders.mjs` stands up the shared
  `PhysicsWorld` and asserts every simulated collider maps to a known shape branch (no
  "unsupported"), transforms are readable, and directly-built TriMesh/ConvexPolyhedron classify as
  mesh wires. `tools/check-debug-menu.mjs` §7 locks the toggle + both wiring paths.

## LOCAL player's own collider now shows in the EXISTING display (2026-07-13, VRmike)
The box/capsule collider view used to draw only OTHER players' capsules — the local player's own
capsule never appeared. Cause: `_buildColliderView`/`syncPlayers` iterate `scene.players` (REMOTE
only); the local player is `scene.selfMesh` (not in that map). Fix: `scene._addSelfColliderWires()`
attaches the SAME green movement-capsule + orange shot-sensor wires to `selfMesh`, called from
`_syncSelf` (live, when the view is on) and `_buildColliderView` (toggle-on rebuild). Only shows
when a self body exists (`_wantSelfMesh()` = third-person OR free cam), so a first-person hunter
still shows none in this view (use the true-collider view or free cam) — but a third-person PROP
(VRmike's case) now sees his own capsule against the counter.

## What it does NOT show
It draws collider GEOMETRY. It cannot show a BEHAVIOURAL bug (e.g. the depenetration failsafe
snapping a player back) — for those, watch how the player/props move against the boxes. The
2026-07-11 "bouncy invisible wall" was behavioural (see `physics.md` pass #4): the boxes were
correct; the failsafe was wrongly treating prop boxes as immovable.
