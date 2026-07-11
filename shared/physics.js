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
    this.dynamicProps = !!opts.dynamicProps;
    this.map = map;

    const g = this.rules.gravity != null ? this.rules.gravity : 22;
    this.world = new RAPIER.World({ x: 0, y: -g, z: 0 });
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

    this._buildStatic(map, catalog);
    this._buildProps(propInstances, catalog);
    this._buildController();
  }

  // ---- construction --------------------------------------------------------
  _buildStatic(map, catalog) {
    const R = this.R;
    const half = map.size / 2;

    // Ground: a thin fixed slab whose top face sits at y=0.
    this.world.createCollider(
      R.ColliderDesc.cuboid(half + 2, 0.5, half + 2).setTranslation(0, -0.5, 0).setFriction(0.9)
    );

    // Boundary walls (match the renderer's enclosing box: 3 tall, centred at 1.5).
    const t = 0.5; // wall thickness
    const wallY = 1.5;
    const walls = [
      [0, wallY, -half, half + t, 1.5, t],
      [0, wallY, half, half + t, 1.5, t],
      [-half, wallY, 0, t, 1.5, half + t],
      [half, wallY, 0, t, 1.5, half + t],
    ];
    for (const [x, y, z, hx, hy, hz] of walls) {
      this.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));
    }

    // Static fixtures — ONLY the genuinely bolted-in pieces (`static`). Knockable
    // fixtures are promoted into the dynamic prop stream by the referee (fix #2), so
    // they're not built here. `decor` pieces (tiny garnish) are visual-only: NO
    // collider — otherwise, once a dynamic table is knocked away, their fixed
    // colliders would linger as invisible floating obstacles. Cheap: fixed colliders
    // don't simulate.
    for (const f of map.fixtures || []) {
      const c = catalog[f.type];
      if (!c || !c.static) continue;
      const { desc, halfH } = shapeFor(R, c);
      desc.setTranslation(f.x, halfH + (f.y || 0), f.z);
      if (f.rot) desc.setRotation(yawQuat(f.rot));
      this.world.createCollider(desc);
    }
  }

  _buildProps(propInstances, catalog) {
    const R = this.R;
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
        const bodyDesc = R.RigidBodyDesc.dynamic()
          .setTranslation(p.x, moved ? cy : cy + SPAWN_EPS, p.z)
          .setLinearDamping(0.5)
          .setAngularDamping(0.7);
        if (moved) bodyDesc.setRotation({ x: p.qx, y: p.qy, z: p.qz, w: p.qw });
        else if (p.rot) bodyDesc.setRotation(yawQuat(p.rot));
        const body = this.world.createRigidBody(bodyDesc);
        this.world.createCollider(desc.setFriction(0.8).setRestitution(0.0).setDensity(dens), body);
        this.propBodies.push({ id: p.id, body });
        dynCount++;
      } else {
        // Fixed obstacle. Three cases land here:
        //  - Guest predictor: host owns all prop motion, so the local character just
        //    collides against these positions; reconciliation corrects the rare case
        //    where a prop has actually been shoved elsewhere.
        //  - Host past the dynamic cap: same solid collider, simply not simulated
        //    (phone-safety — still fully collidable, just not shovable).
        desc.setTranslation(p.x, cy, p.z);
        if (moved) desc.setRotation({ x: p.qx, y: p.qy, z: p.qz, w: p.qw });
        else if (p.rot) desc.setRotation(yawQuat(p.rot));
        this.world.createCollider(desc);
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
    // Slightly smaller collider than the visual capsule so it slips through gaps a
    // touch more forgivingly and never wedges on its own body offset.
    const collider = this.world.createCollider(R.ColliderDesc.capsule(this._pHalf, this._pRadius), body);
    this.players.set(id, { body, collider, vy: 0, grounded: false, input: { mx: 0, mz: 0, yaw: 0, jump: false } });
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
    p.body.setNextKinematicTranslation({ x: pos.x, y: this._pCenterY + (pos.y || 0), z: pos.z });
    p.body.setTranslation({ x: pos.x, y: this._pCenterY + (pos.y || 0), z: pos.z }, false);
    p.vy = 0;
  }

  getPlayer(id) {
    const p = this.players.get(id);
    if (!p) return null;
    const t = p.body.translation();
    return { x: t.x, y: t.y - this._pCenterY, z: t.z, grounded: p.grounded };
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

    for (const p of this.players.values()) {
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

      // Vertical: integrate gravity; jump only when grounded.
      if (p.grounded) {
        p.vy = inp.jump ? jumpSpeed : 0;
      } else {
        p.vy -= g * dt;
      }

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

      // Resolve how far the capsule CAN move BEFORE moving it: computeCollider
      // movement returns a corrected delta that never enters geometry, and we apply
      // exactly that. The capsule therefore never interpenetrates and is never
      // ejected by penetration recovery.
      const desired = { x: vx * moveSpeed * dt, y: p.vy * dt, z: vz * moveSpeed * dt };
      this._controller.computeColliderMovement(p.collider, desired);
      const mv = this._controller.computedMovement();
      p.grounded = this._controller.computedGrounded();
      if (p.grounded && p.vy < 0) p.vy = 0;

      const tr = p.body.translation();
      p.body.setNextKinematicTranslation({ x: tr.x + mv.x, y: tr.y + mv.y, z: tr.z + mv.z });
    }

    // Fixed substep — timestep is _fixedDt (set in the constructor); dt is always
    // _fixedDt here, so the dynamics solver runs at a constant rate.
    this.world.step();
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

// Quaternion for a yaw (rotation about +Y).
function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
