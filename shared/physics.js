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

// Half-extents / radii for a catalog entry's primitive shape. Physics colliders
// are cuboid/cylinder/cone/ball approximations of the primitive footprint (the
// same box the renderer draws before a GLB swaps in) — robust and synchronous.
// Convex hulls baked from the GLB meshes were considered but rejected for a blind
// one-pass build: the GLBs load async and can fail, so coupling collision to them
// would make the world non-deterministic in shape. Documented in notes/physics.md.
function shapeFor(RAPIER, c) {
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
    this.world.timestep = 1 / 60;

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

    // Static fixtures (walls, counters, appliances, tables) — immovable colliders
    // from the LOCAL map data. Cheap: fixed colliders don't simulate.
    for (const f of map.fixtures || []) {
      const c = catalog[f.type];
      if (!c) continue;
      const { desc, halfH } = shapeFor(R, c);
      desc.setTranslation(f.x, halfH + (f.y || 0), f.z);
      if (f.rot) desc.setRotation(yawQuat(f.rot));
      this.world.createCollider(desc);
    }
  }

  _buildProps(propInstances, catalog) {
    const R = this.R;
    for (const p of propInstances || []) {
      const c = catalog[p.type];
      if (!c) continue;
      const { desc, halfH } = shapeFor(R, c);
      const y = halfH + (p.y || 0);
      if (this.dynamicProps) {
        // Host: a real rigid body that can be knocked around and settles to sleep.
        const bodyDesc = R.RigidBodyDesc.dynamic()
          .setTranslation(p.x, y, p.z)
          .setLinearDamping(0.4)
          .setAngularDamping(0.6);
        if (p.rot) bodyDesc.setRotation(yawQuat(p.rot));
        const body = this.world.createRigidBody(bodyDesc);
        this.world.createCollider(desc.setFriction(0.8).setRestitution(0.0).setDensity(0.6), body);
        this.propBodies.push({ id: p.id, body });
      } else {
        // Guest predictor: props are fixed obstacles (host owns their motion). The
        // local character still collides against their spawn positions; reconciliation
        // corrects the rare case where a prop has actually been shoved elsewhere.
        desc.setTranslation(p.x, y, p.z);
        if (p.rot) desc.setRotation(yawQuat(p.rot));
        this.world.createCollider(desc);
      }
    }
  }

  _buildController() {
    const c = this.world.createCharacterController(0.02);
    c.enableAutostep(0.5, 0.2, true); // step up onto low ledges
    c.enableSnapToGround(0.4); // stick to the floor going downhill / down steps
    c.setApplyImpulsesToDynamicBodies(true); // players shove dynamic props (the tell)
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
  // Advance the sim by dt (seconds), in fixed 1/60 substeps (capped so a slow
  // phone / long stall degrades gracefully instead of spiralling). Each substep
  // moves every player via the character controller, then steps the dynamics.
  step(dt) {
    const h = 1 / 60;
    let remaining = Math.min(dt, 0.1); // cap accumulated time (mobile safety)
    let guard = 0;
    while (remaining > 1e-4 && guard < 4) {
      const sub = remaining > h ? h : remaining;
      this._substep(sub);
      remaining -= sub;
      guard++;
    }
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

      const desired = { x: vx * moveSpeed * dt, y: p.vy * dt, z: vz * moveSpeed * dt };
      this._controller.computeColliderMovement(p.collider, desired);
      const mv = this._controller.computedMovement();
      p.grounded = this._controller.computedGrounded();
      if (p.grounded && p.vy < 0) p.vy = 0;

      const tr = p.body.translation();
      p.body.setNextKinematicTranslation({ x: tr.x + mv.x, y: tr.y + mv.y, z: tr.z + mv.z });
    }

    this.world.timestep = dt;
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
