// DOM glue: screen switching, lobby list, HUD, and the kill/event feed.
// Holds no game logic — main.js drives it from server messages.
import { prefersTouchControls } from './input.js';
import { formatClock } from './hud-timer.js';

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
      // SPECTATOR (B6): dynamic hint line + the on-screen phone control bar (◀ / FLY / ▶).
      spectateHint: $('spectateHint'),
      spectateBar: $('spectateBar'),
      spectatePrev: $('spectatePrev'),
      spectateFree: $('spectateFree'),
      spectateNext: $('spectateNext'),
      banner: $('banner'),
      // VOTE-KICK (2026-07-19): the top-of-screen live banner + its Yes/No buttons. setVoteKick()
      // populates the text and shows/hides the buttons per eligibility; main.js injects the callbacks.
      voteKick: $('voteKick'),
      voteKickText: $('voteKickText'),
      voteKickBtns: $('voteKickBtns'),
      voteYes: $('voteYes'),
      voteNo: $('voteNo'),
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
      // PAUSE-MENU (2026-07-17): team-switch button + the room-code display & copy button (add players
      // mid-game). Callbacks injected by main.js — the UI holds no game logic.
      pauseSwitch: $('pauseSwitch'),
      pauseRoomCode: $('pauseRoomCode'),
      pauseCopyRoom: $('pauseCopyRoom'),
      // MOUSE SENSITIVITY slider (B4, PC only). Row hidden on touch below.
      pauseSensRow: $('pauseSensRow'),
      pauseSens: $('pauseSens'),
      pauseSensVal: $('pauseSensVal'),
      // LIGHTING QUALITY tiers + TONEMAP A/B + exposure (2026-07-19, VRmike). Shown on all devices.
      lightingTiers: $('lightingTiers'),
      tonemapModes: $('tonemapModes'),
      exposureSlider: $('exposureSlider'),
      exposureVal: $('exposureVal'),
      // PC CONTROLS REFERENCE (B4): always-visible corner list + its collapse toggle. PC only.
      controlsRef: $('controlsRef'),
      controlsRefToggle: $('controlsRefToggle'),
      controlsRefBody: $('controlsRefBody'),
      // AUDIO TAUNTS (props): the taunt button, the (while-playing) stop button, and the
      // scrolling menu with its list + close + empty-state note.
      tauntBtn: $('tauntBtn'),
      tauntStopBtn: $('tauntStopBtn'),
      tauntStopInline: $('tauntStopInline'), // STOP button INSIDE the menu (same handler as the floating one)
      tauntMenu: $('tauntMenu'),
      tauntList: $('tauntList'),
      tauntClose: $('tauntClose'),
      tauntEmpty: $('tauntEmpty'),
    };
    // Pause-menu callbacks, injected by main.js (no game logic in the UI). Resume re-locks
    // the pointer / dismisses the menu; Exit leaves the match.
    this.onPauseResume = () => {};
    this.onPauseExit = () => {};
    this.onPauseSwitch = () => {};   // PAUSE-MENU TEAM SWITCH
    this.onPauseCopyRoom = () => {}; // COPY ROOM CODE (mid-game join)
    // VOTE-KICK callbacks (injected by main.js — no game logic here). onVoteKick(targetId) starts a
    // vote from a scoreboard kick button; onVoteCast(true|false) casts Yes/No from the banner buttons.
    this.onVoteKick = () => {};
    this.onVoteCast = () => {};
    if (this.el.voteYes) this.el.voteYes.addEventListener('click', () => this.onVoteCast(true));
    if (this.el.voteNo) this.el.voteNo.addEventListener('click', () => this.onVoteCast(false));
    if (this.el.pauseResume) this.el.pauseResume.addEventListener('click', () => this.onPauseResume());
    if (this.el.pauseExit) this.el.pauseExit.addEventListener('click', () => this.onPauseExit());
    if (this.el.pauseHelp) this.el.pauseHelp.addEventListener('click', () => this._togglePauseHelp());
    if (this.el.pauseSwitch) this.el.pauseSwitch.addEventListener('click', () => this.onPauseSwitch());
    if (this.el.pauseCopyRoom) this.el.pauseCopyRoom.addEventListener('click', () => this.onPauseCopyRoom());
    // MOUSE SENSITIVITY (B4, PC only). The slider fires 'input' continuously while dragging, so the
    // look feel changes LIVE (no Apply/restart). main.js injects onSensitivityChange to apply it to
    // input.js AND persist to localStorage. Hide the whole row on touch (the same prefersTouchControls
    // check the control scheme uses) — the mobile drag-look sensitivity is a separate, untouched knob.
    this.onSensitivityChange = () => {};
    if (this.el.pauseSensRow && prefersTouchControls()) this.el.pauseSensRow.classList.add('hidden');
    if (this.el.pauseSens) {
      this.el.pauseSens.addEventListener('input', () => {
        const mult = parseFloat(this.el.pauseSens.value);
        this._renderSensVal(mult);
        this.onSensitivityChange(mult);
      });
    }
    // LIGHTING QUALITY + TONEMAP (2026-07-19, VRmike). main.js injects the handlers; the UI only
    // relays the pick (no game logic). Tier buttons + tonemap-mode buttons use event delegation off
    // their container so the highlight can be re-pushed from state (setLightingTier/setTonemap).
    this.onLightingTier = () => {};
    this.onTonemapMode = () => {};
    this.onExposureChange = () => {};
    if (this.el.lightingTiers) {
      this.el.lightingTiers.addEventListener('click', (e) => {
        const btn = e.target.closest('.lighting-tier');
        if (!btn) return;
        this.onLightingTier(parseInt(btn.dataset.tier, 10));
      });
    }
    if (this.el.tonemapModes) {
      this.el.tonemapModes.addEventListener('click', (e) => {
        const btn = e.target.closest('.tonemap-mode');
        if (!btn) return;
        this.onTonemapMode(btn.dataset.mode);
      });
    }
    if (this.el.exposureSlider) {
      this.el.exposureSlider.addEventListener('input', () => {
        const v = parseFloat(this.el.exposureSlider.value);
        this._renderExposureVal(v);
        this.onExposureChange(v);
      });
    }
    // PC CONTROLS REFERENCE (B4): the collapse toggle just shows/hides the body (visible by default).
    if (this.el.controlsRefToggle) {
      this.el.controlsRefToggle.addEventListener('click', () => this._toggleControlsRef());
    }
    // ROLE-FILTERED CONTROLS LIST (B8, 2026-07-18): the controls reference shows ONLY the current
    // player's role — 'hunter' | 'prop' | 'spectator' | null (pre-role / lobby). main.js pushes the
    // mode via setControlsRole() whenever the role changes (team switch, round flip, death, respawn),
    // and _controlsHtml() renders from it. Null before a role is known (shows the shared move/look rows).
    this._controlsRole = null;
    // SPECTATOR (B6): the on-screen phone controls. Callbacks injected by main.js (no game logic here).
    this.onSpectatePrev = () => {};
    this.onSpectateNext = () => {};
    this.onSpectateFree = () => {};
    if (this.el.spectatePrev) this.el.spectatePrev.addEventListener('click', () => this.onSpectatePrev());
    if (this.el.spectateNext) this.el.spectateNext.addEventListener('click', () => this.onSpectateNext());
    if (this.el.spectateFree) this.el.spectateFree.addEventListener('click', () => this.onSpectateFree());
    // HUNTER-TOOLS v1: the hunter tool bar calls this when a tool button is tapped/clicked.
    // main.js injects the real handler (selectTool). No game logic lives in the UI.
    this.onSelectTool = () => {};

    // AUDIO TAUNTS: callbacks injected by main.js (the UI holds no game logic). onTauntButton =
    // the taunt button was tapped (main.js opens the menu, freeing the mouse on desktop);
    // onTauntPick(id) = a taunt row was tapped (main.js relays it — the menu STAYS open for spam);
    // onTauntStop = the stop button was tapped; onTauntClose = the ✕ closed the menu without
    // playing; onTauntPrefetch = fired when the menu opens so main.js can background-prefetch the
    // library. Wired to pointerdown so a tap unlocks audio + never bubbles to the canvas.
    this.onTauntButton = () => {};
    this.onTauntPick = () => {};
    this.onTauntStop = () => {};
    this.onTauntClose = () => {};
    this.onTauntPrefetch = () => {};
    if (this.el.tauntBtn) {
      this.el.tauntBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.onTauntButton(); });
    }
    if (this.el.tauntStopBtn) {
      this.el.tauntStopBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.onTauntStop(); });
    }
    // The in-menu Stop button shares the exact same handler — it just lives inside the taunt card so
    // you can silence a taunt without leaving the menu (the menu stays open).
    if (this.el.tauntStopInline) {
      this.el.tauntStopInline.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.onTauntStop(); });
    }
    if (this.el.tauntClose) {
      this.el.tauntClose.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.onTauntClose(); });
    }
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

  setHud({ timeLeft, propsAlive, propsTotal }) {
    this.setTimer(timeLeft); // immediate render on a snapshot; the frame loop keeps it ticking
    this.el.hudProps.textContent = `Props: ${propsAlive}/${propsTotal}`;
  }

  // GAME TIMER DESYNC FIX (2026-07-18): the countdown is TICKED LOCALLY every frame from a
  // client-side anchor (HudTimer), re-synced on each snapshot — so a snapshot stall can't
  // freeze it. main.js's frame loop calls this with the locally-computed seconds remaining;
  // setHud calls it too for an immediate render on each snapshot. formatClock clamps at 0:00
  // (round END stays host-authoritative — the display just waits at 0 for the host's event).
  setTimer(seconds) {
    this.el.hudTimer.textContent = formatClock(seconds);
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
      name.className = 'tool-name';
      name.textContent = t.name;
      btn.dataset.baseName = t.name; // PROP FINDER: base label so setToolCooldown can append "(14s)"
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

  // PROP FINDER: show the remaining cooldown right on a tool's button/name (VRmike's preferred
  // "Finder (14s)"). secondsLeft <= 0 (or null) restores the base name and clears the cooling
  // style; > 0 appends the countdown + greys the button so the tool always reads as "not ready".
  setToolCooldown(toolId, secondsLeft) {
    const bar = this.el.toolbar;
    if (!bar) return;
    for (const btn of bar.children) {
      if (btn.dataset.toolId !== toolId) continue;
      const nameEl = btn.querySelector('.tool-name');
      const base = btn.dataset.baseName || (nameEl && nameEl.textContent) || '';
      const s = Math.ceil(secondsLeft || 0);
      const cooling = s > 0;
      if (nameEl) nameEl.textContent = cooling ? `${base} (${s}s)` : base;
      btn.classList.toggle('cooling', cooling);
    }
  }

  // PROP FINDER: lock/unlock the PROP's own taunt UI while a finder-forced (uncancellable) taunt
  // plays — the prop can't start their own taunt until it finishes. Disables + greys the floating
  // taunt button and closes the menu (main.js gates opening on the same lock). Pure DOM.
  setTauntLocked(locked) {
    if (this.el.tauntBtn) {
      this.el.tauntBtn.classList.toggle('locked', !!locked);
      this.el.tauntBtn.disabled = !!locked;
    }
    if (locked) this.closeTauntMenu();
  }

  // Show/hide the dead-player spectator vignette (hunters do not respawn).
  setSpectator(on) {
    if (this.el.spectate) this.el.spectate.classList.toggle('hidden', !on);
  }

  // SPECTATOR (B6): update the vignette's dynamic hint line (fly vs follow controls). main.js
  // composes the text (device-aware); the UI just paints it. Pure show — no game logic.
  setSpectateHint(text) {
    if (this.el.spectateHint) this.el.spectateHint.textContent = text;
  }

  // SPECTATOR (B6): show/hide the on-screen phone control bar (◀ / FLY / ▶). Only meaningful on
  // touch — PC spectators use left-click + Space — so it's revealed only when `touch` AND `on`.
  setSpectateControls(on, touch) {
    if (this.el.spectateBar) this.el.spectateBar.classList.toggle('hidden', !(on && touch));
  }

  // ---- AUDIO TAUNTS (props) -------------------------------------------------
  // Build the scrolling taunt list from the manifest ([{ id, label }], possibly empty). Called
  // once at boot — DATA-DRIVEN, so the ~50 real clips later need ZERO UI code (drop files + add
  // manifest lines). An empty library shows the "no taunts yet" note and no rows. Each row is a
  // big touch target; a tap relays that id and LEAVES the menu open (back-to-back spam is intended).
  buildTauntList(taunts) {
    const list = this.el.tauntList;
    if (!list) return;
    list.innerHTML = '';
    const items = Array.isArray(taunts) ? taunts : [];
    for (const t of items) {
      if (!t || !t.id) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'taunt-item';
      btn.setAttribute('role', 'listitem');
      btn.dataset.tauntId = t.id;
      btn.textContent = t.label || t.id;
      // pointerdown (not click): zero-latency on touch, unlocks audio in the gesture, and never
      // punches through to the canvas. The menu is deliberately NOT closed here.
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onTauntPick(t.id);
      });
      list.appendChild(btn);
    }
    if (this.el.tauntEmpty) this.el.tauntEmpty.classList.toggle('hidden', items.length > 0);
  }

  // Open the taunt menu (main.js has already freed the mouse on desktop). Kicks off the background
  // prefetch so most picks are already decoded by the time they're clicked.
  openTauntMenu() {
    if (!this.el.tauntMenu) return;
    this.el.tauntMenu.classList.remove('hidden');
    this.onTauntPrefetch();
  }
  closeTauntMenu() {
    if (this.el.tauntMenu) this.el.tauntMenu.classList.add('hidden');
  }
  isTauntMenuOpen() {
    return !!(this.el.tauntMenu && !this.el.tauntMenu.classList.contains('hidden'));
  }
  // Show/hide the taunt button (a living prop in an active phase).
  setTauntButton(show) {
    if (this.el.tauntBtn) this.el.tauntBtn.classList.toggle('hidden', !show);
  }
  // Show/hide the stop button (only while YOUR own cancellable taunt is playing). Toggles BOTH the
  // floating on-screen button (the mobile control) and the in-menu Stop button together, so whichever
  // is visible reflects the same "your taunt is playing" state.
  setTauntStop(show) {
    if (this.el.tauntStopBtn) this.el.tauntStopBtn.classList.toggle('hidden', !show);
    if (this.el.tauntStopInline) this.el.tauntStopInline.classList.toggle('hidden', !show);
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
  showPause(players, selfId, selfIsHunter, voteCtx) {
    this.updatePauseScoreboard(players, selfId, selfIsHunter, voteCtx);
    if (this.el.pauseHelpPanel) this.el.pauseHelpPanel.classList.add('hidden'); // help starts collapsed
    if (this.el.pauseMenu) this.el.pauseMenu.classList.remove('hidden');
  }

  // Show the room code in the pause menu (for the copy button — adding players mid-game).
  setPauseRoom(code) {
    if (this.el.pauseRoomCode) this.el.pauseRoomCode.textContent = code || '----';
  }

  hidePause() {
    if (this.el.pauseMenu) this.el.pauseMenu.classList.add('hidden');
    if (this.el.pauseHelpPanel) this.el.pauseHelpPanel.classList.add('hidden');
  }

  // Rebuild the scoreboard rows: every player with their role + current health. DISGUISE-INFO LEAK
  // FIX: the disguise label ("prop · burger") is shown ONLY when the VIEWER is a prop — a HUNTER never
  // sees what any prop is disguised as. (The host also withholds disguised props' NAMES from hunters,
  // so a hunter's data can't tie a name to a disguise even in devtools; here a name-less prop entry
  // renders anonymously as "a prop".) selfIsHunter gates the client half.
  updatePauseScoreboard(players, selfId, selfIsHunter, voteCtx) {
    const list = this.el.pauseScores;
    if (!list) return;
    // VOTE-KICK context (2026-07-19): { hostId, voteActive, cooldownUntil:Map<id,ms>, now }. A "vote
    // kick" button sits on every OTHER player's row EXCEPT the host's (the host IS the server — kicking
    // them ends the match; that needs host migration). The button is greyed while ANY vote is active or
    // during that target's post-fail cooldown (the host enforces the real rule; this is the polite half).
    const vc = voteCtx || {};
    const now = vc.now || (typeof performance !== 'undefined' ? performance.now() : 0);
    list.innerHTML = '';
    for (const p of players || []) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'ps-name';
      const showDisguise = p.disguise && !selfIsHunter; // hunters never see prop disguises
      const roleTxt = showDisguise ? `prop · ${p.disguise}` : p.hunter ? 'hunter' : 'prop';
      const nm = p.id === selfId ? (p.name || 'you') : (p.name || 'a prop'); // host may strip a disguised prop's name for hunters
      who.textContent = `${nm}${p.id === selfId ? ' (you)' : ''} — ${roleTxt}`;
      if (!p.alive) who.classList.add('ps-dead');
      const hp = document.createElement('span');
      hp.className = 'ps-hp';
      const v = Math.max(0, Math.round(p.health == null ? 100 : p.health));
      hp.textContent = p.alive ? `❤ ${v}%` : '☠ dead';
      if (p.alive && v <= 25) hp.classList.add('crit');
      li.append(who, hp);
      // VOTE-KICK button — on every OTHER player's row (host AND guests see it, so anyone can start a
      // vote), never on our own row. The HOST's row shows a greyed "can't kick" note instead of a button:
      // the host IS the server, so kicking them would end the match for everyone (needs host migration, a
      // separate feature). Showing the note — rather than a bare empty row — makes clear WHY there's no
      // button there, so a guest in a 2-player room doesn't read it as broken.
      if (p.id !== selfId && p.id !== vc.hostId) {
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'ps-kick';
        kick.textContent = 'vote kick';
        const cdUntil = (vc.cooldownUntil && vc.cooldownUntil.get(p.id)) || 0;
        const onCooldown = now < cdUntil;
        kick.disabled = !!vc.voteActive || onCooldown;
        if (onCooldown) kick.title = 'Recently voted on — try again shortly.';
        else if (vc.voteActive) kick.title = 'A vote is already in progress.';
        kick.addEventListener('click', () => this.onVoteKick(p.id));
        li.append(kick);
      } else if (p.id !== selfId && p.id === vc.hostId) {
        const note = document.createElement('span');
        note.className = 'ps-kick ps-kick-host';
        note.textContent = 'host · can’t kick';
        note.title = 'The host runs the match — kicking them would end it for everyone.';
        li.append(note);
      }
      list.appendChild(li);
    }
    if (!list.childElementCount) list.appendChild(this._li('No players.'));
  }

  // VOTE-KICK banner (2026-07-19, VRmike). Render the top-of-screen live bar from the host's tally.
  // `vote` is the snapshot's voteKick object (or null to hide). `selfId` decides eligibility: the Yes/No
  // buttons show for any electorate member (present at vote start), incl. the target (they get a vote per
  // spec) and the INITIATOR — and they stay LIVE after casting so a pick can be changed any time before
  // the vote resolves (the initiator starts on YES but may flip to NO and watch — VRmike 2026-07-20).
  // `myChoice` (true|false|null) highlights our current pick. A mid-vote joiner (not in `voters`) sees the
  // banner but no buttons — they just watch. Pure DOM; main.js drives it.
  setVoteKick(vote, selfId, myChoice) {
    const el = this.el.voteKick;
    if (!el) return;
    if (!vote) { el.classList.add('hidden'); el.setAttribute('aria-hidden', 'true'); return; }
    const secs = Math.max(0, Math.ceil(vote.timeLeft || 0));
    if (this.el.voteKickText) {
      this.el.voteKickText.textContent =
        `Kick ${vote.name || 'player'}?  VOTES: ${vote.yes} Yes, ${vote.no} No, ${vote.waiting} Waiting · Timer: ${secs}s`;
    }
    // Eligibility: a member of the electorate gets the Yes/No buttons (the target IS allowed to vote per
    // spec — they're in `voters`). We keep them shown even after casting so an elector can change their
    // mind; only a mid-vote joiner (not in `voters`) gets no buttons — they just watch the tally tick.
    const eligible = Array.isArray(vote.voters) && selfId != null && vote.voters.includes(selfId);
    const btns = this.el.voteKickBtns;
    if (btns) btns.classList.toggle('hidden', !eligible);
    // Highlight our current pick (null = not cast yet) so we can see our choice and that it's changeable.
    if (this.el.voteYes) this.el.voteYes.classList.toggle('chosen', myChoice === true);
    if (this.el.voteNo) this.el.voteNo.classList.toggle('chosen', myChoice === false);
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
  }

  _li(text) {
    const li = document.createElement('li');
    li.className = 'ps-empty';
    li.textContent = text;
    return li;
  }

  // MOUSE SENSITIVITY (B4): reflect the current multiplier into the slider + its "1.0×" label.
  // Called by main.js at boot with the value loaded from localStorage (clamped), so the pause menu
  // opens already showing the persisted setting. Pure DOM.
  setSensitivityValue(mult) {
    if (this.el.pauseSens) this.el.pauseSens.value = String(mult);
    this._renderSensVal(mult);
  }

  _renderSensVal(mult) {
    if (this.el.pauseSensVal) this.el.pauseSensVal.textContent = `${Number(mult).toFixed(2)}×`;
  }

  // LIGHTING QUALITY (2026-07-19): highlight the active tier button. Called by main.js at boot and
  // whenever the tier changes (manual pick OR the auto-tuner stepping it), so the pause menu always
  // reflects what's applied. Pure DOM.
  setLightingTier(tier) {
    if (!this.el.lightingTiers) return;
    const btns = this.el.lightingTiers.querySelectorAll('.lighting-tier');
    btns.forEach((b) => b.classList.toggle('on', parseInt(b.dataset.tier, 10) === Number(tier)));
  }

  // TONEMAP A/B + exposure: highlight the active mode + reflect the exposure slider/label.
  setTonemap(mode, exposure) {
    if (this.el.tonemapModes) {
      const btns = this.el.tonemapModes.querySelectorAll('.tonemap-mode');
      btns.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    }
    if (exposure != null) {
      if (this.el.exposureSlider) this.el.exposureSlider.value = String(exposure);
      this._renderExposureVal(exposure);
    }
  }

  _renderExposureVal(v) {
    if (this.el.exposureVal) this.el.exposureVal.textContent = `${Number(v).toFixed(2)}×`;
  }

  // PC CONTROLS REFERENCE (B4): populate the always-visible corner panel from the SAME rows the
  // pause "Controls" panel uses (_controlsHtml — one source of truth, so the list can't drift), and
  // reveal it. HIDDEN on mobile (phones already show their on-screen buttons) — leave it .hidden.
  // Idempotent: safe to call on every match start. Called by main.js once at boot.
  buildControlsRef() {
    const panel = this.el.controlsRef;
    if (!panel) return;
    if (prefersTouchControls()) { panel.classList.add('hidden'); return; }
    if (this.el.controlsRefBody) this.el.controlsRefBody.innerHTML = this._controlsHtml();
    panel.classList.remove('hidden'); // visible by default on PC
  }

  // ROLE-FILTERED CONTROLS LIST (B8): set which role's controls the reference shows, and re-render
  // the (visible) corner panel + the (open) pause "Controls" panel from the SAME _controlsHtml() rows.
  // `mode` is 'hunter' | 'prop' | 'spectator' | null. Idempotent — a no-op when the mode is unchanged,
  // so main.js can call it liberally (every snapshot/role event) without thrashing the DOM.
  setControlsRole(mode) {
    if (mode === this._controlsRole) return;
    this._controlsRole = mode;
    // Re-render the always-visible corner panel if it's shown (PC only; hidden on touch).
    if (this.el.controlsRef && this.el.controlsRefBody && !this.el.controlsRef.classList.contains('hidden')) {
      this.el.controlsRefBody.innerHTML = this._controlsHtml();
    }
    // Re-render the pause "Controls" panel if it's currently open.
    if (this.el.pauseHelpPanel && this.el.pauseHelpBody && !this.el.pauseHelpPanel.classList.contains('hidden')) {
      this.el.pauseHelpBody.innerHTML = this._controlsHtml();
    }
  }

  _toggleControlsRef() {
    const panel = this.el.controlsRef;
    if (!panel) return;
    const collapsed = panel.classList.toggle('collapsed');
    if (this.el.controlsRefToggle) {
      this.el.controlsRefToggle.innerHTML = collapsed ? '▸' : '▾'; // ▸ collapsed / ▾ expanded
      this.el.controlsRefToggle.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
    }
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
    // ROLE-FILTERED (B8): show ONLY the current role's controls (prop OR hunter), or the spectator
    // controls while dead. Before a role is known (lobby / pre-spawn) `mode` is null → the shared
    // move/look/menu rows only. main.js re-pushes the mode on every role change so this can't go stale.
    const mode = this._controlsRole;

    let common, hunter, prop, spectator;
    if (touch) {
      common = [
        ['Left joystick', 'Move'],
        ['Drag (right side)', 'Look'],
        ['JUMP', 'Jump'],
        ['☰', 'This menu'],
      ];
      hunter = [
        ['ACTION (hold)', 'Use the selected tool (fire · finder · grenade)'],
        ['Tool buttons', 'Switch tool — rifle · finder · grenade'],
      ];
      prop = [
        ['ACTION (hold)', 'Disguise as what you aim at'],
        ['ROTATE (hold)', 'Turn a disguise'],
      ];
      // Spectating (B6) — a dead player's fly cam + player switching (reuses the joystick + drag look).
      spectator = [
        ['Joystick + drag', 'Fly the free camera around the map'],
        ['JUMP', 'Fly up'],
        ['◀ / ▶', 'Switch between watching live players'],
        ['FLY', 'Back to the free-fly camera'],
        ['☰', 'This menu'],
      ];
    } else {
      common = [
        ['WASD / Arrows', 'Move'],
        ['Mouse', 'Look (click the view to capture the mouse)'],
        ['Space', 'Jump'],
        ['`', 'Free the mouse for debug/UI — click the view to resume'],
        ['Esc', 'Open / close this menu (releases the mouse; re-locks on close)'],
      ];
      hunter = [
        ['Left-click (hold)', 'Rapid-fire the rifle'],
        ['1 / 2 / 3', 'Pick hunter tool (rifle · finder · grenade)'],
        ['V', 'Toggle view'],
      ];
      prop = [
        ['Left-click (hold)', 'Disguise as what you aim at'],
        ['Right-click (hold)', 'Turn a disguise'],
        ['E', 'Disguise'],
        ['T', 'Taunt menu — frees the mouse; T or Esc closes it'],
        ['V', 'Toggle view'],
      ];
      // Spectating (B6) — a dead player's fly cam + player switching.
      spectator = [
        ['WASD + mouse', 'Fly the free camera around the map'],
        ['Space / Shift', 'Fly up / down'],
        ['Left-click', 'Cycle between watching live players (past the last → free-fly)'],
        ['Space', 'While following a player, snap back to free-fly'],
        ['Esc', 'Open / close this menu'],
      ];
    }

    const rows =
      mode === 'spectator' ? spectator :
      mode === 'hunter' ? [...common, ...hunter] :
      mode === 'prop' ? [...common, ...prop] :
      common; // no role yet (lobby / pre-spawn) → shared rows only
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

  // HUNTER GRENADES: a brief full-screen explosion flash for the local player when a grenade
  // goes off near them (intensity 0..1 by camera distance, from scene.blastFlashAt). Pure DOM —
  // a lazily-created overlay div that fades out on its own. Guaranteed non-throwing (a nearby
  // blast must never blank the render loop). Intensity <= 0 is a no-op.
  flashScreen(intensity = 1) {
    const k = Math.max(0, Math.min(1, intensity));
    if (k <= 0) return;
    let el = this.el.blastFlash;
    if (!el) {
      el = document.createElement('div');
      el.id = 'blastFlash';
      el.className = 'blast-flash';
      el.setAttribute('aria-hidden', 'true');
      (this.el.game || document.body).appendChild(el);
      this.el.blastFlash = el;
    }
    // Restart the fade: clear any running animation, force reflow, set peak opacity, then fade.
    if (this._blastTimer) { clearTimeout(this._blastTimer); this._blastTimer = null; }
    el.style.transition = 'none';
    el.style.opacity = String(0.65 * k);
    // Force a reflow so the transition below actually runs from the peak opacity.
    void el.offsetWidth;
    el.style.transition = 'opacity 0.4s ease-out';
    el.style.opacity = '0';
    this._blastTimer = setTimeout(() => { el.style.opacity = '0'; this._blastTimer = null; }, 450);
  }
}
