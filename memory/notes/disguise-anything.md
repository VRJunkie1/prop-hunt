# Disguise-anything (Part B, 2026-07-11) — everything except architecture

Requested & approved by VRmike. A player may now disguise as **ANY object they aim at
EXCEPT world architecture** (floors, boundary/room walls, wall panels/dividers, ceilings,
the ground). Explicitly IN now: all tables, chairs, food, the kitchen **vent/extractor
hood**, counters, cabinets, oven/stove, fridge, sinks, shelves, doors — and **PILLARS**
(VRmike wants pillar disguises; visual towers over the physics capsule — accepted).

## The one classifier (shared, so nothing drifts)

`shared/physics.js`:
- **`isArchEntry(c)`** — `!!(c.arch || c.floor || c.wall || c.ceiling)`. Architecture only.
- **`isDisguisableEntry(c)`** — `!!(c.shape && !isArchEntry(c))` = "has a renderable mesh AND
  not architecture". Every catalog entry has a `shape`, so effectively "not architecture".

`shared/config/fixtures.json` flags the 4 architecture entries with `"arch": true`:
`floor_kitchen`, `kitchen_wall`, `wall_post`, `wall_header`. Everything else stays
disguisable.

## Mechanism (minimal-ripple: physics + bounds + check-physics UNCHANGED)

The disguise raycast + `applyDisguise` key off the **prop stream** (`referee.this.props` →
scene `propMeshes`). Previously only `map.props` were disguisable; fixtures weren't in the
aim-able stream at all. Now:

- **`referee.startMatch`** promotes EVERY non-architecture fixture into `this.props`,
  `disguisable: isDisguisableEntry(...)`:
  - **dynFixtures** (knockable: tables, cookware, dishes, food) — already dynamic bodies;
    the `disguisable` flag just flips **false → true**. Biggest-first (dynamic-body cap
    ordering unchanged).
  - **staticFixtures** (bolted-in built-ins: counters, oven, fridge, cabinets, sinks,
    shelves, vent, doors, pillars) — NEW. Appended last (so they never touch the dynamic
    cap; they never simulate).
  Architecture is excluded from both. `disguiseProps` (`map.props`) also uses
  `isDisguisableEntry`.
- **`physics._buildProps`** skips any `isStaticEntry(c)` prop (`continue`): its immovable
  collider is already built by `_buildStatic` from `map.fixtures` — building a second (and
  on the host, DYNAMIC) body would double the collider / explode. So physics + `bounds.js`
  + `check-physics.mjs` are **untouched** (they still key off `c.static` from map data).
- **`scene.buildWorld`** renders a static-fixture prop as an **invisible aim PROXY**: the
  primitive is added with `visible=false` + its `propId` (the raycaster ignores visibility,
  so aim + highlight work), and it's NOT pushed to camera colliders and NOT `_queueModel`'d
  — the VISIBLE mesh + GLB come from the unchanged static scenery loop. Same pattern the
  codebase already uses (invisible primitives as raycast/camera proxies after a GLB swap).

Net: static built-ins now aim-able + disguisable, but their world collision and the
debug/collider-alignment machinery are byte-identical to before.

## Passability (verified)

`setPlayerCollider` grows the disguised capsule to the disguise footprint, **capped** at
`rules.disguiseColliderMaxRadius` (0.55) → diameter **1.10 m** < the 1.2 m doorway. So even
counter/fridge/oven/pillar disguises stay passable. `tools/check-disguise-eligibility.mjs`
asserts this for the giant types. A pillar's VISUAL height ≫ its capsule — intentional (same
as other large disguises; the capsule is the physics body, the mesh is the costume).

## Verification

- **`tools/check-disguise-eligibility.mjs`** (NEW, build-gating, zero-dep) — asserts
  vent/counter/oven/**pillar**/fridge/door ARE eligible and floor/wall/wall-panel/ceiling are
  NOT (both on named catalog entries and end-to-end on the restaurant map's promoted pool),
  plus the doorway-passability cap.
- `tools/check-physics.mjs` / `check-physics-solidity.mjs` still pass unchanged (static
  fixtures keep their `c.static` colliders).

## OWED — live pass

Confirm in a real match that a **pillar disguise works** (aim at a pillar, press disguise,
wear it, walk through a doorway), and that a few other new targets (counter, fridge, vent)
disguise cleanly.
