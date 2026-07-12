// Rapier physics world — the one authoritative simulation on the host, and the
// local prediction sim on guests. This module is TRANSPORT-AGNOSTIC and
// ENVIRONMENT-AGNOSTIC: the same class builds the host's full world (all players
// as kinematic character bodies + dynamic props that can be shoved) and a guest's
// prediction world (just the local player against static geometry).
//
// LAZY LOAD: Rapier is a WASM engine pulled from a CDN. Like three.js / PeerJS /
// nipplejs, it is imported DYNAMICALLY the first time a match starts — never at
// page boot — so the headless load check (which runs with no outbound network)
// makes zero external requests. `PhysicsWorld.load()` fetches + inits Rapier once
// and caches it; construct a world only after it resolves.
//
// Determinism caveat: Rapier is NOT cross-platform deterministic (float drift
// across browsers/builds), which is exactly why the netcode is host-authoritative
// with reconciliation rather than lockstep. Guests predict; the host corrects.
//
// @dimforge/rapier3d-compat inlines its WASM as base64 and decodes it in
// RAPIER.init(), so a single ESM import is enough — no separate .wasm fetch.

const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm';

let _RAPIER = null; // cached, inited Rapier module
let _loadPromise = null;

// Tiny clearance so a body that spawns flush on a surface never begins the match
// interpenetrating its neighbour/surface (which the solver would "recover" from as
// a violent shove). Bodies spawn this far above their rest height and settle onto
// it in the first few frames. See fix #3 (calm match start).
const SPAWN_EPS = 0.02;

// THE floor plane. Every map's ground/floor surface sits at y=0 (the ground slab's
// TOP face, and where every spawn is placed). The un-throttled per-substep player
// clamp (Bug 2, solidity pass #3 relaunch) and the host's referee failsafe both key
// off this ONE constant, so "below the floor" means the same thing everywhere.
export const FLOOR_Y = 0;

// THE static/dynamic split (fix #2). A world object is a fixed, immovable collider
// only if its catalog entry is flagged `static` (genuinely bolted-in: floor, walls,
// pillars, doors, the vent/hood, and the big built-ins — counters, cabinets, oven,
// fridge, sinks, shelves) or `decor` (tiny fixed dressing — thin cut-food/garnish
// that would otherwise form unstable micro-stacks; kept static on purpose and
// flagged in the summary). EVERYTHING ELSE — tables, chairs, stools, crates, pots,
// pans, plates, dishes, whole food, condiments — is a dynamic, knockable rigid body.
// scene.js and referee.js read this SAME flag so collider, mesh, and disguise pool
// stay in lockstep. Absent flag => dynamic (the world defaults to knockable now).
export function isStaticEntry(c) {
  return !!(c && (c.static || c.decor));
}

// ARCHITECTURE (disguise-anything, Part B). A catalog entry is world ARCHITECTURE —
// floors, boundary/room walls, wall panels/dividers, ceilings, the ground — iff it
// carries an `arch`/`floor`/`wall`/`ceiling` flag. Architecture is the ONE thing a
// player may NOT disguise as: it stays pure scenery + world collision and never enters
// the prop/disguise stream. Everything else (all props + every non-architecture fixture:
// tables, chairs, food, the vent/extractor hood, counters, cabinets, oven, fridge,
// sinks, shelves, doors, AND pillars) is disguisable. Referee, scene and the headless
// eligibility check all read THIS one classifier so they can never drift.
export function isArchEntry(c) {
  return !!(c && (c.arch || c.floor || c.wall || c.ceiling));
}

// DISGUISE ELIGIBILITY (Part B). "Has a renderable mesh AND is not architecture." Every
// catalog entry carries a primitive `shape` (its fallback + GLB size target), so a real
// mesh is always drawable; the only exclusion is architecture. Pure + dependency-free so
// the referee (building the disguise pool) and tools/check-disguise-eligibility.mjs run
// the exact same rule.
export function isDisguisableEntry(c) {
  return !!(c && c.shape && !isArchEntry(c));
}

// FEEL TUNING (2026-07). The single derivation point for the physics-feel knobs,
// used by BOTH the host's authoritative world and every client's prediction world.
// Both sims call this with the SAME `feel` object (config.js loads one
// physics-feel.json into the shared cfg), so they can never derive mismatched feel
// and rubber-band a match. Defaults here match Rapier's own defaults (restitution 0,
// solver 4/friction 4) EXCEPT the two we deliberately raise, so a missing/partial
// config still yields sane, rigid behaviour. Pure + side-effect-free so the offline
// parity check (tools/check-physics-feel.mjs) can import and diff it. See
// notes/physics.md (feel-tuning section).
export function resolveFeel(feel) {
  const f = feel || {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    restitution: num(f.restitution, 0.0),
    numSolverIterations: num(f.numSolverIterations, 12),
    numAdditionalFrictionIterations: num(f.numAdditionalFrictionIterations, 4),
    propLinearDamping: num(f.propLinearDamping, 0.4),
    propAngularDamping: num(f.propAngularDamping, 0.4),
    capGroundedImpulse: f.capGroundedImpulse !== false, // default ON
    // Depenetration failsafe (Bug 2, 2026-07-11): if a capsule STARTS a substep
    // genuinely penetrating solid geometry (e.g. a wall-top jump landed it slightly
    // inside a thin edge), snap it back to its last collision-free position rather
    // than let the swept query drop it through the wall. Default ON; flip OFF here if
    // a live playtest shows it stuttering (it can only ADD stability, never remove it).
    depenetrate: f.depenetrate !== false,
    // Ground stick (pass #5, the standing-on-objects BOB). A grounded player used to
    // get vy=0, so the next substep's movement had NO downward component, so
    // computedGrounded() read false, so gravity applied, so it re-grounded — the flag
    // flipped EVERY OTHER substep on a dynamic prop (measured: 593 flips/600 substeps),
    // which 15 Hz round2-quantised snapshots + reconciliation turn into the visible bob
    // (and it made jump flaky on props, since jumping requires `grounded`). Instead a
    // grounded, non-jumping player keeps a small constant downward velocity so the swept
    // controller holds contact and grounding stays stable. Must satisfy
    // stick/60 >= controllerOffset (0.02) so one substep's press reaches the surface.
    groundStickSpeed: num(f.groundStickSpeed, 1.5),
  };
}

// Load + init Rapier exactly once. Returns the ready RAPIER namespace, or throws
// if the CDN is unreachable (callers fall back to the non-physics path).
export async function loadRapier() {
  if (_RAPIER) return _RAPIER;
  if (!_loadPromise) {
    _loadPromise = (async () => {
      const mod = await import(/* @vite-ignore */ RAPIER_URL);
      const R = mod.default || mod;
      await R.init();
      _RAPIER = R;
      return R;
    })().catch((e) => {
      _loadPromise = null; // allow a later retry
      throw e;
    });
  }
  return _loadPromise;
}

// Half-extents / radii for a catalog entry's collider.
//
// PREFERENCE ORDER:
//   1. MEASURED bounds — if config.js attached `c.measured` (a normalized
//      world-space {w,h,d} box from shared/config/asset-dims.json, the output of
//      the bounding-box normalization build), bake a cuboid straight from it. This
//      is the design intent: "cuboid approximations from the measured bounds
//      (trimesh only where a cuboid is clearly wrong)" — real measurements, never
//      guessed sizes. A measured box supersedes the primitive shape entirely.
//   2. FALLBACK — the hand-authored primitive footprint (box/cylinder/cone/ball
//      from the catalog w/h/d/r). Robust and synchronous, but eyeballed. This is
//      what ships until the measured file is populated.
//
// Convex hulls baked from the GLB meshes were considered but rejected for a blind
// one-pass build: the GLBs load async and can fail, so coupling collision to them
// would make the world non-deterministic in shape. Documented in notes/physics.md.
function shapeFor(RAPIER, c) {
  const m = c.measured;
  if (m && m.w > 0 && m.h > 0 && m.d > 0) {
    return { desc: RAPIER.ColliderDesc.cuboid(m.w / 2, m.h / 2, m.d / 2), halfH: m.h / 2 };
  }
  switch (c.shape) {
    case 'box':
      return { desc: RAPIER.ColliderDesc.cuboid((c.w || 1) / 2, (c.h || 1) / 2, (c.d || 1) / 2), halfH: (c.h || 1) / 2 };
    case 'cylinder':
      return { desc: RAPIER.ColliderDesc.cylinder((c.h || 1) / 2, c.r || 0.5), halfH: (c.h || 1) / 2 };
    case 'cone':
      return { desc: RAPIER.ColliderDesc.cone((c.h || 1) / 2, c.r || 0.5), halfH: (c.h || 1) / 2 };
    case 'sphere':
      return { desc: RAPIER.ColliderDesc.ball(c.r || 0.5), halfH: c.r || 0.5 };
    default:
      return { desc: RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), halfH: 0.5 };
  }
}

// Pure footprint half-extents for a catalog entry — measured bounds first, else the
// primitive shape — with NO Rapier dependency. shapeFor() (which needs a real
// ColliderDesc) and the headless solidity check (tools/check-physics-solidity.mjs,
// which has no Rapier) both derive sizes from HERE, so engine and check can never drift
// on what a collider's size is. `box` marks whether a cuboid collider is used (a
// measured entry always forces a cuboid — see shapeFor / notes/asset-dims.md).
export function halfExtentsFor(c) {
  const m = c && c.measured;
  if (m && m.w > 0 && m.h > 0 && m.d > 0) return { hx: m.w / 2, hy: m.h / 2, hz: m.d / 2, box: true };
  switch (c && c.shape) {
    case 'box':
      return { hx: (c.w || 1) / 2, hy: (c.h || 1) / 2, hz: (c.d || 1) / 2, box: true };
    case 'cylinder':
    case 'cone':
      return { hx: c.r || 0.5, hy: (c.h || 1) / 2, hz: c.r || 0.5, box: false };
    case 'sphere':
      return { hx: c.r || 0.5, hy: c.r || 0.5, hz: c.r || 0.5, box: false };
    default:
      return { hx: 0.5, hy: 0.5, hz: 0.5, box: true };
  }
}

// Pure thin-wall thickening decision (Bug 2). Given a static box's HORIZONTAL half-
// extents, return the FINAL half-extents after the min-thickness grow. This is the ONE
// source of truth shared by _buildStatic (the live collider) and the headless check
// (the regression guard), so the "which walls got thickened" rule can't diverge between
// them. A wide+thin PANEL — one horizontal axis long, the other thinner than minHalf and
// ≤ half the long one — gets its thin axis grown to minHalf (symmetric about the centre,
// long axis + visible mesh untouched). Narrow posts/pillars (thin in BOTH axes: a wider
// capsule can't tunnel them) are left exactly as authored. Returns {hx, hz, grew}.
export function thickenWallHalfExtents(hx, hz, minHalf) {
  const thin = Math.min(hx, hz);
  const wide = Math.max(hx, hz);
  const isPanel = thin < minHalf && wide >= 2 * thin;
  if (!isPanel) return { hx, hz, grew: false };
  if (hx <= hz) return { hx: minHalf, hz, grew: true };
  return { hx, hz: minHalf, grew: true };
}

export class PhysicsWorld {
  // RAPIER: the inited module from loadRapier().
  // map, propInstances, catalog: the same data the renderer uses.
  // opts.dynamicProps: true on the host (props are real rigid bodies that get
  //   shoved); false on a guest predictor (props are fixed obstacles the local
  //   character still collides against — host stays authoritative over their
  //   motion, guests just reconcile).
  // opts.rules: the tunables bundle (moveSpeed, gravity, jumpSpeed, player size).
  constructor(RAPIER, map, propInstances, catalog, opts = {}) {
    this.R = RAPIER;
    this.rules = opts.rules || {};
    // FEEL knobs (restitution / solver iterations / prop damping / anti-bob), derived
    // through the ONE shared resolveFeel() so host + client are byte-identical.
    this.feel = resolveFeel(opts.feel);
    this.dynamicProps = !!opts.dynamicProps;
    this.map = map;
    // Keep the render catalog so the disguise-rotation gate (Bug 3) can look up a
    // prop's footprint to shape-cast it against world geometry before letting it turn.
    this.catalog = catalog || {};

    // Movement-query obstacle filter (Bug 1). computeColliderMovement's DEFAULT filter
    // already treats dynamic bodies as obstacles — nothing was excluding them (the
    // "filter excludes dynamic props" theory is REFUTED by the code). We pass an
    // explicit EXCLUDE_SENSORS filter anyway so the intent is unambiguous and
    // future-proof: dynamic props BLOCK the capsule (it compresses against a chair and
    // pushes it, never occupies its space) while applyImpulsesToDynamicBodies(true)
    // still lets the push happen. Sensors (none today) are the only thing skipped.
    this._moveFilter = (RAPIER.QueryFilterFlags && RAPIER.QueryFilterFlags.EXCLUDE_SENSORS) || undefined;

    const g = this.rules.gravity != null ? this.rules.gravity : 22;
    this.world = new RAPIER.World({ x: 0, y: -g, z: 0 });

    // SOLVER STIFFNESS (feel dial 2). Raise the contact-solver iteration counts so
    // stiff contacts resolve fully in one step — the main fix for BOTH the
    // sink-into-props penetration and most of the standing-on-object bobbing. The
    // knob names differ across Rapier versions (numSolverIterations is the current
    // @dimforge/rapier3d-compat 0.14 TGS-soft API; older builds used
    // maxVelocity/PositionIterations), so we feature-detect each property before
    // writing it — an API mismatch silently no-ops instead of throwing, and the sim
    // just runs at Rapier's default iteration count. `in` sees the class
    // getters/setters on integrationParameters' prototype.
    const ip = this.world.integrationParameters;
    if (ip) {
      if ('numSolverIterations' in ip) ip.numSolverIterations = this.feel.numSolverIterations;
      if ('numAdditionalFrictionIterations' in ip) ip.numAdditionalFrictionIterations = this.feel.numAdditionalFrictionIterations;
      // Older-API fallbacks (pre-TGS-soft): only touched if the modern knob is absent.
      if (!('numSolverIterations' in ip) && 'maxVelocityIterations' in ip) ip.maxVelocityIterations = this.feel.numSolverIterations;
      if (!('numSolverIterations' in ip) && 'maxPositionIterations' in ip) ip.maxPositionIterations = Math.max(1, Math.round(this.feel.numSolverIterations / 3));
    }
    // FIXED physics timestep. step(dt) banks real elapsed time in _acc and runs
    // whole _fixedDt steps only — never a variable partial step — so the sim is
    // frame-rate independent and reconciliation replay is deterministic. Render
    // smoothing to the display rate is done by the callers (scene.interpolate for
    // remote bodies; the local predicted pose is read fresh each frame).
    this._fixedDt = 1 / 60;
    this.world.timestep = this._fixedDt;
    this._acc = 0;

    this.players = new Map(); // id -> { body, collider, vy, grounded }
    this.propBodies = []; // { id, body } for dynamic props (host only)
    this._controller = null; // one reusable KinematicCharacterController

    this._pRadius = this.rules.playerRadius != null ? this.rules.playerRadius : 0.4;
    this._pHalf = this.rules.playerHalfHeight != null ? this.rules.playerHalfHeight : 0.5;
    this._pCenterY = this._pRadius + this._pHalf; // capsule centre rests base at y=0

    // FIX #5 tunables — NEW knobs with safe defaults, NOT a re-tune of existing feel/rules.
    //  - _maxStuckSubsteps (Bug A escape hatch): how many CONSECUTIVE substeps the snap-to-
    //    anchor failsafe may fail to clear penetration before the escape hatch fires. 20 @
    //    60 Hz ≈ 0.33 s, so a wedged player with a poisoned anchor is freed well within 1 s.
    //  - _propSkin / _propMaxPush (Bug B): the character-vs-prop depenetration's overlap
    //    tolerance and the max per-substep push-out (a firm block, never a teleport-snap).
    this._maxStuckSubsteps = this.rules.depenetrateMaxStuckSubsteps != null ? this.rules.depenetrateMaxStuckSubsteps : 20;
    this._propSkin = this.rules.propDepenetrateSkin != null ? this.rules.propDepenetrateSkin : 0.03;
    this._propMaxPush = this.rules.propDepenetrateMaxPush != null ? this.rules.propDepenetrateMaxPush : 0.2;
    this._stuckPlayerIds = new Set(); // ids the escape hatch couldn't free → referee respawns
    this._propObstacles = []; // per-prop {body|cx,cy,cz, hx,hy,hz} for character-vs-prop push-out

    this._buildStatic(map, catalog);
    this._buildProps(propInstances, catalog);
    this._buildController();
  }

  // ---- construction --------------------------------------------------------
  _buildStatic(map, catalog) {
    const R = this.R;
    const half = map.size / 2;
    const rest = this.feel.restitution; // 0 = nothing bounces (feel dial 1)

    // Handles of the STATIC WORLD colliders only (ground slab, boundary walls, static
    // fixtures) — NOT props. The depenetration failsafe (_isPenetrating, Bug 2) queries
    // ONLY this set: it must recover a capsule that STARTED a substep inside solid,
    // immovable geometry (a wall-top tunnel), but it must NEVER snap a player back for
    // touching a knockable PROP (those are meant to be shoved via collide-and-slide, not
    // depenetrated). Testing props here was the "bounce off empty air / can't move toward
    // the middle / confined to a strip" regression: with the world now defaulting to ~130
    // dynamic props (fix #2) and a disguised player wearing a fatter capsule (pass #3), a
    // player pushing through props tripped the failsafe every substep and was yanked back.
    // The set is built identically on the host (props = dynamic) and every guest predictor
    // (props = fixed obstacles), so props are excluded from depenetration on BOTH — the
    // fix can't rubber-band. See notes/physics.md (RELAUNCH #2).
    this._staticHandles = new Set();
    const addStatic = (col) => { this._staticHandles.add(col.handle); return col; };

    // Ground: a thick fixed slab whose TOP face sits exactly at y=0. Extended well
    // DOWNWARD (3 m thick, top unchanged) so a fast/falling body can't punch through
    // the floor between substeps (fix #5). Render is unaffected (the visible ground
    // is a separate flat plane at y=0).
    addStatic(this.world.createCollider(
      R.ColliderDesc.cuboid(half + 2, 1.5, half + 2).setTranslation(0, -1.5, 0).setFriction(0.9).setRestitution(rest)
    ));

    // Boundary walls. Thickened to ~1.5 m and EXTENDED OUTWARD (the inner, arena-
    // facing face stays exactly where it was) and taller (5 m, base at y=0) so a
    // high-speed run into a wall can't tunnel and nobody flies over (fix #5). The
    // render meshes (scene.js enclosing box) are untouched.
    const wallInset = 0.5; // inner collider face sits this far inside the map edge (unchanged)
    const wallTZ = 0.75; // half-thickness -> 1.5 m thick
    const wallHY = 2.5; // half-height -> 5 m tall
    const cOut = half - wallInset + wallTZ; // centre distance from origin (pushed OUTWARD)
    const along = half + wallTZ; // long-axis half-extent (covers the corners)
    const walls = [
      [0, wallHY, -cOut, along, wallHY, wallTZ],
      [0, wallHY, cOut, along, wallHY, wallTZ],
      [-cOut, wallHY, 0, wallTZ, wallHY, along],
      [cOut, wallHY, 0, wallTZ, wallHY, along],
    ];
    for (const [x, y, z, hx, hy, hz] of walls) {
      addStatic(this.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRestitution(rest)));
    }

    // Static fixtures — ONLY the genuinely bolted-in pieces (`static`). Knockable
    // fixtures are promoted into the dynamic prop stream by the referee (fix #2), so
    // they're not built here. Cheap: fixed colliders don't simulate.
    for (const f of map.fixtures || []) {
      const c = catalog[f.type];
      if (!c || !c.static) continue;
      const { desc, halfH } = shapeFor(R, c);
      if (c.floor) {
        // FLOOR PIECE (fix #5): grow the collider to ~1 m thick, extended DOWNWARD so
        // its visible TOP surface stays at exactly the same height (top = 2*halfH +
        // f.y). Height grows AND the centre drops by half the added depth. The render
        // mesh keeps its thin look; only the physics shell thickens.
        const top = 2 * halfH + (f.y || 0);
        const thick = Math.max(1.0, 2 * halfH);
        const hx = halfExtentXZ(c, 'w');
        const hz = halfExtentXZ(c, 'd');
        const fc = R.ColliderDesc.cuboid(hx, thick / 2, hz)
          .setTranslation(f.x, top - thick / 2, f.z)
          .setFriction(0.9)
          .setRestitution(rest);
        if (f.rot) fc.setRotation(yawQuat(f.rot));
        addStatic(this.world.createCollider(fc));
        continue;
      }
      // ANTI-TUNNEL for thin wall PANELS (Bug 2, solidity pass #3). A wide, thin static
      // panel — the kitchen/dining divider headers (w3.7 d0.4) and the side walls
      // (w6 d0.4) — is thinner front-to-back than the player capsule is wide. A fast jump
      // INTO its broad face can, at the wrong angle, resolve the swept contact to the FAR
      // side and pop the capsule through (then drop it through the floor beyond — the
      // reported wall→floor fall-through). Grow ONLY the thin horizontal axis to a minimum
      // half-thickness that clears the capsule radius, symmetric about the fixture centre,
      // so the long axis (window/walkway spacing) and the visible mesh are untouched. This
      // targets PANELS only (one horizontal axis ≥2× the other): narrow posts/pillars and
      // bulky appliances are left exactly as authored (they can't tunnel a wider capsule,
      // and thickening them would add annoying invisible collision). Guarded to box shapes.
      const isBox = c.shape === 'box' || (c.measured && c.measured.w > 0 && c.measured.d > 0);
      const minHalf = this.rules.minWallHalfThickness != null ? this.rules.minWallHalfThickness : 0.6;
      const hx0 = halfExtentXZ(c, 'w');
      const hz0 = halfExtentXZ(c, 'd');
      // Shared grow rule (thickenWallHalfExtents) — the SAME decision the headless check
      // asserts, so live colliders and the regression guard can't disagree on which walls
      // got thickened. Only box fixtures are eligible.
      const grown = isBox ? thickenWallHalfExtents(hx0, hz0, minHalf) : { hx: hx0, hz: hz0, grew: false };
      if (grown.grew) {
        const wc = R.ColliderDesc.cuboid(grown.hx, halfH, grown.hz)
          .setTranslation(f.x, halfH + (f.y || 0), f.z)
          .setRestitution(rest);
        if (f.rot) wc.setRotation(yawQuat(f.rot));
        addStatic(this.world.createCollider(wc));
        continue;
      }
      desc.setTranslation(f.x, halfH + (f.y || 0), f.z).setRestitution(rest);
      if (f.rot) desc.setRotation(yawQuat(f.rot));
      addStatic(this.world.createCollider(desc));
    }
  }

  _buildProps(propInstances, catalog) {
    const R = this.R;
    // Handles of every PROP collider (dynamic bodies AND fixed obstacles), the exact
    // complement of _staticHandles. The player-vs-prop depenetration (fix #5 Bug B,
    // implemented in pass #5 — see _depenetrateFromProps) keys off THIS set so it only
    // ever pushes the capsule out of props, never off world geometry (which the
    // static-only snap failsafe owns). Built identically on host + guest predictors.
    this._propHandles = new Set();
    // id -> fixed prop collider, for a PREDICTION world only: syncPropTransforms
    // repositions these to the host's live transforms each snapshot so local collision
    // stops drifting from where the props actually are (pass #5, stale-ghost fix).
    this._fixedPropColliders = new Map();
    // Phone-safety budget: cap how many props are DYNAMIC (real simulated rigid
    // bodies). Past the cap, extras become solid STATIC colliders — fully collidable,
    // just not shovable — so a dense map degrades to "the smallest clutter doesn't
    // get knocked around" instead of tanking a phone's frame rate. The referee lists
    // props BIGGEST-FIRST after the disguise pool, so the cap spends its budget on
    // furniture + substantial items and only the tiniest overflow goes static.
    // Restaurant now runs ~136 dynamic candidates (56 disguise props + ~80 knockable
    // fixtures) against rules.maxDynamicProps (130) — nearly everything is knockable;
    // aggressive sleeping keeps the steady-state cost near zero. Phone HOSTS are the
    // watch item (see notes/physics.md); lower the cap if a warm phone struggles.
    const cap = this.rules.maxDynamicProps != null ? this.rules.maxDynamicProps : 80;
    const dens = this.rules.propDensity != null ? this.rules.propDensity : 1.0;
    let dynCount = 0;
    for (const p of propInstances || []) {
      const c = catalog[p.type];
      if (!c) continue;
      // Disguise-anything (Part B): a non-architecture STATIC fixture (counter, oven,
      // fridge, pillar, door, vent…) is promoted into the prop stream by the referee ONLY
      // so a player can aim at + disguise as it. Its immovable collider is already built by
      // _buildStatic from map.fixtures, so skip it here — a second body would double the
      // collider (and on the host a DYNAMIC body wedged inside a static clone would explode).
      // Architecture never reaches propInstances. The disguised player's OWN capsule still
      // grows to this footprint via setPlayerCollider, exactly as for a knockable prop.
      if (isStaticEntry(c)) continue;
      const { desc, halfH } = shapeFor(R, c);
      // A prop instance carries EITHER spawn semantics (x/z = floor position, y =
      // rest offset above the surface, rot = yaw) OR — for a mid-round joiner's
      // catch-up (fix #8) — a live transform: x/y/z = body CENTRE plus a full
      // quaternion. `moved` distinguishes them so a late joiner sees the room as it
      // actually is (a chair kicked across the room stays kicked).
      const moved = Number.isFinite(p.qx);
      const cy = moved ? p.y : halfH + (p.y || 0);
      if (this.dynamicProps && dynCount < cap) {
        // Host: a real rigid body that can be knocked around and settles to sleep.
        // Spawn a hair above rest (SPAWN_EPS) so nothing starts interpenetrating.
        const spawnY = moved ? cy : cy + SPAWN_EPS;
        const spawnQ = moved
          ? { x: p.qx, y: p.qy, z: p.qz, w: p.qw }
          : p.rot
            ? yawQuat(p.rot)
            : { x: 0, y: 0, z: 0, w: 1 };
        // DAMPING (feel dial 3): props settle instead of oscillating/wiggling. From
        // physics-feel.json so a playtest can retune without a rebuild.
        const bodyDesc = R.RigidBodyDesc.dynamic()
          .setTranslation(p.x, spawnY, p.z)
          .setRotation(spawnQ)
          .setLinearDamping(this.feel.propLinearDamping)
          .setAngularDamping(this.feel.propAngularDamping);
        // CCD (fix #6): a shoved prop can move fast enough in one substep to skip
        // through a thin collider — swept detection closes that hole. Method-guarded.
        if (bodyDesc.setCcdEnabled) bodyDesc.setCcdEnabled(true);
        const body = this.world.createRigidBody(bodyDesc);
        const col = this.world.createCollider(desc.setFriction(0.8).setRestitution(this.feel.restitution).setDensity(dens), body);
        this._propHandles.add(col.handle);
        // Keep the spawn transform so the failsafe can respawn a prop that escapes the
        // world below the floor (fix #4). See respawnEscaped. minHalf = the smallest
        // half-extent = the lowest the body CENTRE can legitimately sit above the floor
        // in any orientation; the per-substep buried-prop recovery (pass #5) keys off it.
        const he = halfExtentsFor(c);
        this.propBodies.push({
          id: p.id, body,
          spawn: { x: p.x, y: spawnY, z: p.z, q: spawnQ },
          minHalf: Math.min(he.hx, he.hy, he.hz),
        });
        dynCount++;
      } else {
        // Fixed obstacle. Three cases land here:
        //  - Guest predictor: host owns all prop motion, so the local character just
        //    collides against these positions; reconciliation corrects the rare case
        //    where a prop has actually been shoved elsewhere.
        //  - Host past the dynamic cap: same solid collider, simply not simulated
        //    (phone-safety — still fully collidable, just not shovable).
        desc.setTranslation(p.x, cy, p.z).setRestitution(this.feel.restitution);
        if (moved) desc.setRotation({ x: p.qx, y: p.qy, z: p.qz, w: p.qw });
        else if (p.rot) desc.setRotation(yawQuat(p.rot));
        const col = this.world.createCollider(desc);
        this._propHandles.add(col.handle);
        this._fixedPropColliders.set(p.id, col);
      }
    }
  }

  _buildController() {
    const r = this.rules;
    // Small skin offset (0.01–0.05): the controller keeps the capsule this far off
    // geometry so it never quite touches — the corrected-movement result is applied,
    // so the capsule NEVER interpenetrates and there is nothing to "recover" from
    // (no clip-then-eject). Tunable via rules.controllerOffset.
    const offset = r.controllerOffset != null ? r.controllerOffset : 0.02;
    const c = this.world.createCharacterController(offset);
    c.enableAutostep(0.3, 0.15, true); // step up over small clutter (chairs' feet, low props)
    // Snap-to-ground keeps the capsule glued when walking downhill / down steps, but
    // it FIGHTS an ascending jump (the classic jitter). It is DEFAULT ON here and
    // toggled OFF per-substep whenever vertical velocity is positive (see _substep).
    this._snapDist = r.snapDistance != null ? r.snapDistance : 0.3;
    c.enableSnapToGround(this._snapDist);
    c.setApplyImpulsesToDynamicBodies(true); // players shove dynamic props (the tell)
    // Give the character a sane mass so walking into a chair SHOVES it naturally
    // instead of nudging a near-massless body into orbit (props use rules.propDensity).
    // Tune together with propDensity in a live feel-test.
    if (c.setCharacterMass) c.setCharacterMass(r.characterMass != null ? r.characterMass : 3.0);
    c.setSlideEnabled(true);
    if (c.setMaxSlopeClimbAngle) c.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    if (c.setMinSlopeSlideAngle) c.setMinSlopeSlideAngle((40 * Math.PI) / 180);
    this._controller = c;
  }

  // ---- players -------------------------------------------------------------
  addPlayer(id, spawn) {
    if (this.players.has(id)) {
      this.setPlayerPosition(id, spawn);
      return;
    }
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, this._pCenterY + (spawn.y || 0), spawn.z)
    );
    // CCD (fix #6): enable continuous collision detection on the character capsule so
    // high-speed motion (a hard fall, a fast run at a thin wall) is swept rather than
    // sampled — it can't tunnel through a collider between substeps. Method-guarded so
    // an older Rapier build can't throw here.
    if (body.enableCcd) body.enableCcd(true);
    // Slightly smaller collider than the visual capsule so it slips through gaps a
    // touch more forgivingly and never wedges on its own body offset.
    const collider = this.world.createCollider(R.ColliderDesc.capsule(this._pHalf, this._pRadius), body);
    const t0 = body.translation();
    // safePos = last collision-free capsule position, seeded at spawn. The depenetration
    // failsafe (Bug 2) snaps the capsule back here if a substep starts inside geometry.
    // radius/half/disguiseType: the capsule's CURRENT girth. A disguised player's capsule
    // is grown to their disguise footprint (solidity pass #3, setPlayerCollider) so a big
    // disguise is solid instead of clipping into world props; base player size until then.
    this.players.set(id, {
      body, collider, vy: 0, grounded: false,
      radius: this._pRadius, half: this._pHalf, disguiseType: null,
      input: { mx: 0, mz: 0, yaw: 0, jump: false },
      safePos: { x: t0.x, y: t0.y, z: t0.z },
    });
  }

  hasPlayer(id) {
    return this.players.has(id);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.world.removeRigidBody(p.body); // also removes its collider
    this.players.delete(id);
  }

  setPlayerInput(id, input) {
    const p = this.players.get(id);
    if (p) p.input = input;
  }

  // Teleport (reconciliation / respawn). Resets vertical velocity so a correction
  // doesn't fling the body.
  setPlayerPosition(id, pos) {
    const p = this.players.get(id);
    if (!p) return;
    const y = this._pCenterY + (pos.y || 0);
    p.body.setNextKinematicTranslation({ x: pos.x, y, z: pos.z });
    p.body.setTranslation({ x: pos.x, y, z: pos.z }, false);
    p.vy = 0;
    // A teleport (reconciliation / respawn) is by construction a fresh valid spot, so
    // reset the depenetration anchor to it — otherwise it could snap back to a stale one.
    p.safePos = { x: pos.x, y, z: pos.z };
  }

  getPlayer(id) {
    const p = this.players.get(id);
    if (!p) return null;
    const t = p.body.translation();
    // _pCenterY is the SAME for every player, disguised or not: setPlayerCollider keeps
    // the capsule's total height constant (radius + half === _pCenterY always), so the
    // body origin stays the geometric centre and the foot stays at y=0. Only girth changes.
    return { x: t.x, y: t.y - this._pCenterY, z: t.z, grounded: p.grounded };
  }

  // Capsule (radius, cylinder-half-height) for a player wearing `disguiseType`, or the
  // base player size when null. THE Bug-1 (solidity pass #3) mechanism: a disguised
  // player's physics body used to stay a fixed tiny capsule (r 0.4) no matter how big
  // their disguise LOOKED, so they could shove that big silhouette into — and fully
  // inside — world props while the little capsule slipped into the gap ("hide inside a
  // prop"). Fitting the capsule GIRTH to the disguise footprint makes a crate-disguised
  // player collide crate-to-crate: they rest against world props instead of tunnelling in.
  //   - radius fits the SMALLER horizontal half-extent of the disguise (so the capsule
  //     sits inside the silhouette), never below the base player radius, and is capped
  //     for passability (rules.disguiseColliderMaxRadius, default 0.55 → diameter 1.1,
  //     still clears the 1.2-wide doors/walkways).
  //   - TOTAL height is held constant at 2*_pCenterY: half = _pCenterY - radius. So the
  //     centre height, grounding, jump, autostep and snap-to-ground feel are byte-identical
  //     to the base capsule — only the belly gets fatter. No re-seat needed.
  // Measured bounds first (dormant today — asset-dims not wired), else the primitive.
  _capsuleDimsFor(type) {
    const baseR = this._pRadius;
    const c = type && this.catalog[type];
    if (!c) return { r: baseR, half: this._pHalf };
    const m = c.measured;
    let hw, hd;
    if (m && m.w > 0 && m.d > 0) { hw = m.w / 2; hd = m.d / 2; }
    else if (c.shape === 'cylinder' || c.shape === 'cone' || c.shape === 'sphere') { hw = hd = c.r || 0.5; }
    else { hw = (c.w || 1) / 2; hd = (c.d || 1) / 2; }
    const maxR = this.rules.disguiseColliderMaxRadius != null ? this.rules.disguiseColliderMaxRadius : 0.55;
    // Keep maxR strictly below _pCenterY so `half` stays positive.
    const cap = Math.min(maxR, this._pCenterY - 0.1);
    const r = Math.min(cap, Math.max(baseR, Math.min(hw, hd)));
    const half = Math.max(0.05, this._pCenterY - r);
    return { r, half };
  }

  // Resize a player's capsule collider to match their current disguise (Bug 1). Called
  // by the host referee (applyDisguise/undisguise) and by each client's OWN prediction
  // world (main.js onSnapshot) whenever the disguise changes, so both sims step an
  // identically-sized body and never rubber-band. No-op when the disguise is unchanged.
  // Total height/centre are preserved (see _capsuleDimsFor), so nothing needs re-seating.
  setPlayerCollider(id, disguiseType) {
    const p = this.players.get(id);
    if (!p) return;
    const type = disguiseType || null;
    if (p.disguiseType === type) return; // unchanged — skip the rebuild
    const dims = this._capsuleDimsFor(type);
    if (p.collider && this.world.removeCollider) this.world.removeCollider(p.collider, false);
    p.collider = this.world.createCollider(this.R.ColliderDesc.capsule(dims.half, dims.r), p.body);
    p.radius = dims.r;
    p.half = dims.half;
    p.disguiseType = type;
  }

  // Is the player capsule genuinely PENETRATING a solid collider right now? (Bug 2
  // depenetration.) Tests a SKIN-SHRUNK capsule so ordinary resting-on-a-surface
  // contact — which is what a grounded player has every frame — reads as clear; only a
  // real overlap deeper than the skin returns true. Excludes the player's own body.
  // Returns true / false, or null if the intersection query isn't available (caller
  // then does nothing — degrades to the terminal clamp + void failsafe alone).
  _isPenetrating(p) {
    const R = this.R;
    if (typeof this.world.intersectionWithShape !== 'function' || !R.Capsule) return null;
    const skin = 0.05;
    // Use the player's CURRENT capsule size (grown when disguised — solidity pass #3),
    // not the base, so the skin-shrunk depenetration test matches the real body.
    const hh = Math.max(0.02, (p.half != null ? p.half : this._pHalf) - skin);
    const rr = Math.max(0.02, (p.radius != null ? p.radius : this._pRadius) - skin);
    try {
      const t = p.body.translation();
      const shape = new R.Capsule(hh, rr);
      // filterPredicate (Rapier's final intersectionWithShape arg): consider ONLY the
      // static WORLD colliders (walls/floor/fixtures). Returning false for everything
      // else means a knockable PROP the player is legitimately shoving is NOT counted as
      // "penetrating solid geometry", so the failsafe never snaps the player off a prop —
      // it only ever fires on immovable geometry (its actual job: wall-top tunnel + floor).
      const staticOnly = this._staticHandles
        ? (col) => this._staticHandles.has(col.handle)
        : undefined;
      const hit = this.world.intersectionWithShape(
        { x: t.x, y: t.y, z: t.z }, IDENT_QUAT, shape, this._moveFilter, undefined, p.collider, p.body, staticOnly
      );
      return !!hit;
    } catch {
      return null;
    }
  }

  // Disguise-rotation gate (Bug 3). Would turning the disguised prop to `yaw` push its
  // FOOTPRINT into world geometry (a wall/fixture/other prop) it can't fit into rotated?
  // The player's own collision body is a symmetric capsule, so its physics can't wedge
  // on yaw — this instead shape-casts the PROP's footprint (from the catalog) at the
  // player's position and reports whether that box, turned to `yaw`, would intersect.
  // The referee steps dispYaw continuously and calls this each increment; a `true` stops
  // the turn there so the prop never rotates through a wall. Reuses the ONE shared
  // Rapier world + catalog (no parallel collision path). Guarded; false (allow) on any
  // gap so rotation never silently locks up.
  rotationWouldCollide(playerId, propType, yaw) {
    const R = this.R;
    const p = this.players.get(playerId);
    const c = propType && this.catalog[propType];
    if (!p || !c) return false;
    if (typeof this.world.intersectionWithShape !== 'function' || !R.Cuboid) return false;
    // Footprint half-extents (measured bounds first, else the primitive w/d/r).
    const m = c.measured;
    let hw, hd;
    if (m && m.w > 0 && m.d > 0) { hw = m.w / 2; hd = m.d / 2; }
    else {
      hw = (c.w != null ? c.w : (c.r != null ? c.r * 2 : 1)) / 2;
      hd = (c.d != null ? c.d : (c.r != null ? c.r * 2 : 1)) / 2;
    }
    // A square / round footprint sweeps the same area at every yaw — rotating it can't
    // change what it overlaps, so skip the query (cheap + avoids spurious blocks).
    if (Math.abs(hw - hd) < 1e-3) return false;
    try {
      const t = p.body.translation();
      // Box at capsule height, kept clear of the y=0 ground (half-height 0.8, centred at
      // the capsule centre ≈0.9 → spans ~0.1..1.7) so only walls/fixtures/props trip it.
      const pr = p.radius != null ? p.radius : this._pRadius;
      const shape = new R.Cuboid(Math.max(hw, pr), 0.8, Math.max(hd, pr));
      const hit = this.world.intersectionWithShape(
        { x: t.x, y: t.y, z: t.z }, yawQuat(yaw), shape, this._moveFilter, undefined, p.collider, p.body
      );
      return !!hit;
    } catch {
      return false;
    }
  }

  // ---- step ----------------------------------------------------------------
  // Advance the sim by dt (seconds) in FIXED _fixedDt substeps only — never a
  // variable partial step. Real elapsed time is banked in _acc and drained one
  // whole substep at a time; the leftover (< _fixedDt) carries to the next call.
  // A per-call guard caps substeps so a slow phone / long stall degrades gracefully
  // instead of spiralling (backlog past the cap is dropped). Each substep moves
  // every player via the character controller, then steps the dynamics.
  step(dt) {
    const h = this._fixedDt;
    this._acc += Math.min(dt, 0.1); // cap the banked time (mobile spiral guard)
    let guard = 0;
    while (this._acc >= h && guard < 6) {
      this._substep(h);
      this._acc -= h;
      guard++;
    }
    if (guard >= 6) this._acc = 0; // huge stall: drop the backlog rather than spiral
  }

  _substep(dt) {
    const g = this.rules.gravity != null ? this.rules.gravity : 22;
    const jumpSpeed = this.rules.jumpSpeed != null ? this.rules.jumpSpeed : 8;
    const moveSpeed = this.rules.moveSpeed != null ? this.rules.moveSpeed : 6;
    // Terminal fall speed cap (Bug 2). Bounds how far a falling capsule can travel in
    // one substep (maxFall/60 ≈ 0.33 m at 20 u/s — far less than any wall/floor
    // thickness), so combined with the controller's SWEPT movement query a single
    // frame can never leap past a collider. From rules.json (shared by both sims).
    const maxFall = this.rules.maxFallSpeed != null ? this.rules.maxFallSpeed : 20;

    for (const [id, p] of this.players) {
      // DEPENETRATION FAILSAFE (Bug 2): if this substep begins with the capsule
      // genuinely INSIDE solid geometry (a wall-top jump can leave it a hair inside a
      // thin edge), the swept query would start from an illegal state and can drop the
      // capsule clean through the wall. Snap back to the last collision-free position
      // and kill the fall instead of tunnelling. Skin-shrunk test (below) so ordinary
      // resting-on-a-surface contact never trips it. Cheap, guarded, no-ops if the
      // intersection API is unavailable.
      // ESCAPE HATCH (fix #5 Bug A, implemented in pass #5): if the snap fails to clear
      // penetration for _maxStuckSubsteps CONSECUTIVE substeps, the anchor itself is
      // poisoned (recorded while already wedged) — the player is permanently stuck.
      // Flag them for the referee's failsafe sweep to respawn instead of leaving them
      // pinned; a guest predictor also flags, but only the host acts (guests just get
      // corrected by the authoritative respawn through the normal snapshot).
      if (this.feel.depenetrate && p.safePos && this._isPenetrating(p) === true) {
        p.body.setTranslation({ x: p.safePos.x, y: p.safePos.y, z: p.safePos.z }, false);
        p.vy = 0;
        p.stuckSubsteps = (p.stuckSubsteps || 0) + 1;
        if (p.stuckSubsteps >= this._maxStuckSubsteps) {
          this._stuckPlayerIds.add(id);
          p.stuckSubsteps = 0;
        }
      } else {
        p.stuckSubsteps = 0;
      }

      const inp = p.input || { mx: 0, mz: 0, yaw: 0, jump: false };
      const sin = Math.sin(inp.yaw);
      const cos = Math.cos(inp.yaw);
      // forward = (-sin,-cos), right = (cos,-sin) — identical to referee/client.
      let vx = -sin * inp.mz + cos * inp.mx;
      let vz = -cos * inp.mz - sin * inp.mx;
      const len = Math.hypot(vx, vz);
      if (len > 1) {
        vx /= len;
        vz /= len;
      }

      // Vertical: integrate gravity; jump only when grounded. A grounded, non-jumping
      // player keeps a small downward STICK velocity (never 0 — see resolveFeel
      // groundStickSpeed): with desired.y = 0 the next substep's movement query makes
      // no downward contact, computedGrounded() flips false, gravity applies, and the
      // flag oscillates every other substep — the standing-on-objects bob + flaky jump.
      // The swept controller stops the press at the surface, so there is no visible
      // sinking; the press only keeps the ground contact (and grounding) continuous.
      if (p.grounded) {
        p.vy = inp.jump ? jumpSpeed : -this.feel.groundStickSpeed;
      } else {
        p.vy -= g * dt;
      }
      if (p.vy < -maxFall) p.vy = -maxFall; // terminal-velocity clamp (Bug 2)

      // JUMP-JITTER FIX: snap-to-ground pulls the capsule back down and fights an
      // ascending jump, which reads as jitter at takeoff. Enable snapping ONLY when
      // not moving upward (vy <= 0 => falling / standing / walking down steps).
      // Guarded so a build lacking disableSnapToGround can't throw mid-substep.
      const ctl = this._controller;
      if (p.vy > 0) {
        if (ctl.disableSnapToGround) ctl.disableSnapToGround();
      } else {
        ctl.enableSnapToGround(this._snapDist);
      }

      // ANTI-BOBBING (feel dial 3b): when a player is grounded AND standing still,
      // stop feeding impulses into whatever dynamic prop is underfoot. Otherwise the
      // capsule's weight pushes the prop down, the prop springs back next frame, and
      // snap-to-ground chases it → the constant up/down bob reported in the playtest.
      // While MOVING (len > 0) impulses stay ON so walking into a prop still shoves it
      // (the prop-vs-disguise tell is preserved). Feature-guarded; only meaningful on
      // the host (guests have static props), but harmless either way. Toggled per
      // player right before its compute — the controller is shared but used serially.
      if (this.feel.capGroundedImpulse && ctl.setApplyImpulsesToDynamicBodies) {
        const standingStill = p.grounded && !inp.jump && len < 1e-3;
        ctl.setApplyImpulsesToDynamicBodies(!standingStill);
      }

      // Resolve how far the capsule CAN move BEFORE moving it: computeCollider
      // movement returns a corrected delta that never enters geometry, and we apply
      // exactly that. The capsule therefore never interpenetrates and is never
      // ejected by penetration recovery.
      const desired = { x: vx * moveSpeed * dt, y: p.vy * dt, z: vz * moveSpeed * dt };
      // Explicit obstacle filter (Bug 1): dynamic props are NOT excluded — they block
      // the capsule as solid obstacles while still being shoved by the impulse pass.
      this._controller.computeColliderMovement(p.collider, desired, this._moveFilter);
      const mv = this._controller.computedMovement();
      p.grounded = this._controller.computedGrounded();
      if (p.grounded && p.vy < 0) p.vy = 0;

      const tr = p.body.translation();
      const nx = tr.x + mv.x, nz = tr.z + mv.z;
      let ny = tr.y + mv.y;
      // HARD FLOOR CLAMP (Bug 2, solidity pass #3 relaunch). The swept mover + terminal
      // clamp + depenetration failsafe make below-floor rare, but a wall-top tunnel could
      // still drop the capsule until the host's THROTTLED (~0.5 s) respawn fires — that gap
      // is the void the players screenshotted. Clamp the capsule foot to the floor plane
      // every substep, un-throttled: the centre can never go below _pCenterY + FLOOR_Y, so
      // the foot can never pass y=FLOOR_Y. This lives in the SHARED substep, so the host's
      // authoritative world and every guest's prediction world apply it identically (no
      // rubber-band). It is purely additive safety — no map has legitimate sub-floor space
      // (the ground slab top is FLOOR_Y everywhere), so it can never fire in normal play;
      // when it does catch a tunnelling capsule it lands it ON the floor instead of the
      // void, and the depenetration anchor below records that valid spot. Props are
      // untouched — they keep their own below-world respawn (respawnEscaped).
      const floorCenterY = this._pCenterY + FLOOR_Y;
      if (ny < floorCenterY) {
        ny = floorCenterY;
        if (p.vy < 0) p.vy = 0;
        p.grounded = true;
      }
      p.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
      // The controller's corrected result never enters geometry (it keeps `offset`
      // clearance), so it is a valid collision-free anchor for the depenetration
      // failsafe above. Recorded every substep so a restore only ever costs one frame.
      p.safePos = { x: nx, y: ny, z: nz };
    }

    // Fixed substep — timestep is _fixedDt (set in the constructor); dt is always
    // _fixedDt here, so the dynamics solver runs at a constant rate.
    this.world.step();

    // PLAYER-vs-PROP DEPENETRATION (fix #5 Bug B, implemented in pass #5). The
    // character controller only SOFTLY resists dynamic bodies: shoving a free prop, the
    // capsule creeps into its footprint (measured up to a full 0.40 m radius) and can
    // cross out the far side — the walk-into/through-props and hide-inside-a-prop bugs.
    // The static-only snap failsafe above deliberately ignores props (pass #4), and
    // nothing else ever separates capsule from prop. So: read the contact manifolds the
    // step just computed and push the PLAYER out of any prop it genuinely overlaps —
    // a firm per-substep push (capped at _propMaxPush), never a teleport-snap. Max
    // approach speed is moveSpeed/60 = 0.1 m per substep, so a 0.2 cap always wins.
    for (const p of this.players.values()) this._depenetrateFromProps(p);

    // BURIED-PROP RECOVERY (pass #5). While a prop is being shoved by (or trampled
    // under) the infinite-mass kinematic capsule, the solver can only resolve the
    // overlap by pushing the PROP — and against the capsule it can drive the prop into
    // the ground slab and pin it there (measured: a shoved table's centre ended at
    // y = -0.56, fully below the floor). minHalf is the lowest a body's centre can
    // legitimately sit in ANY orientation, so lifting only when below it can never
    // fight a normal tumble; velocity is only stripped of its downward component.
    for (const pb of this.propBodies) {
      const t = pb.body.translation();
      const minY = FLOOR_Y + pb.minHalf;
      if (t.y < minY - 0.05) {
        pb.body.setTranslation({ x: t.x, y: minY, z: t.z }, true);
        const lv = pb.body.linvel();
        if (lv.y < 0) pb.body.setLinvel({ x: lv.x, y: 0, z: lv.z }, true);
      }
    }
  }

  // Push the player capsule out of any PROP collider it genuinely overlaps. Props only
  // (_propHandles predicate) — world-geometry recovery stays with the static snap
  // failsafe. Mechanism: project the capsule's three axis points (bottom, centre, top)
  // onto the nearest PROP surface (world.projectPoint, solid=false, so an inside point
  // still gets its nearest surface point + isInside=true — verified against the pinned
  // rapier3d-compat@0.14 API; contact MANIFOLDS were tried first but a kinematic
  // capsule's pairs carry zero contact points, so they can't drive this). An axis point
  // closer to a prop surface than (radius − _propSkin) — or inside the prop outright —
  // yields a push; the deepest sample wins and the push is capped at _propMaxPush per
  // substep, so a recovery is a firm shove, never a visible teleport. Overlap shallower
  // than _propSkin is ordinary resting/pressing contact and is deliberately left alone
  // (the capsule rests against props; it must not vibrate off them). Guarded: absent
  // API → no-op, and the whole thing costs 3 point queries per player per substep.
  _depenetrateFromProps(p) {
    const world = this.world;
    if (!this._propHandles || this._propHandles.size === 0 || typeof world.projectPoint !== 'function') return;
    const propsOnly = (col) => this._propHandles.has(col.handle);
    const t = p.body.translation();
    const half = p.half != null ? p.half : this._pHalf;
    const radius = p.radius != null ? p.radius : this._pRadius;
    const clear = radius - this._propSkin; // an axis point must keep this much distance
    // Two kinds of candidate push, chosen differently:
    //  - INSIDE sample (axis point swallowed by a prop): exit is THROUGH the nearest
    //    surface. Among inside samples take the CHEAPEST exit (smallest travel) — the
    //    deepest one can point at a face that is pressed against the floor (a table's
    //    underside) and would drive the capsule downward instead of surfacing it.
    //  - NEAR sample (surface closer than the capsule radius): push straight away from
    //    the surface; take the deepest violation.
    let inX = 0, inY = 0, inZ = 0, inNeed = Infinity;
    let outX = 0, outY = 0, outZ = 0, outNeed = 0;
    for (const oy of [-half, 0, half]) {
      const pt = { x: t.x, y: t.y + oy, z: t.z };
      let proj;
      try {
        proj = world.projectPoint(pt, false, undefined, undefined, undefined, undefined, propsOnly);
      } catch {
        return; // API mismatch — degrade to no push-out rather than throw mid-substep
      }
      if (!proj || !proj.point) continue;
      const dx = proj.point.x - pt.x, dy = proj.point.y - pt.y, dz = proj.point.z - pt.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) continue;
      if (proj.isInside) {
        const need = d + clear;
        if (need < inNeed) {
          inNeed = need;
          inX = (dx / d) * need; inY = (dy / d) * need; inZ = (dz / d) * need; // toward + past the surface
        }
      } else if (d < clear) {
        const need = clear - d;
        if (need > outNeed) {
          outNeed = need;
          outX = (-dx / d) * need; outY = (-dy / d) * need; outZ = (-dz / d) * need; // away from the surface
        }
      }
    }
    let px, py, pz;
    if (inNeed < Infinity) { px = inX; py = inY; pz = inZ; }
    else if (outNeed > 0) { px = outX; py = outY; pz = outZ; }
    else return;
    const mag = Math.hypot(px, py, pz);
    if (mag < 1e-9) return;
    const scale = Math.min(1, this._propMaxPush / mag);
    const nx = t.x + px * scale, nz = t.z + pz * scale;
    // Never push the capsule below the floor plane (a prop face resting on the ground
    // must not become an exit route into the slab — same clamp the mover applies).
    const ny = Math.max(t.y + py * scale, this._pCenterY + FLOOR_Y);
    p.body.setTranslation({ x: nx, y: ny, z: nz }, false);
    p.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    // The pushed-out position is MORE collision-free than the pre-push one — make it
    // the new anchor so a following static snap can't yank the player back into the prop.
    p.safePos = { x: nx, y: ny, z: nz };
  }

  // Player ids the depenetration escape hatch flagged as unrecoverably wedged since the
  // last call. The HOST referee consumes this in its failsafe sweep and respawns them;
  // returns [] when there is nothing to do (and always on guest predictors, where the
  // authoritative respawn arrives via the normal snapshot instead).
  consumeStuckPlayers() {
    if (!this._stuckPlayerIds || this._stuckPlayerIds.size === 0) return [];
    const out = [...this._stuckPlayerIds];
    this._stuckPlayerIds.clear();
    return out;
  }

  // PREDICTION-WORLD PROP SYNC (pass #5). A guest predictor (and the host's own
  // prediction world) builds every prop as a FIXED collider at its match-start pose —
  // and nothing ever moved them, so after a minute of shoving, local movement collided
  // with ghost colliders where props USED to be and sailed through where they actually
  // are (the "walk into props no problem" feel; authority only corrected at 15 Hz).
  // Called from main.js with each snapshot's awake-prop transforms: reposition the
  // fixed colliders to the live poses so local prediction and authority agree on where
  // the props are. No-op on the host's authoritative world (its props are real dynamic
  // bodies and never enter _fixedPropColliders... except past-cap statics, which the
  // host never syncs because the referee doesn't call this).
  syncPropTransforms(list) {
    if (!this._fixedPropColliders || this._fixedPropColliders.size === 0 || !list) return;
    for (const q of list) {
      const col = this._fixedPropColliders.get(q.id);
      if (!col) continue;
      col.setTranslation({ x: q.x, y: q.y, z: q.z });
      if (Number.isFinite(q.qx)) col.setRotation({ x: q.qx, y: q.qy, z: q.qz, w: q.qw });
    }
  }

  // Transforms of props that are currently AWAKE (moving). Sleeping props are
  // skipped — they haven't moved, so there's nothing to sync (bandwidth win).
  // Host only (guests have no dynamic prop bodies). Returns [] otherwise.
  awakeProps() {
    const out = [];
    for (const { id, body } of this.propBodies) {
      if (body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      out.push({ id, x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w });
    }
    return out;
  }

  // CURRENT transform of EVERY dynamic prop (awake OR asleep). Used to catch a
  // mid-round joiner up to the world as it actually is — a knocked-over, now-resting
  // chair must arrive at its resting place, not its spawn (fix #8). Host only.
  allProps() {
    const out = [];
    for (const { id, body } of this.propBodies) {
      const t = body.translation();
      const r = body.rotation();
      out.push({ id, x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w });
    }
    return out;
  }

  // FALL-THROUGH FAILSAFE for props (fix #4). Any dynamic prop whose body centre has
  // dropped below `minY` (it escaped the world through a seam) is teleported back to
  // its spawn transform with all velocity zeroed, so a lost chair reappears where it
  // belongs instead of falling forever. Host only (guests have no dynamic bodies).
  // Returns the number respawned (for logging). Cheap: one translation read per prop.
  respawnEscaped(minY) {
    let n = 0;
    for (const pb of this.propBodies) {
      const t = pb.body.translation();
      if (t.y >= minY) continue;
      const s = pb.spawn;
      pb.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
      pb.body.setRotation(s.q, true);
      pb.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pb.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      n++;
    }
    return n;
  }

  destroy() {
    try {
      this.world.free();
    } catch {
      /* already freed */
    }
    this.players.clear();
    this.propBodies = [];
  }
}

// Identity rotation, reused by the depenetration intersection test (no per-call alloc).
const IDENT_QUAT = { x: 0, y: 0, z: 0, w: 1 };

// Quaternion for a yaw (rotation about +Y).
function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

// X or Z half-extent of a catalog entry's footprint, measured bounds first, else the
// primitive w/d. Used to size a thickened floor collider (fix #5) without reaching
// into shapeFor's opaque ColliderDesc.
function halfExtentXZ(c, axis) {
  const m = c.measured;
  if (m && m.w > 0 && m.d > 0) return (axis === 'w' ? m.w : m.d) / 2;
  return ((axis === 'w' ? c.w : c.d) || 1) / 2;
}
