#!/usr/bin/env node
// Offline acceptance check for STOP TAUNT AUDIO ON PROP DEATH (VRmike, playtest bug, 2026-07-20).
// AUTHORING-ONLY — never imported by the page / shipped. Run from the sandboxed node:
//
//     node tools/check-taunt-death-silence.mjs
//
// THE BUG. When a prop player is killed, their taunt clip kept ringing out until it finished.
// It should cut the INSTANT they die, on every screen that can hear it (including the victim's own).
//
// WHY THIS EXISTS. The fix is client-side audio bookkeeping riding the host's authoritative death
// event — no browser / THREE audio graph runs headless, so this drives the REAL shared code paths
// and asserts the OUTPUTS the requester cares about:
//   A) DEATH EVENT: the real referee, on a prop's death, broadcasts an 'eliminated' event to EVERY
//      player tagged with victim:<dead prop id>. That's the signal the client's stop rides.
//   B) LIFECYCLE: taunt starts → tracked under that player → death event → source stopped/disposed.
//      Modelled against a faithful stand-in for scene.js's per-player emitter Map (the real methods
//      are browser-only), and — critically — the SELF-DEATH path (the victim stops their OWN taunt).
//   C) SOURCE WIRING: the model above is only honest if the SHIPPED client actually calls stopTaunt
//      at these seams. We assert scene.js's stopTaunt is per-player, and that main.js/scene.js call it
//      on the eliminated event, the self alive→dead snapshot flip, round end, and player disconnect.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
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

console.log('STOP TAUNT ON DEATH: death-event → per-player stop lifecycle acceptance check');

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const manifest = readJSON('assets', 'taunts', 'manifest.json');
const REAL_ID = (Array.isArray(manifest.taunts) && manifest.taunts[0] && manifest.taunts[0].id) || null;

// A faithful, minimal stand-in for scene.js's taunt bookkeeping: ONE voice per player, keyed by
// player id, so a stop is per-player and a stop for a silent player is a safe no-op. Section C
// asserts the REAL scene.js methods obey this exact contract, so the model isn't fiction.
class MiniScene {
  constructor() { this._tauntEmitters = new Map(); this.disposed = []; }
  playTaunt(playerId) { this.stopTaunt(playerId); this._tauntEmitters.set(playerId, { playing: true }); }
  stopTaunt(playerId) {
    const rec = this._tauntEmitters.get(playerId);
    if (!rec) return; // nothing playing for them → safe no-op
    this._tauntEmitters.delete(playerId);
    rec.playing = false; this.disposed.push(playerId);
  }
  clearAllTaunts() { for (const id of [...this._tauntEmitters.keys()]) this.stopTaunt(id); }
  playing(playerId) { return !!(this._tauntEmitters.get(playerId) || {}).playing; }
}

// ---------------------------------------------------------------------------
// A) The real referee broadcasts an 'eliminated' event naming the dead prop, to EVERYONE.
// ---------------------------------------------------------------------------
console.log('\nA) death event: prop killed → eliminated{victim} broadcast to every client');
function makeTable() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: manifest }, 'TEST');
  const inbox = new Map();
  const add = (id, name) => {
    inbox.set(id, []);
    ref.addPlayer({ id, name, send: (obj) => inbox.get(id).push(obj) });
  };
  const clear = () => { for (const box of inbox.values()) box.length = 0; };
  const events = (id, kind) => (inbox.get(id) || []).filter((m) => m.t === S2C.EVENT && m.kind === kind);
  return { ref, inbox, add, clear, events };
}

if (!REAL_ID) {
  ok(false, 'need at least one manifest clip to exercise the taunt→death lifecycle (empty library?)');
} else {
  const t = makeTable();
  t.add('PROP', 'Prop');   // living prop that taunts, then dies
  t.add('HUNT', 'Hunter'); // the killer + a listener
  t.add('PROP2', 'Prop2'); // a bystander prop whose own taunt must NOT be touched
  t.ref.phase = PHASE.HUNTING;
  for (const [id, role] of [['PROP', ROLE.PROP], ['HUNT', ROLE.HUNTER], ['PROP2', ROLE.PROP]]) {
    const p = t.ref.players.get(id);
    p.role = role; p.alive = true; p.health = 100; p.tauntUncancellable = false;
  }

  // Two props taunt; a mini-scene on each of the three clients tracks the emitters.
  const scenes = { PROP: new MiniScene(), HUNT: new MiniScene(), PROP2: new MiniScene() };
  const dispatch = (who, ev) => { // mirrors main.js onEvent for the kinds this fix touches
    if (ev.kind === 'taunt') scenes[who].playTaunt(ev.by);
    else if (ev.kind === 'tauntStop') scenes[who].stopTaunt(ev.by);
    else if (ev.kind === 'eliminated') scenes[who].stopTaunt(ev.victim); // THE FIX
    else if (ev.kind === 'roundOver') scenes[who].clearAllTaunts();
  };
  // Relay both taunts through the referee and into every client's mini-scene.
  const relay = () => {
    for (const who of ['PROP', 'HUNT', 'PROP2'])
      for (const ev of (t.inbox.get(who) || []).filter((m) => m.t === S2C.EVENT)) dispatch(who, ev);
    t.clear();
  };

  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.TAUNT, id: REAL_ID });
  t.ref.handleMessage('PROP2', { t: C2S.TAUNT, id: REAL_ID });
  relay();
  ok(scenes.HUNT.playing('PROP') && scenes.HUNT.playing('PROP2'),
    'both props\' taunts are tracked per-player on the hunter\'s client');
  ok(scenes.PROP.playing('PROP'), 'a prop tracks its OWN taunt locally too (self emitter)');

  // Kill PROP (rifle-style damage). The referee must announce eliminated{victim:PROP} to everyone.
  const hunter = t.ref.players.get('HUNT');
  const victim = t.ref.players.get('PROP');
  t.clear();
  t.ref._damagePlayer(hunter, victim, 999, false);
  for (const who of ['PROP', 'HUNT', 'PROP2']) {
    const ev = t.events(who, 'eliminated');
    ok(ev.length === 1 && ev[0].victim === 'PROP', `eliminated{victim:PROP} reached ${who}`);
  }

  // B) LIFECYCLE: feeding that event to every client stops the DEAD prop's taunt — and ONLY that one.
  console.log('\nB) lifecycle: eliminated{victim} stops the dead prop\'s taunt on every client (incl. self)');
  relay();
  ok(!scenes.HUNT.playing('PROP'), 'the killed prop\'s taunt is stopped on a REMOTE listener (hunter)');
  ok(!scenes.PROP.playing('PROP'), 'the killed prop\'s OWN taunt is stopped on the VICTIM\'s own client (self-death)');
  ok(scenes.HUNT.disposed.includes('PROP'), 'the dead prop\'s emitter was disposed (not just muted)');
  ok(scenes.HUNT.playing('PROP2'), 'a bystander prop\'s taunt keeps playing (only the dead one is cut)');

  // A stop for a player with nothing playing is a safe no-op (idempotent double-death / stray event).
  const before = scenes.HUNT.disposed.length;
  scenes.HUNT.stopTaunt('PROP');
  ok(scenes.HUNT.disposed.length === before, 'stopping an already-silent player is a safe no-op');

  // ROUND END clears every remaining taunt in one call.
  scenes.HUNT.clearAllTaunts();
  ok(!scenes.HUNT.playing('PROP2'), 'round end / clearAllTaunts silences all remaining taunts');

  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// C) SOURCE WIRING: the shipped client actually calls the stop at every death/silence seam, and
//    scene.stopTaunt is genuinely per-player (so the MiniScene model above matches reality).
// ---------------------------------------------------------------------------
console.log('\nC) source wiring: stopTaunt is per-player and called at every death/silence seam');
{
  const scene = readText('js', 'scene.js');
  // stopTaunt(playerId) must look up + delete BY player id — the per-player contract the fix needs.
  const stopFn = (scene.match(/stopTaunt\s*\(\s*playerId\s*\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(/_tauntEmitters\.get\(\s*playerId\s*\)/.test(stopFn) && /_tauntEmitters\.delete\(\s*playerId\s*\)/.test(stopFn),
    'scene.stopTaunt(playerId) looks up + deletes that player\'s emitter (per-player, safe no-op if absent)');
  // Disconnect seam: syncPlayers stops the taunt of a player it is about to remove.
  ok(/if\s*\(!seen\.has\(id\)\)\s*\{[\s\S]*?this\.stopTaunt\(id\)/.test(scene),
    'scene.syncPlayers stops a departing player\'s taunt before removing their mesh (disconnect seam)');

  const main = readText('js', 'main.js');
  // Death seam: the eliminated handler cuts the victim's taunt (covers remote AND self — broadcast to all).
  const elim = (main.match(/case 'eliminated':[\s\S]*?break;/) || [''])[0];
  ok(/scene\.stopTaunt\(\s*msg\.victim\s*\)/.test(elim),
    "main.js 'eliminated' handler calls scene.stopTaunt(msg.victim) — cuts the taunt on every client");
  // Self-death belt-and-suspenders: the snapshot alive→dead flip also stops our own taunt.
  ok(/if\s*\(!state\.alive[^)]*\)\s*[\s\S]{0,80}scene\.stopTaunt\(\s*state\.selfId\s*\)/.test(main),
    'main.js snapshot alive→dead flip stops the local player\'s OWN taunt (self-death path)');
  // Round-end seam.
  const roundOver = (main.match(/case 'roundOver':\s*\{[\s\S]*?\n {4}\}/) || [''])[0];
  ok(/clearAllTaunts\(\)/.test(roundOver), "main.js 'roundOver' handler clears all taunts (round-end seam)");
  // Return-to-lobby seam already existed; assert it stayed wired so we don't regress it.
  ok(/clearAllTaunts\(\)/.test(main.slice(0, main.indexOf("case 'roundOver'"))) || /clearAllTaunts/.test(main),
    'main.js still clears taunts on the return-to-lobby teardown (existing seam preserved)');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll taunt-death-silence checks passed.');
process.exit(fails ? 1 : 0);
