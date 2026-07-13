// DOM glue: screen switching, lobby list, HUD, and the kill/event feed.
// Holds no game logic — main.js drives it from server messages.
import { prefersTouchControls } from './input.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.el = {
      menu: $('menu'),
      lobby: $('lobby'),
      game: $('game'),
      menuError: $('menuError'),
      name: $('name'),
      roomCode: $('roomCode'),
      lobbyCode: $('lobbyCode'),
      playerList: $('playerList'),
      readyBtn: $('readyBtn'),
      startBtn: $('startBtn'),
      mapList: $('mapList'),
      copyLinkBtn: $('copyLinkBtn'),
      lobbyHint: $('lobbyHint'),
      hud: $('hud'),
      crosshair: $('crosshair'),
      hudRole: $('hudRole'),
      hudTimer: $('hudTimer'),
      hudProps: $('hudProps'),
      hudHealth: $('hudHealth'),
      toolbar: $('toolbar'),
      spectate: $('spectate'),
      banner: $('banner'),
      feed: $('feed'),
      clickToPlay: $('clickToPlay'),
      blindfold: $('blindfold'),
      blindfoldTimer: $('blindfoldTimer'),
      pauseBtn: $('pauseBtn'),
      pauseMenu: $('pauseMenu'),
      pauseScores: $('pauseScores'),
      pauseResume: $('pauseResume'),
      pauseHelp: $('pauseHelp'),
      pauseExit: $('pauseExit'),
      pauseHelpPanel: $('pauseHelpPanel'),
      pauseHelpBody: $('pauseHelpBody'),
    };
    // Pause-menu callbacks, injected by main.js (no game logic in the UI). Resume re-locks
    // the pointer / dismisses the menu; Exit leaves the match.
    this.onPauseResume = () => {};
    this.onPauseExit = () => {};
    if (this.el.pauseResume) this.el.pauseResume.addEventListener('click', () => this.onPauseResume());
    if (this.el.pauseExit) this.el.pauseExit.addEventListener('click', () => this.onPauseExit());
    if (this.el.pauseHelp) this.el.pauseHelp.addEventListener('click', () => this._togglePauseHelp());
    // HUNTER-TOOLS v1: the hunter tool bar calls this when a tool button is tapped/clicked.
    // main.js injects the real handler (selectTool). No game logic lives in the UI.
    this.onSelectTool = () => {};
    // Diagnostic: peerId -> true(relayed)/false(direct). Painted in the lobby so
    // a playtest can see whether the free TURN relay is being leaned on. Purely
    // informational; the network layer fills it via setLink().
    this.links = new Map();

    // Map picker data + callback, injected by main.js at boot. `maps` is the
    // shared maps.json catalog (the picker renders straight from it — data-driven,
    // so new maps need zero UI code). `onPickMap(mapId)` fires when the host taps a
    // map. The UI holds NO "am I host / is this legal" logic — the referee is the
    // gate; the picker only disables buttons for non-hosts cosmetically.
    this.maps = null;
    this.onPickMap = () => {};

    // Lobby rename: main.js injects onRename(newName) to relay a C2S.RENAME (the host is
    // the authority). Your OWN lobby row is an editable field; these track its in-progress
    // edit so a roster rebroadcast (someone else joins/readies) mid-typing doesn't wipe what
    // you're entering or steal focus. _rerendering guards the blur that fires when the old
    // input is torn down by a re-render (that's not a real "user finished editing").
    this.onRename = () => {};
    this._editingName = false;
    this._nameDraft = '';
    this._nameInput = null;
    this._rerendering = false;
  }

  show(screen) {
    for (const s of ['menu', 'lobby', 'game']) this.el[s].classList.toggle('hidden', s !== screen);
    const inGame = screen === 'game';
    this.el.hud.classList.toggle('hidden', !inGame);
    this.el.crosshair.classList.toggle('hidden', !inGame);
    // Leaving to the menu means the old peer links are gone — drop stale labels.
    if (screen === 'menu') this.links.clear();
  }

  menuError(msg) {
    this.el.menuError.textContent = msg || '';
  }

  lobbyHint(msg) {
    this.el.lobbyHint.textContent = msg || '';
  }

  renderLobby({ room, hostId, players, mapId, result }, selfId) {
    this.el.lobbyCode.textContent = room;
    // Clearing the list tears down the focused name input, which fires its blur — the
    // _rerendering flag tells that blur "this is a re-render, not the user finishing" so
    // it neither commits nor drops the editing state (restored below).
    this._rerendering = true;
    this.el.playerList.innerHTML = '';
    this._rerendering = false;
    this._nameInput = null;
    for (const p of players) {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      let nameNode;
      if (p.id === selfId) {
        // YOUR row is editable — rename yourself any time in the lobby, whether you're the
        // host or joined via an invite link. Everyone else's row stays read-only (you can
        // only rename yourself; the host validates and rebroadcasts). Keep whatever you're
        // typing on a mid-edit re-render (use the live draft, not the roster value).
        nameNode = this._buildSelfNameField(p, hostId === p.id);
      } else {
        nameNode = document.createElement('span');
        nameNode.textContent = p.name;
        if (p.id === hostId) nameNode.classList.add('host');
      }
      const status = document.createElement('span');
      status.textContent = p.ready ? 'ready' : '';
      status.classList.add('ready');
      const link = document.createElement('span');
      link.classList.add('link');
      this._paintLink(link, this.links.get(p.id));
      li.append(nameNode, link, status);
      this.el.playerList.appendChild(li);
    }
    // If the roster refreshed while you were editing your name, restore focus + caret so
    // typing isn't interrupted by an unrelated lobby update (join/ready/map pick).
    if (this._editingName && this._nameInput) {
      const inp = this._nameInput;
      inp.focus();
      const end = inp.value.length;
      try { inp.setSelectionRange(end, end); } catch { /* not all inputs support it */ }
    }
    const isHost = hostId === selfId;
    this.el.startBtn.classList.toggle('hidden', !isHost);
    this.renderMapPicker(mapId, isHost);
    // Persistent lobby: show who won the previous round (if any) ahead of the
    // ready/waiting hint, so a group running rounds back-to-back keeps the thread.
    const resultNote = result ? `${result.winner === 'hunter' ? 'HUNTERS' : 'PROPS'} won the last round. ` : '';
    this.el.lobbyHint.textContent = resultNote + (isHost
      ? 'You are host. Start whenever you like — you can go solo, and friends can join mid-round.'
      : 'Waiting for the host to start…');
  }

  // Build the editable name field for YOUR own lobby row. Tap to edit (works on phones);
  // commit on blur or Enter, cancel on Escape. The host is the authority — we just relay
  // the requested name via onRename; the referee trims/caps/de-dupes and rebroadcasts the
  // roster, so the next render shows the OFFICIAL name. Mid-edit re-renders are handled by
  // renderLobby (draft kept, focus restored, _rerendering-guarded blur).
  _buildSelfNameField(p, isHost) {
    const wrap = document.createElement('span');
    wrap.className = 'name-self';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'name-edit';
    input.maxLength = 16;
    input.setAttribute('aria-label', 'Your display name');
    input.title = 'Tap to change your name';
    // Keep the in-progress draft on a re-render; otherwise show the official roster name.
    input.value = (this._editingName ? this._nameDraft : p.name) || '';
    if (isHost) input.classList.add('host');
    const authName = p.name; // the roster's current official name (skip a no-op commit)
    input.addEventListener('focus', () => { this._editingName = true; this._nameDraft = input.value; });
    input.addEventListener('input', () => { this._nameDraft = input.value; });
    input.addEventListener('blur', () => {
      if (this._rerendering) return; // torn down by a roster re-render, not a real edit-end
      this._editingName = false;
      const v = input.value;
      if (v.trim() && v !== authName) this.onRename(v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { this._editingName = false; input.value = authName; input.blur(); }
    });
    this._nameInput = input;
    wrap.appendChild(input);
    const tag = document.createElement('span');
    tag.className = 'you-tag';
    tag.textContent = isHost ? '(you) ★' : '(you)';
    wrap.appendChild(tag);
    return wrap;
  }

  // Render the lobby map picker straight from the shared maps catalog. Every
  // client shows the list and highlights the current pick (so a late joiner sees
  // it too); only the host's buttons are live — non-hosts get them disabled, which
  // is purely cosmetic (the referee ignores a non-host pick regardless). Tapping a
  // map emits onPickMap(id); it does NOT change local state — the choice comes back
  // authoritatively in the next LOBBY message. No game logic here by house rule.
  renderMapPicker(mapId, isHost) {
    const list = this.el.mapList;
    if (!list) return;
    list.innerHTML = '';
    if (!this.maps) return;
    for (const [id, m] of Object.entries(this.maps)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-btn' + (id === mapId ? ' selected' : '');
      btn.textContent = m.name || id;
      btn.dataset.mapId = id;
      btn.disabled = !isHost; // cosmetic: non-hosts can look but not pick
      if (isHost) btn.addEventListener('click', () => this.onPickMap(id));
      list.appendChild(btn);
    }
  }

  // Record and paint how a peer connected. Called by the network layer once a
  // link resolves; may arrive just after renderLobby, so it updates the live row
  // too (renderLobby re-reads this.links on the next lobby update).
  setLink(id, relayed) {
    this.links.set(id, relayed);
    const row = this.el.playerList.querySelector(`li[data-id="${id}"] .link`);
    if (row) this._paintLink(row, relayed);
  }

  _paintLink(el, relayed) {
    if (relayed === undefined) {
      el.textContent = '';
      el.className = 'link';
      return;
    }
    el.textContent = relayed ? 'relayed' : 'direct';
    el.className = 'link ' + (relayed ? 'relayed' : 'direct');
  }

  // NOTE: the aim reticle is a FIXED crosshair positioned entirely by CSS — nothing
  // floats it per-frame. HUNTERS: exact screen centre (#crosshair: top/left 50%).
  // PROPS: 66% of the way up the screen (.prop-aim → top 34%) so the reticle clears the
  // player's own third-person body. The aim raycasts (scene.aimedDisguiseTarget /
  // aimDirection / debugPick) fire through the SAME point (scene.setAimMode), so there
  // is still ONE crosshair system. See setAimHint() for the only per-frame reticle
  // state (a dim "no target" tint for props), setAimMode() for the role flip.

  setRole(role) {
    this.el.hudRole.textContent = role === 'hunter' ? 'HUNTER' : 'PROP';
    this.el.hudRole.className = 'pill ' + role;
  }

  setHud({ phase, timeLeft, propsAlive, propsTotal }) {
    const t = Math.max(0, Math.ceil(timeLeft));
    this.el.hudTimer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.el.hudProps.textContent = `Props: ${propsAlive}/${propsTotal}`;
  }

  // HUNTER-TOOLS v1: own health as a filled BAR on the HUD (main.js passes the local player's
  // health from each snapshot). The bar fills the spare width of the top row; the number is
  // centred inside it. Fill goes green → amber → red as it drops. Both roles start at 100.
  setHealth(pct) {
    const el = this.el.hudHealth;
    if (!el) return;
    const v = Math.max(0, Math.min(100, Math.round(pct == null ? 100 : pct)));
    const fill = el.querySelector('.health-fill');
    const label = el.querySelector('.health-label');
    if (fill) fill.style.width = `${v}%`;
    if (label) label.textContent = `❤ ${v}%`;
    el.classList.toggle('crit', v <= 25);
    el.classList.toggle('warn', v > 25 && v <= 50);
  }

  // Build the hunter tool bar from a [{ id, name, key }] list (built for 4+ tools). Called
  // once at boot; visibility + highlight are driven per-state by setToolbar().
  buildToolbar(tools) {
    const bar = this.el.toolbar;
    if (!bar) return;
    bar.innerHTML = '';
    for (const t of tools || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-btn';
      btn.dataset.toolId = t.id;
      const key = document.createElement('span');
      key.className = 'tool-key';
      key.textContent = t.key;
      const name = document.createElement('span');
      name.textContent = t.name;
      btn.append(key, name);
      // pointerdown (not click) so a tap doesn't also punch through to the canvas / steal
      // pointer lock focus; preventDefault keeps the touch from scrolling.
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onSelectTool(t.id);
      });
      bar.appendChild(btn);
    }
  }

  // Show/hide the tool bar and highlight the current tool. `show` = local player is a live
  // hunter; `currentId` = the selected tool. Pure DOM — no game logic.
  setToolbar(show, currentId) {
    const bar = this.el.toolbar;
    if (!bar) return;
    bar.classList.toggle('hidden', !show);
    for (const btn of bar.children) btn.classList.toggle('selected', btn.dataset.toolId === currentId);
  }

  // Show/hide the dead-player spectator banner (hunters do not respawn).
  setSpectator(on) {
    if (this.el.spectate) this.el.spectate.classList.toggle('hidden', !on);
  }

  banner(text, ms = 0) {
    const b = this.el.banner;
    b.textContent = text;
    b.classList.remove('hidden');
    if (this._bt) clearTimeout(this._bt);
    if (ms > 0) this._bt = setTimeout(() => b.classList.add('hidden'), ms);
  }
  hideBanner() {
    this.el.banner.classList.add('hidden');
  }

  feed(text) {
    const d = document.createElement('div');
    d.textContent = text;
    this.el.feed.appendChild(d);
    while (this.el.feed.childElementCount > 5) this.el.feed.firstChild.remove();
    setTimeout(() => d.remove(), 6000);
  }

  // Overlay visibility is driven by input.js pointer-lock events, not polling:
  // shown while the mouse is uncaptured, hidden once the browser confirms lock.
  // An optional message replaces the default prompt to explain a refusal.
  setClickToPlay(visible, message) {
    this.el.clickToPlay.textContent = message || 'Click to play';
    this.el.clickToPlay.classList.toggle('hidden', !visible);
  }

  // HUNTER BLINDFOLD (visual half). main.js derives `blind` fresh every snapshot /
  // phase event from (role === hunter && phase === HIDING) and calls this — so it is
  // a plain show/hide, never a latched toggle. Props always arrive with blind=false
  // (overlay hidden → they see the world), a hunter gets blind=true only during
  // HIDING, and it clears the instant HUNT begins. `seconds` is the HIDING countdown
  // remaining (float); shown rounded up. The referee also withholds prop positions
  // from a blinded hunter, so removing this overlay reveals nothing to peek at.
  setBlindfold(blind, seconds) {
    if (blind && Number.isFinite(seconds)) {
      this.el.blindfoldTimer.textContent = Math.max(0, Math.ceil(seconds));
    }
    this.el.blindfold.classList.toggle('hidden', !blind);
  }

  // ---- pause menu (Escape / ☰) ----------------------------------------------
  // A menu OVERLAY, not a real pause — the world runs on the host. Shows a live scoreboard
  // (everyone + health), a controls/help panel, Resume, and Exit. main.js drives visibility
  // and feeds the roster from each snapshot while it's open.
  showPause(players, selfId) {
    this.updatePauseScoreboard(players, selfId);
    if (this.el.pauseHelpPanel) this.el.pauseHelpPanel.classList.add('hidden'); // help starts collapsed
    if (this.el.pauseMenu) this.el.pauseMenu.classList.remove('hidden');
  }

  hidePause() {
    if (this.el.pauseMenu) this.el.pauseMenu.classList.add('hidden');
    if (this.el.pauseHelpPanel) this.el.pauseHelpPanel.classList.add('hidden');
  }

  // Rebuild the scoreboard rows: every player with their role/disguise + current health.
  updatePauseScoreboard(players, selfId) {
    const list = this.el.pauseScores;
    if (!list) return;
    list.innerHTML = '';
    for (const p of players || []) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'ps-name';
      const roleTxt = p.disguise ? `prop · ${p.disguise}` : p.hunter ? 'hunter' : 'prop';
      who.textContent = `${p.name || (p.id || '').slice(0, 4)}${p.id === selfId ? ' (you)' : ''} — ${roleTxt}`;
      if (!p.alive) who.classList.add('ps-dead');
      const hp = document.createElement('span');
      hp.className = 'ps-hp';
      const v = Math.max(0, Math.round(p.health == null ? 100 : p.health));
      hp.textContent = p.alive ? `❤ ${v}%` : '☠ dead';
      if (p.alive && v <= 25) hp.classList.add('crit');
      li.append(who, hp);
      list.appendChild(li);
    }
    if (!list.childElementCount) list.appendChild(this._li('No players.'));
  }

  _li(text) {
    const li = document.createElement('li');
    li.className = 'ps-empty';
    li.textContent = text;
    return li;
  }

  _togglePauseHelp() {
    const panel = this.el.pauseHelpPanel;
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      if (this.el.pauseHelpBody) this.el.pauseHelpBody.innerHTML = this._controlsHtml();
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  _controlsHtml() {
    // SAME classification as input.js (pointer-capability, not "can be touched") so the
    // controls-help list can never disagree with which scheme is actually wired.
    const touch = prefersTouchControls();
    const rows = touch
      ? [
          ['Left joystick', 'Move'],
          ['Drag (right side)', 'Look'],
          ['ACTION (hold)', 'Hunter: fire the rifle · Prop: disguise as what you aim at'],
          ['JUMP', 'Jump'],
          ['ROTATE (hold)', 'Turn a disguise'],
          ['☰', 'This menu'],
        ]
      : [
          ['WASD / Arrows', 'Move'],
          ['Mouse', 'Look (click the view to capture the mouse)'],
          ['Left-click (hold)', 'Hunter: rapid-fire the rifle · Prop: disguise as what you aim at'],
          ['Right-click (hold)', 'Turn a disguise'],
          ['Space', 'Jump'],
          ['E', 'Disguise (prop)'],
          ['1 / 2', 'Pick hunter tool'],
          ['V', 'Toggle view'],
          ['`', 'Free the mouse for debug/UI — click the view to resume'],
          ['Esc', 'This menu (releases the mouse; Resume re-locks)'],
        ];
    return rows.map(([k, v]) => `<div class="pause-help-row"><b>${k}</b><span>${v}</span></div>`).join('');
  }

  // Crosshair aim feedback for PROPs. main.js calls this every frame with
  // `noTarget = (aimed prop id == null)`: true when the player is aiming at nothing
  // disguisable (dim the reticle as a hint), false when a valid prop is targeted or
  // the hint doesn't apply (hunter/dead/lobby → bright default). Pure show/hide on the
  // existing crosshair element — no new DOM, and guaranteed non-throwing (this method
  // going missing is exactly what blanked the render loop; keep it defined).
  setAimHint(noTarget) {
    if (!this.el.crosshair) return;
    this.el.crosshair.classList.toggle('no-target', !!noTarget);
  }
}
