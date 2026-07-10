// Entry point. Wires DOM -> network -> scene, runs the render loop with light
// client-side prediction for the local player, and sends movement intent to the
// referee at a fixed rate. The referee stays authoritative; prediction only
// makes the local camera feel responsive.
//
// Since the P2P rebuild the "network" is a Session that hides whether we're the
// host (referee runs in this tab, replies are instant loopback) or a guest
// (referee is another player's tab, reached over a PeerJS DataConnection). This
// file is identical for both — it just calls session.send()/reads session.onMessage.
import { loadConfig } from './config.js';
import { Session } from './net.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { C2S, S2C, PHASE, ROLE } from '/shared/protocol.js';
// Physics is imported LAZILY (loadRapier pulls WASM from a CDN) — only referenced
// inside buildPredict(), which runs at match start, so a bare landing page still
// makes zero external requests (headless load check stays clean).
import { loadRapier, PhysicsWorld } from '/shared/physics.js';

const ui = new UI();
let session = null; // created in boot() once config is loaded
let editor = null; // lazily created on the first Ctrl+E (see editor.js)
const canvas = document.getElementById('view');
// scene.js pulls Three.js from a CDN, so it is imported LAZILY (built on the
// first match start, not at page load). That keeps a bare landing page free of
// external requests — the headless load check never triggers the CDN fetch. See
// ensureScene() and the STARTED handler.
let scene = null;
async function ensureScene() {
  if (!scene) {
    const { Scene3D } = await import('./scene.js');
    scene = new Scene3D(canvas);
    if (state.selfId) scene.setSelf(state.selfId);
  }
  return scene;
}
// The overlay covers the canvas, so it (not the canvas) is the element that
// actually receives the "click to play" click that requests pointer lock.
const input = new Input(canvas, ui.el.clickToPlay);

const state = {
  selfId: null,
  role: null,
  room: null, // current room code, for the shareable invite link
  phase: PHASE.LOBBY,
  cfg: null,
  map: null,
  mapId: null, // id of the active match's map (for the level editor default)
  lobbyMapId: null, // id currently picked in the lobby (editor default before a match)
  editing: false, // level editor open (gameplay render/predict stepped aside; see editor.js)
  editorPrevScreen: null, // screen to restore when the editor closes
  props: [], // authoritative prop instances for the active match
  self: { x: 0, y: 0, z: 0 }, // predicted local position (physics truth or 2D fallback)
  serverSelf: { x: 0, y: 0, z: 0 }, // last authoritative position for reconciliation
  movable: false,
  spawned: false, // snap to the authoritative spawn on the first snapshot
  bounds: 18,

  // ---- client-side prediction + reconciliation ----------------------------
  // predict: a LOCAL Rapier world holding just this player against the map's static
  //   geometry (walls/fixtures/props), so local movement predicts real collisions
  //   instantly. Null => Rapier unavailable => fall back to the flat 2D prediction.
  // seq/pending: an input history. Each predicted frame gets a seq; the host echoes
  //   the last seq it consumed as `ack`, and on each snapshot we rewind the local
  //   body to the authoritative state and REPLAY every unacked input — the textbook
  //   server-reconciliation loop. corr is a decaying visual offset so a correction
  //   eases in (small) or snaps (large) instead of popping.
  predict: null,
  seq: 0,
  pending: [], // [{ seq, mx, mz, yaw, jump, rotUnlock, dt }]
  corr: { x: 0, y: 0, z: 0 },
  SELF_ID: 'self', // stable id for the local player in the predict world

  // Disguise orientation lock (local view of our own model). While disguised, the
  // prop keeps the facing it had at disguise time unless right-click (rotUnlock) is
  // held. The referee is authoritative (it broadcasts our locked yaw to others);
  // this is just so our OWN third-person model matches instead of spinning.
  selfDisguised: false,
  selfDispYaw: 0,
};

// ---- action routing -------------------------------------------------------
input.onAction = (name) => {
  if (state.phase !== PHASE.HIDING && state.phase !== PHASE.HUNTING) return;
  if (name === 'primary') name = state.role === ROLE.HUNTER ? 'tag' : 'disguise';
  if (name === 'disguise') tryDisguise();
  if (name === 'tag') session.send({ t: C2S.TAG });
};

// Overlay visibility follows the browser's real pointer-lock state (input.js
// events), so it hides only once capture is confirmed and comes back on its
// own when the mouse is released (Esc, alt-tab) — clickable to re-capture.
input.onLockChange = (locked) => {
  if (state.editing) return; // editor owns the view; no "click to play" overlay
  const inGame = !ui.el.game.classList.contains('hidden');
  ui.setClickToPlay(inGame && !locked);
};
input.onLockError = (reason) => {
  if (state.editing) return;
  const inGame = !ui.el.game.classList.contains('hidden');
  if (inGame) ui.setClickToPlay(true, reason);
};
// Touch has no pointer lock: tapping the overlay dismisses it and NOW brings up
// the on-screen controls + joystick (deferred to here so the controls never sit
// on top of the "Tap to play" overlay and steal its tap). Audio is unlocked inside
// input.js's own tap handler — the one gesture iOS gives us.
input.onTouchPlay = () => {
  ui.setClickToPlay(false);
  input.enterGame();
};

// Optional view toggle (desktop V): flip third-person <-> first-person. Third-person
// is the default; this flips the camera, the own-model visibility, and the reticle
// behaviour together behind the scene's one flag.
input.onToggleView = () => {
  if (scene) scene.setThirdPerson(!scene.thirdPerson);
};

// Ctrl+E: toggle the in-game level editor (desktop debug tool). Available only in
// solo/local play — never mid-multiplayer (see canEnterEditor). Entering steps the
// client OUT of the game loop into a client-local sandbox that loads the map fresh;
// the referee/netcode are never touched. See editor.js.
input.onToggleEdit = () => {
  if (state.editing) exitEditor();
  else enterEditor();
};

// ---- screen wake lock ------------------------------------------------------
// Phones sleep the screen on their own; for the HOST that's fatal — the referee
// and the WebRTC links live in that tab, so a sleeping host ends the match for
// EVERYONE. Hold a wake lock while in a match and re-acquire it if the OS drops it
// (e.g. after a tab switch). Best-effort: unsupported browsers just skip it.
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* denied / unsupported — nothing we can do, don't block play */
  }
}
function releaseWakeLock() {
  try {
    if (wakeLock) wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  // The lock is auto-released when the tab is hidden; re-grab it on return if
  // we're still in a match.
  if (document.visibilityState === 'visible' && !ui.el.game.classList.contains('hidden')) acquireWakeLock();
});

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
      state.room = msg.room;
      if (scene) scene.setSelf(msg.id); // else applied when ensureScene() builds it
      ui.show('lobby');
      break;

    case S2C.LOBBY:
      state.room = msg.room;
      state.lobbyMapId = msg.mapId; // editor default target before a match starts
      ui.renderLobby(msg, state.selfId);
      if (msg.phase === PHASE.LOBBY) {
        // Persistent lobby: a round just ended (or we're joining fresh). If we were
        // in a match, return to the lobby screen WITHOUT reconnecting — peers stay
        // open, we just tidy the per-round view state.
        const wasInGame = !ui.el.game.classList.contains('hidden');
        state.phase = PHASE.LOBBY;
        if (wasInGame) {
          input.exitGame();
          releaseWakeLock();
          ui.setClickToPlay(false);
          resetReadyButton();
          destroyPredict();
          state.role = null;
          state.movable = false;
          state.spawned = false;
        }
        ui.show('lobby');
      }
      break;

    case S2C.STARTED: {
      state.mapId = msg.mapId;
      state.map = state.cfg.maps[msg.mapId];
      state.props = msg.props;
      // Client-side merge of any authored per-object prop `scale` onto the referee's
      // prop instances. The referee builds this.props by mapping map.props in order
      // (see referee.js), so msg.props[i] corresponds to state.map.props[i] on every
      // client — we zip the scale back on without any referee/protocol change. Inert
      // for every current map (none carry a scale); it lets an edited map's scaled
      // props RENDER at the authored scale once committed (scale is visual-only —
      // colliders stay base-size; shared/ is untouched). Fixtures read scale straight
      // from local map data in scene.js and need no merge.
      const mapProps = (state.map && state.map.props) || [];
      state.props.forEach((pi, i) => {
        const src = mapProps[i];
        if (src && src.scale) pi.scale = src.scale;
      });
      state.bounds = state.map.size / 2 - state.cfg.rules.mapMargin;
      state.spawned = false;
      // First time we need Three.js: build the renderer now (lazy CDN load). The
      // render catalog merges the disguise props with the static fixtures catalog
      // (kept in separate files so fixtures can't leak into the disguise pool) into
      // one type→shape/model lookup for scene.js. Fixture types are only ever
      // referenced by map.fixtures, so this merge never widens the disguise pool.
      const catalog = { ...state.cfg.props, ...state.cfg.fixtures };
      ensureScene().then((s) => s.buildWorld(state.map, state.props, catalog));
      // Stand up the local prediction world (real wall/prop collision for our own
      // movement). Fire-and-forget: until it resolves — or forever, if Rapier can't
      // load — the frame loop uses the flat 2D prediction. See buildPredict().
      buildPredict(state.map, state.props, catalog);
      ui.show('game');
      // Entering the game uncaptured. Desktop waits for the pointer-lock click;
      // touch shows a "Tap to play" prompt (dismissed by input.onTouchPlay) and
      // brings up the on-screen controls.
      if (input.touch) {
        // Controls are shown on the tap (input.onTouchPlay), not here — see there.
        ui.setClickToPlay(true, 'Tap to play');
        // A phone HOST that sleeps kills the match for everyone (referee lives in
        // this tab). Wake lock covers auto-sleep; warn about a manual lock too.
        if (session && session.isHost) ui.feed('You are hosting on a phone — keep this screen on, or the match ends for everyone.');
      } else {
        ui.setClickToPlay(!input.locked);
      }
      acquireWakeLock();
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
  } else if (kind === 'link') {
    // Diagnostic label: how a peer connected (direct vs relayed through TURN).
    ui.setLink(detail.id, detail.relayed);
  } else if (kind === 'closed') {
    backToMenu(detail || 'Disconnected.');
  }
}

// Return to the landing screen and arm a fresh Session so the player can start
// or join another match (a Session is single-use — it tears down its peer link
// and PeerJS connection when a match ends).
function backToMenu(msg) {
  state.selfId = null;
  state.role = null;
  state.room = null;
  state.phase = PHASE.LOBBY;
  state.movable = false;
  state.spawned = false;
  input.exitGame();
  releaseWakeLock();
  destroyPredict();
  resetReadyButton();
  ui.show('menu');
  if (msg) ui.menuError(msg);
  newSession();
}

// Reset the lobby ready toggle to its default. The referee clears server-side
// ready on resetToLobby; this keeps the local button label/state in step so a
// back-to-back round starts from "Ready", not a stale "Not ready".
function resetReadyButton() {
  ui.el.readyBtn._ready = false;
  ui.el.readyBtn.textContent = 'Ready';
}

function onSnapshot(msg) {
  state.phase = msg.phase;
  ui.setHud(msg);
  if (scene) {
    scene.syncPlayers(msg.players); // no-op until ensureScene() resolves
    if (msg.props) scene.syncProps(msg.props); // awake dynamic-prop transforms
  }
  const me = msg.players.find((p) => p.id === state.selfId);
  if (me) {
    state.serverSelf.x = me.x;
    state.serverSelf.y = me.y || 0;
    state.serverSelf.z = me.z;
    // Freeze the disguise facing at the moment we become disguised; after that the
    // frame loop holds it (or follows look while right-click is held).
    const nowDisguised = !!me.disguise;
    if (nowDisguised && !state.selfDisguised) state.selfDispYaw = input.yaw;
    state.selfDisguised = nowDisguised;
    const frozenHunter = state.role === ROLE.HUNTER && msg.phase === PHASE.HIDING;
    state.movable = me.alive && !frozenHunter && (msg.phase === PHASE.HIDING || msg.phase === PHASE.HUNTING);

    if (state.predict) {
      // Physics prediction path.
      if (!state.spawned) {
        // First snapshot of the match: hard-place the local body at spawn.
        state.predict.setPlayerPosition(state.SELF_ID, { x: me.x, y: me.y || 0, z: me.z });
        state.self.x = me.x;
        state.self.y = me.y || 0;
        state.self.z = me.z;
        state.pending = [];
        state.corr.x = state.corr.y = state.corr.z = 0;
        state.spawned = true;
      } else if (state.movable) {
        reconcilePredict(me); // rewind to authoritative + replay unacked inputs
      } else {
        // Frozen hunter / dead / between phases: pin to the authoritative pose, no
        // prediction to reconcile.
        state.predict.setPlayerPosition(state.SELF_ID, { x: me.x, y: me.y || 0, z: me.z });
        state.self.x = me.x;
        state.self.y = me.y || 0;
        state.self.z = me.z;
        state.pending = [];
        state.corr.x = state.corr.y = state.corr.z = 0;
      }
    } else {
      // 2D fallback: snap on spawn / when immovable; the frame loop nudges otherwise.
      if (!state.spawned) {
        state.self.x = me.x;
        state.self.z = me.z;
        state.self.y = 0;
        state.spawned = true;
      }
      if (!state.movable) {
        state.self.x = me.x;
        state.self.z = me.z;
        state.self.y = me.y || 0;
      }
    }
  }
}

function onEvent(msg) {
  switch (msg.kind) {
    case 'phase':
      if (msg.phase === PHASE.HIDING) ui.banner('HIDING PHASE — props, disguise now!', 2500);
      if (msg.phase === PHASE.HUNTING) ui.banner('HUNT! Hunters are loose.', 2500);
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
      ui.banner(`${msg.winner === ROLE.HUNTER ? 'HUNTERS' : 'PROPS'} WIN — ${won ? 'you won!' : 'you lost.'}`, 6000);
      break;
    }
  }
}

// ---- client-side prediction world -----------------------------------------
// Build the local prediction world for this match: the map's static geometry plus
// this one player, so our own movement collides for real and responds instantly.
// Async (Rapier WASM loads on demand). Guarded by a token so a match that ends
// mid-load is discarded. Any failure leaves state.predict null → 2D fallback.
let _predictToken = 0;
async function buildPredict(map, props, catalog) {
  destroyPredict(); // tears down any prior world and bumps _predictToken
  const token = _predictToken; // capture the post-teardown token to detect supersession
  let RAPIER;
  try {
    RAPIER = await loadRapier();
  } catch {
    return; // Rapier unavailable — the frame loop uses flat 2D prediction
  }
  if (token !== _predictToken) return; // superseded (match ended / new match)
  try {
    const world = new PhysicsWorld(RAPIER, map, props, catalog, { dynamicProps: false, rules: state.cfg.rules });
    world.addPlayer(state.SELF_ID, { x: state.self.x, y: state.self.y, z: state.self.z });
    state.predict = world;
  } catch {
    state.predict = null;
  }
}

function destroyPredict() {
  _predictToken++; // invalidate any buildPredict still awaiting Rapier
  if (state.predict) {
    state.predict.destroy();
    state.predict = null;
  }
  state.pending = [];
  state.corr.x = state.corr.y = state.corr.z = 0;
}

// Rewind + replay: on each authoritative snapshot, drop inputs the host has already
// applied (seq <= ack), teleport the local body to the authoritative state, then
// re-simulate every remaining input. The result is where our prediction SHOULD be
// given the host's truth — small residual eases in via corr, a big one snaps.
function reconcilePredict(me) {
  const w = state.predict;
  if (!w) return false;
  // Capture the CURRENTLY displayed position before the replay overwrites state.self,
  // so the correction offset preserves on-screen continuity (no visible pop).
  const dispX = state.self.x + state.corr.x;
  const dispY = state.self.y + state.corr.y;
  const dispZ = state.self.z + state.corr.z;
  const ack = Number.isFinite(me.ack) ? me.ack : 0;
  state.pending = state.pending.filter((p) => p.seq > ack);
  w.setPlayerPosition(state.SELF_ID, { x: me.x, y: me.y || 0, z: me.z });
  for (const p of state.pending) predictStep(p, p.dt);
  const now = w.getPlayer(state.SELF_ID);
  if (!now) return false;
  state.self.x = now.x;
  state.self.y = now.y;
  state.self.z = now.z;
  state.corr.x = dispX - now.x;
  state.corr.y = dispY - now.y;
  state.corr.z = dispZ - now.z;
  // Big correction (teleport, tag, hard desync): snap rather than slide across the map.
  if (Math.hypot(state.corr.x, state.corr.z) > 2.5 || Math.abs(state.corr.y) > 2.5) {
    state.corr.x = state.corr.y = state.corr.z = 0;
  }
  return true;
}

// Advance the prediction world by one input over dt and read back the local body.
function predictStep(input, dt) {
  const w = state.predict;
  if (!w) return;
  w.setPlayerInput(state.SELF_ID, { mx: input.mx, mz: input.mz, yaw: input.yaw, jump: input.jump });
  w.step(dt);
  const p = w.getPlayer(state.SELF_ID);
  if (p) {
    state.self.x = p.x;
    state.self.y = p.y;
    state.self.z = p.z;
  }
}

// ---- prediction + render loop ---------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Level editor owns the frame while open: it renders its own sandbox scene through
  // the shared renderer and ignores gameplay entirely (no predict, no game render).
  if (state.editing) {
    if (editor) editor.frame(dt);
    requestAnimationFrame(frame);
    return;
  }

  if (state.predict) {
    // Physics prediction: step our own body through the local Rapier world for this
    // frame's input, recording it for reconciliation. Real collide-and-slide against
    // walls/fixtures happens right here, with zero network latency.
    if (state.movable) {
      state.seq++;
      const { mx, mz } = input.moveVector();
      const inp = { seq: state.seq, mx, mz, yaw: input.yaw, jump: input.jump, rotUnlock: input.rotUnlock, dt };
      state.pending.push(inp);
      if (state.pending.length > 300) state.pending.shift(); // safety cap on the history
      predictStep(inp, dt); // advances state.self
    }
    // Decay the visual correction offset so a reconciliation eases out over a few
    // frames (y a touch faster so landings don't float).
    state.corr.x *= 0.85;
    state.corr.y *= 0.75;
    state.corr.z *= 0.85;
  } else if (state.movable) {
    // Flat 2D fallback prediction (Rapier not loaded): integrate + nudge toward the
    // authoritative position. Identical to the pre-physics behaviour.
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
    const speed = state.cfg.rules.moveSpeed;
    state.self.x += vx * speed * dt;
    state.self.z += vz * speed * dt;
    state.self.x = clamp(state.self.x, -state.bounds, state.bounds);
    state.self.z = clamp(state.self.z, -state.bounds, state.bounds);
    state.self.x += (state.serverSelf.x - state.self.x) * 0.08;
    state.self.z += (state.serverSelf.z - state.self.z) * 0.08;
    state.self.y = 0;
  }

  // Disguise orientation lock: keep the frozen facing unless right-click is held.
  if (!state.selfDisguised || input.rotUnlock) state.selfDispYaw = input.yaw;

  if (scene) {
    // Displayed position = predicted truth + the decaying correction offset.
    const disp = {
      x: state.self.x + state.corr.x,
      y: state.self.y + state.corr.y,
      z: state.self.z + state.corr.z,
    };
    scene.setCamera(disp, input.yaw, input.pitch, state.selfDispYaw);
    scene.interpolate(0.25);
    scene.render();
    // Drive the aim reticle off the referee's yaw-forward vector (where the tag
    // cone actually swings), not screen center — the third-person eye sits off the
    // player. Null => first-person, reticle stays centered.
    ui.setCrosshair(scene.aimScreenPoint(disp, input.yaw));
  }

  requestAnimationFrame(frame);
}

// Send movement intent to the referee at a fixed rate.
function startInputLoop() {
  setInterval(() => {
    if (state.editing) return; // editor sandbox: stay detached from the match loop
    if (!session || !session.ready) return;
    if (state.phase !== PHASE.HIDING && state.phase !== PHASE.HUNTING) return;
    const { mx, mz } = input.moveVector();
    // seq = the latest predicted-frame id; the host echoes it back as `ack` so we
    // know which inputs it has applied. jump/rotUnlock drive physics + the disguise
    // orientation lock.
    session.send({
      t: C2S.INPUT,
      seq: state.seq,
      mx,
      mz,
      yaw: input.yaw,
      pitch: input.pitch,
      jump: input.jump,
      rotUnlock: input.rotUnlock,
    });
  }, 1000 / 20);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- level editor (desktop debug tool) ------------------------------------
// The editor is a client-local sandbox: it never touches the referee, netcode, or
// match flow. It's gated to solo/local play so it can't disturb a live match, and
// entering steps the render loop out of gameplay into editor.frame() (see frame()).

// Only in solo/local play — never mid-multiplayer, never on touch (desktop tool).
function canEnterEditor() {
  if (input.touch) return false; // desktop-only debug tool
  if (!session) return true; // pre-session (landing) — a pure local sandbox
  if (!session.isHost && session.conn) return false; // we're a guest in someone's match
  if (session.isHost && session.conns && session.conns.size > 0) return false; // host WITH guests
  return true; // menu, solo host lobby, or a solo host match
}

// Which map the editor opens on: the active match's map, else the lobby's current
// pick, else the first map in the catalog.
function editorTargetMap() {
  const id = state.mapId || state.lobbyMapId || Object.keys(state.cfg.maps)[0];
  return { id, map: state.cfg.maps[id] };
}

function currentScreen() {
  for (const s of ['menu', 'lobby', 'game']) if (!ui.el[s].classList.contains('hidden')) return s;
  return 'menu';
}

async function enterEditor() {
  if (state.editing || state._enteringEditor || !state.cfg) return; // busy / not ready
  if (!canEnterEditor()) {
    ui.feed('Level editor is available only in solo/local play — not during a multiplayer match.');
    return;
  }
  state._enteringEditor = true; // guard the async gap (import + build) against double-enter
  try {
    await _enterEditorInner();
  } finally {
    state._enteringEditor = false;
  }
}

async function _enterEditorInner() {
  // ensureScene() guarantees the single WebGLRenderer exists (the editor renders its
  // own scene through it). Cheap no-op if a match already built the scene.
  const s = await ensureScene();
  if (!editor) {
    const { Editor } = await import('./editor.js');
    editor = new Editor(canvas, s.renderer, state.cfg);
    editor.setKeySource(() => input.keys); // fly camera reads the shared key set
    editor.onExit = () => exitEditor();
  }
  state.editorPrevScreen = currentScreen();
  const { id, map } = editorTargetMap();
  // Release any active pointer lock — the editor uses a free cursor (drag-to-look),
  // so a locked pointer from a solo match would leave no cursor for the editor UI.
  if (document.pointerLockElement) document.exitPointerLock();
  // Reveal the canvas; suppress the gameplay overlay/HUD (the editor has its own UI).
  input.exitGame(); // release touch controls (no-op on desktop)
  ui.setClickToPlay(false);
  ui.show('game');
  ui.el.hud.classList.add('hidden');
  ui.el.crosshair.classList.add('hidden');
  await editor.enter(id, map);
  state.editing = true;
}

function exitEditor() {
  if (!state.editing) return;
  state.editing = false;
  if (editor) editor.exit();
  // Restore whatever screen we came from (menu / lobby / game). We never stopped the
  // underlying solo match, so returning to 'game' simply resumes it.
  ui.show(state.editorPrevScreen || 'menu');
  if (state.editorPrevScreen === 'game') ui.setClickToPlay(!input.locked);
}

// ---- menu wiring ----------------------------------------------------------
// create()/join() hand off to PeerJS (the free public broker introduces the two
// browsers); everything after (ready, start, and all gameplay) rides the peer
// link via session.send().
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
  ui.el.readyBtn.addEventListener('click', () => {
    ui.el.readyBtn._ready = !ui.el.readyBtn._ready;
    session.send({ t: C2S.READY, ready: ui.el.readyBtn._ready });
    ui.el.readyBtn.textContent = ui.el.readyBtn._ready ? 'Not ready' : 'Ready';
  });
  ui.el.startBtn.addEventListener('click', () => session.send({ t: C2S.START }));
  // Map picker: the UI renders the list from the shared maps catalog and, when the
  // host taps a map, hands the choice back here to send as a C2S.PICK_MAP. The
  // referee is the gate (host-only, LOBBY-only, real map); we just relay the tap.
  ui.maps = state.cfg.maps;
  ui.onPickMap = (mapId) => session.send({ t: C2S.PICK_MAP, mapId });
  // Copy a one-click invite link (room code in the URL hash) so the host can
  // paste it in chat and friends just click to join.
  ui.el.copyLinkBtn.addEventListener('click', async () => {
    if (!state.room) return;
    const link = `${location.origin}${location.pathname}#${state.room}`;
    try {
      await navigator.clipboard.writeText(link);
      ui.lobbyHint('Invite link copied — paste it to your friends.');
    } catch {
      // Clipboard blocked (e.g. insecure context): show the link to copy by hand.
      ui.lobbyHint(link);
    }
  });
}

// Join-by-link: a shared URL carries the room code after a '#'. If present, drop
// it into the code field and auto-join so the friend really does "just click".
function tryJoinFromHash() {
  const code = (location.hash || '').replace(/^#/, '').toUpperCase().trim();
  if (!code) return;
  ui.el.roomCode.value = code;
  session.join(ui.el.name.value, code);
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
  tryJoinFromHash();
})();
