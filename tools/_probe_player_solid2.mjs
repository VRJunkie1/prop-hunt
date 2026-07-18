import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const map = { size: 40, fixtures: [] };
const catalog = {
  bigtable: { shape: 'box', w: 2.4, h: 1.0, d: 2.4 },
  burger: { shape: 'cylinder', r: 0.35, h: 0.3 },
};
const H = 1 / 60;

// Scenario helper. moverDisguise/targetDisguise null = base capsule. If realProp, place
// a real dynamic prop at origin instead of player B.
function run(label, { moverDisguise = null, targetDisguise = null, realProp = null, steps = 240 } = {}) {
  const props = realProp ? [{ id: 'P', type: realProp, x: 0, z: 0, y: 0, rot: 0 }] : [];
  const w = new PhysicsWorld(RAPIER, map, props, catalog, { rules, feel, dynamicProps: true });
  w.addPlayer('A', { x: -4, y: 0, z: 0 });
  if (moverDisguise) w.setPlayerCollider('A', moverDisguise);
  if (!realProp) {
    w.addPlayer('B', { x: 0, y: 0, z: 0 });
    if (targetDisguise) w.setPlayerCollider('B', targetDisguise);
    w.setPlayerInput('B', { mx: 0, mz: 0, yaw: 0, jump: false });
  }
  w.setPlayerInput('A', { mx: 1, mz: 0, yaw: 0, jump: false });
  for (let i = 0; i < steps; i++) w.step(H);
  const a = w.getPlayer('A');
  let bStr = '';
  if (!realProp) { const b = w.getPlayer('B'); bStr = ` | B x=${b.x.toFixed(3)} z=${b.z.toFixed(3)}`; }
  else { const p = w.propBodies[0].body.translation(); bStr = ` | PROP x=${p.x.toFixed(3)} z=${p.z.toFixed(3)}`; }
  console.log(`${label}: A x=${a.x.toFixed(3)} z=${a.z.toFixed(3)}${bStr}`);
  w.destroy();
}

run('base->base       ', {});
run('base->bigtable   ', { targetDisguise: 'bigtable' });
run('base->burger     ', { targetDisguise: 'burger' });
run('base->REALbigtable', { realProp: 'bigtable' });
run('base->REALburger ', { realProp: 'burger' });
run('bigtable->base   ', { moverDisguise: 'bigtable' });
run('bigtable->bigtable', { moverDisguise: 'bigtable', targetDisguise: 'bigtable' });
