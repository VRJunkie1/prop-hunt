// Keyboard + pointer-lock mouse look. Produces a movement intent (mx, mz) and
// look angles (yaw, pitch) that main.js forwards to the server. Also surfaces
// discrete action key presses (disguise, tag) via callbacks.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.sensitivity = 0.0022;

    // Touch layer (mobile). The on-screen controls in touch.js write these; the
    // getters/moveVector below fold them in so the rest of the game reads ONE
    // intent regardless of input device. isTouch just gates whether we show the
    // controls + skip the click-to-play/pointer-lock prompt (pointer lock is a
    // no-op on phones). See client/js/touch.js and memory/notes/mobile.md.
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.touchMove = { mx: 0, mz: 0 }; // from the virtual joystick, [-1..1]
    this.touchJump = false; // held while the on-screen JUMP button is pressed
    this.touchCrouch = false; // held while the on-screen CROUCH button is pressed

    this.onAction = () => {}; // (name) => void  for 'disguise' | 'tag'

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.addEventListener('click', () => {
      if (!this.locked) canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    });
    // Left click = the role's primary action while locked.
    canvas.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) this.onAction('primary');
    });
  }

  onKeyDown(e) {
    this.keys.add(e.code);
    if (!this.locked) return;
    // Space now jumps (below via held-state), so stop the page from scrolling.
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyE') this.onAction('disguise');
    if (e.code === 'KeyF') this.onAction('tag'); // Space freed up for jumping
  }

  // Movement intent in local space: mz forward(+)/back(-), mx right(+)/left(-).
  moveVector() {
    let mz = 0;
    let mx = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    // Fold in the virtual joystick (phones have no keyboard, so on touch these
    // are the only contributors). main.js normalizes the final vector, so adding
    // both sources can't exceed max speed.
    mx += this.touchMove.mx;
    mz += this.touchMove.mz;
    return { mx, mz };
  }

  // Held-state jump/crouch. Held (not edge-triggered) so the referee and the
  // client prediction read the SAME signal each step and stay in sync — the
  // referee only acts on jump when grounded, so holding Space doesn't spam hops.
  get jump() {
    return this.keys.has('Space') || this.touchJump;
  }
  get crouch() {
    return (
      this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC') || this.touchCrouch
    );
  }

  // Apply a look-drag delta (pixels) from the touch layer, mirroring the mouse
  // path above so the feel + pitch clamp stay identical across devices.
  applyLookDelta(dx, dy, sensitivity = 0.004) {
    this.yaw -= dx * sensitivity;
    this.pitch -= dy * sensitivity;
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
  }
}
