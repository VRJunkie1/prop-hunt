# Object grounding (floating props / sunken objects)

## 2026-07-17 — SEATING PASS + everything-dynamic (floating-fixed-props round 4, VRmike)
The 2026-07-16 note below says "do NOT re-enable hull-top grounding without fixing those hulls
first." Round 4's directive (everything non-architecture is a dynamic body that FALLS) forced the
issue, so we added a SEPARATE, NARROW pass that seats ONLY what would otherwise launch — and left
`groundMapData` exactly as-is.
- **NEW `seatMapData(map, catalog)`** — runs at load AFTER `groundMapData` (js/config.js). For each
  DYNAMIC (non-fixed) item, if its base sits more than `SEAT_TOL` (0.02 m) BELOW the top of the
  collider actually beneath it (a tall/degenerate hull it was authored INSIDE — e.g. a `dinner` at
  0.81 inside `table_food`'s 1.39 m hull), it is RAISED onto that collider top. So a newly-dynamic
  prop spawns RESTING, never interpenetrating → it can't launch when it wakes. Iterated to a fixed
  point (stacks seat bottom-up). Pure geometry over the SAME `halfExtentsFor` footprints physics
  bakes → deterministic, identical on every client. Idempotent. Fixed bodies (arch + wall-attached)
  keep their authored heights.
- **`supportTopUnder` — two hard-won guards** (both bugs found live in `_probe_seat`): (1) SKIP FIXED
  pieces as supports — a counter authored 9 cm from a wall-post is NEXT TO it, not resting ON it;
  counting the 2.8 m wall top as a "support" launched the counter to 2.8 m. Clutter only rests on
  DYNAMIC furniture; the floor tile is handled by `floorUnder`. (2) REQUIRE `SUPPORT_MIN_DROP` (0.05)
  of drop — two items at nearly the same height (burger layers) must not seat onto each other or they
  leapfrog upward forever (climbed to 2.02 m before the guard).
- **`findFloatingProps` / `findEmbedded`** — non-mutating inspectors for the NEW guard
  `tools/check-floating-props.mjs` (see notes/physics.md round-4 section). `findFloatingProps` also
  detects a re-introduced y-threshold PIN (pass `opts.pinY`) so the guard can prove-itself by failing
  on main's pin. The FIXED-vs-DYNAMIC classifier itself is `physics.isFixedBodyEntry` (arch OR
  wall-attached) — see notes/physics.md.
- The degenerate hulls the 2026-07-16 note flagged (`stove_plain` 0.20 m, `shelf` off-COM) are now
  fixed at the source with a `noHull` catalog flag (use the symmetric primitive box) rather than
  worked-around — so seating them behaves.

## 2026-07-16 — TIGHT SINK TOLERANCE + kitchen seated on its floor (VRmike attempt #3)
VRmike's sunken counters were REAL and the guard was WRONG. Mechanism (root-caused via git —
original to commit `9ee0f7d` "fix #5 THICK FLOORS", 2026-07-10, NOT a regression from the collider
overhauls): the restaurant kitchen sits on a raised `floor_kitchen` tile whose collider TOP is at
y=0.06, but every kitchen fixture (counter/fridge/oven/stove/cabinet/sink…) was authored at y=0, so
each was buried 6 cm. A player disguised as a counter stands ON the tile (feet at 0.06), so their
disguise floated 6 cm ABOVE the real counters — his exact complaint. The old guard passed because
`classify()` reused the lenient `GROUND_TOL = 0.12` for BOTH float AND sink, swallowing the 6 cm.
- **FIX 1 — the check now proves itself.** `SINK_TOL = 0.02` (tight; clipping into a floor is never
  OK) is now used for the SINK branch of `classify()`; `GROUND_TOL = 0.12` still governs FLOAT
  (clutter a hair proud is fine). Verified fail→pass: the guard FAILED on 44 sunk kitchen items,
  then passed after seating.
- **FIX 2 — the whole kitchen stack seated on the tile.** `tools/_seat_kitchen.mjs` (one-time
  migration) added `floorUnder` (=0.06) to the `y` of EVERY non-arch item over a tile — fixtures AND
  the clutter resting on them — so a counter's bottom face sits ON the tile AND its canisters/pots
  stay resting on the counter (coherent +0.06 platform shift, no cascade embedding). maps.json is now
  clean authored data (not relying on the load-time pass). The disguise costume now matches the real
  counter height exactly.
- Also seated a pre-existing floater the tight tol exposed (a stacked `planks` was 0.09 m proud).
- NOTE for future edits: the load-time `groundMapData` still does NOT cascade (it only seats a single
  floater/sinker to its floor). Author kitchen items measured from the tile top (y≥0.06), not 0.

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
