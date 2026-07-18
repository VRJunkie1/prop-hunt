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
import { Input, SENSITIVITY_RANGE } from './input.js';
import { UI } from './ui.js';
import { TauntLibrary } from './taunts.js';
import { HudTimer } from './hud-timer.js';
import { C2S, S2C, PHASE, ROLE } from '/shared/protocol.js';
// COMBAT SFX (B5): the shared prop-ouch pitch-by-size mapping — derives an ouch playbackRate from
// the SAME size the damage curve scales by, so pitch and damage can never disagree. See onEvent
// (kind:'hurt') + playPropOuch, and notes/combat-sfx.md.
import { ouchRateForDisguise, resolveDamageCfg } from '/shared/damage.js';
// Physics is imported LAZILY (loadRapier pulls WASM from a CDN) — only referenced
// inside buildPredict(), which runs at match start, so a bare landing page still
// makes zero external requests (headless load check stays clean).
import { loadRapier, PhysicsWorld } from '/shared/physics.js';

const ui = new UI();

// GAME TIMER DESYNC FIX (2026-07-18, VRmike). The HUD countdown is TICKED LOCALLY off this
// anchor and re-synced on every snapshot / phase event, so a snapshot stall can never freeze
// or drift the displayed clock more than one snapshot interval. Round END stays host-
// authoritative — the ticker clamps at 0 and waits for the host's phase/roundOver event. See
// js/hud-timer.js. nowMs() (below) is the shared performance.now() clock the frame loop uses.
const hudTimer = new HudTimer();

// HUNTER-TOOLS v1 — the hunter tool bar. Built for 4+ tools; two ship now. `id` is the
// internal tool key, `name` the label, `key` the on-screen/number-key hint. The rifle is
// the default. Only the FIRE event is networked (host-authoritative); which tool a hunter
// holds is NOT synced to other players in v1 (deliberate — the box is a no-op, so it'd be
// netcode for no payoff; the held-tool silhouette can come with a later tool that needs it).
const HUNTER_TOOLS = [
  { id: 'rifle', name: 'Assault Rifle', key: '1' },
  { id: 'finder', name: 'Prop Finder', key: '2' },
  { id: 'grenade', name: 'Grenade', key: '3' },
];

let session = null; // created in boot() once config is loaded
let editor = null; // lazily created on the first Ctrl+E (see editor.js)
// AUDIO TAUNTS: the lazy clip loader/cache (built in boot() from the manifest) and a timer that
// auto-hides the local player's stop button when their own taunt finishes on its own. See
// sendTaunt/onTaunt/updateTauntUi.
let taunts = null;
let _selfTauntTimer = null;
// PROP FINDER: timer that releases the local prop's taunt-UI lock when a finder-forced taunt ends,
// and the lazily-decoded denied-buzz AudioBuffer (played when a hunter clicks the finder while it
// is still cooling down). Loaded on first denial through the scene's shared audio context.
let _forcedTauntTimer = null;
let _finderDenyBuf = null;
let _finderDenyBufLoading = false;
// In-game debug MENU (js/debug.js) is now ON BY DEFAULT (2026-07-12, VRmike) — no ?debug=1
// needed. DEBUG below still reads ?debug=1 and controls the SEPARATE heavier features that
// flag has always driven: the collider wireframe overlay (read directly in scene.js), the
// per-peer ping traffic, and the referee's host-authoritative debug-command gate. So the two
// links genuinely differ — normal link = the menu; ?debug=1 = the menu PLUS collider
// wireframes + ping + accepted host debug commands. The menu itself constructs unconditionally
// (see boot()); every debugMenu hook stays null-guarded in case the lazy import ever fails.
const DEBUG = typeof URLSearchParams !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1';
let debugMenu = null; // set in boot() when DEBUG
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
    // Rules feed the ?debug=1 collider overlay so it mirrors thin-wall thickening exactly
    // (same rules.minWallHalfThickness the engine + guard use). Harmless when debug is off.
    scene.rules = state.cfg && state.cfg.rules ? state.cfg.rules : null;
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
  // Local-prediction grounded flag (read back from the predict world each step). While
  // AIRBORNE (a jump/fall) the vertical axis is owned by local prediction and NOT reconciled
  // against snapshots — see reconcilePredict for why (the first-person jump-judder fix).
  grounded: true,

  // Disguise orientation lock (local view of our own model). While disguised, the
  // prop keeps the facing it had at disguise time unless right-click (rotUnlock) is
  // held. The referee is authoritative (it broadcasts our locked yaw to others);
  // this is just so our OWN third-person model matches instead of spinning.
  selfDisguised: false,
  selfDispYaw: 0,

  // Crosshair-based disguise: the prop id currently under the aim ray (or null), set
  // each frame by the render loop and consumed by tryDisguise() on Action. See frame().
  aimPropId: null,

  // HUNTER-TOOLS v1: the hunter's currently selected tool (see HUNTER_TOOLS). The rifle fires,
  // the prop finder activates its AOE, the grenade throws. Defaults to the rifle. As of B7 the
  // SELECTION is reported to the host (C2S.SELECT_TOOL) so other players see the right item in
  // this hunter's hands on their third-person model; toolSynced is the last value we sent (so we
  // don't re-send it every snapshot). null → force a re-send (e.g. after becoming a hunter).
  tool: 'rifle',
  toolSynced: null,
  alive: true, // local player's authoritative alive flag (for the tool bar + spectator view)

  // PROP FINDER (hunter tool #2). finderCooldownUntil = performance.now() time this hunter's own
  // finder is ready again (0 = ready now); set optimistically on activation and reconciled by the
  // host's kind:'find' reply. Drives the on-button countdown + the AOE cylinder colour (green
  // ready / grey cooling) + the local denied buzz. Per-hunter (each client tracks only its own).
  finderCooldownUntil: 0,
  // AUDIO TAUNTS: while a finder-FORCED (uncancellable) taunt is playing on the LOCAL prop, their
  // taunt UI is locked — they can't start their own taunt until it finishes. Cleared by a timer
  // sized to the clip (onTaunt) and on any teardown. Gates tauntEligible / openTauntMenu.
  tauntLocked: false,

  // Pause menu overlay (Escape / ☰). paused === menu shown; hasLocked tracks whether the
  // pointer was ever captured this game (so the first unlock shows "Click to play", a later
  // unlock shows the pause menu). lastPlayers is the newest snapshot roster for the pause
  // scoreboard. The simulation is NEVER paused (multiplayer) — this only gates local input.
  paused: false,
  hasLocked: false,
  lastPlayers: null,

  // Desktop "UI mode" (backtick `). A deliberate THIRD state — not playing, not paused: the
  // pointer lock is released so the mouse is free to click the DEBUG menu / any UI, but the
  // pause menu is NOT opened and the "Click to play" overlay is suppressed. Clicking the game
  // canvas re-locks and clears this (via onLockChange); Esc opens pause (which also clears it).
  // Derived/reset from live state everywhere — never latched — so the click-to-play rule can
  // never see a stale value after the pointer re-locks. Desktop-only; always false on touch.
  uiMode: false,

  // AUDIO TAUNTS: the taunt menu is open. Like uiMode, this frees the desktop mouse (so the
  // scrolling list is clickable) WITHOUT opening the pause menu — onLockChange keys off it. It
  // also halts movement while open (input loop), and the frame/input loops keep running (the world
  // is live on the host). Always cleared when leaving a match / dying / phase-out. Touch never
  // needs the pointer-lock dance, but the flag still gates the same halt + overlay logic.
  tauntMenuOpen: false,

  // Debug FREE CAM (js/debug.js, ?debug=1 only). While true the render camera is flown
  // locally by the debug module and the physics player is frozen (no prediction, zeroed
  // movement sent), so the body stays put. Always false in normal play.
  freeCam: false,

  // SPECTATOR MODE (B6, 2026-07-18). A dead player spectates during an active phase: a free-flying
  // camera (mode:'fly') or orbiting a live player (mode:'follow', targetId = whom). Purely
  // client-side — the physics body stays dead/frozen on the host, nothing new goes over the wire.
  // Driven from the frame loop (updateSpectatorCamera) and toggled by setSpectating off the
  // authoritative alive flag. _prevJump edge-detects Space to snap follow → free-fly.
  spectate: { on: false, mode: 'fly', targetId: null, _prevJump: false },
};

// ---- action routing -------------------------------------------------------
input.onAction = (name) => {
  if (state.phase !== PHASE.HIDING && state.phase !== PHASE.HUNTING) return;
  // SPECTATOR (B6): a dead player has no fire/disguise — their primary (left-click / ACTION)
  // cycles the spectator camera between live players and back to free-fly. See spectateCycle.
  if (state.spectate.on) { if (name === 'primary') spectateCycle(1); return; }
  // HUNTER-TOOLS v1: a hunter's primary action fires the selected tool (rifle shoots; the
  // prop finder activates its AOE); a prop's primary disguises. The old instant 'tag' melee is
  // SUPERSEDED by the rifle + health system and fully unwired (client + referee) so it can't
  // bypass health (an instant-kill path would defeat the whole damage model).
  if (name === 'primary') name = state.role === ROLE.HUNTER ? 'fire' : 'disguise';
  if (name === 'disguise') tryDisguise();
  if (name === 'fire') tryFire();
};

// PC PAUSE POLICY (2026-07-13, VRmike): ONLY an explicit Escape pauses on desktop. Losing
// pointer lock by itself — Alt-Tab, the Windows key, or clicking another window — must NOT pause
// or blur; the game keeps rendering and simply stops turning the camera (the mouse is uncaptured)
// until the player clicks back in. The sneaky browser fact this hinges on: pressing Escape while
// the mouse is captured does NOT arrive as a keypress — it arrives as "pointer lock lost". The
// reliable tell to separate the two: Escape releases the lock while the game window KEEPS focus;
// an ambient focus loss releases it WITHOUT focus. So the pause decision is built on
// document.hasFocus() at unlock time (with a very-recent-blur backstop for browsers that fire
// pointerlockchange a tick before focus settles).
let _lastWindowBlurAt = -1e9;
if (typeof window !== 'undefined') {
  window.addEventListener('blur', () => { _lastWindowBlurAt = nowMs(); });
}
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
// True when a pointer-lock LOSS was an explicit Escape (window still focused), not an ambient
// focus change (Alt-Tab / Windows key / other-window click).
function unlockWasEscape() {
  const hasFocus = (typeof document !== 'undefined' && typeof document.hasFocus === 'function')
    ? document.hasFocus() : true;
  const recentlyBlurred = (nowMs() - _lastWindowBlurAt) < 250; // a focus change just happened
  return hasFocus && !recentlyBlurred;
}

// Overlay visibility follows the browser's real pointer-lock state (input.js events).
// In-game unlocked states, in priority order:
//   - UI mode (backtick)                       -> no overlay (free mouse, deliberate);
//   - ambient focus loss (Alt-Tab / Win key)   -> NOTHING: no pause, no blur, keep rendering;
//   - explicit Escape after playing            -> the PAUSE MENU (Escape's job);
//   - never captured yet this session          -> the "Click to play" prompt (first entry).
// Locking (or Resume) hides both overlays. The world keeps running underneath either way — the
// pause menu is an overlay, not a real pause (multiplayer). See openPause()/closePause().
input.onLockChange = (locked) => {
  if (state.editing) return; // editor owns the view; no overlay
  const inGame = !ui.el.game.classList.contains('hidden');
  if (locked) {
    state.hasLocked = true;
    state.uiMode = false; // re-locked (incl. clicking the canvas from UI mode) -> leave UI mode
    closePause(false); // re-locked -> drop the pause overlay
    ui.setClickToPlay(false);
    return;
  }
  if (!inGame || input.touch) return;
  if (state.uiMode) { ui.setClickToPlay(false); return; }
  // Taunt menu open: the mouse was freed on purpose (to click the list) — like UI mode, show no
  // overlay and don't open pause. Closing the menu (✕ / T / Esc) re-locks via closeTauntMenu.
  if (state.tauntMenuOpen) { ui.setClickToPlay(false); return; }
  // Ambient focus loss (the mouse got freed because the window lost focus, NOT because Escape
  // was pressed): do nothing visible — no pause, no overlay, no blur. The game keeps rendering;
  // the camera just stops turning (mouse uncaptured). Clicking the canvas re-locks and resumes
  // exactly where we were. Only an EXPLICIT Escape (or the never-captured first entry) shows UI.
  if (state.hasLocked && !unlockWasEscape()) { ui.setClickToPlay(false); return; }
  if (state.hasLocked) openPause(); // explicit Escape after playing -> pause menu
  else ui.setClickToPlay(true); // haven't captured yet -> the entry prompt
};
input.onLockError = (reason) => {
  if (state.editing) return;
  const inGame = !ui.el.game.classList.contains('hidden');
  if (inGame && !state.paused && !state.uiMode) ui.setClickToPlay(true, reason);
};
// UI mode (backtick) + Esc-in-UI-mode routing. See enterUiMode()/exitUiMode() below.
input.onToggleUiMode = () => {
  if (input.touch) return;
  if (state.uiMode) exitUiMode(true); // ` again -> re-lock and resume
  else enterUiMode();
};
// Esc arrives here ONLY while the pointer is already free (UI mode, the pause menu open, or the taunt
// menu open) — when the mouse is captured the browser eats Esc to release the lock and pause opens via
// the onLockChange path above instead. Derive the action from live state so open/close stays consistent
// across both routes (the "derive, don't latch" rule): Esc closes the taunt menu, toggles the pause menu
// shut if it's up, otherwise opens pause. Each close re-locks the pointer (this keypress is a user
// gesture, so the re-lock request is allowed).
input.onRequestPause = () => {
  if (state.tauntMenuOpen) { closeTauntMenu(true); return; } // Esc closes the taunt menu + re-locks
  if (state.paused) { closePause(true); return; }            // Esc toggles the pause menu closed + re-locks
  openPause();                                               // otherwise Esc opens the pause menu
};

// ---- pause menu (Escape / on-screen button) -------------------------------
// A menu OVERLAY — it does NOT pause the simulation (multiplayer: the world runs on the
// host). Escape releases the pointer lock (browser-native) which opens this via onLockChange;
// the on-screen ☰ button opens it on touch (no pointer lock there). Contents live in ui.js:
// a live scoreboard (everyone + health), a controls/help panel, Resume, and Exit. While open
// we send ZEROED movement so the avatar holds still at the menu (see the input loop + frame).
function openPause() {
  const inGame = !ui.el.game.classList.contains('hidden');
  if (state.paused || !inGame || state.editing) return;
  state.uiMode = false; // pause takes over from UI mode (the two are mutually exclusive)
  if (state.tauntMenuOpen) { state.tauntMenuOpen = false; ui.closeTauntMenu(); } // pause supersedes it
  state.paused = true;
  if (document.pointerLockElement) document.exitPointerLock(); // release the mouse (no-op on touch)
  ui.setClickToPlay(false);
  ui.setPauseRoom(state.room); // room code + copy button, for adding players mid-game
  // Pass our OWN role so a HUNTER's pause roster hides prop disguises (client half of the leak fix;
  // the host also withholds disguised props' names from hunters — hunterSafeSnapshot).
  ui.showPause(state.lastPlayers || [], state.selfId, state.role === ROLE.HUNTER);
}
function closePause(relock) {
  if (!state.paused) return;
  state.paused = false;
  ui.hidePause();
  const inGame = !ui.el.game.classList.contains('hidden');
  if (inGame && !input.touch) {
    if (relock) canvas.requestPointerLock(); // Resume re-locks (a user gesture)
    else ui.setClickToPlay(!input.locked);
  }
}
// ---- desktop "UI mode" (backtick `) ---------------------------------------
// A deliberate THIRD state (not playing, not paused): release the pointer lock so the mouse is
// free to click the DEBUG button / open debug panel / any UI, WITHOUT opening the pause menu and
// WITHOUT the "Click to play" overlay (both are suppressed off state.uiMode — the overlay rule in
// onLockChange keys off it, not off whichever event fired last). Clicking the game canvas re-locks
// and clears uiMode via onLockChange; Esc opens the pause menu (openPause clears it too). A click
// on the debug panel/buttons targets that DOM element (which sits above the canvas), so it neither
// re-locks nor punches through to a shot. The re-lock click can't fire the rifle either: the
// canvas mousedown handler is gated on `this.locked`, which is false until the lock actually
// engages. Desktop-only; a no-op on touch (no pointer lock, and the ` key never reaches here).
function enterUiMode() {
  const inGame = !ui.el.game.classList.contains('hidden');
  if (state.uiMode || state.paused || state.editing || !inGame || input.touch) return;
  state.uiMode = true; // set BEFORE releasing lock so the onLockChange(false) handler sees it
  if (document.pointerLockElement) document.exitPointerLock(); // free the mouse — no pause menu
  ui.setClickToPlay(false); // deliberate free-mouse state: never show the entry overlay
  ui.feed('UI mode: mouse freed for debug/menus. Click the game to resume (` to toggle).');
}
function exitUiMode(relock) {
  if (!state.uiMode) return;
  state.uiMode = false;
  const inGame = !ui.el.game.classList.contains('hidden');
  if (relock && inGame && !input.touch) canvas.requestPointerLock(); // resume play (a user gesture)
  else if (inGame && !input.touch) ui.setClickToPlay(!input.locked); // derive the overlay from live lock
}

// Touch has no pointer lock: tapping the overlay dismisses it and NOW brings up
// the on-screen controls + joystick (deferred to here so the controls never sit
// on top of the "Tap to play" overlay and steal its tap). Audio is unlocked inside
// input.js's own tap handler — the one gesture iOS gives us.
input.onTouchPlay = () => {
  ui.setClickToPlay(false);
  input.enterGame();
};

// Optional view toggle (desktop V): flip third-person <-> first-person. Flips the
// camera and the own-model visibility behind the scene's one flag. A debug/preference
// override on top of the role default below (a hunter can peek at their own soldier).
input.onToggleView = () => {
  if (scene) scene.setThirdPerson(!scene.thirdPerson);
};

// Role-driven view. HUNTERS are FIRST-PERSON: camera at their eye looking along
// yaw/pitch, and their own body is NOT drawn to themselves (remote players still see
// the full animated third-person soldier — see scene.meshForPlayer). PROPS stay
// THIRD-PERSON so they can see the disguise they're wearing. Called on the ROLE
// message and again after buildWorld (role can arrive before the scene exists).
function applyRoleView() {
  const isProp = state.role === ROLE.PROP;
  if (scene) {
    scene.setThirdPerson(state.role !== ROLE.HUNTER);
    // Move the aim RAY 66% up the screen for props (clears their own body), dead-centre
    // for hunters — and flip the visible reticle to the same spot so ray + crosshair agree.
    scene.setAimMode(isProp);
  }
  ui.el.crosshair.classList.toggle('prop-aim', isProp);
}

// ROLE — authoritative-and-acknowledged (2026-07-18, VRmike). ONE place that applies "you are
// a hunter/prop" to the local client: the HUD role pill, the role-driven view (first-person
// hunter / third-person prop), and the tool bar / viewmodel. Called from BOTH rails that carry
// the role now: the private S2C.ROLE announcement (below) AND the per-snapshot self-heal in
// onSnapshot (which converges to the host's `hunter` flag if the one-time ROLE message was ever
// missed or applied at the wrong moment during a round flip / team switch / mid-join). Does NOT
// touch state.alive — alive is owned by the snapshot (ROLE's caller sets it explicitly on a
// fresh spawn). Idempotent, so re-applying the same role is a cheap no-op.
function applyRole(role) {
  state.role = role;
  ui.setRole(role);
  applyRoleView(); // hunters go first-person (own body hidden); props stay third-person
  applyToolView(); // hunter tool bar + held tool, or hidden for a prop; also refreshes the taunt button
}

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

// CROSSHAIR-BASED DISGUISE (was nearest-prop). Target = the disguisable prop the
// player is AIMING AT, not whichever is closest. The frame loop raycasts from the
// player along the look direction each frame (scene.aimedDisguiseTarget), highlights the
// hit prop, and stores its id in state.aimPropId; pressing Action disguises as THAT prop.
// Identical on desktop (mouse aim) and mobile (screen-centre crosshair) since both feed
// the same yaw/pitch. Only target SELECTION changed — the host's applyDisguise (range +
// disguisable check from the player's position) is untouched and remains authoritative.
function tryDisguise() {
  if (state.role !== ROLE.PROP) return;
  const id = state.aimPropId;
  if (id != null) session.send({ t: C2S.DISGUISE, propId: id });
  else ui.feed('No prop targeted — aim at a prop and press Action.');
}

// HUNTER-TOOLS v1: fire the selected tool. Only the assault rifle does anything; the prop
// finder is a deliberate no-op. We send just the camera-forward AIM direction (the SAME
// screen-centre ray the disguise pick uses) — the HOST re-runs the shot against its
// authoritative world, decides the hit + damage, and broadcasts the tracer to everyone.
function tryFire() {
  if (state.role !== ROLE.HUNTER || !state.movable || state.paused || state.uiMode) return;
  if (state.tool === 'finder') { tryFinder(); return; } // the finder tool activates instead of firing
  if (state.tool === 'grenade') { tryGrenade(); return; } // the grenade throws instead of firing
  if (state.tool !== 'rifle') return;
  const dir = scene && scene.aimDirection ? scene.aimDirection() : null;
  if (!dir) return;
  session.send({ t: C2S.SHOOT, dx: dir.x, dy: dir.y, dz: dir.z });
  lastFireAt = performance.now(); // paces the hold-to-fire auto-repeat (see frameBody)
}

// HUNTER GRENADES (hunter tool #3): throw a grenade (LEFT-CLICK on PC / the fire button on mobile
// while the grenade is selected). Like the rifle, we send ONLY the camera-forward AIM direction —
// the HOST raycasts it, explodes at the first hit, and resolves all damage + the backfire /
// redemption. NO COOLDOWN (balanced by risk), and it never auto-repeats on a held click (only the
// rifle does — see frameBody), so one throw per press. The explosion flash arrives as a broadcast
// kind:'grenade' event for everyone (see onEvent), so we don't draw anything optimistically here.
function tryGrenade() {
  if (state.role !== ROLE.HUNTER || !state.movable || state.paused || state.uiMode) return;
  const dir = scene && scene.aimDirection ? scene.aimDirection() : null;
  if (!dir) return;
  if (scene && scene.unlockAudio) scene.unlockAudio(); // iOS: keep audio warm in the gesture
  session.send({ t: C2S.GRENADE, dx: dir.x, dy: dir.y, dz: dir.z });
}

// PROP FINDER cooldown (ms) — the SAME per-hunter cooldown the host enforces (rules.finderCooldownSeconds).
function finderCooldownMs() {
  const r = state.cfg && state.cfg.rules;
  const s = r && r.finderCooldownSeconds;
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : 20000;
}
function finderRadius() {
  const r = state.cfg && state.cfg.rules;
  const v = r && r.finderRadius;
  return Number.isFinite(v) && v > 0 ? v : 8;
}

// PROP FINDER: activate the finder (LEFT-CLICK on PC / the fire button on mobile while the finder is
// selected). If the local cooldown is still running, play the short denied buzz and DON'T send. Else
// tell the host (which is the authority — it re-checks the cooldown, finds the in-range props, and
// forces their taunts) and start the on-button countdown optimistically; the host's kind:'find'
// reply reconciles the exact remaining time.
function tryFinder() {
  if (state.role !== ROLE.HUNTER || !state.movable || state.paused || state.uiMode) return;
  const now = performance.now();
  if (now < state.finderCooldownUntil) { playFinderDenied(); return; }
  state.finderCooldownUntil = now + finderCooldownMs(); // optimistic; host reply reconciles
  if (scene && scene.unlockAudio) scene.unlockAudio(); // iOS: keep audio warm in the gesture
  session.send({ t: C2S.FIND });
}

// PROP FINDER: play the short, quiet synthesized "denied" buzz (our own generated WAV — NOT a ripped
// Windows sound) for a click during cooldown. Lazily fetch+decode it once through the scene's shared
// audio context, then play it non-positionally. Silent if audio/asset is unavailable.
function playFinderDenied() {
  if (!scene) return;
  if (scene.unlockAudio) scene.unlockAudio(); // this runs from a click/tap gesture — keep iOS audio warm
  if (_finderDenyBuf) { scene.playUiSound(_finderDenyBuf, 0.5); return; }
  if (_finderDenyBufLoading || !scene.loadAudioBuffer) return;
  _finderDenyBufLoading = true;
  scene.loadAudioBuffer('/assets/finder/deny.wav').then((buf) => {
    _finderDenyBufLoading = false;
    if (buf) { _finderDenyBuf = buf; scene.playUiSound(buf, 0.5); }
  });
}

// ---- COMBAT SFX (B5, VRmike 2026-07-18) -----------------------------------
// Four synthesized combat sounds (our own generator scripts under tools/, NOT ripped): a rifle
// GUNSHOT, a grenade BLAST, a finder activation PING, and ONE shared prop OUCH (pitch-shifted by prop
// size). All are lazily fetch+decoded ONCE through the scene's shared audio context (like the finder
// deny buzz) and played through the existing audio graph — the gunshot/grenade/ouch positionally
// (inverse-square + HRTF), routed through the SAME AudioListener → master limiter as taunts; the
// shooter's own gunshot plainly/close (non-positional). Everything is fail-silent: no audio backend
// (headless / pre-tap iOS) => every one of these no-ops. Per-source gains are modest so the master
// limiter stays a safety net, not the mixer. See notes/combat-sfx.md.
const COMBAT_SFX = {
  gunshot: { url: '/assets/combat/gunshot.wav', buf: null, loading: false },
  grenade: { url: '/assets/combat/grenade.wav', buf: null, loading: false },
  ouch: { url: '/assets/combat/ouch.wav', buf: null, loading: false },
  finderPing: { url: '/assets/finder/ping.wav', buf: null, loading: false },
};

// Lazily decode a combat clip once (cached), then hand the buffer to `cb`. Silent no-op if audio /
// the asset is unavailable (never throws). Mirrors playFinderDenied's lazy-load pattern.
function _withCombatSfx(key, cb) {
  const s = COMBAT_SFX[key];
  if (!s || !scene || !scene.loadAudioBuffer) return;
  if (s.buf) { cb(s.buf); return; }
  if (s.loading) return;
  s.loading = true;
  scene.loadAudioBuffer(s.url).then((buf) => {
    s.loading = false;
    if (buf) { s.buf = buf; cb(buf); }
  });
}

// Play a combat clip POSITIONALLY at world point `pos` (through the inverse-square + HRTF path).
function playCombatSoundAt(key, pos, volume, rate) {
  if (!scene || !pos) return;
  _withCombatSfx(key, (buf) => {
    if (scene.playPositionalSound) {
      scene.playPositionalSound(pos, buf, { volume, rate, mapSize: state.map && state.map.size });
    }
  });
}

// Play a combat clip NON-positionally/close (the shooter's own gunshot) — a flat 2D blip through the
// same listener/limiter, same path as the finder deny buzz.
function playCombatSound2D(key, volume) {
  if (!scene) return;
  _withCombatSfx(key, (buf) => { if (scene.playUiSound) scene.playUiSound(buf, volume); });
}

// PROP OUCH: a prop PLAYER took a real hit (rifle or grenade) — play the ONE shared ouch at the prop,
// PITCH-SHIFTED by its disguise size. The rate comes from ouchRateForDisguise over the SAME merged
// catalog + damage-size anchors the referee's damage math uses, so pitch and damage always agree about
// how big the prop is: tiny burger => high squeak, big fridge/table => low groan, undisguised => 1.0.
function playPropOuch(victim) {
  if (!victim) return;
  const catalog = scene && scene.catalog; // merged props+fixtures set in buildWorld
  const dcfg = resolveDamageCfg(state.cfg && state.cfg.rules && state.cfg.rules.damage);
  const rate = ouchRateForDisguise(victim.disguise, catalog, { smallSize: dcfg.smallSize, largeSize: dcfg.largeSize });
  // Emit at the prop's snapshot position, lifted ~1 unit so it reads at body height (like taunts).
  const pos = { x: victim.x, y: (victim.y || 0) + 1.0, z: victim.z };
  playCombatSoundAt('ouch', pos, 0.7, rate);
}

// PROP FINDER: reflect the finder cooldown onto its tool button ("Finder (14s)") and drive the AOE
// zone cylinder (visible + green ready / grey cooling) while a live hunter holds the finder. Called
// every frame from the render loop with the hunter's displayed position.
function updateFinderHud(now, disp) {
  const liveHunter = state.role === ROLE.HUNTER && state.alive;
  const remainMs = Math.max(0, state.finderCooldownUntil - now);
  ui.setToolCooldown('finder', remainMs / 1000);
  if (scene && scene.updateFinderZone) {
    scene.updateFinderZone({
      visible: liveHunter && state.tool === 'finder' && state.movable,
      ready: remainMs <= 0,
      radius: finderRadius(),
      pos: disp,
    });
  }
}

// ---- audio taunts (props) -------------------------------------------------
// A living prop may taunt in any active phase (a prop taunting while hiding only snitches on
// itself — that's the point). The menu is a UI-mode-like overlay: opening it frees the desktop
// mouse so the scrolling list is clickable, without opening pause. It STAYS open across picks so
// spamming is easy; the ✕ / T / Escape close it.
function tauntEligible() {
  const inGame = !ui.el.game.classList.contains('hidden');
  return inGame && !state.editing && state.role === ROLE.PROP && state.alive
    && (state.phase === PHASE.HIDING || state.phase === PHASE.HUNTING);
}
function openTauntMenu() {
  if (state.tauntMenuOpen || state.paused || state.tauntLocked || !tauntEligible()) return;
  state.tauntMenuOpen = true;
  state.uiMode = false; // the two free-mouse states are mutually exclusive
  if (!input.touch && document.pointerLockElement) document.exitPointerLock(); // free the mouse
  ui.setClickToPlay(false);
  if (scene && scene.unlockAudio) scene.unlockAudio(); // iOS: resume audio inside this gesture
  ui.openTauntMenu(); // reveals the list + kicks the background prefetch (onTauntPrefetch)
}
function closeTauntMenu(relock = true) {
  if (!state.tauntMenuOpen) return;
  state.tauntMenuOpen = false;
  ui.closeTauntMenu();
  const inGame = !ui.el.game.classList.contains('hidden');
  if (relock && inGame && !input.touch && !state.paused) canvas.requestPointerLock();
  else if (inGame && !input.touch && !state.paused) ui.setClickToPlay(!input.locked);
}

// Relay a taunt pick to the host (host-authoritative — it validates we're a living prop and the id
// is real, then broadcasts to everyone). The menu is left OPEN by design. Unlocks audio in the
// same gesture (the pick is a pointerdown / keypress).
function sendTaunt(id) {
  if (state.tauntLocked || !tauntEligible()) return; // finder-forced taunt locks self-taunting
  if (!taunts || !taunts.has(id)) return;
  if (scene && scene.unlockAudio) scene.unlockAudio();
  session.send({ t: C2S.TAUNT, id });
}

// Reflect taunt-related UI (the taunt button visibility) from live role/phase/alive. Called from
// applyToolView (role/alive/scene rebuild) and the phase event. When the player can no longer
// taunt (died / became a hunter / round ended), also tear the menu + stop button down.
function updateTauntUi() {
  const ok = tauntEligible();
  ui.setTauntButton(ok);
  if (!ok) {
    closeTauntMenu(false); // no re-lock: we're leaving the taunt-able state
    ui.setTauntStop(false);
    if (_selfTauntTimer) { clearTimeout(_selfTauntTimer); _selfTauntTimer = null; }
    // PROP FINDER: release any forced-taunt lock too (died / became a hunter / round ended).
    if (state.tauntLocked || _forcedTauntTimer) {
      if (_forcedTauntTimer) { clearTimeout(_forcedTauntTimer); _forcedTauntTimer = null; }
      setTauntLocked(false);
    }
  }
}

// A taunt event arrived (from the host relay). Play the clip as 3D positional audio at the taunter's
// live position; lazy-load + cache the buffer on first use. For OUR OWN taunt, show the stop button
// (unless the finder tool forced it uncancellable) and auto-hide it when the clip ends.
async function onTaunt(msg) {
  if (!scene || !taunts) return;
  const buf = await taunts.load(msg.id);
  if (!buf) return; // clip unavailable → silence (never breaks the game); nothing to stop
  scene.playTaunt(msg.by, buf, { mapSize: state.map && state.map.size });
  if (msg.by === state.selfId) {
    if (_selfTauntTimer) { clearTimeout(_selfTauntTimer); _selfTauntTimer = null; }
    if (msg.uncancellable) {
      // PROP FINDER forced this taunt: our stop button can't kill it AND we can't start our own
      // taunt until it finishes — LOCK the taunt UI for the clip's duration, then auto-release.
      ui.setTauntStop(false);
      setTauntLocked(true);
      if (_forcedTauntTimer) clearTimeout(_forcedTauntTimer);
      const lockMs = (buf.duration || 1) * 1000 + 200;
      _forcedTauntTimer = setTimeout(() => { setTauntLocked(false); _forcedTauntTimer = null; }, lockMs);
    } else {
      ui.setTauntStop(true);
      const ms = (buf.duration || 1) * 1000 + 250;
      _selfTauntTimer = setTimeout(() => { ui.setTauntStop(false); _selfTauntTimer = null; }, ms);
    }
  }
}

// PROP FINDER: lock/unlock the local prop's taunt UI while a forced (uncancellable) taunt plays.
// While locked the prop can't open the menu or start a taunt; the button greys out (ui.setTauntLocked).
function setTauntLocked(locked) {
  state.tauntLocked = !!locked;
  ui.setTauntLocked(!!locked);
  if (locked && state.tauntMenuOpen) closeTauntMenu(false);
}

// A stop event arrived: kill that player's taunt everywhere. If it's ours, hide our stop button.
function onTauntStop(msg) {
  if (scene && scene.stopTaunt) scene.stopTaunt(msg.by);
  if (msg.by === state.selfId) {
    ui.setTauntStop(false);
    if (_selfTauntTimer) { clearTimeout(_selfTauntTimer); _selfTauntTimer = null; }
  }
}

// RAPID FIRE cadence (ms between shots) the CLIENT paces its held-fire auto-repeat off —
// the SAME rounds-per-minute the host caps with (rules.fireRateRpm). Damage/bullet is
// unchanged (host-side). Falls back to the legacy cooldown if rpm is absent.
let lastFireAt = 0;
function fireIntervalMs() {
  const r = state.cfg && state.cfg.rules;
  if (r && r.fireRateRpm > 0) return 60000 / r.fireRateRpm;
  return (r && r.fireCooldownMs) || 250;
}

// Select a hunter tool by id (from the tool bar or a number key). Hunters only; updates
// the first-person viewmodel + tool-bar highlight. Purely local (not networked in v1).
function selectTool(id) {
  if (state.role !== ROLE.HUNTER) return;
  if (!HUNTER_TOOLS.some((t) => t.id === id)) return;
  state.tool = id;
  applyToolView();
}

// Reflect the current role/tool/alive state into the first-person viewmodel + tool bar.
// A LIVE hunter sees the tool bar (current tool highlighted) and holds the tool's
// viewmodel (rifle or box); props / dead players see neither. Called on role, tool change,
// each snapshot (alive can flip), and after buildWorld rebuilds the scene.
function applyToolView() {
  const liveHunter = state.role === ROLE.HUNTER && state.alive;
  if (scene && scene.setViewModel) scene.setViewModel(liveHunter ? state.tool : null);
  ui.setToolbar(liveHunter, state.tool);
  updateTauntUi(); // AUDIO TAUNTS: the taunt button follows role/alive (props only) as well
  syncSelectedTool(); // B7: report the held tool to the host so others see it on our model
}

// HELD-TOOL VISIBILITY (B7). Tell the host which tool we hold so it rebroadcasts it in our
// snapshot entry and other players render the right item in our hands. Sent only for a LIVING
// HUNTER and only when the value CHANGES (deduped via state.toolSynced), so this is safe to call
// from applyToolView every snapshot without spamming the wire. When we're not a live hunter we
// clear toolSynced so becoming a hunter again re-sends the current tool (the host reset us to
// rifle on our fresh spawn; our local state may differ). Purely cosmetic — no gameplay effect.
function syncSelectedTool() {
  const liveHunter = state.role === ROLE.HUNTER && state.alive;
  if (!liveHunter) { state.toolSynced = null; return; }
  if (state.toolSynced === state.tool) return;
  if (session && session.send) {
    session.send({ t: C2S.SELECT_TOOL, tool: state.tool });
    state.toolSynced = state.tool;
  }
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
          hudTimer.stop(); // no HUD countdown in the lobby; a stale anchor mustn't paint
          state.paused = false;
          state.hasLocked = false;
          state.uiMode = false; // never carry the free-mouse state across rounds
          ui.hidePause();
          ui.setClickToPlay(false);
          ui.setBlindfold(false); // drop any hunter blindfold on the way back to the lobby
          input.lookFrozen = false;
          state.aimPropId = null;
          // HUNTER-TOOLS v1: tidy the tool bar / spectator / tool state for the next round.
          ui.setToolbar(false);
          setSpectating(false);
          state.tool = 'rifle';
          state.toolSynced = null; // B7: re-sync the held tool next time we're a live hunter
          state.alive = true;
          resetFinderState(); // PROP FINDER: cooldown/zone/lock reset to ready between rounds
          resetDebugView(); // drop free cam / focus box between rounds
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
      // HIDE-SPOT REMOVAL: indices into map.fixtures the host deleted this match. The client
      // renders fixtures + builds their static colliders from its LOCAL map data, so it must
      // drop exactly these indices from BOTH (scene scenery mesh AND predict-physics collider)
      // or a removed built-in would linger as scenery / an invisible wall. Older hosts omit it.
      state.removedFixtures = msg.removedFixtures || [];
      // Client-side merge of any authored per-object prop `scale` onto the referee's
      // prop instances. Each prop instance carries `mi` = its source index in
      // state.map.props (the referee stamps it), so we zip the authored scale back on by
      // ORIGINAL index — robust even though map randomization skipped some props (a plain
      // positional zip would misalign after a skip). No referee/protocol change beyond the
      // already-present `mi`. Inert for every current map (none carry a scale); it lets an
      // edited map's scaled props RENDER at the authored scale once committed (scale is
      // visual-only — colliders stay base-size; shared/ is untouched). Fixtures read scale
      // straight from local map data in scene.js and need no merge.
      const mapProps = (state.map && state.map.props) || [];
      state.props.forEach((pi) => {
        const src = Number.isInteger(pi.mi) ? mapProps[pi.mi] : null;
        if (src && src.scale) pi.scale = src.scale;
      });
      state.bounds = state.map.size / 2 - state.cfg.rules.mapMargin;
      state.spawned = false;
      state.uiMode = false; // fresh match starts uncaptured, not in the free-mouse state
      // PROP FINDER: a fresh match starts with the finder ready (no stuck grey cylinder / countdown)
      // and no forced-taunt lock carried across rounds.
      resetFinderState();
      // First time we need Three.js: build the renderer now (lazy CDN load). The
      // render catalog merges the disguise props with the static fixtures catalog
      // (kept in separate files so fixtures can't leak into the disguise pool) into
      // one type→shape/model lookup for scene.js. Fixture types are only ever
      // referenced by map.fixtures, so this merge never widens the disguise pool.
      const catalog = { ...state.cfg.props, ...state.cfg.fixtures };
      ensureScene().then((s) => {
        s.buildWorld(state.map, state.props, catalog, state.cfg.characterModels, state.removedFixtures);
        applyRoleView(); // HUNTER => first-person; PROP => third-person (role may already be known)
        applyToolView(); // re-establish the hunter viewmodel/tool bar after the scene rebuild
      });
      // Stand up the local prediction world (real wall/prop collision for our own
      // movement). Fire-and-forget: until it resolves — or forever, if Rapier can't
      // load — the frame loop uses the flat 2D prediction. See buildPredict().
      buildPredict(state.map, state.props, catalog, state.removedFixtures);
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
      state.alive = true; // a private ROLE always accompanies a fresh spawn => alive
      applyRole(msg.role); // ONE role-application path (shared with the snapshot self-heal)
      if (msg.role === ROLE.HUNTER) ui.banner('You are a HUNTER. Pick a tool (1–3: rifle · finder · grenade), then hunt.', 3500);
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
  // Connection/phase transitions change whether the editor is enterable (e.g. a guest
  // joins → host now has guests → hide the button). Refresh after every game message.
  updateEditorButton();
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
  updateEditorButton(); // a link forming/closing can change editor availability
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
  hudTimer.stop(); // drop the HUD countdown on the way back to the menu
  destroyPredict();
  resetReadyButton();
  state.paused = false;
  state.hasLocked = false;
  state.uiMode = false; // drop the free-mouse state on the way back to the menu
  // AUDIO TAUNTS: tear the taunt UI + any playing clip down on the way out (a taunt is a Web Audio
  // node, not a scene child, so it must be explicitly stopped or it bleeds past the match).
  state.tauntMenuOpen = false;
  ui.closeTauntMenu();
  ui.setTauntButton(false);
  ui.setTauntStop(false);
  if (_selfTauntTimer) { clearTimeout(_selfTauntTimer); _selfTauntTimer = null; }
  if (scene && scene.clearAllTaunts) scene.clearAllTaunts();
  ui.hidePause();
  ui.setBlindfold(false); // clear any active blindfold overlay + release look
  input.lookFrozen = false;
  state.aimPropId = null;
  ui.setToolbar(false); // HUNTER-TOOLS v1: hide the tool bar + spectator on the way out
  setSpectating(false); // B6: exit spectator (fly/follow cam) + hide its hint/controls
  state.tool = 'rifle';
  state.toolSynced = null; // B7: re-sync the held tool next time we're a live hunter
  state.alive = true;
  resetFinderState(); // PROP FINDER: clear cooldown/zone/taunt-lock on the way out
  resetDebugView(); // drop free cam / focus box so they don't bleed into the next match
  ui.show('menu');
  if (msg) ui.menuError(msg);
  newSession();
  updateEditorButton(); // back on the landing screen (solo) → editor available again
}

// PROP FINDER: clear all finder + forced-taunt-lock client state so a new round/match starts clean
// (ready cylinder, no countdown, no stuck taunt lock). Called on STARTED, on the lobby transition,
// and on backToMenu — the cooldown must reset to ready across respawns/round transitions.
function resetFinderState() {
  state.finderCooldownUntil = 0;
  ui.setToolCooldown('finder', 0);
  if (_forcedTauntTimer) { clearTimeout(_forcedTauntTimer); _forcedTauntTimer = null; }
  setTauntLocked(false);
  if (scene && scene.updateFinderZone) scene.updateFinderZone({ visible: false });
}

// Turn off the debug free cam + focus box when leaving a match, so a persisted scene
// doesn't start the next round with a frozen (free-cam) camera or a stale focus box.
// No-op without ?debug=1.
function resetDebugView() {
  state.freeCam = false;
  if (scene) {
    if (scene.setFreeCam) scene.setFreeCam(false);
    if (scene.setFocusBox) scene.setFocusBox(false);
  }
  if (debugMenu && debugMenu.resetView) debugMenu.resetView();
}

// Reset the lobby ready toggle to its default. The referee clears server-side
// ready on resetToLobby; this keeps the local button label/state in step so a
// back-to-back round starts from "Ready", not a stale "Not ready".
function resetReadyButton() {
  ui.el.readyBtn._ready = false;
  ui.el.readyBtn.textContent = 'Ready';
}

// HUNTER BLINDFOLD (anti-cheat, screen half). While the start-of-map HIDING countdown
// runs, a HUNTER's screen is blacked out with a centered countdown and their look/yaw is
// frozen (movement is already frozen by the referee). The instant the host flips to
// HUNTING the overlay drops and look is released. Props are never blindfolded. The
// referee also withholds prop data from a blinded hunter (blindHunterSnapshot), so a
// hacked client that deletes this overlay still gets nothing to peek at.
function updateBlindfold(seconds) {
  const blind = state.role === ROLE.HUNTER && state.phase === PHASE.HIDING;
  input.lookFrozen = blind; // freeze yaw/pitch while blindfolded (see input.js)
  ui.setBlindfold(blind, seconds);
}

function onSnapshot(msg) {
  state.phase = msg.phase;
  // GAME TIMER DESYNC FIX: re-anchor the local countdown to the host's authoritative
  // time-remaining. The frame loop ticks it down smoothly between snapshots, so a snapshot
  // stall can't freeze the HUD clock (Jie's "5s left" while the host hit 0). See hudTimer.
  hudTimer.anchor(msg.timeLeft, nowMs());
  ui.setHud(msg);
  updateBlindfold(msg.timeLeft);
  // Newest roster for the pause scoreboard; refresh it live if the pause menu is open (the
  // world keeps running underneath, so health/roster keep updating behind the overlay).
  state.lastPlayers = msg.players;
  if (state.paused) ui.updatePauseScoreboard(msg.players, state.selfId, state.role === ROLE.HUNTER);
  if (debugMenu) debugMenu.onSnapshot(msg); // feed the debug panel (roster/states)
  if (scene) {
    scene.syncPlayers(msg.players); // no-op until ensureScene() resolves
    if (msg.props) scene.syncProps(msg.props); // awake dynamic-prop transforms
  }
  // Mirror the shoved props into the local PREDICTION world too (pass #5). Its props
  // are fixed colliders built at match-start poses; without this they never moved, so
  // local movement collided with ghost colliders where props USED to be and got no
  // resistance where they actually are (the "walk into props" sponginess — authority
  // only corrected at 15 Hz). Same transforms the renderer just consumed.
  if (msg.props && msg.props.length && state.predict && state.predict.syncPropTransforms) {
    state.predict.syncPropTransforms(msg.props);
  }
  const me = msg.players.find((p) => p.id === state.selfId);
  if (me) {
    // ROLE CONVERGENCE (2026-07-18, VRmike). Role now rides EVERY snapshot as our own entry's
    // `hunter` flag — present in all three snapshot variants the host may send us (full /
    // blindfolded-hunter / hunter-safe), because a recipient always sees themselves. The private
    // S2C.ROLE message is a one-time announcement; if it's ever missed or applied at the wrong
    // moment during a round flip / team switch / mid-join, THIS self-heals: we converge to the
    // host's authoritative role within one snapshot, so a client can never stay stuck rendering /
    // behaving as the wrong role (the bug where a player saw themselves as a HUNTER while the host
    // had them as a PROP and a real hunter could kill them). No-op in the common case (roles agree).
    const serverRole = me.hunter ? ROLE.HUNTER : ROLE.PROP;
    if (serverRole !== state.role) {
      applyRole(serverRole);
      ui.feed(`Role re-synced to ${serverRole === ROLE.HUNTER ? 'HUNTER' : 'PROP'} (host authority).`);
    }
    // HUNTER-TOOLS v1: own health on the HUD; track alive to drive the tool bar/viewmodel
    // and the dead-player spectator banner (hunters do NOT respawn).
    ui.setHealth(me.health);
    const wasAlive = state.alive;
    state.alive = me.alive !== false;
    if (state.alive !== wasAlive) applyToolView();
    const activePhase = msg.phase === PHASE.HIDING || msg.phase === PHASE.HUNTING;
    setSpectating(!state.alive && activePhase);
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
      // Mirror the authoritative capsule-resize on our OWN prediction body (solidity
      // pass #3, Bug 1): when we're disguised, our local collision capsule grows to the
      // disguise footprint exactly as the host's does, so prediction and authority step
      // an identically-sized body and don't rubber-band. No-op when unchanged.
      if (state.predict.setPlayerCollider) state.predict.setPlayerCollider(state.SELF_ID, me.disguise || null);
      if (!state.spawned) {
        // First snapshot of the match: hard-place the local body at spawn.
        state.predict.setPlayerPosition(state.SELF_ID, { x: me.x, y: me.y || 0, z: me.z });
        state.self.x = me.x;
        state.self.y = me.y || 0;
        state.self.z = me.z;
        state.pending = [];
        state.corr.x = state.corr.y = state.corr.z = 0;
        state.grounded = true; // fresh spawn stands on the ground (avoid a stale airborne flag)
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
      // Drive the blindfold straight off the phase event too, so a HUNTER's overlay drops
      // (and look unfreezes) the instant the host flips HIDING→HUNTING — without waiting
      // for the next snapshot. state.phase is authoritative from the event here.
      state.phase = msg.phase;
      // Re-anchor the local HUD countdown to the new phase's authoritative duration the instant
      // the host flips phases (HIDING→HUNTING→ENDING), so the clock resyncs without waiting for
      // the next snapshot. Round END is still host-driven — this only sets what the ticker counts.
      hudTimer.anchor(msg.seconds, nowMs());
      updateBlindfold(msg.seconds);
      if (msg.phase === PHASE.HIDING) ui.banner('HIDING PHASE — props, disguise now!', 2500);
      if (msg.phase === PHASE.HUNTING) ui.banner('HUNT! Hunters are loose.', 2500);
      updateTauntUi(); // taunt button follows the phase (available during HIDING/HUNTING only)
      break;
    case 'taunt':
      // Play the taunt as 3D positional audio at the taunter's position for everyone (async: the
      // clip is lazy-loaded on first use). See onTaunt (cut-off + own-stop-button handling).
      onTaunt(msg);
      break;
    case 'tauntStop':
      onTauntStop(msg);
      break;
    case 'find':
      // PROP FINDER: the host's private reply to OUR activation. ok:true => it fired; sync the
      // on-button countdown to the authoritative cooldown. ok:false => we were still cooling (a
      // click during cooldown) → play the denied buzz + keep the countdown honest. The forced
      // taunts themselves arrive as normal 'taunt' events (uncancellable) for everyone.
      if (msg.ok) {
        state.finderCooldownUntil = performance.now() + (msg.cooldownMs || finderCooldownMs());
        if (msg.hits > 0) ui.feed(`Finder pinged ${msg.hits} prop${msg.hits === 1 ? '' : 's'}!`);
        else ui.feed('Finder: no props in range.');
        // COMBAT SFX: the activation PING — an ascending success pulse, DISTINCT from the descending
        // deny buzz. This 'find' ok reply is private to the activating hunter, so it fires at their own
        // position (positional, essentially centred on the listener). Modest volume.
        playCombatSoundAt('finderPing', { x: state.self.x, y: (state.self.y || 0) + 1.2, z: state.self.z }, 0.6);
      } else {
        state.finderCooldownUntil = performance.now() + (msg.remainMs || 0);
        playFinderDenied();
      }
      break;
    case 'shot':
      // Everyone sees the muzzle flash + tracer, host-authoritative from the rifle muzzle
      // (o*) to the confirmed impact point (i*). Guarded so a missing method can't throw.
      if (scene && scene.spawnTracer) scene.spawnTracer(msg.ox, msg.oy, msg.oz, msg.ix, msg.iy, msg.iz);
      // COMBAT SFX: the gunshot report. The SHOOTER hears their own shot plainly + up-close
      // (non-positional, so it's not weirdly panned); everyone else hears it POSITIONALLY at the
      // muzzle (inverse-square falloff + HRTF), so they can tell direction/distance.
      if (msg.by === state.selfId) playCombatSound2D('gunshot', 0.4);
      else playCombatSoundAt('gunshot', { x: msg.ox, y: msg.oy, z: msg.oz }, 0.7);
      break;
    case 'grenade':
      // HUNTER GRENADES: the host-computed blast exploded at (x,y,z). Everyone sees the 3D
      // explosion flash there; a nearby local player also gets a brief screen flash. Per-target
      // damage rides the normal 'hurt'/'eliminated' events + the health snapshot. Feedback for
      // the thrower: redeemed (a prop-kill healed them to full) or the backfire they soaked.
      if (scene && scene.spawnExplosion) scene.spawnExplosion(msg.x, msg.y, msg.z);
      // COMBAT SFX: the blast boom, POSITIONAL at the blast centre for everyone in earshot (the
      // thrower is near the blast, so they hear it positionally too — that's correct).
      playCombatSoundAt('grenade', { x: msg.x, y: msg.y, z: msg.z }, 0.8);
      if (scene && scene.blastFlashAt) {
        const flash = scene.blastFlashAt(msg.x, msg.y, msg.z); // 0..1 by camera distance
        if (flash > 0) ui.flashScreen(flash);
      }
      if (msg.by === state.selfId) {
        if (msg.redeemed) ui.feed('Grenade kill — redeemed to full health!');
        else if (msg.backfire > 0) ui.feed(`Grenade backfire off decoys! −${msg.backfire}%`);
      }
      break;
    case 'hurt':
      // Light feedback for the local player (health itself rides the snapshot HUD).
      if (msg.victim === state.selfId) {
        if (msg.self) ui.feed(`You shot a decoy! −${msg.dmg}% (aim for real props).`);
        else ui.feed(`Hit! −${msg.dmg}%`);
      }
      // COMBAT SFX — PROP OUCH: a prop PLAYER taking a real hit (rifle or grenade) yelps, pitched by
      // prop size. Skip msg.self (the hunter's wrong-guess/backfire self-damage — that's not a prop),
      // and skip hunter victims (only PROP players ouch). Reads the victim's live disguise + role from
      // the newest snapshot roster (present for everyone during HUNTING, when combat happens).
      if (!msg.self) {
        const victim = state.lastPlayers && state.lastPlayers.find((p) => p.id === msg.victim);
        if (victim && !victim.hunter) playPropOuch(victim);
      }
      break;
    case 'eliminated':
      // hunter=true => a hunter died (no respawn); else a prop was found.
      ui.feed(msg.hunter ? `${msg.name} (hunter) was taken down!` : `${msg.name} was found!`);
      if (msg.victim === state.selfId) {
        ui.banner(msg.hunter ? 'You died — spectating.' : 'You were caught!', 3000);
      }
      break;
    case 'miss':
      ui.feed('Missed — nothing there.');
      break;
    case 'log':
      // PUBLIC log line broadcast by the host (a team switch or a mid-round join). Everyone sees it.
      if (msg.text) ui.feed(msg.text);
      break;
    case 'world':
      // WORLD SNAPSHOT ON BLINDFOLD RELEASE (host-authoritative object sync). A one-time full
      // snapshot of every dynamic body's current transform, handed to a hunter the instant they're
      // released from the HIDING blindfold. SNAP the rendered props (and the local prediction
      // colliders) straight to it so knocked-over objects appear where they actually rest — never the
      // factory-fresh map. Only moved props (live centre+quaternion) are applied; never-moved props
      // are already at their built spawn pose. Guarded so a missing method / pre-scene event can't throw.
      if (msg.props) {
        if (scene && scene.applyWorldSnapshot) scene.applyWorldSnapshot(msg.props);
        if (state.predict && state.predict.syncPropTransforms) state.predict.syncPropTransforms(msg.props);
      }
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
async function buildPredict(map, props, catalog, removedFixtures = null) {
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
    const world = new PhysicsWorld(RAPIER, map, props, catalog, { dynamicProps: false, rules: state.cfg.rules, feel: state.cfg.feel, removedFixtures });
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
  state.grounded = true;
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
  // JUMP-JUDDER FIX (2026-07-13, diagnosed via tools/_jumpdiag host-case trace). While the
  // local player is AIRBORNE, the vertical arc is fully determined by the SAME shared physics
  // both sides run (gravity + jumpSpeed from rules.json), so the local prediction already has
  // the correct height. Reconciling Y here snaps it to the authoritative snapshot, which is
  // 15Hz, 1cm-quantised AND phase-shifted from the local sim (the two Rapier worlds step on
  // different cadences — 60fps predict vs 30fps referee tick). That injected a large decaying
  // vertical correction (measured up to ~0.45 m) EVERY snapshot — a sawtooth that reads as the
  // camera "jerking downward" mid-jump. It hit even the HOST (zero latency, but the worlds
  // still step out of phase); remote players never juddered because they're pure interpolation
  // of the smooth authoritative arc. So: while airborne we let local prediction OWN the jump
  // and SKIP reconciliation entirely — EXCEPT a genuine large teleport (respawn / anti-tunnel
  // escape / hard desync), which must still snap immediately. Horizontal drift during the sub-
  // second airborne window is negligible (host: near-zero; guest: << the 2.5 m snap threshold)
  // and eases out on the next grounded reconcile. Grounded play is unchanged.
  if (!state.grounded) {
    const bigTeleport =
      Math.hypot(me.x - state.self.x, me.z - state.self.z) > 2.5 ||
      Math.abs((me.y || 0) - state.self.y) > 2.5;
    if (!bigTeleport) {
      // Drop acked inputs (keep the history bounded) but leave the local pose untouched.
      state.pending = state.pending.filter((p) => p.seq > ack);
      return true;
    }
    // else: fall through to the full snap-reconcile below (a real teleport, not a jump).
  }
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
  // Part 1 (2026-07-13): our own movement collider is now the disguise's true prop shape —
  // keep it yawed to the disguise facing so a rotated prop collides at its true silhouette,
  // matching the host (both sims step an identically-oriented body → no rubber-band). Uses
  // last frame's selfDispYaw; harmless (symmetric capsule) when undisguised.
  if (w.setPlayerColliderYaw) w.setPlayerColliderYaw(state.SELF_ID, state.selfDisguised ? state.selfDispYaw : 0);
  w.step(dt);
  const p = w.getPlayer(state.SELF_ID);
  if (p) {
    state.self.x = p.x;
    state.self.y = p.y;
    state.self.z = p.z;
    state.grounded = !!p.grounded; // drives the airborne-skip in reconcilePredict
  }
}

// ---- prediction + render loop ---------------------------------------------
let last = performance.now();
// ---- SPECTATOR MODE (B6) --------------------------------------------------
// A dead player spectates during an active phase. Enter/exit is driven off the authoritative
// alive flag in onSnapshot (setSpectating); the camera itself is driven each frame by
// updateSpectatorCamera. Free-fly (mode:'fly') reuses the fly-cam math with map-bounds clamping;
// follow (mode:'follow') reuses the third-person orbit pointed at a live player. Purely
// client-side — the physics body stays dead/frozen on the host, nothing new crosses the wire.

// Enter/leave spectator. Idempotent (no-op if already in the requested state). scene-null-safe so
// it can be called from teardown paths where the renderer may be gone.
function setSpectating(on) {
  const sp = state.spectate;
  if (on === sp.on) return;
  sp.on = on;
  if (on) {
    sp.mode = 'fly';
    sp.targetId = null;
    sp._prevJump = input.jump;
    if (scene && scene.enterSpectate) scene.enterSpectate();
    ui.setSpectator(true);
    ui.setSpectateControls(true, input.touch);
    updateSpectateHint();
  } else {
    ui.setSpectator(false);
    ui.setSpectateControls(false, input.touch);
  }
}

// Live players a spectator can watch: everyone alive in the latest snapshot except themselves.
// (During HIDING a spectator's snapshot is blindfold-filtered to hunters only — see the referee —
// so the list is naturally just the visible seekers then; during HUNTING it's everyone alive.)
function liveWatchables() {
  const list = state.lastPlayers || [];
  return list.filter((p) => p.alive !== false && p.id !== state.selfId);
}
function nameOf(id) {
  const p = (state.lastPlayers || []).find((x) => x.id === id);
  return p && p.name ? p.name : 'a player';
}

// Cycle the spectator camera one step through the ring [free-fly, ...live players] in direction
// `dir` (+1 next / −1 prev). Passing the end wraps back to free-fly — so a single press always
// returns to free-fly eventually, and there's an explicit path to it too (Space / the FLY button).
function spectateCycle(dir) {
  const sp = state.spectate;
  const live = liveWatchables();
  const ring = ['fly', ...live.map((p) => p.id)]; // 'fly' sentinel + live player ids
  let idx = sp.mode === 'fly' ? 0 : ring.indexOf(sp.targetId);
  if (idx < 0) idx = 0; // stale target (they died/left) — treat as free-fly for the step
  idx = (idx + dir + ring.length) % ring.length;
  const sel = ring[idx];
  if (sel === 'fly') { setSpectateMode('fly'); ui.feed('Free-fly camera.'); }
  else { sp.mode = 'follow'; sp.targetId = sel; ui.feed(`Now watching ${nameOf(sel)}.`); }
  updateSpectateHint();
}

// Switch spectator sub-mode. Entering 'fly' re-seeds the fly eye from the CURRENT camera (which may
// be the follow orbit) so the view doesn't jump.
function setSpectateMode(mode) {
  const sp = state.spectate;
  sp.mode = mode;
  if (mode === 'fly') {
    sp.targetId = null;
    if (scene && scene.enterSpectate) scene.enterSpectate();
  }
}

// Update the on-screen spectator hint (repurposes the death vignette's subtitle) for the current
// mode + device. Undocumented controls were half the complaint — this is the always-visible half;
// the PC controls-reference panel carries the full list.
function updateSpectateHint() {
  const sp = state.spectate;
  const touch = input.touch;
  let text;
  if (sp.mode === 'follow' && sp.targetId != null) {
    text = touch
      ? `Watching ${nameOf(sp.targetId)} · ◀ ▶ to switch · FLY for free-fly`
      : `Watching ${nameOf(sp.targetId)} · click to cycle · Space for free-fly`;
  } else {
    text = touch
      ? 'Free-fly — joystick + drag to move, JUMP up · ▶ to follow a player'
      : 'Free-fly — WASD + mouse, Space/Shift up-down · click to follow players';
  }
  ui.setSpectateHint(text);
}

// Drive the spectator camera this frame. Called after scene.interpolate() so a followed player is
// tracked at their smoothed mesh position. If the watched player dies/leaves, hop to the next live
// one; if none remain, drop to free-fly.
function updateSpectatorCamera(dt) {
  if (!scene || state.freeCam) return; // the debug free cam (?debug=1) owns the view if a dev toggled it
  const sp = state.spectate;

  // Space edge = snap follow → free-fly (a dedicated "back to free-fly" that doesn't wait for a full cycle).
  const jumpEdge = input.jump && !sp._prevJump;
  sp._prevJump = input.jump;
  if (jumpEdge && sp.mode === 'follow') { setSpectateMode('fly'); updateSpectateHint(); ui.feed('Free-fly camera.'); }

  if (sp.mode === 'follow') {
    const live = liveWatchables();
    if (!live.length) {
      setSpectateMode('fly'); updateSpectateHint();
    } else if (!live.some((p) => p.id === sp.targetId)) {
      sp.targetId = live[0].id; // watched player gone — jump to the next live one
      ui.feed(`Now watching ${nameOf(sp.targetId)}.`);
      updateSpectateHint();
    }
    if (sp.mode === 'follow') {
      const pos = scene.playerViewPos(sp.targetId);
      if (pos) { scene.spectateFollow(pos, input.yaw, input.pitch); return; }
      // no rendered mesh yet — fall through to a free-fly frame
    }
  }

  // FLY: free-flying eye, clamped inside the map so nobody drifts into the void.
  const mv = input.moveVector();
  const down = input.keys && (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'));
  const size = state.map ? state.map.size : 0;
  scene.updateSpectateFly({
    yaw: input.yaw, pitch: input.pitch, mx: mv.mx, mz: mv.mz,
    up: (input.jump ? 1 : 0) - (down ? 1 : 0),
    dt,
    half: size ? size / 2 : 1e6, // inside the arena walls
    yMin: 0.6, yMax: size ? size : 1e6, // floor-to-a-generous-ceiling
  });
}

// Render-loop safety wrapper. The next-frame reschedule happens HERE, first, before
// any gameplay work — so a thrown exception in frameBody() can never stop the loop
// (the bug that blanked the whole game to solid blue when a called method was missing).
// We catch, log once, and keep animating; a transient error degrades gracefully instead
// of killing all rendering forever.
function frame(now) {
  requestAnimationFrame(frame);
  try {
    frameBody(now);
  } catch (e) {
    if (!frame._loggedErr) {
      console.error('[frame] render loop error (continuing anyway):', e);
      frame._loggedErr = true; // log once so a per-frame throw doesn't spam the console
    }
  }
}

function frameBody(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Level editor owns the frame while open: it renders its own sandbox scene through
  // the shared renderer and ignores gameplay entirely (no predict, no game render).
  if (state.editing) {
    if (editor) editor.frame(dt);
    return;
  }

  // GAME TIMER DESYNC FIX: tick the HUD countdown LOCALLY every frame off the anchor set on
  // the last snapshot / phase event. This is what keeps the clock moving (and correct) between
  // snapshots and through a network stall; it re-syncs the instant a fresh snapshot arrives.
  // Clamped at 0 by HudTimer — the round's real end stays host-authoritative.
  if (hudTimer.active) ui.setTimer(hudTimer.remaining(now));

  // RAPID FIRE: while the primary is HELD, auto-repeat the rifle at the configured RPM for a
  // live hunter. The host still enforces its own rate cap, so this only paces client sends.
  if (
    input.primaryHeld && !state.paused && !state.uiMode &&
    state.role === ROLE.HUNTER && state.alive && state.movable && state.tool === 'rifle' &&
    now - lastFireAt >= fireIntervalMs()
  ) {
    tryFire(); // sets lastFireAt
  }

  if (state.predict) {
    // Physics prediction: step our own body through the local Rapier world for this
    // frame's input, recording it for reconciliation. Real collide-and-slide against
    // walls/fixtures happens right here, with zero network latency. Skipped while the
    // debug free cam is on so the physics player stays put (main sends zeroed movement too).
    // Also skipped while paused OR in UI mode, so the avatar holds still while a menu/debug UI is
    // up (the world keeps running on the host).
    if (state.movable && !state.freeCam && !state.paused && !state.uiMode) {
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
  } else if (state.movable && !state.freeCam && !state.paused && !state.uiMode) {
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

  // Disguise orientation lock (local own-model view). Undisguised: face where we look.
  // Disguised + right-click: ease the facing toward look-yaw at the SAME capped rate the
  // host uses (rules.disguiseRotSpeedDeg), so our own prop turns smoothly/continuously
  // instead of snapping (Bug 3) and roughly matches the host-authoritative dispYaw
  // everyone else sees. The host does the fit-gating; this is cosmetic self-view only.
  if (!state.selfDisguised) {
    state.selfDispYaw = input.yaw;
  } else if (input.rotUnlock) {
    const maxStep = (((state.cfg.rules.disguiseRotSpeedDeg || 270) * Math.PI) / 180) * dt;
    let d = (input.yaw - state.selfDispYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    state.selfDispYaw += Math.max(-maxStep, Math.min(maxStep, d));
  }

  if (scene) {
    // Displayed position = predicted truth + the decaying correction offset.
    const disp = {
      x: state.self.x + state.corr.x,
      y: state.self.y + state.corr.y,
      z: state.self.z + state.corr.z,
    };
    if (state.spectate.on) {
      // SPECTATOR (B6): a dead player flies free or orbits a live player — NOT the self follow-cam,
      // finder HUD, or disguise targeting. The camera is positioned AFTER interpolate() below so the
      // follow-cam tracks the smoothly-interpolated watched mesh, not this frame's stale pose.
      state.aimPropId = null;
      scene.highlightProp(null);
      ui.setAimHint(false);
    } else {
      scene.setCamera(disp, input.yaw, input.pitch, state.selfDispYaw);

      // PROP FINDER: countdown on the tool button + the AOE cylinder follows the hunter (green ready /
      // grey cooling). After setCamera so the zone sits on the freshest displayed position.
      updateFinderHud(now, disp);

      // Crosshair-based disguise targeting + highlight. While alive as a PROP in an active
      // phase, raycast from the player along the look direction for the first disguisable
      // prop within disguiseRange; outline it (so you see what you'll become) and remember
      // its id for Action. Anything else (hunter, dead, lobby) clears the highlight/target.
      // state.movable for a PROP == alive AND in an active phase (props are never frozen),
      // exactly when targeting should run.
      if (state.role === ROLE.PROP && state.movable) {
        const id = scene.aimedDisguiseTarget(disp, input.yaw, input.pitch, state.cfg.rules.disguiseRange);
        state.aimPropId = id;
        scene.highlightProp(id);
        ui.setAimHint(id == null); // tiny "no prop targeted" hint when nothing valid is aimed at
      } else {
        state.aimPropId = null;
        scene.highlightProp(null);
        ui.setAimHint(false);
      }
    }

    scene.interpolate(0.25);
    // SPECTATOR camera (fly / follow) — after interpolate so a followed player is tracked smoothly.
    if (state.spectate.on) updateSpectatorCamera(dt);
    // Advance remote-hunter animation mixers (needs real dt; interpolate uses a fixed
    // alpha). Drives the velocity-based idle/run state machine — see scene.updateAnimations.
    scene.updateAnimations(dt);
    // HUNTER-TOOLS v1: fade + retire active tracers / muzzle flashes.
    scene.updateEffects(dt);
    // AUDIO TAUNTS: keep each active 3D taunt emitter glued to its (possibly moving) prop and
    // retire finished ones. After interpolate/setCamera so mesh positions are current this frame.
    scene.updateTauntEmitters();
    // Debug menu (?debug=1 only): updates its live displays and, when active, drives the
    // free cam + focus-box raycast. Runs BEFORE render so the camera/box reflect this frame.
    if (debugMenu) debugMenu.frame(dt);
    scene.render();
    // The reticle is a fixed crosshair at the EXACT screen centre (CSS #crosshair) —
    // nothing floats it. Disguise targeting raycasts through that same centre (see
    // scene.aimedDisguiseTarget), so what the crosshair overlaps is what you pick.
  }
}

// Send movement intent to the referee at a fixed rate.
function startInputLoop() {
  setInterval(() => {
    if (state.editing) return; // editor sandbox: stay detached from the match loop
    if (!session || !session.ready) return;
    if (state.phase !== PHASE.HIDING && state.phase !== PHASE.HUNTING) return;
    // Debug free cam: send zeroed movement so the (frozen) physics player stays put while
    // the local camera flies. The last real input.mx/mz would otherwise keep the referee
    // driving the body forward, so we must actively send a stop.
    // Free cam OR the pause menu OR UI mode -> send zeroed movement so the (frozen) body stays put
    // while the local view is detached; the world keeps running on the host regardless.
    const halt = state.freeCam || state.paused || state.uiMode || state.tauntMenuOpen;
    const { mx, mz } = halt ? { mx: 0, mz: 0 } : input.moveVector();
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
      jump: halt ? false : input.jump,
      rotUnlock: halt ? false : input.rotUnlock,
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

async function enterEditor(forceHelp) {
  if (state.editing || state._enteringEditor || !state.cfg) return; // busy / not ready
  if (!canEnterEditor()) {
    ui.feed('Level editor is available only in solo/local play — not during a multiplayer match.');
    return;
  }
  state._enteringEditor = true; // guard the async gap (import + build) against double-enter
  try {
    await _enterEditorInner(forceHelp);
  } finally {
    state._enteringEditor = false;
  }
}

async function _enterEditorInner(forceHelp) {
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
  // Opened from the on-screen dev button → always show the help/instructions panel
  // (controls + how to export edits back to DevBot). Ctrl+E keeps its first-open-only
  // auto-show inside editor.enter().
  if (forceHelp && editor.showHelp) editor.showHelp();
  state.editing = true;
  updateEditorButton();
}

function exitEditor() {
  if (!state.editing) return;
  state.editing = false;
  if (editor) editor.exit();
  // Restore whatever screen we came from (menu / lobby / game). We never stopped the
  // underlying solo match, so returning to 'game' simply resumes it.
  ui.show(state.editorPrevScreen || 'menu');
  if (state.editorPrevScreen === 'game') ui.setClickToPlay(!input.locked);
  updateEditorButton();
}

// Show the "Map Editor (dev use only)" button only when the editor is actually
// enterable: desktop, config loaded, not already editing, and solo/local play
// (canEnterEditor gates out touch, guests, and a host with guests). Called on every
// screen/connection transition so it appears in the menu + solo lobby/match and
// disappears the moment someone joins.
function updateEditorButton() {
  const btn = document.getElementById('editBtn');
  if (!btn) return;
  const show = !!state.cfg && !input.touch && !state.editing && canEnterEditor();
  btn.classList.toggle('hidden', !show);
}

// ---- menu wiring ----------------------------------------------------------
// Remember the player's chosen name locally (no account/server) so it pre-fills next
// time — set at create/join and on every lobby rename. localStorage can throw (private
// mode / blocked), so both helpers swallow errors and degrade to "not remembered".
const NAME_KEY = 'prophunt.name';
function saveName(name) {
  try { localStorage.setItem(NAME_KEY, String(name || '').slice(0, 16)); } catch { /* storage blocked */ }
}
function loadSavedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

// MOUSE SENSITIVITY (B4, 2026-07-18, VRmike) — persist the PC mouse-look multiplier locally (NOT a
// cookie, NOT a server; no account) so the chosen feel survives a reload and future sessions. Anything
// missing / corrupted / out of range silently falls back to 1.0× (the historical default feel). Range
// clamp mirrors input.js SENSITIVITY_RANGE so a hand-edited localStorage value can't push it out of band.
const SENS_KEY = 'prophunt.sensitivity';
function saveSensitivity(mult) {
  try { localStorage.setItem(SENS_KEY, String(mult)); } catch { /* storage blocked / private mode */ }
}
function loadSensitivity() {
  let raw = null;
  try { raw = localStorage.getItem(SENS_KEY); } catch { return SENSITIVITY_RANGE.default; }
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return SENSITIVITY_RANGE.default; // absent / corrupted → default
  return Math.min(SENSITIVITY_RANGE.max, Math.max(SENSITIVITY_RANGE.min, n));
}

// create()/join() hand off to PeerJS (the free public broker introduces the two
// browsers); everything after (ready, start, and all gameplay) rides the peer
// link via session.send().
function wireMenu() {
  const nameEl = ui.el.name;
  // Pre-fill the name from last time (saved locally, no account) so returning players
  // don't retype it. Only if the field is empty, so we never clobber a fresh entry.
  if (!nameEl.value) nameEl.value = loadSavedName();
  document.getElementById('createBtn').addEventListener('click', () => {
    saveName(nameEl.value);
    session.create(nameEl.value);
  });
  document.getElementById('joinBtn').addEventListener('click', () => {
    const room = ui.el.roomCode.value.toUpperCase().trim();
    if (!room) return ui.menuError('Enter a room code.');
    saveName(nameEl.value);
    session.join(nameEl.value, room);
  });
  // Lobby rename: relay the requested name to the host (authority) and remember it locally
  // so it pre-fills next time. The referee trims/caps/de-dupes and rebroadcasts the roster.
  ui.onRename = (name) => {
    saveName(name);
    session.rename(name);
  };
  ui.el.readyBtn.addEventListener('click', () => {
    ui.el.readyBtn._ready = !ui.el.readyBtn._ready;
    session.send({ t: C2S.READY, ready: ui.el.readyBtn._ready });
    ui.el.readyBtn.textContent = ui.el.readyBtn._ready ? 'Not ready' : 'Ready';
  });
  ui.el.startBtn.addEventListener('click', () => session.send({ t: C2S.START }));
  // Dev-only Map Editor launcher (desktop, host/solo). Opens the editor WITH the help
  // panel; visibility is managed by updateEditorButton() on every state transition.
  const editBtn = document.getElementById('editBtn');
  if (editBtn) editBtn.addEventListener('click', () => enterEditor(true));
  // Map picker: the UI renders the list from the shared maps catalog and, when the
  // host taps a map, hands the choice back here to send as a C2S.PICK_MAP. The
  // referee is the gate (host-only, LOBBY-only, real map); we just relay the tap.
  ui.maps = state.cfg.maps;
  ui.onPickMap = (mapId) => session.send({ t: C2S.PICK_MAP, mapId });
  // Copy a one-click invite link (room code in the URL hash) so the host can
  // paste it in chat and friends just click to join.
  // Pause menu wiring (Resume re-locks / Exit leaves the match). The ☰ button opens it on
  // touch (and works on desktop when unlocked); Escape opens it on desktop via onLockChange.
  ui.onPauseResume = () => closePause(true);
  ui.onPauseExit = () => backToMenu('Left the match.');
  // PAUSE-MENU TEAM SWITCH: ask the host to respawn us on the opposite team (host-authoritative; it
  // broadcasts the public "X switched to …" log). Close the menu + re-lock so we drop back into play.
  ui.onPauseSwitch = () => {
    session.send({ t: C2S.SWITCH_TEAM });
    closePause(true);
  };
  // COPY JOIN LINK from the pause menu, so new players can be added mid-game by pasting one URL
  // (opening it drops them straight into the room — see tryJoinFromHash). Build the link string
  // FIRST (synchronous, via the shared buildJoinLink) then write it inside this tap handler —
  // mobile browsers only grant clipboard access from a direct user gesture. Phone-friendly
  // fallback: show the link in the feed if clipboard access is denied / insecure ctx. The raw
  // room code stays visible on-screen (#pauseRoomCode) for anyone who'd rather type it.
  ui.onPauseCopyRoom = async () => {
    if (!state.room) return;
    const link = buildJoinLink(state.room);
    try {
      await navigator.clipboard.writeText(link);
      ui.feed('Join link copied — paste it so friends drop straight into the room.');
    } catch {
      ui.feed(`Join link: ${link} (copy it manually to invite players).`);
    }
  };
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) pauseBtn.addEventListener('click', () => openPause());
  ui.el.copyLinkBtn.addEventListener('click', async () => {
    if (!state.room) return;
    const link = buildJoinLink(state.room);
    try {
      await navigator.clipboard.writeText(link);
      ui.lobbyHint('Invite link copied — paste it to your friends.');
    } catch {
      // Clipboard blocked (e.g. insecure context): show the link to copy by hand.
      ui.lobbyHint(link);
    }
  });
}

// --- JOIN LINK: ONE definition of the shareable-URL format, used by BOTH the builder
// (lobby "Copy invite link" + pause "Copy link") and the parser (auto-join on boot) so the
// two sides can never drift. The link is the page's OWN current address with the room code as
// the URL hash:  <origin><path>#CODE  (e.g. https://prophunt.pages.dev/#X7K2). Using
// location.origin+pathname (never a hardcoded URL) means preview/test deploys share correctly
// too. Room codes are an uppercase alphabet, so the parser upper-cases + trims.
function buildJoinLink(code) {
  return `${location.origin}${location.pathname}#${code}`;
}
function parseRoomFromHash() {
  return (location.hash || '').replace(/^#/, '').toUpperCase().trim();
}

// Join-by-link: a shared URL carries the room code after a '#'. If present, drop
// it into the code field and auto-join so the friend really does "just click".
function tryJoinFromHash() {
  const code = parseRoomFromHash();
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
  // Debug menu ping: only measure RTT when the debug panel is present (?debug=1). No ping
  // traffic in normal play. Safe to call before the link opens (it no-ops until then).
  if (DEBUG) session.enablePing();
}

// ---- boot -----------------------------------------------------------------
(async function boot() {
  state.cfg = await loadConfig();
  // Build the in-game debug menu — ON BY DEFAULT now (no ?debug=1 needed). Lazy import so
  // it stays out of the initial parse, but it's constructed unconditionally. It reads live
  // state + drives host-authoritative debug commands through the referee's gated `debug:`
  // family (which the referee still only honours when the HOST loaded ?debug=1, so a normal
  // match can't be tampered with even though the panel is visible). See js/debug.js.
  try {
    const { DebugMenu } = await import('./debug.js');
    debugMenu = new DebugMenu({
      state, input, ui, cfg: state.cfg,
      C2S, ROLE, PHASE,
      debugFlag: DEBUG, // ?debug=1: the collider overlay is already built at load
      getScene: () => scene,
      getSession: () => session,
      onExit: () => backToMenu('Left the match (debug exit).'),
    });
  } catch (e) {
    console.warn('[main] debug menu unavailable:', e && e.message); // stays null-guarded
  }
  newSession();
  wireMenu();
  // HUNTER-TOOLS v1: build the (initially hidden) hunter tool bar and wire selection from
  // both the on-screen buttons and the number keys (1..2). Hidden until a hunter is live.
  ui.buildToolbar(HUNTER_TOOLS);
  ui.onSelectTool = selectTool;
  input.onSelectTool = (i) => { const t = HUNTER_TOOLS[i]; if (t) selectTool(t.id); };
  // SPECTATOR (B6): the on-screen phone controls (◀ / FLY / ▶) shown while dead. PC uses left-click +
  // Space; these buttons are the touch equivalent (no keyboard there). Guarded so a stray press while
  // alive does nothing.
  ui.onSpectatePrev = () => { if (state.spectate.on) spectateCycle(-1); };
  ui.onSpectateNext = () => { if (state.spectate.on) spectateCycle(1); };
  ui.onSpectateFree = () => { if (state.spectate.on && state.spectate.mode === 'follow') { setSpectateMode('fly'); updateSpectateHint(); ui.feed('Free-fly camera.'); } };
  // AUDIO TAUNTS: build the lazy clip loader (decodes through the scene's shared audio context)
  // and the data-driven menu list from the manifest, then wire the open/pick/stop/close/prefetch
  // callbacks + the desktop T key. Clips are never fetched here — only on first play / menu-open
  // prefetch. An empty manifest just yields an empty menu (the referee rejects every taunt id too).
  const tauntList = (state.cfg.taunts && state.cfg.taunts.taunts) || [];
  taunts = new TauntLibrary(tauntList, (url) => (scene && scene.loadAudioBuffer ? scene.loadAudioBuffer(url) : Promise.resolve(null)));
  ui.buildTauntList(tauntList);
  ui.onTauntButton = () => { if (state.tauntMenuOpen) closeTauntMenu(true); else openTauntMenu(); };
  ui.onTauntPick = (id) => sendTaunt(id);
  ui.onTauntStop = () => { if (session) session.send({ t: C2S.STOP_TAUNT }); };
  ui.onTauntClose = () => closeTauntMenu(true);
  ui.onTauntPrefetch = () => { if (taunts) taunts.prefetch(); };
  input.onToggleTaunt = () => { if (state.tauntMenuOpen) closeTauntMenu(true); else openTauntMenu(); };
  // MOUSE SENSITIVITY (B4, PC): restore the saved multiplier from localStorage, apply it to input.js,
  // and reflect it in the pause-menu slider. The slider then drives it LIVE (no restart) and persists
  // every change. On touch the slider row is hidden (ui.js) — this still runs harmlessly.
  {
    const s = loadSensitivity();
    input.setSensitivity(s);
    ui.setSensitivityValue(s);
    ui.onSensitivityChange = (mult) => { saveSensitivity(input.setSensitivity(mult)); };
  }
  // PC CONTROLS REFERENCE (B4): populate + show the always-visible corner controls list (PC only;
  // ui.js keeps it hidden on touch). Built once here from the shared _controlsHtml() rows.
  ui.buildControlsRef();
  updateEditorButton(); // show the dev editor button on the landing screen (desktop solo)
  startInputLoop();
  requestAnimationFrame(frame);
  tryJoinFromHash();
})();
