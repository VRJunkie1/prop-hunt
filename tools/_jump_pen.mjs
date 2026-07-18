let RAPIER; try { RAPIER = (await import('@dimforge/rapier3d-compat')).default; } catch { console.log('SKIP'); process.exit(3); }
import fs from 'node:fs';
const { PhysicsWorld } = await import('../shared/physics.js');
await RAPIER.init();
const rules = JSON.parse(fs.readFileSync(new URL('../shared/config/rules.json', import.meta.url), 'utf8'));
const feel = JSON.parse(fs.readFileSync(new URL('../shared/config/physics-feel.json', import.meta.url), 'utf8'));
const H = 1 / 60;
const catalog = { crate: { shape: 'box', w: 1.5, h: 1.0, d: 1.5 } };
for (const mx of [0, 1]) {
  const w = new PhysicsWorld(RAPIER, { size: 40, fixtures: [] }, [], catalog, { dynamicProps: true, rules, feel });
  w.addPlayer('p', { x: 0, y: 0, z: 0 });
  w.setPlayerCollider('p', 'crate');
  const p = w.players.get('p');
  console.log(`\n== crate, mx=${mx} ==  radius=${p.radius} half=${p.half} offsetY=${p.colliderOffsetY}`);
  for (let i = 0; i < 90; i++) { w.setPlayerInput('p', { mx: 0, mz: 0, yaw: 0, jump: false }); w.step(H); }
  for (let i = 0; i < 6; i++) {
    // pre-substep penetration verdict (what the failsafe sees at substep start)
    const pen = w._isPenetrating(p);
    const t = p.body.translation();
    console.log(`  before t${i}: y=${(t.y).toFixed(4)} vy=${p.vy.toFixed(3)} grounded=${p.grounded?1:0} isPenetrating=${pen} safePos.y=${p.safePos.y.toFixed(4)}`);
    w.setPlayerInput('p', { mx, mz: 0, yaw: 0, jump: true });
    w.step(H);
  }
  w.destroy();
}
