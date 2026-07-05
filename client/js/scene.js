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

    // Static props.
    for (const p of propInstances) {
      const built = makePropMesh(p.type, catalog);
      if (!built) continue;
      built.mesh.position.set(p.x, built.baseY, p.z);
      built.mesh.rotation.y = p.rot || 0;
      this.scene.add(built.mesh);
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
      if (p.id === this.selfId) continue; // self is the camera, no avatar

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

  // Place the first-person camera.
  setCamera(pos, yaw, pitch) {
    this.camera.position.set(pos.x, 1.6, pos.z);
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = pitch;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
