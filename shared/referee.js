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
import { C2S, S2C, PHASE, ROLE, HUNTER_TOOL_IDS } from './protocol.js';
import { loadRapier, PhysicsWorld, isFixedBodyEntry, isArchEntry, isDisguisableEntry } from './physics.js';
import { WALL_INSET } from './bounds.js';
import { resolveDamageCfg, multiplierForDisguise, wrongGuessPenalty, resolveGrenadeCfg, grenadeFalloff, grenadeOuterRadius } from './damage.js';

const DEG2RAD = Math.PI / 180;

// Lobby display-name cap. Mirrors js/net.js cleanName() (the join-time cleaner)
// so a name looks the same whether it's set at join or via a lobby rename.
const NAME_MAX = 16;

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
    // Shape catalogs (props = movable items, fixtures = built-ins + scenery). Disguise
    // eligibility is now "renderable mesh AND not architecture" (Part B), so the disguise
    // pool = map.props + every NON-architecture map.fixture (startMatch promotes them with
    // isDisguisableEntry). Only ARCHITECTURE (floors/walls, isArchEntry) stays out. Kept as
    // separate merged lookups; the physics world also reads them for collider dimensions.
    this.propCatalog = config.props || {};
    this.fixtureCatalog = config.fixtures || {};
    // AUDIO TAUNT library (data-driven). The SAME manifest the client loads
    // (assets/taunts/manifest.json → cfg.taunts), so the host validates a taunt id against the
    // exact same list the menu shows — adding ~50 real clips later is a data-only change (drop
    // files + manifest lines, ZERO code). An absent/empty manifest is fine (no taunts available;
    // applyTaunt just rejects every id). `_tauntIds` is the O(1) existence check for relays.
    this.taunts = (config.taunts && Array.isArray(config.taunts.taunts)) ? config.taunts.taunts : [];
    this._tauntIds = new Set(this.taunts.map((t) => t && t.id).filter(Boolean));
    // DEFAULT_MAP_ID: the first map in maps.json until the host picks another via
    // setMapId(). This is the ONLY place the map choice lives; startMatch/integrate
    // read it without re-validating (see setMapId for why the id is trusted).
    this.mapId = Object.keys(this.maps)[0];

    this.code = code;
    this.players = new Map(); // id -> player
    this.hostId = null;

    // DEBUG GATE (?debug=1). The referee ALWAYS runs inside the HOST's browser tab, so
    // reading the host's own URL here is exactly "does the HOST have debug on". The
    // `debug:` message family (handleDebug) is dropped unless this is true — so a random
    // guest (even a tampered one) can't push debug commands into a normal match. When the
    // host IS in debug mode, the whole table has opted into a dev session. See js/debug.js.
    this.debugEnabled =
      typeof location !== 'undefined' && typeof URLSearchParams !== 'undefined'
        ? new URLSearchParams(location.search).get('debug') === '1'
        : false;

    this.phase = PHASE.LOBBY;
    this.props = []; // authoritative prop instances for the active map
    // Indices into the active map's `fixtures[]` that the load-time hide-spot removal pass
    // deleted this match (host-authoritative). Broadcast in STARTED so every client drops the
    // same fixtures' LOCAL scenery mesh AND static collider, and passed to the physics world so
    // its `_buildStatic` skips them. Empty until startMatch runs. See startMatch.
    this.removedFixtures = [];
    // Round-robin cursor for placing a MID-ROUND entrant (team switch / mid-game join) at a prop
    // spawn, so successive drop-ins spread across the map's spawn points instead of stacking. See
    // _spawnOnTeam. Persists across rounds (harmless — it's only a spawn-point index).
    this._propSpawnRR = 0;
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
    // GHOST-PLAYER TIMEOUT (B2, 2026-07-18). A peer whose phone locks or whose signal drops
    // SILENTLY never fires a WebRTC 'close', so the graceful-leave path (net.js → removePlayer)
    // never runs and they linger as an uncontrolled ghost. We stamp `player._lastSeen` on every
    // C2S message (handleMessage) and, during an active round, sweep out anyone silent longer than
    // this window (tick → _sweepSilentPlayers). INPUT rides at 20Hz all through HIDING/HUNTING, so
    // a genuinely-connected client is never silent; only a dropped one goes quiet. See rules.json.
    this._leaveTimeoutMs = Math.max(0, (this.rules.leaveTimeoutSeconds != null ? this.rules.leaveTimeoutSeconds : 5) * 1000);
    // Per-round record of which teams have EVER had a member this round (set at round start +
    // whenever a player joins/switches onto a team). checkRoundOver reads these so a team emptied
    // by a LEAVE (which removes the player from the roster, erasing the roster-count evidence that
    // the team existed) still resolves the round — a departed last prop is a hunter win, a departed
    // last hunter a props win. Undefined until the first round; checkRoundOver falls back to the
    // live roster count then (so a manually-driven test harness behaves as before).
    this._roundHadHunters = undefined;
    this._roundHadProps = undefined;
    this.interval = setInterval(() => this.tick(), 1000 / this.rules.tickRate);
  }

  // ---- membership ---------------------------------------------------------
  // player: { id, name, send }. `send` is how the referee talks back to this
  // player — a DataChannel write for guests, a direct call for the host.
  addPlayer(player) {
    player.role = null;
    player.alive = true;
    player.health = this._startHealth(); // HUNTER-TOOLS v1: 0..100 % health (HUD + damage)
    player.ready = false;
    player.disguise = null;
    player.pos = { x: 0, y: 0, z: 0 };
    player.yaw = 0; // look yaw (drives movement + the tag/aim cone)
    player.pitch = 0;
    player.dispYaw = 0; // display yaw for a disguised prop (orientation lock)
    player.rotUnlock = false; // right-click held: a disguise may rotate on yaw
    player.lastInputSeq = 0; // echoed as `ack` for client reconciliation
    player.input = { mx: 0, mz: 0, jump: false };
    // AUDIO TAUNTS: true while this player's CURRENT taunt was forced uncancellable by the
    // (future) prop-finder tool (referee.forceTaunt) — their stop button is then ignored. A
    // normal self-chosen taunt clears it (see applyTaunt). Reset each match in startMatch.
    player.tauntUncancellable = false;
    // PROP FINDER: timestamp of this player's last finder activation (PER-HUNTER cooldown, never
    // shared). 0 = ready. Reset each match (startMatch) and on resetToLobby. See applyFind.
    player._lastFindAt = 0;
    // HELD-TOOL VISIBILITY (B7): the hunter's currently-selected tool, rebroadcast in the
    // snapshot so others render the right item in their hands. Defaults to the rifle; updated
    // by C2S.SELECT_TOOL (applySelectTool) and reset to rifle on every fresh spawn.
    player.tool = 'rifle';

    player._lastSeen = Date.now(); // GHOST-PLAYER TIMEOUT: fresh join is "seen now" (see tick sweep)
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
    // MID-ROUND JOIN (2026-07-17, VRmike): a player joining a live round drops STRAIGHT into it on the
    // team with the FEWER players — a coin-flip when the teams are even — instead of always as a hunter.
    // Count the CURRENT teams (this newcomer isn't slotted in yet); ties → random. Host-authoritative.
    let hunters = 0, props = 0;
    for (const p of this.players.values()) {
      if (p === player) continue;
      if (p.role === ROLE.HUNTER) hunters++;
      else if (p.role === ROLE.PROP) props++;
    }
    const role =
      hunters < props ? ROLE.HUNTER :
      props < hunters ? ROLE.PROP :
      (Math.random() < 0.5 ? ROLE.HUNTER : ROLE.PROP); // even teams → random

    // Catch-up FIRST: with a knockable world, a late joiner must receive the CURRENT position of every
    // prop that has moved (resting or not), or they'd see kicked chairs/tables back at their spawn — an
    // instant desync (fix #8). STARTED must precede ROLE/phase so the client switches into the running
    // world before it learns its role. Props that never moved (or are capped-static) fall back to spawn.
    //
    // ANTI-CHEAT: a HUNTER joining DURING HIDING is blindfolded — they must get the factory-fresh
    // (spawn-form) world, never the live shoved positions (a data peek the screen-blackout can't stop
    // if a client deletes the overlay). Props join seeing normally; hunters joining in HUNTING see the
    // live world. The blindfolded joiner gets the full world snapshot at HIDING→HUNTING (setPhase).
    const blind = role === ROLE.HUNTER && this.phase === PHASE.HIDING;
    send(player, { t: S2C.STARTED, mapId: this.mapId, props: this._propsCatchup(blind), removedFixtures: this.removedFixtures });
    // Fresh spawn on the assigned team via the SHARED routine (same one the pause-menu team switch
    // uses, so mid-join and switch can't drift): full HP, no disguise, a physics body + private ROLE.
    this._spawnOnTeam(player, role);
    const seconds = Math.max(0, (this.phaseEndsAt - Date.now()) / 1000);
    send(player, { t: S2C.EVENT, kind: 'phase', phase: this.phase, seconds });
    // Public log line for EVERYONE ("X joined the hunters") + refresh the (hidden-during-play) lobby
    // list so names stay in sync for when everyone returns to the persistent lobby.
    this.broadcastLog(`${player.name} joined the ${role === ROLE.HUNTER ? 'hunters' : 'props'}`);
    this.broadcastLobby();
  }

  // A player left — GRACEFUL (WebRTC 'close'/'error' → net.js) or a SILENT TIMEOUT (the sweep in
  // tick() when a locked/dropped phone stops sending). Either way we FULLY remove them: despawn the
  // physics body + collider (so no ghost avatar blocks anyone), drop them from the roster (so they
  // vanish from every snapshot + team count), announce a public "X left" line, and recount BOTH
  // teams so a departure can resolve or unstick the round. `reason` is only for the log flavour.
  removePlayer(id, reason) {
    const player = this.players.get(id);
    if (!player) return;
    const wasActive = this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING;
    this.players.delete(id);
    if (this.physics) this.physics.removePlayer(id); // despawn avatar + collider (no ghost body)

    // The host is the referee: if it leaves, the whole match is torn down by the
    // network layer and this instance is destroyed, so this reassignment only
    // ever matters when a *guest* leaves (hostId is unchanged then).
    if (this.hostId === id) {
      this.hostId = this.players.keys().next().value || null;
    }

    // Public feed line so everyone sees who dropped (mirrors the join / team-switch log lines).
    if (player.name) this.broadcastLog(`${player.name} left${reason ? ` (${reason})` : ''}`);

    // Recount BOTH teams after the removal: a ghost prop must not keep a round alive, and a leaver
    // who was the last of their team resolves it (last prop gone → hunters win; last hunter gone →
    // props win). checkRoundOver reads the per-round _roundHad* flags so it still knows the emptied
    // team existed even though the leaver is no longer in the roster to be counted.
    if (wasActive) this.checkRoundOver();
    this.broadcastLobby();
  }

  // GHOST-PLAYER TIMEOUT (B2, 2026-07-18). Called each tick during an active round. A connected
  // client streams INPUT at 20Hz all through HIDING/HUNTING, so a peer that has sent NOTHING for
  // _leaveTimeoutMs has genuinely dropped (phone locked, signal lost) WITHOUT a WebRTC 'close' —
  // the exact case that used to leave an uncontrolled ghost standing in the round. Remove them the
  // same way a graceful leave does. Two guards keep it safe: (1) the HOST is never swept — the
  // referee lives in its tab, so if it were gone nothing would be running; (2) disabled if the
  // timeout is 0. Collect-then-remove so we don't mutate the map mid-iteration.
  _sweepSilentPlayers(now) {
    if (!(this._leaveTimeoutMs > 0)) return;
    let gone = null;
    for (const p of this.players.values()) {
      if (p.id === this.hostId) continue; // never time out the host (it IS the referee)
      const last = p._lastSeen || 0;
      if (now - last > this._leaveTimeoutMs) (gone || (gone = [])).push(p.id);
    }
    if (gone) for (const id of gone) this.removePlayer(id, 'timed out');
  }

  // ---- lobby rename (host-authoritative) ----------------------------------
  // Change a player's OWN display name from the lobby. Every player — the host and
  // an invite-link guest alike — routes here through C2S.RENAME (no special-casing);
  // a player can only rename THEMSELVES because the referee looks up the sender by
  // their connection id (handleMessage), never a name in the payload. The host is the
  // authority: it trims whitespace, caps the length, REJECTS an empty name (keeps the
  // old one), and de-dupes so two people can't share a name. Then it rebroadcasts the
  // roster (broadcastLobby) — the SAME rebroadcast a join fires — so every lobby list,
  // including late joiners, updates live. LOBBY-ONLY: a rename mid-round is ignored so
  // scoreboards and elimination messages don't shuffle names mid-match (rename again
  // back in the lobby). The chosen name rides every later snapshot, so it carries into
  // the game for the scoreboard/feed automatically.
  applyRename(player, rawName) {
    if (this.phase !== PHASE.LOBBY) return; // lobby-only; a live match keeps its names
    const cleaned = String(rawName == null ? '' : rawName).slice(0, NAME_MAX).trim();
    if (!cleaned) return; // reject empty/whitespace-only — keep the current name
    const unique = this._uniqueName(cleaned, player.id);
    if (unique === player.name) return; // no actual change → no needless rebroadcast
    player.name = unique;
    this.broadcastLobby();
  }

  // Resolve a name clash so two players never share a display name: if `name` is taken
  // by ANOTHER player, append the smallest free integer suffix ("Alex" -> "Alex2"),
  // trimming the base so the result still fits the length cap. Case-insensitive compare.
  _uniqueName(name, exceptId) {
    const taken = new Set();
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.name) taken.add(p.name.toLowerCase());
    }
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 10000; n++) {
      const suffix = String(n);
      const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name; // pathological (thousands of clashes) — give up gracefully
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
    // GHOST-PLAYER TIMEOUT: any C2S message is proof the peer is alive. Stamp it so the silent-
    // timeout sweep (tick) only ever removes a peer that has genuinely gone quiet.
    player._lastSeen = Date.now();
    switch (msg.t) {
      case C2S.READY:
        player.ready = !!msg.ready;
        this.broadcastLobby();
        break;
      case C2S.RENAME:
        this.applyRename(player, msg.name);
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
      case C2S.TAUNT:
        this.applyTaunt(player, msg.id);
        break;
      case C2S.STOP_TAUNT:
        this.applyStopTaunt(player);
        break;
      // C2S.TAG (legacy instant-kill melee) is intentionally NOT handled: HUNTER-TOOLS v1
      // replaces it with the rifle + health system, and honouring it would let a tag bypass
      // health (an instant kill). Dropped so even a hand-crafted TAG message is a no-op.
      case C2S.SHOOT:
        this.applyShot(player, msg);
        break;
      case C2S.FIND:
        this.applyFind(player);
        break;
      case C2S.GRENADE:
        this.applyGrenade(player, msg);
        break;
      case C2S.SELECT_TOOL:
        this.applySelectTool(player, msg.tool);
        break;
      case C2S.SWITCH_TEAM:
        this.applySwitchTeam(player);
        break;
      case C2S.DEBUG:
        this.handleDebug(player, msg);
        break;
      default:
        break;
    }
  }

  // ---- debug commands (?debug=1 only) -------------------------------------
  // The host-authoritative half of the in-game debug menu (js/debug.js). Every command
  // routes through the referee exactly like a normal state change, so host and guests
  // share ONE authoritative path. HARD GATE: dropped entirely unless the HOST loaded with
  // ?debug=1 (this.debugEnabled) — a guest can send C2S.DEBUG all day, but a normal match's
  // host ignores it. Only meaningful during a live round for team/morph; reset works from
  // any phase.
  handleDebug(player, msg) {
    if (!this.debugEnabled) return; // host isn't in debug mode → this is a normal match
    const action = msg && msg.action;
    if (action === 'team') this.debugSetTeam(player, msg.role);
    else if (action === 'reset') this.debugReset();
    else if (action === 'morph') this.debugMorph(player, msg.type);
  }

  // CHANGE TEAMS: flip a player between hunter and prop, mid-round, host-authoritatively.
  // Becoming a hunter drops any disguise and shrinks the physics capsule back to base;
  // the player's private ROLE message updates their client, and the next snapshot carries
  // the new hunter/alive flags to everyone. Keeps position (a debug teleport isn't wanted).
  debugSetTeam(player, role) {
    const r = role === ROLE.HUNTER ? ROLE.HUNTER : ROLE.PROP;
    player.role = r;
    // Keep the per-round team-existence flags monotonic (see _launchRound / checkRoundOver).
    if (r === ROLE.HUNTER) this._roundHadHunters = true;
    else this._roundHadProps = true;
    player.alive = true;
    player.health = this._startHealth();
    if (r === ROLE.HUNTER) {
      player.disguise = null;
      if (this.physics && this.physics.setPlayerCollider) this.physics.setPlayerCollider(player.id, null);
      // HITBOX ACCURACY: back to a capsule-matching shot sensor (undisguised hunter is shot
      // on their body shape, no leftover disguise silhouette).
      if (this.physics && this.physics.setShotCollider) this.physics.setShotCollider(player.id, null);
    }
    player.dispYaw = player.yaw;
    send(player, { t: S2C.ROLE, role: r });
    // A team flip can end the round (e.g. the last prop became a hunter → no props left is
    // NOT a hunter win; checkRoundOver only ends on "props existed and all are caught").
    this.checkRoundOver();
    this.broadcastLobby();
  }

  // RESET GAME: cleanly restart the round. Reuse the well-tested resetToLobby() teardown
  // (roles/alive/disguise/physics world all cleared), then immediately start a fresh match
  // when there are enough players (minPlayers=1, so a solo debug host just re-rolls). If a
  // start isn't possible the group is left in the lobby to start manually.
  debugReset() {
    this.resetToLobby();
    if (this.players.size >= this.rules.minPlayers) this.startMatch();
  }

  // FORCE MORPH INTO PROP X: force-disguise the sender as any catalog type, resizing the
  // physics capsule through the SAME setPlayerCollider path applyDisguise uses (so the
  // disguised body is solid at the right girth) — but bypassing the range / aimed-prop
  // checks, which is the whole point of a debug morph. `type` must be a real catalog entry.
  debugMorph(player, type) {
    if (!type || !player.alive) return;
    const c = this.propCatalog[type] || this.fixtureCatalog[type];
    if (!c) return; // not a real catalog type
    player.disguise = type;
    if (this.physics && this.physics.setPlayerCollider) this.physics.setPlayerCollider(player.id, type);
    if (this.physics && this.physics.setShotCollider) this.physics.setShotCollider(player.id, type); // disguise-shaped shot sensor
    player.dispYaw = player.yaw;
    send(player, { t: S2C.EVENT, kind: 'disguised', type });
  }

  // ---- shared fresh-spawn onto a team (team switch + mid-round join) -------
  // FRESH-spawn a SINGLE player onto `role`'s team, mid-round, host-authoritatively. The ONE routine
  // both the pause-menu TEAM SWITCH (applySwitchTeam) and the MID-ROUND JOIN (admitMidGame) use, so
  // the two can never drift. Full reset — the newcomer/switcher starts a clean life: alive, full HP,
  // NO disguise (a new prop re-disguises by aiming; a fresh hunter gets its default tools client-side),
  // cleared taunt/finder state, motion zeroed. Placed at the team's spawn (hunters share hunterSpawn;
  // props round-robin the map spawns). The physics body is repositioned (or created) and its movement
  // collider + shot sensor are reset to a plain capsule (a hunter, or an undisguised prop). Finally the
  // player is handed its new private ROLE. Guarded so it works on the 2D fallback (physics not up).
  _spawnOnTeam(player, role) {
    const map = this.maps[this.mapId];
    player.role = role;
    // A join/switch onto a team means that team HAS had a member this round (monotonic — never
    // cleared mid-round), so checkRoundOver still resolves if that team later empties via a leave.
    if (role === ROLE.HUNTER) this._roundHadHunters = true;
    else if (role === ROLE.PROP) this._roundHadProps = true;
    player.alive = true;
    player.health = this._startHealth();
    player.disguise = null;
    player.rotUnlock = false;
    player.tauntUncancellable = false;
    player._lastFindAt = 0;
    player.tool = 'rifle'; // HELD-TOOL VISIBILITY (B7): a fresh spawn starts on the rifle
    player.input = { mx: 0, mz: 0, jump: false };
    if (role === ROLE.HUNTER) {
      player.pos = { x: map.hunterSpawn.x, y: 0, z: map.hunterSpawn.z };
    } else {
      const s = map.spawns[this._propSpawnRR++ % map.spawns.length];
      player.pos = { x: s.x, y: 0, z: s.z };
    }
    player.spawn = { x: player.pos.x, z: player.pos.z }; // fall-through failsafe target (fix #4)
    player.dispYaw = player.yaw;
    if (this.physics) {
      if (this.physics.hasPlayer(player.id)) this.physics.setPlayerPosition(player.id, player.pos);
      else this.physics.addPlayer(player.id, player.pos);
      // Back to a base capsule: drop any disguise girth + a disguise-shaped shot sensor (a fresh
      // hunter or an undisguised fresh prop is collided/shot on their plain body shape).
      if (this.physics.setPlayerCollider) this.physics.setPlayerCollider(player.id, null);
      if (this.physics.setShotCollider) this.physics.setShotCollider(player.id, null);
      // SEAM D3: a fresh respawn (team switch / mid-join) can land ON another player — the shared
      // hunter spawn especially. Nudge the newcomer clear so nobody spawns fused inside anyone.
      if (this.physics.resolveSpawnOverlap) this.physics.resolveSpawnOverlap(player.id);
    }
    send(player, { t: S2C.ROLE, role });
  }

  // PAUSE-MENU TEAM SWITCH (2026-07-17, VRmike). The sender clicks "Switch teams" and is respawned as
  // a FRESH player on the OPPOSITE team via the shared _spawnOnTeam routine, then a PUBLIC log line is
  // broadcast to everyone ("X switched to hunters"). Host-authoritative; active-round only (a switch
  // in the lobby/ending window is ignored). NO cooldown / anti-abuse — accepted per VRmike.
  applySwitchTeam(player) {
    if (!player) return;
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    const newRole = player.role === ROLE.HUNTER ? ROLE.PROP : ROLE.HUNTER;
    this._spawnOnTeam(player, newRole);
    this.broadcastLog(`${player.name} switched to ${newRole === ROLE.HUNTER ? 'hunters' : 'props'}`);
    // A switch changes team COUNTS, so it can legitimately end a round (e.g. the remaining props were
    // all already dead). checkRoundOver counts by CURRENT role, so it never fires a false win — the
    // switcher is no longer counted on their old team.
    this.checkRoundOver();
  }

  // HELD-TOOL VISIBILITY (B7). A hunter reports which tool it has selected so its third-person
  // model shows the right item to everyone else. Host-authoritative relay: accept it only from a
  // LIVING HUNTER and only a REAL tool id (HUNTER_TOOL_IDS) — otherwise ignore and keep the
  // current value, so a hacked client can't push a bogus/other-player tool. Stored on the player
  // and rebroadcast in that player's snapshot entry (broadcastSnapshot `tool`). Purely cosmetic:
  // it changes no damage/hitbox/gameplay — which tool actually fires stays the client-only fire
  // path. No broadcast here; the change rides the next snapshot like every other player field.
  applySelectTool(player, tool) {
    if (!player || player.role !== ROLE.HUNTER || !player.alive) return;
    if (!HUNTER_TOOL_IDS.includes(tool)) return;
    player.tool = tool;
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
    if (!prop || prop.disguisable === false) return; // architecture (floors/walls) isn't disguisable
    // Read the prop's LIVE position (it may have been shoved across the room) so
    // disguising as a kicked chair still works. Sleeping/never-moved props fall back
    // to their spawn x/z. (fix #2: disguise/tag track live prop positions.)
    const live = this._propPos(prop);
    const dx = live.x - player.pos.x;
    const dz = live.z - player.pos.z;
    if (Math.hypot(dx, dz) > this.rules.disguiseRange) return;
    player.disguise = prop.type;
    // Grow this player's authoritative collision capsule to the disguise footprint
    // (solidity pass #3, Bug 1): a big disguise is now solid crate-to-crate instead of
    // clipping into world props. Guarded — no-op on the 2D fallback (physics not up).
    // The disguised player's OWN client mirrors this on its prediction body (main.js).
    if (this.physics && this.physics.setPlayerCollider) this.physics.setPlayerCollider(player.id, prop.type);
    // HITBOX ACCURACY: swap the shot sensor to the disguise's shape so bullets now register on
    // the visible prop silhouette (a table's corners, a chair's back), not the movement capsule.
    if (this.physics && this.physics.setShotCollider) this.physics.setShotCollider(player.id, prop.type);
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

  // ---- HUNTER-TOOLS v1: assault rifle (host-authoritative) -----------------
  // Starting health (0..100 %). Config-tunable; defaults to 100.
  _startHealth() {
    return this.rules && this.rules.startHealth != null ? this.rules.startHealth : 100;
  }

  // The merged shape catalog (props + fixtures) used for size-based damage lookups.
  _combatCatalog() {
    return { ...this.propCatalog, ...this.fixtureCatalog };
  }

  // RAPID FIRE (2026-07-12): the host's authoritative minimum time (ms) between a hunter's
  // shots — the rate CAP a modified client can't beat. Derived from rules.fireRateRpm
  // (rounds/minute; 600-800 is the real assault-rifle band) as 60000/rpm, minus a small
  // grace so a legit client firing exactly on-cadence isn't throttled BELOW the intended
  // rate by timer/network jitter (the grace still caps a cheat: e.g. 700 rpm => ~86ms => cap
  // ~66ms => ~900 rpm hard ceiling, not thousands). Falls back to the legacy fireCooldownMs.
  _fireCooldownMs() {
    const rpm = this.rules.fireRateRpm;
    if (Number.isFinite(rpm) && rpm > 0) return Math.max(10, Math.round(60000 / rpm) - 20);
    return this.rules.fireCooldownMs != null ? this.rules.fireCooldownMs : 250;
  }

  // DAMAGE MULTIPLIER — always derived FRESH from a player's CURRENT disguise, never a cached
  // value from an earlier disguise. This is the authoritative fix for the size-multiplier bug
  // (a prop that goes small then re-disguises large must immediately take large-object damage,
  // not keep the small-object multiplier): there is NO per-player multiplier state anywhere —
  // this reads target.disguise at the instant damage is applied and re-runs the size curve.
  // tools/check-combat.mjs proves it across a small->large re-disguise. See shared/damage.js.
  _playerHitDamage(target) {
    const d = resolveDamageCfg(this.rules.damage);
    return d.base * multiplierForDisguise(target.disguise, this._combatCatalog(), d);
  }

  // Fire the rifle. The client sends only its AIM direction (dx,dy,dz — the camera-forward
  // it also disguise-picks with). The HOST is the authority: it re-casts the shot in its
  // own physics world from the shooter's authoritative eye, decides what was hit, applies
  // damage, and broadcasts the muzzle-flash + tracer to EVERYONE (kind:'shot'). A hacked
  // client can aim anywhere (legal — you can always aim), but it can never claim a hit the
  // host's world doesn't produce. No physics world yet (2D fallback) => a no-damage tracer.
  applyShot(hunter, msg) {
    if (!hunter || hunter.role !== ROLE.HUNTER || !hunter.alive) return;
    if (this.phase !== PHASE.HUNTING) return; // no shooting during HIDING (hunters frozen/blind)
    const now = Date.now();
    const cd = this._fireCooldownMs();
    if (now - (hunter._lastShotAt || 0) < cd) return; // rate limit (host-enforced cap)
    hunter._lastShotAt = now;

    // Aim direction: trust the client's camera-forward; fall back to yaw/pitch if absent.
    let dx = Number(msg && msg.dx), dy = Number(msg && msg.dy), dz = Number(msg && msg.dz);
    let len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6) || !Number.isFinite(len)) {
      const cp = Math.cos(hunter.pitch || 0);
      dx = -Math.sin(hunter.yaw) * cp;
      dy = Math.sin(hunter.pitch || 0);
      dz = -Math.cos(hunter.yaw) * cp;
      len = 1;
    }
    dx /= len; dy /= len; dz /= len;

    const EYE = 1.5; // eye height above the foot (first-person camera sits at ~1.6)
    const eye = { x: hunter.pos.x, y: (hunter.pos.y || 0) + EYE, z: hunter.pos.z };
    const range = this.rules.shootRange != null ? this.rules.shootRange : 120;

    let impact = { x: eye.x + dx * range, y: eye.y + dy * range, z: eye.z + dz * range };
    let info = null;
    let hitSomething = false;
    if (this.physics && this.physics.raycastShot) {
      const r = this.physics.raycastShot(hunter.id, eye, { x: dx, y: dy, z: dz }, range);
      if (r) { impact = r.point; info = r.info; hitSomething = true; }
    }
    // Damage decision (pure w.r.t. physics — the info descriptor is all it needs).
    this._applyShotDamage(hunter, info);

    // SHOT IMPULSE (2026-07, VRmike): a shot that lands on a DYNAMIC prop gives it a small
    // host-authoritative kick at the hit point along the shot direction, so shot items get a
    // visible nudge. Cosmetic/feel only — the damage decision above is untouched, and this is
    // a no-op for player/fixture/world hits and on the 2D fallback (no physics). It rides the
    // normal prop stream to every client (asleep bodies are woken inside applyShotImpulse).
    if (hitSomething && info && info.kind === 'prop' && this.physics && this.physics.applyShotImpulse) {
      const kick = this.rules.shotImpulse != null ? this.rules.shotImpulse : 1.5;
      this.physics.applyShotImpulse(info.id, impact, { x: dx, y: dy, z: dz }, kick);
    }

    // Muzzle a touch forward + down of the eye so the tracer reads as coming from the
    // held rifle (approximate; the exact bone muzzle isn't networked in v1).
    const muzzle = { x: eye.x + dx * 0.5, y: eye.y + dy * 0.5 - 0.15, z: eye.z + dz * 0.5 };
    this.broadcast({
      t: S2C.EVENT, kind: 'shot', by: hunter.id,
      ox: round2(muzzle.x), oy: round2(muzzle.y), oz: round2(muzzle.z),
      ix: round2(impact.x), iy: round2(impact.y), iz: round2(impact.z),
      hit: hitSomething,
    });
  }

  // Resolve a shot's DAMAGE from its classified hit descriptor (physics.describeCollider).
  // Split from applyShot so the offline guard (tools/check-combat.mjs) can drive it with a
  // synthetic descriptor and no Rapier. Rules:
  //   - player hit           -> that player takes base * size-multiplier(their disguise).
  //   - disguisable object    -> the object COULD have been a player, so the HUNTER takes a
  //     (prop or non-arch fixture)  FLAT wrong-guess penalty (base, NO size multiplier — a
  //                                 burger decoy and a table decoy cost the same; 20 = dead).
  //   - architecture / world  -> free miss, no damage (walls/floor/ceiling/ground).
  _applyShotDamage(hunter, info) {
    if (!info) return;
    const d = resolveDamageCfg(this.rules.damage);
    const catalog = this._combatCatalog();
    if (info.kind === 'player') {
      const target = this.players.get(info.id);
      if (!target || !target.alive || target.id === hunter.id) return;
      // Derive the size multiplier FRESH from the target's CURRENT disguise (never cached) —
      // _playerHitDamage re-runs the curve on target.disguise every hit, so a re-disguise
      // (small -> large) takes effect immediately. See _playerHitDamage.
      this._damagePlayer(hunter, target, this._playerHitDamage(target), false);
      return;
    }
    if (info.kind === 'prop') {
      const prop = this.props.find((p) => p.id === info.id);
      if (!prop) return;
      const c = catalog[prop.type];
      if (!c || isArchEntry(c) || prop.disguisable === false) return; // architecture-ish => miss
      this._damagePlayer(hunter, hunter, wrongGuessPenalty(d), true); // FLAT wrong-guess penalty (never size-scaled)
      return;
    }
    if (info.kind === 'fixture') {
      const c = catalog[info.type];
      if (!c || isArchEntry(c)) return; // real wall/floor => free miss
      this._damagePlayer(hunter, hunter, wrongGuessPenalty(d), true); // FLAT wrong-guess penalty (never size-scaled)
      return;
    }
    // kind:'world' (ground slab / boundary walls) => architecture => nothing.
  }

  // Apply `dmg` to `victim`. Broadcasts a 'hurt' event (feedback; health also rides the
  // snapshot), and on death flips alive=false, announces 'eliminated', and — for a PROP
  // killed by a live hunter — REFILLS the hunter to full (the kill reward). Death can end
  // the round (all props caught => hunters win; all hunters dead => props win).
  _damagePlayer(attacker, victim, dmg, self) {
    if (!victim || !victim.alive) return;
    victim.health = Math.max(0, (victim.health != null ? victim.health : this._startHealth()) - dmg);
    this.broadcast({
      t: S2C.EVENT, kind: 'hurt', victim: victim.id, by: attacker.id,
      self: !!self, dmg: round2(dmg), health: round2(victim.health),
    });
    if (victim.health <= 0) {
      victim.alive = false;
      const wasHunter = victim.role === ROLE.HUNTER;
      this.broadcast({ t: S2C.EVENT, kind: 'eliminated', by: attacker.id, victim: victim.id, name: victim.name, hunter: wasHunter });
      // KILL REFILL: a hunter that kills a PROP player refills to full health. (A hunter
      // that self-destructs on a decoy, or friendly-fires another hunter, gets nothing.)
      if (victim.role === ROLE.PROP && attacker.role === ROLE.HUNTER && attacker.alive) {
        attacker.health = this._startHealth();
      }
      this.checkRoundOver();
    }
  }

  // ---- audio taunts (props only, host-authoritative relay) ----------------
  // A prop asks to play a taunt clip. The host is the authority: it validates the sender is a
  // LIVING PROP in an active phase and the taunt id exists in the manifest, then relays the
  // request to EVERYONE tagged with who taunted (S2C.EVENT kind:'taunt'). Each client plays the
  // clip as 3D positional audio at that prop's LIVE position — so hunters can locate props by
  // ear (taunting is a self-snitch by design). The cut-off rule (a new taunt from the same
  // player replaces their previous one) is handled per-emitter on each client, so the referee
  // only relays. A self-chosen taunt is always cancellable, and clears any forced-uncancellable
  // flag left by the prop-finder tool (the player chose to taunt again).
  applyTaunt(player, id) {
    if (!player || player.role !== ROLE.PROP || !player.alive) return;
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    if (typeof id !== 'string' || !this._tauntIds.has(id)) return; // unknown taunt → ignore
    player.tauntUncancellable = false;
    this.broadcast({ t: S2C.EVENT, kind: 'taunt', by: player.id, id, uncancellable: false });
  }

  // Stop the sender's OWN currently-playing taunt for everyone. Ignored when their current taunt
  // was forced uncancellable by the prop-finder tool (forceTaunt) — that's the whole point of the
  // uncancellable flag: the prop's stop button can't kill a finder-triggered taunt.
  applyStopTaunt(player) {
    if (!player) return;
    if (player.tauntUncancellable) return; // finder-forced taunt: the stop button does nothing
    this.broadcast({ t: S2C.EVENT, kind: 'tauntStop', by: player.id });
  }

  // FINDER-TOOL HOOK (design-only — NOT wired to gameplay yet). Force a RANDOM taunt from a given
  // prop player, marked UNCANCELLABLE so that prop's stop button won't silence it. The future
  // prop-finder tool hooks this up with one line: `referee.forceTaunt(propId)`. Returns true if a
  // taunt was fired. Deterministic PRNG is not needed — this is a host-authoritative broadcast
  // and different clients must all play the SAME chosen clip, so the host picks once and relays.
  forceTaunt(propId) {
    const player = this.players.get(propId);
    if (!player || player.role !== ROLE.PROP || !player.alive) return false;
    if (!this.taunts.length) return false; // empty library → nothing to force
    const pick = this.taunts[Math.floor(Math.random() * this.taunts.length)];
    if (!pick || !pick.id) return false;
    player.tauntUncancellable = true;
    this.broadcast({ t: S2C.EVENT, kind: 'taunt', by: propId, id: pick.id, uncancellable: true });
    return true;
  }

  // ---- PROP FINDER (hunter tool #2, host-authoritative) -------------------
  // Per-hunter cooldown (ms) between finder activations. Derived from rules.finderCooldownSeconds
  // (VRmike expects to tune it live). Enforced HOST-SIDE so a hacked client can't skip it.
  _finderCooldownMs() {
    const s = this.rules.finderCooldownSeconds;
    return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : 20000;
  }

  // AOE radius (metres). The zone cylinder the hunter sees is this radius and effectively
  // infinite in height, so the target test is a FLAT 2D distance — height is ignored.
  _finderRadius() {
    const r = this.rules.finderRadius;
    return Number.isFinite(r) && r > 0 ? r : 8;
  }

  // Activate the prop finder for `hunter`. Host is the authority for EVERYTHING: it checks the
  // hunter's OWN per-hunter cooldown (`_lastFindAt`, never shared between hunters), then forces a
  // random UNCANCELLABLE taunt out of every LIVING PROP whose position is within finderRadius of
  // the hunter (2D — the cylinder is infinitely tall). Each forced taunt rides the normal
  // forceTaunt broadcast (kind:'taunt', uncancellable:true) so all clients hear the victims taunt
  // positionally through the existing 3D taunt path. Replies privately to the hunter with the
  // cooldown state so its tool button can show the countdown / play the denied buzz.
  applyFind(hunter) {
    if (!hunter || hunter.role !== ROLE.HUNTER || !hunter.alive) return;
    if (this.phase !== PHASE.HUNTING) return; // hunters act only during HUNTING (frozen in HIDING)
    const now = Date.now();
    const cd = this._finderCooldownMs();
    const since = now - (hunter._lastFindAt || 0);
    if (hunter._lastFindAt && since < cd) {
      // Still cooling down — reject (host-enforced) and tell the hunter how long is left so its
      // client plays the short denied buzz and keeps the on-button countdown honest.
      send(hunter, { t: S2C.EVENT, kind: 'find', ok: false, remainMs: cd - since });
      return;
    }
    hunter._lastFindAt = now;

    const r = this._finderRadius();
    const r2 = r * r;
    const hx = hunter.pos.x, hz = hunter.pos.z;
    let hits = 0;
    for (const p of this.players.values()) {
      if (p.role !== ROLE.PROP || !p.alive) continue;
      const dx = p.pos.x - hx, dz = p.pos.z - hz; // 2D distance only (infinite-height cylinder)
      if (dx * dx + dz * dz <= r2) {
        if (this.forceTaunt(p.id)) hits++;
      }
    }
    send(hunter, { t: S2C.EVENT, kind: 'find', ok: true, cooldownMs: cd, hits });
  }

  // ---- HUNTER GRENADES (hunter tool #3, host-authoritative) ---------------
  // Throw a grenade. The client sends ONLY its aim direction (dx,dy,dz — the same camera-forward
  // the rifle sends); it NEVER sends a hit point. The HOST is the authority: it raycasts that aim
  // through its OWN world (reusing the rifle's raycastShot) and explodes INSTANTLY at the first hit
  // (no arc/travel/fuse). NO COOLDOWN — grenades are balanced by risk (the backfire), not a timer.
  // Then _resolveGrenadeBlast does all the damage + the redemption rule. A hacked client can aim
  // anywhere (legal) but can never move the blast to fake a kill or dodge backfire, and with no
  // physics world yet (2D fallback) the blast simply centres on the aim ray end (nothing to hit).
  applyGrenade(hunter, msg) {
    if (!hunter || hunter.role !== ROLE.HUNTER || !hunter.alive) return;
    if (this.phase !== PHASE.HUNTING) return; // hunters act only during HUNTING (frozen in HIDING)

    // Aim direction: trust the client's camera-forward; fall back to yaw/pitch if absent. Same
    // normalisation applyShot uses (a client can always aim; only the WORLD is host-judged).
    let dx = Number(msg && msg.dx), dy = Number(msg && msg.dy), dz = Number(msg && msg.dz);
    let len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6) || !Number.isFinite(len)) {
      const cp = Math.cos(hunter.pitch || 0);
      dx = -Math.sin(hunter.yaw) * cp;
      dy = Math.sin(hunter.pitch || 0);
      dz = -Math.cos(hunter.yaw) * cp;
      len = 1;
    }
    dx /= len; dy /= len; dz /= len;

    const EYE = 1.5; // eye height above the foot (matches applyShot)
    const eye = { x: hunter.pos.x, y: (hunter.pos.y || 0) + EYE, z: hunter.pos.z };
    const range = this.rules.shootRange != null ? this.rules.shootRange : 120;

    // HOST recomputes the blast centre — the first thing the aim ray touches (never a client point).
    let center = { x: eye.x + dx * range, y: eye.y + dy * range, z: eye.z + dz * range };
    if (this.physics && this.physics.raycastShot) {
      const r = this.physics.raycastShot(hunter.id, eye, { x: dx, y: dy, z: dz }, range);
      if (r) center = r.point;
    }

    this._resolveGrenadeBlast(hunter, center);
  }

  // Resolve a grenade blast at `center` (host-authoritative). Split from applyGrenade so the
  // offline guard (tools/check-grenade.mjs) can drive it with a synthetic centre + no Rapier.
  // ORDERING IS LOAD-BEARING (the redemption rule):
  //   1. compute EVERY prop-PLAYER's damage (base×size-multiplier×falloff) AND the total hunter
  //      BACKFIRE (flat base×falloff off non-player decoy props) for this blast — WITHOUT applying
  //      anything yet;
  //   2. apply the prop-player damage and note whether any prop player DIED as a result;
  //   3. if a prop player died => the thrower is REDEEMED to FULL HP and the backfire is forgiven
  //      (never applied); if nobody died => apply the backfire, which may kill the hunter.
  // So the backfire can NEVER kill the hunter before we've checked whether a prop-kill redeemed
  // them. NO friendly fire (other hunters are never targeted) and NO direct self-damage (the blast
  // only reaches the thrower THROUGH decoy props). Broadcasts the explosion for everyone's flash.
  _resolveGrenadeBlast(hunter, center) {
    const g = resolveGrenadeCfg(this.rules.grenade);
    const startHealth = this._startHealth();
    const baseHP = g.baseDamage * startHealth; // fraction of full health -> HP (0.45*100 = 45)
    const outer = grenadeOuterRadius(g); // = fullDamageRadius + falloffDistance (1 + 2), derived
    const catalog = this._combatCatalog();

    // (1a) Prop-PLAYER damage: base × their disguise SIZE multiplier (the same curve the rifle
    // uses, so tiny burger props take proportionally more) × distance falloff. Computed first,
    // applied in (2). Other hunters are never in this list (props only) => no friendly fire.
    const playerHits = [];
    for (const p of this.players.values()) {
      if (p.role !== ROLE.PROP || !p.alive) continue;
      const d = dist3(center, p.pos);
      if (d >= outer) continue;
      const f = grenadeFalloff(d, g);
      if (f <= 0) continue;
      const mult = multiplierForDisguise(p.disguise, catalog, this.rules.damage);
      const dmg = baseHP * mult * f;
      if (dmg > 0) playerHits.push({ player: p, dmg });
    }

    // (1b) BACKFIRE: flat base × falloff (NO size multiplier — a burger decoy and a table decoy
    // cost the thrower the same, so ~3 direct decoy hits = lethal without hardcoding "3") summed
    // over every non-player DECOY prop in range — the same "could be a player but isn't" objects
    // the rifle backfires on (a disguisable, non-architecture prop instance). Architecture and
    // non-disguisable knockables never backfire.
    let backfire = 0;
    for (const prop of this.props) {
      if (prop.disguisable === false) continue; // not a "could-be-a-player" decoy
      const c = catalog[prop.type];
      if (!c || isArchEntry(c)) continue; // architecture (walls/floors) never backfires
      const pos = this._propBlastPos(prop);
      const d = dist3(center, pos);
      if (d >= outer) continue;
      const f = grenadeFalloff(d, g);
      if (f > 0) backfire += baseHP * f;
    }

    // (2) Apply the prop-player damage; track whether any prop player died from THIS blast.
    let killedProp = false;
    for (const h of playerHits) {
      const wasAlive = h.player.alive;
      this._damagePlayer(hunter, h.player, h.dmg, false);
      if (wasAlive && !h.player.alive) killedProp = true;
    }

    // (3) Redemption vs backfire. A prop-player kill restores the thrower to FULL HP (explicit,
    // even though _damagePlayer's kill-refill already did it) and the backfire is forgiven. Only
    // if NOBODY died does the backfire land — possibly fatally.
    let redeemed = false;
    if (killedProp) {
      if (hunter.alive) hunter.health = startHealth; // redeemed to full (backfire never applied)
      redeemed = true;
    } else if (backfire > 0) {
      this._damagePlayer(hunter, hunter, backfire, true); // self-inflicted via decoys; may be lethal
    }

    this.broadcast({
      t: S2C.EVENT, kind: 'grenade', by: hunter.id,
      x: round2(center.x), y: round2(center.y), z: round2(center.z),
      hits: playerHits.filter((h) => !h.player.alive).length,
      backfire: round2(redeemed ? 0 : backfire), redeemed,
    });
  }

  // Best-known world position of a decoy prop for blast-distance: its LIVE shoved x/z (propLive,
  // updated each tick from awake transforms) when the physics world is up, else its spawn x/z;
  // y comes from the prop's rest offset (props sit on surfaces near their authored height). Used
  // by _resolveGrenadeBlast; falls back cleanly to the spawn entry when there's no physics (the
  // offline guard sets prop.x/y/z directly).
  _propBlastPos(prop) {
    const l = this.propLive && this.propLive.get(prop.id);
    return { x: l ? l.x : prop.x, y: prop.y || 0, z: l ? l.z : prop.z };
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
  // Start the FIRST round from the lobby (host START). Randomly split into hunters/props, then hand
  // off to the shared round-start flow. After this, rounds chain ENDLESSLY with flipped teams
  // (startFlippedRound) instead of returning to the lobby — see tick()'s ENDING branch.
  startMatch() {
    if (this.phase !== PHASE.LOBBY) return;
    const ids = [...this.players.keys()];
    if (ids.length < this.rules.minPlayers) {
      const host = this.players.get(this.hostId);
      if (host) send(host, { t: S2C.ERROR, msg: `Need at least ${this.rules.minPlayers} players to start.` });
      return;
    }
    // Randomly split into Hunters and Props (the host referee decides). Always keep at least one prop:
    // hunters are capped at players-1, so a SOLO launch (n===1) yields 0 hunters (the lone host is a
    // prop and can walk/disguise while testing a map). Roles are assigned here; _launchRound spawns them.
    shuffle(ids);
    const hunterCount = Math.min(
      Math.max(1, Math.round(ids.length * this.rules.hunterRatio)),
      Math.max(0, ids.length - 1),
    );
    ids.forEach((id, i) => { this.players.get(id).role = i < hunterCount ? ROLE.HUNTER : ROLE.PROP; });
    this._launchRound();
  }

  // ENDLESS FLIPPED ROUNDS (2026-07-17, VRmike): when a round ends, instead of returning to the lobby,
  // immediately start the next round with every team FLIPPED — every prop becomes a hunter and every
  // hunter becomes a prop — then run the SAME round-start flow (fresh spawns, disguises re-rolled,
  // physics reset). Rounds keep chaining while the host (= the referee's tab) is connected; the host
  // leaving tears the match down (no host migration yet). Called from tick() when ENDING expires.
  startFlippedRound() {
    const players = [...this.players.values()];
    if (players.length === 0) { this.resetToLobby(); return; }
    for (const p of players) p.role = p.role === ROLE.HUNTER ? ROLE.PROP : ROLE.HUNTER;
    // A round needs >=1 prop to be meaningful (mirrors startMatch). The only zero-prop flip is a lone
    // host who was a prop (solo → 0 hunters → flip → 0 props); keep one player a prop in that case.
    if (!players.some((p) => p.role === ROLE.PROP)) players[0].role = ROLE.PROP;
    this._launchRound();
  }

  // Shared round-start flow for BOTH a fresh match (startMatch) and each flipped round
  // (startFlippedRound). Assumes every player's `role` is ALREADY assigned. Builds the authoritative
  // prop instances (hide-spot removal pass), spawns each player FRESH by role (full HP, no disguise,
  // cleared taunt/finder state), sends each a private ROLE, broadcasts STARTED, enters HIDING, and
  // stands up the physics world. Clears lastResult (a new round supersedes the previous result).
  _launchRound() {
    this.lastResult = null; // a fresh round supersedes the previous result
    // Record which teams start this round populated (roles are already assigned by startMatch /
    // startFlippedRound). checkRoundOver reads these so a team later emptied by a LEAVE still
    // resolves the round; _spawnOnTeam / admitMidGame keep them monotonically true as players
    // join or switch onto a team mid-round.
    const roster = [...this.players.values()];
    this._roundHadHunters = roster.some((p) => p.role === ROLE.HUNTER);
    this._roundHadProps = roster.some((p) => p.role === ROLE.PROP);

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
    // HIDE-SPOT REMOVAL (host-authoritative, no seed on the wire). The load-time pass that
    // deletes ~mapRandomizeSkip of the scene to open hiding gaps now covers EVERYTHING a prop
    // player can disguise as (VRmike 2026-07-16): both the disguise-pool props (map.props) AND
    // every NON-ARCHITECTURE fixture — knockable tables/cookware AND bolted-in built-ins
    // (counters, pillars, fridge, doors…). It draws from the SAME "can this be disguised as?"
    // rule the disguise pool uses (isDisguisableEntry), so the removal set and the pool can never
    // drift. ARCHITECTURE (floors/walls/ceilings, isArchEntry) is the one thing never eligible.
    //
    // The decision is made ONCE here (host-side) and every downstream consumer builds from it:
    //   - the trimmed `this.props` (aim proxies + dynamic bodies) below,
    //   - `this.removedFixtures` (indices into map.fixtures) broadcast in STARTED — so each
    //     client drops the removed BUILT-IN's LOCAL scenery mesh AND its `_buildStatic` collider
    //     (both, so a removed pillar can never leave an invisible wall — the stuck-spot failure),
    //   - `_buildPhysics`, which passes the same set to the authoritative collider world.
    // The seed lives ONLY on the host; clients get the concrete reduced props list + the removed
    // index set, never the seed, so every client and late joiner agree with zero desync risk.
    // See notes/map-randomization.md.
    this.matchSeed = (Math.random() * 0x100000000) >>> 0;
    const skipRatio = this.rules.mapRandomizeSkip != null ? this.rules.mapRandomizeSkip : 0.25;
    const minKept = this.rules.minPropsKept != null ? this.rules.minPropsKept : 6;
    // NO MORE PIN (floating-fixed-props round 4, 2026-07-17). Every non-architecture object is a
    // dynamic body now — plates/food/decor included, per VRmike's standing instruction. The old
    // `pinClutterAboveY` pin that froze surface clutter in mid-air is gone; the launch-out-of-hull
    // problem it worked around is solved by seating each item on the collider actually beneath it
    // (shared/grounding.js seatMapData, run at load). See isFixedBodyEntry + notes/physics.md.

    // (1) Disguise-pool props (map.props) — all disguisable; existing behaviour, ratio bumped.
    // `mi` = the source index in map.props, carried so the client can still zip authored
    // per-object `scale` back on by original index even though removal skipped some props (a
    // plain positional zip would misalign after a skip). Inert on every current map (no scales).
    const mapProps = map.props || [];
    const propSkip = seededSkipSet(mapProps.length, this.matchSeed, skipRatio, minKept);
    const disguiseProps = mapProps
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => !propSkip.has(i))
      .map(({ p, i }) => ({
        id: nextPropId++, mi: i, type: p.type, x: p.x, z: p.z, y: p.y || 0, rot: p.rot || 0,
        disguisable: isDisguisableEntry(catalog[p.type]),
      }));

    // (2) Fixtures — remove the SAME ratio of the DISGUISABLE (non-architecture) ones. Eligible =
    // their ORIGINAL map.fixtures indices; the skip runs over just those slots (a decorrelated
    // seed so props and fixtures don't thin the same relative positions), then maps back to real
    // indices. `removedFixtures` (real indices) is the single set every downstream consumer keys
    // off — architecture indices are never in `eligible`, so floors/walls/ceilings are untouched.
    const mapFixtures = map.fixtures || [];
    const eligibleFixtureIdx = [];
    mapFixtures.forEach((f, i) => {
      const c = catalog[f.type];
      if (c && isDisguisableEntry(c)) eligibleFixtureIdx.push(i);
    });
    const fxSkipLocal = seededSkipSet(
      eligibleFixtureIdx.length, (this.matchSeed ^ 0x9e3779b9) >>> 0, skipRatio, minKept,
    );
    const removedFixtures = new Set([...fxSkipLocal].map((k) => eligibleFixtureIdx[k]));
    this.removedFixtures = [...removedFixtures];

    // DISGUISE-ANYTHING (Part B) + EVERYTHING-IS-A-PHYSICS-OBJECT (2026-07-16, VRmike attempt #3).
    // Every NON-ARCHITECTURE fixture that SURVIVED removal is promoted into the prop stream and
    // flagged disguisable, so a player can aim at + become it. Two kinds:
    //   - dynFixtures: knockable fixtures (tables, cookware, dishes, food) AND — now that the
    //     built-ins are un-`static` — the counters, cabinets, oven, stove(s), fridge, sinks and
    //     shelf. All get a REAL dynamic body (shovable) and are disguise targets.
    //   - staticFixtures: the only pieces still bolted in — PILLARS (structural columns), the
    //     DOOR, and the vent/extractor HOOD. These stay IMMOVABLE — physics builds their collider
    //     in _buildStatic and _buildProps skips them — but they ride the prop stream so scene.js
    //     can raycast + highlight them and applyDisguise accepts them (invisible aim proxy; the
    //     visible mesh is the local scenery).
    // The removed fixtures are excluded HERE exactly as the client scenery loop + _buildStatic
    // exclude them, carrying each survivor's original index through the dyn/static split.
    const nonArchFixtures = mapFixtures
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => {
        const c = catalog[f.type];
        return c && !isArchEntry(c) && !removedFixtures.has(i);
      });
    const dynFixtures = nonArchFixtures
      .filter(({ f }) => !isFixedBodyEntry(catalog[f.type]))
      .map(({ f }) => ({
        id: nextPropId++, type: f.type, x: f.x, z: f.z, y: f.y || 0, rot: f.rot || 0,
        disguisable: isDisguisableEntry(catalog[f.type]),
      }));
    const staticFixtures = nonArchFixtures
      .filter(({ f }) => isFixedBodyEntry(catalog[f.type]))
      .map(({ f }) => ({
        id: nextPropId++, type: f.type, x: f.x, z: f.z, y: f.y || 0, rot: f.rot || 0,
        disguisable: isDisguisableEntry(catalog[f.type]),
      }));
    // ONE pool of dynamic-body candidates: the disguise-pool props AND the now-dynamic fixtures.
    // Order them GLOBALLY BIGGEST-FIRST so the phone-safe dynamic-body cap (rules.maxDynamicProps,
    // enforced in physics._buildProps) spends its budget on the largest, most-worth-shoving objects
    // (fridge, tables, counters, chairs, stools, crates) instead of letting 100 tiny disguise props
    // jump the queue and silently demote a counter to a fixed collider. Whatever falls past the cap
    // (the smallest scraps — condiments, cut veg) stays a solid STATIC collider: still collidable,
    // just not shovable. staticFixtures (pillars/door/vent) never get a body and go last.
    // The sort is deterministic (stable, footprint-keyed) so host + late joiners agree.
    const dynamicCandidates = [...disguiseProps, ...dynFixtures]
      .sort((a, b) => footprint(catalog[b.type]) - footprint(catalog[a.type]));
    this.props = [...dynamicCandidates, ...staticFixtures];
    // Live x/z per prop id, seeded at spawn and updated from awake transforms each
    // tick (see integrate). Read by applyDisguise for range against the real position.
    this.propLive = new Map(this.props.map((p) => [p.id, { x: p.x, z: p.z }]));

    // Spawn every player FRESH for their already-assigned role (startMatch shuffled the split;
    // startFlippedRound flipped it). Props round-robin the map's prop spawns; hunters share the hunter
    // spawn. Full reset so a flipped player starts a clean round: alive, full HP, no disguise, cleared
    // taunt/finder state, motion zeroed. A zero-hunter (solo) round just runs on the timer
    // (checkRoundOver treats "no hunters" as no instant win; the surviving prop wins at expiry).
    let spawnIdx = 0;
    for (const player of this.players.values()) {
      player.alive = true;
      player.health = this._startHealth();
      player.disguise = null;
      player.input = { mx: 0, mz: 0, jump: false };
      player.rotUnlock = false;
      player.dispYaw = player.yaw;
      player.tauntUncancellable = false; // fresh round: no forced taunt in flight
      player._lastFindAt = 0; // PROP FINDER: fresh round → cooldown reset to ready (no stuck grey)
      player.tool = 'rifle'; // HELD-TOOL VISIBILITY (B7): fresh round → back to the rifle
      if (player.role === ROLE.HUNTER) {
        player.pos = { x: map.hunterSpawn.x, y: 0, z: map.hunterSpawn.z };
      } else {
        const s = map.spawns[spawnIdx++ % map.spawns.length];
        player.pos = { x: s.x, y: 0, z: s.z };
      }
      // Remember this player's spawn so the fall-through failsafe can send them back here (fix #4).
      player.spawn = { x: player.pos.x, z: player.pos.z };
      send(player, { t: S2C.ROLE, role: player.role });
    }

    this.broadcast({ t: S2C.STARTED, mapId: this.mapId, props: this.props, removedFixtures: this.removedFixtures });
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
        removedFixtures: this.removedFixtures, // skip the hide-spot-removed built-ins' colliders
      });
      for (const p of this.players.values()) {
        if (p.alive && (p.role === ROLE.HUNTER || p.role === ROLE.PROP)) {
          world.addPlayer(p.id, p.pos);
          // If a prop already disguised during the async WASM load (the match ran on the
          // 2D fallback meanwhile), size their capsule to it now (solidity pass #3).
          if (p.disguise) world.setPlayerCollider(p.id, p.disguise);
          // HITBOX ACCURACY: attach every player's shot sensor (disguise-shaped or capsule-
          // matching) so the authoritative shot raycast tests the visible shape from the start.
          if (world.setShotCollider) world.setShotCollider(p.id, p.disguise || null);
          // SEAM D3: every hunter shares one spawn point, so several materialise inside each other
          // on a fresh world. Resolving per-player as we add fans them apart (each newcomer clears
          // the ones already placed) so nobody starts the round fused to a teammate.
          if (world.resolveSpawnOverlap) world.resolveSpawnOverlap(p.id);
        }
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
    // WORLD SNAPSHOT ON BLINDFOLD RELEASE (host-authoritative object sync). A hunter was
    // blindfolded through HIDING: their snapshots carried ZERO prop transforms
    // (blindHunterSnapshot) AND, by the time HUNTING starts, nearly every object a hiding
    // prop shoved has settled ASLEEP — so the per-tick awake stream won't resend it either.
    // Result without this: the just-released hunter sees the FACTORY-FRESH map (props upright
    // at spawn) instead of the world as it actually is — the exact "hunters spawning in later
    // still see it upright" desync. So the instant HIDING→HUNTING, hand every hunter a ONE-TIME
    // full snapshot of every dynamic body's current transform. Same anti-cheat door as the
    // blindfold: withheld until the precise moment the hunter is allowed to see the world.
    // (Props were never blindfolded — they tracked the awake stream live — so they don't need
    // it.) HIDING→HUNTING is the only path into HUNTING, so this can't double-fire.
    // SPECTATORS RIDE THE SAME GATE (B6, 2026-07-18). A DEAD player (spectator) is withheld all
    // prop positions through HIDING exactly like a blindfolded hunter (see broadcastSnapshot) — a
    // dead teammate on voice must not narrate where props are hiding to live hunters. So they, too,
    // need this one-time world catch-up the moment HUNTING starts, else their fly cam would show the
    // factory-fresh map. Dying during HIDING is rare (hunters are frozen + blindfolded then), but
    // this closes the hole cleanly instead of special-casing it. Live props were never withheld.
    if (phase === PHASE.HUNTING) {
      const world = this._propsCatchup();
      for (const p of this.players.values()) {
        if (p.role === ROLE.HUNTER || !p.alive) send(p, { t: S2C.EVENT, kind: 'world', props: world });
      }
    }
  }

  // ONE shared recount, run after every elimination, team switch, mid-join AND leave, plus at
  // round transitions. Resolves the round if EITHER side has no living members left — whether they
  // were caught/self-destructed OR simply LEFT. The per-round _roundHad* flags record that a team
  // existed this round even after a leaver is dropped from the roster (a departed last prop erases
  // the roster-count proof that props existed), so a ghost/leaver can neither keep a round alive nor
  // strand it. Falls back to the live roster count when the flags are unset (a manually-driven test
  // harness that never ran _launchRound), preserving the original death-only behaviour there.
  checkRoundOver() {
    if (this.phase !== PHASE.HIDING && this.phase !== PHASE.HUNTING) return;
    const all = [...this.players.values()];
    const props = all.filter((p) => p.role === ROLE.PROP);
    const hunters = all.filter((p) => p.role === ROLE.HUNTER);
    const aliveProps = props.filter((p) => p.alive);
    const aliveHunters = hunters.filter((p) => p.alive);
    const hadProps = this._roundHadProps != null ? this._roundHadProps : props.length > 0;
    const hadHunters = this._roundHadHunters != null ? this._roundHadHunters : hunters.length > 0;

    // The round had props and none survive (every prop caught OR the last one left) => hunters win.
    if (hadProps && aliveProps.length === 0) {
      this.endRound(ROLE.HUNTER);
      return;
    }
    // HUNTER-TOOLS v1 win condition: hunters do NOT respawn (see DECISIONS.md). If the round had
    // hunters and none survive — self-destructed on a decoy, friendly-fired, OR the last one left —
    // the round ends HUNTERS LOSE, PROPS WIN. A zero-hunter solo round (_roundHadHunters false)
    // never triggers this and just runs on the timer.
    if (hadHunters && aliveHunters.length === 0) {
      this.endRound(ROLE.PROP);
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
      p.health = this._startHealth();
      p.disguise = null;
      p.ready = false;
      p.input = { mx: 0, mz: 0, jump: false };
      p.rotUnlock = false;
      p.tauntUncancellable = false; // no forced taunt survives a round teardown
      p._lastFindAt = 0; // PROP FINDER: cooldown resets to ready across round/lobby transitions
      p.tool = 'rifle'; // HELD-TOOL VISIBILITY (B7): reset to the rifle on a round/lobby teardown
    }
    this.broadcastLobby();
  }

  // ---- simulation ---------------------------------------------------------
  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    if (this.phase === PHASE.HIDING || this.phase === PHASE.HUNTING) {
      this._sweepSilentPlayers(now); // GHOST-PLAYER TIMEOUT: drop peers that went silent mid-round
      this.integrate(dt);
    }

    // Timer-driven phase transitions.
    if (this.phase !== PHASE.LOBBY && now >= this.phaseEndsAt) {
      if (this.phase === PHASE.HIDING) {
        this.setPhase(PHASE.HUNTING, this.rules.huntingSeconds);
      } else if (this.phase === PHASE.HUNTING) {
        this.endRound(ROLE.PROP); // time ran out, surviving props win
      } else if (this.phase === PHASE.ENDING) {
        // ENDLESS FLIPPED ROUNDS: chain straight into the next round with teams flipped instead of
        // returning to the lobby, as long as the host (= the referee's tab, so always, while this
        // runs) still has players. resetToLobby stays as the empty-room fallback.
        if (this.players.size > 0) this.startFlippedRound();
        else this.resetToLobby();
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
        if (!this.physics.hasPlayer(p.id)) {
          this.physics.addPlayer(p.id, p.pos); // join race
          if (this.physics.setShotCollider) this.physics.setShotCollider(p.id, p.disguise || null);
          if (this.physics.resolveSpawnOverlap) this.physics.resolveSpawnOverlap(p.id); // seam D3: don't materialise inside anyone
        }
        // HITBOX ACCURACY: keep a disguised player's shot sensor oriented to its visible facing
        // (dispYaw, advanced above by updateDisguiseRotation) so a rotated box is hit at its
        // true corners. No-op for round/undisguised sensors.
        if (p.disguise && this.physics.setShotColliderYaw) this.physics.setShotColliderYaw(p.id, p.dispYaw);
        // Part 1 (2026-07-13): the MOVEMENT collider is now the disguise's true prop shape, so
        // it must also track the visible facing — a rotated table must COLLIDE rotated. Twin of
        // the shot-sensor yaw above. No-op for round/undisguised (symmetric) colliders.
        if (p.disguise && this.physics.setPlayerColliderYaw) this.physics.setPlayerColliderYaw(p.id, p.dispYaw);
        const frozen = p.role === ROLE.HUNTER && this.phase === PHASE.HIDING;
        this.physics.setPlayerInput(
          p.id,
          frozen
            ? { mx: 0, mz: 0, yaw: p.yaw, jump: false }
            : { mx: p.input.mx, mz: p.input.mz, yaw: p.yaw, jump: p.input.jump }
        );
      }
      this.physics.step(dt);
      // Arena-edge backstop clamp — derived from the WALL geometry, NOT rules.mapMargin.
      // The old bound (size/2 − mapMargin = wall face − 1.0) sat 0.58 m IN FRONT of where
      // the walls actually let a capsule stand (size/2 − WALL_INSET − playerRadius), so it
      // clamped the broadcast position of anyone hugging a wall while their physics body
      // stayed put — and if a body ever ended up OUTSIDE the walls, the clamp pinned its
      // broadcast at the wall forever while the real body roamed the ground-slab apron:
      // the reported "glitched mode" (run the perimeter, get snapped back wall-ward every
      // snapshot when trying to leave). Now the clamp sits just BEHIND the legal standing
      // range (a true backstop that never bites in normal play), and the failsafe below
      // actively recovers any body that escapes the arena. (pass #5)
      const pRadius = this.rules.playerRadius != null ? this.rules.playerRadius : 0.4;
      const wallBound = map.size / 2 - WALL_INSET - pRadius;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const t = this.physics.getPlayer(p.id);
        if (t) {
          p.pos.x = clamp(t.x, -wallBound, wallBound);
          p.pos.y = t.y;
          p.pos.z = clamp(t.z, -wallBound, wallBound);
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
        // OUT-OF-ARENA line (pass #5): the boundary walls' inner face. A capsule whose
        // CENTRE is past it is at least half-embedded in (or beyond) a wall — never a
        // legal state, since legal wall-hugging stops a radius short of the face. The
        // ground slab extends 2 m past the walls, so an escaped body does NOT fall (the
        // below-floor check never fires for it) — it walks the apron in "glitched mode"
        // forever unless recovered here.
        const innerFace = map.size / 2 - WALL_INSET;
        // Players the depenetration escape hatch flagged as wedged beyond recovery
        // (snap-to-anchor failing for ~0.33 s straight — a poisoned anchor).
        //
        // WEDGED-RESPAWN DISABLED 2026-07-16 (requested by VRmike) — DIAGNOSTIC EXPERIMENT.
        // VRmike still hits the "locked at spawn, move a little, snap back" loop. Hypothesis:
        // the wedged flag is a FALSE POSITIVE for disguised players — _isPenetrating (shared/
        // physics.js) tests a bounding-capsule PROXY that can be fatter than the real disguise
        // collider, so a player with nothing actually colliding gets flagged wedged and then
        // teleported to spawn every ~0.5 s → infinite lock loop. We are turning the wedged
        // TELEPORT off to confirm the theory. We STILL drain the flag (consumeStuckPlayers,
        // below) so the set can't accumulate, and we STILL console.warn the flagged id(s) so
        // the evidence keeps arriving in the host console while the teleport is suppressed.
        // The fell-through-floor and out-of-arena recoveries below are UNCHANGED and remain
        // fully live — only the `stuck` respawn path is disabled.
        const stuckIds = this.physics.consumeStuckPlayers ? this.physics.consumeStuckPlayers() : [];
        let fellPlayers = 0, escapedPlayers = 0;
        for (const p of this.players.values()) {
          if (!p.alive || !p.spawn) continue;
          const t = this.physics.getPlayer(p.id); // TRUE body pose (p.pos is clamped)
          const fell = (p.pos.y || 0) + capsuleH < floorTop - 2;
          const escaped = t && (Math.abs(t.x) > innerFace || Math.abs(t.z) > innerFace);
          if (!fell && !escaped) continue; // wedged (`stuck`) intentionally NOT recovered — see note above
          p.pos = { x: p.spawn.x, y: 0, z: p.spawn.z };
          this.physics.setPlayerPosition(p.id, p.pos);
          if (fell) fellPlayers++;
          else escapedPlayers++;
        }
        // Wedged respawn is suppressed (2026-07-16, VRmike diagnostic): report the flagged
        // id(s) so the host console still sees the evidence, but do NOT teleport them.
        if (stuckIds.length > 0) {
          console.warn(
            `[physics] WEDGED respawn SUPPRESSED (disabled 2026-07-16 for diagnosis, suspected disguise-proxy false positive): player(s) [${stuckIds.join(', ')}] were flagged wedged on map "${this.mapId}" but were NOT teleported to spawn.`
          );
        }
        const fellProps = this.physics.respawnEscaped(floorTop - 2);
        // LOG when the last-resort net fires (solidity pass #3): after this pass it should
        // basically never trigger, so a line here means we hear about a tunnelling/fall-
        // through regression from the console before players report it. Kept as the net —
        // logging it doesn't weaken the recovery, it just makes a silent failure loud.
        if (fellPlayers > 0 || escapedPlayers > 0 || fellProps > 0) {
          console.warn(
            `[physics] failsafe recovered ${fellPlayers} fallen, ${escapedPlayers} out-of-arena player(s) + ${fellProps} prop(s) on map "${this.mapId}". This should be rare — a repeat means a real collision regression.`
          );
        }
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

  // Broadcast a PUBLIC log line to EVERY player's kill/event feed. Used for team switches and
  // mid-round joins (S2C.EVENT kind:'log' → js/main.js onEvent → ui.feed). Not a game-state change.
  broadcastLog(text) {
    this.broadcast({ t: S2C.EVENT, kind: 'log', text });
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
      // HUNTER-TOOLS v1: 0..100 % health (HUD for self; visible to all — no secret).
      health: round2(p.health != null ? p.health : this._startHealth()),
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
      // HELD-TOOL VISIBILITY (B7): the hunter's selected held item, so everyone renders the
      // right thing in their hands. Only meaningful for hunters (null otherwise). Coerced to a
      // valid id so a never-set/garbage value can't reach the renderer as an unknown tool.
      tool: p.role === ROLE.HUNTER ? (HUNTER_TOOL_IDS.includes(p.tool) ? p.tool : 'rifle') : null,
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
    //
    // DISGUISE-INFO LEAK FIX (2026-07-17, VRmike). The pause-menu roster used to reveal what every
    // prop is disguised as (e.g. "VRmike — burger") to EVERYONE, incl. hunters — a trivial cheat. The
    // render-facing `disguise` field MUST stay for hunters (a prop disguised as a burger has to render
    // AS a burger on the hunter's screen — that IS the game), so we can't strip it. What we CAN strip,
    // host-side, is the ROSTER IDENTITY LABEL: for a hunter recipient we blank the `name` on every
    // DISGUISED prop entry (hunterSafeSnapshot), so a hunter's data never pairs a real player NAME with
    // a disguise — the render shape stays byte-for-byte intact, but "which burger is a person" is gone.
    // Undisguised props + hunters keep their names. During HIDING the blindfold already withholds ALL
    // prop entries, so the leak can't happen there; this covers HUNTING (and any non-blind hunter view).
    //
    // SPECTATOR WITHHOLDING (B6, 2026-07-18, VRmike). A dead player is a spectator with a fly cam and
    // player-switching, and a dead teammate can still TALK to living hunters on voice. So a dead
    // spectator watching props scatter during HIDING is the exact anti-cheat leak the blindfold
    // guards. The rule therefore keys on DEAD-OR-HUNTER + phase, not team: during HIDING every
    // spectator (dead, any team) is withheld all prop transforms via the SAME blindHunterSnapshot
    // path as a blindfolded hunter, and gets the same one-time `kind:'world'` catch-up at HUNTING
    // (see setPhase). From HUNTING onward a spectator sees everything — including disguised props'
    // names — because they're a dead teammate on voice anyway and that's normal prop-hunt
    // spectating (so a dead hunter falls through to the FULL feed, not the name-blanked hunterView).
    // Living hunters/props are byte-identical to before. See memory/notes/anti-cheat-blindfold.md.
    let blinded = null, hunterView = null;
    for (const p of this.players.values()) {
      if (this.phase === PHASE.HIDING && (p.role === ROLE.HUNTER || !p.alive)) {
        // Blindfolded hunter OR any dead spectator during HIDING: withhold every prop position.
        if (!blinded) blinded = blindHunterSnapshot(full);
        send(p, blinded);
      } else if (p.role === ROLE.HUNTER && p.alive) {
        // Living hunter during HUNTING: roster-safe (disguised props keep their shape, lose their name).
        if (!hunterView) hunterView = hunterSafeSnapshot(full);
        send(p, hunterView);
      } else {
        // Living props, and any dead spectator during HUNTING: the full feed (fly cam sees the world).
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
  //
  // BLINDFOLD GATE (anti-cheat). A hunter who joins DURING the HIDING phase is
  // blindfolded — they must NOT learn where props have been shoved. Pass blind=true
  // and they get the SPAWN-form list (factory-fresh map) instead of the live world;
  // the moment HIDING flips to HUNTING they receive the full world snapshot as their
  // legitimate catch-up (setPhase → kind:'world'). This rides the SAME door the
  // blindfold's snapshot half already guards — extend it, never bypass it.
  _propsCatchup(blind = false) {
    if (blind || !this.physics) return this.props;
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

// Hunter-safe snapshot (DISGUISE-INFO LEAK FIX, HUNTING phase) — the roster half of the anti-cheat.
// Keeps EVERY field the renderer needs (each prop's `disguise` shape/appearance is preserved byte-for-
// byte, so disguised props still draw AS their disguise on the hunter's screen), but BLANKS the `name`
// on every disguised prop entry so a hunter's data can't tie a real player NAME to a disguise (the
// pause-menu roster leak). Undisguised props and hunters keep their names. Pure, so the offline guard
// (tools/check-team-flip.mjs) can assert BOTH halves: zero name↔disguise labels AND intact render shapes.
export function hunterSafeSnapshot(full) {
  return {
    ...full,
    players: full.players.map((pl) => (!pl.hunter && pl.disguise ? { ...pl, name: null } : pl)),
  };
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
// 3D distance between two {x,y,z} points — grenade blast falloff is spherical (a prop 1 m away
// in any direction is at full damage), so distance is measured in all three axes.
const dist3 = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
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
