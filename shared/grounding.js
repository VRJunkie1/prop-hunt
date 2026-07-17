// shared/grounding.js — ONE deterministic, physics-free pass that keeps every map object
// resting on a real support, so nothing hovers in mid-air or sinks below the floor.
//
// WHY (VRmike, 2026-07-16). After the density expansion, an item whose supporting counter is
// deleted/moved can hang in the air, and a piece can end up below the floor surface. A
// per-machine physics settle would give each client a slightly different result (a desync
// risk for a host-authoritative game), so this is a PURE geometric calculation over the SAME
// collider data every consumer already reads (halfExtentsFor). It runs ONCE, in js/config.js
// loadConfig, and mutates the loaded map records IN PLACE — so the visible mesh, the physics
// colliders, the host's prop stream, the bounds/debug overlay and the disguise system all
// consume the ONE grounded position; nothing computes a height a second time. Identical JSON
// in => identical heights out on every client + late joiner.
//
// DELIBERATELY CONSERVATIVE (learned from the data, 2026-07-16). Several restaurant GLBs carry
// a convex hull whose TOP is NOT their flat working surface — `table_food` is a table *with
// food modelled on it* (hull 1.39 m tall), `stove_plain`'s hull baked to just 0.20 m though a
// pot rests on its ~0.9 m cooktop. So "rest every item on the hull-top beneath it" would sink
// pots into stoves and fling plates onto tabletops. Instead this pass ONLY corrects the two
// UNAMBIGUOUS, support-independent failures:
//   (1) ORPHAN FLOAT — a piece hanging with NOTHING beneath it (no fixture/prop footprint
//       overlaps it at a lower height): its authored surface is gone, so it drops to the FLOOR
//       (the ground, or the raised kitchen-floor tile it stands on).
//   (2) BELOW-FLOOR — a piece whose base is under the floor surface: it rises to rest on it.
// A piece that already rests ON some support (a plate on a table, a pot on a stove, a canister
// on a counter) is LEFT EXACTLY as authored — the author tuned those heights against the real
// meshes, and the collider hulls are not a trustworthy second opinion. The result: floaters
// and sunk pieces are fixed; every correctly-placed piece stays byte-identical.
//
// EXEMPT entirely: world ARCHITECTURE (walls/floors/ceilings/ground, via isArchEntry) and any
// entry flagged `noGround` — vents (the extractor hood) and doors, which are mounted in place
// and must never be dropped to the floor if their neighbour is ever removed.

import { halfExtentsFor, isArchEntry, isFixedBodyEntry } from './physics.js';

// A piece counts as "supported" (not an orphan) if some other object's footprint overlaps it
// and starts at least this far below its base — enough to be a genuine surface underneath, not
// a side-by-side neighbour at the same height.
const SUPPORT_MIN_DROP = 0.05;
// FLOAT tolerance. Only treat a piece as an orphan FLOATER when it hangs more than this above
// its floor (metres). Generous, so authored clutter resting a hair proud of a surface is never
// disturbed — we only catch real gaps ABOVE a surface.
export const GROUND_TOL = 0.12;
// SINK tolerance — deliberately TIGHT (2026-07-16, VRmike attempt #3). A piece whose base is
// BELOW the floor surface it stands on is CLIPPING INTO the floor — there is never a legitimate
// reason for that, so it must be caught at a much finer grain than the float side. The old code
// reused the lenient 0.12 m float tolerance for BOTH directions, which silently accepted the
// restaurant's whole kitchen stack: every counter/fridge/oven/stove sits over the raised
// `floor_kitchen` tile (top at y=0.06) but was authored at y=0, so each was buried 6 cm — inside
// the 0.12 m window, so the guard passed while the screenshot showed sunken counters. A player
// disguised as a counter stands ON the tile (feet at 0.06), so their disguise sat 6 cm ABOVE the
// real counters — VRmike's exact complaint. 2 cm tolerates sub-centimetre authoring noise while
// flagging the tile-step burial. NOTE: sinkers also spawn a DYNAMIC body buried in the floor
// collider (once everything is shovable), which jitters/launches — so a tight sink gate also
// guards the physics conversion, not just the visual.
export const SINK_TOL = 0.02;
// SEAT tolerance (floating-fixed-props round 4, 2026-07-17). seatMapData raises a dynamic item
// onto the collider top beneath it whenever its base sits more than this far BELOW that top — i.e.
// it is embedded INSIDE a taller hull. Kept tight so an item that already rests cleanly (base at/
// near its support top) is left byte-identical; only genuine embeds move. After the pass no dynamic
// item is embedded more than this, which is exactly what tools/check-floating-props.mjs verifies.
export const SEAT_TOL = 0.02;

// EXEMPT from ground-snapping. Architecture stays put by definition; `noGround` marks the few
// mounted pieces (vents, doors) that must not be re-grounded.
export function isGroundExempt(c) {
  return !c || isArchEntry(c) || !!c.noGround;
}

// Axis-aligned footprint half-extents of a (possibly yaw-rotated) object + its collider
// height, all from the SAME halfExtentsFor the engine bakes colliders with.
function footprint(o, c) {
  const he = halfExtentsFor(c);
  const rot = o.rot || 0;
  const co = Math.abs(Math.cos(rot));
  const si = Math.abs(Math.sin(rot));
  return { hx: he.hx * co + he.hz * si, hz: he.hx * si + he.hz * co, height: 2 * he.hy };
}

// Real horizontal overlap (not a mere shared edge).
function overlaps(a, b) {
  return Math.abs(a.x - b.x) < a.hx + b.hx - 1e-6 && Math.abs(a.z - b.z) < a.hz + b.hz - 1e-6;
}

// Build the per-object working list (footprint + base + flags) once. `catalog` = merged
// props+fixtures. Objects whose type is unknown are skipped (nothing to place).
function buildItems(map, catalog) {
  const items = [];
  const collect = (arr, kind) => {
    for (const o of arr || []) {
      const c = catalog[o.type];
      if (!c) continue;
      const fp = footprint(o, c);
      items.push({
        o, kind, type: o.type, x: o.x, z: o.z, hx: fp.hx, hz: fp.hz, height: fp.height,
        base: o.y || 0, isFloor: !!c.floor, exempt: isGroundExempt(c), fixed: isFixedBodyEntry(c),
      });
    }
  };
  collect(map.fixtures, 'fixture');
  collect(map.props, 'prop');
  return items;
}

// The floor surface height directly under a piece: the top of the highest FLOOR fixture whose
// footprint contains the piece's centre (the raised kitchen-floor tile), else 0 (the ground).
function floorUnder(item, items) {
  let top = 0;
  for (const s of items) {
    if (!s.isFloor || s === item) continue;
    if (Math.abs(item.x - s.x) > s.hx || Math.abs(item.z - s.z) > s.hz) continue;
    const sTop = s.base + s.height;
    if (sTop > top) top = sTop;
  }
  return top;
}

// Is `item` resting on some support (any non-floor object whose footprint overlaps it and
// starts strictly below it)? If so it is NOT an orphan and we leave it exactly as authored.
function hasSupportBeneath(item, items) {
  for (const s of items) {
    if (s === item || s.isFloor) continue;
    if (s.base >= item.base - SUPPORT_MIN_DROP) continue;
    if (overlaps(item, s)) return true;
  }
  return false;
}

// Classify one piece against its floor. Returns { kind:'float'|'sink'|'ok', floor } — 'float'
// = orphan hanging above its floor with nothing under it; 'sink' = base below the floor.
export function classify(item, items) {
  const floor = floorUnder(item, items);
  if (item.exempt) return { kind: 'ok', floor };
  // SINK uses the TIGHT tolerance (clipping into the floor is never acceptable — VRmike's
  // sunken counters); FLOAT keeps the lenient one (clutter resting a hair proud is fine).
  if (item.base < floor - SINK_TOL) return { kind: 'sink', floor };
  if (item.base > floor + GROUND_TOL && !hasSupportBeneath(item, items)) return { kind: 'float', floor };
  return { kind: 'ok', floor };
}

// NON-MUTATING inspection: return every non-exempt piece that floats or sinks in `map`, as
// { kind:'float'|'sink', type, x, z, base, floor }. Used by tools/check-grounding.mjs to fail
// the build on an authoring mistake (a new item placed with no support / below the floor)
// BEFORE the load-time pass silently drops it. Empty array => the map is cleanly grounded.
export function findUngrounded(map, catalog) {
  if (!map || !catalog) return [];
  const items = buildItems(map, catalog);
  const out = [];
  for (const it of items) {
    const { kind, floor } = classify(it, items);
    if (kind !== 'ok') out.push({ kind, type: it.type, x: it.x, z: it.z, base: it.base, floor });
  }
  return out;
}

// The TOP of the collider `item` actually rests ON: the tallest DYNAMIC piece whose footprint
// overlaps it and starts meaningfully below it, else its floor surface. TWO guards learned the hard
// way (round 4):
//   - SKIP FIXED pieces (walls, wall-posts, headers, pillars): a counter authored 9 cm from a wall
//     post is NEXT TO it, not resting ON it — treating a 2.8 m wall top as a "support" launched the
//     counter to 2.8 m. Clutter only ever rests on DYNAMIC furniture (counters/tables/appliances);
//     the floor tile is handled separately by floorUnder. So fixed pieces are obstacles, not shelves.
//   - REQUIRE a real drop (SUPPORT_MIN_DROP): two items at nearly the same height (burger layers)
//     must not seat onto each other, or they leapfrog upward every iteration and climb into the air.
function supportTopUnder(item, items) {
  let top = floorUnder(item, items);
  for (const s of items) {
    if (s === item || s.fixed || s.isFloor) continue;   // fixed pieces + floor tiles aren't shelves
    if (s.base >= item.base - SUPPORT_MIN_DROP) continue; // support must start MEANINGFULLY below (no leapfrog)
    if (!overlaps(item, s)) continue;
    const sTop = s.base + s.height;
    if (sTop > top) top = sTop;
  }
  return top;
}

// SEAT dynamic clutter on reality (floating-fixed-props round 4, 2026-07-17, VRmike). Runs AFTER
// groundMapData at the ONE shared load point (js/config.js). groundMapData fixes the two floor-
// relative failures (orphan floaters -> floor, sinkers -> floor). seatMapData fixes the SUPPORT-
// relative one the all-dynamic world exposed: several restaurant GLBs carry a convex-hull collider
// much TALLER than their visual working surface (table_food's hull is 1.39 m, a sink's ~1.35 m incl.
// the faucet), so a plate/pot/food authored to sit on the VISUAL top was authored INSIDE that hull.
// Frozen (the old `pinned` bug) it hung in mid-air; woken as a dynamic body it LAUNCHED out of the
// hull. This raises every NON-fixed item whose base is below the collider top actually beneath it up
// ONTO that top, so it spawns RESTING (never interpenetrating) and then falls/shoves like everything
// else. Iterated to a fixed point so stacks seat bottom-up. Pure geometry over the SAME halfExtentsFor
// footprints => identical on every client + late joiner (no per-machine settle, no desync). Fixed
// bodies (architecture + wall-attached) keep their authored heights. Mutates each item's `y` in place
// and returns { type, x, z, from, to } per moved item (empty when nothing is embedded). Idempotent.
export function seatMapData(map, catalog) {
  if (!map || !catalog) return [];
  const items = buildItems(map, catalog);
  const original = new Map(); // item -> authored base, so the change log shows the true from->to
  let moved = true;
  let guard = 0;
  while (moved && guard++ < 24) {
    moved = false;
    for (const it of items) {
      if (it.exempt || it.fixed) continue; // architecture / wall-attached / doors / vents: never re-seated
      const supTop = supportTopUnder(it, items);
      if (it.base < supTop - SEAT_TOL) {
        if (!original.has(it)) original.set(it, it.base);
        it.base = supTop;
        it.o.y = supTop; // rewrite the ONE authoritative record every consumer reads
        moved = true;
      }
    }
  }
  const changes = [];
  for (const [it, from] of original) changes.push({ type: it.type, x: it.x, z: it.z, from, to: it.base });
  return changes;
}

// NON-MUTATING inspection: every NON-fixed item embedded more than SEAT_TOL inside the collider
// beneath it, as { type, x, z, base, supportTop, embed }. Used by tools/check-floating-props.mjs to
// prove the seating pass leaves nothing interpenetrating (which would launch as a dynamic body).
// Empty array => every dynamic item spawns resting on its support. Run it AFTER seatMapData.
export function findEmbedded(map, catalog) {
  if (!map || !catalog) return [];
  const items = buildItems(map, catalog);
  const out = [];
  for (const it of items) {
    if (it.exempt || it.fixed) continue;
    const supTop = supportTopUnder(it, items);
    if (it.base < supTop - SEAT_TOL) {
      out.push({ type: it.type, x: it.x, z: it.z, base: it.base, supportTop: supTop, embed: supTop - it.base });
    }
  }
  return out;
}

// NON-MUTATING inspection of the FIXED-vs-DYNAMIC classification (floating-fixed-props round 4).
// Used by tools/check-floating-props.mjs. Returns every offender as { kind, type, x, z, base, floor,
// reason }:
//   (a) kind:'pinned' — a NON-architecture, NON-wall-attached object that would be a FIXED collider.
//       In a correct build this is impossible (only isFixedBodyEntry pieces are fixed). It can only
//       reappear if a y-threshold "pin" comes back — pass that threshold as opts.pinY and this flags
//       every surface prop it would freeze (the exact round-4 bug: plates/food/dishes hanging fixed).
//   (b) kind:'floating' — a FLOOR-STANDING fixed piece (wall-attached but not architecture and not a
//       wall-MOUNTED noGround door/vent — i.e. a structural pillar) whose base hangs above the surface
//       beneath it. Architecture (headers/ceilings/walls at authored heights) and mounted door/vent
//       are trusted and never flagged. Empty array => the classification is clean.
export function findFloatingProps(map, catalog, opts = {}) {
  if (!map || !catalog) return [];
  const pinY = opts.pinY != null ? opts.pinY : null;
  const items = buildItems(map, catalog);
  const out = [];
  for (const it of items) {
    const c = catalog[it.type];
    if (!it.fixed) {
      // (a) dynamic-by-classification, but a live pin would freeze it in mid-air.
      if (pinY != null && it.base > pinY) {
        out.push({ kind: 'pinned', type: it.type, x: it.x, z: it.z, base: it.base, floor: floorUnder(it, items),
          reason: `a y>${pinY} pin would FREEZE this at its authored height, but it is not architecture/wall-attached — it must be a dynamic body that falls` });
      }
      continue;
    }
    // (b) a floor-standing fixed piece (pillar) that hangs above the floor. Skip architecture (arch
    // may sit at any authored height — headers, ceilings) and wall-MOUNTED noGround pieces (door/vent).
    if (!isArchEntry(c) && !(c && c.noGround)) {
      const floor = floorUnder(it, items);
      if (it.base > floor + GROUND_TOL) {
        out.push({ kind: 'floating', type: it.type, x: it.x, z: it.z, base: it.base, floor,
          reason: `fixed piece hangs ${(it.base - floor).toFixed(2)} m above the surface beneath it` });
      }
    }
  }
  return out;
}

// Ground every offending piece in `map` onto its floor. Mutates each fixture/prop's `y` in
// place and returns the list of changes { kind, type, x, z, from, to, why } (empty when the
// map is already grounded). Deterministic in `map` aside from that in-place write.
export function groundMapData(map, catalog) {
  if (!map || !catalog) return [];
  const items = buildItems(map, catalog);
  const changes = [];
  for (const it of items) {
    const { kind, floor } = classify(it, items);
    if (kind === 'ok') continue;
    changes.push({ kind, type: it.type, x: it.x, z: it.z, from: it.base, to: floor, why: kind });
    it.base = floor;
    it.o.y = floor; // rewrite the ONE authoritative record every consumer reads
  }
  return changes;
}
