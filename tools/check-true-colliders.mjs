#!/usr/bin/env node
// tools/check-true-colliders.mjs — validates the TRUE Rapier collider overlay's shape
// dispatch (js/scene.js _buildTrueColliderWire / _trueShapeKey) against the REAL engine.
//
// The "True Colliders" debug toggle (2026-07-13, VRmike) reads collider shapes STRAIGHT from
// the live Rapier world and draws each in its real form. scene.js can't be exercised headless
// (it needs THREE + a canvas), so this stands up the SAME shared/physics.js PhysicsWorld the
// game runs and asserts that every collider Rapier actually simulates maps to a KNOWN shape
// branch — never the "unsupported" fallthrough. It also constructs a trimesh + convex-hull
// shape directly to prove those branches (no game map uses them today, but the renderer must
// handle them per the task: "draw the polygon/mesh colliders").
//
// AUTHORING-ONLY, never shipped. Rapier is a WASM package the page pulls from a CDN, so this
// needs a local dev install first (not saved to package.json):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-true-colliders.mjs
// If the package is absent it prints SKIP and exits 3 (same convention as check-physics-live).

let RAPIER;
try {
  RAPIER = (await import('@dimforge/rapier3d-compat')).default;
} catch {
  console.log('SKIP: @dimforge/rapier3d-compat not installed. Run: npm i --no-save @dimforge/rapier3d-compat@0.14.0');
  process.exit(3);
}
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');

await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));

// The SAME classification js/scene.js uses (minus the THREE geometry it builds). Given a
// Rapier Shape, return the wire KIND the overlay would draw, or 'unsupported' (== null wire).
// Mirrors _buildTrueColliderWire's branch order exactly so a divergence fails here.
function classifyShape(s) {
  if (!s) return 'unsupported';
  const t = s.type;
  if (s.halfExtents) return 'cuboid';                       // Cuboid / RoundCuboid
  if (s.vertices && (t === 6 || t === 9 || t === 16)) return 'mesh'; // TriMesh / Convex(+round)
  if (s.radius != null && s.halfHeight != null) {           // Capsule / Cylinder / Cone (+round)
    if (t === 10 || t === 14) return 'cylinder';
    if (t === 11 || t === 15) return 'cone';
    return 'capsule';
  }
  if (s.radius != null) return 'ball';                      // Ball
  return 'unsupported';
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('true-collider overlay shape-dispatch check');

// A map exercising every primitive the catalog can build (box/cylinder/cone/ball) plus a
// static box fixture; players add capsule colliders (base + disguise-grown, both capsules).
const map = {
  size: 40,
  fixtures: [{ type: 'counter', x: 8, z: 0, y: 0, rot: 0 }],
};
const catalog = {
  counter: { shape: 'box', w: 1.0, h: 1.0, d: 1.0, static: true },
  crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 },
  barrel: { shape: 'cylinder', r: 0.5, h: 1.2 },
  cone_prop: { shape: 'cone', r: 0.5, h: 1.0 },
  ball_prop: { shape: 'sphere', r: 0.6 },
};
const props = [
  { id: 1, type: 'crate', x: -4, z: 0, y: 0, rot: 0 },
  { id: 2, type: 'barrel', x: -2, z: 0, y: 0, rot: 0 },
  { id: 3, type: 'cone_prop', x: 0, z: 0, y: 0, rot: 0 },
  { id: 4, type: 'ball_prop', x: 2, z: 0, y: 0, rot: 0 },
];

const w = new PhysicsWorld(RAPIER, map, props, catalog, { dynamicProps: true, rules, feel });
w.addPlayer('local', { x: 0, y: 0, z: 6 });   // the LOCAL player's own capsule (VRmike's bug)
w.addPlayer('remote', { x: 0, y: 0, z: 8 });  // a remote player, disguised below
// Part 1 (2026-07-13, VRmike): a disguised player's MOVEMENT collider is now the prop's TRUE
// shape (a crate => a cuboid), NOT a person capsule grown to fit — so the true-collider viz
// shows ONLY the prop shape, with no residual full-size pink capsule enclosing it.
if (w.setPlayerCollider) w.setPlayerCollider('remote', 'crate'); // disguise => prop-shaped move collider

// Walk EVERY collider the engine is simulating, exactly like scene.updateTrueColliders, and
// classify each via the same dispatch. Read the transform too so a break in that API surfaces.
const census = {};
let total = 0, transformsOk = 0;
w.world.forEachCollider((col) => {
  total++;
  const kind = classifyShape(col.shape);
  census[kind] = (census[kind] || 0) + 1;
  const tr = col.translation();
  const q = col.rotation();
  if (tr && Number.isFinite(tr.x) && q && Number.isFinite(q.w)) transformsOk++;
});

console.log('  collider census:', JSON.stringify(census), `(total ${total})`);
check('forEachCollider iterated the live world', total > 0, `${total} colliders`);
check('every collider maps to a KNOWN shape branch (no "unsupported")', !census.unsupported, census.unsupported ? `${census.unsupported} unsupported` : 'all classified');
check('every collider exposed a finite translation()/rotation()', transformsOk === total, `${transformsOk}/${total}`);
check('cuboid colliders present (ground/walls/fixtures/box props)', (census.cuboid || 0) > 0, `${census.cuboid || 0}`);
// Exactly ONE capsule: the UNDISGUISED local player. The crate-disguised remote's movement body
// is a cuboid now (Part 1), not a second capsule — the whole point of the fix.
check('undisguised player keeps a capsule movement body (local only)', (census.capsule || 0) === 1, `${census.capsule || 0} capsule(s)`);
check('cylinder collider present (barrel prop)', (census.cylinder || 0) >= 1, `${census.cylinder || 0}`);
check('cone collider present (cone prop)', (census.cone || 0) >= 1, `${census.cone || 0}`);
check('ball collider present (sphere prop)', (census.ball || 0) >= 1, `${census.ball || 0}`);

// Part 1 assertion, made explicit per-player against the live engine: the crate-disguised
// remote's own MOVEMENT collider IS a cuboid (the prop shape) and there is NO residual capsule
// on its body — the true-collider viz will therefore show ONLY the crate shape, no pink capsule.
const remoteBody = w.players.get('remote').body;
let remoteMove = null, remoteCaps = 0;
for (let i = 0; i < remoteBody.numColliders(); i++) {
  const col = remoteBody.collider(i);
  const kind = classifyShape(col.shape);
  const isSensor = col.isSensor ? col.isSensor() : false;
  if (!isSensor) remoteMove = kind;
  if (!isSensor && kind === 'capsule') remoteCaps++;
}
check('disguised player movement collider IS the prop shape (crate => cuboid)', remoteMove === 'cuboid', `movement collider = ${remoteMove}`);
check('disguised player has NO residual full-size capsule', remoteCaps === 0, `${remoteCaps} residual capsule(s)`);
w.destroy();

// The renderer must also handle mesh colliders (the task's whole point: SEE the polygon/mesh
// colliders). No shipped map bakes a trimesh/convex hull today, so construct them directly and
// prove the dispatch classifies them as 'mesh' and their vertex buffers are readable.
const triVerts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const triIdx = new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
const trimesh = new RAPIER.TriMesh(triVerts, triIdx);
check('TriMesh classifies as a mesh wire', classifyShape(trimesh) === 'mesh', `type=${trimesh.type}`);
check('TriMesh exposes readable vertices/indices', trimesh.vertices.length === 12 && trimesh.indices.length === 12);

const hullVerts = new Float32Array([-1, -1, -1, 1, -1, -1, 0, 1, 0, 0, 0, 1]);
const convex = RAPIER.ConvexPolyhedron ? new RAPIER.ConvexPolyhedron(hullVerts, null) : null;
if (convex) {
  check('ConvexPolyhedron classifies as a mesh wire', classifyShape(convex) === 'mesh', `type=${convex.type}`);
  check('ConvexPolyhedron exposes readable vertices', convex.vertices.length >= 12);
} else {
  console.log('  (RAPIER.ConvexPolyhedron unavailable in this build — trimesh branch already covers the mesh path)');
}

// ---- CONVEX-HULL COLLIDERS (2026-07-13, VRmike — collider overhaul option 1) ----------------
// Prove that EVERY baked hull in shared/config/hulls.json actually builds a convex-hull collider
// in the live engine (classifies as a mesh wire — the true-collider overlay will draw the real
// polyhedron), and that a hull prop's collider is centred so its base rests on the floor. A hull
// that came out degenerate would silently fall through shapeFor to a cuboid — this catches that
// so a "hulled" prop can't quietly ship as a box. Also confirms the disguised-player movement +
// shot colliders become hulls (the coordination point with the disguise-collider build).
let hullDoc = { hulls: {} };
try { hullDoc = JSON.parse(fs.readFileSync(new URL('../shared/config/hulls.json', import.meta.url), 'utf8')); } catch {}
const hullTypes = Object.keys(hullDoc.hulls || {});
console.log(`\nconvex-hull colliders (${hullTypes.length} baked type(s)):`);
check(`safety scan verdict recorded`, !!(hullDoc.scan && hullDoc.scan.verdict), hullDoc.scan ? hullDoc.scan.verdict : 'missing');
check(`safety scan excluded no room shells (or listed them)`, Array.isArray(hullDoc.scan && hullDoc.scan.excluded),
  hullDoc.scan && hullDoc.scan.excluded ? `${hullDoc.scan.excluded.length} exclusion(s)` : 'n/a');

let hullBuilt = 0, hullFellBack = 0, hullBadBase = 0;
for (const type of hullTypes) {
  const h = hullDoc.hulls[type];
  const cat = { [type]: { shape: 'box', w: 1, h: 1, d: 1, hullVerts: h.v, hullAabb: h.aabb } };
  const hw = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [{ id: 1, type, x: 0, z: 0, y: 0, rot: 0 }], cat, { dynamicProps: true, rules, feel });
  let kind = null, base = null;
  hw.world.forEachCollider((col) => {
    // the single prop body's collider (ground/walls are cuboids at the edges; the prop is at x=0)
    const t = col.translation();
    if (Math.abs(t.x) < 0.01 && Math.abs(t.z) < 0.01 && col.shape && !col.shape.halfExtents) {
      kind = classifyShape(col.shape); base = t.y - h.aabb.h / 2;
    }
  });
  if (kind === 'mesh') hullBuilt++; else hullFellBack++;
  if (base != null && Math.abs(base) > 0.03) hullBadBase++;
  hw.destroy();
}
check('every baked hull builds a convex-hull (mesh) collider', hullFellBack === 0, `${hullBuilt} hull / ${hullFellBack} fell back to a box`);
check('hull prop bases rest on the floor (y=0)', hullBadBase === 0, `${hullBadBase} misplaced`);

// The disguised-player path: a hull-typed disguise gives a MESH movement collider (not a capsule)
// AND a MESH shot sensor — the coordination the disguise-collider build asked the second builder for.
if (hullTypes.length) {
  const t0 = hullTypes[0];
  const h0 = hullDoc.hulls[t0];
  const cat = { [t0]: { shape: 'box', w: 1, h: 1, d: 1, hullVerts: h0.v, hullAabb: h0.aabb } };
  const dw = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [], cat, { dynamicProps: true, rules, feel });
  dw.addPlayer('p', { x: 0, y: 0, z: 0 });
  if (dw.setPlayerCollider) dw.setPlayerCollider('p', t0);
  if (dw.setShotCollider) dw.setShotCollider('p', t0);
  const body = dw.players.get('p').body;
  let move = null, sensor = null;
  for (let i = 0; i < body.numColliders(); i++) {
    const col = body.collider(i);
    const isSensor = col.isSensor ? col.isSensor() : false;
    (isSensor ? (sensor = classifyShape(col.shape)) : (move = classifyShape(col.shape)));
  }
  check(`disguised-as-hull player movement collider is a hull (${t0})`, move === 'mesh', `movement = ${move}`);
  check(`disguised-as-hull player shot sensor is a hull (${t0})`, sensor === 'mesh', `sensor = ${sensor}`);
  dw.destroy();
}

// ---- LIVE RESTAURANT COVERAGE (convex-hull round 3, 2026-07-13, VRmike) --------------------
// The task's requirement (4): confirm hull coverage is now 100% of the restaurant's collidable
// objects, that no collider exceeds its render geometry by more than an epsilon, and EXPLICITLY
// report any object still on a primitive collider and why. This builds the REAL restaurant world
// (map.fixtures -> static colliders incl. the code-built walls/columns/archway; map.props +
// knockable fixtures -> prop colliders) exactly as the game does, then walks every collider and
// compares its true Rapier shape AABB against the object's rendered geometry.
console.log('\nlive restaurant collider coverage (100% hull + no over-coverage):');
const EPS = 0.05; // 5 cm slack (authoring rounding); a real oversized box is ~0.4–0.8 m over
const maps = JSON.parse(fs.readFileSync(new URL('../shared/config/maps.json', import.meta.url), 'utf8'));
const propsCat = JSON.parse(fs.readFileSync(new URL('../shared/config/props.json', import.meta.url), 'utf8'));
const fixturesCat = JSON.parse(fs.readFileSync(new URL('../shared/config/fixtures.json', import.meta.url), 'utf8'));
// Attach baked hulls exactly as js/config.js does (mutate the catalog entries in place).
for (const [type, h] of Object.entries(hullDoc.hulls || {})) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (propsCat[type]) { propsCat[type].hullVerts = h.v; propsCat[type].hullAabb = h.aabb; }
  if (fixturesCat[type]) { fixturesCat[type].hullVerts = h.v; fixturesCat[type].hullAabb = h.aabb; }
}
const rCatalog = { ...propsCat, ...fixturesCat };
const restaurant = maps.restaurant;

// Render bounds of a catalog entry (what the player sees) — independent of the collider:
//   hulled -> the baked hull AABB (check-collider-visual proves it == the GLB / code-built box);
//   raw box -> the BoxGeometry(w,h,d) makePropMesh draws; round -> the primitive's r/h.
function renderBounds(c) {
  if (c.hullVerts && c.hullAabb && c.hullAabb.w > 0) return { w: c.hullAabb.w, h: c.hullAabb.h, d: c.hullAabb.d };
  if (c.shape === 'box') return { w: c.w, h: c.h, d: c.d };
  if (c.shape === 'cylinder' || c.shape === 'cone') return { w: 2 * c.r, h: c.h, d: 2 * c.r };
  if (c.shape === 'sphere') return { w: 2 * c.r, h: 2 * c.r, d: 2 * c.r };
  return null;
}
// A collider's LOCAL (unrotated) shape AABB, straight from the Rapier shape.
function shapeAabb(s) {
  if (!s) return null;
  if (s.halfExtents) return { w: 2 * s.halfExtents.x, h: 2 * s.halfExtents.y, d: 2 * s.halfExtents.z };
  if (s.vertices) {
    const v = s.vertices; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) { const val = v[i + a]; if (val < mn[a]) mn[a] = val; if (val > mx[a]) mx[a] = val; }
    return { w: mx[0] - mn[0], h: mx[1] - mn[1], d: mx[2] - mn[2] };
  }
  if (s.radius != null && s.halfHeight != null) return { w: 2 * s.radius, h: 2 * s.halfHeight, d: 2 * s.radius };
  if (s.radius != null) return { w: 2 * s.radius, h: 2 * s.radius, d: 2 * s.radius };
  return null;
}

// Build the world the exact way the referee does: static fixtures via _buildStatic, and every
// non-static fixture + disguise prop as a prop body.
const rProps = [];
let rid = 1;
for (const f of restaurant.fixtures || []) rProps.push({ id: rid++, type: f.type, x: f.x, z: f.z, y: f.y || 0, rot: f.rot || 0 });
for (const p of restaurant.props || []) rProps.push({ id: rid++, type: p.type, x: p.x, z: p.z, y: p.y || 0, rot: p.rot || 0 });
const rWorld = new PhysicsWorld(RAPIER, restaurant, rProps, rCatalog, { dynamicProps: true, rules, feel });

// Walk every collider, key it back to its catalog type, and record shape + AABB (dedup by type).
const byType = new Map(); // type -> { kind, colAabb, isStatic }
rWorld.world.forEachCollider((col) => {
  let type = rWorld._staticFixtureTypeByHandle && rWorld._staticFixtureTypeByHandle.get(col.handle);
  let isStatic = !!type;
  if (!type && rWorld._propHandleToId) {
    const id = rWorld._propHandleToId.get(col.handle);
    if (id != null) { const inst = rProps.find((p) => p.id === id); type = inst && inst.type; }
  }
  if (!type || byType.has(type)) return; // ground slab / boundary walls are untyped; one per type
  byType.set(type, { kind: classifyShape(col.shape), colAabb: shapeAabb(col.shape), isStatic });
});

let hulledCount = 0, primitiveExceptions = 0, overCoverage = 0, uncovered = 0;
const collidableTypes = [...byType.keys()].sort();
for (const type of collidableTypes) {
  const rec = byType.get(type);
  const c = rCatalog[type];
  const hulled = !!(c && c.hullVerts && c.hullAabb);
  const rb = renderBounds(c);
  if (rec.kind === 'mesh' && hulled) {
    hulledCount++;
    // Over-coverage: the live hull's AABB must not exceed the render bounds by more than EPS.
    const over = rb ? Math.max(rec.colAabb.w - rb.w, rec.colAabb.h - rb.h, rec.colAabb.d - rb.d) : 0;
    if (over > EPS) {
      overCoverage++;
      check(`${type} hull hugs render geometry (over ≤ ${EPS}m)`, false,
        `OVER by ${over.toFixed(2)}m — collider ${rec.colAabb.w.toFixed(2)}×${rec.colAabb.h.toFixed(2)}×${rec.colAabb.d.toFixed(2)} vs render ${rb.w.toFixed(2)}×${rb.h.toFixed(2)}×${rb.d.toFixed(2)}`);
    }
  } else if (c && c.floor) {
    primitiveExceptions++;
    console.log(`  · ${type} — PRIMITIVE by design: floor piece uses a thick-DOWNWARD anti-tunnel slab (visible top flush); the extension is below the floor, not an over-coverage.`);
  } else if (rec.kind === 'cylinder' || rec.kind === 'cone' || rec.kind === 'ball') {
    primitiveExceptions++;
    console.log(`  · ${type} — PRIMITIVE by design: round ${rec.kind} — a true ${rec.kind} collider hugs the drawn mesh tighter than a faceted hull (round rule).`);
  } else {
    // A box-shaped collidable that is NOT a hull is the exact regression this task forbids.
    uncovered++;
    check(`${type} is a convex-hull (mesh) collider, not an oversized primitive`, false,
      `on a ${rec.kind} collider${hulled ? ' despite a baked hull (thickening/override?)' : ' with no baked hull'}`);
  }
}
check('every collidable object is a hull OR a documented primitive exception (floor/round)', uncovered === 0,
  `${hulledCount} hulled, ${primitiveExceptions} documented exception(s), ${uncovered} unexpected primitive(s)`);
check('no hull over-covers its render geometry by more than a hair', overCoverage === 0,
  overCoverage ? `${overCoverage} oversized` : `all ${hulledCount} hulls within ${EPS}m`);
console.log(`  coverage: ${hulledCount}/${hulledCount + uncovered} box-collidable types on hulls; exceptions: ${primitiveExceptions} (floor + round primitives, by design).`);
rWorld.destroy();

if (failures) {
  console.error(`\ntrue-collider check FAILED (${failures} problem${failures > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ntrue-collider check passed');
