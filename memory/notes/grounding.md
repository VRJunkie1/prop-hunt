# Object grounding (floating props / sunken objects)

## What it is
`shared/grounding.js` `groundMapData(map, catalog)` — ONE pure, physics-free, deterministic pass
that keeps every map object resting on a real support. Wired into `js/config.js` `loadConfig`, the
SINGLE shared load point: it mutates the loaded map records IN PLACE, AFTER the measured+hull seams
attach and BEFORE anything consumes the maps, so the host referee's PhysicsWorld, every client's
prediction world, the renderer, the bounds/debug overlay and the disguise system all read the SAME
grounded `y`. Deterministic over the JSON → identical on every client + late joiner (no per-machine
physics settle → no desync). Guarded by `tools/check-grounding.mjs`.

## Why it is DELIBERATELY CONSERVATIVE (learned from the data, do not "improve" blindly)
The approved plan imagined "rest every piece on the collider-top beneath it." The dry-run
(`tools/_ground_dryrun.mjs`) DISPROVED that for this map:
- Several restaurant GLBs have a convex hull whose TOP is NOT their flat working surface:
  `table_food` hull = 1.39 m (a table WITH food modelled on it), `stove_plain` hull = 0.20 m even
  though a `stew_pot` correctly rests on its ~0.9 m cooktop (a bad/degenerate bake). So "rest on the
  hull-top" RAISED plates onto tabletops and SANK pots into stoves — ~36 correctly-authored items
  moved, and it wasn't even idempotent.
- The authored `y` values ARE the ground truth (the author tuned them against the real meshes); the
  collider hulls are not a trustworthy second opinion for surface height.

So the pass ONLY corrects the two UNAMBIGUOUS, support-independent failures:
1. **Orphan float** — a non-exempt piece hanging with NOTHING under it (no other footprint overlaps
   it at a lower height) and above its floor → drop to the floor (ground `y=0`, or the raised
   kitchen-floor tile it stands on).
2. **Below-floor sink** — base below its floor surface → rise to rest on it.
A piece resting on ANY support (plate on table, pot on stove, canister on counter) is left
byte-identical. `GROUND_TOL = 0.12 m` so authored clutter a hair proud of a surface is never nudged.

Exempt: architecture (`isArchEntry`) + the `noGround` flag — added to `extractor` (the VENT, mounted
at y=1.9 above the stove) and `door`, so removing a neighbour never drops them to the floor.

On the CURRENT maps the pass is a clean, idempotent NO-OP (no gross floaters/sinkers exist today).
It is a deterministic safety-net + regression gate for FUTURE edits (e.g. a future hide-spot removal
or map edit that orphans an item auto-drops it instead of leaving it hovering).

## Guard: tools/check-grounding.mjs
(A) fails the build if authored maps.json floats/sinks a non-exempt piece (catches the authoring
mistake before the load-time pass silently drops it); (B) self-tests a synthetic map to PROVE the
pass drops floaters, raises sinkers, leaves supported+exempt pieces, and is idempotent — so the
guard can never "pass by checking nothing"; plus an exemption-set sanity check (only door+extractor
carry `noGround`). Uses the SAME halfExtentsFor + hull/measured seams the engine uses.

## Honest limits (NOT auto-fixed — would break correct placements)
- Authored-`y` vs a GLB's real WORKING SURFACE (combined tables like `table_food`, cooktops like
  `stove_plain`): the collider hull can't tell you the flat surface height, so these can't be
  auto-grounded safely.
- The ~6 cm kitchen-floor-tile step (`floor_kitchen` collider top ≈ 0.06 while items in the kitchen
  are authored at `y=0`) makes kitchen built-ins sit slightly INTO the tile and a player standing on
  the tile disguise-render ~6 cm above them. Shifting the whole kitchen up ripples into new
  mismatches at the kitchen/dining boundary — left alone; it's small.
- Recommended follow-up if VRmike still sees visible float/sink: bake accurate surface heights /
  asset-dims for the combined GLBs (then the pass could be extended to rest on those), or a visual
  editor pass. Do NOT re-enable hull-top grounding without fixing those hulls first.

## Disguise alignment
Real object renders base at grounded `f.y`; a disguised player renders base at foot height `p.y`
(≈0 on the floor). For floor-resting built-ins (counters at `y=0`) these already coincide, so the
mimic matches. Because everyone reads the ONE grounded `y`, there is no second place for the numbers
to disagree.
