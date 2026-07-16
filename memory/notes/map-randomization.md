# Map randomization / hide-spot removal (load-time gaps)

At match start the HOST deterministically deletes a fraction of the scene so hiding spots
differ each round and there are gaps for prop players to hide in. One decision, made once,
host-side; clients build from the concrete result (never the seed) so there's zero desync.

## What it covers (2026-07-16, VRmike — widened)

Originally only `map.props` (the disguise pool) were thinned. VRmike's directive: apply the
removal to **EVERYTHING a prop player can disguise as**. So it now also deletes disguisable
**fixtures** — both knockable ones (tables/cookware) and bolted-in **built-ins** (counters,
pillars, fridge, doors, sinks, shelves, the vent). ARCHITECTURE (floors/walls/ceilings,
`isArchEntry`) is the one thing NEVER removed. The eligibility rule is the SAME shared
`physics.isDisguisableEntry` the disguise pool uses, so removal and the pool can't drift.

Ratio: `rules.mapRandomizeSkip` = **0.25** (was 0.20). Floor: `rules.minPropsKept` (6) survivors
on each side (props / fixtures) so a sparse pool never empties.

## The decision, in ONE place: `referee.startMatch`

- `this.matchSeed` = per-match random uint32 (host only; never on the wire).
- Props: `seededSkipSet(nProps, seed, ratio, minKept)` → skip set over `map.props` indices.
  Survivors become `disguiseProps` (each carries `mi` = source index for the scale-zip).
- Fixtures: build `eligibleFixtureIdx` = the ORIGINAL `map.fixtures` indices where
  `isDisguisableEntry`. Run `seededSkipSet(eligible.length, seed ^ 0x9e3779b9, ratio, minKept)`
  over just those slots (decorrelated seed so props & fixtures don't thin the same relative
  positions), then map back to real indices → `removedFixtures` (a Set of real indices).
  `this.removedFixtures = [...removedFixtures]`.
- The surviving non-arch fixtures (excluding `removedFixtures`) are split into `dynFixtures`
  (knockable, biggest-first for the dynamic-body cap) + `staticFixtures` (built-ins), promoted
  into `this.props` as before (Part B).

## The single upstream trim → everything downstream agrees (the stuck-spot guarantee)

A disguisable BUILT-IN has THREE representations on a client, from TWO data sources:
1. visible mesh — LOCAL `map.fixtures` (scene.buildWorld static-scenery loop),
2. static collider — LOCAL `map.fixtures` (physics `_buildStatic`; mirror in bounds.js),
3. invisible aim proxy — the `this.props` stream (STARTED broadcast).

Removing #3 alone would leave a built-in visible + solid but "gone" — worse, dropping the mesh
but keeping the collider = an **invisible wall** (the exact stuck-spot failure to avoid). So the
host broadcasts `removedFixtures` (index set) in **STARTED** (and in the mid-join
`admitMidGame` catch-up), and every consumer keys off it:

- `js/main.js` STARTED → `state.removedFixtures`, threaded to `scene.buildWorld(...)` and
  `buildPredict(...)`.
- `js/scene.js buildWorld` — static-scenery loop skips removed indices (no mesh, no camera
  collider). Stored on `this._removedFixtures` so the debug collider-view mirrors it.
- `shared/physics.js` — `PhysicsWorld` opts `removedFixtures`; `_buildStatic` skips them (no
  collider). Built identically on the host world (from `referee.removedFixtures`) and every
  guest predictor (from STARTED).
- `shared/bounds.js worldColliderBoxes(map, catalog, rules, removedFixtures?)` — optional param
  so the `?debug=1` / debug-menu overlay draws exactly the kept set (matches physics). Omitted
  by the headless checks → byte-identical to before.

Net: a removed built-in loses BOTH its mesh and its collider on every peer; a kept one keeps
both. They can never disagree — `tools/check-hide-spot-density.mjs` asserts scene-set ==
physics-set == overlay-set across 200 seeds.

## Intended quirk (VRmike, accepted)

At 25% across everything disguisable, some rounds a pillar / fridge / door is simply absent —
an open gap. That's the point (more variety, more hiding gaps); expect the room to look a bit
different each round. Removal only ever FREES space, so it can't create a stuck spot on its own
— the only risk is the half-removal (mesh vs collider) that the single-trim design forecloses.

## Dynamic-body cap interaction (unchanged machinery)

Removal happens BEFORE `_buildProps`' `maxDynamicProps` (130) cap. Overflow past the cap already
degrades to a **solid static collider** (fully collidable, not shovable), biggest-first — so
adding dressing never loses solidity and needs no hand-marking. With 25% removed each round the
per-round candidate count is if anything lighter than the old 20%.

## Verify

`tools/check-hide-spot-density.mjs` — ratio 0.25; removal reaches fixtures; arch never removed;
render/collider/overlay consistency across seeds; determinism + min-keep; spawn + doorway
clearance under worst-case (nothing removed) density; density additions present.
</invoke>
