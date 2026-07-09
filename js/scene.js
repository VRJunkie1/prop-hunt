// All Three.js rendering lives here. The scene is a pure view of server state:
// it builds the map + props from config, and each frame reconciles player
// meshes against the latest authoritative snapshot. No game rules here.
import * as THREE from 'three';

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
      const built = makePropMesh(f.type, catalog);
      if (!built) continue;
      built.mesh.position.set(f.x, built.baseY, f.z);
      built.mesh.rotation.y = f.rot || 0;
      this.scene.add(built.mesh);
      this.colliders.push(built.mesh); // camera pulls in against fixtures too
    }

    // Dynamic props (the disguise pool — chairs, stools, crates, dishes, food).
    // Built from the referee's authoritative prop instances; these are the
    // objects props can morph into.
    for (const p of propInstances) {
      const built = makePropMesh(p.type, catalog);
      if (!built) continue;
      built.mesh.position.set(p.x, built.baseY, p.z);
      built.mesh.rotation.y = p.rot || 0;
      this.scene.add(built.mesh);
      this.colliders.push(built.mesh); // ...and against static props
    }
  }

  setSelf(id) {
    this.selfId = id;
  }

  // Create a mesh matching how a player should currently look.
  meshForPlayer(p) {
    if (p.disguise && this.catalog[p.disguise]) {
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
        mesh.position.set(p.x, mesh.userData.baseY, p.z);
        this.scene.add(mesh);
        entry = { mesh, kind, target: { x: p.x, z: p.z, yaw: p.yaw } };
        this.players.set(p.id, entry);
      }
      entry.target.x = p.x;
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

  // Smoothly move other players toward their latest snapshot position.
  interpolate(alpha) {
    for (const entry of this.players.values()) {
      const m = entry.mesh;
      m.position.x += (entry.target.x - m.position.x) * alpha;
      m.position.z += (entry.target.z - m.position.z) * alpha;
      m.rotation.y = entry.target.yaw;
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
  setCamera(pos, yaw, pitch) {
    if (!this.thirdPerson) {
      this.camera.position.set(pos.x, 1.6, pos.z);
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
    const target = this._vTarget.set(pos.x, this._camHeadY, pos.z);
    if (this.selfMesh) {
      this.selfMesh.position.set(pos.x, this.selfMesh.userData.baseY, pos.z);
      this.selfMesh.rotation.y = yaw;
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

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
