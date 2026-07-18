import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const map = { size: 40, fixtures: [] };
const catalog = { bigtable: { shape: 'box', w: 2.4, h: 1.0, d: 2.4 } };
const w = new PhysicsWorld(RAPIER, map, [], catalog, { rules, feel, dynamicProps: true });
w.addPlayer('a', { x: 5, y: 0, z: -3 });
w.addPlayer('b', { x: 5, y: 0, z: -3 });
const a = w.players.get('a'), b = w.players.get('b');
const R = RAPIER;
function testHit(label) {
  const t = b.body.translation();
  const only = (col) => col.handle === a.collider.handle;
  let hit = null;
  try {
    hit = w.world.intersectionWithShape({ x: t.x, y: t.y, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Capsule(0.5, 0.4), undefined, undefined, b.collider, b.body, only);
  } catch (e) { console.log(label, 'threw', e.message); return; }
  console.log(label, 'hit=', hit ? hit.handle : null);
}
console.log('World methods:', ['updateSceneQueries', 'step', 'queryPipeline', 'bodies', 'colliders'].map(k => `${k}:${typeof w.world[k]}`).join(' '));
testHit('before any step:');
if (typeof w.world.updateSceneQueries === 'function') { w.world.updateSceneQueries(); testHit('after updateSceneQueries:'); }
w.world.step(); testHit('after step:');
w.destroy();
