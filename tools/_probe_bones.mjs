// One-off probe: do the idle/run clips animate Head + UpperArm.R (so rotateOnAxis won't accumulate)?
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cm = JSON.parse(readFileSync(join(root, 'shared', 'config', 'character-models.json'), 'utf8'));
const buf = readFileSync(join(root, 'assets', cm.hunter.model));
const chunkLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen));
const nodeName = (i) => (json.nodes[i] && json.nodes[i].name) || ('#' + i);
const want = ['Head', 'UpperArm.R', 'Wrist.R'];
for (const clipName of ['Idle_Gun_Pointing', 'Run_Shoot']) {
  const anim = (json.animations || []).find((a) => (a.name || '').endsWith(clipName));
  if (!anim) { console.log(clipName, 'NOT FOUND'); continue; }
  const targets = new Set(anim.channels.map((c) => nodeName(c.target.node)));
  console.log(`\n${anim.name}: ${anim.channels.length} channels`);
  for (const w of want) console.log(`  ${w}: ${targets.has(w) ? 'ANIMATED' : 'NOT animated'}`);
}
