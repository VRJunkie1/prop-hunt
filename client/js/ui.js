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
      teamHunters: $('teamHunters'),
      teamProps: $('teamProps'),
      hunterList: $('hunterList'),
      propList: $('propList'),
      unassignedList: $('unassignedList'),
      mapList: $('mapList'),
      mapHint: $('mapHint'),
      startBtn: $('startBtn'),
      lobbyHint: $('lobbyHint'),
      hud: $('hud'),
      crosshair: $('crosshair'),
      targetHint: $('targetHint'),
      hudRole: $('hudRole'),
      hudTimer: $('hudTimer'),
      hudProps: $('hudProps'),
      banner: $('banner'),
      feed: $('feed'),
      clickToPlay: $('clickToPlay'),
      blindfold: $('blindfold'),
      blindfoldTimer: $('blindfoldTimer'),
      touch: $('touch'),
    };
    this.myTeam = null; // the team the local player has picked (or null)
    this.maps = null; // the map catalog (maps.json), set once at boot via setMaps
    this.touchEnabled = false; // true on touch devices — shows on-screen controls
  }

  // Called once at boot (touch.js) when we're on a touch device: the on-screen
  // controls then appear whenever the game screen is up.
  enableTouch() {
    this.touchEnabled = true;
    if (!this.el.game.classList.contains('hidden')) this.el.touch.classList.remove('hidden');
  }

  // The lobby map list is rendered straight from the map file (which every
  // client already downloaded); the referee only tells us WHICH id is selected.
  setMaps(maps) {
    this.maps = maps;
  }

  show(screen) {
    for (const s of ['menu', 'lobby', 'game']) this.el[s].classList.toggle('hidden', s !== screen);
    const inGame = screen === 'game';
    this.el.hud.classList.toggle('hidden', !inGame);
    this.el.crosshair.classList.toggle('hidden', !inGame);
    this.el.touch.classList.toggle('hidden', !(inGame && this.touchEnabled));
  }

  menuError(msg) {
    this.el.menuError.textContent = msg || '';
  }

  renderLobby({ room, hostId, players, canStart, mapId }, selfId) {
    this.el.lobbyCode.textContent = room;
    const isHost = hostId === selfId;
    this.renderMaps(mapId, isHost);

    // Remember our own pick so the click handler can toggle it off, and so we
    // can highlight the column we're on.
    const me = players.find((p) => p.id === selfId);
    this.myTeam = me ? me.team || null : null;

    const fill = (listEl, team) => {
      listEl.innerHTML = '';
      for (const p of players.filter((pl) => pl.team === team)) {
        const li = document.createElement('li');
        li.textContent = p.name + (p.id === selfId ? ' (you)' : '');
        if (p.id === hostId) li.classList.add('host');
        listEl.appendChild(li);
      }
    };
    fill(this.el.hunterList, 'hunter');
    fill(this.el.propList, 'prop');

    // Everyone who hasn't picked yet.
    const undecided = players.filter((p) => p.team !== 'hunter' && p.team !== 'prop');
    this.el.unassignedList.textContent = undecided.length
      ? undecided.map((p) => p.name + (p.id === selfId ? ' (you)' : '')).join(', ')
      : 'everyone has picked!';

    // Highlight the column the local player is on.
    this.el.teamHunters.classList.toggle('picked', this.myTeam === 'hunter');
    this.el.teamProps.classList.toggle('picked', this.myTeam === 'prop');

    this.el.startBtn.classList.toggle('hidden', !isHost);
    this.el.startBtn.disabled = !canStart;
    this.el.lobbyHint.textContent = isHost
      ? canStart
        ? 'Everyone picked — start when ready.'
        : 'Pick a side. Start unlocks when everyone has picked and both teams have a player.'
      : this.myTeam
        ? `You're on the ${this.myTeam === 'hunter' ? 'Hunters' : 'Props'}. Waiting for the host to start…`
        : 'Click a team to join. Left = Hunters, right = Props.';
  }

  // Render the map list for everyone. The selected map is marked for all players;
  // only the host's rows are interactive (click -> C2S.PICK_MAP, wired in
  // main.js). Guests see the same list but read-only ('locked'). A faked click
  // from a guest is caught by the referee anyway (host + lobby + valid-id gates).
  renderMaps(selectedMapId, isHost) {
    const listEl = this.el.mapList;
    listEl.innerHTML = '';
    for (const [id, m] of Object.entries(this.maps || {})) {
      const li = document.createElement('li');
      li.dataset.mapId = id;
      li.className = 'map-row' + (id === selectedMapId ? ' selected' : '') + (isHost ? '' : ' locked');

      const name = document.createElement('span');
      name.className = 'map-name';
      name.textContent = m.name || id;
      const size = document.createElement('span');
      size.className = 'map-size';
      size.textContent = `${m.size}×${m.size}`;
      li.append(name, size);
      listEl.appendChild(li);
    }
    this.el.mapHint.textContent = isHost
      ? 'Pick the map to play. Everyone sees your choice.'
      : 'The host chooses the map.';
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

  // Crosshair target hint (e.g. "Click to disguise as Crate"). Pure display —
  // main.js decides what, if anything, is a valid target. Empty string hides it.
  setTargetHint(text) {
    const el = this.el.targetHint;
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  setClickToPlay(visible) {
    this.el.clickToPlay.classList.toggle('hidden', !visible);
  }

  // Hunter blackout during the hiding phase — the visible half of the blindfold
  // (the referee also starves them of data). Pure show/hide + countdown text.
  setBlindfold(visible, seconds) {
    this.el.blindfold.classList.toggle('hidden', !visible);
    if (visible) this.el.blindfoldTimer.textContent = `Eyes open in ${seconds}s`;
  }
}
