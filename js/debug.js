// In-game developer/debug menu. LOADED ONLY when the page URL carries ?debug=1 — the
// SAME single switch that turns on the collider wireframe view (js/scene.js). Without the
// flag, js/main.js never imports this module, so a normal match ships ZERO debug DOM,
// listeners, or styles: byte-for-byte normal play.
//
// It's a plain DOM overlay (no framework), phone-usable: a thumb-sized toggle button, a
// collapsible panel that never covers the whole screen, readable text. All panel code
// lives here; main.js only constructs it (under the flag) and calls onSnapshot()/frame().
//
// Host-authoritative actions (change team, reset, force-morph) route through the referee's
// `debug:` message family exactly like any normal state change — and the referee DROPS them
// unless the HOST also loaded with ?debug=1 (referee.debugEnabled), so a guest can't push
// debug commands into a normal match. Free cam / focus box / inspect are LOCAL rendering
// concerns handled through explicit scene seams (setFreeCam/updateFreeCam/debugPick/
// setFocusBox). "Exit game" is the existing back-to-menu path.
//
// See memory/notes/debug-menu.md.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const rad2deg = (v) => (Number.isFinite(v) ? Math.round((v * 180) / Math.PI) : v);

export class DebugMenu {
  // ctx: { state, input, ui, cfg, C2S, ROLE, PHASE, getScene, getSession, onExit }
  constructor(ctx) {
    this.ctx = ctx;
    this._snapshot = null; // latest authoritative snapshot (roster + counts)
    this._me = null; // this player's entry in the latest snapshot
    this._fps = 60;
    this._prevSelf = null; // previous predicted position, for a velocity estimate
    this._vel = { x: 0, y: 0, z: 0 };
    this._lastSlow = 0; // throttle timer for the heavier list rebuilds
    this._injectStyles();
    this._buildDom();
  }

  // ---- styling (self-contained; nothing lands in css/style.css) -------------
  _injectStyles() {
    if (document.getElementById('dbgStyle')) return;
    const s = el('style');
    s.id = 'dbgStyle';
    s.textContent = `
      #dbgToggle{position:fixed;top:8px;left:8px;z-index:46;min-width:44px;min-height:44px;
        padding:8px 12px;border:0;border-radius:10px;background:#12081fdd;color:#ff5af0;
        font:bold 13px/1 monospace;letter-spacing:1px;box-shadow:0 2px 8px #0008;cursor:pointer;}
      #dbgToggle:active{transform:scale(.96);}
      #dbgPanel{position:fixed;top:58px;left:8px;z-index:45;width:min(80vw,270px);
        max-height:76dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;
        background:#12081fee;color:#f0e6ff;border:1px solid #ff2fd066;border-radius:12px;
        padding:8px 10px 12px;font:12px/1.4 monospace;box-shadow:0 4px 16px #000a;}
      #dbgPanel.hidden{display:none;}
      .dbg-sec{margin:8px 0 4px;padding-top:6px;border-top:1px solid #ffffff1a;
        color:#ff8ae8;font-weight:bold;letter-spacing:1px;text-transform:uppercase;font-size:11px;}
      .dbg-sec:first-child{border-top:0;padding-top:0;margin-top:0;}
      .dbg-row{display:flex;justify-content:space-between;gap:8px;}
      .dbg-row b{color:#8ad9ff;font-weight:normal;}
      .dbg-row span{color:#f0e6ff;text-align:right;word-break:break-word;}
      .dbg-btns{display:flex;flex-wrap:wrap;gap:6px;}
      .dbg-btn{flex:1 1 auto;min-height:34px;padding:6px 8px;border:1px solid #ffffff33;
        border-radius:8px;background:#2a1b4a;color:#f5eaff;font:bold 12px/1 monospace;cursor:pointer;}
      .dbg-btn:active{transform:scale(.97);}
      .dbg-btn.on{background:#ff2fd0;color:#12081f;border-color:#ff2fd0;}
      .dbg-btn.warn{background:#4a1b2a;color:#ff9ab0;}
      .dbg-note{color:#9a86c4;font-size:10px;margin-top:4px;}
      .dbg-list{margin:2px 0;}
      .dbg-list div{display:flex;justify-content:space-between;gap:6px;padding:1px 0;}
      .dbg-list .r-h{color:#ff5a5a;} .dbg-list .r-p{color:#8ad9ff;} .dbg-list .r-d{color:#7be38b;}
      .dbg-dead{opacity:.45;text-decoration:line-through;}
      #dbgMorph{display:none;flex-wrap:wrap;gap:4px;max-height:150px;overflow-y:auto;margin-top:4px;}
      #dbgMorph.open{display:flex;}
      #dbgMorph button{flex:1 1 40%;min-height:30px;padding:4px;border:1px solid #ffffff22;
        border-radius:6px;background:#1a1030;color:#d9c9ff;font:11px monospace;cursor:pointer;}
      #dbgInspect{white-space:pre-wrap;color:#d9f5d9;background:#0c0616;border-radius:8px;
        padding:6px;margin-top:4px;min-height:18px;font-size:11px;}
    `;
    document.head.appendChild(s);
  }

  // ---- DOM ------------------------------------------------------------------
  _buildDom() {
    const { ROLE } = this.ctx;
    const toggle = el('button', null, 'DEBUG ▾');
    toggle.id = 'dbgToggle';
    toggle.type = 'button';
    toggle.addEventListener('click', () => this._toggleCollapse());
    this._toggle = toggle;

    const panel = el('div');
    panel.id = 'dbgPanel';
    this._panel = panel;

    // --- actions ---
    panel.appendChild(el('div', 'dbg-sec', 'Actions'));
    const teamBtns = el('div', 'dbg-btns');
    const bProp = el('button', 'dbg-btn', 'Be PROP');
    const bHunter = el('button', 'dbg-btn', 'Be HUNTER');
    bProp.addEventListener('click', () => this._sendDebug({ action: 'team', role: ROLE.PROP }));
    bHunter.addEventListener('click', () => this._sendDebug({ action: 'team', role: ROLE.HUNTER }));
    teamBtns.append(bProp, bHunter);
    panel.appendChild(teamBtns);

    const actBtns = el('div', 'dbg-btns');
    const bReset = el('button', 'dbg-btn', 'Reset game');
    const bExit = el('button', 'dbg-btn warn', 'Exit game');
    bReset.addEventListener('click', () => this._sendDebug({ action: 'reset' }));
    bExit.addEventListener('click', () => this.ctx.onExit && this.ctx.onExit());
    actBtns.append(bReset, bExit);
    panel.appendChild(actBtns);

    const viewBtns = el('div', 'dbg-btns');
    this._bFreeCam = el('button', 'dbg-btn', 'Free cam');
    this._bFocus = el('button', 'dbg-btn', 'Focus box');
    this._bFreeCam.addEventListener('click', () => this._toggleFreeCam());
    this._bFocus.addEventListener('click', () => this._toggleFocus());
    viewBtns.append(this._bFreeCam, this._bFocus);
    panel.appendChild(viewBtns);

    const morphRow = el('div', 'dbg-btns');
    const bMorph = el('button', 'dbg-btn', 'Force morph ▾');
    const bInspect = el('button', 'dbg-btn', 'Inspect ⌖');
    bMorph.addEventListener('click', () => this._morph.classList.toggle('open'));
    bInspect.addEventListener('click', () => this._doInspect());
    morphRow.append(bMorph, bInspect);
    panel.appendChild(morphRow);

    this._morph = el('div');
    this._morph.id = 'dbgMorph';
    this._buildMorphPicker();
    panel.appendChild(this._morph);

    panel.appendChild(el('div', 'dbg-note', 'Host must also run ?debug=1 for team/reset/morph to apply.'));

    // --- HUD / coords / fps ---
    panel.appendChild(el('div', 'dbg-sec', 'HUD'));
    this._fFps = this._kv(panel, 'fps');
    this._fCoords = this._kv(panel, 'xyz');
    this._fVel = this._kv(panel, 'vel');

    // --- local player states ---
    panel.appendChild(el('div', 'dbg-sec', 'Local player'));
    this._stateBody = el('div', 'dbg-list');
    panel.appendChild(this._stateBody);

    // --- roster ---
    panel.appendChild(el('div', 'dbg-sec', 'Players / ping'));
    this._rosterBody = el('div', 'dbg-list');
    panel.appendChild(this._rosterBody);

    // --- inspector ---
    panel.appendChild(el('div', 'dbg-sec', 'Inspector'));
    this._inspectBody = el('div');
    this._inspectBody.id = 'dbgInspect';
    this._inspectBody.textContent = 'Aim + tap Inspect (or enable Focus box).';
    panel.appendChild(this._inspectBody);

    document.body.append(toggle, panel);
    this._collapsed = false;
  }

  _kv(parent, label) {
    const row = el('div', 'dbg-row');
    row.appendChild(el('b', null, label));
    const v = el('span', null, '—');
    row.appendChild(v);
    parent.appendChild(row);
    return v;
  }

  _buildMorphPicker() {
    const types = Object.keys((this.ctx.cfg && this.ctx.cfg.props) || {}).sort();
    for (const t of types) {
      const b = el('button', null, t);
      b.type = 'button';
      b.addEventListener('click', () => {
        this._sendDebug({ action: 'morph', type: t });
        this._morph.classList.remove('open');
      });
      this._morph.appendChild(b);
    }
    if (!types.length) this._morph.appendChild(el('div', 'dbg-note', 'no props catalog'));
  }

  _toggleCollapse() {
    this._collapsed = !this._collapsed;
    this._panel.classList.toggle('hidden', this._collapsed);
    this._toggle.textContent = this._collapsed ? 'DEBUG ▸' : 'DEBUG ▾';
  }

  // ---- actions --------------------------------------------------------------
  _sendDebug(payload) {
    const sess = this.ctx.getSession();
    if (sess && sess.ready) sess.send({ t: this.ctx.C2S.DEBUG, ...payload });
    else if (this.ctx.ui) this.ctx.ui.feed('Debug: not in a match.');
  }

  _toggleFreeCam() {
    const scene = this.ctx.getScene();
    if (!scene) { if (this.ctx.ui) this.ctx.ui.feed('Free cam: start a match first.'); return; }
    const on = !this.ctx.state.freeCam;
    this.ctx.state.freeCam = on; // main.js reads this to freeze the physics player
    scene.setFreeCam(on);
    this._bFreeCam.classList.toggle('on', on);
  }

  _toggleFocus() {
    const scene = this.ctx.getScene();
    if (!scene) { if (this.ctx.ui) this.ctx.ui.feed('Focus box: start a match first.'); return; }
    this._focusOn = !this._focusOn;
    scene.setFocusBox(this._focusOn);
    this._bFocus.classList.toggle('on', !!this._focusOn);
  }

  // Reset the local view toggles' button state (main.js already turned the scene flags
  // off) so the panel doesn't show "on" for a free cam / focus box that no longer runs.
  resetView() {
    this._focusOn = false;
    if (this._bFreeCam) this._bFreeCam.classList.remove('on');
    if (this._bFocus) this._bFocus.classList.remove('on');
  }

  _doInspect() {
    const scene = this.ctx.getScene();
    if (!scene) { this._inspectBody.textContent = 'No scene yet.'; return; }
    this._renderInspector(scene.debugPick());
  }

  _renderInspector(info) {
    if (!info) { this._inspectBody.textContent = 'Nothing under the crosshair.'; return; }
    const p = info.pos || {};
    const rot = info.rot || {};
    const lines = [
      `${info.kind.toUpperCase()}  id:${info.id != null ? info.id : '—'}`,
      `type: ${info.type}`,
      `catalog: ${info.catalog}`,
      `pos: ${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}`,
      `rot°: ${rad2deg(rot.x)}, ${rad2deg(rot.y)}, ${rad2deg(rot.z)}`,
      `body: ${info.body}`,
      `sleeping: ${info.sleeping}`,
    ];
    if (info.kind === 'player') {
      lines.push(`role: ${info.role}   alive: ${info.alive}`);
      lines.push(info.disguisedPlayer ? `⚠ DISGUISED PLAYER as "${info.disguiseType}"` : 'not a disguised player');
    }
    this._inspectBody.textContent = lines.join('\n');
  }

  // ---- data hooks (called from main.js) -------------------------------------
  onSnapshot(msg) {
    this._snapshot = msg;
    this._me = msg.players ? msg.players.find((p) => p.id === this.ctx.state.selfId) : null;
  }

  // Per-frame update. Cheap displays every frame; heavier list rebuilds throttled. Also
  // drives the fly-cam and (when enabled) the live focus-box pick.
  frame(dt) {
    const { state, input } = this.ctx;
    const scene = this.ctx.getScene();

    // FPS (smoothed) + coords + a velocity estimate off the predicted position.
    if (dt > 0) this._fps += (1 / dt - this._fps) * 0.1;
    const self = state.self || { x: 0, y: 0, z: 0 };
    if (this._prevSelf && dt > 0) {
      this._vel.x = (self.x - this._prevSelf.x) / dt;
      this._vel.y = (self.y - this._prevSelf.y) / dt;
      this._vel.z = (self.z - this._prevSelf.z) / dt;
    }
    this._prevSelf = { x: self.x, y: self.y, z: self.z };
    this._fFps.textContent = Math.round(this._fps);
    this._fCoords.textContent = `${r2(self.x)}, ${r2(self.y)}, ${r2(self.z)}`;
    const spd = Math.hypot(this._vel.x, this._vel.z);
    this._fVel.textContent = `${spd.toFixed(1)} m/s (y ${r2(this._vel.y)})`;

    // FREE CAM: feed the fly-cam this frame's input. Physics player is frozen by main.js.
    if (state.freeCam && scene) {
      const mv = input.moveVector();
      const down = input.keys && (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'));
      scene.updateFreeCam({
        yaw: input.yaw, pitch: input.pitch,
        mx: mv.mx, mz: mv.mz,
        up: (input.jump ? 1 : 0) - (down ? 1 : 0),
        dt,
      });
    }

    // FOCUS BOX: keep the box (and live inspector) tracking the entity under the crosshair.
    if (this._focusOn && scene) this._renderInspector(scene.debugPick());

    // Heavier list rebuilds ~4 Hz.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._lastSlow > 250) {
      this._lastSlow = now;
      this._renderStates();
      this._renderRoster();
    }
  }

  _renderStates() {
    const { state, input } = this.ctx;
    const me = this._me;
    const pw = state.predict;
    const body = pw && pw.players && pw.players.get(state.SELF_ID);
    const gp = pw && pw.getPlayer && pw.getPlayer(state.SELF_ID);
    const rows = [
      ['role', state.role || '—'],
      ['phase', state.phase || '—'],
      ['disguise', (me && me.disguise) || (state.selfDisguised ? '(yes)' : 'none')],
      ['grounded', gp ? String(!!gp.grounded) : '—'],
      ['frozen/blind', String(!!input.lookFrozen)],
      ['alive', me ? String(!!me.alive) : '—'],
      ['capsule r/half', body ? `${r2(body.radius)} / ${r2(body.half)}` : '—'],
      ['velocity', `${Math.hypot(this._vel.x, this._vel.z).toFixed(1)} m/s`],
    ];
    this._stateBody.innerHTML = '';
    for (const [k, v] of rows) {
      const row = el('div');
      row.append(el('b', null, k), el('span', null, String(v)));
      this._stateBody.appendChild(row);
    }
  }

  _renderRoster() {
    const snap = this._snapshot;
    this._rosterBody.innerHTML = '';
    if (!snap || !snap.players || !snap.players.length) {
      this._rosterBody.appendChild(el('div', 'dbg-note', 'no players'));
      return;
    }
    const session = this.ctx.getSession();
    const pings = (session && session.pings) || new Map();
    for (const p of snap.players) {
      const row = el('div');
      const roleCls = p.disguise ? 'r-d' : p.hunter ? 'r-h' : 'r-p';
      const roleTxt = p.disguise ? `prop:${p.disguise}` : p.hunter ? 'hunter' : 'prop';
      const name = el('span', roleCls, `${p.name || p.id.slice(0, 4)} · ${roleTxt}`);
      if (!p.alive) name.classList.add('dbg-dead');
      const rtt = p.id === this.ctx.state.selfId ? 'you' : (pings.has(p.id) ? pings.get(p.id) + 'ms' : '—');
      row.append(name, el('span', null, rtt));
      this._rosterBody.appendChild(row);
    }
  }
}
