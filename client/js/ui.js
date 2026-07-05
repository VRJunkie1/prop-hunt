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
      lobbyHint: $('lobbyHint'),
      hud: $('hud'),
      crosshair: $('crosshair'),
      hudRole: $('hudRole'),
      hudTimer: $('hudTimer'),
      hudProps: $('hudProps'),
      banner: $('banner'),
      feed: $('feed'),
      clickToPlay: $('clickToPlay'),
    };
  }

  show(screen) {
    for (const s of ['menu', 'lobby', 'game']) this.el[s].classList.toggle('hidden', s !== screen);
    const inGame = screen === 'game';
    this.el.hud.classList.toggle('hidden', !inGame);
    this.el.crosshair.classList.toggle('hidden', !inGame);
  }

  menuError(msg) {
    this.el.menuError.textContent = msg || '';
  }

  renderLobby({ room, hostId, players }, selfId) {
    this.el.lobbyCode.textContent = room;
    this.el.playerList.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === selfId ? ' (you)' : '');
      if (p.id === hostId) name.classList.add('host');
      const status = document.createElement('span');
      status.textContent = p.ready ? 'ready' : '';
      status.classList.add('ready');
      li.append(name, status);
      this.el.playerList.appendChild(li);
    }
    const isHost = hostId === selfId;
    this.el.startBtn.classList.toggle('hidden', !isHost);
    this.el.lobbyHint.textContent = isHost
      ? `You are host. Start when everyone has joined (min ${players.length >= 2 ? '' : '2 '}players).`
      : 'Waiting for the host to start…';
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

  setClickToPlay(visible) {
    this.el.clickToPlay.classList.toggle('hidden', !visible);
  }
}
