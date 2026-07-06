// Mobile touch controls. Wires the on-screen widgets in index.html (#touch) to
// the shared Input instance so the game reads ONE intent no matter the device:
//   - left virtual joystick  -> input.touchMove {mx, mz}
//   - drag on the look layer  -> input.applyLookDelta() (yaw/pitch, like the mouse)
//   - JUMP / CROUCH buttons   -> input.touchJump / input.touchCrouch (held)
//   - ACTION button           -> input.onAction('primary') (tag or disguise by role)
//
// This is intentionally isolated from input.js (keyboard/mouse) — the mobile
// layer is easy to find and change, and desktop is untouched. Multi-touch is
// handled by tracking touch identifiers so looking + moving + a button press
// can happen at once. See memory/notes/mobile.md.
export function setupTouchControls(input, ui) {
  const $ = (id) => document.getElementById(id);
  const root = $('touch');
  const lookLayer = $('touchLook');
  const joy = $('joystick');
  const knob = $('joyKnob');
  const btnAction = $('btnAction');
  const btnJump = $('btnJump');
  const btnCrouch = $('btnCrouch');
  if (!root || !lookLayer || !joy || !knob) return; // DOM missing — no-op

  // ---- look: drag anywhere on the look layer (the screen minus the widgets) --
  // One finger owns the look drag at a time, tracked by its identifier so a
  // second finger on the joystick/buttons doesn't hijack it.
  let lookId = null;
  let lookX = 0;
  let lookY = 0;

  lookLayer.addEventListener(
    'touchstart',
    (e) => {
      if (lookId !== null) return;
      const t = e.changedTouches[0];
      lookId = t.identifier;
      lookX = t.clientX;
      lookY = t.clientY;
      e.preventDefault();
    },
    { passive: false }
  );
  lookLayer.addEventListener(
    'touchmove',
    (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        input.applyLookDelta(t.clientX - lookX, t.clientY - lookY);
        lookX = t.clientX;
        lookY = t.clientY;
        e.preventDefault();
      }
    },
    { passive: false }
  );
  const endLook = (e) => {
    for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null;
  };
  lookLayer.addEventListener('touchend', endLook);
  lookLayer.addEventListener('touchcancel', endLook);

  // ---- joystick: normalized offset within its radius -> move intent ----------
  let joyId = null;
  const RADIUS = 46; // px; matches the .joystick size in style.css

  const setKnob = (dx, dy) => {
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const resetJoy = () => {
    joyId = null;
    input.touchMove.mx = 0;
    input.touchMove.mz = 0;
    setKnob(0, 0);
  };
  const moveJoy = (clientX, clientY) => {
    const r = joy.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setKnob(dx, dy);
    // Screen up (negative dy) = forward (mz +). Screen right (dx +) = strafe right.
    input.touchMove.mx = dx / RADIUS;
    input.touchMove.mz = -dy / RADIUS;
  };

  joy.addEventListener(
    'touchstart',
    (e) => {
      if (joyId !== null) return;
      const t = e.changedTouches[0];
      joyId = t.identifier;
      moveJoy(t.clientX, t.clientY);
      e.preventDefault();
    },
    { passive: false }
  );
  joy.addEventListener(
    'touchmove',
    (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyId) continue;
        moveJoy(t.clientX, t.clientY);
        e.preventDefault();
      }
    },
    { passive: false }
  );
  const endJoy = (e) => {
    for (const t of e.changedTouches) if (t.identifier === joyId) resetJoy();
  };
  joy.addEventListener('touchend', endJoy);
  joy.addEventListener('touchcancel', endJoy);

  // ---- buttons ---------------------------------------------------------------
  // Held buttons (jump/crouch) mirror keyboard held-state; the referee only acts
  // on jump when grounded, so holding can't spam hops (same as Space).
  const hold = (el, set) => {
    if (!el) return;
    const down = (e) => {
      set(true);
      el.classList.add('pressed');
      e.preventDefault();
    };
    const up = (e) => {
      set(false);
      el.classList.remove('pressed');
      e.preventDefault();
    };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  };
  hold(btnJump, (v) => (input.touchJump = v));
  hold(btnCrouch, (v) => (input.touchCrouch = v));

  // Action = the role's primary (hunter: tag / prop: disguise at the crosshair).
  // main.js routes 'primary' by role, exactly like the mouse/keyboard path.
  if (btnAction) {
    btnAction.addEventListener(
      'touchstart',
      (e) => {
        input.onAction('primary');
        btnAction.classList.add('pressed');
        e.preventDefault();
      },
      { passive: false }
    );
    const release = () => btnAction.classList.remove('pressed');
    btnAction.addEventListener('touchend', release);
    btnAction.addEventListener('touchcancel', release);
  }

  // Show the controls only while in game (the UI toggles this alongside screens).
  if (ui) ui.enableTouch();
}
