# physics (Rapier)

Landed in the big physics + netcode pass (2026-07-09, `physics-net`). Read this
before touching movement, collision, or the disguise orientation lock.

## 2026-07-11 CHECK-REPAIR — check-physics.mjs walkable-floor false positive (spawn-blocked-by-floor_kitchen)
`node tools/check-physics.mjs` exited 1 with 2 violations: restaurant spawns `(-15,-2)` and
`(15,-2)` "blocked by floor_kitchen". These are the SAME 2 pre-existing failures pass #5 flagged
below (lines noting "spawn-blocked-by-floor_kitchen ... map data, untouched by this pass").
ROOT CAUSE (a CHECK bug, not a map/engine bug — confirmed via `git_log`: check-physics.mjs is a
single new commit `bf18073`, while the kitchen floor tiles + spawns predate it by many commits and
the map has shipped fine): the OPEN-MIDDLE stand-clearance test filtered out only `kind==='ground'`
from the collider set. A `floor_kitchen` fixture is a WALKABLE floor — bounds.js "fix #5" holds its
visible top flush at the surface (mesh h=0.06 → collider top ~0.06 m) and extends the collider
DOWNWARD, exactly like the ground slab. A player STANDS ON it. The two z=-2 spawns sit at the front
edge of the kitchen floor tiles (tiles at z=-6 span z∈[-10,-2], x∈[-16,16]); the capsule-radius
padding (0.4) applied vertically made the sample at y=0.1 read as "inside" the flush floor top =
false "trapped". FIX (minimal, 1 line + comment in `tools/check-physics.mjs`): exclude walkable
floors from the stand set too — `worldBoxes.filter(b => b.kind!=='ground' && !b.floor)` (floor boxes
carry `floor:true` from bounds.js). Now green (exit 0) on all 3 maps; browser_check clean. No game
code touched — authoring-only tool.

## 2026-07-11 PHYSICS PASS #5 (branch `physics-pass-5-player-collision`) — Jie: bob + phase-into-props + hide-inside + perimeter "glitched mode". FIRST PASS VERIFIED BY HEADLESS LIVE-SIM, NOT INSPECTION.
What ended the guess cycle: `PhysicsWorld` takes RAPIER as a constructor arg, so the REAL
engine was run headless in Node against a local `@dimforge/rapier3d-compat@0.14.0` (same
pinned version the CDN serves) and every reported bug was REPRODUCED with numbers before
anything was changed. The repro harness ships as **`tools/check-physics-live.mjs`** (SKIPs
exit-3 if rapier isn't installed; `npm i --no-save @dimforge/rapier3d-compat@0.14.0` first).
Four root causes, four fixes:

- **Bob while standing on objects (+ flaky jump on props) = grounded-flag oscillation.**
  Grounded set `vy = 0`, so the next substep's movement had NO downward component, so
  `computedGrounded()` read false, so gravity applied, so it re-grounded — MEASURED: 593
  flips in 600 substeps standing still on a crate. Through 15 Hz round2-quantised
  snapshots + reconciliation that's the visible bob; and jump (needs `grounded`) was a
  coin toss on props. **Fix: ground STICK** — a grounded, non-jumping player keeps
  `vy = -feel.groundStickSpeed` (1.5; `groundStickSpeed/60 ≥ controllerOffset` so one
  substep's press reaches the surface). The swept controller stops the press at the
  surface (no visible sinking); grounding is now 0-flip stable, y amplitude 1 mm.
- **Walk-into / push-through / hide-inside props = "fix #5" was DEAD CODE.** The
  constructor declared `_propSkin/_propMaxPush/_propObstacles/_maxStuckSubsteps/
  _stuckPlayerIds` with comments describing a character-vs-prop depenetration and an
  escape hatch — none of it was referenced anywhere. Meanwhile pass #4 had (correctly)
  excluded props from the static snap failsafe, so NOTHING ever separated capsule from
  prop: measured penetration up to a full capsule radius while shoving; a capsule
  teleported inside a prop stayed there forever. **Fix: `_depenetrateFromProps`** (every
  substep, after `world.step()`): project the capsule's three axis points onto the
  nearest PROP surface (`world.projectPoint`, `solid=false`, props-only predicate =
  `_propHandles`, the complement of `_staticHandles`); push the PLAYER out when an axis
  point is nearer than `radius − _propSkin` (or inside), capped `_propMaxPush`/substep.
  Inside-exits take the CHEAPEST surface (deepest can point at a floor-pressed face) and
  the push is floor-clamped. NOTE: contact MANIFOLDS were tried first and DON'T work — a
  kinematic capsule's pairs exist but carry zero contact points in 0.14. The ESCAPE HATCH
  is real now too: a static-snap that fails `_maxStuckSubsteps` consecutive substeps
  flags the id; the referee failsafe consumes `consumeStuckPlayers()` and respawns.
- **Perimeter "glitched mode" (run along outside, snapped back wall-ward) = referee clamp
  0.58 m IN FRONT of the walls + no out-of-arena recovery.** `integrate()` clamped
  broadcast pos to `size/2 − mapMargin` (1.5) but legal wall-hugging reaches
  `size/2 − WALL_INSET(0.5) − playerRadius(0.4)`. A body that escaped the arena (ground
  slab extends 2 m past the walls — a walkable apron; below-floor failsafe never fires
  out there) kept broadcasting a clamped pos AT the wall; the client rewound to it every
  snapshot (>2.5 m mismatch = the hard corr snap = "bounces me toward the wall").
  **Fix:** clamp derived from wall geometry (imports `WALL_INSET` from bounds.js, now a
  true backstop that never bites in normal play) + the throttled failsafe respawns any
  body whose centre passes the wall inner face (reads `physics.getPlayer`, the TRUE pose,
  not the clamped `p.pos`) and logs fallen/escaped/wedged counts separately.
- **"Phasing regardless of disguise" feel = prediction world's props NEVER MOVED.** Every
  predict world built props as fixed colliders at match-start poses; snapshot prop
  transforms only reached the renderer. Local movement collided with ghosts where props
  USED to be and sailed through where they ARE (authority corrected at only 15 Hz = the
  spongy push-in). **Fix: `syncPropTransforms(list)`** repositions the fixed colliders
  (`_fixedPropColliders` by id), called from `main.js onSnapshot` with the same transforms
  `scene.syncProps` consumes. Plus **buried-prop recovery**: a prop's centre can't stay
  below `FLOOR_Y + min half-extent − 0.05` (the kinematic capsule used to pin shoved
  props INSIDE the ground slab — measured centre y=−0.56).
- **Chaos caveat for future checks:** Rapier runs are NOT bit-reproducible across
  processes — scenario outcomes (how a prop tumbles) vary run to run. Live-sim assertions
  must be INVARIANTS the engine enforces every substep (push-out, clamps, stick), not
  trajectory expectations. All 10 checks in check-physics-live.mjs are green 3/3 runs;
  `check-physics.mjs` has 2 PRE-EXISTING spawn-blocked-by-floor_kitchen failures on main
  (map data, untouched by this pass).
- **Files:** `shared/physics.js` (stick, `_propHandles`, `_depenetrateFromProps`, escape
  hatch, buried-prop recovery, `syncPropTransforms`, `consumeStuckPlayers`),
  `shared/referee.js` (wall-derived clamp, out-of-arena + wedged respawn),
  `js/main.js` (predict prop sync), `shared/config/physics-feel.json`
  (`groundStickSpeed`), `tools/check-physics-live.mjs` (new).
- **LIVE RE-TEST PASSED (Jie, 2026-07-11, local solo playtest):** confirmed fixed in a
  live browser session — no bob on props, prop collision holds firm (no phase-in /
  hide-inside), and the perimeter "glitched mode" no longer persists. First physics pass
  to be BOTH headless-sim verified AND playtest-confirmed before merge.

## 2026-07-11 PHYSICS PASS #4 (on `main`) — Jie: bouncy invisible wall + still phasing. ROOT CAUSE FOUND (behavioural, not geometry).
Attempt #4. Jie reported the just-shipped relaunch made it WORSE: (1) STILL phases through
props, and (2) NEW — an "invisible bouncy wall" confines the player to a strip along one wall;
they bounce off empty air and can't move toward the middle. Both attached screenshots are the
**circus_lot** map (purple sky) — whose props are pure PRIMITIVES with perfect
collider==mesh alignment. So the acute bug is **map-independent player physics, NOT a collider
geometry misalignment** (the prime "displaced collider" hypothesis is refuted by the map choice
in the very screenshots).

**ROOT CAUSE — the depenetration failsafe was snapping players off PROPS.** `_isPenetrating`
(pass #2, `physics.js`) tested the capsule against ALL solid geometry using only
`EXCLUDE_SENSORS`. Since fix #2 the world defaults to ~130 **dynamic/knockable** props, and
pass #3 grows a disguised player's capsule fatter — so a (disguised) player pushing through the
pervasive props overlapped a prop every substep, tripped the failsafe, and was **yanked back to
`safePos` = "bounce off empty air, can't reach the middle, confined to a strip"**. The failsafe
is meant to recover a capsule that started a substep inside IMMOVABLE geometry (a wall-top
tunnel), never to fight a prop the player is legitimately shoving.

**FIX (behavioural, minimal):** `_buildStatic` now records the handles of the STATIC WORLD
colliders only (ground slab, boundary walls, static fixtures) in `this._staticHandles`.
`_isPenetrating` passes Rapier's `intersectionWithShape` **filterPredicate** (its final arg,
verified against the pinned rapier3d-compat@0.14 API) = `(col) => _staticHandles.has(col.handle)`,
so depenetration considers ONLY immovable world geometry. Props (dynamic on the host, fixed
obstacles on a guest predictor) are excluded on BOTH sims — the set is built identically in the
shared `PhysicsWorld`, so no rubber-band. Wall-top / floor tunnel recovery is **preserved**
(walls + slab are in the set); prop collide-and-slide (via `computeColliderMovement`, unchanged)
still blocks the capsule at a prop's surface and still shoves it. This also cleans up symptom 1:
the failsafe fighting every prop contact was degrading prop-collision feel ("minimal
resistance / phasing"). The disguise-capsule 0.55 radius cap (≈0.2 m overhang on the widest
disguises) remains the documented passability tradeoff — NOT blind-tuned.

**SEE-IT + GUARD (the thing that ends the 4-attempt guess cycle):**
- **`shared/bounds.js` (NEW) — ONE shared source** for the world-space bounds of every
  collider + every mesh. Collider SIZES reuse the SAME pure helpers `physics.js` builds real
  colliders from (`halfExtentsFor`/`thickenWallHalfExtents`/`isStaticEntry`/`FLOOR_Y`); the
  static-collider PLACEMENT math is a faithful mirror of `_buildStatic` (constants
  `GROUND_SLAB_HALF_Y`/`WALL_INSET`/`WALL_HALF_THICK`/`WALL_HALF_HEIGHT` live here). The debug
  view, the guard, and diagnosis ALL read this — they cannot drift from each other.
- **`?debug=1` collider view** (`js/scene.js`) — wireframe outline of EVERY physics collider
  in-world (ground grey, boundary walls red, static fixtures cyan; each prop's collider
  outline parented to its container so it tracks shoves in yellow). Built from `shared/bounds.js`.
  Toggle with the `?debug=1` URL param. Full doc: `memory/notes/collider-debug.md`.
- **`tools/check-physics.mjs` (NEW)** — sibling of `check-physics-solidity.mjs`, pure/zero-dep/
  headless. Asserts (MISALIGNMENT) every collider AABB overlaps its mesh AABB and is not
  smaller than the mesh; (OPEN MIDDLE) every spawn + the hunter spawn is collider-free at
  player height and no static fixture collider is arena-sized (a blown-up transform).
  Hand-traced GREEN on all three maps (sandbox has no shell; several GLBs are UNVERIFIED
  because their native bbox isn't in asset-dims.json — those keep the primitive footprint,
  which equals the mesh by construction). Run `node tools/check-physics.mjs` to gate.

**Honest residual:** the depenetration fix is BEHAVIOURAL — a static check can't reproduce it.
It needs a live browser pass (Jie): disguise as a big crate, walk INTO the props toward the
middle → you now push through/past them instead of bouncing; jump onto the divider/wall top →
still no tunnel/void; props still shove + trampleable. **Files:** `shared/physics.js`
(`_staticHandles` + predicate), `shared/bounds.js` (new), `js/scene.js` (debug view), `js/main.js`
(scene.rules), `tools/check-physics.mjs` (new), notes.


## 2026-07-11 PHYSICS SOLIDITY PASS #3 — RELAUNCH (on `main`) — verify + close the fall-through window
Relaunch of pass #3 (the first attempt's session was lost). Found pass #3's CODE already in
the tree (disguise-sized capsule + thin-panel min-thickness) and re-traced from data before
changing anything. Key diagnostic results:

- **The empty-measurements hypothesis is REFUTED for the shipped maps.** `asset-dims.json` is
  NOT read at runtime anyway — its keys are GLB paths (`"restaurant/door.glb"`), not the
  `{dims:{...}}` shape `js/config.js` looks for, so `c.measured` is `undefined` everywhere and
  colliders use the primitive footprints. Those footprints were ALREADY normalized to
  `native × modelScale (0.75)` by the bbox pass, so **colliders match meshes**: verified
  door `2.1==2.8×0.75`, fridge `1.88≈2.5×0.75`, oven `1.52≈2.02×0.75`, counter/cabinet
  `0.75==1.0×0.75`, food_crate `1.5×0.72==2.0×0.966×0.75`, chair/tables likewise. So the
  reported sinking is NOT a collider-smaller-than-visuals gap, and there is NO top-face height
  gap on any wall (collider height == mesh height for every verifiable static fixture).
- **The dramatic "fall through the ground → solid purple void" (both attached screenshots) is
  the RECOVERY WINDOW, not a permanent fall.** The host's below-floor respawn
  (`referee.integrate`) only fires when the capsule is >2 m below the floor AND is throttled to
  ~0.5 s, so a wall-top tunnel drops the player into the void for up to half a second before it
  yanks them back — long enough to screenshot. That window is the concrete defect this relaunch
  closes.

**FIX (minimal, guaranteed, un-tunable): per-substep hard floor clamp** (`physics.js
_substep`). After the swept move, clamp the capsule CENTRE to `>= _pCenterY + FLOOR_Y` so the
foot can never pass `y=FLOOR_Y` in ANY substep. Lives in the SHARED substep → host authority
and every guest predictor apply it identically (no rubber-band). Purely additive: no map has
legitimate sub-floor space (the ground slab top is `FLOOR_Y` everywhere), so it can't fire in
normal play; when it catches a tunnelling capsule it lands it ON the floor instead of the void.
The throttled referee respawn stays as the higher-level net (still logs). **`FLOOR_Y` is now an
exported constant** — the one place the floor plane is defined, keyed by both the clamp and the
check.

**Shared pure helpers (single source of truth, no Rapier):** `halfExtentsFor(c)` and
`thickenWallHalfExtents(hx,hz,minHalf)` extracted from the inline collider-build math.
`_buildStatic` now calls `thickenWallHalfExtents` (behaviour-identical to the old inline
`isThinPanel` block), and the headless check imports the SAME helpers, so engine and guard can
never disagree on a collider's size or which walls get thickened.

**`tools/check-physics-solidity.mjs` REWRITTEN to a pure-JS, zero-dependency, deterministic
guard** that actually runs on bare `node` (the old version stood up Rapier — browser-only WASM
— so it SKIPPED (exit 3) everywhere incl. CI and never guarded anything). It asserts the
geometric root-cause invariants, proven against the real map+catalog data, one per bug:
  - **A (sink/hide inside):** every world-prop *box* collider ≥ its drawn mesh (no gap to sink
    into). Round colliders hug the body, not the GLB bbox — reported, not asserted. Plus the
    worst-case disguise mesh-overhang bound (0.2 m today; hard-fails only if it regresses past
    the pre-pass-#3 ~0.35, i.e. capsule-fitting disabled).
  - **B (wall tunnel incl. top face):** every static box collider ≥ its mesh HEIGHT (no
    top-face gap), the min wall thickness clears the capsule radius, and thin panels still get
    thickened (regression guard on pass #3's grow).
  - **C (below floor):** ground slab top == `FLOOR_Y`, covers the arena, ≫ one-substep fall;
    and the engine clamps every foot to `FLOOR_Y` each substep.
  Hand-traced GREEN against all three maps (this sandbox has no shell to execute it; the
  invariants are computed by hand in the relaunch summary). **Run `node
  tools/check-physics-solidity.mjs` to gate a build.**

**Honest residuals (unchanged, live-playtest owed):** (1) Rapier's character-controller
top-of-thin-wall tunnel is a runtime edge case a static check can't reproduce — the swept mover
+ CCD + depenetration failsafe + the new floor clamp are the defence; a live browser pass on
the divider is still owed. (2) The disguise capsule is capped at `0.55` radius for doorway
passability, so the biggest disguises (1.5-wide crate) leave ~0.2 m of mesh able to overlap a
world prop — the documented tell-vs-passability tradeoff; raise `disguiseColliderMaxRadius` if a
playtest wants more solidity at the cost of squeezing through the 1.2-wide door. Did NOT
blind-tune it (that was build #38's mistake). **Files:** `shared/physics.js` (FLOOR_Y +
helpers + floor clamp), `tools/check-physics-solidity.mjs` (rewrite), notes.

## 2026-07-11 PHYSICS SOLIDITY PASS #3 (on `main`) — Jie/Teravortryx: pass-through props + wall tunnel
Third pass after two players reported (a) a player-controlled prop passing through /
hiding fully INSIDE world props, and (b) jumping INTO a vertical wall tunnelling through
then falling through the floor. Passes #1/#2 already REFUTED the obvious movement theories
(the mover is swept `computeColliderMovement`, prediction shares the world, vertical is not
raw-translated). So this pass traced the two remaining *mechanisms* and fixed those, rather
than re-tuning constants (build #38's mistake). STILL NEEDS A LIVE PLAYTEST — nothing here
is runtime-verified in the sandbox (no shell; see the new guard tool caveat).

**Mechanism found for Bug 1 (pass-through / hide-inside).** World-prop colliders DO match
their meshes (verified: crate `1.5×0.72×1.5` ≈ measured `2.0×0.966×2.0 ×0.75`; round/large
tables likewise). The real cause is the previously-*accepted caveat*: a disguised player's
physics body stayed a fixed **tiny capsule (r 0.4)** no matter how big the disguise LOOKED,
so the big disguise silhouette clipped into — and, for a light dynamic world prop shoved
aside, fully inside — world props while the little capsule slipped into the gap.
  - **Fix: capsule girth now fits the disguise footprint.** New `PhysicsWorld._capsuleDimsFor(type)`
    + `setPlayerCollider(id, type)` rebuild the player's capsule to the disguise's smaller
    horizontal half-extent, clamped `[playerRadius, rules.disguiseColliderMaxRadius=0.55]`
    (diameter 1.1, still clears the 1.2-wide doors/walkways). **Total capsule height is held
    constant** (`half = _pCenterY − radius`), so centre height, grounding, jump, autostep and
    snap-to-ground are byte-identical to before — only the belly gets fatter. `_pCenterY`
    stays global (radius+half always == it) so `getPlayer`/`setPlayerPosition` are untouched;
    `_isPenetrating`/`rotationWouldCollide` now read the per-player `p.radius`/`p.half`.
  - **Wired both sims:** host `referee.applyDisguise` (+ the `_buildPhysics` load-race) calls
    `setPlayerCollider`; each client's OWN prediction mirrors it in `main.js onSnapshot`
    (`me.disguise` → `predict.setPlayerCollider(SELF_ID, …)`) so authority + prediction step
    an identically-sized body and don't rubber-band. No netcode/protocol change.
  - **Honest residual:** the 0.55 radius cap is a passability compromise — a very wide
    disguise (a 1.5-wide crate, half 0.75) still leaves ~0.2 m of mesh able to overlap a
    world prop (was ~0.35). "Fully inside" is gone; a little edge clip on the biggest
    disguises remains, bounded by doorway width. Raise `disguiseColliderMaxRadius` if a
    playtest wants more solidity at the cost of squeezing through doors.

**Mechanism found for Bug 2 (wall tunnel → floor fall).** The kitchen/dining divider and
side walls are built from **thin static box panels** (`kitchen_wall` d0.4, `wall_header`
d0.4) — thinner front-to-back than the player capsule is wide. A fast jump into a broad
thin face can resolve the swept contact to the FAR side and pop through (then drop through
the floor beyond — exactly "pass through then fall through the ground").
  - **Fix: minimum thickness on thin wall PANELS only** (`_buildStatic`). A static box whose
    thin horizontal half-extent `< rules.minWallHalfThickness (0.6)` AND whose long axis is
    `≥2×` the thin one is grown on its thin axis to 0.6 half (1.2 thick), symmetric about the
    centre, long axis + visible mesh untouched. Targets `kitchen_wall`/`wall_header`/`door`/
    `shelf`; **skips** narrow posts/pillars (thin in BOTH axes — a wider capsule can't tunnel
    them and thickening adds annoying invisible collision) and bulky appliances (already thick).
  - Kept as nets, unchanged: swept mover, CCD, terminal fall clamp, depenetration failsafe.

**Anti-fall teleport now LOGGED.** `referee.integrate`'s below-floor failsafe still recovers
players/props, but now `console.warn`s the counts + map when it fires — after this pass it
should basically never trigger, so a line in the console is an early regression signal.

**NEW guard tool `tools/check-physics-solidity.mjs`** (authoring-only, never shipped) — the
LIVE-sim sibling to the static `check-blindfold`/`check-physics-feel`. Stands up the REAL
`PhysicsWorld` and asserts the three reports: (A) a disguised prop rests against a world prop
without deep penetration; (B) a player at jump speed never crosses a thin wall panel; (C) a
player never ends below floor level (drop + wall-slam). **Rapier-in-Node caveat:** the game
loads Rapier from a CDN (browser-only); the tool tries a dev-only `npm i --no-save
@dimforge/rapier3d-compat@0.14.0` first, else the CDN, else prints SKIP + exits 3. **NOT run
in this sandbox (no shell)** — authored + hand-traced against source; run it + a live phone
playtest to close.

**Config:** `rules.json` +`disguiseColliderMaxRadius:0.55` +`minWallHalfThickness:0.6`.
**Files:** `shared/physics.js`, `shared/referee.js`, `js/main.js`,
`shared/config/rules.json`, `tools/check-physics-solidity.mjs` (new).
**LIVE RE-TEST OWED (Jie/Teravortryx):** a disguised prop now rests against world props
(no walking through / hiding inside); jumping into the divider/side walls no longer tunnels
or drops through the floor; props still push around and are still trampleable (stand/jump on
top); disguised movement through doors/walkways still fits; watch the console for the anti-
fall warning (should stay silent).

## 2026-07-11 PHYSICS SOLIDITY PASS #2 (on `main`) — Jie's three bugs
Second solidity pass after a live playtest. Three specific bugs; scope limited to the
player controller + disguise rotation + fall path (no map/netcode/editor changes). All
three still need a LIVE re-test — headless can't verify physics behaviour at runtime.

**Bug 1 — player stands/pushes deep inside props.** *Filter-excludes-dynamic theory
REFUTED.* `computeColliderMovement` was called with NO filter, and Rapier's default does
NOT exclude dynamic bodies — dynamic props were already obstacles the capsule slides
against; `applyImpulsesToDynamicBodies(true)` is the ADDITIONAL push, not a replacement
for blocking. So nothing was letting the capsule through. What remains (documented, not a
controller bug): the player collider is a player-sized *capsule* smaller than the disguise
mesh, and primitive footprints (asset-dims.json still empty) can be smaller than a GLB, so
a capsule stopping at a prop's collider edge can still *look* embedded; plus a one-substep
lag (controller queries the prop's last-step position, the prop moves during `world.step`)
leaves a small visual overlap while a light prop is being shoved. Change made: pass an
EXPLICIT `QueryFilterFlags.EXCLUDE_SENSORS` to `computeColliderMovement` so "dynamic props
block the capsule" is unambiguous + future-proof (behaviour-identical to the old default in
this sensor-free world). The controller `offset` (0.02) is a controller-GLOBAL property —
it already applies to dynamic contacts (confirmed), so the capsule keeps its skin gap off
props too. Real "feels more solid" levers are propDensity/characterMass (feel dials, left
alone — need a feel-test, not a blind bump).

**Bug 2 — fall-through via wall-top jump.** *Raw-gravity-translation theory REFUTED.* ALL
vertical motion already routes through `computeColliderMovement` (desired.y = vy·dt) — there
is NO raw gravity translation anywhere in the physics path (the 2D fallback has no vertical
at all). And the KinematicCharacterController's movement query is inherently SWEPT
(shape-cast along the desired vector), so a single frame can't tunnel a wall by moving too
far — confirming plan Step 4's "if it sweeps, no redundant step-clamp." The real cause is
(c): the movement query STARTING already penetrating. A wall-top jump can leave the capsule
a hair inside a thin top edge; a swept query from inside solid geometry is degenerate and
can drop the capsule through. Fixes:
  - **Depenetration failsafe** (`_substep` + `_isPenetrating`, gated by `feel.depenetrate`,
    default ON): each substep, if the capsule STARTS genuinely inside solid geometry, snap
    it back to `safePos` (the previous substep's controller-corrected, collision-free
    position) and zero vy — instead of tunnelling. Tested with a SKIN-SHRUNK capsule
    (radius/half −0.05) so resting-on-a-surface or pressing-a-wall contact never trips it;
    only a real overlap deeper than the skin does. `intersectionWithShape`, guarded/try-
    catch → no-ops to the clamp+failsafe alone if the API is absent. `safePos` is recorded
    every substep as the controller's output (never enters geometry by construction).
  - **Terminal fall-speed clamp** `rules.maxFallSpeed` (20 u/s): bounds one substep's fall
    to ≈0.33 m — far under any wall/floor thickness — so sweep + clamp together make a
    single-frame leap impossible. No extra per-step position clamp added (the sweep already
    covers it; not stacking a redundant third clamp).
  - **Void failsafe (verified, not rebuilt):** the "capsule top < floorTop−2 → respawn"
    catch is host-authoritative in `referee.integrate` at floorTop=0, GLOBAL to every map
    (not per-map). Confirmed it covers all three maps; left as-is.

**Bug 3 — disguise rotation snaps instantly.** Was: `dispYaw` set instantly to look-yaw on
right-click (referee `applyInput` + client `main.js`) — a teleport that could jump the prop
into a pose it can't fit rotated. Now CONTINUOUS: `referee.updateDisguiseRotation(dt)` (per
tick, before movement) eases `dispYaw` toward look-yaw at a capped
`rules.disguiseRotSpeedDeg` (270°/s), and each increment is validated by
`physics.rotationWouldCollide(playerId, propType, yaw)` — a footprint shape-cast (the prop's
w/d box at capsule height, excluding own capsule) against the SHARED Rapier world; if the
next increment would intersect a wall/fixture/prop, the turn STOPS there (no force-through).
*Honest caveat:* the player's physics body is a symmetric *capsule*, so yaw rotation can't
literally wedge the physics — the snap's damage was the VISUAL prop teleporting into an
illegal-looking pose and (where a big disguise silhouette clips geometry) reading as an
eject. The gate now tests the PROP footprint so the disguise won't rotate into a wall; if a
disguise is already wedged (mesh bigger than capsule, current pose overlapping), rotation
locks until you move out — intended ("no force-through"), a rare edge. Client mirrors the
same capped ease on the local own-model (cosmetic; host stays authoritative + does the
gating). Yaw authorship unchanged (turning player's own client → host → snapshot).

**Config added:** `rules.json` → `maxFallSpeed: 20`, `disguiseRotSpeedDeg: 270`.
`physics-feel.json` → `depenetrate: true`. **Files:** `shared/physics.js`,
`shared/referee.js`, `js/main.js`, `shared/config/{rules,physics-feel}.json`.
**LIVE RE-TEST OWED:** props feel solid (compress+push, no standing inside); wall-top jumps
no longer fall through wall→floor; disguise rotation turns smoothly and stops at walls
instead of wedging; watch the depenetration for any stutter (flip `depenetrate` off if so).

---

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
  to leak). **As of SOLIDITY PASS #2 (2026-07-11) this follow is CONTINUOUS, not a
  snap:** `referee.updateDisguiseRotation(dt)` eases `dispYaw` toward look-yaw at
  `rules.disguiseRotSpeedDeg` (270°/s) with a per-increment
  `physics.rotationWouldCollide` fit-gate (stops the turn at a wall instead of
  wedging the prop). See the top "SOLIDITY PASS #2" section. Snapshots broadcast
  `dispYaw` as the player's `yaw` when disguised, so
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
