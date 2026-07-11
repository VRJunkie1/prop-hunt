// Fetches the same content-as-data config the referee uses, so the client
// renders exactly the world the referee simulates. Loaded once at startup.
// These are plain static JSON files served alongside the app (no backend).
let cache = null;

export async function loadConfig() {
  if (cache) return cache;
  const [maps, props, fixtures, rules, assetDims, feel] = await Promise.all([
    fetch('/shared/config/maps.json').then((r) => r.json()),
    fetch('/shared/config/props.json').then((r) => r.json()),
    fetch('/shared/config/fixtures.json').then((r) => r.json()),
    fetch('/shared/config/rules.json').then((r) => r.json()),
    // Measured normalized world-space bounds per catalog type (output of the
    // bounding-box normalization build). Tolerate absence — if the file is
    // missing/malformed, colliders simply fall back to the primitive footprints.
    fetch('/shared/config/asset-dims.json').then((r) => r.json()).catch(() => ({ dims: {} })),
    // Physics FEEL tuning (restitution / solver iterations / prop damping). Tolerate
    // absence — physics.js applies safe defaults if it's missing/malformed. This ONE
    // object flows to BOTH the host's authoritative world and every client's
    // prediction world (see net.js → Referee, main.js → buildPredict), so the two
    // sims can never derive mismatched feel and rubber-band. See notes/physics.md.
    fetch('/shared/config/physics-feel.json').then((r) => r.json()).catch(() => ({})),
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
  cache = { maps, props, fixtures, rules, feel };
  return cache;
}
