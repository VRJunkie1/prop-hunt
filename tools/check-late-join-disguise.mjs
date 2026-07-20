#!/usr/bin/env node
// tools/check-late-join-disguise.mjs — acceptance guard for the LATE-JOINER-SEES-PROPS-AS-RED-CUBES
// fix (playtest bug, VRmike, #devbot 2026-07-20, screenshots posted).
//
// THE BUG. A player who joins a match already in progress saw every disguised PROP player rendered as
// a plain red box (the reddish primitive placeholder, e.g. diner_chair = "#c0392b" box) instead of the
// furniture GLB — at the CORRECT position, so it wasn't a position-sync gap. It never fixed itself.
//
// THE DIAGNOSIS (why this test asserts what it does). VRmike's report guessed the disguise identity was
// "only broadcast at transform time" and so never reached a late joiner. Tracing the actual join path
// shows otherwise: the per-tick SNAPSHOT already carries every prop player's `disguise` (+ `tool`, `alive`,
// `health`), and that data correctly rides the anti-cheat gate (blindHunterSnapshot withholds props from a
// blindfolded hunter during HIDING; hunterSafeSnapshot preserves the disguise SHAPE for hunters in HUNTING
// while blanking the roster NAME). So the wire was never the gap. The real root cause was CLIENT-SIDE
// (js/scene.js): a disguise avatar's appearance `kind` was just `d:<type>`, which did NOT encode whether
// the disguise GLB had finished loading. A late joiner whose GLBs were still downloading when the first
// snapshot arrived built the primitive placeholder — and because the kind never changed, syncPlayers never
// rebuilt it once the GLB loaded → stuck red box forever. Veterans dodged it only because their GLBs had
// long since loaded by the time anyone disguised.
//
// WHAT THIS GUARDS (so the bug can't quietly return):
//   1) DATA PATH (referee, authoritative, drives the REAL admitMidGame join flow):
//        (a) a HUNTER late joiner in HUNTING gets each disguised prop's `disguise` SHAPE (name blanked);
//        (b) a PROP late joiner in HUNTING gets the disguise AND the name (full feed);
//        (c) sibling visual state (`tool` held item, `alive`) rides the same snapshot;
//        (d) ANTI-CHEAT: a HUNTER joining during HIDING is blindfolded — zero prop entries leak.
//   2) CLIENT SWAP (js/scene.js, static): the disguise kind encodes GLB readiness and rebuilds on load,
//      and a disguise model the client hasn't got is pulled on demand (never a permanent placeholder).
//
// AUTHORING-ONLY, never shipped. Rapier-free (physics is stubbed; the join + snapshot logic is pure). Run:
//     node tools/check-late-join-disguise.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee, hunterSafeSnapshot, blindHunterSnapshot } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// ── Referee harness (mirrors check-votekick): captured mailbox per player; physics STUBBED so the
//    round launch is Rapier-free. The join + snapshot data path this test covers is entirely physics-free.
function makeRef() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
  ref._buildPhysics = async () => {}; // no Rapier in the sandbox; the data path is physics-free
  const inbox = new Map();
  // A pre-existing player, added DIRECTLY (bypassing addPlayer) with a role already set — exactly the
  // check-votekick pattern for seeding a running roster before the late joiner arrives.
  const seed = (id, role) => {
    inbox.set(id, []);
    const p = {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
      tool: 'rifle', lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false }, _lastSeen: Date.now(),
      send: (obj) => inbox.get(id).push(obj),
    };
    ref.players.set(id, p);
    if (!ref.hostId) ref.hostId = id;
    return p;
  };
  // A LATE joiner, admitted through the REAL join entry point (addPlayer → admitMidGame). This is the
  // path the bug lives on, so we exercise it rather than hand-place the player.
  const joinLate = (id) => {
    inbox.set(id, []);
    ref.addPlayer({ id, name: id, send: (obj) => inbox.get(id).push(obj) });
    return ref.players.get(id);
  };
  const msgs = (id) => inbox.get(id) || [];
  const lastSnap = (id) => { const s = msgs(id).filter((m) => m.t === S2C.SNAPSHOT); return s[s.length - 1] || null; };
  const started = (id) => msgs(id).filter((m) => m.t === S2C.STARTED).pop() || null;
  const roleMsg = (id) => msgs(id).filter((m) => m.t === S2C.ROLE).pop() || null;
  // Launch a round for the already-seeded roster (spawns by their assigned role), then force HUNTING.
  const launchHunting = () => { ref._launchRound(); ref.phase = PHASE.HUNTING; ref.phaseEndsAt = Date.now() + 300000; };
  const entryFor = (snap, id) => snap && snap.players.find((p) => p.id === id);
  return { ref, seed, joinLate, msgs, lastSnap, started, roleMsg, launchHunting, entryFor };
}

console.log('LATE-JOINER SEES PROPS AS RED CUBES — disguise-sync acceptance check');

// ===========================================================================
// 1a) HUNTER late joiner during HUNTING receives every disguised prop's SHAPE (name blanked by the
//     anti-cheat roster gate). This is the exact screenshot scenario: the data to render furniture
//     (not a red box) MUST be in the joiner's very first snapshot.
// ===========================================================================
console.log('\n1a) a HUNTER joining mid-HUNTING gets each prop\'s disguise SHAPE (identity/name still gated)');
{
  const t = makeRef();
  t.seed('HOST', ROLE.HUNTER);
  const p1 = t.seed('P1', ROLE.PROP);
  const p2 = t.seed('P2', ROLE.PROP);
  t.launchHunting(); // _launchRound resets disguise to null, so disguise AFTER launch (simulates hiding)
  p1.disguise = 'diner_chair'; // the reddish box in the screenshot until its GLB swaps in
  p2.disguise = 'burger';
  // Coin-flip role by team counts: hunters(1) < props(2) → the joiner is admitted as a HUNTER.
  const j = t.joinLate('LATE');
  ok(j.role === ROLE.HUNTER, 'joiner admitted as a HUNTER (joined the smaller/among-larger team is props → hunter)');
  ok((t.roleMsg('LATE') || {}).role === ROLE.HUNTER, 'the joiner is told its private ROLE (hunter)');

  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('LATE');
  ok(!!snap, 'the late joiner receives a snapshot');
  const e1 = t.entryFor(snap, 'P1');
  const e2 = t.entryFor(snap, 'P2');
  ok(!!e1 && !!e2, 'both existing props appear in the joiner\'s snapshot');
  // THE FIX'S DATA HALF: the disguise identity is present — NOT just coordinates.
  ok(e1 && e1.disguise === 'diner_chair', 'prop P1 carries its disguise MODEL id (diner_chair) — the render shape, not a red-box fallback');
  ok(e2 && e2.disguise === 'burger', 'prop P2 carries its disguise MODEL id (burger)');
  ok(e1 && Number.isFinite(e1.x) && Number.isFinite(e1.z), 'the position is present too (the bug was never a missing position — it was correct-position, wrong-model)');
  // ANTI-CHEAT (step 4): the render SHAPE rides the gate, but the roster NAME is still blanked for hunters.
  ok(e1 && e1.name === null, 'the disguised prop\'s NAME is blanked for the hunter joiner (hunterSafeSnapshot — no name↔disguise leak)');
  t.ref.destroy();
}

// ===========================================================================
// 1b) PROP late joiner during HUNTING gets the FULL feed: disguise shape AND the name.
// ===========================================================================
console.log('\n1b) a PROP joining mid-HUNTING gets the disguise shape AND the name (full feed)');
{
  const t = makeRef();
  t.seed('HOST', ROLE.HUNTER);
  t.seed('H2', ROLE.HUNTER);
  const p1 = t.seed('P1', ROLE.PROP);
  t.launchHunting();
  p1.disguise = 'burger';
  // hunters(2) > props(1) → the joiner is admitted as a PROP.
  const j = t.joinLate('LATE');
  ok(j.role === ROLE.PROP, 'joiner admitted as a PROP (props were the smaller team)');
  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('LATE');
  const e1 = t.entryFor(snap, 'P1');
  ok(e1 && e1.disguise === 'burger', 'the prop joiner sees P1\'s disguise shape (burger)');
  ok(e1 && e1.name === 'P1', 'a prop joiner (not a hunter) also sees the name — no blanking on the full feed');
  t.ref.destroy();
}

// ===========================================================================
// 1c) SIBLING VISUAL STATE (plan step 3) rides the SAME snapshot: a hunter's held `tool` and every
//     player's `alive` flag. These were never the reported bug, but the sweep confirms a late joiner
//     gets them exactly as veterans do (they update every snapshot, so they never stick like disguise did).
// ===========================================================================
console.log('\n1c) held-item + alive state ride the same snapshot a late joiner receives');
{
  const t = makeRef();
  const host = t.seed('HOST', ROLE.HUNTER);
  const p1 = t.seed('P1', ROLE.PROP);
  const p2 = t.seed('P2', ROLE.PROP);
  t.launchHunting();
  p1.disguise = 'diner_chair';
  p2.disguise = 'burger';
  host.tool = 'grenade'; // the host switched to grenades
  p2.alive = false;      // P2 was eliminated
  const j = t.joinLate('LATE'); // hunter (props are larger)
  ok(j.role === ROLE.HUNTER, 'joiner is a hunter for this case');
  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('LATE');
  const eh = t.entryFor(snap, 'HOST');
  const e2 = t.entryFor(snap, 'P2');
  ok(eh && eh.tool === 'grenade', 'the hunter\'s selected held item (grenade) rides the joiner\'s snapshot');
  ok(e2 && e2.alive === false, 'a dead prop\'s alive=false rides the joiner\'s snapshot');
  ok(e2 && e2.disguise === 'burger', 'a dead prop still carries its disguise shape (so it renders correctly if visible)');
  t.ref.destroy();
}

// ===========================================================================
// 1d) ANTI-CHEAT GATE (plan step 4): a HUNTER joining during HIDING is blindfolded — the disguise data
//     must ride the SAME withholding gate, never bypass it. The joiner's snapshot carries ZERO prop
//     entries, so no disguise (or position) can leak to a hunter before the hunt begins.
// ===========================================================================
console.log('\n1d) anti-cheat: a HUNTER joining during HIDING gets NO prop data (blindfold gate holds)');
{
  const t = makeRef();
  t.seed('HOST', ROLE.HUNTER);
  const p1 = t.seed('P1', ROLE.PROP);
  const p2 = t.seed('P2', ROLE.PROP);
  t.launchHunting();
  t.ref.phase = PHASE.HIDING; // back to HIDING for the blindfold case (launch left us in HIDING anyway)
  t.ref.phaseEndsAt = Date.now() + 300000;
  p1.disguise = 'diner_chair';
  p2.disguise = 'burger';
  const j = t.joinLate('LATE'); // hunters(1) < props(2) → HUNTER, and HIDING → blindfolded
  ok(j.role === ROLE.HUNTER, 'the HIDING joiner is a blindfolded hunter');
  t.ref.broadcastSnapshot();
  const snap = t.lastSnap('LATE');
  ok(snap && snap.players.every((p) => p.hunter), 'the blindfolded joiner\'s snapshot contains ZERO prop-role entries (no disguise/position leak)');
  ok(snap && !snap.players.some((p) => p.disguise), 'no disguise identity is present at all for the blindfolded joiner');
  ok(snap && snap.props.length === 0, 'no dynamic-prop transforms leak to the blindfolded joiner either');
  t.ref.destroy();
}

// ===========================================================================
// 1e) The two anti-cheat filters do what 1a/1d rely on (pure-function sanity, so the gate can't drift):
//     hunterSafeSnapshot keeps the disguise SHAPE + blanks the NAME; blindHunterSnapshot drops all props.
// ===========================================================================
console.log('\n1e) filter sanity — hunterSafe keeps shape/blanks name; blind drops all props');
{
  const full = {
    t: S2C.SNAPSHOT, phase: PHASE.HUNTING, players: [
      { id: 'h1', hunter: true, name: 'Hunter', tool: 'rifle', alive: true, x: 0, y: 0, z: 0 },
      { id: 'p1', hunter: false, name: 'Prop1', disguise: 'diner_chair', alive: true, x: 3, y: 0, z: 3 },
      { id: 'p2', hunter: false, name: 'Prop2', disguise: null, alive: true, x: -3, y: 0, z: 1 },
    ],
    props: [{ id: 1, x: 3, y: 0, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 }],
  };
  const hv = hunterSafeSnapshot(full);
  const hp1 = hv.players.find((p) => p.id === 'p1');
  ok(hp1.disguise === 'diner_chair' && hp1.name === null, 'hunterSafeSnapshot keeps disguise shape, blanks the disguised prop\'s name');
  ok(hv.players.find((p) => p.id === 'p2').name === 'Prop2', 'hunterSafeSnapshot keeps an UNdisguised prop\'s name (nothing to hide yet)');
  ok(full.players.find((p) => p.id === 'p1').name === 'Prop1', 'hunterSafeSnapshot does not mutate the source snapshot');
  const bv = blindHunterSnapshot(full);
  ok(bv.players.every((p) => p.hunter) && bv.props.length === 0, 'blindHunterSnapshot strips every prop entry + all transforms');
}

// ===========================================================================
// 2) CLIENT SWAP (js/scene.js, static). The real root cause + fix: the disguise appearance kind now
//    encodes GLB readiness (so syncPlayers rebuilds the placeholder into the real mesh once it loads),
//    and a disguise model the client hasn't loaded is pulled on demand (never a permanent red box).
// ===========================================================================
console.log('\n2) client swap — disguise kind encodes model-readiness + rebuilds; missing model pulled on demand');
{
  const sceneSrc = read('js', 'scene.js');
  // The single kind helper both syncPlayers + _syncSelf route through (no drift), folding readiness in.
  ok(/_playerKind\s*\([^)]*\)\s*\{/.test(sceneSrc), 'scene defines _playerKind() — the one appearance-signature builder');
  ok(/d:\$\{p\.disguise\}:\$\{this\._disguiseModelReady\(p\.disguise\)\s*\?\s*'glb'\s*:\s*'prim'\}/.test(sceneSrc),
    'a disguise kind encodes GLB readiness (d:<type>:glb once loaded, else :prim) so it rebuilds on load');
  ok(/_disguiseModelReady\s*\([^)]*\)\s*\{/.test(sceneSrc), 'scene defines _disguiseModelReady() (the readiness check the kind + render agree on)');
  // Both reconciliation sites use the shared helper (so neither can regress to the old fixed `d:<type>`).
  const syncPlayers = (sceneSrc.match(/syncPlayers\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  ok(/this\._playerKind\(p,\s*true\)/.test(syncPlayers), 'syncPlayers derives the remote kind via _playerKind (rebuilds when it changes)');
  const syncSelf = (sceneSrc.match(/_syncSelf\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  ok(/this\._playerKind\(p,\s*false\)/.test(syncSelf), '_syncSelf derives the local kind via _playerKind too (own disguise swaps in as well)');
  // The old, buggy fixed kind (no readiness suffix) must be gone from both sites.
  ok(!/`d:\$\{p\.disguise\}`/.test(sceneSrc), 'the old fixed `d:<type>` kind (which never rebuilt → stuck red box) is gone');
  // On-demand pull so a disguise model not queued via _modelSlots still resolves.
  ok(/_ensureDisguiseModel\s*\([^)]*\)\s*\{/.test(sceneSrc), 'scene defines _ensureDisguiseModel() (on-demand single-GLB loader)');
  const buildMesh = (sceneSrc.match(/_buildPlayerMesh\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  ok(/this\._ensureDisguiseModel\(path\)/.test(buildMesh), '_buildPlayerMesh kicks an on-demand load when a disguise GLB is not cached (placeholder is only ever temporary)');
}

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nlate-join disguise check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nlate-join disguise check passed');
