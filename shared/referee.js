// Referee = one lobby + one match, and the authoritative judge for it.
//
// This is a PORT of the old server-side Room. The rules are identical; what
// changed is everything that used to be server-only plumbing:
//   - config is INJECTED (constructor arg) instead of read from disk, so this
//     runs in a browser where there is no filesystem;
//   - each player carries a `send(obj)` CALLBACK instead of a raw socket, so the
//     referee doesn't know or care whether a message goes out over an
//     RTCDataChannel (guests) or a local loopback (the host's own client);
//   - the tick uses setInterval, which exists in both the browser and Node.
//
// Since the P2P rebuild the referee runs INSIDE the host's browser tab. It still
// speaks the same C2S/S2C protocol it always did — the transport underneath is
// the only thing that moved. Authority now lives on the host, not a server; see
// memory/architecture.md for why that trade was made.
import { C2S, S2C, PHASE, ROLE } from './protocol.js';

const DEG2RAD = Math.PI / 180;

function send(player, obj) {
  try {
    player.send(obj);
  } catch {
    /* peer went away mid-send; cleanup happens on channel close */
  }
}

let nextPropId = 1;

export class Referee {
  // config: the content-as-data bundle the client already fetched
  //         ({ rules, maps, props }). code: the room code, for lobby messages.
  constructor(config, code) {
    this.rules = config.rules;
    this.maps = config.maps;
    // DEFAULT_MAP_ID: the first map in maps.json until the host picks another via
    // setMapId(). This is the ONLY place the map choice lives; startMatch/integrate
    // read it without re-validating (see setMapId for why the id is trusted).
    this.mapId = Object.keys(this.maps)[0];

    this.code = code;
    this.players = new Map(); // id -> player
    this.hostId = null;

    this.phase = PHASE.LOBBY;
    this.props = []; // authoritative prop instances for the active map
    this.phaseEndsAt = 0;

    this.lastTick = Date.now();
    this.lastSnapshot = 0;
    this.interval = setInterval(() => this.tick(), 1000 / this.rules.tickRate);
  }

  // ---- membership ---------------------------------------------------------
  // player: { id, name, send }. `send` is how the referee talks back to this
  // player — a DataChannel write for guests, a direct call for the host.
  addPlayer(player) {
    player.role = null;
    player.alive = true;
    player.ready = false;
    player.disguise = null;
    player.pos = { x: 0, y: 0, z: 0 };
    player.yaw = 0;
    player.pitch = 0;
    player.input = { mx: 0, mz: 0 };

    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id; // host adds itself first

    send(player, { t: S2C.JOINED, id: player.id, room: this.code, host: this.hostId === player.id });
    this.broadcastLobby();
  }

  removePlayer(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);

    // The host is the referee: if it leaves, the whole match is torn down by the
    // network layer and this instance is destroyed, so this reassignment only
    // ever matters when a *guest* leaves (hostId is unchanged then).
    if (this.hostId === id) {
      this.hostId = this.players.keys().next().value || null;
    }

    if (this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING) {
      this.checkRoundOver();
    }
    this.broadcastLobby();
  }

  destroy() {
    clearInterval(this.interval);
  }

  // ---- messaging ----------------------------------------------------------
  handleMessage(id, msg) {
    const player = this.players.get(id);
    if (!player) return;
    switch (msg.t) {
      case C2S.READY:
        player.ready = !!msg.ready;
        this.broadcastLobby();
        break;
      case C2S.START:
        if (player.id === this.hostId) this.startMatch();
        break;
      case C2S.PICK_MAP:
        this.setMapId(msg.mapId, player.id);
        break;
      case C2S.INPUT:
        this.applyInput(player, msg);
        break;
      case C2S.DISGUISE:
        this.applyDisguise(player, msg.propId);
        break;
      case C2S.TAG:
        this.applyTag(player);
        break;
      default:
        break;
    }
  }

  applyInput(player, msg) {
    // Clamp so a hostile peer can't send absurd movement multipliers. (The host
    // still judges every guest's input; guests are not trusted with outcomes.)
    player.input.mx = Math.max(-1, Math.min(1, Number(msg.mx) || 0));
    player.input.mz = Math.max(-1, Math.min(1, Number(msg.mz) || 0));
    if (Number.isFinite(msg.yaw)) player.yaw = msg.yaw;
    if (Number.isFinite(msg.pitch)) player.pitch = Math.max(-1.5, Math.min(1.5, msg.pitch));
  }

  applyDisguise(player, propId) {
    if (player.role !== ROLE.PROP || !player.alive) return;
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    const prop = this.props.find((p) => p.id === propId);
    if (!prop) return;
    const dx = prop.x - player.pos.x;
    const dz = prop.z - player.pos.z;
    if (Math.hypot(dx, dz) > this.rules.disguiseRange) return;
    player.disguise = prop.type;
    send(player, { t: S2C.EVENT, kind: 'disguised', type: prop.type });
  }

  applyTag(hunter) {
    if (hunter.role !== ROLE.HUNTER || this.phase !== PHASE.HUNTING || !hunter.alive) return;

    const fx = -Math.sin(hunter.yaw);
    const fz = -Math.cos(hunter.yaw);
    const maxCos = Math.cos(this.rules.tagAngleDeg * DEG2RAD);

    let best = null;
    let bestDist = Infinity;
    for (const target of this.players.values()) {
      if (target.role !== ROLE.PROP || !target.alive) continue;
      const dx = target.pos.x - hunter.pos.x;
      const dz = target.pos.z - hunter.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > this.rules.tagRange || dist < 1e-3) continue;
      const cos = (dx / dist) * fx + (dz / dist) * fz;
      if (cos < maxCos) continue; // outside the aim cone
      if (dist < bestDist) {
        bestDist = dist;
        best = target;
      }
    }

    if (best) {
      best.alive = false;
      this.broadcast({ t: S2C.EVENT, kind: 'eliminated', by: hunter.id, victim: best.id, name: best.name });
      this.checkRoundOver();
    } else {
      send(hunter, { t: S2C.EVENT, kind: 'miss' });
    }
  }

  // ---- lobby settings -----------------------------------------------------
  // The ONE gate for the lobby map choice. All guard rails live here so nothing
  // downstream re-checks: only the host may pick, only during LOBBY, and only a
  // map id that actually exists in the maps file. A tampered client can send
  // C2S.PICK_MAP with anything — if it fails a rail, nothing changes. Once stored,
  // this.mapId is trusted by startMatch/integrate (single source of truth, so the
  // two can't drift). Rebroadcasts the lobby so every screen agrees on the pick.
  setMapId(id, byId) {
    if (byId !== this.hostId) return; // host-authority: guests can't change the map
    if (this.phase !== PHASE.LOBBY) return; // only choosable before the match starts
    if (!this.maps[id]) return; // must be a real map in maps.json
    if (id === this.mapId) return; // no-op: avoid a redundant lobby rebroadcast
    this.mapId = id;
    this.broadcastLobby();
  }

  // ---- match lifecycle ----------------------------------------------------
  startMatch() {
    if (this.phase !== PHASE.LOBBY) return;
    const ids = [...this.players.keys()];
    if (ids.length < this.rules.minPlayers) {
      const host = this.players.get(this.hostId);
      if (host) send(host, { t: S2C.ERROR, msg: `Need at least ${this.rules.minPlayers} players to start.` });
      return;
    }

    const map = this.maps[this.mapId];
    // Build authoritative prop instances from map data.
    this.props = (map.props || []).map((p) => ({
      id: nextPropId++,
      type: p.type,
      x: p.x,
      z: p.z,
      rot: p.rot || 0,
    }));

    // Randomly split into Hunters and Props (the host referee decides).
    shuffle(ids);
    const hunterCount = Math.max(1, Math.round(ids.length * this.rules.hunterRatio));
    let spawnIdx = 0;
    ids.forEach((id, i) => {
      const player = this.players.get(id);
      player.alive = true;
      player.disguise = null;
      player.input = { mx: 0, mz: 0 };
      if (i < hunterCount) {
        player.role = ROLE.HUNTER;
        player.pos = { x: map.hunterSpawn.x, y: 0, z: map.hunterSpawn.z };
      } else {
        player.role = ROLE.PROP;
        const s = map.spawns[spawnIdx++ % map.spawns.length];
        player.pos = { x: s.x, y: 0, z: s.z };
      }
      send(player, { t: S2C.ROLE, role: player.role });
    });

    this.broadcast({ t: S2C.STARTED, mapId: this.mapId, props: this.props });
    this.setPhase(PHASE.HIDING, this.rules.hidingSeconds);
  }

  setPhase(phase, seconds) {
    this.phase = phase;
    this.phaseEndsAt = Date.now() + seconds * 1000;
    this.broadcast({ t: S2C.EVENT, kind: 'phase', phase, seconds });
  }

  checkRoundOver() {
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    const props = [...this.players.values()].filter((p) => p.role === ROLE.PROP);
    const aliveProps = props.filter((p) => p.alive);
    if (props.length > 0 && aliveProps.length === 0) {
      this.endRound(ROLE.HUNTER);
    }
  }

  endRound(winner) {
    this.broadcast({ t: S2C.EVENT, kind: 'roundOver', winner });
    this.setPhase(PHASE.ENDING, this.rules.endingSeconds);
  }

  resetToLobby() {
    this.phase = PHASE.LOBBY;
    this.props = [];
    // DELIBERATE CARVE-OUT: this.mapId is NOT reset here. A reset-to-lobby clears
    // per-player round state (roles/alive/disguise/ready), but the chosen map is a
    // lobby *setting*, not per-player state — so the last-picked map stays selected
    // for the next round. Documented exception to "fresh lobby", not a silent
    // branch (see memory/notes/map-selection.md).
    for (const p of this.players.values()) {
      p.role = null;
      p.alive = true;
      p.disguise = null;
      p.ready = false;
      p.input = { mx: 0, mz: 0 };
    }
    this.broadcastLobby();
  }

  // ---- simulation ---------------------------------------------------------
  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    if (this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING) {
      this.integrate(dt);
    }

    // Timer-driven phase transitions.
    if (this.phase !== PHASE.LOBBY && now >= this.phaseEndsAt) {
      if (this.phase === PHASE.HIDING) {
        this.setPhase(PHASE.HUNTING, this.rules.huntingSeconds);
      } else if (this.phase === PHASE.HUNTING) {
        this.endRound(ROLE.PROP); // time ran out, surviving props win
      } else if (this.phase === PHASE.ENDING) {
        this.resetToLobby();
      }
    }

    // Broadcast authoritative snapshots at snapshotRate during a match.
    if (this.phase !== PHASE.LOBBY && now - this.lastSnapshot >= 1000 / this.rules.snapshotRate) {
      this.lastSnapshot = now;
      this.broadcastSnapshot();
    }
  }

  integrate(dt) {
    const map = this.maps[this.mapId];
    const bound = map.size / 2 - this.rules.mapMargin;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // Hunters are frozen during the hiding period.
      if (p.role === ROLE.HUNTER && this.phase === PHASE.HIDING) continue;

      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // forward = (-sin, -cos), right = (cos, -sin); matches the client.
      let vx = -sin * p.input.mz + cos * p.input.mx;
      let vz = -cos * p.input.mz - sin * p.input.mx;
      const len = Math.hypot(vx, vz);
      if (len > 1) {
        vx /= len;
        vz /= len;
      }
      p.pos.x = clamp(p.pos.x + vx * this.rules.moveSpeed * dt, -bound, bound);
      p.pos.z = clamp(p.pos.z + vz * this.rules.moveSpeed * dt, -bound, bound);
    }
  }

  // ---- outbound -----------------------------------------------------------
  broadcast(obj) {
    for (const p of this.players.values()) send(p, obj);
  }

  broadcastLobby() {
    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready }));
    // mapId rides along so every lobby screen (including a late joiner) shows the
    // host's current pick; the picker UI highlights it and renders from maps.json.
    this.broadcast({ t: S2C.LOBBY, room: this.code, hostId: this.hostId, players, phase: this.phase, mapId: this.mapId });
  }

  broadcastSnapshot() {
    const timeLeft = Math.max(0, (this.phaseEndsAt - Date.now()) / 1000);
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: round2(p.pos.x),
      z: round2(p.pos.z),
      yaw: round3(p.yaw),
      alive: p.alive,
      // Roles are hidden: we expose that hunters are hunters (they are the
      // visible seekers) and props only via their chosen disguise. We never
      // leak which players are undisguised props.
      //
      // CAVEAT (P2P): the host runs this referee, so the *host's* browser holds
      // the full unfiltered state in memory — a determined host could inspect it.
      // Guests still receive only this filtered view. This is one of the
      // anti-cheat guarantees given up by moving authority off a neutral server;
      // see memory/architecture.md.
      hunter: p.role === ROLE.HUNTER,
      disguise: p.disguise,
    }));
    const propsTotal = [...this.players.values()].filter((p) => p.role === ROLE.PROP).length;
    const propsAlive = [...this.players.values()].filter((p) => p.role === ROLE.PROP && p.alive).length;
    this.broadcast({
      t: S2C.SNAPSHOT,
      phase: this.phase,
      timeLeft: round2(timeLeft),
      propsAlive,
      propsTotal,
      players,
    });
  }
}

// ---- helpers --------------------------------------------------------------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
