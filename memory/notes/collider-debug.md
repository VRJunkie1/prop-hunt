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

## What it does NOT show
It draws collider GEOMETRY. It cannot show a BEHAVIOURAL bug (e.g. the depenetration failsafe
snapping a player back) — for those, watch how the player/props move against the boxes. The
2026-07-11 "bouncy invisible wall" was behavioural (see `physics.md` pass #4): the boxes were
correct; the failsafe was wrongly treating prop boxes as immovable.
