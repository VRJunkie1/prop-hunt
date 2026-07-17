#!/usr/bin/env node
// tools/check-settle.mjs — HEADLESS "SETTLE TEST" (VRmike attempt #3, 2026-07-16). The offline
// gate that would have caught the failure mode attempts #1 and #2 risked: now that EVERYTHING that
// isn't a wall/door/vent is a real dynamic rigid body, a fixture that spawns buried in the floor —
// or with a collider whose centre of mass is off its base — will JITTER, LAUNCH itself out of the
// world, or TIP OVER the instant the sim wakes. This test stands up the REAL shared/physics.js
// PhysicsWorld with the REAL restaurant map (every fixture promoted exactly as referee.startMatch
// does), steps it forward with NO players, and asserts that at rest:
//   - nothing LAUNCHES (gains height on its own — the buried-body-ejects-itself bug),
//   - nothing SINKS through its floor,
//   - nothing DRIFTS horizontally on its own (a body wedged in geometry slides away),
//   - nothing TIPS OVER unprompted (a mis-seated tall body topples), and
//   - the map SETTLES: nearly every body is asleep within a few seconds (phone-budget health —
//     a map that never sleeps burns battery and frame budget forever).
//
// AUTHORING-ONLY, never shipped. Needs a local dev Rapier (same as check-physics-live):
//     npm i --no-save @dimforge/rapier3d-compat@0.14.0
//     node tools/check-settle.mjs
// Prints SKIP + exit 3 if Rapier is absent (never fails a build it can't run).

let RAPIER;
try {
  RAPIER = (await import('@dimforge/rapier3d-compat')).default;
} catch {
  console.log('SKIP: @dimforge/rapier3d-compat not installed. Run: npm i --no-save @dimforge/rapier3d-compat@0.14.0');
  process.exit(3);
}
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { PhysicsWorld, isArchEntry, isStaticEntry, isDisguisableEntry } = await import('../shared/physics.js');
const { groundMapData } = await import('../shared/grounding.js');

await RAPIER.init();
const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json');
const feel = cfg('physics-feel.json');
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const assetDims = cfg('asset-dims.json');
let hullDefs = {}; try { hullDefs = (cfg('hulls.json').hulls) || {}; } catch {}

// Attach the SAME measured + convex-hull seams js/config.js attaches, so the collider shapes/heights
// the test sees match the shipping game exactly (otherwise it'd settle against primitive fallbacks).
const dims = (assetDims && assetDims.dims) || {};
for (const [t, b] of Object.entries(dims)) {
  if (!b || !(b.w > 0 && b.h > 0 && b.d > 0)) continue;
  const m = { w: b.w, h: b.h, d: b.d };
  if (props[t]) props[t].measured = m;
  if (fixtures[t]) fixtures[t].measured = m;
}
for (const [t, h] of Object.entries(hullDefs)) {
  if (!h || !Array.isArray(h.v) || h.v.length < 12 || !h.aabb) continue;
  if (props[t]) { props[t].hullVerts = h.v; props[t].hullAabb = h.aabb; }
  if (fixtures[t]) { fixtures[t].hullVerts = h.v; fixtures[t].hullAabb = h.aabb; }
}
const catalog = { ...props, ...fixtures };

// footprint() — copy of referee's biggest-first key, so the SAME items become dynamic here.
function footprint(c) {
  if (!c) return 0;
  const m = c.measured; if (m && m.w > 0 && m.h > 0 && m.d > 0) return m.w * m.h * m.d;
  switch (c.shape) {
    case 'box': return (c.w || 1) * (c.h || 1) * (c.d || 1);
    case 'cylinder': case 'cone': return Math.PI * (c.r || 0.5) * (c.r || 0.5) * (c.h || 1);
    case 'sphere': return (4 / 3) * Math.PI * Math.pow(c.r || 0.5, 3);
    default: return 0.5;
  }
}

// Promote a map exactly as referee.startMatch (global biggest-first), but with NO hide-spot removal
// — the WORST case (most bodies, densest packing) a phone/host ever faces at match start.
const pinY = rules.pinClutterAboveY != null ? rules.pinClutterAboveY : 0.5;
function promote(map) {
  let id = 1;
  const mk = (o) => ({ id: id++, type: o.type, x: o.x, z: o.z, y: o.y || 0, rot: o.rot || 0, pinned: (o.y || 0) > pinY });
  const disguiseProps = (map.props || []).map(mk);
  const nonArch = (map.fixtures || []).filter((f) => { const c = catalog[f.type]; return c && !isArchEntry(c); });
  const dynFixtures = nonArch.filter((f) => !isStaticEntry(catalog[f.type])).map(mk);
  const staticFixtures = nonArch.filter((f) => isStaticEntry(catalog[f.type])).map(mk);
  const dynamicCandidates = [...disguiseProps, ...dynFixtures].sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]));
  return [...dynamicCandidates, ...staticFixtures];
}

const H = 1 / 60;
let failures = 0;
const check = (ok, name, detail) => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
// up.y of a body's local up-axis after its rotation quat — 1 = perfectly upright, drops as it tips.
// Pure yaw (spawn facing) leaves this at 1, so only real pitch/roll (tipping) is flagged.
const upY = (q) => 1 - 2 * (q.x * q.x + q.z * q.z);

// Tolerances. A well-seated body spawns SPAWN_EPS (0.02 m) above rest, drops onto its support and
// sleeps — net motion should be a couple cm. These bands catch a real launch/sink/skitter/topple
// while tolerating normal settle + a body resting on another that settles under it.
const LAUNCH_NET = 0.15;   // net height GAINED over spawn (a body must never rise on its own)
const LAUNCH_PEAK = 0.6;   // peak transient rise (catches launch-then-fall-back)
const SINK_NET = 0.25;     // net height LOST (settling is cm; this catches falling through a floor)
const DRIFT = 0.35;        // horizontal wander with no player touching it
const TIP_MIN_UPY = Math.cos((25 * Math.PI) / 180); // ~0.906 — more than 25° of tilt = tipped
const SLEEP_FRAC = 0.9;    // fraction of dynamic bodies that must be asleep by the end

console.log('settle test — full restaurant map, no players, everything dynamic\n');

const map = JSON.parse(JSON.stringify(maps.restaurant));
const changed = groundMapData(map, catalog); // matches js/config.js load; should be a NO-OP (data is pre-seated)
check(changed.length === 0, 'authored map is already grounded (load-time pass is a no-op)', changed.length ? `pass moved ${changed.length} piece(s): ${changed.slice(0, 4).map((c) => c.type).join(', ')}` : 'nothing to move');

const propInstances = promote(map);
const world = new PhysicsWorld(RAPIER, map, propInstances, catalog, { dynamicProps: true, rules, feel });
const bodies = world.propBodies; // only the REAL dynamic bodies (past-cap overflow is static, not here)
const typeById = new Map(propInstances.map((p) => [p.id, p.type]));
check(bodies.length > 0, `built ${bodies.length} dynamic bodies (of ${propInstances.length} promoted; cap ${rules.maxDynamicProps})`, `dynamic=${bodies.length}`);

// Spawn snapshot.
const spawn = new Map();
for (const b of bodies) { const t = b.body.translation(); spawn.set(b.id, { x: t.x, y: t.y, z: t.z }); }
const peakRise = new Map(bodies.map((b) => [b.id, 0]));

// Step 6 s (nobody touching anything). Track peak transient rise each step.
const STEPS = 360;
for (let i = 0; i < STEPS; i++) {
  world.step(H);
  for (const b of bodies) {
    const t = b.body.translation();
    const rise = t.y - spawn.get(b.id).y;
    if (rise > peakRise.get(b.id)) peakRise.set(b.id, rise);
  }
}

// Assess each body's final state.
let launched = [], sank = [], drifted = [], tipped = [], asleep = 0;
for (const b of bodies) {
  const s = spawn.get(b.id);
  const t = b.body.translation();
  const q = b.body.rotation();
  const netY = t.y - s.y;
  const horiz = Math.hypot(t.x - s.x, t.z - s.z);
  const label = `${typeById.get(b.id)}@(${s.x.toFixed(1)},${s.z.toFixed(1)})`;
  if (netY > LAUNCH_NET || peakRise.get(b.id) > LAUNCH_PEAK) launched.push(`${label} +${Math.max(netY, peakRise.get(b.id)).toFixed(2)}m`);
  if (netY < -SINK_NET) sank.push(`${label} ${netY.toFixed(2)}m`);
  if (horiz > DRIFT) drifted.push(`${label} ${horiz.toFixed(2)}m`);
  if (upY(q) < TIP_MIN_UPY) tipped.push(`${label} up=${upY(q).toFixed(2)}`);
  if (b.body.isSleeping()) asleep++;
}

check(launched.length === 0, `nothing launches out of the floor/world`, launched.length ? `${launched.length}: ${launched.slice(0, 6).join('; ')}` : `worst peak rise ${Math.max(0, ...[...peakRise.values()]).toFixed(3)}m`);
check(sank.length === 0, `nothing sinks through its floor`, sank.length ? `${sank.length}: ${sank.slice(0, 6).join('; ')}` : 'all bodies held their height');
check(drifted.length === 0, `nothing skitters away untouched`, drifted.length ? `${drifted.length}: ${drifted.slice(0, 6).join('; ')}` : 'all bodies stayed put');
check(tipped.length === 0, `nothing tips over unprompted`, tipped.length ? `${tipped.length}: ${tipped.slice(0, 6).join('; ')}` : 'all bodies upright');
check(asleep / bodies.length >= SLEEP_FRAC, `map settles to sleep (>=${(SLEEP_FRAC * 100) | 0}% asleep in ${(STEPS * H).toFixed(0)}s)`, `${asleep}/${bodies.length} asleep (${((asleep / bodies.length) * 100).toFixed(0)}%)`);

world.destroy();

console.log('');
if (failures) { console.error(`settle test FAILED (${failures} problem${failures > 1 ? 's' : ''})`); process.exit(1); }
console.log('settle test passed');
