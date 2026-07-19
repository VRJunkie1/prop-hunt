// SCRATCH repro for B8 item 2 — round-2 permanent blindfold. Drives the REAL referee through
// round1 -> (prop caught, dies) -> ENDING -> flip -> round2 HIDING -> HUNTING, capturing each
// player's received messages and running a faithful client-side blindfold reducer.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const startHealth = rules.startHealth != null ? rules.startHealth : 100;

const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'ABCD');
ref._buildPhysics = async () => {};

const inbox = new Map();
function add(id, role) {
  inbox.set(id, []);
  const p = {
    id, name: id, role, alive: true, health: startHealth, disguise: null,
    ready: false, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, dispYaw: 0, rotUnlock: false,
    lastInputSeq: 0, input: { mx: 0, mz: 0, jump: false },
    send: (obj) => inbox.get(id).push(obj),
  };
  ref.players.set(id, p);
  if (!ref.hostId) ref.hostId = id;
  return p;
}

// Faithful client model of the blindfold-relevant state (mirrors js/main.js).
function makeClient(id) {
  return { id, role: null, phase: PHASE.LOBBY, alive: true, spawned: false, blind: false, lookFrozen: false, spectating: false };
}
function clientApply(c, msg) {
  if (msg.t === S2C.ROLE) { c.alive = true; c.role = msg.role; }
  else if (msg.t === S2C.STARTED) { c.spawned = false; }
  else if (msg.t === S2C.EVENT && msg.kind === 'phase') {
    c.phase = msg.phase;
    c.blind = c.role === ROLE.HUNTER && c.phase === PHASE.HIDING;
    c.lookFrozen = c.blind;
  } else if (msg.t === S2C.SNAPSHOT) {
    c.phase = msg.phase;
    const me = msg.players.find((p) => p.id === c.id);
    if (me) {
      const serverRole = me.hunter ? ROLE.HUNTER : ROLE.PROP;
      if (serverRole !== c.role) c.role = serverRole;
      c.alive = me.alive !== false;
      const activePhase = msg.phase === PHASE.HIDING || msg.phase === PHASE.HUNTING;
      c.spectating = !c.alive && activePhase;
      if (!c.spawned) c.spawned = true;
    }
    c.blind = c.role === ROLE.HUNTER && c.phase === PHASE.HIDING;
    c.lookFrozen = c.blind;
  }
  return c;
}

function drain(id, client) {
  for (const m of inbox.get(id)) clientApply(client, m);
  inbox.set(id, []);
}

// ---- round 1: H hunter, P prop
const H = add('H', ROLE.HUNTER);
const P = add('P', ROLE.PROP);
const cH = makeClient('H');
const cP = makeClient('P');

ref._launchRound(); // roles pre-assigned
drain('H', cH); drain('P', cP);
console.log('R1 HIDING  cH', JSON.stringify(cH));
console.log('R1 HIDING  cP', JSON.stringify(cP));

ref.broadcastSnapshot();
drain('H', cH); drain('P', cP);

// R1 -> HUNTING
ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
ref.broadcastSnapshot();
drain('H', cH); drain('P', cP);
console.log('R1 HUNTING cP', JSON.stringify(cP), '<- prop should NOT be blind');

// Kill the prop -> round over -> ENDING
ref._damagePlayer(H, P, 9999, false);
console.log('after kill: P.alive(server)=', P.alive, 'phase=', ref.phase);
ref.broadcastSnapshot();
drain('H', cH); drain('P', cP);
console.log('ENDING     cP', JSON.stringify(cP));

// ENDING expiry -> flipped round 2
ref.startFlippedRound();
console.log('--- round 2 launched. server roles: H=', H.role, 'P=', P.role, 'P.alive=', P.alive);
drain('H', cH); drain('P', cP);
console.log('R2 HIDING  cP(was dead prop, now hunter)', JSON.stringify(cP));
console.log('R2 HIDING  cH(was hunter, now prop)      ', JSON.stringify(cH));

// R2 HIDING snapshots
ref.broadcastSnapshot();
// inspect the raw snapshot the new hunter (P) receives
const pSnap = inbox.get('P').find((m) => m.t === S2C.SNAPSHOT);
console.log('R2 HIDING snapshot to P: alive=', pSnap && pSnap.players.find((x) => x.id === 'P').alive,
  'props withheld=', pSnap && pSnap.props.length === 0, 'propEntries=', pSnap && pSnap.players.filter((x) => !x.hunter).length);
drain('H', cH); drain('P', cP);
console.log('R2 HIDING  cP after snapshot', JSON.stringify(cP));

// R2 HIDING -> HUNTING (release)
ref.setPhase(PHASE.HUNTING, rules.huntingSeconds);
const worldEvt = inbox.get('P').find((m) => m.t === S2C.EVENT && m.kind === 'world');
console.log('R2 release: P got world catch-up?', !!worldEvt);
ref.broadcastSnapshot();
drain('H', cH); drain('P', cP);
console.log('R2 HUNTING cP (blind should be FALSE)', JSON.stringify(cP));

console.log('\nRESULT: round-2 hunter blind =', cP.blind, '| lookFrozen =', cP.lookFrozen, '| spectating =', cP.spectating, '| spawned =', cP.spawned);
ref.destroy();
process.exit(0);
