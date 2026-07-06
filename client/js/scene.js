// All Three.js rendering lives here. The scene is a pure view of server state:
// it builds the map + props from config, and each frame reconciles player
// meshes against the latest authoritative snapshot. No game rules here.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- Custom-content asset loading -------------------------------------------
// Optional real 3D models (glTF/.glb) and image textures for maps and props.
// Everything here is ADDITIVE and view-only: when a catalog/map entry has no
// `model`/`texture` field, or a file fails to load, we keep the colored-primitive
// look. The referee never opens these files — it reads only type/x/z/rot from
// the same config — so fancy visuals can never drift game rules. The primitive
// dimensions (w/h/d/r) are still the single source of size, which a future
// physics pass reuses; models are purely what you see. See docs/custom-content.md.

// Resolve an author-supplied asset path. Bare paths live under /assets/; an
// absolute path or full URL is used as-is (e.g. a CDN-hosted model).
function assetURL(path) {
  if (/^(https?:)?\/\//.test(path) || path.startsWith('/')) return path;
  return '/assets/' + path.replace(/^\.?\/+/, '');
}

const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const gltfCache = new Map(); // url -> Promise<THREE.Object3D> (source; cloned per use)

// Load a glTF/.glb once and cache the source scene; callers clone it per instance.
function loadGLTFScene(url) {
  if (!gltfCache.has(url)) {
    gltfCache.set(
      url,
      new Promise((resolve, reject) => {
        gltfLoader.load(url, (g) => resolve(g.scene), undefined, reject);
      })
    );
  }
  return gltfCache.get(url);
}

// Load an image texture (fresh instance so per-use wrap/repeat can differ).
function loadTexture(url, { repeat } = {}) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}

// Build the colored-primitive fallback for a prop type. Returns { mesh, baseY }
// where baseY rests the shape on the ground (y=0). This is always built first so
// something shows instantly and works synchronously (disguised players need it).
function makePrimitive(c) {
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

// If a prop type points at a real model or texture, load it async and swap it in
// on top of the primitive. On any failure the primitive stays — the game never
// breaks on a bad asset. `mesh` is the primitive; `baseY` its ground offset.
function applyCustomVisual(mesh, baseY, c) {
  if (c.model) {
    loadGLTFScene(assetURL(c.model))
      .then((src) => {
        const model = src.clone(true);
        model.scale.setScalar(c.modelScale || 1);
        // The primitive sits centered at baseY; drop the model so its own origin
        // lands on the ground, then allow a per-type nudge for odd pivots.
        model.position.y = -baseY + (c.modelYOffset || 0);
        model.traverse((o) => {
          if (o.isMesh) o.castShadow = true;
        });
        mesh.material.visible = false; // hide the fallback shape; children render
        mesh.add(model);
      })
      .catch(() => {
        /* keep the colored fallback so a missing/broken model never breaks play */
      });
  } else if (c.texture) {
    mesh.material.map = loadTexture(assetURL(c.texture));
    mesh.material.needsUpdate = true;
  }
}

// Build a mesh for a prop type from the catalog. Returns { mesh, baseY }. Reused
// for static props and for disguised players. Colored-primitive by default; if
// the type declares a `model`/`texture`, that loads async and swaps in on top.
export function makePropMesh(type, catalog) {
  const c = catalog[type];
  if (!c) return null;
  const built = makePrimitive(c);
  applyCustomVisual(built.mesh, built.baseY, c);
  return built;
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

    // Procedural ground + boundary walls. These are always built: they show
    // instantly and act as the fallback if a custom map model is set but fails
    // (or absent). A map may texture the ground via `groundTexture`.
    const envFallback = [];
    const groundMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(map.ground) });
    if (map.groundTexture) {
      groundMat.map = loadTexture(assetURL(map.groundTexture), { repeat: map.groundTextureRepeat || 8 });
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.size, map.size), groundMat);
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    envFallback.push(ground);

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
      envFallback.push(wall);
    }

    // Optional custom map model (glTF/.glb) overlaid on top. It's view-only —
    // gameplay bounds still come from `map.size`, so a decorative model that
    // extends past the arena won't change where players can walk. On success we
    // hide the procedural ground/walls; on failure they stay as the fallback.
    if (map.model) {
      loadGLTFScene(assetURL(map.model))
        .then((src) => {
          const m = src.clone(true);
          m.scale.setScalar(map.modelScale || 1);
          m.position.y = map.modelYOffset || 0;
          this.scene.add(m);
          for (const o of envFallback) o.visible = false;
        })
        .catch(() => {
          /* keep the procedural arena so a bad map model never breaks play */
        });
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
