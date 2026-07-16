// Fetches the same content-as-data config the referee uses, so the client
// renders exactly the world the referee simulates. Loaded once at startup.
// These are plain static JSON files served alongside the app (no backend).
import { groundMapData } from '/shared/grounding.js';

let cache = null;

export async function loadConfig() {
  if (cache) return cache;
  const [maps, props, fixtures, rules, assetDims, hulls, feel, characterModels, taunts] = await Promise.all([
    fetch('/shared/config/maps.json').then((r) => r.json()),
    fetch('/shared/config/props.json').then((r) => r.json()),
    fetch('/shared/config/fixtures.json').then((r) => r.json()),
    fetch('/shared/config/rules.json').then((r) => r.json()),
    // Measured normalized world-space bounds per catalog type (output of the
    // bounding-box normalization build). Tolerate absence — if the file is
    // missing/malformed, colliders simply fall back to the primitive footprints.
    fetch('/shared/config/asset-dims.json').then((r) => r.json()).catch(() => ({ dims: {} })),
    // CONVEX-HULL collider point clouds baked from each model's real mesh vertices at
    // final world scale (output of tools/build-hulls.mjs). Tolerate absence — if it's
    // missing/malformed, colliders fall back to measured/primitive. See notes/physics.md.
    fetch('/shared/config/hulls.json').then((r) => r.json()).catch(() => ({ hulls: {} })),
    // Physics FEEL tuning (restitution / solver iterations / prop damping). Tolerate
    // absence — physics.js applies safe defaults if it's missing/malformed. This ONE
    // object flows to BOTH the host's authoritative world and every client's
    // prediction world (see net.js → Referee, main.js → buildPredict), so the two
    // sims can never derive mismatched feel and rubber-band. See notes/physics.md.
    fetch('/shared/config/physics-feel.json').then((r) => r.json()).catch(() => ({})),
    // Character-model registry (animated third-person player models — the SWAT hunter).
    // DELIBERATELY separate from props/fixtures so a player character never enters the
    // disguise pool or the collider-baking pipeline. Tolerate absence — scene.js simply
    // falls back to the neutral capsule avatar if it's missing/malformed. See
    // shared/config/character-models.json + notes/hunter-character-model.md.
    fetch('/shared/config/character-models.json').then((r) => r.json()).catch(() => ({})),
    // AUDIO TAUNT manifest (data-driven library — id/label/file per clip). The SAME list the
    // referee validates against and the taunt menu renders from, so adding ~50 real clips later
    // is a data-only change (drop files into assets/taunts/ + add manifest lines, ZERO code).
    // Tolerate absence/empty — no manifest just means no taunts available (menu shows nothing,
    // the host rejects every taunt id). Clips themselves are LAZY-loaded on first play, never here.
    fetch('/assets/taunts/manifest.json').then((r) => r.json()).catch(() => ({ taunts: [] })),
  ]);
  // props = the disguise catalog (movable items only, per referee's disguise pool);
  // fixtures = the static building-piece catalog. Kept as separate files so a
  // fixture can never leak into the disguise pool; scene.js merges them purely for
  // rendering. The referee is injected the whole cfg but only ever reads maps/rules.
  //
  // MEASURED-DIMS SEAM: attach each type's measured world-space box onto its catalog
  // entry as `measured`. This single mutation reaches everything downstream through
  // the SAME cfg object — the host referee's PhysicsWorld, every client's prediction
  // world, and the renderer — so colliders and meshes bake from measured bounds when
  // present and from the hand-authored footprint otherwise. See notes/asset-dims.md.
  const dims = (assetDims && assetDims.dims) || {};
  for (const [type, box] of Object.entries(dims)) {
    if (!box || !(box.w > 0 && box.h > 0 && box.d > 0)) continue; // ignore junk/partials
    const measured = { w: box.w, h: box.h, d: box.d };
    if (props[type]) props[type].measured = measured;
    if (fixtures[type]) fixtures[type].measured = measured;
  }
  // CONVEX-HULL SEAM (same one-mutation-three-consumers pattern as `measured` above). Attach
  // each baked hull's flat vertex array + world-space AABB onto its catalog entry. Because the
  // SAME cfg object flows to the host referee's PhysicsWorld, every client's prediction world,
  // and the renderer, this one attach reaches all three — so shapeFor()/halfExtentsFor() bake a
  // convex hull (its FIRST branch, ahead of measured/primitive) identically everywhere. A hull
  // supersedes the measured cuboid and the primitive; a missing/degenerate hull falls through.
  const hullDefs = (hulls && hulls.hulls) || {};
  for (const [type, h] of Object.entries(hullDefs)) {
    if (!h || !Array.isArray(h.v) || h.v.length < 12) continue; // need >=4 points (x,y,z each)
    const aabb = h.aabb && h.aabb.w > 0 && h.aabb.h > 0 && h.aabb.d > 0 ? { w: h.aabb.w, h: h.aabb.h, d: h.aabb.d } : null;
    if (!aabb) continue;
    if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = aabb; }
    if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = aabb; }
  }
  // GROUNDING PASS (VRmike, 2026-07-16). Rewrite each map's object heights so nothing hovers
  // above a deleted support or sinks below the floor. Runs HERE, at the ONE shared load point,
  // AFTER the measured+hull seams are attached (so it reads the final collider footprints) and
  // BEFORE anything consumes the maps — so the host referee's PhysicsWorld, every client's
  // prediction world, the renderer, the bounds/debug overlay and the disguise system all read
  // the SAME grounded `y`. Pure + deterministic over the JSON => identical on every client and
  // late joiner (no per-machine physics settle, no desync). See shared/grounding.js. A clean
  // map (every piece already resting on a support) is left byte-identical — this only moves the
  // few pieces that genuinely float or sink. tools/check-grounding.mjs guards the invariant.
  const catalog = { ...props, ...fixtures };
  for (const map of Object.values(maps)) groundMapData(map, catalog);
  // Normalize the taunt manifest to a stable shape so downstream code can always read
  // cfg.taunts.taunts as an array (an empty library is valid — see loader above).
  const tauntList = (taunts && Array.isArray(taunts.taunts)) ? taunts.taunts : [];
  cache = { maps, props, fixtures, rules, feel, characterModels, taunts: { taunts: tauntList } };
  return cache;
}
