#!/usr/bin/env node
// tools/check-spectator.mjs — HEADLESS acceptance check for SPECTATOR MODE (B6, VRmike, 2026-07-18).
// AUTHORING-ONLY — never imported by the page or shipped to a browser. Run from a shell:
//
//     node tools/check-spectator.mjs
//
// WHY THIS EXISTS. A dead player becomes a SPECTATOR with a free-fly camera and the ability to switch
// between watching live players. But a dead teammate can still TALK to living hunters on voice, so a
// spectator watching props scatter during HIDING is the exact anti-cheat leak the hunter blindfold
// already guards. The B6 rule EXTENDS that blindfold gate from "hunter-during-HIDING" to
// "hunter-OR-dead-during-HIDING": the host withholds every prop transform from a spectator through
// HIDING and hands them the same one-time `kind:'world'` catch-up the instant HUNTING starts — while a
// LIVING hunter's roster-safe name-blanking still applies only to LIVING hunters (a dead hunter is a
// spectator and sees the full world, names included). This drives the REAL Referee snapshot dispatch
// (no Rapier needed — physics is nulled so _propsCatchup returns the authoritative prop list) and
// asserts RELATIONSHIPS, not hard-coded counts:
//   (A) a DEAD prop during HIDING receives ZERO prop transforms + zero prop-player entries (withheld),
//       while a LIVING prop the same tick still sees the world (we don't over-withhold live props);
//   (B) at HIDING→HUNTING a dead spectator gets the one-time full-world catch-up (like a hunter),
//       while a living prop does NOT (it tracked the awake stream live);
//   (C) during HUNTING a DEAD hunter gets the FULL feed (a disguised prop's NAME is visible — normal
//       spectating), while a LIVING hunter still gets the name-blanked roster-safe view (anti-cheat).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE, PHASE, S2C } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = (n) => JSON.parse(readFileSync(join(here, '..', 'shared', 'config', n), 'utf8'));
const rules = cfg('rules.json');
const maps = cfg('maps.json');
const props = cfg('props.json');
const fixtures = cfg('fixtures.json');
const feel = cfg('physics-feel.json');
const config = { rules, maps, props, fixtures, feel };

let fails = 0;
const ok = (cond, msg, detail) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg + (detail ? ' — ' + detail : ''));
  if (!cond) fails++;
};

// A Referee with NO physics: _propsCatchup returns the authoritative prop list, broadcastSnapshot reads
// awakePropTransforms directly — so the whole data gate runs pure, no Rapier.
function makeRef(phase) {
  const ref = new Referee(config, 'SPEC');
  if (ref.interval) clearInterval(ref.interval);
  ref.mapId = Object.keys(maps)[0];
  ref.physics = null;
  ref.phase = phase;
  ref.phaseEndsAt = Date.now() + 30000;
  // One authoritative prop, reported AWAKE this tick so withholding is a real (non-vacuous) test.
  ref.props = [{ id: 1, mi: 0, type: 'crate', disguisable: true, x: 2, z: 3, y: 0 }];
  ref.awakePropTransforms = [{ id: 1, x: 2, y: 0, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 }];
  return ref;
}

function addPlayer(ref, id, role, alive, cap, disguise = null) {
  const p = {
    id, name: id, role, alive, health: 100,
    pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, disguise, lastInputSeq: 0,
    send: (m) => cap.push(m),
  };
  ref.players.set(id, p);
  return p;
}
const snapOf = (cap) => cap.find((m) => m.t === S2C.SNAPSHOT);
const worldOf = (cap) => cap.find((m) => m.t === S2C.EVENT && m.kind === 'world');

console.log('spectator — real Referee snapshot dispatch: a dead spectator rides the blindfold gate\n');

// ---- (A) DEAD prop withheld during HIDING; LIVING prop the same tick still sees the world. -----------
{
  const ref = makeRef(PHASE.HIDING);
  const liveCap = [], deadCap = [], hunterCap = [];
  addPlayer(ref, 'liveProp', ROLE.PROP, true, liveCap, 'crate');
  addPlayer(ref, 'deadProp', ROLE.PROP, false, deadCap);
  addPlayer(ref, 'hunter', ROLE.HUNTER, true, hunterCap);
  ref.broadcastSnapshot();

  const live = snapOf(liveCap), dead = snapOf(deadCap), hunter = snapOf(hunterCap);
  ok(dead && dead.props.length === 0, '(A) a DEAD prop during HIDING receives ZERO prop transforms (spectator withheld)',
    dead ? `dead-spectator snapshot props: ${dead.props.length}` : 'no snapshot');
  ok(dead && dead.players.every((pl) => pl.hunter), '(A) a DEAD spectator during HIDING sees NO prop-player entries (only hunters remain)',
    dead ? `prop entries visible to spectator: ${dead.players.filter((pl) => !pl.hunter).length}` : 'no snapshot');
  ok(live && live.props.length > 0, '(A) a LIVING prop the SAME tick still receives the world (we do not over-withhold live props)',
    live ? `live-prop snapshot props: ${live.props.length}` : 'no snapshot');
  ok(hunter && hunter.props.length === 0, '(A) a blindfolded HUNTER during HIDING is still withheld (unchanged baseline)',
    hunter ? `hunter snapshot props: ${hunter.props.length}` : 'no snapshot');
}

// ---- (B) RELEASE: a dead spectator gets the one-time world catch-up at HUNTING; a live prop does not. -
{
  const ref = makeRef(PHASE.HIDING);
  const deadCap = [], liveCap = [], hunterCap = [];
  addPlayer(ref, 'deadProp', ROLE.PROP, false, deadCap);
  addPlayer(ref, 'liveProp', ROLE.PROP, true, liveCap);
  addPlayer(ref, 'hunter', ROLE.HUNTER, true, hunterCap);
  ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);

  const deadWorld = worldOf(deadCap), hunterWorld = worldOf(hunterCap);
  ok(deadWorld && deadWorld.props.some((p) => p.id === 1),
    '(B) at HIDING→HUNTING a DEAD spectator receives the one-time full-world catch-up (fly cam never shows an empty world)',
    deadWorld ? `world snapshot: ${deadWorld.props.length} props` : 'no kind:world event');
  ok(hunterWorld, '(B) a released hunter still receives the world catch-up (unchanged baseline)');
  ok(!worldOf(liveCap), '(B) a LIVING prop does NOT get the release snapshot (it tracked the awake stream live)');
}

// ---- (C) During HUNTING a DEAD hunter sees the FULL feed (names visible); a LIVING hunter does not. ---
{
  const ref = makeRef(PHASE.HUNTING);
  const deadCap = [], liveCap = [];
  addPlayer(ref, 'propX', ROLE.PROP, true, [], 'crate'); // disguised prop — its NAME is the anti-cheat leak
  addPlayer(ref, 'deadHunter', ROLE.HUNTER, false, deadCap);
  addPlayer(ref, 'liveHunter', ROLE.HUNTER, true, liveCap);
  ref.broadcastSnapshot();

  const dead = snapOf(deadCap), live = snapOf(liveCap);
  const deadPropX = dead && dead.players.find((pl) => pl.id === 'propX');
  const livePropX = live && live.players.find((pl) => pl.id === 'propX');
  ok(deadPropX && deadPropX.name === 'propX',
    '(C) during HUNTING a DEAD hunter (spectator) sees the disguised prop\'s NAME (full feed — normal spectating)',
    deadPropX ? `name seen by dead spectator: ${JSON.stringify(deadPropX.name)}` : 'propX missing');
  ok(livePropX && livePropX.name === null,
    '(C) a LIVING hunter still gets the roster-safe view (disguised prop NAME blanked — anti-cheat unchanged)',
    livePropX ? `name seen by live hunter: ${JSON.stringify(livePropX.name)}` : 'propX missing');
  ok(deadPropX && livePropX && deadPropX.disguise === livePropX.disguise && !!deadPropX.disguise,
    '(C) both still receive the disguise RENDER shape (only the name label differs)',
    deadPropX ? `disguise: ${deadPropX.disguise}` : '');
}

// ---- CLIENT WIRING (static) — the fly cam + player switching + docs are actually wired. ------------
// A dead spectator's whole experience is client-side; a call to a missing scene.* method would blank
// the render loop (the blindfold-bug class — see check-blindfold). Assert the seams exist end to end.
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');
const mainSrc = read('js', 'main.js');
const sceneSrc = read('js', 'scene.js');
const uiSrc = read('js', 'ui.js');
const html = read('index.html');
const css = read('css', 'style.css');
const defined = (src, name) => new RegExp('(^|[^\\w.])' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm').test(src);

console.log('');
// scene camera seams (the fly cam + the reused third-person orbit for follow).
ok(defined(sceneSrc, 'enterSpectate'), 'scene.enterSpectate() is defined (seed the fly eye on death)');
ok(defined(sceneSrc, 'updateSpectateFly'), 'scene.updateSpectateFly() is defined (bounds-clamped free-fly cam)');
ok(defined(sceneSrc, 'spectateFollow'), 'scene.spectateFollow() is defined (follow a live player)');
ok(defined(sceneSrc, '_orbitCameraTo'), 'scene._orbitCameraTo() is defined (shared third-person orbit — reused, not a second follow-cam)');
ok(/spectateFollow\s*\([^)]*\)\s*\{[\s\S]*?_orbitCameraTo\(/.test(sceneSrc),
  'spectateFollow REUSES the third-person orbit (_orbitCameraTo), per the plan — not a reimplementation');
ok(defined(sceneSrc, 'playerViewPos'), 'scene.playerViewPos() is defined (smoothed follow target)');
ok(/updateSpectateFly\s*\([^)]*\)\s*\{[\s\S]*?half/.test(sceneSrc),
  'the fly cam is CLAMPED to the map bounds (half-size) so nobody flies into the void');

// main.js controller + camera drive.
ok(defined(mainSrc, 'setSpectating'), 'main.js setSpectating() enters/leaves spectator off the alive flag');
ok(defined(mainSrc, 'spectateCycle'), 'main.js spectateCycle() switches between watching live players');
ok(defined(mainSrc, 'updateSpectatorCamera'), 'main.js updateSpectatorCamera() drives the fly/follow cam each frame');
ok(/if \(state\.spectate\.on\) updateSpectatorCamera\(/.test(mainSrc), 'the frame loop drives the spectator camera when dead');
ok(/state\.spectate\.on[\s\S]{0,80}spectateCycle\(1\)/.test(mainSrc), 'a dead player\'s primary (click / ACTION) cycles the spectator camera');
ok(/setSpectating\(!state\.alive && activePhase\)/.test(mainSrc), 'spectator is entered on death during an active phase (from the authoritative snapshot)');

// docs (undocumented controls were half the complaint): the controls panel + the on-death hint.
ok(defined(uiSrc, 'setSpectateHint'), 'ui.setSpectateHint() is defined (the on-death one-line hint)');
ok(defined(uiSrc, 'setSpectateControls'), 'ui.setSpectateControls() is defined (phone ◀ / FLY / ▶ bar)');
ok(/Spectating/.test(uiSrc), 'the PC/touch controls reference list documents the Spectating controls');
ok(/updateSpectateHint/.test(mainSrc), 'main.js updates the on-screen spectator hint on death / mode change');
ok(/id="spectateBar"/.test(html) && /id="spectateHint"/.test(html), 'index.html has the spectate hint + phone control bar');
ok(/\.spectate-bar\b/.test(css), 'css styles the phone spectate control bar');

console.log('');
if (fails) { console.error(`spectator check FAILED (${fails} problem${fails > 1 ? 's' : ''})`); process.exit(1); }
console.log('spectator check passed');
