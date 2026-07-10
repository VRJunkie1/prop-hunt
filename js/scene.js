// All Three.js rendering lives here. The scene is a pure view of server state:
// it builds the map + props from config, and each frame reconciles player
// meshes against the latest authoritative snapshot. No game rules here.
import * as THREE from 'three';
// The SAME static/dynamic classifier the physics + referee use, so a fixture that
// became a knockable rigid body isn't ALSO drawn as immovable scenery here (it would
// double-render and leave a ghost collider). Importing the constant does not load
// Rapier — physics.js only fetches the WASM inside loadRapier().
import { isStaticEntry } from '/shared/physics.js';

// Build a mesh for a prop type from the catalog. Returns { mesh, baseY } where
// baseY rests the shape on the ground (y=0). Reused for static props and for
// disguised players.
export function makePropMesh(type, catalog) {
  const c = catalog[type];
  if (!c) return null;
  let geo;
  let baseY;
  const color = new THREE.Color(c.color);
  switch (c.shape) {
    case 'box':
      geo = new THREE.BoxGeometry(c.w, c.h, c.d);
      baseY = c.h / 2;
      break;
    case 'cylinder':
      geo = new THREE.CylinderGeometry(c.r, c.r, c.h, 16);
      baseY = c.h / 2;
      break;
    case 'cone':
      geo = new THREE.ConeGeometry(c.r, c.h, 16);
      baseY = c.h / 2;
      break;
    case 'sphere':
      geo = new THREE.SphereGeometry(c.r, 16, 12);
      baseY = c.r;
      break;
    default:
      geo = new THREE.BoxGeometry(1, 1, 1);
      baseY = 0.5;
  }
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  mesh.castShadow = true;
  return { mesh, baseY };
}

// The largest world-space dimension a loaded GLB should be scaled to fit. Derived
// from the catalog entry's primitive footprint so a real mesh lands at roughly the
// intended size regardless of the GLB's native units — or from an explicit
// `modelSize` override for pieces whose primitive box doesn't match (floors, walls,
// pillars, door). See Scene3D._instantiateModel.
function targetSizeForEntry(c) {
  if (typeof c.modelSize === 'number') return c.modelSize;
  switch (c.shape) {
    case 'box':
      return Math.max(c.w, c.h, c.d);
    case 'cylinder':
    case 'cone':
      return Math.max(2 * c.r, c.h);
    case 'sphere':
      return 2 * c.r;
    default:
      return 1.5;
  }
}

export class Scene3D {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
    this.camera.position.set(0, 1.6, 0);

    this.selfId = null;
    this.catalog = null;
    this.players = new Map(); // id -> { mesh, target:{x,z,yaw}, kind }

    // ---- lazy GLB meshes (real Restaurant Bits models) ----------------------
    // The map first renders with primitive placeholders, then the real GLBs the
    // active map references are loaded and swapped in over them. Everything here is
    // kicked off from buildWorld (match start) — never at page boot — so the
    // GLTFLoader CDN import and the GLB downloads stay off the headless load check.
    this._gltfLoader = null; // created lazily on the first match start
    this._modelCache = new Map(); // '/assets/…​.glb' -> loaded template, or 'failed'
    this._modelSlots = []; // this match's primitives still awaiting their GLB
    this._buildToken = 0; // bumped each buildWorld so stale async loads no-op

    // ---- third-person follow camera -----------------------------------------
    // The local player now sees their OWN model from a camera orbiting behind and
    // slightly above them (default). yaw/pitch (from mouse-look / touch drag) orbit
    // the camera instead of turning a first-person head. A collision ray pulls the
    // camera in when a wall/prop sits between it and the player. `thirdPerson=false`
    // flips back to the classic eye view (toggle: V on desktop).
    this.thirdPerson = true;
    this.selfMesh = null; // the local player's own avatar (only in third-person)
    this.selfKind = null; // appearance signature, so we rebuild on disguise/role change
    this.selfAlive = true;
    this.colliders = []; // walls + static props the camera ray tests against
    this._raycaster = new THREE.Raycaster();
    // Tunables.
    this._camDesiredDist = 5.0; // how far behind the player the camera wants to sit
    this._camHeadY = 1.5; // look-at height on the player (upper body / head)
    this._camHeightBias = 0.4; // extra lift so we look slightly down over them
    this._camMinDist = 1.2; // never pull closer than this (avoids clipping into the model)
    this._camDist = this._camDesiredDist; // smoothed current distance (eased for pull-in/out)
    // Reused scratch vectors (no per-frame allocation in the render loop).
    this._vTarget = new THREE.Vector3();
    this._vDesired = new THREE.Vector3();
    this._vDir = new THREE.Vector3();
    this._vAim = new THREE.Vector3();
    this._qScratch = new THREE.Quaternion(); // reused for awake-prop orientation
    this.propMeshes = new Map(); // id -> dynamic-prop render record (rebuilt per match)

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Orientation changes on phones sometimes report the new size a beat late;
    // a deferred re-measure avoids a one-frame letterbox after a rotate.
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));

    // Mobile GPUs drop the WebGL context under memory pressure / backgrounding.
    // Preventing the default lets the browser restore it instead of white-screening
    // permanently; Three.js re-uploads its resources on the 'restored' event. The
    // world itself is rebuilt on the next match start (buildWorld), which is the
    // only place that holds the map data.
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Rebuild the world for a new match.
  buildWorld(map, propInstances, catalog) {
    this.catalog = catalog;
    // A new match: invalidate any in-flight GLB loads from a previous build and
    // start a fresh slot list (the primitives queued for a real-mesh swap).
    this._buildToken++;
    this._modelSlots = [];
    // Clear previous scene contents.
    this.scene.clear();
    this.players.clear();
    // scene.clear() also drops the self avatar; reset its trackers and the camera's
    // collision set / smoothed distance so a fresh match starts fully zoomed out.
    this.selfMesh = null;
    this.selfKind = null;
    this.colliders = [];
    this._camDist = this._camDesiredDist;

    this.scene.background = new THREE.Color(map.sky || '#87ceeb');
    this.scene.fog = new THREE.Fog(new THREE.Color(map.sky || '#87ceeb'), 40, 120);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    // Ground.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.size, map.size),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(map.ground) })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Boundary walls so the arena reads as enclosed.
    const half = map.size / 2;
    const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x2a2140 });
    const wallGeo = new THREE.BoxGeometry(map.size, 3, 0.5);
    const walls = [
      [0, -half, 0],
      [0, half, 0],
      [-half, 0, Math.PI / 2],
      [half, 0, Math.PI / 2],
    ];
    for (const [x, z, ry] of walls) {
      const wall = new THREE.Mesh(wallGeo, wallMaterial);
      wall.position.set(x, 1.5, z);
      wall.rotation.y = ry || 0;
      this.scene.add(wall);
      this.colliders.push(wall); // camera pulls in against the arena walls
    }

    // Static world fixtures (immovable building pieces: kitchen appliances,
    // counters, sinks, interior walls, large/anchored tables). These come from
    // the LOCAL map data (`map.fixtures`), NOT from the referee's prop list, so
    // the referee never treats them as disguisable — they are pure scenery +
    // world collision. Every client has maps.json, so they render identically on
    // host and guests with no protocol change. Older maps have no `fixtures` key
    // and are unaffected. See memory/notes/restaurant-map.md.
    for (const f of map.fixtures || []) {
      const c = catalog[f.type];
      if (!c || !isStaticEntry(c)) continue; // knockable fixtures render via propInstances (below)
      const built = makePropMesh(f.type, catalog);
      if (!built) continue;
      built.mesh.position.set(f.x, built.baseY + (f.y || 0), f.z);
      built.mesh.rotation.y = f.rot || 0;
      this.scene.add(built.mesh);
      this.colliders.push(built.mesh); // camera pulls in against fixtures too
      this._queueModel(f, built.mesh, catalog); // swap in the real GLB if any
    }

    // Dynamic props (the disguise pool — chairs, stools, crates, dishes, food).
    // Built from the referee's authoritative prop instances; these are the objects
    // props can morph into AND real dynamic rigid bodies the host can shove around.
    //
    // Each prop lives in a CONTAINER Group whose origin is the body CENTRE (== the
    // physics body's translation), so an awake prop's snapshot transform {x,y,z +
    // quaternion} maps straight onto the container. The primitive sits centred at the
    // container origin; a swapped-in GLB is offset down by baseY so its base rests on
    // the floor — both then rotate about the centre exactly as the rigid body does.
    this.propMeshes = new Map(); // id -> { container, primitive, baseY, target, awake }
    for (const p of propInstances) {
      const built = makePropMesh(p.type, catalog);
      if (!built) continue;
      const container = new THREE.Group();
      // A mid-round joiner's props carry a live transform (centre + quaternion) so a
      // shoved chair arrives where it actually rests; a fresh match's props carry
      // spawn semantics (floor x/z, surface y-offset, yaw). `moved` picks between them.
      if (Number.isFinite(p.qx)) {
        container.position.set(p.x, p.y, p.z);
        container.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      } else {
        container.position.set(p.x, built.baseY + (p.y || 0), p.z);
        container.rotation.y = p.rot || 0;
      }
      built.mesh.position.set(0, 0, 0); // centred on the container origin
      container.add(built.mesh);
      this.scene.add(container);
      this.colliders.push(built.mesh); // camera pulls in against props too
      this.propMeshes.set(p.id, {
        container,
        primitive: built.mesh,
        baseY: built.baseY,
        target: null, // set once the prop first appears AWAKE in a snapshot
        awake: false,
      });
      this._queueModel(p, built.mesh, catalog, container, built.baseY); // swap in the real GLB if any
    }

    // Kick off the real-mesh load for everything queued above. Fire-and-forget:
    // primitives are already on screen, so the map is playable instantly and each
    // GLB pops in as it arrives (or never, leaving its primitive — the fallback).
    this._loadModels().catch(() => {});
  }

  // Record a primitive that has a real GLB to swap in later. `entry` is the map's
  // fixture/prop record (carries type/x/z and optional y/rot); `holder` is the
  // primitive mesh already added to the scene. Called for both fixtures and props.
  _queueModel(entry, holder, catalog, container = null, baseY = 0) {
    const c = catalog[entry.type];
    if (!c || !c.model) return;
    this._modelSlots.push({
      holder,
      // For a dynamic prop the GLB is parented to the prop's container (which the
      // snapshot moves) and offset so its base rests on the floor; for a fixture it
      // is placed once in world space. container == null => fixture path.
      container,
      baseY,
      path: '/assets/' + c.model,
      target: targetSizeForEntry(c),
      // Optional non-uniform target dims {w,h,d}. When present the GLB is scaled per
      // axis to these exact world sizes instead of uniformly by its largest
      // dimension — the reliable fix for pieces whose native proportions don't match
      // the intended footprint (e.g. a floor tile that must stay thin however thick
      // its GLB is). Uniform max-dim scaling inflated the kitchen floor's thickness.
      // MEASURED bounds win when present so the mesh matches the physics collider
      // (both baked from asset-dims.json); else the ad-hoc modelDims override.
      dims: c.measured || c.modelDims || null,
      x: entry.x,
      y: entry.y || 0,
      z: entry.z,
      rot: entry.rot || 0,
    });
  }

  setSelf(id) {
    this.selfId = id;
  }

  // Create a mesh matching how a player should currently look.
  meshForPlayer(p) {
    if (p.disguise && this.catalog[p.disguise]) {
      const c = this.catalog[p.disguise];
      // If the disguise's real GLB has already been loaded for this map, wear the
      // real mesh; otherwise (not yet loaded, or it failed) fall back to the
      // primitive so a disguise is always drawn.
      if (c.model) {
        const tmpl = this._modelCache.get('/assets/' + c.model);
        if (tmpl && tmpl !== 'failed') {
          const inst = this._instantiateModel(tmpl, targetSizeForEntry(c), c.measured || c.modelDims || null);
          inst.userData.baseY = 0;
          return inst;
        }
      }
      const built = makePropMesh(p.disguise, this.catalog);
      built.mesh.userData.baseY = built.baseY;
      return built.mesh;
    }
    // Capsule avatar: red for hunters, muted for undisguised props.
    const geo = new THREE.CapsuleGeometry(0.4, 1.0, 4, 12);
    const color = p.hunter ? 0xff5a5a : 0x9a86c4;
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    mesh.userData.baseY = 0.9;
    return mesh;
  }

  // Reconcile meshes against a snapshot's player list.
  syncPlayers(players) {
    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      if (p.id === this.selfId) {
        // In third-person the local player sees their OWN model (built via the same
        // disguise/role path everyone else is drawn with, so it matches what the
        // referee and other clients believe this player is). In first-person there
        // is no self avatar (the camera is the eyes).
        this._syncSelf(p);
        continue;
      }

      let entry = this.players.get(p.id);
      const kind = p.disguise ? `d:${p.disguise}` : p.hunter ? 'hunter' : 'prop';
      if (!entry || entry.kind !== kind) {
        // New player, or appearance changed (disguised / role) -> rebuild mesh.
        if (entry) this.scene.remove(entry.mesh);
        const mesh = this.meshForPlayer(p);
        mesh.position.set(p.x, mesh.userData.baseY + (p.y || 0), p.z);
        this.scene.add(mesh);
        entry = { mesh, kind, target: { x: p.x, y: p.y || 0, z: p.z, yaw: p.yaw } };
        this.players.set(p.id, entry);
      }
      entry.target.x = p.x;
      entry.target.y = p.y || 0;
      entry.target.z = p.z;
      entry.target.yaw = p.yaw;
      entry.mesh.visible = p.alive;
    }
    // Remove players no longer present.
    for (const [id, entry] of this.players) {
      if (!seen.has(id)) {
        this.scene.remove(entry.mesh);
        this.players.delete(id);
      }
    }
  }

  // Apply the awake dynamic-prop transforms from a snapshot. Only props the host
  // reported as awake (moving) are here; sleeping props keep their built pose, so
  // most props never touch this. A prop first seen awake starts interpolating from
  // wherever it was built. This is the visible half of the physics TELL — real props
  // get shoved and tumble; a disguised player (kinematic) never does.
  syncProps(awake) {
    if (!this.propMeshes || !awake) return;
    for (const q of awake) {
      const rec = this.propMeshes.get(q.id);
      if (!rec) continue;
      if (!rec.target) rec.target = { x: q.x, y: q.y, z: q.z, qx: q.qx, qy: q.qy, qz: q.qz, qw: q.qw };
      else {
        rec.target.x = q.x;
        rec.target.y = q.y;
        rec.target.z = q.z;
        rec.target.qx = q.qx;
        rec.target.qy = q.qy;
        rec.target.qz = q.qz;
        rec.target.qw = q.qw;
      }
      rec.awake = true;
    }
  }

  // Smoothly move other players + awake props toward their latest snapshot pose.
  interpolate(alpha) {
    for (const entry of this.players.values()) {
      const m = entry.mesh;
      m.position.x += (entry.target.x - m.position.x) * alpha;
      m.position.z += (entry.target.z - m.position.z) * alpha;
      const yTarget = (m.userData.baseY || 0) + (entry.target.y || 0);
      m.position.y += (yTarget - m.position.y) * alpha;
      m.rotation.y = entry.target.yaw;
    }
    if (this.propMeshes) {
      for (const rec of this.propMeshes.values()) {
        if (!rec.awake || !rec.target) continue;
        const c = rec.container;
        c.position.x += (rec.target.x - c.position.x) * alpha;
        c.position.y += (rec.target.y - c.position.y) * alpha;
        c.position.z += (rec.target.z - c.position.z) * alpha;
        this._qScratch.set(rec.target.qx, rec.target.qy, rec.target.qz, rec.target.qw);
        c.quaternion.slerp(this._qScratch, alpha);
      }
    }
  }

  // Build/rebuild (or tear down) the local player's own avatar to match their
  // current appearance. Only present in third-person; the mesh is positioned each
  // frame from the PREDICTED local position in setCamera (not the lagging snapshot).
  _syncSelf(p) {
    this.selfAlive = p.alive;
    if (!this.thirdPerson) {
      this._removeSelfMesh();
      return;
    }
    const kind = p.disguise ? `d:${p.disguise}` : p.hunter ? 'hunter' : 'prop';
    if (!this.selfMesh || this.selfKind !== kind) {
      this._removeSelfMesh();
      this.selfMesh = this.meshForPlayer(p);
      this.selfKind = kind;
      this.selfMesh.position.set(p.x, this.selfMesh.userData.baseY, p.z);
      this.scene.add(this.selfMesh);
    }
  }

  _removeSelfMesh() {
    if (this.selfMesh) this.scene.remove(this.selfMesh);
    this.selfMesh = null;
    this.selfKind = null;
  }

  // Flip between third-person (default) and first-person. Removing the self avatar
  // immediately keeps first-person from briefly showing the player's own model; it
  // is rebuilt on the next snapshot when switching back.
  setThirdPerson(on) {
    this.thirdPerson = !!on;
    if (!this.thirdPerson) this._removeSelfMesh();
  }

  // Place the camera. Third-person = orbit behind/above the player (collision-aware,
  // smoothed); first-person = classic eye view. yaw/pitch come from the same
  // mouse-look / touch-drag inputs either way — only their interpretation changes.
  // selfYaw (optional) is the facing of the local player's OWN model. It differs
  // from `yaw` (the look/camera yaw) only while disguised with the orientation lock
  // engaged — then the prop stays fixed even as the camera orbits. Defaults to yaw.
  setCamera(pos, yaw, pitch, selfYaw = yaw) {
    const py = pos.y || 0; // jump height
    if (!this.thirdPerson) {
      this.camera.position.set(pos.x, 1.6 + py, pos.z);
      this.camera.rotation.set(0, 0, 0, 'YXZ');
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = yaw;
      this.camera.rotation.x = pitch;
      return;
    }

    // Camera-forward (same convention as first-person / the referee's aim vector).
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;

    // Look-at point on the player; keep the own avatar glued to the predicted
    // position/yaw so it tracks the camera without snapshot lag.
    const target = this._vTarget.set(pos.x, this._camHeadY + py, pos.z);
    if (this.selfMesh) {
      this.selfMesh.position.set(pos.x, this.selfMesh.userData.baseY + py, pos.z);
      // Own model faces selfYaw (== look yaw normally; the frozen disguise facing
      // while the orientation lock is on) so a locked disguise doesn't spin as you
      // turn the camera — matching what other players see of you.
      this.selfMesh.rotation.y = selfYaw;
      this.selfMesh.visible = this.selfAlive;
    }

    // Desired camera spot: behind (−forward) and lifted a touch. Floor the height
    // so looking far up (which orbits the camera downward) can't sink it below the
    // ground plane (the ground isn't a collider, so nothing else would stop it).
    const dist = this._camDesiredDist;
    const desired = this._vDesired.set(
      target.x - fx * dist,
      Math.max(0.4, target.y - fy * dist + this._camHeightBias),
      target.z - fz * dist
    );

    // Collision pull-in: cast from the player toward the desired spot; if a wall or
    // prop is in the way, clamp the distance so the camera never clips through it.
    const dir = this._vDir.copy(desired).sub(target);
    const desiredLen = dir.length() || 1e-3;
    dir.multiplyScalar(1 / desiredLen);
    let allowed = desiredLen;
    if (this.colliders.length) {
      this._raycaster.set(target, dir);
      this._raycaster.far = desiredLen;
      const hits = this._raycaster.intersectObjects(this.colliders, false);
      if (hits.length) allowed = Math.max(this._camMinDist, hits[0].distance - 0.3);
    }

    // Smooth: snap IN immediately (so we never clip), ease back OUT when clear.
    if (allowed < this._camDist) this._camDist = allowed;
    else this._camDist += (allowed - this._camDist) * 0.12;
    this._camDist = Math.min(this._camDist, desiredLen);

    this.camera.position.copy(target).addScaledVector(dir, this._camDist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
  }

  // Screen-space point (pixels) where the aim indicator should sit, so the reticle
  // marks where the referee's tag cone actually points (its yaw-forward vector) —
  // NOT screen center, since the third-person eye is off the player. Returns null
  // in first-person (reticle stays centered) or when the point is behind the camera.
  aimScreenPoint(pos, yaw) {
    if (!this.thirdPerson) return null;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const D = 3.0; // a few metres ahead of the player, at ~chest height
    const p = this._vAim.set(pos.x + fx * D, this._camHeadY - 0.4, pos.z + fz * D);
    p.project(this.camera);
    if (p.z > 1) return null; // behind the camera
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  // ---- lazy GLB meshes ------------------------------------------------------
  // Load the real Restaurant Bits GLBs referenced by THIS map and swap each in over
  // its primitive placeholder. Only the models the active map references are loaded
  // (from this._modelSlots, built during buildWorld). The GLTFLoader itself is a
  // dynamic CDN import done here on the first match start — never at page boot — so
  // the headless load check makes zero external requests (same rule as three.js /
  // PeerJS). Any GLB that is missing or errors just leaves its primitive in place.
  async _loadModels() {
    const slots = this._modelSlots;
    if (!slots.length) return;
    const token = this._buildToken;
    if (!this._gltfLoader) {
      try {
        const mod = await import('three/addons/loaders/GLTFLoader.js');
        this._gltfLoader = new mod.GLTFLoader();
      } catch (e) {
        // CDN unreachable / import blocked: every item keeps its primitive fallback.
        console.warn('[scene] GLTFLoader unavailable — keeping primitive shapes', e);
        return;
      }
    }
    if (token !== this._buildToken) return; // a newer match started while importing
    // Group by GLB path so each file downloads once, then applies to all its uses.
    const byPath = new Map();
    for (const s of slots) {
      if (!byPath.has(s.path)) byPath.set(s.path, []);
      byPath.get(s.path).push(s);
    }
    for (const [path, uses] of byPath) this._loadOne(path, uses, token);
  }

  _loadOne(path, uses, token) {
    const cached = this._modelCache.get(path);
    if (cached === 'failed') return; // known-bad file — keep the primitives
    if (cached) {
      for (const s of uses) this._applyModel(cached, s, token);
      return;
    }
    this._gltfLoader.load(
      path,
      (gltf) => {
        this._modelCache.set(path, gltf.scene);
        for (const s of uses) this._applyModel(gltf.scene, s, token);
      },
      undefined,
      (err) => {
        // Missing or corrupt GLB: record it so we don't retry, and leave every
        // referencing primitive visible. One bad file never blanks the map.
        console.warn('[scene] mesh failed to load, using primitive fallback:', path, err);
        this._modelCache.set(path, 'failed');
      }
    );
  }

  // Place a loaded model into a slot and hide (but keep) its primitive.
  _applyModel(template, slot, token) {
    if (token !== this._buildToken) return; // match ended / restarted; drop it
    const inst = this._instantiateModel(template, slot.target, slot.dims);
    if (slot.container) {
      // Dynamic prop: parent the GLB to the prop's container (origin == body centre)
      // and drop it by baseY so its base rests on the floor. The container is what
      // the snapshot moves/rotates, so the GLB follows the physics body for free.
      inst.position.set(0, -slot.baseY, 0);
      slot.container.add(inst);
    } else {
      // Fixture: place once in world space.
      inst.position.set(slot.x, slot.y || 0, slot.z);
      inst.rotation.y = slot.rot || 0;
      this.scene.add(inst);
    }
    // Keep the primitive as the (now invisible) camera-collision proxy so the
    // third-person pull-in behaves identically whatever the GLB's real silhouette
    // is — the raycaster still hits it (invisible objects are not skipped). If the
    // GLB had failed instead, the primitive would simply have stayed visible.
    slot.holder.visible = false;
  }

  // Clone a loaded GLB, scale it so its largest dimension == `target` world units,
  // then centre it in x/z and rest its base on y=0. Wrapped in a group so the caller
  // can position/rotate it freely regardless of the model's internal origin.
  _instantiateModel(template, target, dims) {
    const inner = template.clone(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (dims) {
      // Non-uniform: scale each axis to an exact world size. Guards against a zero
      // native extent (a perfectly flat mesh) so a floor stays the intended thickness
      // no matter how thick or thin the source GLB is.
      inner.scale.set(
        dims.w / (size.x || 1),
        dims.h / (size.y || 1),
        dims.d / (size.z || 1)
      );
    } else {
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      inner.scale.setScalar(target / maxDim);
    }
    const box2 = new THREE.Box3().setFromObject(inner);
    const center = new THREE.Vector3();
    box2.getCenter(center);
    inner.position.set(-center.x, -box2.min.y, -center.z);
    inner.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    const holder = new THREE.Group();
    holder.add(inner);
    return holder;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
