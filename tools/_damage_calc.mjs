// Scratch: tabulate hits-to-kill for every catalog entry under the CURRENT linear curve
// vs a proposed power curve, so Part-2 recalibration is chosen from data, not guessed.
import fs from 'node:fs';
import { halfExtentsFor } from '../shared/physics.js';

const props = JSON.parse(fs.readFileSync(new URL('../shared/config/props.json', import.meta.url), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(new URL('../shared/config/fixtures.json', import.meta.url), 'utf8'));
const catalog = { ...props, ...fixtures };

const base = 5, health = 100;
const smallSize = 0.72, largeSize = 2.2, smallMult = 10, largeMult = 0.34;

const entrySize = (c) => { const h = halfExtentsFor(c); return 2 * Math.max(h.hx, h.hy, h.hz); };
const linear = (s) => {
  if (s <= smallSize) return smallMult;
  if (s >= largeSize) return largeMult;
  const t = (s - smallSize) / (largeSize - smallSize);
  return smallMult + (largeMult - smallMult) * t;
};
const power = (s, p, lMult = largeMult, lSize = largeSize) => {
  if (s <= smallSize) return smallMult;
  if (s >= lSize) return lMult;
  const t = (s - smallSize) / (lSize - smallSize);
  return lMult + (smallMult - lMult) * Math.pow(1 - t, p);
};
const hits = (mult) => Math.ceil(health / (base * mult));

const rows = [];
for (const [name, c] of Object.entries(catalog)) {
  if (name.startsWith('_')) continue;
  if (!c || !c.shape) continue;
  const s = entrySize(c);
  rows.push({ name, size: s, lin: linear(s), p2: power(s, 2), p2b: power(s, 2, 0.28, 2.4) });
}
rows.sort((a, b) => a.size - b.size);
console.log('name'.padEnd(16), 'size', ' lin(hits)', ' p2(hits)', ' p2b(hits)');
for (const r of rows) {
  console.log(
    r.name.padEnd(16),
    r.size.toFixed(2),
    `${r.lin.toFixed(2)}(${hits(r.lin)})`.padStart(10),
    `${r.p2.toFixed(2)}(${hits(r.p2)})`.padStart(10),
    `${r.p2b.toFixed(2)}(${hits(r.p2b)})`.padStart(10),
  );
}
