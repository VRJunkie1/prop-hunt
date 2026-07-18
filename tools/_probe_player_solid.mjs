// Probe: does a player capsule currently block against ANOTHER player's kinematic
// collider (base capsule AND disguise-shaped)? Empirical, no assertions — just prints.
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

function run(disguiseB) {
  const w = new PhysicsWorld(RAPIER, map, [], catalog, { rules, feel, dynamicProps: true });
  // B stands still at origin; A walks straight at B along +x from x=-4.
  w.addPlayer('B', { x: 0, y: 0, z: 0 });
  w.addPlayer('A', { x: -4, y: 0, z: 0 });
  if (disguiseB) w.setPlayerCollider('B', disguiseB);
  // input: A moves toward +x. movement formula: mx is strafe, mz is forward.
  // vx = -sin*mz + cos*mx ; with yaw=0 => vx = mx. So mx=1 => +x.
  w.setPlayerInput('A', { mx: 1, mz: 0, yaw: 0, jump: false });
  w.setPlayerInput('B', { mx: 0, mz: 0, yaw: 0, jump: false });
  for (let i = 0; i < 240; i++) w.step(H);
  const a = w.getPlayer('A');
  const b = w.getPlayer('B');
  console.log(`disguiseB=${disguiseB || 'none'}: A ended x=${a.x.toFixed(3)} z=${a.z.toFixed(3)} | B x=${b.x.toFixed(3)} z=${b.z.toFixed(3)}`);
  w.destroy();
}

console.log('A walks +x into B for 4s. If blocked, A.x stays < ~ -(rA+rB). If pass-through, A.x > 0.');
run(null);          // both base capsules
run('bigtable');    // B disguised as a big table (2.4 wide) — A should stop ~1.6m away
run('burger');      // B disguised as a small burger
