#!/usr/bin/env node
// Offline acceptance check for HUNTER GRENADES (hunter tool #3, VRmike, 2026-07-17). AUTHORING-ONLY
// — never imported by the page / shipped. Run under the sandboxed node:
//
//     node tools/check-grenade.mjs
//
// WHY THIS EXISTS. The grenade is host-authoritative logic (referee.applyGrenade → _resolveGrenadeBlast)
// plus tunable config plus pure falloff math — none of which a headless page boot exercises (no peers,
// no Rapier, no THREE). So this drives the REAL shared code paths directly and asserts the OUTPUTS the
// spec names, plus source assertions for the client pieces:
//   A) CONFIG knobs exist + sane (baseDamage=0.45, fullDamageRadius=1, falloffDistance=2), authored as
//      1 + 2 (NOT an outer radius of 3), and the referee reads them.
//   B) FALLOFF math: full at 1 m, half at 2 m, ~0 at 2.99 m, 0 at 3 m+; outer = full + falloff.
//   C) PROP-PLAYER damage = base × disguise SIZE multiplier × falloff (tiny props take proportionally
//      more; falloff scales it by distance).
//   D) BACKFIRE hits ONLY non-player DECOY props (disguisable, non-architecture), FLAT base × falloff
//      (no size multiplier — a burger decoy and a table decoy cost the same); ~3 direct hits = lethal
//      WITHOUT hardcoding "3".
//   E) NO friendly fire (another hunter in radius is untouched) + NO direct self-damage (a blast with a
//      prop player but no decoys never hurts the thrower).
//   F) THE REDEMPTION RULE (ordering): a blast that KILLS a prop player leaves the thrower at FULL HP
//      even when the backfire would have been lethal; a blast that kills NOBODY applies the (lethal)
//      backfire.
//   G) HOST recomputes the blast point from the AIM ray (never trusts a client-supplied hit point).
//   H) CLIENT source assertions: tool selection (3 tools), throw wiring, explosion + screen flash.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C2S, S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';
import { isArchEntry } from '../shared/physics.js';
import {
  resolveGrenadeCfg, grenadeFalloff, grenadeOuterRadius,
  resolveDamageCfg, multiplierForDisguise,
} from '../shared/damage.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('HUNTER GRENADES: config + falloff + host-authoritative blast/redemption acceptance check');

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const catalog = { ...props, ...fixtures };
const dcfg = resolveDamageCfg(rules.damage);
const gcfg = resolveGrenadeCfg(rules.grenade);
const startHealth = rules.startHealth != null ? rules.startHealth : 100;
const baseHP = gcfg.baseDamage * startHealth; // fraction of full health -> HP (0.45 * 100 = 45)

// Shared harness: a referee with a captured mailbox per player, positions/roles set directly (like
// check-finder/check-combat) so we exercise the blast resolver without standing up a physics match.
function makeTable() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'TEST');
  ref.phase = PHASE.HUNTING;
  const inbox = new Map();
  const add = (id, role, x = 0, y = 0, z = 0, extra = {}) => {
    inbox.set(id, []);
    const p = {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      pos: { x, y, z }, yaw: 0, pitch: 0, input: { mx: 0, mz: 0, jump: false },
      send: (obj) => inbox.get(id).push(obj),
    };
    Object.assign(p, extra);
    ref.players.set(id, p);
    return p;
  };
  const events = (id, kind) => (inbox.get(id) || []).filter((m) => m.t === S2C.EVENT && m.kind === kind);
  return { ref, add, events };
}

// ---------------------------------------------------------------------------
// A) CONFIG knobs exist + sane, authored as 1 + 2 (not an outer radius of 3).
// ---------------------------------------------------------------------------
console.log('\nA) config knobs (baseDamage 0.45, fullDamageRadius 1, falloffDistance 2 — authored 1+2)');
ok(rules.grenade && typeof rules.grenade === 'object', 'rules.grenade block exists');
ok(near(rules.grenade.baseDamage, 0.45), `rules.grenade.baseDamage is 0.45 (45% of full health) — got ${rules.grenade.baseDamage}`);
ok(rules.grenade.fullDamageRadius === 1, `rules.grenade.fullDamageRadius is 1 m — got ${rules.grenade.fullDamageRadius}`);
ok(rules.grenade.falloffDistance === 2, `rules.grenade.falloffDistance is 2 m ADDED past full — got ${rules.grenade.falloffDistance}`);
ok(!('outerRadius' in rules.grenade) && !('radius' in rules.grenade),
  'the blast is authored as fullDamageRadius + falloffDistance, NOT a stored outer radius of 3');
ok(grenadeOuterRadius(gcfg) === 3, `outer radius is derived as 1 + 2 = 3 (${grenadeOuterRadius(gcfg)})`);
ok(baseHP === 45, `base damage resolves to ${baseHP} HP (0.45 × startHealth ${startHealth})`);

// ---------------------------------------------------------------------------
// B) FALLOFF math — full at 1 m, half at 2 m, ~0 at 2.99 m, 0 at 3 m+.
// ---------------------------------------------------------------------------
console.log('\nB) falloff curve (full@1m, half@2m, ~0@2.99m, 0@3m+)');
ok(grenadeFalloff(0, gcfg) === 1, 'point-blank (d=0) => full (1.0)');
ok(grenadeFalloff(1, gcfg) === 1, 'd=1 m (full-damage radius edge) => full (1.0)');
ok(near(grenadeFalloff(2, gcfg), 0.5), `d=2 m => half (0.5) — got ${grenadeFalloff(2, gcfg)}`);
ok(grenadeFalloff(2.99, gcfg) > 0 && grenadeFalloff(2.99, gcfg) < 0.02, `d=2.99 m => ~0 (${grenadeFalloff(2.99, gcfg).toFixed(4)})`);
ok(grenadeFalloff(3, gcfg) === 0, 'd=3 m (outer edge) => 0');
ok(grenadeFalloff(5, gcfg) === 0, 'd=5 m (past the edge) => 0');
// Monotonic non-increasing across the full range.
let mono = true, prev = Infinity;
for (let d = 0; d <= 3.5 + 1e-9; d += 0.1) { const f = grenadeFalloff(d, gcfg); if (f > prev + 1e-9) mono = false; prev = f; }
ok(mono, 'falloff is monotonically non-increasing as distance grows');

// ---------------------------------------------------------------------------
// C) PROP-PLAYER damage = base × size multiplier × falloff.
// ---------------------------------------------------------------------------
console.log('\nC) prop-player damage = base × disguise size multiplier × falloff');
{
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 40, 0, 0); // well outside the blast (no self-hit)
  // Three prop players AT the blast centre (full falloff), given huge HP so they SURVIVE (so we read
  // the raw per-hit damage and no kill/redemption fires): undisguised, tiny burger, big table.
  const pPlain = t.add('P0', ROLE.PROP, 0, 0, 0, { disguise: null, health: 100000 });
  const pBurger = t.add('P1', ROLE.PROP, 0, 0, 0, { disguise: 'burger', health: 100000 });
  const pTable = t.add('P2', ROLE.PROP, 0, 0, 0, { disguise: 'kitchen_table', health: 100000 });
  t.ref.props = [];
  t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });

  const dPlain = 100000 - pPlain.health;
  const dBurger = 100000 - pBurger.health;
  const dTable = 100000 - pTable.health;
  const mB = multiplierForDisguise('burger', catalog, dcfg);
  const mT = multiplierForDisguise('kitchen_table', catalog, dcfg);
  ok(near(dPlain, baseHP), `undisguised prop-player takes the flat base at point-blank (${dPlain.toFixed(1)} = ${baseHP})`);
  ok(near(dBurger, baseHP * mB), `burger prop takes base × size-mult (${dBurger.toFixed(1)} = ${(baseHP * mB).toFixed(1)})`);
  ok(near(dTable, baseHP * mT), `table prop takes base × size-mult (${dTable.toFixed(1)} = ${(baseHP * mT).toFixed(1)})`);
  ok(dBurger > dPlain && dPlain > dTable, `tiny prop takes MORE than a big one (burger ${dBurger.toFixed(1)} > plain ${dPlain.toFixed(1)} > table ${dTable.toFixed(1)})`);
  t.ref.destroy();
}
{
  // Falloff applied to a prop player: an undisguised prop 2 m away takes half.
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 40, 0, 0);
  const p = t.add('P', ROLE.PROP, 2, 0, 0, { disguise: null, health: 100000 });
  t.ref.props = [];
  t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
  ok(near(100000 - p.health, baseHP * 0.5), `a prop player 2 m away takes half base (${(100000 - p.health).toFixed(1)} = ${(baseHP * 0.5).toFixed(1)})`);
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// D) BACKFIRE: non-player decoy props only, FLAT base × falloff, no size multiplier.
// ---------------------------------------------------------------------------
console.log('\nD) backfire = non-player decoy props only, flat base × falloff');
const archType = Object.keys(fixtures).find((t) => isArchEntry(fixtures[t]));
{
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 40, 0, 0, { health: 100000 }); // huge HP so backfire never kills here
  // No prop PLAYERS (so nobody dies -> the backfire actually lands). A spread of DECOY prop instances:
  t.ref.props = [
    { id: 1, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },        // full  -> +base
    { id: 2, type: 'kitchen_table', disguisable: true, x: 2, y: 0, z: 0 }, // 2 m   -> +base×0.5 (FLAT: size ignored)
    { id: 3, type: 'crate', disguisable: false, x: 0, y: 0, z: 0 },        // non-decoy -> 0
    { id: 4, type: 'burger', disguisable: true, x: 3.5, y: 0, z: 0 },      // beyond outer -> 0
  ];
  if (archType) t.ref.props.push({ id: 5, type: archType, disguisable: true, x: 0, y: 0, z: 0 }); // architecture -> 0
  t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
  const took = 100000 - H.health;
  const expected = baseHP * 1 + baseHP * 0.5; // burger@0 (full) + table@2 (half); everything else 0
  ok(near(took, expected), `backfire = flat base×falloff over DECOYS only (${took.toFixed(1)} = ${expected.toFixed(1)})`);
  const gren = t.events('H', 'grenade').find(Boolean);
  ok(gren && near(gren.backfire, Math.round(took * 100) / 100), `the grenade event reports the backfire (${gren && gren.backfire})`);
  t.ref.destroy();
}
{
  // FLAT proof: a burger decoy and a table decoy at the SAME distance cost the thrower the SAME, even
  // though their disguise size multipliers differ wildly (mirror of the rifle's flat wrong-guess penalty).
  const mB = multiplierForDisguise('burger', catalog, dcfg);
  const mT = multiplierForDisguise('kitchen_table', catalog, dcfg);
  ok(!near(mB, mT), `burger vs table have DIFFERENT size multipliers (${mB.toFixed(2)} vs ${mT.toFixed(2)}) — so an equal backfire is meaningful`);
  const one = (type) => {
    const t = makeTable();
    const H = t.add('H', ROLE.HUNTER, 40, 0, 0, { health: 100000 });
    t.ref.props = [{ id: 1, type, disguisable: true, x: 0, y: 0, z: 0 }];
    t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
    const d = 100000 - H.health; t.ref.destroy(); return d;
  };
  ok(near(one('burger'), one('kitchen_table')) && near(one('burger'), baseHP),
    `a burger decoy and a table decoy each cost the SAME flat base (${one('burger').toFixed(1)}) — no size scaling on backfire`);
}

// ---------------------------------------------------------------------------
// E) NO friendly fire + NO direct self-damage.
// ---------------------------------------------------------------------------
console.log('\nE) no friendly fire (other hunters) + no direct self-damage (no decoys)');
{
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 0, 0, 0, { health: 100000 });   // thrower AT the blast centre
  const H2 = t.add('H2', ROLE.HUNTER, 0, 0, 0, { health: 100000 }); // another hunter AT the centre
  const P = t.add('P', ROLE.PROP, 0, 0, 0, { disguise: null, health: 100000 }); // a prop that survives
  t.ref.props = []; // NO decoy props -> no backfire
  t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
  ok(H2.health === 100000, 'another hunter inside the blast takes NO damage (no friendly fire)');
  ok(H.health === 100000, 'the thrower takes NO direct self-damage from the blast (only backfire off decoys can reach them)');
  ok(100000 - P.health > 0, 'the prop player inside the blast still took damage (sanity: the blast did fire)');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// F) THE REDEMPTION RULE (ordering).
// ---------------------------------------------------------------------------
console.log('\nF) redemption ordering (kill => full HP even vs lethal backfire; no kill => lethal backfire)');
{
  // KILL case: a prop player dies AND the decoys would deal lethal backfire — the thrower is REDEEMED
  // to full HP, never takes the backfire, and stays alive.
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 40, 0, 0, { health: 10 }); // nearly dead
  const P = t.add('P', ROLE.PROP, 0, 0, 0, { disguise: null, health: 20 }); // dies to base 45
  // Three burger decoys at the centre => 3 × base = 135 backfire, comfortably lethal to a 10-HP hunter.
  t.ref.props = [
    { id: 1, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },
    { id: 2, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },
    { id: 3, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },
  ];
  t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
  ok(P.alive === false, 'the prop player was killed by the blast');
  ok(H.alive === true && H.health === startHealth, `the thrower is REDEEMED to full HP despite lethal backfire (${H.health})`);
  const gren = t.events('H', 'grenade').find(Boolean);
  ok(gren && gren.redeemed === true && gren.backfire === 0, 'the grenade event marks redeemed=true, backfire=0');
  t.ref.destroy();
}
{
  // NO-KILL case: nobody dies (no prop players in range) and the decoys deal lethal backfire — the
  // thrower dies. Proves the backfire lands when there's no redemption.
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 40, 0, 0, { health: 50 });
  t.ref.props = [
    { id: 1, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },
    { id: 2, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },
    { id: 3, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 },
  ];
  t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
  ok(H.alive === false && H.health === 0, 'with no prop kill, the lethal backfire kills the thrower');
  t.ref.destroy();
}
{
  // "~3 direct decoy hits = lethal" emerges from the math (baseHP × 3 = 135 >= 100), and 2 do NOT
  // (90 < 100) — proving the falloff/base produces ~3 WITHOUT hardcoding "3".
  const blastN = (n, hp) => {
    const t = makeTable();
    const H = t.add('H', ROLE.HUNTER, 40, 0, 0, { health: hp });
    t.ref.props = Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'burger', disguisable: true, x: 0, y: 0, z: 0 }));
    t.ref._resolveGrenadeBlast(H, { x: 0, y: 0, z: 0 });
    const dead = H.alive === false; t.ref.destroy(); return dead;
  };
  ok(!blastN(2, startHealth), '2 direct decoy hits do NOT kill a full-health hunter (90 < 100)');
  ok(blastN(3, startHealth), '3 direct decoy hits DO kill a full-health hunter (135 >= 100) — ~3 = lethal, not hardcoded');
}

// ---------------------------------------------------------------------------
// G) HOST recomputes the blast point from the AIM ray (never a client hit point).
// ---------------------------------------------------------------------------
console.log('\nG) host recomputes the blast centre from aim (ignores any client-supplied hit point)');
{
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 40, 0, 0, { health: 100000 });
  const P = t.add('P', ROLE.PROP, 0, 0, 0, { disguise: null, health: 100000 });
  t.ref.props = [];
  // Stub the physics raycast so the HOST computes a blast at the origin, regardless of what the client
  // claims. The client message carries bogus hit coordinates (x/y/z/ix = 999) that MUST be ignored.
  t.ref.physics = { raycastShot: () => ({ point: { x: 0, y: 0, z: 0 } }), destroy: () => {} };
  t.ref.applyGrenade(H, { t: C2S.GRENADE, dx: 0, dy: 0, dz: -1, x: 999, y: 999, z: 999, ix: 999 });
  ok(100000 - P.health > 0, 'the prop at the host-raycast blast centre took damage — the client hit point was ignored');
  const gren = t.events('H', 'grenade').find(Boolean);
  ok(gren && gren.x === 0 && gren.y === 0 && gren.z === 0, `the broadcast blast centre is the host raycast point (${gren && gren.x},${gren && gren.y},${gren && gren.z}), not the client's 999s`);
  t.ref.destroy();
}
{
  // Validation: a prop, a dead hunter, or the wrong phase => the grenade is ignored (no blast event).
  const t = makeTable();
  const H = t.add('H', ROLE.HUNTER, 0, 0, 0);
  const P = t.add('P', ROLE.PROP, 0, 0, 0);
  t.ref.props = [];
  t.ref.physics = { raycastShot: () => ({ point: { x: 0, y: 0, z: 0 } }), destroy: () => {} };
  t.ref.applyGrenade(P, { dx: 0, dy: 0, dz: -1 });
  ok(t.events('H', 'grenade').length === 0 && t.events('P', 'grenade').length === 0, "a prop's GRENADE is ignored (hunters only)");
  H.alive = false;
  t.ref.applyGrenade(H, { dx: 0, dy: 0, dz: -1 });
  ok(t.events('H', 'grenade').length === 0, "a dead hunter's GRENADE is ignored");
  H.alive = true;
  for (const ph of [PHASE.HIDING, PHASE.LOBBY, PHASE.ENDING]) {
    t.ref.phase = ph;
    t.ref.applyGrenade(H, { dx: 0, dy: 0, dz: -1 });
  }
  ok(t.events('H', 'grenade').length === 0, 'GRENADE is ignored outside the HUNTING phase');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// H) CLIENT + shared source assertions.
// ---------------------------------------------------------------------------
console.log('\nH) source: tool selection (3 tools), throw wiring, explosion + screen flash');
{
  const proto = readText('shared', 'protocol.js');
  ok(/GRENADE:\s*'grenade'/.test(proto), 'protocol.js defines C2S.GRENADE');

  const ref = readText('shared', 'referee.js');
  ok(ref.includes('applyGrenade') && ref.includes('_resolveGrenadeBlast'), 'referee.js provides applyGrenade + _resolveGrenadeBlast');
  ok(/resolveGrenadeCfg|grenadeFalloff|grenadeOuterRadius/.test(ref), 'referee reads the grenade config + falloff via the shared helpers');
  ok(ref.includes('raycastShot') && !/msg\.(ix|point)\b/.test(ref.slice(ref.indexOf('applyGrenade'), ref.indexOf('_resolveGrenadeBlast'))),
    'applyGrenade computes the blast via raycastShot and never reads a client hit point');

  const main = readText('js', 'main.js');
  ok(/id:\s*'grenade'/.test(main), 'main.js HUNTER_TOOLS includes the grenade as a selectable tool');
  ok((main.match(/id:\s*'(rifle|finder|grenade)'/g) || []).length === 3, 'the hunter tool bar has THREE tools (rifle, finder, grenade)');
  ok(main.includes('tryGrenade'), 'main.js has tryGrenade');
  ok(main.includes('C2S.GRENADE'), 'main.js sends C2S.GRENADE (aim direction only)');
  ok(/state\.tool === 'grenade'/.test(main), 'tryFire routes to the grenade when it is the selected tool (PC left-click / mobile fire button)');
  ok(/case 'grenade'/.test(main), "main.js handles the 'grenade' explosion event");
  ok(main.includes('scene.spawnExplosion') || main.includes('spawnExplosion'), 'main.js spawns the explosion on the grenade event');

  const scene = readText('js', 'scene.js');
  ok(scene.includes('spawnExplosion'), 'scene.js provides spawnExplosion (the 3D blast)');
  ok(scene.includes('blastFlashAt'), 'scene.js provides blastFlashAt (screen-flash intensity by distance)');
  ok(/toolId === 'grenade'/.test(scene), 'scene.js builds a grenade first-person viewmodel');

  const ui = readText('js', 'ui.js');
  ok(ui.includes('flashScreen'), 'ui.js provides flashScreen (the on-screen explosion flash)');

  const css = readText('css', 'style.css');
  ok(/blast-flash/.test(css), 'css styles the blast flash overlay');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll hunter-grenade checks passed.');
process.exit(fails ? 1 : 0);
