// ONE-TIME SEATING MIGRATION (throwaway, _-prefixed). VRmike attempt #3: the restaurant kitchen
// is a raised platform — every `floor_kitchen` tile's TOP is at y=0.06 — but the kitchen fixtures
// (counters/fridge/oven/…) AND the clutter resting on them were authored measured from the GROUND
// (y=0), so the whole stack sits 6 cm too low: counters' bottom faces clip into the tile, and a
// disguised player standing ON the tile floats 6 cm above the real counters.
//
// FIX: shift the WHOLE kitchen stack up by the tile height. For every non-architecture item whose
// floor surface (top of the tile beneath it) is above 0, add that height to its `y`. This raises a
// counter's base onto the tile (bottom face = tile top) AND raises the canister resting on it by the
// same 6 cm, so the canister stays on the counter top — no cascade embedding. Items NOT over a tile
// (the dining zone, other maps) have floorUnder=0 and are left byte-identical.
//
// Minimal-diff: rewrites ONLY the `y` on the lines that need it, preserving all other formatting,
// blank-line grouping and key order in maps.json. Run once:  node tools/_seat_kitchen.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { halfExtentsFor, isArchEntry } from '../shared/physics.js';

const here = dirname(fileURLToPath(import.meta.url));
const P = (name) => join(here, '..', 'shared', 'config', name);
const readJSON = (name) => JSON.parse(readFileSync(P(name), 'utf8'));
const maps = readJSON('maps.json');
const props = readJSON('props.json');
const fixtures = readJSON('fixtures.json');
const assetDims = readJSON('asset-dims.json');
let hullDefs = {};
try { hullDefs = (readJSON('hulls.json').hulls) || {}; } catch {}
const dims = (assetDims && assetDims.dims) || {};
for (const [type, box] of Object.entries(dims)) {
  if (!box || !(box.w > 0 && box.h > 0 && box.d > 0)) continue;
  const m = { w: box.w, h: box.h, d: box.d };
  if (props[type]) props[type].measured = m;
  if (fixtures[type]) fixtures[type].measured = m;
}
for (const [type, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[type]) { props[type].hullVerts = h.v; props[type].hullAabb = h.aabb; }
  if (fixtures[type]) { fixtures[type].hullVerts = h.v; fixtures[type].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };
const round5 = (v) => Math.round(v * 1e5) / 1e5;

// Build the floor-tile list for the restaurant map and compute floorUnder for any item.
const map = maps.restaurant;
const floors = [];
for (const o of map.fixtures || []) {
  const c = catalog[o.type];
  if (!c || !c.floor) continue;
  const he = halfExtentsFor(c);
  floors.push({ x: o.x, z: o.z, hx: he.hx, hz: he.hz, top: (o.y || 0) + 2 * he.hy });
}
const floorUnder = (o) => {
  let top = 0;
  for (const s of floors) {
    if (Math.abs(o.x - s.x) > s.hx || Math.abs(o.z - s.z) > s.hz) continue;
    if (s.top > top) top = s.top;
  }
  return top;
};

// change map: `${type}|${x}|${z}` -> QUEUE of newY, consumed in array order. A queue (not a
// single value) so STACKED duplicates at the SAME (type,x,z) but DIFFERENT y (e.g. two planks
// at 0.15/0.45) each get their OWN base+floorUnder, instead of both collapsing to the last one.
const changes = new Map();
const consider = (arr) => {
  for (const o of arr || []) {
    const c = catalog[o.type];
    if (!c || isArchEntry(c)) continue; // walls/floors stay put
    const fu = floorUnder(o);
    if (fu <= 1e-9) continue;            // not over a raised tile -> unchanged
    const newY = round5((o.y || 0) + fu);
    const key = `${o.type}|${o.x}|${o.z}`;
    (changes.get(key) || changes.set(key, []).get(key)).push(newY);
  }
};
consider(map.fixtures);
consider(map.props);

// ---- rewrite maps.json text, one item-line at a time ----
const path = P('maps.json');
const src = readFileSync(path, 'utf8');
const lines = src.split('\n');
let changed = 0;
const out = lines.map((line) => {
  const trimmed = line.trim().replace(/,$/, '');
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('"type"'))) return line;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return line; }
  if (typeof obj.x !== 'number' || typeof obj.z !== 'number') return line;
  const key = `${obj.type}|${obj.x}|${obj.z}`;
  const queue = changes.get(key);
  if (!queue || !queue.length) return line;
  const newY = queue.shift(); // this physical line's own base+floorUnder (order-matched)
  if (obj.y != null && round5(obj.y) === newY) return line; // already seated
  changed++;
  if (obj.y != null) {
    // replace the existing y value in-place, preserving all other formatting
    return line.replace(/("y"\s*:\s*)-?\d+(?:\.\d+)?/, `$1${newY}`);
  }
  // insert `, "y": <newY>` right before the closing brace (matches the `... -16.5 }` style)
  return line.replace(/\s+\}(\s*,?)\s*$/, `, "y": ${newY} }$1`);
});
writeFileSync(path, out.join('\n'));

let total = 0;
const summary = {};
for (const [k, q] of changes) { const t = k.split('|')[0]; summary[t] = (summary[t] || 0) + q.length; total += q.length; }
console.log(`seated ${changed} kitchen-platform item line(s) (of ${total} items over a raised tile; each raised by its floorUnder so its base sits ON the tile)`);
for (const [t, n] of Object.entries(summary).sort()) console.log(`  ${t.padEnd(16)} x${n}`);
