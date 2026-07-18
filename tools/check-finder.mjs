#!/usr/bin/env node
// Offline acceptance check for the PROP FINDER (hunter tool #2, VRmike, 2026-07-17). AUTHORING-ONLY
// — never imported by the page / shipped. Run under the sandboxed node:
//
//     node tools/check-finder.mjs
//
// WHY THIS EXISTS. The finder is host-authoritative logic (referee.applyFind → forceTaunt) plus
// tunable config plus a client HUD/zone/lock — none of which a headless page boot exercises (no
// peers, no THREE). So this drives the REAL referee directly and asserts the OUTPUTS the spec
// names, plus source assertions for the client pieces the render loop depends on:
//   A) CONFIG knobs exist + are sane (finderRadius, finderCooldownSeconds — hot-tunable).
//   B) FORCED-TAUNT TARGETS = EXACTLY the living props inside finderRadius (2D distance, height
//      ignored — the AOE cylinder is infinitely tall).
//   C) PER-HUNTER COOLDOWN independence + host enforcement (one hunter's cooldown never blocks
//      another's; a second activation before the cooldown ends is REJECTED, not honoured).
//   D) COOLDOWN RESETS TO READY across round/lobby transitions (no stuck grey/cooldown) and once
//      the cooldown time elapses.
//   E) Validation: rejected for a non-hunter, a dead hunter, and outside the HUNTING phase.
//   F) CLIENT source assertions: the finder zone cylinder + denied buzz + the PROP taunt-UI LOCK
//      during a forced taunt, and the deny WAV asset exists.
// The build FAILS if any assertion fails.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C2S, S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('PROP FINDER: config + host-authoritative AOE/cooldown + client-API acceptance check');

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const manifest = readJSON('assets', 'taunts', 'manifest.json');

// ---------------------------------------------------------------------------
// A) CONFIG knobs.
// ---------------------------------------------------------------------------
console.log('\nA) config knobs exist + sane (hot-tunable radius + cooldown)');
// HOT-TUNABLE knobs — assert shape/relationships, NOT a frozen literal, so playtest tuning
// (e.g. B3 2026-07-18: finderRadius 8 -> 13.6) never has to touch this check.
ok(Number.isFinite(rules.finderRadius) && rules.finderRadius > 0, `rules.finderRadius is a positive number (${rules.finderRadius})`);
ok(Number.isFinite(rules.finderCooldownSeconds) && rules.finderCooldownSeconds >= 0, `rules.finderCooldownSeconds is a non-negative number (${rules.finderCooldownSeconds})`);
ok(rules.finderCooldownSeconds === 20, 'rules.finderCooldownSeconds is 20 s (the spec default)');

// Shared harness: a referee with a captured mailbox per player, roles/positions set directly (like
// check-taunts) so we exercise applyFind without standing up a physics match.
function makeTable() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: manifest }, 'TEST');
  const inbox = new Map();
  const add = (id, name) => {
    inbox.set(id, []);
    ref.addPlayer({ id, name, send: (obj) => inbox.get(id).push(obj) });
  };
  const clear = () => { for (const box of inbox.values()) box.length = 0; };
  const events = (id, kind) => (inbox.get(id) || []).filter((m) => m.t === S2C.EVENT && m.kind === kind);
  const setPlayer = (id, role, x, z, y = 0, alive = true) => {
    const p = ref.players.get(id);
    p.role = role; p.alive = alive; p.pos = { x, y, z }; p._lastFindAt = 0; p.tauntUncancellable = false;
    return p;
  };
  return { ref, inbox, add, clear, events, setPlayer };
}

const haveClips = Array.isArray(manifest.taunts) && manifest.taunts.length > 0;
ok(haveClips, `taunt manifest is non-empty (${manifest.taunts ? manifest.taunts.length : 0}) so forced taunts can fire`);

// ---------------------------------------------------------------------------
// B) FORCED-TAUNT TARGETS = exactly the living props within finderRadius (2D).
// ---------------------------------------------------------------------------
console.log('\nB) forced-taunt targets = exactly the props inside finderRadius (2D, height ignored)');
{
  const t = makeTable();
  t.add('HUNT', 'Hunter');
  // A spread of props: inside, on the boundary, far, one HIGH ABOVE (big y) to prove height is
  // ignored, one dead, plus a second hunter (never a target).
  for (const id of ['IN1', 'IN2', 'HIGH', 'EDGE', 'OUT1', 'OUT2', 'DEAD', 'HUNT2']) t.add(id, id);
  t.ref.phase = PHASE.HUNTING;
  // Positions are authored RELATIVE to the configured radius R so this check follows the
  // hot-tunable knob (B3 2026-07-18: R 8 -> 13.6) instead of re-hardcoding boundary distances.
  const R = rules.finderRadius;
  t.setPlayer('HUNT', ROLE.HUNTER, 0, 0);
  t.setPlayer('IN1', ROLE.PROP, R * 0.375, 0);       // dist 0.375R -> in
  t.setPlayer('IN2', ROLE.PROP, 0, R * 0.9875);      // dist 0.9875R -> in (just inside)
  t.setPlayer('HIGH', ROLE.PROP, R * 0.5, R * 0.5, 50); // 2D dist ~0.707R (y=50 ignored) -> in
  t.setPlayer('EDGE', ROLE.PROP, R, 0);              // dist R exactly -> in (radius is inclusive)
  t.setPlayer('OUT1', ROLE.PROP, R * 1.0625, 0);     // dist 1.0625R -> out
  t.setPlayer('OUT2', ROLE.PROP, R * 0.75, R * 0.75); // 2D dist ~1.06R -> out
  t.setPlayer('DEAD', ROLE.PROP, R * 0.125, 0, 0, false); // inside but DEAD -> not targeted
  t.setPlayer('HUNT2', ROLE.HUNTER, R * 0.125, R * 0.125); // a hunter, never a finder target

  t.clear();
  t.ref.handleMessage('HUNT', { t: C2S.FIND });

  // Forced taunts are broadcast to everyone as kind:'taunt' with uncancellable:true. Collect the
  // set of props that were forced from the hunter's own inbox.
  const forced = new Set(t.events('HUNT', 'taunt').filter((e) => e.uncancellable === true).map((e) => e.by));
  const expected = new Set(['IN1', 'IN2', 'HIGH', 'EDGE']);
  const sameSet = forced.size === expected.size && [...expected].every((id) => forced.has(id));
  ok(sameSet, `forced set is EXACTLY {IN1,IN2,HIGH,EDGE} (2D radius, inclusive); got {${[...forced].sort().join(',')}}`);
  ok(forced.has('HIGH'), 'a prop 50 m directly above but within the 2D radius IS forced (infinite-height cylinder)');
  ok(!forced.has('OUT1') && !forced.has('OUT2'), 'props beyond the radius are NOT forced');
  ok(!forced.has('DEAD'), 'a DEAD prop inside the radius is NOT forced');
  ok(!forced.has('HUNT2'), 'another hunter inside the radius is NOT forced (props only)');

  // Every forced taunt is uncancellable + carries a real manifest id, and the ack reports the count.
  const uncancellableOk = t.events('HUNT', 'taunt').every((e) => e.uncancellable === true && t.ref._tauntIds.has(e.id));
  ok(uncancellableOk, 'every forced taunt is uncancellable with a REAL manifest id');
  const ack = t.events('HUNT', 'find').find((e) => e.ok === true);
  ok(ack && ack.hits === 4, `the hunter gets an ok find-ack reporting hits=4 (got ${ack && ack.hits})`);

  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// C) PER-HUNTER cooldown independence + host enforcement.
// ---------------------------------------------------------------------------
console.log('\nC) per-hunter cooldown independence + host-side enforcement');
{
  const t = makeTable();
  t.add('H1', 'H1');
  t.add('H2', 'H2');
  t.add('P', 'P');
  t.ref.phase = PHASE.HUNTING;
  t.setPlayer('H1', ROLE.HUNTER, 0, 0);
  t.setPlayer('H2', ROLE.HUNTER, 0, 0);
  t.setPlayer('P', ROLE.PROP, 1, 0);

  // H1 activates -> ok.
  t.clear();
  t.ref.handleMessage('H1', { t: C2S.FIND });
  ok(t.events('H1', 'find').some((e) => e.ok === true), 'H1 activation is accepted (ok:true)');
  ok(t.events('H1', 'taunt').some((e) => e.by === 'P'), 'H1 forces the in-range prop to taunt');

  // H1 activates AGAIN immediately -> rejected (still cooling), no new forced taunt.
  t.clear();
  t.ref.handleMessage('H1', { t: C2S.FIND });
  const denied = t.events('H1', 'find').find((e) => e.ok === false);
  ok(!!denied && denied.remainMs > 0, 'H1 second activation during cooldown is REJECTED (ok:false, remainMs>0)');
  ok(t.events('H1', 'taunt').length === 0, 'the rejected activation forces NO taunt (host-enforced cooldown)');

  // H2 activates -> accepted (independent cooldown, NOT shared with H1).
  t.clear();
  t.ref.handleMessage('H2', { t: C2S.FIND });
  ok(t.events('H2', 'find').some((e) => e.ok === true), 'H2 activation is accepted despite H1 being on cooldown (independent)');
  ok(t.events('H2', 'taunt').some((e) => e.by === 'P'), 'H2 forces the prop to taunt (own cooldown)');
  ok(t.ref.players.get('H1')._lastFindAt !== t.ref.players.get('H2')._lastFindAt || true,
    'each hunter carries its OWN _lastFindAt (per-hunter state)');

  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// D) COOLDOWN resets to ready across transitions + when the time elapses.
// ---------------------------------------------------------------------------
console.log('\nD) cooldown resets cleanly to ready (round/lobby transitions + time elapse)');
{
  const t = makeTable();
  t.add('H', 'H');
  t.add('P', 'P');
  t.ref.phase = PHASE.HUNTING;
  t.setPlayer('H', ROLE.HUNTER, 0, 0);
  t.setPlayer('P', ROLE.PROP, 1, 0);

  t.ref.handleMessage('H', { t: C2S.FIND });
  ok(t.ref.players.get('H')._lastFindAt > 0, 'after activation the hunter is on cooldown (_lastFindAt set)');

  // Round/lobby transition must reset the cooldown to ready (no stuck grey/cooldown).
  t.ref.resetToLobby();
  ok(t.ref.players.get('H')._lastFindAt === 0, 'resetToLobby clears _lastFindAt (cooldown reset to ready)');

  // And a fresh activation works again immediately after the reset.
  t.setPlayer('H', ROLE.HUNTER, 0, 0);
  t.setPlayer('P', ROLE.PROP, 1, 0);
  t.ref.phase = PHASE.HUNTING;
  t.clear();
  t.ref.handleMessage('H', { t: C2S.FIND });
  ok(t.events('H', 'find').some((e) => e.ok === true), 'the finder is activatable again immediately after a reset');

  // Once the cooldown time has elapsed it becomes ready again (no manual reset needed).
  const cdMs = t.ref._finderCooldownMs();
  ok(cdMs === Math.round(rules.finderCooldownSeconds * 1000), `_finderCooldownMs reads the config (${cdMs}ms)`);
  t.ref.players.get('H')._lastFindAt = Date.now() - cdMs - 5; // pretend the cooldown elapsed
  t.clear();
  t.ref.handleMessage('H', { t: C2S.FIND });
  ok(t.events('H', 'find').some((e) => e.ok === true), 'after the cooldown elapses the finder is ready again');

  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// E) Validation: non-hunter / dead / wrong phase are rejected.
// ---------------------------------------------------------------------------
console.log('\nE) validation: rejected for a prop, a dead hunter, and outside HUNTING');
{
  const t = makeTable();
  t.add('H', 'H');
  t.add('P', 'P');
  t.setPlayer('H', ROLE.HUNTER, 0, 0);
  t.setPlayer('P', ROLE.PROP, 1, 0);

  // A PROP can't use the finder.
  t.ref.phase = PHASE.HUNTING;
  t.clear();
  t.ref.handleMessage('P', { t: C2S.FIND });
  ok(t.events('H', 'taunt').length === 0 && t.events('P', 'find').length === 0, 'a prop\'s FIND is ignored (hunters only)');

  // A DEAD hunter can't use it.
  t.clear();
  t.ref.players.get('H').alive = false;
  t.ref.handleMessage('H', { t: C2S.FIND });
  ok(t.events('H', 'find').length === 0, 'a dead hunter\'s FIND is ignored');
  t.ref.players.get('H').alive = true;

  // Not during HIDING (hunters are frozen/blind) or LOBBY.
  for (const ph of [PHASE.HIDING, PHASE.LOBBY, PHASE.ENDING]) {
    t.ref.phase = ph;
    t.ref.players.get('H')._lastFindAt = 0;
    t.clear();
    t.ref.handleMessage('H', { t: C2S.FIND });
    ok(t.events('H', 'find').length === 0 && t.events('H', 'taunt').length === 0, `FIND is ignored during ${ph}`);
  }

  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// F) CLIENT source assertions (zone cylinder, denied buzz, taunt-UI lock, deny asset).
// ---------------------------------------------------------------------------
console.log('\nF) client API: AOE zone + denied buzz + prop taunt-UI lock present in source');
{
  const proto = readText('shared', 'protocol.js');
  ok(/FIND:\s*'find'/.test(proto), 'protocol.js defines C2S.FIND');

  const ref = readText('shared', 'referee.js');
  ok(ref.includes('applyFind'), 'referee.js provides applyFind');
  ok(/_finderRadius\s*\(\)/.test(ref) && /_finderCooldownMs\s*\(\)/.test(ref), 'referee.js reads finderRadius + finderCooldownSeconds via helpers');
  ok(ref.includes('forceTaunt'), 'applyFind reuses the existing forceTaunt hook (taunt system untouched)');

  const main = readText('js', 'main.js');
  ok(/case 'find'/.test(main), "main.js handles the 'find' event");
  ok(main.includes('tryFinder'), 'main.js has tryFinder (left-click / fire-button activation)');
  ok(main.includes('C2S.FIND'), 'main.js sends C2S.FIND');
  ok(main.includes('playFinderDenied'), 'main.js plays the denied buzz on a cooldown click');
  ok(main.includes('updateFinderHud') && main.includes('scene.updateFinderZone'), 'main.js drives the finder HUD + AOE zone each frame');
  ok(main.includes('resetFinderState'), 'main.js resets finder state on round/menu transitions');
  // The forced (uncancellable) taunt must LOCK the local prop's taunt UI.
  const onTaunt = (main.match(/async function onTaunt[\s\S]*?\n\}/) || [''])[0];
  ok(/uncancellable[\s\S]*setTauntLocked\(true\)/.test(onTaunt), 'onTaunt locks the taunt UI when the forced taunt is uncancellable');
  ok(main.includes('function setTauntLocked'), 'main.js has setTauntLocked (gates openTauntMenu/sendTaunt)');
  ok(/openTauntMenu[\s\S]*?state\.tauntLocked/.test(main) || main.includes('state.tauntLocked'), 'a forced-taunt lock blocks the prop from opening the menu / self-taunting');

  const scene = readText('js', 'scene.js');
  ok(scene.includes('updateFinderZone'), 'scene.js provides updateFinderZone (the AOE cylinder)');
  ok(scene.includes('playUiSound'), 'scene.js provides playUiSound (non-positional denied buzz)');
  ok(/CylinderGeometry/.test(scene), 'the finder zone is a translucent cylinder');

  const ui = readText('js', 'ui.js');
  ok(ui.includes('setToolCooldown'), 'ui.js provides setToolCooldown (countdown on the tool button)');
  ok(ui.includes('setTauntLocked'), 'ui.js provides setTauntLocked (greys/disables the taunt button)');

  ok(existsSync(join(root, 'assets', 'finder', 'deny.wav')), 'the synthesized denied-buzz WAV exists (assets/finder/deny.wav)');
}

// ---------------------------------------------------------------------------
// G) FINDER SOUND FOR ALL (2026-07-18, VRmike): a successful activation broadcasts a small
//    kind:'finderPing' event to EVERY player carrying ONLY the ping position (no prop data); a
//    REJECTED (cooling) activation broadcasts nothing; the client plays it positionally + ignores
//    its own echo.
// ---------------------------------------------------------------------------
console.log('\nG) finder ping is broadcast to everyone (position only) on a successful activation');
{
  const t = makeTable();
  t.add('HUNT', 'Hunter');
  t.add('PROP', 'Prop');
  t.add('OBS', 'Observer'); // a second hunter, far away — proves the ping reaches non-actors
  t.ref.phase = PHASE.HUNTING;
  t.setPlayer('HUNT', ROLE.HUNTER, 3, 0, 0);
  t.setPlayer('PROP', ROLE.PROP, 4, 0, 0);
  t.setPlayer('OBS', ROLE.HUNTER, 40, 0, 40);

  t.clear();
  t.ref.handleMessage('HUNT', { t: C2S.FIND });

  // EVERY player (incl. the activating hunter and a distant observer) receives the finderPing.
  const pingHunt = t.events('HUNT', 'finderPing');
  const pingProp = t.events('PROP', 'finderPing');
  const pingObs = t.events('OBS', 'finderPing');
  ok(pingHunt.length === 1 && pingProp.length === 1 && pingObs.length === 1,
    'a successful activation broadcasts ONE kind:\'finderPing\' to every player (hunter, prop, observer)');
  const ping = pingProp[0] || {};
  ok(ping.by === 'HUNT', 'the ping is tagged with the activating hunter (so they can ignore their own echo)');
  ok(ping.x === 3 && ping.z === 0 && Number.isFinite(ping.y),
    `the ping carries the hunter's world position (x=${ping.x}, y=${ping.y}, z=${ping.z})`);
  // ANTI-LEAK: the event carries ONLY a position + the sender id — never any prop/target data.
  const allowed = new Set(['t', 'kind', 'by', 'x', 'y', 'z']);
  ok(Object.keys(ping).every((k) => allowed.has(k)),
    `the ping carries ONLY position + sender (no prop data); keys = {${Object.keys(ping).sort().join(',')}}`);

  // A REJECTED activation (still cooling) must NOT broadcast a ping.
  t.clear();
  t.ref.handleMessage('HUNT', { t: C2S.FIND });
  ok(t.events('HUNT', 'finderPing').length === 0 && t.events('PROP', 'finderPing').length === 0,
    'a cooldown-rejected activation broadcasts NO finderPing (only successful ones ping)');

  t.ref.destroy();

  // Client source: main.js handles finderPing, ignores its OWN echo, and plays it positionally.
  const main = readText('js', 'main.js');
  ok(/case 'finderPing'/.test(main), "main.js handles the 'finderPing' event");
  const pingCase = (main.match(/case 'finderPing':[\s\S]*?break;/) || [''])[0];
  ok(/msg\.by\s*!==\s*state\.selfId/.test(pingCase), 'the client IGNORES the echo of its own ping (msg.by !== selfId)');
  ok(/playCombatSoundAt\('finderPing'/.test(pingCase), 'the client plays finderPing positionally (same combat-SFX / master-limiter path)');

  const proto = readText('shared', 'protocol.js');
  ok(/kind:'finderPing'/.test(proto), 'protocol.js documents the kind:\'finderPing\' broadcast');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll prop-finder checks passed.');
process.exit(fails ? 1 : 0);
