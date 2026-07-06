// Entry point. Wires DOM -> network -> scene, runs the render loop with light
// client-side prediction for the local player, and sends movement intent to the
// referee at a fixed rate. The referee stays authoritative; prediction only
// makes the local camera feel responsive.
//
// Since the P2P rebuild the "network" is a Session that hides whether we're the
// host (referee runs in this tab, replies are instant loopback) or a guest
// (referee is another player's tab, reached over an RTCDataChannel). This file
// is identical for both — it just calls session.send()/reads session.onMessage.
import { loadConfig } from './config.js';
import { Session } from './net.js';
import { Input } from './input.js';
import { Scene3D } from './scene.js';
import { UI } from './ui.js';
import { C2S, S2C, PHASE, ROLE } from '/shared/protocol.js';

const ui = new UI();
let session = null; // created in boot() once config is loaded
const canvas = document.getElementById('view');
const scene = new Scene3D(canvas);
const input = new Input(canvas);

const state = {
  selfId: null,
  role: null,
  phase: PHASE.LOBBY,
  cfg: null,
  map: null,
  props: [], // authoritative prop instances for the active match
  self: { x: 0, y: 0, z: 0, vy: 0 }, // predicted local position + vertical velocity
  serverSelf: { x: 0, y: 0, z: 0 }, // last authoritative position for reconciliation
  eyeHeight: 1.6, // current (lerped) camera eye height; drops when crouching
  movable: false,
  blindfolded: false, // hunter, during HIDING — screen blackout ("eyes closed")
  timeLeft: 0, // last known phase countdown (for the blindfold overlay)
  spawned: false, // snap to the authoritative spawn on the first snapshot
  bounds: 18,
};

// ---- action routing -------------------------------------------------------
input.onAction = (name) => {
  if (state.phase !== PHASE.HIDING && state.phase !== PHASE.HUNTING) return;
  if (name === 'primary') name = state.role === ROLE.HUNTER ? 'tag' : 'disguise';
  if (name === 'disguise') tryDisguise();
  if (name === 'tag') session.send({ t: C2S.TAG });
};

function tryDisguise() {
  if (state.role !== ROLE.PROP) return;
  const range = state.cfg.rules.disguiseRange;
  let best = null;
  let bestDist = Infinity;
  for (const p of state.props) {
    const d = Math.hypot(p.x - state.self.x, p.z - state.self.z);
    if (d <= range && d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (best) session.send({ t: C2S.DISGUISE, propId: best.id });
  else ui.feed('No prop close enough to disguise as.');
}

// ---- network handling -----------------------------------------------------
// Game messages (S2C) from the referee — same whether it's our own in-tab
// referee (host) or the host's over the data channel (guest).
function handleGameMessage(msg) {
  switch (msg.t) {
    case S2C.JOINED:
      state.selfId = msg.id;
      scene.setSelf(msg.id);
      ui.show('lobby');
      break;

    case S2C.LOBBY:
      ui.renderLobby(msg, state.selfId);
      if (msg.phase === PHASE.LOBBY) {
        state.phase = PHASE.LOBBY;
        ui.show('lobby');
      }
      break;

    case S2C.STARTED: {
      state.map = state.cfg.maps[msg.mapId];
      state.props = msg.props;
      state.bounds = state.map.size / 2 - state.cfg.rules.mapMargin;
      state.spawned = false;
      scene.buildWorld(state.map, state.props, state.cfg.props);
      ui.show('game');
      ui.banner('Get ready…', 1500);
      break;
    }

    case S2C.ROLE:
      state.role = msg.role;
      ui.setRole(msg.role);
      if (msg.role === ROLE.HUNTER) ui.banner('You are a HUNTER. Wait, then find the props.', 3500);
      else ui.banner('You are a PROP. Look at an object and press E to disguise.', 3500);
      break;

    case S2C.SNAPSHOT:
      onSnapshot(msg);
      break;

    case S2C.EVENT:
      onEvent(msg);
      break;

    case S2C.ERROR:
      if (ui.el.menu.classList.contains('hidden')) ui.feed(msg.msg);
      else ui.menuError(msg.msg);
      break;
  }
}

// Connection status (not gameplay) — surfaced to the UI.
function handleStatus(kind, detail) {
  if (kind === 'connecting') {
    ui.menuError('Connecting…');
  } else if (kind === 'error') {
    if (ui.el.menu.classList.contains('hidden')) ui.feed(detail || 'Connection error.');
    else ui.menuError(detail || 'Connection error.');
  } else if (kind === 'closed') {
    backToMenu(detail || 'Disconnected.');
  }
}

// Return to the landing screen and arm a fresh Session so the player can start
// or join another match (a Session is single-use — it tears down its peer links
// and signaling socket when a match ends).
function backToMenu(msg) {
  state.selfId = null;
  state.role = null;
  state.phase = PHASE.LOBBY;
  state.movable = false;
  state.spawned = false;
  state.blindfolded = false;
  ui.setBlindfold(false, 0);
  ui.show('menu');
  if (msg) ui.menuError(msg);
  newSession();
}

function onSnapshot(msg) {
  state.phase = msg.phase;
  state.timeLeft = msg.timeLeft;
  ui.setHud(msg);
  scene.syncPlayers(msg.players);
  const me = msg.players.find((p) => p.id === state.selfId);
  if (me) {
    state.serverSelf.x = me.x;
    state.serverSelf.y = me.y || 0;
    state.serverSelf.z = me.z;
    if (!state.spawned) {
      state.self.x = me.x;
      state.self.y = me.y || 0;
      state.self.z = me.z;
      state.self.vy = 0;
      state.spawned = true;
    }
    const frozenHunter = state.role === ROLE.HUNTER && msg.phase === PHASE.HIDING;
    state.movable = me.alive && !frozenHunter && (msg.phase === PHASE.HIDING || msg.phase === PHASE.HUNTING);
    if (!state.movable) {
      state.self.x = me.x;
      state.self.y = me.y || 0;
      state.self.z = me.z;
      state.self.vy = 0;
    }
  }
  updateBlindfold();
}

// The blindfold's screen half: hunters see a blackout during HIDING. The data
// half (referee sends them nothing) lives in shared/referee.js. Kept as a pure
// show/hide switch driven by role+phase, same pattern as the click-to-play
// overlay — no game logic sneaks into the UI layer.
function updateBlindfold() {
  state.blindfolded = state.role === ROLE.HUNTER && state.phase === PHASE.HIDING;
  ui.setBlindfold(state.blindfolded, Math.max(0, Math.ceil(state.timeLeft)));
}

function onEvent(msg) {
  switch (msg.kind) {
    case 'phase':
      state.phase = msg.phase;
      if (msg.phase === PHASE.HIDING) {
        state.timeLeft = msg.seconds;
        ui.banner('HIDING PHASE — props, disguise now!', 2500);
      }
      if (msg.phase === PHASE.HUNTING) ui.banner('HUNT! Hunters are loose.', 2500);
      // Flip the blackout the instant the phase changes, before the next
      // snapshot — no window where a hunter glimpses the world.
      updateBlindfold();
      break;
    case 'toLobby':
      ui.feed(msg.reason || 'Returned to the lobby.');
      break;
    case 'eliminated':
      ui.feed(`${msg.name} was found!`);
      if (msg.victim === state.selfId) ui.banner('You were caught!', 3000);
      break;
    case 'miss':
      ui.feed('Missed — nothing there.');
      break;
    case 'disguised':
      ui.feed(`Disguised as a ${msg.type}.`);
      break;
    case 'roundOver': {
      const won =
        (msg.winner === ROLE.HUNTER && state.role === ROLE.HUNTER) ||
        (msg.winner === ROLE.PROP && state.role === ROLE.PROP);
      // Scoreboard holds for the ENDING phase, then the referee rolls into the
      // next round with teams swapped — no trip back to the lobby.
      ui.banner(
        `${msg.winner === ROLE.HUNTER ? 'HUNTERS' : 'PROPS'} WIN — ${won ? 'you won!' : 'you lost.'}\nNext round starting… teams swap!`,
        9000
      );
      break;
    }
  }
}

// ---- prediction + render loop ---------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const r = state.cfg.rules;
  const crouching = state.movable && input.crouch;
  if (state.movable) {
    const { mx, mz } = input.moveVector();
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    let vx = -sin * mz + cos * mx;
    let vz = -cos * mz - sin * mx;
    const len = Math.hypot(vx, vz);
    if (len > 1) {
      vx /= len;
      vz /= len;
    }
    // Same crouch multiplier + jump/gravity as the referee (shared/referee.js
    // integrate). Must stay identical or the local player rubber-bands.
    const speed = r.moveSpeed * (input.crouch ? r.crouchSpeedMult : 1);
    state.self.x += vx * speed * dt;
    state.self.z += vz * speed * dt;
    state.self.x = clamp(state.self.x, -state.bounds, state.bounds);
    state.self.z = clamp(state.self.z, -state.bounds, state.bounds);

    const grounded = state.self.y <= 0;
    if (grounded && input.jump) state.self.vy = r.jumpSpeed;
    state.self.vy -= r.gravity * dt;
    state.self.y += state.self.vy * dt;
    if (state.self.y < 0) {
      state.self.y = 0;
      state.self.vy = 0;
    }

    // Gentle reconciliation toward the authoritative position.
    state.self.x += (state.serverSelf.x - state.self.x) * 0.08;
    state.self.y += (state.serverSelf.y - state.self.y) * 0.08;
    state.self.z += (state.serverSelf.z - state.self.z) * 0.08;
  }

  // Ease the eye height toward stand/crouch so ducking dips the camera smoothly.
  const targetEye = crouching ? r.crouchEyeHeight : r.standEyeHeight;
  state.eyeHeight += (targetEye - state.eyeHeight) * Math.min(1, dt * 12);

  scene.setCamera(state.self, state.eyeHeight, input.yaw, input.pitch);
  scene.interpolate(0.25);
  scene.render();

  const inGame = !ui.el.game.classList.contains('hidden');
  ui.setClickToPlay(inGame && !input.locked && !state.blindfolded);

  requestAnimationFrame(frame);
}

// Send movement intent to the referee at a fixed rate.
function startInputLoop() {
  setInterval(() => {
    if (!session || !session.ready) return;
    if (state.phase !== PHASE.HIDING && state.phase !== PHASE.HUNTING) return;
    const { mx, mz } = input.moveVector();
    session.send({ t: C2S.INPUT, mx, mz, yaw: input.yaw, pitch: input.pitch, jump: input.jump, crouch: input.crouch });
  }, 1000 / 20);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- menu wiring ----------------------------------------------------------
// Create/join go through the matchmaker (signaling); everything after (ready,
// start, and all gameplay) rides the peer link via session.send().
function wireMenu() {
  const nameEl = ui.el.name;
  document.getElementById('createBtn').addEventListener('click', () => {
    session.create(nameEl.value);
  });
  document.getElementById('joinBtn').addEventListener('click', () => {
    const room = ui.el.roomCode.value.toUpperCase().trim();
    if (!room) return ui.menuError('Enter a room code.');
    session.join(nameEl.value, room);
  });
  // Team pickers replace the Ready button: clicking a column IS readying up.
  // Clicking the team you're already on unpicks you.
  ui.el.teamHunters.addEventListener('click', () => pickTeam('hunter'));
  ui.el.teamProps.addEventListener('click', () => pickTeam('prop'));
  ui.el.startBtn.addEventListener('click', () => session.send({ t: C2S.START }));
}

function pickTeam(team) {
  const next = ui.myTeam === team ? null : team;
  session.send({ t: C2S.PICK_TEAM, team: next });
}

// Build a fresh Session and wire its callbacks. Sessions are single-use, so this
// runs at boot and again each time we return to the menu after a match ends.
function newSession() {
  session = new Session(state.cfg);
  session.onMessage = handleGameMessage;
  session.onStatus = handleStatus;
}

// ---- boot -----------------------------------------------------------------
(async function boot() {
  state.cfg = await loadConfig();
  newSession();
  wireMenu();
  startInputLoop();
  requestAnimationFrame(frame);
})();
