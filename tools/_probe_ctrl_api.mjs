import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const map = { size: 40, fixtures: [] };
const catalog = { bigtable: { shape: 'box', w: 2.4, h: 1.0, d: 2.4 } };
const H = 1 / 60;
const w = new PhysicsWorld(RAPIER, map, [], catalog, { rules, feel, dynamicProps: true });
w.addPlayer('B', { x: 0, y: 0, z: 0 });
w.setPlayerCollider('B', 'bigtable');
w.addPlayer('A', { x: -2.2, y: 0, z: 0 });
w.setPlayerInput('A', { mx: 1, mz: 0, yaw: 0, jump: false });
const ctl = w._controller;
console.log('has numComputedCollisions:', typeof ctl.numComputedCollisions);
console.log('has computedCollision:', typeof ctl.computedCollision);
// Step a few, then inspect A's collisions after a manual compute.
for (let i = 0; i < 60; i++) w.step(H);
// Manual compute for A against world to read collisions.
const A = w.players.get('A');
w._controller.computeColliderMovement(A.collider, { x: 0.1, y: -0.02, z: 0 }, w._moveFilter);
const n = ctl.numComputedCollisions ? ctl.numComputedCollisions() : -1;
console.log('A numComputedCollisions after pressing into table:', n);
for (let i = 0; i < n; i++) {
  const c = ctl.computedCollision(i);
  const keys = c ? Object.keys(c) : [];
  const handle = c && c.collider != null ? (c.collider.handle != null ? c.collider.handle : c.collider) : 'n/a';
  console.log(`  collision[${i}] keys=${JSON.stringify(keys)} colliderHandle=${handle} normal1=${c && c.normal1 ? JSON.stringify(c.normal1) : 'n/a'}`);
}
const B = w.players.get('B');
console.log('B collider handle:', B.collider.handle, ' A collider handle:', A.collider.handle);
w.destroy();
