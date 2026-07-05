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
    if (e.code === 'KeyE') this.onAction('disguise');
    if (e.code === 'KeyF' || e.code === 'Space') this.onAction('tag');
  }

  // Movement intent in local space: mz forward(+)/back(-), mx right(+)/left(-).
  moveVector() {
    let mz = 0;
    let mx = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    return { mx, mz };
  }
}
