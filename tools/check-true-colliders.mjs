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

if (failures) {
  console.error(`\ntrue-collider check FAILED (${failures} problem${failures > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\ntrue-collider check passed');
