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

export class Referee {
  // config: the content-as-data bundle the client already fetched
  //         ({ rules, maps, props }). code: the room code, for lobby messages.
  constructor(config, code) {
    this.rules = config.rules;
    this.maps = config.maps;
    this.propCatalog = config.props; // prop-type catalog, for aim/height checks
    this.mapId = Object.keys(this.maps)[0]; // DEFAULT_MAP_ID

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
    player.team = null; // lobby team pick ('hunter'|'prop'|null); replaces `ready`
    player.disguise = null;
    player.pos = { x: 0, y: 0, z: 0 };
    player.vy = 0; // vertical velocity (jump/gravity)
    player.yaw = 0;
    player.pitch = 0;
    player.input = { mx: 0, mz: 0, jump: false, crouch: false };

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

    // A disconnect is the ONE place a live match can end early besides a normal
    // round win: if leaving empties a whole team the round is unplayable, so we
    // bail to the lobby. Otherwise fall through to the usual win check.
    if (this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING) {
      if (!this.bailIfTeamEmpty()) this.checkRoundOver();
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
      case C2S.PICK_TEAM:
        // Picking a team IS readying up (the Ready button is gone). Only valid
        // in the lobby; anything else clears the pick.
        if (this.phase === PHASE.LOBBY) {
          player.team = msg.team === 'hunter' || msg.team === 'prop' ? msg.team : null;
          this.broadcastLobby();
        }
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
    // Clamp so a hostile peer can't send absurd movement multipliers. (The host
    // still judges every guest's input; guests are not trusted with outcomes.)
    player.input.mx = Math.max(-1, Math.min(1, Number(msg.mx) || 0));
    player.input.mz = Math.max(-1, Math.min(1, Number(msg.mz) || 0));
    if (Number.isFinite(msg.yaw)) player.yaw = msg.yaw;
    if (Number.isFinite(msg.pitch)) player.pitch = Math.max(-1.5, Math.min(1.5, msg.pitch));
    // Jump/crouch are held-state booleans, judged authoritatively in integrate().
    player.input.jump = !!msg.jump;
    player.input.crouch = !!msg.crouch;
  }

  // Disguise is now AIM-based: the client raycasts and sends the id of the prop
  // under its crosshair. The referee re-checks that request loosely — range +
  // facing only, NO occlusion geometry. This asymmetry is DELIBERATE: the client
  // is stricter (its first-hit ray means an occluding prop wins), so the referee
  // will accept anything the client would ever send. Its only job here is to stop
  // a tampered "I aimed at a prop across the map" claim, not to re-simulate the
  // scene. Do NOT port heavy 3D geometry in here — see memory/notes/disguise.md.
  applyDisguise(player, propId) {
    if (player.role !== ROLE.PROP || !player.alive) return;
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    const prop = this.props.find((p) => p.id === propId);
    if (!prop) return;
    const dx = prop.x - player.pos.x;
    const dz = prop.z - player.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > this.rules.disguiseRange) return;
    // Facing gate — skipped when standing basically on top of the prop (dist~0,
    // no meaningful direction). Uses the SAME crouch-aware eye height + pitch the
    // tag gate uses, so crouch/jump can't make the two sides disagree about aim.
    if (dist > 1e-3) {
      const fx = -Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      const cos = (dx / dist) * fx + (dz / dist) * fz;
      if (cos < Math.cos(this.rules.disguiseAngleDeg * DEG2RAD)) return; // not facing it
      // Vertical: the aim ray's height at the prop's distance must land within
      // the prop's body column (feet at y=0 up to its catalog height), padded.
      const eyeY = player.pos.y + this.eyeHeight(player);
      const rayY = eyeY + Math.tan(player.pitch) * dist;
      const pad = this.rules.disguiseVertPad;
      if (rayY < -pad || rayY > this.propHeight(prop) + pad) return;
    }
    player.disguise = prop.type;
    send(player, { t: S2C.EVENT, kind: 'disguised', type: prop.type });
  }

  // How tall a prop stands (feet on the ground at y=0), derived from its catalog
  // shape — mirrors makePropMesh's baseY math on the client. Used by the disguise
  // vertical aim gate only.
  propHeight(prop) {
    const c = this.propCatalog[prop.type];
    if (!c) return this.rules.standBodyHeight; // unknown shape: fall back sane
    return c.shape === 'sphere' ? c.r * 2 : c.h;
  }

  applyTag(hunter) {
    if (hunter.role !== ROLE.HUNTER || this.phase !== PHASE.HUNTING || !hunter.alive) return;

    const fx = -Math.sin(hunter.yaw);
    const fz = -Math.cos(hunter.yaw);
    const maxCos = Math.cos(this.rules.tagAngleDeg * DEG2RAD);
    // Where the hunter's eye is, and the vertical slope of their aim. This lets
    // the vertical gate below match exactly what the hunter sees — a crouched
    // (shorter) prop must be aimed at lower, a jumping prop is higher. The eye
    // height + slope mirror the client camera (main.js / scene.setCamera).
    const eyeY = hunter.pos.y + this.eyeHeight(hunter);
    const slope = Math.tan(hunter.pitch); // rise per unit horizontal distance
    const pad = this.rules.tagVertPad;

    let best = null;
    let bestDist = Infinity;
    for (const target of this.players.values()) {
      if (target.role !== ROLE.PROP || !target.alive) continue;
      const dx = target.pos.x - hunter.pos.x;
      const dz = target.pos.z - hunter.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > this.rules.tagRange || dist < 1e-3) continue;
      const cos = (dx / dist) * fx + (dz / dist) * fz;
      if (cos < maxCos) continue; // outside the horizontal aim cone
      // Vertical gate: the aim ray's height at the target's distance must fall
      // within the target's (crouch-shrunk / jump-raised) body column.
      const rayY = eyeY + slope * dist;
      const footY = target.pos.y;
      const topY = footY + this.bodyHeight(target);
      if (rayY < footY - pad || rayY > topY + pad) continue;
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
  // Host pressed Start from the lobby. Teams come from the players' own picks
  // (the referee owns the truth: everyone must have picked and both sides must
  // be non-empty). No more random-by-ratio assignment.
  startMatch() {
    if (this.phase !== PHASE.LOBBY) return;
    const host = this.players.get(this.hostId);
    const err = (msg) => host && send(host, { t: S2C.ERROR, msg });

    const present = [...this.players.values()];
    if (present.length < this.rules.minPlayers) {
      err(`Need at least ${this.rules.minPlayers} players to start.`);
      return;
    }
    if (present.some((p) => p.team !== 'hunter' && p.team !== 'prop')) {
      err('Everyone must pick a team first.');
      return;
    }
    const hunterIds = present.filter((p) => p.team === 'hunter').map((p) => p.id);
    const propIds = present.filter((p) => p.team === 'prop').map((p) => p.id);
    if (!hunterIds.length || !propIds.length) {
      err('Need at least one player on each team.');
      return;
    }
    this.beginRound(hunterIds, propIds);
  }

  // Start a round with explicit team rosters. Used for round one (picked teams)
  // and every subsequent round (swapped teams). Ids not present are skipped;
  // players in neither list spectate (role stays null).
  beginRound(hunterIds, propIds) {
    const map = this.maps[this.mapId];
    // Build authoritative prop instances from map data. Each placement carries a
    // STABLE id from the map file (maps.json) — the same id the client's scene
    // tags its meshes with, so a DISGUISE request ("prop #17") is unambiguous on
    // both sides. See memory/notes/disguise.md.
    this.props = (map.props || []).map((p) => ({
      id: p.id,
      type: p.type,
      x: p.x,
      z: p.z,
      rot: p.rot || 0,
    }));

    // Reset everyone to a clean spectator state first, then assign the rosters.
    for (const player of this.players.values()) {
      player.role = null;
      player.alive = true;
      player.disguise = null;
      player.vy = 0;
      player.input = { mx: 0, mz: 0, jump: false, crouch: false };
      player.pos = { x: 0, y: 0, z: 0 };
    }
    for (const id of hunterIds) {
      const player = this.players.get(id);
      if (!player) continue;
      player.role = ROLE.HUNTER;
      player.pos = { x: map.hunterSpawn.x, y: 0, z: map.hunterSpawn.z };
    }
    let spawnIdx = 0;
    for (const id of propIds) {
      const player = this.players.get(id);
      if (!player) continue;
      player.role = ROLE.PROP;
      const s = map.spawns[spawnIdx++ % map.spawns.length];
      player.pos = { x: s.x, y: 0, z: s.z };
    }
    for (const player of this.players.values()) {
      if (player.role) send(player, { t: S2C.ROLE, role: player.role });
    }

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

  // Called when the ENDING scoreboard elapses. Instead of dumping everyone to the
  // lobby, roll straight into the next round with the teams SWAPPED. Only fall
  // back to the lobby if a swap would leave a side empty (everyone left one team).
  nextRoundOrLobby() {
    const { hunters, props } = this.computeSwappedTeams();
    if (!hunters.length || !props.length) {
      this.resetToLobby('Not enough players to keep going — back to the lobby.');
      return;
    }
    this.beginRound(hunters, props);
  }

  // Swap last round's roles: hunters -> props, props -> hunters. Spectators (new
  // mid-match joiners, role null) fold into the smaller side so they play next.
  computeSwappedTeams() {
    const hunters = [];
    const props = [];
    for (const p of this.players.values()) {
      if (p.role === ROLE.HUNTER) props.push(p.id);
      else if (p.role === ROLE.PROP) hunters.push(p.id);
      else if (hunters.length <= props.length) hunters.push(p.id);
      else props.push(p.id);
    }
    return { hunters, props };
  }

  // Mid-round safety net: if a disconnect emptied a whole team, the round can't
  // be finished, so bail to the lobby. Returns true if it did.
  bailIfTeamEmpty() {
    const present = [...this.players.values()];
    const hunters = present.filter((p) => p.role === ROLE.HUNTER).length;
    const props = present.filter((p) => p.role === ROLE.PROP).length;
    if (hunters === 0 || props === 0) {
      this.resetToLobby('A team emptied out — back to the lobby.');
      return true;
    }
    return false;
  }

  resetToLobby(reason) {
    this.phase = PHASE.LOBBY;
    this.props = [];
    for (const p of this.players.values()) {
      p.role = null;
      p.alive = true;
      p.disguise = null;
      p.team = null;
      p.vy = 0;
      p.input = { mx: 0, mz: 0, jump: false, crouch: false };
    }
    if (reason) this.broadcast({ t: S2C.EVENT, kind: 'toLobby', reason });
    this.broadcastLobby();
  }

  // Eye height / body-column height for a player, crouch-aware. Shared by the
  // tag hitbox (above) and kept identical to the client camera + avatar scale.
  eyeHeight(p) {
    return p.input.crouch ? this.rules.crouchEyeHeight : this.rules.standEyeHeight;
  }
  bodyHeight(p) {
    return p.input.crouch ? this.rules.crouchBodyHeight : this.rules.standBodyHeight;
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
        this.nextRoundOrLobby(); // stay in-game: next round, teams swapped
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
    const { moveSpeed, crouchSpeedMult, gravity, jumpSpeed } = this.rules;
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
      // Crouching slows you down. Same multiplier the client predicts with.
      const speed = moveSpeed * (p.input.crouch ? crouchSpeedMult : 1);
      p.pos.x = clamp(p.pos.x + vx * speed * dt, -bound, bound);
      p.pos.z = clamp(p.pos.z + vz * speed * dt, -bound, bound);

      // Vertical: jump off the ground, then gravity. MUST match main.js exactly
      // or players rubber-band mid-air (see memory/notes/netcode.md).
      const grounded = p.pos.y <= 0;
      if (grounded && p.input.jump) p.vy = jumpSpeed;
      p.vy -= gravity * dt;
      p.pos.y += p.vy * dt;
      if (p.pos.y < 0) {
        p.pos.y = 0;
        p.vy = 0;
      }
    }
  }

  // ---- outbound -----------------------------------------------------------
  broadcast(obj) {
    for (const p of this.players.values()) send(p, obj);
  }

  broadcastLobby() {
    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team }));
    // The referee owns the truth about whether a start is legal; the lobby screen
    // only displays it. Everyone picked + at least one on each side.
    const canStart =
      players.length >= this.rules.minPlayers &&
      players.every((p) => p.team === 'hunter' || p.team === 'prop') &&
      players.some((p) => p.team === 'hunter') &&
      players.some((p) => p.team === 'prop');
    this.broadcast({ t: S2C.LOBBY, room: this.code, hostId: this.hostId, players, phase: this.phase, canStart });
  }

  broadcastSnapshot() {
    const timeLeft = Math.max(0, (this.phaseEndsAt - Date.now()) / 1000);
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: round2(p.pos.x),
      y: round2(p.pos.y),
      z: round2(p.pos.z),
      yaw: round3(p.yaw),
      alive: p.alive,
      crouch: !!p.input.crouch,
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
    const base = {
      t: S2C.SNAPSHOT,
      phase: this.phase,
      timeLeft: round2(timeLeft),
      propsAlive,
      propsTotal,
    };
    // BLINDFOLD (data half): during HIDING, hunters get NO information about
    // anyone else — their player list contains only themselves. Even a hunter
    // poking at dev tools sees nothing to cheat with. Everyone else gets the full
    // list. The screen blackout (client) is the visible half of the same rule.
    for (const p of this.players.values()) {
      const visible = this.phase === PHASE.HIDING && p.role === ROLE.HUNTER ? players.filter((e) => e.id === p.id) : players;
      send(p, { ...base, players: visible });
    }
  }
}

// ---- helpers --------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
