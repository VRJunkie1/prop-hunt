// All Three.js rendering lives here. The scene is a pure view of server state:
// it builds the map + props from config, and each frame reconciles player
// meshes against the latest authoritative snapshot. No game rules here.
//
// Three.js is imported LAZILY (initThree) instead of at module load, so the
// landing page pulls in NO external CDN resources — the headless load check stays
// clean even when its network to CDNs is unreliable. THREE is filled in before
// any Scene3D/makePropMesh call runs (main.js awaits initThree() in ensureScene()
// before constructing the scene), so every THREE.* reference below resolves fine.
// See index.html for the full rationale.
let THREE = null;

// Resolve the 'three' importmap entry on demand and cache the module namespace.
// Callers MUST await this before constructing Scene3D or calling makePropMesh.
export async function initThree() {
  if (!THREE) THREE = await import('three');
  return THREE;
}

// Vertical squash applied to a crouching avatar. Roughly matches the
// crouch/stand body-height ratio in rules.json (1.1 / 1.8).
const CROUCH_SCALE = 0.6;

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
    this.propMeshes = []; // static disguisable props, tagged with userData.propId
    this.raycaster = new THREE.Raycaster(); // aim-to-disguise crosshair ray
    this.highlighted = null; // prop mesh currently under the crosshair, if any

    this.resize();
    window.addEventListener('resize', () => this.resize());
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
    }

    // Static props. Each mesh carries its stable prop id + type so the aim ray
    // (propUnderCrosshair) can name exactly what the player is looking at.
    this.propMeshes = [];
    this.highlighted = null;
    for (const p of propInstances) {
      const built = makePropMesh(p.type, catalog);
      if (!built) continue;
      built.mesh.position.set(p.x, built.baseY, p.z);
      built.mesh.rotation.y = p.rot || 0;
      built.mesh.userData.propId = p.id;
      built.mesh.userData.propType = p.type;
      this.scene.add(built.mesh);
      this.propMeshes.push(built.mesh);
    }
  }

  // Shoot a ray straight out of the camera (screen centre = the crosshair) and
  // return { id, type, mesh } of the FIRST static prop it hits within maxDist, or
  // null. First-hit is the point: an occluding barrel in front of a crate gets
  // you the barrel. Only static props are tested — you disguise as scenery, not
  // as other players.
  propUnderCrosshair(maxDist) {
    if (!this.propMeshes.length) return null;
    this.raycaster.far = maxDist;
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
    const hits = this.raycaster.intersectObjects(this.propMeshes, false);
    if (!hits.length) return null;
    const mesh = hits[0].object;
    return { id: mesh.userData.propId, type: mesh.userData.propType, mesh };
  }

  // Emissive glow on the prop under the crosshair (view-layer feedback only — the
  // "is this a valid target" decision lives in main.js). Pass null to clear.
  highlightProp(mesh) {
    if (this.highlighted === mesh) return;
    if (this.highlighted) this.highlighted.material.emissive.setHex(0x000000);
    this.highlighted = mesh || null;
    if (mesh) mesh.material.emissive.setHex(0x2a2a10);
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
      if (p.id === this.selfId) continue; // self is the camera, no avatar

      let entry = this.players.get(p.id);
      const kind = p.disguise ? `d:${p.disguise}` : p.hunter ? 'hunter' : 'prop';
      if (!entry || entry.kind !== kind) {
        // New player, or appearance changed (disguised / role) -> rebuild mesh.
        if (entry) this.scene.remove(entry.mesh);
        const mesh = this.meshForPlayer(p);
        mesh.position.set(p.x, mesh.userData.baseY, p.z);
        this.scene.add(mesh);
        entry = { mesh, kind, baseY: mesh.userData.baseY, target: { x: p.x, y: p.y || 0, z: p.z, yaw: p.yaw } };
        this.players.set(p.id, entry);
      }
      entry.target.x = p.x;
      entry.target.y = p.y || 0;
      entry.target.z = p.z;
      entry.target.yaw = p.yaw;
      entry.crouch = !!p.crouch;
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

  // Smoothly move other players toward their latest snapshot position. Also
  // applies vertical jump offset and a crouch squash so ducking/hopping reads
  // to everyone — and matches the referee's shrunk tag hitbox.
  interpolate(alpha) {
    for (const entry of this.players.values()) {
      const m = entry.mesh;
      m.position.x += (entry.target.x - m.position.x) * alpha;
      m.position.z += (entry.target.z - m.position.z) * alpha;
      const s = entry.crouch ? CROUCH_SCALE : 1;
      m.scale.y = s;
      // Keep feet on the ground (+ jump height): center = foot + scaled half-height.
      m.position.y = (entry.target.y || 0) + entry.baseY * s;
      m.rotation.y = entry.target.yaw;
    }
  }

  // Place the first-person camera. eyeHeight dips when crouching; pos.y rises
  // when jumping — both fed from main.js prediction.
  setCamera(pos, eyeHeight, yaw, pitch) {
    this.camera.position.set(pos.x, (pos.y || 0) + eyeHeight, pos.z);
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = pitch;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
