# Convex-hull colliders for props & fixtures (collider overhaul, option 1)

Landed 2026-07-13 (`build/83-convex-hull-colliders-for`, VRmike). Read this before touching
collider shapes, `shapeFor`, the hull bake, or the disguised-player collider.

## What shipped
Every hand-guessed BOX collider on a **model-bearing, non-architecture** prop/fixture is now a
**convex hull generated from that model's ACTUAL mesh vertices** (Rapier
`ColliderDesc.convexHull`), at the model's final rendered world scale. So bullets and players
collide with something that hugs the real furniture (a chair's seat+back+legs silhouette, a
crate's box, an oven's body) instead of a loose cuboid. 49 types hulled; deliberately ROUND
items (barrels/balls/stools/plates/pots/bowls/cylinders — 40 types) KEEP their primitive (a
cylinder/ball hugs better than a faceted hull; plan step 6). Floors/walls stay cuboids (`arch`).

## The one decision point (no parallel path)
Hulls are the new **FIRST branch** in the single collider-shape selector
`shared/physics.js shapeFor()`: **hull → measured cuboid → primitive**. Everything that bakes a
collider flows through it, so all of these inherit hulls with zero extra wiring:
- world **dynamic props** and **static fixtures** (`_buildProps` / `_buildStatic`),
- a **disguised player's MOVEMENT collider** (`_buildMoveColliderDesc` → `shapeFor`), and
- a **disguised player's SHOT sensor** (`_buildShotColliderDesc` → `shapeFor`).
`halfExtentsFor()` got the matching hull-first branch (returns the baked world-space AABB), so
damage sizing, the depenetration proxy radius, and the debug wires all agree.

## Why BAKED, not generated at load time (deviation from the plan's step 3, deliberate)
The approved plan sketched generating hulls in-browser from the renderer's async-loaded GLB
verts and **swapping the live collider** at runtime. Instead the hull POINT CLOUDS are **baked
offline** into a committed data file (`shared/config/hulls.json`) by `tools/build-hulls.mjs` —
the SAME pattern as `tools/measure-glbs.mjs` → `asset-dims.json`. Same result (hulls from the
real mesh verts, at final scale) but strictly better on the plan's own risk axes:
- **Determinism** — every peer loads identical committed bytes → identical
  `ColliderDesc.convexHull` (same WASM, same Float32Array) → host & client prediction never
  fight. No dependence on an async GLB download completing; the plan's "async window" is gone.
- **Synchronous at match start** — no spawn-on-primitive-then-swap; the world builds hull
  colliders immediately in `shapeFor`, like it builds a measured cuboid.
- **Zero new runtime machinery** in the sensitive physics/netcode layer — the disguised-player
  path already rebuilds colliders (`setPlayerCollider`, landed in the disguise-collider build),
  and that's the ONLY runtime rebuild; props/fixtures are one-shot at build.
- **Cost** — re-run `node tools/build-hulls.mjs` after adding/replacing any restaurant GLB
  (identical authoring workflow to measure-glbs). If you skip it, colliders just fall back to
  the primitive (never broken).

## The bake (`tools/build-hulls.mjs`, authoring-only)
1. Parse each candidate GLB's raw POSITION vertex stream (decode the BIN chunk; mirrors
   measure-glbs's node-world-matrix math — the FBX2glTF `scale:[100,…]` node scale is applied).
2. **Scale trap care**: scale by the SAME factor the renderer uses (`native × map.modelScale
   0.75`; a per-entry `modelScale` would win but none is set), then recenter exactly like
   `scene.js instantiateModel` (base at y=0, x/z centred), then shift the AABB centre to the
   origin — the collider-local frame `shapeFor` expects (centred; caller translates to
   `halfH+f.y` so the base lands on the floor). Verified: baked hull AABB == fresh GLB mesh
   bbox for all 49 (`check-collider-visual.mjs` hull section).
3. **Point reduction**: deterministic support-point sampling over the 6 axes + 260
   Fibonacci-sphere directions. Support points are always ON the hull; including the 6 axes
   makes the reduced set's AABB EQUAL the mesh AABB (covers the visual exactly), and it can only
   under-approximate slightly (stays INSIDE the mesh) → can never bulge out and entomb. 12–105
   points per model. No randomness → byte-stable re-runs.
4. **Degenerate guard**: `shapeFor` falls through to measured/primitive if
   `ColliderDesc.convexHull` returns null (flat/inside-out). None do today (checked live).

## SAFETY SCAN — VRmike's entombment concern (plan step 1)
A single hull of a ROOM SHELL or a MERGED multi-object mesh becomes one solid block that would
seal players inside. The bake scans every candidate and EXCLUDES (keeps on primitive, names in
the report) anything that is **room-scale** (largest world footprint > min(8, mapSize/3)) or a
**multi-object mesh** (>1 disjoint island — union-find over primitive AABBs with a 0.15-native
gap; a chair's seat+legs+back collapse to one island, a kit of separate wall panels wouldn't).
**Verdict this build: "all pieces, no room shells"** — every one of the 49 candidates is a
single-island, sub-room-scale PIECE. Zero exclusions. (The known multi-panel KIT GLBs —
`modular_walls`, `modular_kitchen_parts` — aren't referenced by any catalog entry; the walls use
primitive boxes and `counter` uses `kitchen_cabinet`, so nothing kit-shaped ever reached the
scan.) Verdict is stored in `hulls.json.scan` and re-asserted by `check-true-colliders.mjs`.

## ACCEPTED cost — hulls fill concavities ("filled-in" offenders)
A hull seals openings and undersides. Worst offenders the group should know about:
- **`shelf`** — the shelf's open compartments seal shut (can't shoot through the gaps).
  NOTE it's a static THIN PANEL, so the world collider is actually the anti-tunnel THICKENED BOX
  (`_buildStatic` grow path wins over the hull for thin static panels — same as `door`); the
  hull is still used when a PLAYER disguises as a shelf. Either way its openings are closed.
- **`dishrack`** — open rack becomes a solid block.
- **tables** (`kitchen_table`, `large_table`, `table_food`, `table_sink`) — you can no longer
  hide UNDER a table; the hull spans leg-to-leg under the top.
- **`diner_chair`** — seals under the seat / between the legs.
This is the known option-1 tradeoff. Option 2 (V-HACD convex DECOMPOSITION) is the future fix if
it plays badly — it would keep the openings. Documented for the group, not fixed here.

## Coordination with the disguise-collider build (constraint 4 — SATISFIED)
The disguise-collider-replacement build (`54fb2bf`, landed FIRST) already routes a disguised
player's movement collider through `shapeFor` (the prop's true shape, not a grown capsule). This
build landed SECOND, so per the request it makes the disguised player's collider a **hull too**:
because `_buildMoveColliderDesc` and `_buildShotColliderDesc` both call `shapeFor`, a player
disguised as a hulled prop now gets a **hull movement collider AND a hull shot sensor** at the
disguise's rescaled world size — no extra code. Proven live: `check-true-colliders.mjs`
(disguised-as-hull → movement=mesh, sensor=mesh) and `check-physics-live.mjs`
(hull-disguise grounds stably, foot on floor, walks). The KinematicCharacterController drives a
convex hull fine (a hull is convex, like the cuboid/cylinder/ball it already handled).

## Verification
- `tools/build-hulls.mjs` — prints the safety-scan verdict + per-type hull report.
- `tools/check-true-colliders.mjs` — EVERY baked hull builds a convex-hull (mesh) collider in
  the live engine (0 fell back to a box), bases rest on the floor, disguised-player move+shot
  colliders are hulls, safety verdict recorded.
- `tools/check-collider-visual.mjs` — attaches hulls like config.js, asserts each hull AABB ==
  fresh GLB mesh bbox (the "hull verts lie on/inside the mesh bounds AND cover them" check;
  catches a scale-trap or a stale hull → "re-run build-hulls.mjs").
- `tools/check-physics-live.mjs` §hull-disguise — hull movement body grounds/walks.
- Full harness green: check-combat, check-physics, check-physics-solidity, check-physics-feel,
  check-blindfold, check-disguise-eligibility, check-flicker. Page boots clean (0 console
  errors, normal + ?debug=1). The magenta **True Colliders** debug overlay already draws
  ConvexPolyhedron (type 9) from `shape.vertices`, so hulls are visible in-game for eyeballing.

## Files
`tools/build-hulls.mjs` (new), `shared/config/hulls.json` (new, generated), `js/config.js`
(attach hullVerts/hullAabb), `shared/physics.js` (shapeFor + halfExtentsFor hull-first branch),
`tools/check-collider-visual.mjs` + `tools/check-true-colliders.mjs` + `tools/check-physics-live.mjs`
(hull assertions). NO change to netcode/protocol/referee/scene render (the True-collider overlay
already handled convex meshes). NO change to `_buildStatic`/`_buildProps` placement logic — the
hull rides the existing translate/rotate path via `shapeFor`'s `{desc, halfH}`.

## OWED — live pass
Enable **True Colliders** (magenta) in the debug menu: prop/fixture hulls hug the models (chairs,
crates, appliances, tables). Shoot a chair/table at its real silhouette (edges register; the old
loose-box air around legs no longer whiffs — WYSIWYG). Confirm the "filled-in" tradeoff is
acceptable (can't shoot through a shelf's gaps / hide under a table). Disguise as a chair/crate
and check you fit + collide like the prop. Phone-host FPS with ~49 hull colliders in play (hulls
cost a little more than boxes; lower `rules.maxDynamicProps` if a warm phone hitches).
