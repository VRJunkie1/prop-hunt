// Input owns EVERY control scheme and funnels them all into the same shape the
// rest of the game reads: a movement intent (mx, mz), look angles (yaw, pitch),
// and discrete action callbacks. Nothing downstream (net/referee/scene) knows or
// cares whether a frame's movement came from WASD, a thumbstick, or a drag.
//
// Two schemes live here:
//   - DESKTOP: keyboard + pointer-lock mouse look (unchanged — see the
//     input-mouselook note). Wired whenever the device has a PRECISE pointer (a
//     mouse/trackpad), EVEN if the screen is also touchable — see
//     prefersTouchControls() below (the "touchscreen PC got phone controls" fix).
//   - TOUCH (phones/tablets): a nipplejs virtual joystick for movement, a
//     hand-rolled drag-to-look zone (pointer events; phones have no pointer lock,
//     so this REPLACES mouse-look rather than imitating it), and on-screen tap
//     buttons for the role action. Only wired on touch devices, so desktop is
//     untouched. nipplejs is lazy-loaded from jsDelivr on first game entry (same
//     "CDN import, no build step, nothing at boot" pattern as Three/PeerJS), so a
//     bare landing page still makes zero external requests.

// nipplejs (MIT) pulled as ESM from jsDelivr's prebuilt bundle, LAZILY — the
// import only runs the first time a touch player actually enters a match, never
// at page load. Cached after the first load.
let _nippleFactory = null;
async function loadNipple() {
  if (!_nippleFactory) {
    const mod = await import('https://cdn.jsdelivr.net/npm/nipplejs@0.10.2/+esm');
    _nippleFactory = mod.default || mod;
  }
  return _nippleFactory;
}

// Audio unlock: iOS keeps audio muted until it's started inside a real user
// gesture. We resume a shared AudioContext on the first in-game tap (see the tap
// handlers below). It lives in this input/glue layer ON PURPOSE — not in ui.js —
// so the "UI is logic-free" rule holds. Harmless today (no sounds yet); this is
// the one correct place to do it, so future audio just works on phones.
let _audioCtx = null;
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
  } catch {
    /* audio is best-effort; never block gameplay on it */
  }
}

// PRIMARY-MODE CLASSIFICATION (2026-07, VRmike "touchscreen PC got phone controls" fix).
// The OLD test asked "can this device be touched?" — ('ontouchstart' in window ||
// maxTouchPoints > 0) — so a Windows PC with a touchscreen (or touch-capable drivers)
// answered YES and got the phone scheme: no pointer lock, no Escape pause, no left-click
// hold-fire. The RIGHT question is "does this device have a PRECISE pointer (a mouse /
// trackpad)?" — decide the PRIMARY control mode by the PRIMARY POINTER ('(pointer: …)'):
//   - PRIMARY pointer coarse ('(pointer: coarse)') => TOUCH controls, even if a SECONDARY
//     stylus/mouse makes '(any-pointer: fine)' also match (real phones incl. Samsung S-Pen).
//     Keying off any-pointer:fine — the earlier fix — misclassified stylus phones as desktop
//     (VRmike, 2026-07-13: game-breaking mobile bug, pointer-lock overlay over dead controls).
//   - PRIMARY pointer fine ('(pointer: fine)') OR real hover ('(hover: hover)') => DESKTOP
//     wiring (pointer lock + mouse-look + keyboard), EVEN when the screen is ALSO touchable
//     (a hybrid laptop whose primary input is the trackpad). Correctness over cleverness: we
//     ship the desktop classification alone rather than ALSO dual-wiring the touch pads.
// Returns TRUE when the device should use the TOUCH scheme. Pure + fully INJECTABLE (pass an
// `env` of {matchMedia, maxTouchPoints, hasOntouchstart}) so tools/check-input-mode.mjs can
// unit-test every device combo with mocked signals. See memory/notes/input-mode.md.
export function prefersTouchControls(env) {
  const e = env || {};
  const mm = e.matchMedia !== undefined
    ? e.matchMedia
    : (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null);
  const maxTouchPoints = e.maxTouchPoints !== undefined
    ? e.maxTouchPoints
    : (typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0);
  const hasOntouchstart = e.hasOntouchstart !== undefined
    ? e.hasOntouchstart
    : (typeof window !== 'undefined' && 'ontouchstart' in window);
  const q = (s) => {
    try { const r = mm && mm(s); return !!(r && r.matches); } catch { return false; }
  };
  // PRIMARY SIGNAL: classify by the PRIMARY pointer ('(pointer: …)'), NOT any-pointer. A phone
  // with a stylus (Samsung S-Pen etc.) advertises '(any-pointer: fine)', yet its PRIMARY
  // pointer is the finger => it MUST get touch controls. Keying off any-pointer:fine (the old
  // code) misclassified those phones as DESKTOP, requested pointer lock (impossible on mobile),
  // and left the "blocked mouse capture" overlay stuck over dead touch controls (VRmike,
  // 2026-07-13). A hybrid touchscreen laptop is unaffected: its PRIMARY pointer is the trackpad
  // ('(pointer: fine)'), only its secondary any-pointer is coarse — so it still gets desktop.
  if (mm) {
    // Primary pointer is coarse (finger) => TOUCH, even if a secondary stylus/mouse exists.
    if (q('(pointer: coarse)')) return true;
    // Primary pointer is fine (mouse/trackpad) or real hover => DESKTOP, even when the screen
    // is ALSO touchable (a hybrid laptop whose primary input is the trackpad).
    if (q('(pointer: fine)') || q('(hover: hover)')) return false;
    // Primary-pointer queries inconclusive — fall through to the raw touch signal below.
  }
  // FALLBACK (old / matchMedia-less browsers): touch present => touch controls, else desktop
  // (a keyboard+mouse box that fails feature detection must NOT lose pointer lock / Esc / fire).
  return !!(hasOntouchstart || maxTouchPoints > 0);
}

export class Input {
  // lockTrigger is the element clicked to capture the mouse (desktop) OR tapped to
  // dismiss the overlay (touch) — the "Click/Tap to play" overlay, which is painted
  // over the canvas and swallows its clicks. Defaults to the canvas.
  constructor(canvas, lockTrigger = canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    // When true, look (yaw/pitch) updates are ignored — used by the HUNTER BLINDFOLD
    // during the HIDING phase so a blindfolded hunter can't pre-aim while their screen
    // is blacked out. Movement is frozen separately by the referee. Set from main.js.
    this.lookFrozen = false;
    this.sensitivity = 0.0022;
    this.jump = false; // held: Space (desktop) / jump button (touch)
    this.rotUnlock = false; // held: right-click (desktop) / rotate button (touch) —
    //   lets a disguised prop rotate on yaw only (never tips)
    // RAPID FIRE: true while the primary (left-click / touch ACTION) is HELD. main.js reads
    // this each frame to auto-repeat a hunter's rifle at the configured RPM (hold-to-fire).
    // Cleared on release and whenever pointer lock is lost (so a hold can't "stick" firing).
    this.primaryHeld = false;

    this.onAction = () => {}; // (name) => void  for 'disguise' | 'tag' | 'primary'
    this.onLockChange = () => {}; // (locked: boolean) => void  (desktop pointer lock)
    this.onLockError = () => {}; // (reason: string) => void    (desktop pointer lock)
    // Backtick (`) toggles a DESKTOP "UI mode": release the mouse for the DEBUG menu / any UI
    // WITHOUT opening the pause menu (main.js owns the state). onRequestPause is Escape while the
    // pointer is already unlocked (e.g. in UI mode) — pause takes over. Both no-op while typing.
    this.onToggleUiMode = () => {}; // () => void  ` key: toggle desktop UI mode (free mouse, no pause)
    this.onRequestPause = () => {}; // () => void  Esc while unlocked: open the pause menu
    this.onTouchPlay = () => {}; // () => void  fired when a touch player taps the overlay
    this.onToggleView = () => {}; // () => void  V key: third-person <-> first-person
    this.onToggleEdit = () => {}; // () => void  Ctrl/Cmd+E: toggle the level editor (desktop)
    this.onSelectTool = () => {}; // (index:number)  number keys 1..9 select a hunter tool
    // AUDIO TAUNTS: the T key toggles the prop taunt menu (main.js gates it to a living prop).
    // On desktop the menu opening frees the mouse (main.js exits pointer lock) so the scrolling
    // list is clickable; on touch the on-screen taunt button does the same job. No-op while typing.
    this.onToggleTaunt = () => {}; // () => void  T key: toggle the taunt menu

    // Touch state. `this.touch` is the ONE classification the whole game keys off (the
    // Escape handler, the click/tap overlay text, the controls-help list, the editor gate,
    // …), so redefining it here re-routes EVERY downstream branch at once: a touchscreen PC
    // now reports false => full desktop wiring (pointer lock, Esc pause, left-click fire).
    this.touch = prefersTouchControls();
    this.touchMove = { mx: 0, mz: 0 }; // latest joystick vector (right+, forward+)
    this.touchLookSens = 0.005;
    this._joystick = null;
    this._touchBuilt = false;
    this._touchRoot = null;
    this._lookPointerId = null; // the single finger currently driving look
    this._lookLast = null;

    // Keyboard is always live (a hybrid laptop still has it; a pure phone won't
    // fire these). Action keys are gated on pointer lock below.
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    // Window blur (Alt-Tab / Windows key / clicking another window): the browser stops
    // delivering keyup, so any key held at that moment would "stick down" and keep the avatar
    // walking/firing while the player is in another window. Since ambient focus loss no longer
    // pauses (PC pause is Escape-only — see main.js onLockChange), clear all held input here so
    // losing focus cleanly stops control until the player clicks back in.
    window.addEventListener('blur', () => this._releaseHeldInput());

    if (this.touch) this._wireTouch(lockTrigger);
    else this._wireDesktop(lockTrigger);
  }

  // ---- desktop (unchanged behaviour) --------------------------------------
  _wireDesktop(lockTrigger) {
    const canvas = this.canvas;
    const requestLock = () => {
      if (!this.locked) canvas.requestPointerLock();
    };
    canvas.addEventListener('click', requestLock);
    if (lockTrigger && lockTrigger !== canvas) lockTrigger.addEventListener('click', requestLock);

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.primaryHeld = false; // releasing the mouse (Esc/alt-tab) stops held fire
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.onLockError('Browser blocked mouse capture — click again (and allow pointer lock if your browser asks).');
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.lookFrozen) return; // blindfolded hunter: camera is locked while props hide
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.primaryHeld = true; this.onAction('primary'); } // left: fire (held) / disguise
      if (e.button === 2) this.rotUnlock = true; // right: unlock disguise yaw rotation
    });
    // Right-click is held to rotate a disguise; left-click is HELD to rapid-fire. Catch the
    // release even off-canvas, and stop the browser context menu from popping over the game.
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.primaryHeld = false;
      if (e.button === 2) this.rotUnlock = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- touch --------------------------------------------------------------
  _wireTouch(lockTrigger) {
    // Drag-to-look on the canvas. The joystick zone and action button are DOM
    // elements layered OVER the canvas, so touches that land on them never reach
    // here — the canvas only sees "empty" screen, which is exactly the look zone.
    // One finger drives look at a time (the joystick finger is a different pointer
    // captured by the joystick element).
    const canvas = this.canvas;
    canvas.style.touchAction = 'none'; // no pinch-zoom / pull-to-refresh eating drags
    canvas.addEventListener('pointerdown', (e) => {
      if (this._lookPointerId !== null) return;
      this._lookPointerId = e.pointerId;
      this._lookLast = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._lookPointerId || !this._lookLast) return;
      this.yaw -= (e.clientX - this._lookLast.x) * this.touchLookSens;
      this.pitch -= (e.clientY - this._lookLast.y) * this.touchLookSens;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
      this._lookLast = { x: e.clientX, y: e.clientY };
    });
    const endLook = (e) => {
      if (e.pointerId === this._lookPointerId) {
        this._lookPointerId = null;
        this._lookLast = null;
      }
    };
    canvas.addEventListener('pointerup', endLook);
    canvas.addEventListener('pointercancel', endLook);

    // The "Tap to play" overlay: on touch there's no pointer lock to wait on, so
    // tapping it just unlocks audio and tells main.js to dismiss the overlay. No
    // fake lock events — the desktop lock path is left completely alone.
    if (lockTrigger) {
      lockTrigger.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        unlockAudio();
        this.onTouchPlay();
      });
    }
  }

  // Show the touch controls and lazily build the joystick. Called by main.js when
  // a match starts. No-op on desktop.
  async enterGame() {
    if (!this.touch) return;
    this._buildTouchDom();
    this._touchRoot.classList.remove('hidden');
    await this._initJoystick();
  }

  // Hide the touch controls when we leave the game (back to lobby/menu). No-op on
  // desktop. The joystick manager is kept (cheap) and reused next round.
  exitGame() {
    if (!this.touch) return;
    if (this._touchRoot) this._touchRoot.classList.add('hidden');
    this.touchMove = { mx: 0, mz: 0 };
    this._lookPointerId = null;
    this._lookLast = null;
    this.jump = false;
    this.rotUnlock = false;
    this.primaryHeld = false;
  }

  // Build the on-screen controls once: a joystick zone (bottom-left) and an action
  // button (bottom-right). Positioning/orientation handling is pure CSS
  // (orientation media queries), so a rotate needs no JS. This DOM is created here,
  // in the input module — ui.js stays free of control logic.
  _buildTouchDom() {
    if (this._touchBuilt) return;
    const root = document.createElement('div');
    root.id = 'touchControls';
    root.className = 'hidden';

    const stick = document.createElement('div');
    stick.id = 'touchStick';
    stick.className = 'touch-stick-zone';

    const action = document.createElement('button');
    action.id = 'touchAction';
    action.type = 'button';
    action.className = 'touch-btn';
    action.textContent = 'ACTION';
    // pointerdown (not click) for zero-latency taps, and so it never bubbles to the
    // canvas look zone underneath.
    // pointerdown fires immediately AND arms hold-to-fire (main.js auto-repeats a hunter's
    // rifle while primaryHeld); pointerup/cancel/leave disarm it. A prop's single disguise
    // still happens on the initial pointerdown (main.js only auto-repeats for hunters).
    action.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      unlockAudio();
      this.primaryHeld = true;
      this.onAction('primary'); // main.js maps 'primary' to fire/disguise by role
    });
    const actionUp = () => { this.primaryHeld = false; };
    action.addEventListener('pointerup', actionUp);
    action.addEventListener('pointercancel', actionUp);
    action.addEventListener('pointerleave', actionUp);

    // Jump button (held): sets the same jump flag Space does on desktop.
    const jump = document.createElement('button');
    jump.id = 'touchJump';
    jump.type = 'button';
    jump.className = 'touch-btn touch-btn-sm';
    jump.textContent = 'JUMP';
    const jumpDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.jump = true;
    };
    const jumpUp = () => {
      this.jump = false;
    };
    jump.addEventListener('pointerdown', jumpDown);
    jump.addEventListener('pointerup', jumpUp);
    jump.addEventListener('pointercancel', jumpUp);
    jump.addEventListener('pointerleave', jumpUp);

    // Rotate button (held): the touch equivalent of holding right-click — lets a
    // disguised prop turn on yaw while pressed (never tips).
    const rotate = document.createElement('button');
    rotate.id = 'touchRotate';
    rotate.type = 'button';
    rotate.className = 'touch-btn touch-btn-sm';
    rotate.textContent = 'ROTATE';
    const rotDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.rotUnlock = true;
    };
    const rotUp = () => {
      this.rotUnlock = false;
    };
    rotate.addEventListener('pointerdown', rotDown);
    rotate.addEventListener('pointerup', rotUp);
    rotate.addEventListener('pointercancel', rotUp);
    rotate.addEventListener('pointerleave', rotUp);

    root.append(stick, action, jump, rotate);
    (this.canvas.parentElement || document.body).appendChild(root);
    this._touchRoot = root;
    this._stickZone = stick;
    this._touchBuilt = true;
  }

  async _initJoystick() {
    if (this._joystick || !this._stickZone) return;
    let factory;
    try {
      factory = await loadNipple();
    } catch {
      return; // CDN down: look + action still work; movement just unavailable
    }
    this._joystick = factory.create({
      zone: this._stickZone,
      mode: 'dynamic', // stick materialises wherever the thumb lands in the zone
      color: '#ff4fa3',
      size: 110,
      fadeTime: 100,
    });
    this._joystick.on('move', (_evt, data) => {
      if (!data || !data.vector) return;
      // nipplejs vector: x right(+), y up(+). Our convention: mx right(+),
      // mz forward(+). Forward == up.
      this.touchMove.mx = data.vector.x;
      this.touchMove.mz = data.vector.y;
    });
    this._joystick.on('end', () => {
      this.touchMove.mx = 0;
      this.touchMove.mz = 0;
    });
  }

  onKeyDown(e) {
    // Ctrl/Cmd+E toggles the in-game level editor (a desktop debug tool). Handled
    // FIRST — before the pointer-lock gate (so it works from the lobby, uncaptured)
    // and before KeyE's disguise action (so edit-toggle never doubles as a disguise).
    // The editor reads movement keys straight off `this.keys`; it does NOT use
    // pointer lock, so it never contends with the desktop mouse-look path.
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyE') {
      e.preventDefault();
      this.onToggleEdit();
      return;
    }
    // Backtick (`) — toggle desktop "UI mode": free the mouse for the DEBUG menu / UI WITHOUT
    // opening the pause menu (a deliberate third state; see main.js). Handled FIRST, before the
    // pointer-lock action gate, so it also toggles back OUT while unlocked. Does NOTHING while
    // typing in a text field (a backtick in a name/room code stays a plain character — we return
    // WITHOUT preventDefault) or on touch (no pointer lock there).
    if (e.code === 'Backquote') {
      if (this.touch || this._isTyping()) return;
      e.preventDefault();
      this.onToggleUiMode();
      return;
    }
    // Escape while the pointer is NOT locked (e.g. UI mode) opens the pause menu — pause TAKES
    // OVER from UI mode. When the pointer IS locked the browser's own Esc releases the lock and
    // main.js opens pause from the resulting pointerlockchange, so we defer to that path here to
    // avoid double-handling. Ignored while typing / on touch.
    if (e.code === 'Escape') {
      if (!this.touch && !this.locked && !this._isTyping()) this.onRequestPause();
      return;
    }
    // T — toggle the prop TAUNT menu. Handled BEFORE the pointer-lock gate (like Backquote) so it
    // both OPENS while playing (mouse captured) and CLOSES while the menu has freed the mouse. No-op
    // on touch (the on-screen taunt button covers it there) or while typing in a text field. main.js
    // gates it to a living prop, so a hunter's T press just does nothing.
    if (e.code === 'KeyT') {
      if (this.touch || this._isTyping()) return;
      e.preventDefault();
      this.onToggleTaunt();
      return;
    }
    this.keys.add(e.code);
    if (e.code === 'Space') {
      this.jump = true; // held; physics only jumps when grounded
      e.preventDefault(); // don't scroll the page
    }
    if (!this.locked) return;
    if (e.code === 'KeyE') this.onAction('disguise');
    if (e.code === 'KeyV') this.onToggleView();
    // HUNTER-TOOLS v1: number keys 1..9 select a hunter tool (main.js maps index → tool).
    if (/^Digit[1-9]$/.test(e.code)) this.onSelectTool(parseInt(e.code.slice(5), 10) - 1);
  }

  onKeyUp(e) {
    this.keys.delete(e.code);
    if (e.code === 'Space') this.jump = false;
  }

  // Drop every held control. Called on window blur so a key/button that was down when focus
  // left (its keyup/mouseup lands in another window) can't "stick" and keep the avatar
  // moving/firing while the player is Alt-Tabbed away. Look angles are untouched (they're
  // absolute, not held). Movement resumes the instant the player clicks back in and presses keys.
  _releaseHeldInput() {
    this.keys.clear();
    this.jump = false;
    this.rotUnlock = false;
    this.primaryHeld = false;
  }

  // True when a text field (name / room code) currently has focus. The ` and Esc hotkeys must
  // not fire while the player is typing — a backtick in a name is just a character, and Esc in a
  // field should blur/clear it, not toggle game state.
  _isTyping() {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    if (!a) return false;
    const tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || a.isContentEditable === true;
  }

  // Movement intent in local space: mz forward(+)/back(-), mx right(+)/left(-).
  // Keyboard and joystick are summed (then clamped) so a hybrid device can use
  // either; main.js normalises the combined vector before applying speed.
  moveVector() {
    let mz = 0;
    let mx = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.touch) {
      mx += this.touchMove.mx;
      mz += this.touchMove.mz;
    }
    return { mx: clamp(mx, -1, 1), mz: clamp(mz, -1, 1) };
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
