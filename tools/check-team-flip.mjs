#!/usr/bin/env node
// Offline acceptance check for PAUSE-MENU TEAM SWITCH + ENDLESS FLIPPED ROUNDS + MID-ROUND JOIN +
// DISGUISE-INFO LEAK FIX (VRmike, 2026-07-17). AUTHORING-ONLY — never imported by the page / shipped.
// Run under the sandboxed node:
//
//     node tools/check-team-flip.mjs
//
// WHY THIS EXISTS. All four pieces are host-authoritative referee logic (role flip, mid-join team
// assignment, team switch, per-recipient snapshot filtering) that a headless page boot never exercises
// (no peers, no Rapier, no THREE). So this drives the REAL shared referee directly and asserts the
// OUTPUTS the spec names, plus source assertions for the client wiring:
//   A) ENDLESS FLIPPED ROUNDS — startFlippedRound() flips EVERY player's team and re-launches the round
//      with a CLEAN state (alive, full HP, no disguise) + fresh ROLE + a STARTED broadcast + HIDING phase.
//   B) MID-ROUND JOIN — admitMidGame assigns the newcomer to the SMALLER team (random on a tie), drops
//      them into the live round fresh, and broadcasts a public "joined the …" log.
//   C) TEAM SWITCH — applySwitchTeam respawns the sender on the OPPOSITE team (fresh) + a public
//      "switched to …" log; active-round only.
//   D) DISGUISE-LEAK FIX (BOTH HALVES) — a hunter's snapshot contains ZERO name↔disguise identity labels
//      (disguised props' names blanked) BUT STILL contains the disguise SHAPE/render field (so the fix
//      can't silently over-strip and blank the world for hunters); a prop's snapshot keeps the labels.
//   E) SOURCE — protocol/referee/main/ui/index wiring for all four pieces.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C2S, S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee, hunterSafeSnapshot } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('TEAM SWITCH + FLIPPED ROUNDS + MID-JOIN + DISGUISE-LEAK: host-authoritative acceptance check');

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

// Shared harness: a referee with a captured mailbox per player, roles/positions set directly. Physics
// is STUBBED OUT (_buildPhysics no-op) so the round-launch runs Rapier-free and deterministic — we only
// assert referee OUTPUTS (roles/spawns/messages/snapshots), not the async physics world.
function makeRef() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
  ref._buildPhysics = async () => {}; // no Rapier in the sandbox; the logic under test is physics-free
  const inbox = new Map();
  const mk = (id, role, extra = {}) => {
    inbox.set(id, []);
    const p = {
      id, name: id, role, alive: true, health: startHealth, disguise: null,
      ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
      lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false },
      send: (obj) => inbox.get(id).push(obj),
    };
    Object.assign(p, extra);
    return p;
  };
  const add = (id, role, extra = {}) => { const p = mk(id, role, extra); ref.players.set(id, p); if (!ref.hostId) ref.hostId = id; return p; };
  const msgs = (id) => inbox.get(id) || [];
  const events = (id, kind) => msgs(id).filter((m) => m.t === S2C.EVENT && m.kind === kind);
  const roles = (id) => msgs(id).filter((m) => m.t === S2C.ROLE);
  const started = (id) => msgs(id).filter((m) => m.t === S2C.STARTED);
  return { ref, mk, add, msgs, events, roles, started };
}

// ---------------------------------------------------------------------------
// A) ENDLESS FLIPPED ROUNDS — startFlippedRound flips every team + clean re-launch.
// ---------------------------------------------------------------------------
console.log('\nA) endless flipped rounds — every team flips, clean state, ROLE + STARTED, HIDING');
{
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  const H1 = t.add('H1', ROLE.HUNTER, { health: 30 });
  const H2 = t.add('H2', ROLE.HUNTER, { alive: false, health: 0 });
  const P1 = t.add('P1', ROLE.PROP, { disguise: 'burger', health: 55 });
  const P2 = t.add('P2', ROLE.PROP, { disguise: 'crate' });

  t.ref.startFlippedRound();

  ok(H1.role === ROLE.PROP && H2.role === ROLE.PROP, 'both former HUNTERS are now PROPS');
  ok(P1.role === ROLE.HUNTER && P2.role === ROLE.HUNTER, 'both former PROPS are now HUNTERS');
  const clean = [H1, H2, P1, P2].every((p) => p.alive === true && p.health === startHealth && p.disguise === null);
  ok(clean, 'every player is CLEAN after the flip: alive, full HP, no disguise');
  ok([H1, H2, P1, P2].every((p) => t.roles(p.id).some((m) => m.role === p.role)), 'every player got a private ROLE matching their new team');
  ok([H1, H2, P1, P2].every((p) => t.started(p.id).length >= 1), 'every player got a STARTED broadcast (fresh world for the new round)');
  ok(t.ref.phase === PHASE.HIDING, 'the new round enters HIDING');
  // counts preserved (2 hunters + 2 props, swapped)
  const hn = [H1, H2, P1, P2].filter((p) => p.role === ROLE.HUNTER).length;
  const pn = [H1, H2, P1, P2].filter((p) => p.role === ROLE.PROP).length;
  ok(hn === 2 && pn === 2, 'team COUNTS preserved through the flip (2 hunters / 2 props, swapped)');
  t.ref.destroy();
}
{
  // SOLO guard: a lone host (prop, 0 hunters) flipped would be a 0-prop round — the guard keeps them a
  // prop so the round stays meaningful (matches startMatch's "always >=1 prop").
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  const S = t.add('S', ROLE.PROP);
  t.ref.startFlippedRound();
  ok(S.role === ROLE.PROP, 'a solo prop host stays a PROP after a flip (>=1 prop guard) — no empty-prop round');
  ok(t.ref.phase === PHASE.HIDING, 'the solo flipped round still launches (HIDING)');
  t.ref.destroy();
}
{
  // tick() drives the ENDING→flip transition — assert the ENDING branch is wired to startFlippedRound.
  const ref = readText('shared', 'referee.js');
  const tickBody = ref.slice(ref.indexOf('tick() {'), ref.indexOf('tick() {') + 2400);
  ok(/PHASE\.ENDING[\s\S]{0,500}startFlippedRound\(\)/.test(tickBody), "tick() starts a flipped round when ENDING expires (not resetToLobby)");
}

// ---------------------------------------------------------------------------
// B) MID-ROUND JOIN — assign to the SMALLER team (random on a tie).
// ---------------------------------------------------------------------------
console.log('\nB) mid-round join — smaller team (random on a tie), fresh drop-in, public log');
function joinInto(hunters, propsN) {
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  for (let i = 0; i < hunters; i++) t.add('H' + i, ROLE.HUNTER);
  for (let i = 0; i < propsN; i++) t.add('P' + i, ROLE.PROP, { disguise: 'burger' });
  const nc = t.mk('NEW', null); // addPlayer assigns everything
  t.ref.addPlayer(nc);
  return { t, nc };
}
{
  const { t, nc } = joinInto(2, 1); // hunters 2 > props 1 → join PROPS
  ok(nc.role === ROLE.PROP, 'joins the SMALLER team (2 hunters, 1 prop → PROP)');
  ok(t.roles('NEW').some((m) => m.role === ROLE.PROP), 'newcomer got a private ROLE=prop');
  ok(t.started('NEW').length === 1, 'newcomer got the STARTED world catch-up');
  ok(nc.alive === true && nc.health === startHealth && nc.disguise === null, 'newcomer drops in FRESH (alive, full HP, no disguise)');
  const log = t.events('H0', 'log').find((m) => /joined the props/.test(m.text || ''));
  ok(!!log, 'a public "X joined the props" log is broadcast to everyone');
  t.ref.destroy();
}
{
  const { t, nc } = joinInto(1, 2); // props 2 > hunters 1 → join HUNTERS
  ok(nc.role === ROLE.HUNTER, 'joins the SMALLER team (1 hunter, 2 props → HUNTER)');
  ok(t.events('P0', 'log').some((m) => /joined the hunters/.test(m.text || '')), 'a public "joined the hunters" log fired');
  t.ref.destroy();
}
{
  const { nc } = joinInto(0, 1); // 0 hunters, 1 prop → join HUNTERS (0 < 1)
  ok(nc.role === ROLE.HUNTER, 'joins the empty team (0 hunters, 1 prop → HUNTER)');
}
{
  const { nc } = joinInto(1, 0); // 1 hunter, 0 props → join PROPS (0 < 1)
  ok(nc.role === ROLE.PROP, 'joins the empty team (1 hunter, 0 props → PROP)');
}
{
  // TIE (1 v 1): the assignment must be a VALID team, and stay valid across many runs (random, never crashes).
  let allValid = true, sawHunter = false, sawProp = false;
  for (let i = 0; i < 40; i++) {
    const { nc } = joinInto(1, 1);
    if (nc.role !== ROLE.HUNTER && nc.role !== ROLE.PROP) allValid = false;
    if (nc.role === ROLE.HUNTER) sawHunter = true;
    if (nc.role === ROLE.PROP) sawProp = true;
  }
  ok(allValid, 'an even-teams join always yields a valid team (hunter or prop)');
  ok(sawHunter && sawProp, 'an even-teams join is RANDOM across runs (both teams observed over 40 tries)');
}

// ---------------------------------------------------------------------------
// C) TEAM SWITCH — opposite team, fresh, public log; active-round only.
// ---------------------------------------------------------------------------
console.log('\nC) team switch — opposite team, fresh spawn, public log, active-round only');
{
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING;
  const P = t.add('P', ROLE.PROP, { disguise: 'burger', health: 40 });
  t.ref.applySwitchTeam(P);
  ok(P.role === ROLE.HUNTER, 'a prop switches to HUNTER');
  ok(P.disguise === null && P.health === startHealth && P.alive === true, 'switcher respawns FRESH (no disguise, full HP, alive)');
  ok(t.roles('P').some((m) => m.role === ROLE.HUNTER), 'switcher got a private ROLE=hunter');
  ok(t.events('P', 'log').some((m) => /switched to hunters/.test(m.text || '')), 'a public "switched to hunters" log is broadcast');

  t.ref.applySwitchTeam(P); // back the other way
  ok(P.role === ROLE.PROP, 'switching again flips back to PROP');
  ok(t.events('P', 'log').some((m) => /switched to props/.test(m.text || '')), 'a public "switched to props" log is broadcast');
  t.ref.destroy();
}
{
  // Active-round only: a switch in LOBBY / ENDING is ignored (no ROLE, no log).
  for (const ph of [PHASE.LOBBY, PHASE.ENDING]) {
    const t = makeRef();
    t.ref.phase = ph;
    const P = t.add('P', ROLE.PROP);
    t.ref.applySwitchTeam(P);
    ok(P.role === ROLE.PROP && t.roles('P').length === 0 && t.events('P', 'log').length === 0, `a team switch during ${ph} is ignored`);
    t.ref.destroy();
  }
}

// ---------------------------------------------------------------------------
// D) DISGUISE-LEAK FIX — both halves, per-recipient snapshot filtering.
// ---------------------------------------------------------------------------
console.log('\nD) disguise leak — hunters get render shapes but ZERO name↔disguise labels; props keep labels');
{
  const t = makeRef();
  t.ref.phase = PHASE.HUNTING; // HIDING already withholds all props via the blindfold; HUNTING is the exposed case
  t.ref.phaseEndsAt = Date.now() + 30000;
  const H = t.add('H', ROLE.HUNTER, { name: 'Hunter', pos: { x: 1, y: 0, z: 1 } });
  const P = t.add('P', ROLE.PROP, { name: 'VRmike', disguise: 'burger', pos: { x: 2, y: 0, z: 2 } });
  const Q = t.add('Q', ROLE.PROP, { name: 'Sam', disguise: null, pos: { x: 3, y: 0, z: 3 } });
  t.ref.broadcastSnapshot();

  const hSnap = t.msgs('H').find((m) => m.t === S2C.SNAPSHOT);
  const pSnap = t.msgs('P').find((m) => m.t === S2C.SNAPSHOT);
  ok(hSnap && pSnap, 'both a hunter and a prop received a snapshot');

  const hP = hSnap.players.find((pl) => pl.id === 'P');
  const hQ = hSnap.players.find((pl) => pl.id === 'Q');
  const hH = hSnap.players.find((pl) => pl.id === 'H');
  // Render half: the disguised prop still carries its render shape for the hunter (so it draws AS a burger).
  ok(hP && hP.disguise === 'burger', "HUNTER still receives the disguised prop's SHAPE (disguise='burger') — the world isn't blanked");
  // Label half: no name↔disguise pairing anywhere in the hunter's data.
  ok(hP && hP.name == null, "HUNTER does NOT receive the disguised prop's NAME (identity label stripped)");
  const noLabels = hSnap.players.every((pl) => !(pl.name && pl.disguise));
  ok(noLabels, 'ZERO name↔disguise identity labels in the hunter-bound snapshot');
  ok(hQ && hQ.name === 'Sam', 'an UNDISGUISED prop keeps its name for the hunter (only disguised props are anonymized)');
  ok(hH && hH.name === 'Hunter', 'the hunter keeps its own name');

  // Prop viewer keeps the labels (props may see who is disguised as what).
  const pP = pSnap.players.find((pl) => pl.id === 'P');
  ok(pP && pP.name === 'VRmike' && pP.disguise === 'burger', 'a PROP viewer keeps the full "name + disguise" label');
  t.ref.destroy();
}
{
  // Pure helper: hunterSafeSnapshot preserves shape, strips only disguised props' names.
  const full = {
    t: S2C.SNAPSHOT,
    players: [
      { id: 'a', name: 'Alice', hunter: true, disguise: null },
      { id: 'b', name: 'Bob', hunter: false, disguise: 'table' },
      { id: 'c', name: 'Cara', hunter: false, disguise: null },
    ],
    props: [{ id: 9, x: 1 }],
  };
  const safe = hunterSafeSnapshot(full);
  ok(safe.players.find((p) => p.id === 'b').disguise === 'table', 'hunterSafeSnapshot KEEPS the disguise shape (render intact)');
  ok(safe.players.find((p) => p.id === 'b').name == null, "hunterSafeSnapshot strips a disguised prop's name");
  ok(safe.players.find((p) => p.id === 'c').name === 'Cara', 'hunterSafeSnapshot keeps an undisguised prop name');
  ok(safe.players.find((p) => p.id === 'a').name === 'Alice', 'hunterSafeSnapshot keeps the hunter name');
  ok(safe.props === full.props, 'hunterSafeSnapshot leaves the prop transform stream untouched');
  ok(full.players.find((p) => p.id === 'b').name === 'Bob', 'the original snapshot is NOT mutated (pure)');
}

// ---------------------------------------------------------------------------
// E) SOURCE — protocol / referee / client wiring.
// ---------------------------------------------------------------------------
console.log('\nE) source: protocol + referee + main/ui/index wiring');
{
  const proto = readText('shared', 'protocol.js');
  ok(/SWITCH_TEAM:\s*'switchTeam'/.test(proto), 'protocol.js defines C2S.SWITCH_TEAM');
  ok(/kind:'log'/.test(proto), 'protocol.js documents S2C.EVENT kind:log');

  const ref = readText('shared', 'referee.js');
  ok(/applySwitchTeam\(/.test(ref) && /_spawnOnTeam\(/.test(ref), 'referee has applySwitchTeam + the shared _spawnOnTeam routine');
  ok(/startFlippedRound\(/.test(ref) && /_launchRound\(/.test(ref), 'referee has startFlippedRound + the shared _launchRound flow');
  ok(/case C2S\.SWITCH_TEAM/.test(ref), 'referee routes C2S.SWITCH_TEAM');
  ok(/hunterSafeSnapshot/.test(ref), 'referee applies hunterSafeSnapshot to hunter recipients');
  // admitMidGame picks the smaller team (both branches present).
  ok(/hunters < props/.test(ref) && /props < hunters/.test(ref), 'admitMidGame assigns by the smaller team (both directions)');

  const main = readText('js', 'main.js');
  ok(/C2S\.SWITCH_TEAM/.test(main), 'main.js sends C2S.SWITCH_TEAM (team switch)');
  ok(/onPauseSwitch/.test(main) && /onPauseCopyRoom/.test(main), 'main.js wires the pause switch + copy-room buttons');
  ok(/setPauseRoom/.test(main), 'main.js populates the pause room code');
  ok(/case 'log'/.test(main), "main.js handles the public 'log' event");
  // The 3rd positional arg is still the viewer role (a trailing voteCtx arg was added for VOTE-KICK —
  // `[),]` tolerates either the old closing paren or the new comma, so the disguise-leak intent holds).
  ok(/updatePauseScoreboard\(msg\.players, state\.selfId, state\.role === ROLE\.HUNTER[),]/.test(main), 'main.js passes the viewer role so a hunter roster hides disguises');

  const ui = readText('js', 'ui.js');
  ok(/updatePauseScoreboard\(players, selfId, selfIsHunter[),]/.test(ui), 'ui.updatePauseScoreboard takes the viewer role');
  ok(/p\.disguise && !selfIsHunter/.test(ui), 'ui hides the disguise label from a HUNTER viewer');
  ok(/setPauseRoom\(/.test(ui), 'ui has setPauseRoom (room code display)');
  ok(/onPauseSwitch/.test(ui) && /onPauseCopyRoom/.test(ui), 'ui wires the switch + copy-room callbacks');

  const html = readText('index.html');
  ok(/id="pauseSwitch"/.test(html), 'index.html has the Switch-teams button');
  ok(/id="pauseCopyRoom"/.test(html) && /id="pauseRoomCode"/.test(html), 'index.html has the room-code display + copy button');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll team-switch / flipped-round / mid-join / leak checks passed.');
process.exit(fails ? 1 : 0);
