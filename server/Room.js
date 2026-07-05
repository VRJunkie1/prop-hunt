// Room = one lobby + one match, and the authoritative referee for it.
//
// The server owns the true game state. Clients only send intent (movement,
// disguise, tag) and render whatever snapshots the server broadcasts. This is
// what makes the "no port forwarding" and (later) anti-cheat design work:
// nobody hosts on their own machine and no client is trusted with outcomes.
import { C2S, S2C, PHASE, ROLE } from '../shared/protocol.js';
import { rules, maps, propCatalog, DEFAULT_MAP_ID } from './config.js';

const DEG2RAD = Math.PI / 180;

function send(player, obj) {
  try {
    if (player.socket.readyState === 1 /* OPEN */) {
      player.socket.send(JSON.stringify(obj));
    }
  } catch {
    /* socket went away mid-send; cleanup handled on close */
  }
}

let nextPropId = 1;

export class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty; // callback so the manager can drop empty rooms
    this.players = new Map(); // id -> player
    this.hostId = null;

    this.mapId = DEFAULT_MAP_ID;
    this.phase = PHASE.LOBBY;
    this.props = []; // authoritative prop instances for the active map
    this.phaseEndsAt = 0;

    this.lastTick = Date.now();
    this.lastSnapshot = 0;
    this.interval = setInterval(() => this.tick(), 1000 / rules.tickRate);
  }

  // ---- membership ---------------------------------------------------------
  addPlayer(player) {
    player.room = this;
    player.role = null;
    player.alive = true;
    player.ready = false;
    player.disguise = null;
    player.pos = { x: 0, y: 0, z: 0 };
    player.yaw = 0;
    player.pitch = 0;
    player.input = { mx: 0, mz: 0 };

    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;

    send(player, { t: S2C.JOINED, id: player.id, room: this.code, host: this.hostId === player.id });
    this.broadcastLobby();
  }

  removePlayer(player) {
    if (!this.players.has(player.id)) return;
    this.players.delete(player.id);

    if (this.hostId === player.id) {
      this.hostId = this.players.keys().next().value || null;
    }

    if (this.players.size === 0) {
      this.destroy();
      return;
    }

    // If a match is running and everyone left is a hunter or no props remain,
    // resolve the round instead of leaving it stuck.
    if (this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING) {
      this.checkRoundOver();
    }
    this.broadcastLobby();
  }

  destroy() {
    clearInterval(this.interval);
    this.onEmpty?.(this.code);
  }

  // ---- messaging ----------------------------------------------------------
  handleMessage(player, msg) {
    switch (msg.t) {
      case C2S.READY:
        player.ready = !!msg.ready;
        this.broadcastLobby();
        break;
      case C2S.START:
        if (player.id === this.hostId) this.startMatch();
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
    // Clamp so a hostile client can't send absurd movement multipliers.
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
    if (Math.hypot(dx, dz) > rules.disguiseRange) return;
    player.disguise = prop.type;
    send(player, { t: S2C.EVENT, kind: 'disguised', type: prop.type });
  }

  applyTag(hunter) {
    if (hunter.role !== ROLE.HUNTER || this.phase !== PHASE.HUNTING || !hunter.alive) return;

    const fx = -Math.sin(hunter.yaw);
    const fz = -Math.cos(hunter.yaw);
    const maxCos = Math.cos(rules.tagAngleDeg * DEG2RAD);

    let best = null;
    let bestDist = Infinity;
    for (const target of this.players.values()) {
      if (target.role !== ROLE.PROP || !target.alive) continue;
      const dx = target.pos.x - hunter.pos.x;
      const dz = target.pos.z - hunter.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > rules.tagRange || dist < 1e-3) continue;
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

  // ---- match lifecycle ----------------------------------------------------
  startMatch() {
    if (this.phase !== PHASE.LOBBY) return;
    const ids = [...this.players.keys()];
    if (ids.length < rules.minPlayers) {
      const host = this.players.get(this.hostId);
      if (host) send(host, { t: S2C.ERROR, msg: `Need at least ${rules.minPlayers} players to start.` });
      return;
    }

    const map = maps[this.mapId];
    // Build authoritative prop instances from map data.
    this.props = (map.props || []).map((p) => ({
      id: nextPropId++,
      type: p.type,
      x: p.x,
      z: p.z,
      rot: p.rot || 0,
    }));

    // Randomly split into Hunters and Props (server decides).
    shuffle(ids);
    const hunterCount = Math.max(1, Math.round(ids.length * rules.hunterRatio));
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
    this.setPhase(PHASE.HIDING, rules.hidingSeconds);
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
    this.setPhase(PHASE.ENDING, rules.endingSeconds);
  }

  resetToLobby() {
    this.phase = PHASE.LOBBY;
    this.props = [];
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
        this.setPhase(PHASE.HUNTING, rules.huntingSeconds);
      } else if (this.phase === PHASE.HUNTING) {
        this.endRound(ROLE.PROP); // time ran out, surviving props win
      } else if (this.phase === PHASE.ENDING) {
        this.resetToLobby();
      }
    }

    // Broadcast authoritative snapshots at snapshotRate during a match.
    if (this.phase !== PHASE.LOBBY && now - this.lastSnapshot >= 1000 / rules.snapshotRate) {
      this.lastSnapshot = now;
      this.broadcastSnapshot();
    }
  }

  integrate(dt) {
    const map = maps[this.mapId];
    const bound = map.size / 2 - rules.mapMargin;
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
      p.pos.x = clamp(p.pos.x + vx * rules.moveSpeed * dt, -bound, bound);
      p.pos.z = clamp(p.pos.z + vz * rules.moveSpeed * dt, -bound, bound);
    }
  }

  // ---- outbound -----------------------------------------------------------
  broadcast(obj) {
    for (const p of this.players.values()) send(p, obj);
  }

  broadcastLobby() {
    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready }));
    this.broadcast({ t: S2C.LOBBY, room: this.code, hostId: this.hostId, players, phase: this.phase });
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
