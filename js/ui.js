// DOM glue: screen switching, lobby list, HUD, and the kill/event feed.
// Holds no game logic — main.js drives it from server messages.
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
      banner: $('banner'),
      feed: $('feed'),
      clickToPlay: $('clickToPlay'),
      blindfold: $('blindfold'),
      blindfoldTimer: $('blindfoldTimer'),
    };
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
    this.el.playerList.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === selfId ? ' (you)' : '');
      if (p.id === hostId) name.classList.add('host');
      const status = document.createElement('span');
      status.textContent = p.ready ? 'ready' : '';
      status.classList.add('ready');
      const link = document.createElement('span');
      link.classList.add('link');
      this._paintLink(link, this.links.get(p.id));
      li.append(name, link, status);
      this.el.playerList.appendChild(li);
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

  // Position the aim reticle. `pt` is {x,y} in pixels (third-person: where the tag
  // cone points on screen) or null to recenter (first-person). The CSS keeps a
  // translate(-50%,-50%), so left/top land the reticle centered on the point.
  setCrosshair(pt) {
    const c = this.el.crosshair;
    if (!pt) {
      c.style.left = '50%';
      c.style.top = '50%';
      return;
    }
    c.style.left = `${pt.x}px`;
    c.style.top = `${pt.y}px`;
  }

  setRole(role) {
    this.el.hudRole.textContent = role === 'hunter' ? 'HUNTER' : 'PROP';
    this.el.hudRole.className = 'pill ' + role;
  }

  setHud({ phase, timeLeft, propsAlive, propsTotal }) {
    const t = Math.max(0, Math.ceil(timeLeft));
    this.el.hudTimer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.el.hudProps.textContent = `Props: ${propsAlive}/${propsTotal}`;
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
