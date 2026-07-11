// In-game level editor — a DESKTOP DEBUG TOOL, not a product feature.
//
// The problem it solves: placement/rotation/scale of a map's fixtures and props
// were tuned by editing shared/config/maps.json numbers blind, then rebuilding to
// see the result. This lets a human walk around inside the level and fix it by eye
// instead.
//
// WHY IT'S HONESTLY CLIENT-ONLY (the load-bearing design call):
//   Ctrl+E does NOT pause a running round or reach into the referee. It steps the
//   client OUT of gameplay into a private, LOCAL sandbox scene that loads the map
//   fresh from config. The host referee / netcode / match flow are never touched —
//   the editor simply isn't listening to them while it's open. main.js gates it to
//   solo/local play (never mid-multiplayer) and routes the render loop here.
//
// WHAT IT REUSES (no second renderer, no second pointer-lock path):
//   - The game's single WebGLRenderer (passed in) — one GL context on #view.
//   - scene.js's mesh helpers (makePropMesh / instantiateModel / targetSizeForEntry)
//     so a spawned/edited object is sized EXACTLY as the game draws it.
//   It renders its OWN THREE.Scene with a free-fly camera, and does its own pointer
//   handling (drag-to-look on right button; left click/drag to select/move). It
//   never requests pointer lock, so it can't contend with input.js's desktop scheme.
//
// EXPORT: serialises the edited layout back to the exact maps.json format (fixtures
// + props arrays, position/rotation/scale) to the clipboard or a download. The game
// never writes files — a human pastes the result to the bot or commits it.

import * as THREE from 'three';
import { makePropMesh, instantiateModel, targetSizeForEntry } from './scene.js';

const DEG = Math.PI / 180;
const ROT_STEP = 15 * DEG; // coarse rotate step
const ROT_FINE = 1 * DEG; // with a modifier held
const SCALE_STEP = 0.1;
const SCALE_FINE = 0.02;
const SCALE_MIN = 0.1;
const SCALE_MAX = 5;
const FLY_SPEED = 12; // metres/sec base; Shift is used for vertical-down, not sprint
const LOOK_SENS = 0.0035;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10000) / 10000;

// A tiny GLTF loader, isolated from Scene3D's own so the game's load-bearing
// renderer is untouched. Same lazy-CDN pattern (import only when the editor first
// needs a mesh). Cache is shared across editor sessions in this page.
let _gltfLoader = null;
const _modelCache = new Map(); // '/assets/x.glb' -> template | 'failed'
async function loadTemplate(path) {
  const cached = _modelCache.get(path);
  if (cached === 'failed') return null;
  if (cached) return cached;
  if (!_gltfLoader) {
    try {
      const mod = await import('three/addons/loaders/GLTFLoader.js');
      _gltfLoader = new mod.GLTFLoader();
    } catch {
      return null; // CDN blocked — every item keeps its primitive
    }
  }
  return new Promise((resolve) => {
    _gltfLoader.load(
      path,
      (gltf) => {
        _modelCache.set(path, gltf.scene);
        resolve(gltf.scene);
      },
      undefined,
      () => {
        _modelCache.set(path, 'failed');
        resolve(null);
      }
    );
  });
}

export class Editor {
  // renderer: the game's single WebGLRenderer (shared GL context on the canvas).
  // cfg: the loaded config bundle ({maps, props, fixtures, rules}).
  constructor(canvas, renderer, cfg) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.cfg = cfg;
    this.catalog = { ...cfg.props, ...cfg.fixtures }; // same merge scene.js uses to render
    this.active = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
    this.raycaster = new THREE.Raycaster();

    this.editables = []; // { kind:'fixture'|'prop', type, x,y,z, rot, scale, group, mesh, baseY, cat }
    this.selected = null;
    this.selBox = null; // THREE.BoxHelper outline around the selection
    this.deleteStack = []; // deleted records, popped by the undelete key (U)

    // Free-fly camera state.
    this.yaw = 0;
    this.pitch = -0.5;
    this.camPos = new THREE.Vector3(0, 12, 20);

    // Measured native bounding boxes (real in-world sizes). Fetched lazily on enter;
    // '{}' fallback => the inspector shows primitive/unknown sizes instead of breaking.
    this.assetDims = {};

    // Pointer interaction state.
    this._looking = false; // right-button drag-to-look
    this._dragging = false; // left-button drag on a selected object
    this._dragOffset = new THREE.Vector3();
    this._lastPtr = { x: 0, y: 0 };

    this._boundKey = (e) => this._onKey(e);
    this._boundResize = () => this._resize();
    this._boundDown = (e) => this._onPointerDown(e);
    this._boundMove = (e) => this._onPointerMove(e);
    this._boundUp = (e) => this._onPointerUp(e);
    this._boundWheel = (e) => this._onWheel(e); // mouse wheel rotates the selection (see _onWheel)
    this._helpSeenKey = 'ph_editor_help_seen'; // localStorage flag: help auto-shows only the first time
  }

  // ---- lifecycle -----------------------------------------------------------
  async enter(mapId, mapObj) {
    this.mapId = mapId;
    this.mapMeta = JSON.parse(JSON.stringify(mapObj)); // clone; never mutate cfg.maps
    if (!this._domBuilt) this._buildDom();
    this._root.classList.remove('hidden');
    // Load the measured dimensions once (real in-world sizes for the inspector).
    if (!this._dimsLoaded) {
      try {
        this.assetDims = await fetch('/shared/config/asset-dims.json').then((r) => r.json());
      } catch {
        this.assetDims = {};
      }
      this._dimsLoaded = true;
    }
    this._buildScene();
    this._populatePalette();
    this._syncMapSelect();
    // Start the fly camera looking at the map centre from a back-corner vantage.
    const half = (this.mapMeta.size || 36) / 2;
    this.camPos.set(0, half * 0.7, half + 6);
    this.yaw = 0;
    this.pitch = -0.5;
    this._applyCamera();

    window.addEventListener('keydown', this._boundKey);
    window.addEventListener('resize', this._boundResize);
    this.canvas.addEventListener('pointerdown', this._boundDown);
    window.addEventListener('pointermove', this._boundMove);
    window.addEventListener('pointerup', this._boundUp);
    this.canvas.addEventListener('wheel', this._boundWheel, { passive: false });
    this._resize();
    this.active = true;
    this._refreshInspector();
    this._status('Edit mode. Right-drag to look, WASD + Space/Shift to fly.');
    // Show the help panel automatically the FIRST time edit mode is ever opened, then
    // remember it so it never nags again (per-browser, best-effort in private mode).
    let seen = false;
    try {
      seen = localStorage.getItem(this._helpSeenKey) === '1';
    } catch {
      /* storage blocked (private mode) — just don't auto-show, the ? button still works */
      seen = true;
    }
    if (!seen) {
      this._showHelp();
      try {
        localStorage.setItem(this._helpSeenKey, '1');
      } catch {
        /* ignore */
      }
    }
  }

  exit() {
    this.active = false;
    window.removeEventListener('keydown', this._boundKey);
    window.removeEventListener('resize', this._boundResize);
    this.canvas.removeEventListener('pointerdown', this._boundDown);
    window.removeEventListener('pointermove', this._boundMove);
    window.removeEventListener('pointerup', this._boundUp);
    this.canvas.removeEventListener('wheel', this._boundWheel);
    if (this._root) this._root.classList.add('hidden');
    this._looking = this._dragging = false;
    this._disposeScene();
  }

  // ---- scene build ---------------------------------------------------------
  _buildScene() {
    this._disposeScene();
    const map = this.mapMeta;
    this._owned = []; // geometries/materials the editor created (safe to dispose)
    this.scene.background = new THREE.Color(map.sky || '#87ceeb');
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    // Ground (also the drag/spawn raycast target reference, though we intersect a
    // math plane for that, not this mesh).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.size, map.size),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(map.ground || '#6b6b6b') })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this._own(ground);
    // A subtle grid helps judge placement by eye.
    const grid = new THREE.GridHelper(map.size, Math.max(4, Math.round(map.size / 2)), 0x000000, 0x000000);
    grid.material.opacity = 0.15;
    grid.material.transparent = true;
    this.scene.add(grid);
    this._own(grid);

    // Boundary walls (match the game's enclosing box so the arena reads the same).
    const half = map.size / 2;
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x2a2140 });
    const wallGeo = new THREE.BoxGeometry(map.size, 3, 0.5);
    this._owned.push(wallGeo, wallMat);
    for (const [x, z, ry] of [[0, -half, 0], [0, half, 0], [-half, 0, Math.PI / 2], [half, 0, Math.PI / 2]]) {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(x, 1.5, z);
      wall.rotation.y = ry || 0;
      this.scene.add(wall);
    }

    // Fixtures + props from the cloned map data → editable objects.
    this.editables = [];
    for (const f of map.fixtures || []) this._addEditable('fixture', f);
    for (const p of map.props || []) this._addEditable('prop', p);
    this.selected = null;
    this.selBox = null;
  }

  // Track a mesh's geometry + material for disposal. Used ONLY for editor-created
  // resources (ground, grid, walls, primitive placeholders). GLB instances are
  // NEVER tracked: instantiateModel clones share geometry/material with the cached
  // template, so disposing them would corrupt the shared _modelCache.
  _own(mesh) {
    if (mesh.geometry) this._owned.push(mesh.geometry);
    if (mesh.material) this._owned.push(mesh.material);
  }

  _disposeScene() {
    for (const r of this._owned || []) if (r && r.dispose) r.dispose();
    this._owned = [];
    this._clearSelBox();
    this.scene.clear();
    this.editables = [];
    this.selected = null;
    this.selBox = null;
  }

  // Build one editable object. Each is a top-level Group whose origin is the object's
  // GROUND-CONTACT point (x, y-offset, z); the mesh is lifted inside it by baseY, so
  // scaling the group about its origin keeps the base flush on the floor — the clean
  // transform model the editor manipulates directly.
  _addEditable(kind, entry) {
    const cat = this.catalog[entry.type];
    const built = makePropMesh(entry.type, this.catalog);
    if (!built) return null;
    const group = new THREE.Group();
    const rec = {
      kind,
      type: entry.type,
      x: entry.x,
      y: entry.y || 0,
      z: entry.z,
      rot: entry.rot || 0,
      scale: entry.scale || 1,
      group,
      mesh: built.mesh,
      baseY: built.baseY,
      cat,
    };
    built.mesh.position.set(0, built.baseY, 0); // base at the group origin
    group.add(built.mesh);
    if (this._owned) this._own(built.mesh); // primitive geo/mat: editor-created, safe to dispose
    group.userData.editable = rec;
    this._applyTransform(rec);
    this.scene.add(group);
    this.editables.push(rec);
    // Swap in the real GLB (if any), sized like the game, base at the group origin.
    if (cat && cat.model) this._swapModel(rec);
    return rec;
  }

  async _swapModel(rec) {
    const cat = rec.cat;
    const tmpl = await loadTemplate('/assets/' + cat.model);
    if (!tmpl || !this.active) return;
    // Guard: the object may have been deleted while the GLB loaded.
    if (!this.editables.includes(rec)) return;
    const scale = typeof cat.modelScale === 'number' ? cat.modelScale : this.mapMeta.modelScale;
    const inst = instantiateModel(tmpl, targetSizeForEntry(cat), cat.modelDims || null, scale);
    inst.position.set(0, 0, 0); // instantiateModel already rests the base at y=0
    rec.mesh.visible = false; // keep the primitive as a hidden fallback
    rec.group.add(inst);
    rec.model = inst;
    if (this.selected === rec && this.selBox) this.selBox.setFromObject(rec.group);
  }

  _applyTransform(rec) {
    rec.group.position.set(rec.x, rec.y, rec.z);
    rec.group.rotation.y = rec.rot;
    rec.group.scale.setScalar(rec.scale);
    if (this.selected === rec && this.selBox) this.selBox.update();
  }

  // ---- selection -----------------------------------------------------------
  _select(rec) {
    if (this.selected === rec) return;
    this._clearSelBox();
    this.selected = rec;
    if (rec) {
      this.selBox = new THREE.BoxHelper(rec.group, 0xffef6b);
      this.scene.add(this.selBox);
    }
    this._refreshInspector();
  }

  _clearSelBox() {
    if (this.selBox) {
      this.scene.remove(this.selBox);
      if (this.selBox.geometry) this.selBox.geometry.dispose();
      if (this.selBox.material) this.selBox.material.dispose();
      this.selBox = null;
    }
  }

  _deleteSelected() {
    const rec = this.selected;
    if (!rec) return;
    const i = this.editables.indexOf(rec);
    if (i >= 0) this.editables.splice(i, 1);
    this.scene.remove(rec.group);
    this.deleteStack.push(rec);
    this._select(null);
    this._status(`Deleted ${rec.type}. Press U to undo.`);
  }

  _undelete() {
    const rec = this.deleteStack.pop();
    if (!rec) {
      this._status('Nothing to undelete.');
      return;
    }
    this.scene.add(rec.group);
    this.editables.push(rec);
    this._select(rec);
    this._status(`Restored ${rec.type}.`);
  }

  // ---- spawn ---------------------------------------------------------------
  _spawn(type) {
    const kind = this.cfg.props[type] ? 'prop' : 'fixture';
    const at = this._groundPointAtCenter();
    const rec = this._addEditable(kind, { type, x: round2(at.x), y: 0, z: round2(at.z), rot: 0, scale: 1 });
    if (rec) {
      this._select(rec);
      this._status(`Spawned ${type} (${kind}) at crosshair.`);
    }
  }

  // Ground point under the screen-centre crosshair (spawn location).
  _groundPointAtCenter() {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!this.raycaster.ray.intersectPlane(plane, hit)) hit.set(0, 0, 0);
    // Keep spawns inside the arena so they don't land in a wall or off-map.
    const lim = (this.mapMeta.size || 36) / 2 - 1;
    hit.x = clamp(hit.x, -lim, lim);
    hit.z = clamp(hit.z, -lim, lim);
    return hit;
  }

  // ---- pointer -------------------------------------------------------------
  _ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _onPointerDown(e) {
    if (!this.active) return;
    if (e.button === 2) {
      // Right button: drag-to-look (no pointer lock).
      this._looking = true;
      this._lastPtr = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    // Left button: pick. Hits an editable -> select + begin move drag. Empty -> deselect.
    const rec = this._pick(e);
    if (rec) {
      this._select(rec);
      this._dragging = true;
      this._lastPtr = { x: e.clientX, y: e.clientY };
      // Offset so the object doesn't jump its centre to the cursor when dragging.
      const p = this._groundPointAt(e, rec.y);
      if (p) this._dragOffset.set(rec.x - p.x, 0, rec.z - p.z);
    } else {
      this._select(null);
    }
  }

  _onPointerMove(e) {
    if (!this.active) return;
    if (this._looking) {
      this.yaw -= (e.clientX - this._lastPtr.x) * LOOK_SENS;
      this.pitch -= (e.clientY - this._lastPtr.y) * LOOK_SENS;
      this.pitch = clamp(this.pitch, -1.5, 1.5);
      this._lastPtr = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this._dragging && this.selected) {
      const rec = this.selected;
      if (e.shiftKey) {
        // Vertical: mouse up raises, down lowers (screen-Y is inverted).
        const dy = e.clientY - this._lastPtr.y;
        rec.y = round2(rec.y - dy * 0.03);
      } else {
        const p = this._groundPointAt(e, rec.y);
        if (p) {
          rec.x = round2(p.x + this._dragOffset.x);
          rec.z = round2(p.z + this._dragOffset.z);
        }
      }
      this._lastPtr = { x: e.clientX, y: e.clientY };
      this._applyTransform(rec);
      this._updateInspectorValues();
    }
  }

  _onPointerUp(e) {
    if (e.button === 2) this._looking = false;
    if (e.button === 0) this._dragging = false;
  }

  // Mouse wheel = rotate the selection in 15° clicks around Y (Shift = fine 1° steps),
  // the same yaw-only rotate as the R key. preventDefault always, so the page never
  // scrolls behind the editor. No selection => wheel is inert (but still swallowed).
  _onWheel(e) {
    e.preventDefault();
    if (!this.active) return;
    const rec = this.selected;
    if (!rec) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    rec.rot += dir * (e.shiftKey ? ROT_FINE : ROT_STEP);
    this._applyTransform(rec);
    this._refreshInspector();
  }

  _pick(e) {
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.editables.map((r) => r.group), true);
    for (const h of hits) {
      let o = h.object;
      while (o) {
        if (o.userData && o.userData.editable) return o.userData.editable;
        o = o.parent;
      }
    }
    return null;
  }

  // Ground point (at height `y`) under an arbitrary pointer position (drag target).
  _groundPointAt(e, y) {
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    return this.raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  // ---- keyboard commands ---------------------------------------------------
  _onKey(e) {
    if (!this.active) return;
    // Movement keys are read continuously in frame(); ignore them here. Let the
    // browser handle typing in our own inputs (map select has no text input, but
    // be safe) — skip when focus is in a form field.
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    // '?' toggles the help panel (matches the header hint + the ? button).
    if (e.key === '?') {
      this._toggleHelp();
      e.preventDefault();
      return;
    }

    const rec = this.selected;
    switch (e.code) {
      case 'KeyR':
        if (rec) {
          rec.rot += (e.shiftKey ? ROT_FINE : ROT_STEP) * (e.altKey ? -1 : 1);
          this._applyTransform(rec);
          this._refreshInspector();
        }
        e.preventDefault();
        break;
      case 'Equal':
      case 'NumpadAdd':
        this._nudgeScale(rec, e.shiftKey ? SCALE_FINE : SCALE_STEP);
        e.preventDefault();
        break;
      case 'Minus':
      case 'NumpadSubtract':
        this._nudgeScale(rec, -(e.shiftKey ? SCALE_FINE : SCALE_STEP));
        e.preventDefault();
        break;
      case 'KeyG':
        if (rec) {
          rec.y = 0; // snap the base flush to the floor
          this._applyTransform(rec);
          this._refreshInspector();
          this._status('Snapped to ground.');
        }
        break;
      case 'Delete':
      case 'Backspace':
        this._deleteSelected();
        e.preventDefault();
        break;
      case 'KeyU':
        this._undelete();
        break;
      case 'Escape':
        // Close the help panel first if it's open; otherwise deselect.
        if (this._helpEl && !this._helpEl.classList.contains('hidden')) this._hideHelp();
        else this._select(null);
        break;
      default:
        // Number keys 1–9 spawn the first nine palette entries.
        if (/^Digit[1-9]$/.test(e.code)) {
          const idx = parseInt(e.code.slice(5), 10) - 1;
          const type = this._paletteOrder[idx];
          if (type) this._spawn(type);
        }
    }
  }

  _nudgeScale(rec, delta) {
    if (!rec) return;
    rec.scale = round3(clamp(rec.scale + delta, SCALE_MIN, SCALE_MAX));
    this._applyTransform(rec);
    this._refreshInspector();
  }

  // ---- per-frame update ----------------------------------------------------
  frame(dt) {
    if (!this.active) return;
    this._flyStep(dt);
    this._applyCamera();
    this.renderer.render(this.scene, this.camera);
  }

  _flyStep(dt) {
    if (typeof this._keys !== 'function') return;
    const keys = this._keys();
    if (!keys) return;
    const cp = Math.cos(this.pitch);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(fwd);
    if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
    // Vertical: Space or E up; Shift or Q down.
    if (keys.has('Space') || keys.has('KeyE')) move.y += 1;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(FLY_SPEED * dt);
      this.camPos.add(move);
    }
  }

  _applyCamera() {
    this.camera.position.copy(this.camPos);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The renderer size is owned by Scene3D.resize; it targets the same window, so
    // we don't fight it here — only our camera aspect needs updating.
  }

  // The editor reads live key state from the shared Input via a setter (main.js wires
  // it), so movement uses the same key set as the rest of the game.
  setKeySource(fn) {
    this._keys = fn;
  }

  // ---- real in-world size (measured) --------------------------------------
  // Returns { w, h, d, source } in metres for the inspector, or null if unknown.
  _realSize(cat, objScale) {
    if (!cat) return null;
    if (cat.modelDims) {
      const d = cat.modelDims;
      return { w: d.w * objScale, h: d.h * objScale, d: d.d * objScale, source: 'exact' };
    }
    const native = cat.model ? this.assetDims[cat.model] : null;
    if (native) {
      const eff = (typeof cat.modelScale === 'number' ? cat.modelScale : this.mapMeta.modelScale || 1) * objScale;
      return { w: native.w * eff, h: native.h * eff, d: native.d * eff, source: 'measured' };
    }
    // Primitive footprint (already in world units) — the fallback / size target.
    if (cat.shape === 'box') return { w: cat.w * objScale, h: cat.h * objScale, d: cat.d * objScale, source: 'approx' };
    if (cat.shape === 'cylinder' || cat.shape === 'cone')
      return { w: 2 * cat.r * objScale, h: cat.h * objScale, d: 2 * cat.r * objScale, source: 'approx' };
    if (cat.shape === 'sphere') return { w: 2 * cat.r * objScale, h: 2 * cat.r * objScale, d: 2 * cat.r * objScale, source: 'approx' };
    return null;
  }

  // ---- serialisation / export ---------------------------------------------
  _serializeEntry(rec) {
    const out = { type: rec.type, x: round2(rec.x), z: round2(rec.z) };
    if (rec.y) out.y = round2(rec.y);
    // Normalise rotation into (-π, π] so repeated R presses don't emit huge radians.
    let r = rec.rot % (2 * Math.PI);
    if (r > Math.PI) r -= 2 * Math.PI;
    if (r <= -Math.PI) r += 2 * Math.PI;
    if (Math.abs(r) > 1e-6) out.rot = round4(r);
    if (rec.scale && rec.scale !== 1) out.scale = round3(rec.scale);
    return out;
  }

  // Full maps.json with THIS map's fixtures/props replaced by the edited layout and
  // every other map left byte-identical — a drop-in replacement for the file.
  _exportMapsJson() {
    const fixtures = this.editables.filter((r) => r.kind === 'fixture').map((r) => this._serializeEntry(r));
    const props = this.editables.filter((r) => r.kind === 'prop').map((r) => this._serializeEntry(r));
    const out = {};
    for (const [id, m] of Object.entries(this.cfg.maps)) {
      if (id !== this.mapId) {
        out[id] = m;
        continue;
      }
      const edited = { ...JSON.parse(JSON.stringify(m)) };
      // Preserve the map's meta (name/size/ground/sky/spawns/modelScale/_comments)
      // and only swap the two arrays. Omit an empty fixtures[] for maps that never
      // had one (circus/toy) so the file stays clean.
      if (fixtures.length || Array.isArray(m.fixtures)) edited.fixtures = fixtures;
      edited.props = props;
      out[id] = edited;
    }
    return JSON.stringify(out, null, 2);
  }

  async _copyJson() {
    const text = this._exportMapsJson();
    try {
      await navigator.clipboard.writeText(text);
      this._status('Copied maps.json to clipboard — paste it to the bot or into shared/config/maps.json.');
    } catch {
      // Clipboard blocked (permissions / insecure context): fall back to a download.
      this._downloadJson(text);
      this._status('Clipboard blocked — downloaded maps.json instead.');
    }
  }

  _downloadJson(text) {
    const blob = new Blob([text || this._exportMapsJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maps.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this._status('Downloaded maps.json.');
  }

  // ---- DOM (built once, styled in css/style.css) ---------------------------
  _buildDom() {
    const root = document.createElement('div');
    root.id = 'editorRoot';
    root.className = 'hidden';

    // Header + help.
    const header = document.createElement('div');
    header.id = 'edHeader';
    header.innerHTML =
      '<strong>LEVEL EDITOR</strong> · debug' +
      '<div class="ed-help">Right-drag look · WASD+Space/Shift fly · click select · drag move (Shift=up/down) · ' +
      'R / wheel rotate 15° · +/− or slider scale · G snap floor · Del delete · U undo · Ctrl+E exit · ' +
      '<b>press ? for full help</b></div>';
    root.appendChild(header);

    // Palette (left).
    const palette = document.createElement('div');
    palette.id = 'edPalette';
    palette.innerHTML = '<div class="ed-title">Spawn (click / 1–9)</div><div id="edPaletteList"></div>';
    root.appendChild(palette);
    this._paletteList = palette.querySelector('#edPaletteList');

    // Inspector (right).
    const inspector = document.createElement('div');
    inspector.id = 'edInspector';
    inspector.innerHTML = '<div class="ed-title">Inspector</div><div id="edInspectorBody" class="ed-empty">Nothing selected.</div>';
    root.appendChild(inspector);
    this._inspectorBody = inspector.querySelector('#edInspectorBody');

    // Footer (map select + export).
    const footer = document.createElement('div');
    footer.id = 'edFooter';
    const mapSel = document.createElement('select');
    mapSel.id = 'edMapSelect';
    mapSel.addEventListener('change', () => this._switchMap(mapSel.value));
    this._mapSelect = mapSel;
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy map JSON';
    copyBtn.className = 'ed-btn primary';
    copyBtn.addEventListener('click', () => this._copyJson());
    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download maps.json';
    dlBtn.className = 'ed-btn';
    dlBtn.addEventListener('click', () => this._downloadJson());
    const helpBtn = document.createElement('button');
    helpBtn.textContent = '?';
    helpBtn.className = 'ed-btn ed-help-btn';
    helpBtn.title = 'Show controls & how to save (?)';
    helpBtn.addEventListener('click', () => this._toggleHelp());
    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'Exit (Ctrl+E)';
    exitBtn.className = 'ed-btn';
    exitBtn.addEventListener('click', () => this.onExit && this.onExit());
    const label = document.createElement('span');
    label.className = 'ed-map-label';
    label.textContent = 'Map:';
    footer.append(label, mapSel, copyBtn, dlBtn, helpBtn, exitBtn);
    root.appendChild(footer);

    // Help overlay (controls + how-to-save). Built once, hidden until the ? button
    // or the first-open auto-show reveals it.
    this._buildHelp(root);

    // Status line.
    const status = document.createElement('div');
    status.id = 'edStatus';
    root.appendChild(status);
    this._statusEl = status;

    // Centre crosshair (spawn point marker).
    const cross = document.createElement('div');
    cross.id = 'edCrosshair';
    cross.textContent = '+';
    root.appendChild(cross);

    (this.canvas.parentElement || document.body).appendChild(root);
    this._root = root;
    this._domBuilt = true;
  }

  // ---- help panel ----------------------------------------------------------
  // A centred modal listing every control and a short "how to save your edits" note.
  // Opens on the ? button and automatically the first time edit mode is ever entered.
  _buildHelp(root) {
    const backdrop = document.createElement('div');
    backdrop.id = 'edHelp';
    backdrop.className = 'hidden';
    // Click on the dimmed backdrop (outside the card) closes.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this._hideHelp();
    });

    const card = document.createElement('div');
    card.id = 'edHelpCard';
    card.innerHTML =
      '<h2>Level editor — controls</h2>' +
      '<ul class="ed-help-list">' +
      '<li><b>Ctrl+E</b> — toggle edit mode (also exits)</li>' +
      '<li><b>Fly</b> — W A S D move · Space/E up · Shift/Q down · <b>right-drag</b> mouse to look</li>' +
      '<li><b>Select</b> — left-click an object · Esc deselects</li>' +
      '<li><b>Move</b> — drag the selection along the floor · hold <b>Shift</b> for up/down · <b>G</b> snaps to ground</li>' +
      '<li><b>Rotate</b> — <b>R</b> or the <b>mouse wheel</b>, 15° steps (Shift = fine 1°, Alt reverses R) — yaw only</li>' +
      '<li><b>Scale</b> — <b>+ / −</b> keys or the inspector <b>slider</b>, 0.1×–5× (Shift = fine)</li>' +
      '<li><b>Add</b> — click a palette item on the left, or number keys <b>1–9</b> — spawns at the crosshair</li>' +
      '<li><b>Delete</b> — <b>Del</b> / Backspace · <b>U</b> undoes the last delete</li>' +
      '</ul>' +
      '<h2>How to save your edits</h2>' +
      '<ol class="ed-help-list">' +
      '<li>Click <b>“Copy map JSON”</b> — it copies the whole maps.json to your clipboard.</li>' +
      '<li>Paste it to <b>DevBot</b> in the Discord <b>#devbot</b> channel and say which map it is (e.g. “restaurant”).</li>' +
      '<li>The bot commits it — no file editing on your end. (“Download maps.json” is a fallback if the clipboard is blocked.)</li>' +
      '</ol>' +
      '<div class="ed-help-actions"><button id="edHelpClose" class="ed-btn primary">Got it</button></div>';
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    this._helpEl = backdrop;
    card.querySelector('#edHelpClose').addEventListener('click', () => this._hideHelp());
  }

  // Public: force the help/instructions panel open. Used when the editor is opened
  // from the on-screen "Map Editor (dev use only)" button so a first-time dev always
  // sees the controls + how-to-save note, regardless of the first-open localStorage
  // flag (which only governs the automatic Ctrl+E auto-show).
  showHelp() {
    this._showHelp();
  }

  _showHelp() {
    if (this._helpEl) this._helpEl.classList.remove('hidden');
  }

  _hideHelp() {
    if (this._helpEl) this._helpEl.classList.add('hidden');
  }

  _toggleHelp() {
    if (this._helpEl) this._helpEl.classList.toggle('hidden');
  }

  _populatePalette() {
    this._paletteList.innerHTML = '';
    this._paletteOrder = [];
    const add = (type, kind) => {
      const idx = this._paletteOrder.length;
      this._paletteOrder.push(type);
      const btn = document.createElement('button');
      btn.className = 'ed-pal-item ' + kind;
      const key = idx < 9 ? `${idx + 1} ` : '';
      btn.textContent = key + type;
      btn.title = `${type} (${kind})`;
      btn.addEventListener('click', () => this._spawn(type));
      this._paletteList.appendChild(btn);
    };
    // Props first (disguise pool), then fixtures — number keys hit the most-used first.
    for (const t of Object.keys(this.cfg.props)) if (!t.startsWith('_')) add(t, 'prop');
    for (const t of Object.keys(this.cfg.fixtures)) if (!t.startsWith('_')) add(t, 'fixture');
  }

  _syncMapSelect() {
    const sel = this._mapSelect;
    sel.innerHTML = '';
    for (const [id, m] of Object.entries(this.cfg.maps)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = m.name || id;
      if (id === this.mapId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  _switchMap(id) {
    if (id === this.mapId) return;
    this.mapId = id;
    this.mapMeta = JSON.parse(JSON.stringify(this.cfg.maps[id]));
    this.deleteStack = [];
    this._buildScene();
    this._select(null);
    const half = (this.mapMeta.size || 36) / 2;
    this.camPos.set(0, half * 0.7, half + 6);
    this._status(`Editing ${this.mapMeta.name || id}.`);
  }

  // Full (re)build of the inspector DOM — on selection change, spawn, rotate, snap,
  // and keyboard scale nudge. Stable value spans (edv*) let _updateInspectorValues
  // refresh just the numbers during a drag without rebuilding the scale slider.
  _refreshInspector() {
    const rec = this.selected;
    const body = this._inspectorBody;
    if (!rec) {
      body.className = 'ed-empty';
      body.textContent = 'Nothing selected. Click an object.';
      this._scaleSlider = null;
      return;
    }
    body.className = '';
    body.innerHTML =
      `<div class="ed-row"><span>Name</span><b>${rec.type}</b> <span class="ed-src">${rec.kind}</span></div>` +
      `<div class="ed-row"><span>Pos</span><span id="edvPos"></span></div>` +
      `<div class="ed-row"><span>Rot Y</span><span id="edvRot"></span></div>` +
      `<div class="ed-row"><span>Scale</span><span id="edvScale"></span></div>` +
      `<input id="edScaleSlider" class="ed-scale" type="range" min="${SCALE_MIN}" max="${SCALE_MAX}" step="0.05">` +
      `<div class="ed-row"><span>Size</span><span id="edvSize"></span></div>`;
    this._scaleSlider = body.querySelector('#edScaleSlider');
    this._scaleSlider.value = String(rec.scale);
    // Dragging the slider scales the selection uniformly (same single `scale` value the
    // +/− keys drive and the exporter writes). Update only the numeric spans so the
    // slider keeps its own drag state (a full rebuild would reset the thumb mid-drag).
    this._scaleSlider.addEventListener('input', () => {
      const r = this.selected;
      if (!r) return;
      r.scale = round3(clamp(parseFloat(this._scaleSlider.value), SCALE_MIN, SCALE_MAX));
      this._applyTransform(r);
      this._updateInspectorValues(true);
    });
    this._updateInspectorValues();
  }

  // Refresh just the live value spans (pos / rot / scale / size). Cheap enough to call
  // every drag frame. skipSlider avoids yanking the slider thumb while the user drags it.
  _updateInspectorValues(skipSlider) {
    const rec = this.selected;
    const body = this._inspectorBody;
    if (!rec || !body) return;
    const set = (id, html) => {
      const el = body.querySelector('#' + id);
      if (el) el.innerHTML = html;
    };
    set('edvPos', `${rec.x.toFixed(2)}, ${rec.y.toFixed(2)}, ${rec.z.toFixed(2)}`);
    set('edvRot', `${Math.round(((rec.rot / DEG) % 360 + 360) % 360)}°`);
    set('edvScale', `${rec.scale.toFixed(2)}×`);
    const size = this._realSize(rec.cat, rec.scale);
    set(
      'edvSize',
      size ? `${size.w.toFixed(2)} × ${size.h.toFixed(2)} × ${size.d.toFixed(2)} m <span class="ed-src">(${size.source})</span>` : 'size unknown'
    );
    if (!skipSlider && this._scaleSlider) this._scaleSlider.value = String(rec.scale);
  }

  _status(msg) {
    if (this._statusEl) this._statusEl.textContent = msg || '';
  }
}
