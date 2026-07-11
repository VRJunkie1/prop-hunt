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
import { loadRapier, PhysicsWorld, isStaticEntry } from './physics.js';

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
    // Physics FEEL knobs (restitution / solver iterations / prop damping). The SAME
    // object every client loaded, so the host's authoritative world and each guest's
    // prediction world derive identical feel (see js/main.js buildPredict). null-safe:
    // physics.js applies defaults if absent.
    this.feel = config.feel;
    // Shape catalogs (props = disguise pool, fixtures = static scenery). The referee
    // never uses these to build the disguise pool (that's map.props only) — it needs
    // them purely to hand the physics world collider dimensions for each type. Kept
    // as separate merged lookups so a fixture still can't leak into the disguise pool.
    this.propCatalog = config.props || {};
    this.fixtureCatalog = config.fixtures || {};
    // DEFAULT_MAP_ID: the first map in maps.json until the host picks another via
    // setMapId(). This is the ONLY place the map choice lives; startMatch/integrate
    // read it without re-validating (see setMapId for why the id is trusted).
    this.mapId = Object.keys(this.maps)[0];

    this.code = code;
    this.players = new Map(); // id -> player
    this.hostId = null;

    this.phase = PHASE.LOBBY;
    this.props = []; // authoritative prop instances for the active map
    // ---- physics (Rapier) ----------------------------------------------------
    // The authoritative simulation. Built LAZILY at match start (loadRapier pulls
    // the WASM from a CDN on demand — never at boot, so the headless load check
    // stays clean). Until it resolves, integrate() falls back to the old flat 2D
    // movement so a match is never stalled by a slow/failed physics load. If Rapier
    // can't load at all, the whole match just runs on the 2D fallback (no wall
    // collision / props, but fully playable) — an honest graceful degrade.
    this.physics = null;
    this._physicsToken = 0; // bumped per match so a stale async build is discarded
    this.awakePropTransforms = []; // set each tick from physics; broadcast to clients
    this.phaseEndsAt = 0;
    // Result of the most recent round, carried into the persistent lobby so a
    // group running back-to-back rounds sees who won without a page reload.
    // Rides S2C.LOBBY; cleared when the next match starts. null before round 1.
    this.lastResult = null;

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
    player.yaw = 0; // look yaw (drives movement + the tag/aim cone)
    player.pitch = 0;
    player.dispYaw = 0; // display yaw for a disguised prop (orientation lock)
    player.rotUnlock = false; // right-click held: a disguise may rotate on yaw
    player.lastInputSeq = 0; // echoed as `ack` for client reconciliation
    player.input = { mx: 0, mz: 0, jump: false };

    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id; // host adds itself first

    send(player, { t: S2C.JOINED, id: player.id, room: this.code, host: this.hostId === player.id });

    // ONE gate, two doors. This add-player point is the referee's single entry for
    // everyone (host loopback + every guest DataConnection), so it's also the only
    // place that has to decide lobby-join vs mid-round-join. Because the host is
    // single-threaded, the id/name/role assignment below is atomic per newcomer —
    // two guests whose channels open in the same instant can't collide.
    if (this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING) {
      // A round is live: slot them straight in instead of stranding them on a
      // lobby screen (or forcing a wait for the next round).
      this.admitMidGame(player);
    } else {
      // LOBBY (or the brief ENDING window, which flips to LOBBY in a few seconds —
      // they just wait it out on the lobby screen).
      this.broadcastLobby();
    }
  }

  // Catch a mid-round joiner up to the running match. Everything a game decision
  // touches happens HERE, on the referee — the guest side only presents what it's
  // told. Late joiners come in as HUNTERS on purpose: joining as a prop mid-hunt
  // is unfair (no time to hide) and hunter is the prop-hunt convention. They get
  // the SAME filtered view every other guest receives (STARTED payload = map +
  // static props; a private ROLE; the current phase + clock; then the normal
  // per-tick snapshot) — never the host's full unfiltered state, so the "guests
  // never learn who's an undisguised prop" rule holds for late joiners too.
  admitMidGame(player) {
    const map = this.maps[this.mapId];
    player.role = ROLE.HUNTER;
    player.alive = true;
    player.disguise = null;
    player.input = { mx: 0, mz: 0, jump: false };
    player.pos = { x: map.hunterSpawn.x, y: 0, z: map.hunterSpawn.z };
    player.spawn = { x: player.pos.x, z: player.pos.z }; // fall-through failsafe target (fix #4)
    player.dispYaw = player.yaw;
    // If the world's physics is already up, give the newcomer a body immediately
    // (otherwise integrate() adds it on the next tick via the join-race guard).
    if (this.physics) this.physics.addPlayer(player.id, player.pos);

    // Catch-up: with a knockable world, a late joiner must receive the CURRENT
    // position of every prop that has moved (resting or not), or they'd see kicked
    // chairs/tables back at their spawn — an instant desync (fix #8). Props that
    // never moved (or are capped-static) fall back to their spawn entry.
    send(player, { t: S2C.STARTED, mapId: this.mapId, props: this._propsCatchup() });
    send(player, { t: S2C.ROLE, role: player.role });
    const seconds = Math.max(0, (this.phaseEndsAt - Date.now()) / 1000);
    send(player, { t: S2C.EVENT, kind: 'phase', phase: this.phase, seconds });
    // Refresh the (hidden-during-play) lobby list so names stay in sync for when
    // everyone returns to the persistent lobby.
    this.broadcastLobby();
  }

  removePlayer(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    if (this.physics) this.physics.removePlayer(id);

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
    this._physicsToken++;
    if (this.physics) {
      this.physics.destroy();
      this.physics = null;
    }
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
    player.input.jump = !!msg.jump;
    player.rotUnlock = !!msg.rotUnlock;
    if (Number.isFinite(msg.yaw)) player.yaw = msg.yaw;
    if (Number.isFinite(msg.pitch)) player.pitch = Math.max(-1.5, Math.min(1.5, msg.pitch));
    // Track the newest input id so each snapshot can tell this player which of its
    // inputs the host has already applied (its reconciliation ack). Guard against a
    // reordered/duplicate packet lowering the ack.
    if (Number.isFinite(msg.seq) && msg.seq > player.lastInputSeq) player.lastInputSeq = msg.seq;

    // Orientation lock: someone NOT disguised has no prop to keep still, so their
    // display yaw just tracks where they look (instant — no footprint to wedge). A
    // DISGUISED prop's facing is now advanced CONTINUOUSLY in integrate()
    // (updateDisguiseRotation) at a capped rate with a per-increment fit check, instead
    // of snapping to look-yaw here — a snap could teleport the prop into a pose it
    // can't fit, forcing the solver to eject/tunnel it (Bug 3). Nothing to do here for
    // the disguised case; the tick handles it.
    if (!player.disguise) player.dispYaw = player.yaw;
  }

  applyDisguise(player, propId) {
    if (player.role !== ROLE.PROP || !player.alive) return;
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    const prop = this.props.find((p) => p.id === propId);
    if (!prop || prop.disguisable === false) return; // knockable fixtures aren't disguisable
    // Read the prop's LIVE position (it may have been shoved across the room) so
    // disguising as a kicked chair still works. Sleeping/never-moved props fall back
    // to their spawn x/z. (fix #2: disguise/tag track live prop positions.)
    const live = this._propPos(prop);
    const dx = live.x - player.pos.x;
    const dz = live.z - player.pos.z;
    if (Math.hypot(dx, dz) > this.rules.disguiseRange) return;
    player.disguise = prop.type;
    // Lock the disguise's facing to the player's current look direction. From here
    // it stays fixed while they move (a real prop doesn't spin as it slides) UNLESS
    // right-click is held (rotUnlock), which lets them re-aim it on yaw only — never
    // tipping. Updated in integrate(). See notes/physics.md (orientation lock).
    player.dispYaw = player.yaw;
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

    this.lastResult = null; // a fresh round supersedes the previous result

    const map = this.maps[this.mapId];
    // Build the authoritative prop instances (= every dynamic rigid body) from map
    // data. TWO sources, ONE stream:
    //   1. map.props  — the disguise pool (chairs, stools, crates, dishes, food a
    //      player can hide as). disguisable: true.
    //   2. map.fixtures that are NOT bolted-in/decor — tables, cookware, plates,
    //      food, condiments. These are now knockable rigid bodies too (fix #2), but
    //      NON-disguisable: they never enter the disguise pool. disguisable: false.
    // Sharing one id-keyed stream means the existing prop machinery (physics bodies,
    // scene containers, awake-sync, mid-join catch-up) covers both for free. The
    // disguise/tag gates read the `disguisable` flag, so a table can be shoved but
    // never worn. y = rest offset above a surface; rot = spawn yaw.
    const catalog = { ...this.propCatalog, ...this.fixtureCatalog };
    // MAP RANDOMIZATION (host-authoritative, no seed on the wire). The host picks a
    // per-match seed and deterministically SKIPS ~mapRandomizeSkip (default 20%) of the
    // DISGUISABLE decorative props, so hiding spots differ each round and the scene has
    // gaps. ONLY map.props (the disguise pool) are eligible — fixtures/built-ins
    // (walls/floor/counters) are never touched. A minimum-keep clamp stops a sparse map
    // from emptying out. The seed lives ONLY here on the host: clients don't receive it,
    // they render/predict from the concrete reduced `props` list broadcast in STARTED
    // (and a late joiner gets the SAME reduced list via _propsCatchup), so every client
    // and every late joiner agree with zero desync risk. See notes/map-randomization.md.
    this.matchSeed = (Math.random() * 0x100000000) >>> 0;
    const mapProps = map.props || [];
    const skip = seededSkipSet(
      mapProps.length,
      this.matchSeed,
      this.rules.mapRandomizeSkip != null ? this.rules.mapRandomizeSkip : 0.2,
      this.rules.minPropsKept != null ? this.rules.minPropsKept : 6,
    );
    // `mi` = the source index in map.props, carried so the client can still zip authored
    // per-object `scale` back on by original index even though randomization removed some
    // props (a plain positional zip would misalign after a skip). Inert on every current
    // map (none author a scale). disguisable: true — all disguise-pool props.
    const disguiseProps = mapProps
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => !skip.has(i))
      .map(({ p, i }) => ({
        id: nextPropId++, mi: i, type: p.type, x: p.x, z: p.z, y: p.y || 0, rot: p.rot || 0, disguisable: true,
      }));
    // Bigger pieces first: the dynamic-body cap (rules.maxDynamicProps) spends its
    // budget on furniture/large cookware; anything past the cap degrades to a solid
    // STATIC collider (still collidable, just not shovable — phone safety).
    const dynFixtures = (map.fixtures || [])
      .filter((f) => { const c = catalog[f.type]; return c && !isStaticEntry(c); })
      .map((f) => ({ type: f.type, x: f.x, z: f.z, y: f.y || 0, rot: f.rot || 0 }))
      .sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]))
      .map((f) => ({ id: nextPropId++, ...f, disguisable: false }));
    this.props = [...disguiseProps, ...dynFixtures];
    // Live x/z per prop id, seeded at spawn and updated from awake transforms each
    // tick (see integrate). Read by applyDisguise for range against the real position.
    this.propLive = new Map(this.props.map((p) => [p.id, { x: p.x, z: p.z }]));

    // Randomly split into Hunters and Props (the host referee decides).
    shuffle(ids);
    // Always keep at least one prop (a round with nobody to hunt is pointless),
    // so hunters are capped at players-1. For a SOLO launch (ids.length === 1)
    // that cap is 0 → the lone host is a prop and can walk/disguise while testing
    // a map; the win-checker treats "zero hunters" as no instant win, so the round
    // just runs on the timer (surviving props win when it expires). See
    // checkRoundOver.
    const hunterCount = Math.min(
      Math.max(1, Math.round(ids.length * this.rules.hunterRatio)),
      Math.max(0, ids.length - 1),
    );
    let spawnIdx = 0;
    ids.forEach((id, i) => {
      const player = this.players.get(id);
      player.alive = true;
      player.disguise = null;
      player.input = { mx: 0, mz: 0, jump: false };
      player.dispYaw = player.yaw;
      if (i < hunterCount) {
        player.role = ROLE.HUNTER;
        player.pos = { x: map.hunterSpawn.x, y: 0, z: map.hunterSpawn.z };
      } else {
        player.role = ROLE.PROP;
        const s = map.spawns[spawnIdx++ % map.spawns.length];
        player.pos = { x: s.x, y: 0, z: s.z };
      }
      // Remember this player's spawn so the fall-through failsafe can send them back
      // here if they slip below the floor (fix #4).
      player.spawn = { x: player.pos.x, z: player.pos.z };
      send(player, { t: S2C.ROLE, role: player.role });
    });

    this.broadcast({ t: S2C.STARTED, mapId: this.mapId, props: this.props });
    this.setPhase(PHASE.HIDING, this.rules.hidingSeconds);

    // Spin up the authoritative Rapier world for this match (async: WASM loads from
    // a CDN on demand). integrate() uses the flat 2D fallback until it's ready.
    this._buildPhysics(map);
  }

  // Build (or rebuild) the authoritative physics world for the active map, then
  // add every current player's kinematic body. Fully async + guarded by a token so
  // a match that ends mid-load discards the stale world. On any failure the match
  // simply keeps running on the 2D fallback — never a hard stop.
  async _buildPhysics(map) {
    const token = ++this._physicsToken;
    if (this.physics) {
      this.physics.destroy();
      this.physics = null;
    }
    let RAPIER;
    try {
      RAPIER = await loadRapier();
    } catch (e) {
      // CDN unreachable / WASM blocked: stay on the 2D fallback for this match.
      return;
    }
    if (token !== this._physicsToken) return; // a newer match (or reset) superseded us
    try {
      const world = new PhysicsWorld(RAPIER, map, this.props, { ...this.propCatalog, ...this.fixtureCatalog }, {
        dynamicProps: true,
        rules: this.rules,
        feel: this.feel,
      });
      for (const p of this.players.values()) {
        if (p.alive && (p.role === ROLE.HUNTER || p.role === ROLE.PROP)) world.addPlayer(p.id, p.pos);
      }
      this.physics = world;
    } catch (e) {
      this.physics = null; // build blew up — 2D fallback carries the round
    }
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
    this.lastResult = { winner }; // survives into the persistent lobby (see broadcastLobby)
    this.broadcast({ t: S2C.EVENT, kind: 'roundOver', winner });
    this.setPhase(PHASE.ENDING, this.rules.endingSeconds);
  }

  resetToLobby() {
    this.phase = PHASE.LOBBY;
    this.props = [];
    // Tear down the match's physics world (bump the token so any still-in-flight
    // async build from this match is discarded rather than adopted next round).
    this._physicsToken++;
    if (this.physics) {
      this.physics.destroy();
      this.physics = null;
    }
    this.awakePropTransforms = [];
    this.propLive = null;
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
      p.input = { mx: 0, mz: 0, jump: false };
      p.rotUnlock = false;
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

  // CONTINUOUS disguise rotation (Bug 3). Right-click (rotUnlock) no longer snaps a
  // disguised prop instantly to look-yaw — that could teleport the prop into a pose it
  // can't fit rotated, forcing the physics solver to eject or tunnel it. Instead the
  // display yaw eases toward the look direction at a capped angular rate
  // (rules.disguiseRotSpeedDeg, default 270°/s), and each increment is validated: if
  // turning the prop's footprint that far would intersect world geometry
  // (physics.rotationWouldCollide), the turn STOPS there rather than forcing through.
  // Physics then resolves incrementally along the way instead of jumping to an illegal
  // state. Yaw stays authored here on the host (authoritative) and rides the snapshot as
  // before — no netcode change. Runs every tick with real dt.
  updateDisguiseRotation(dt) {
    const maxStep = (((this.rules.disguiseRotSpeedDeg || 270) * Math.PI) / 180) * dt;
    for (const p of this.players.values()) {
      if (!p.alive || !p.disguise) continue;
      // Only turn while right-click is held; otherwise the facing stays frozen (the
      // "prop doesn't spin as it slides" tell).
      const target = p.rotUnlock ? p.yaw : p.dispYaw;
      const delta = wrapAngle(target - p.dispYaw);
      if (Math.abs(delta) < 1e-4) continue;
      const step = Math.max(-maxStep, Math.min(maxStep, delta));
      const next = wrapAngle(p.dispYaw + step);
      // Per-increment fit check against the SHARED physics world (guarded — a missing
      // physics or query API just lets it turn, so rotation never locks up on a gap).
      if (this.physics && this.physics.rotationWouldCollide && this.physics.rotationWouldCollide(p.id, p.disguise, next)) {
        continue; // blocked: hold the last fitting facing rather than wedge the prop
      }
      p.dispYaw = next;
    }
  }

  integrate(dt) {
    const map = this.maps[this.mapId];
    const bound = map.size / 2 - this.rules.mapMargin;

    // Advance disguise facings continuously this tick (Bug 3), before movement.
    this.updateDisguiseRotation(dt);

    // Physics path: real collide-and-slide vs walls/fixtures, jump, prop shoving.
    if (this.physics) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (!this.physics.hasPlayer(p.id)) this.physics.addPlayer(p.id, p.pos); // join race
        const frozen = p.role === ROLE.HUNTER && this.phase === PHASE.HIDING;
        this.physics.setPlayerInput(
          p.id,
          frozen
            ? { mx: 0, mz: 0, yaw: p.yaw, jump: false }
            : { mx: p.input.mx, mz: p.input.mz, yaw: p.yaw, jump: p.input.jump }
        );
      }
      this.physics.step(dt);
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const t = this.physics.getPlayer(p.id);
        if (t) {
          // Keep the arena-edge clamp as a cheap backstop behind the wall colliders.
          p.pos.x = clamp(t.x, -bound, bound);
          p.pos.y = t.y;
          p.pos.z = clamp(t.z, -bound, bound);
        }
      }
      this.awakePropTransforms = this.physics.awakeProps();
      // Track each moving prop's live x/z so disguise range (applyDisguise) measures
      // against where a prop actually IS after being shoved. Sleeping props haven't
      // moved, so their last recorded position persists — no need to touch them.
      if (this.propLive) {
        for (const q of this.awakePropTransforms) {
          const l = this.propLive.get(q.id);
          if (l) { l.x = q.x; l.z = q.z; }
        }
      }

      // FALL-THROUGH FAILSAFE (fix #4): a cheap ~0.5 s sweep, host-authoritative. If a
      // player's capsule is ENTIRELY below the floor (capsule top < floor top - 2)
      // they've slipped through a seam — teleport them back to spawn at ground height
      // with motion zeroed. Any dynamic prop that fell below the world respawns at its
      // map position. Runs ONLY here in the host's referee tick; the correction lands
      // on every client through the normal per-tick snapshot (never a client teleport).
      const now = Date.now();
      if (now - (this._lastFailsafe || 0) >= 500) {
        this._lastFailsafe = now;
        const floorTop = 0; // every map's ground/floor surface sits at y=0
        const capsuleH = 2 * ((this.rules.playerRadius || 0.4) + (this.rules.playerHalfHeight || 0.5));
        for (const p of this.players.values()) {
          if (!p.alive || !p.spawn) continue;
          if ((p.pos.y || 0) + capsuleH < floorTop - 2) {
            p.pos = { x: p.spawn.x, y: 0, z: p.spawn.z };
            this.physics.setPlayerPosition(p.id, p.pos);
          }
        }
        this.physics.respawnEscaped(floorTop - 2);
      }
      return;
    }

    // 2D fallback (physics not loaded yet, or Rapier unavailable): flat movement,
    // no vertical, no collision — playable, matches the pre-physics behaviour.
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
      p.pos.y = 0;
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
    // lastResult carries the previous round's winner into the persistent lobby.
    this.broadcast({ t: S2C.LOBBY, room: this.code, hostId: this.hostId, players, phase: this.phase, mapId: this.mapId, result: this.lastResult });
  }

  broadcastSnapshot() {
    const timeLeft = Math.max(0, (this.phaseEndsAt - Date.now()) / 1000);
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: round2(p.pos.x),
      y: round2(p.pos.y || 0), // jump height (0 on the flat fallback)
      z: round2(p.pos.z),
      // Display yaw: a disguised prop broadcasts its LOCKED facing (dispYaw), so it
      // won't spin as it slides; everyone else faces where they look. dispYaw tracks
      // yaw for the unlocked/undisguised case (see applyInput).
      yaw: round3(p.disguise ? p.dispYaw : p.yaw),
      // Reconciliation ack: the last INPUT.seq the host consumed from this player.
      ack: p.lastInputSeq,
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
    const full = {
      t: S2C.SNAPSHOT,
      phase: this.phase,
      timeLeft: round2(timeLeft),
      propsAlive,
      propsTotal,
      players,
      // Only AWAKE dynamic props ride each snapshot (sleeping ones haven't moved, so
      // there's nothing to send — the bandwidth win). Empty on the 2D fallback.
      props: this.awakePropTransforms.map((q) => ({
        id: q.id,
        x: round2(q.x),
        y: round2(q.y),
        z: round2(q.z),
        qx: round3(q.qx),
        qy: round3(q.qy),
        qz: round3(q.qz),
        qw: round3(q.qw),
      })),
    };

    // HUNTER BLINDFOLD — data-peek shield (anti-cheat). While the start-of-map HIDING
    // countdown runs, every hunter is blindfolded. The client blacks out the screen and
    // freezes look, but a hacked client could delete that overlay — so we ALSO withhold
    // the data it would need to peek: for a hunter during HIDING we strip every PROP-role
    // player's transform and all dynamic-prop transforms from THAT recipient's snapshot
    // (blindHunterSnapshot). Props (not blindfolded) and everyone during HUNTING keep the
    // full stream, so full prop data resumes the instant the host flips HIDING→HUNTING.
    // This is per-recipient dispatch — the SAME single filter path, computed once per
    // tick and reused. See memory/notes/anti-cheat-blindfold.md.
    let blinded = null;
    for (const p of this.players.values()) {
      if (p.role === ROLE.HUNTER && this.phase === PHASE.HIDING) {
        if (!blinded) blinded = blindHunterSnapshot(full);
        send(p, blinded);
      } else {
        send(p, full);
      }
    }
  }

  // Live x/z of a prop (shoved position if it has moved, else spawn). See propLive.
  _propPos(prop) {
    const l = this.propLive && this.propLive.get(prop.id);
    return l || { x: prop.x, z: prop.z };
  }

  // The prop list to hand a mid-round joiner: each prop carries its LIVE transform
  // (centre + quaternion) when the physics world is up, so a knocked-about room
  // arrives as it actually is. Props with no live body (capped-static, or physics
  // not yet loaded) keep their spawn entry. Quantised like a snapshot.
  _propsCatchup() {
    if (!this.physics) return this.props;
    const live = new Map(this.physics.allProps().map((q) => [q.id, q]));
    return this.props.map((p) => {
      const q = live.get(p.id);
      if (!q) return p; // never simulated (capped-static) — spawn pose is correct
      return {
        id: p.id, mi: p.mi, type: p.type, disguisable: p.disguisable,
        x: round2(q.x), y: round2(q.y), z: round2(q.z),
        qx: round3(q.qx), qy: round3(q.qy), qz: round3(q.qz), qw: round3(q.qw),
      };
    });
  }
}

// ---- helpers --------------------------------------------------------------

// Deterministic set of prop indices to SKIP for map randomization (feature: gaps in
// the scene each round). A mulberry32 PRNG seeded by the match seed drives a partial
// Fisher–Yates over [0..n): shuffle and take the first `skipCount`. skipCount =
// round(n * ratio), clamped so at least `minKeep` props always remain — a sparse map
// (few props) is never emptied out, and a full ~20% is removed on dense maps. Pure +
// deterministic: same (n, seed, ratio, minKeep) always yields the same set, so the host
// could reproduce a round — but ONLY the host runs this; clients get the concrete
// reduced prop list, never the seed. Exported for tools/check-features.mjs.
export function seededSkipSet(n, seed, ratio, minKeep) {
  const skip = new Set();
  if (!(n > 0)) return skip;
  const r = Number.isFinite(ratio) ? ratio : 0.2;
  const keepFloor = Number.isFinite(minKeep) ? minKeep : 6;
  let skipCount = Math.round(n * r);
  const maxSkip = Math.max(0, n - keepFloor);
  if (skipCount > maxSkip) skipCount = maxSkip;
  if (skipCount <= 0) return skip;
  const idx = Array.from({ length: n }, (_, i) => i);
  const rng = mulberry32(seed >>> 0);
  for (let i = 0; i < skipCount; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
    skip.add(idx[i]);
  }
  return skip;
}

// Small, fast, seedable PRNG (public-domain mulberry32). Deterministic given its seed —
// what makes the map randomization reproducible on the host.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Filtered snapshot for a BLINDFOLDED hunter (HIDING phase) — the data-peek half of the
// anti-cheat blindfold. Removes every prop-role player entry (they are hiding; a hunter
// must not learn where, even via a hacked client) and all dynamic-prop transforms, so a
// hunter's HIDING snapshot carries zero prop positions to draw. Hunters stay in the list
// (visible seekers); the propsAlive/propsTotal COUNTS stay (they carry no position and
// show normally in the HUD anyway). Pure so tools/check-features.mjs can assert it.
export function blindHunterSnapshot(full) {
  return { ...full, players: full.players.filter((pl) => pl.hunter), props: [] };
}

// Rough footprint volume of a catalog entry, for prioritising which knockable
// fixtures get a dynamic body when the cap is tight (bigger pieces win). Prefers
// measured bounds when present, else the authored primitive.
function footprint(c) {
  if (!c) return 0;
  const m = c.measured;
  if (m && m.w > 0 && m.h > 0 && m.d > 0) return m.w * m.h * m.d;
  switch (c.shape) {
    case 'box': return (c.w || 1) * (c.h || 1) * (c.d || 1);
    case 'cylinder':
    case 'cone': return Math.PI * (c.r || 0.5) * (c.r || 0.5) * (c.h || 1);
    case 'sphere': return (4 / 3) * Math.PI * (c.r || 0.5) ** 3;
    default: return 1;
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
// Wrap an angle delta into [-π, π] so continuous disguise rotation always turns the
// short way and never treats a ±2π wrap as a huge jump.
const wrapAngle = (a) => {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
