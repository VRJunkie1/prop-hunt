// Shared message protocol.
// Imported by the browser client only (served at /shared/protocol.js). Keep it
// dependency-free ESM.
//
// Since the static-Pages fix there is ONE protocol here: C2S/S2C between the
// client and the referee. It rides a PeerJS DataConnection to the host's
// in-browser referee (or a local loopback for the host itself); the referee
// speaks the same language regardless of transport. (Signaling used to be a
// separate `SIG` protocol to a Node matchmaker — that matchmaker is gone; PeerJS
// and its own connect/disconnect events handle the handshake now.)

// Client -> Referee message types (over the DataConnection to the host, or loopback).
export const C2S = {
  READY: 'ready', // { ready }                     -> toggle ready in lobby
  // Change your OWN lobby display name. { name }. Any player (host or an invite-link
  // guest) may rename only themselves; the HOST is the authority — it trims/caps/rejects
  // -empty/de-dupes the name (referee.applyRename), updates the shared roster, and
  // rebroadcasts S2C.LOBBY so every peer's lobby list updates live. LOBBY-only: a rename
  // during a live round is ignored (keeps scoreboards / "who tagged whom" stable).
  RENAME: 'rename', // { name }                    -> rename yourself in the lobby
  START: 'start', // {}                            -> host starts the match
  PICK_MAP: 'pickMap', // { mapId }                     -> host chooses the lobby map (host-only; referee is the gate)
  INPUT: 'input', // { seq, mx, mz, yaw, pitch, jump, rotUnlock } -> movement + look intent
  //   seq: monotonic per-client input id, echoed back as `ack` in each player's
  //        snapshot entry so a guest can reconcile/replay unacked inputs.
  //   jump: rising-edge jump request (physics: only when grounded).
  //   rotUnlock: right-click held — a disguised prop may rotate on yaw (never tips);
  //              otherwise a disguise keeps its locked orientation while moving.
  DISGUISE: 'disguise', // { propId }                    -> prop takes an object's shape
  // AUDIO TAUNTS (props only). A prop asks the host to play a taunt clip as DIRECTIONAL 3D
  // audio at its own position for EVERYONE (hunters locate props by ear — taunting is a
  // self-snitch by design). The host validates (sender is a LIVING PROP in an active phase,
  // the taunt id exists in the manifest) then relays S2C.EVENT kind:'taunt' tagged with who
  // taunted; each client plays the clip positionally at that prop's live position. Same
  // host-authoritative relay pattern as SHOOT. The cut-off rule (a new taunt from the same
  // player replaces their previous one) is per-emitter on each client — the referee just relays.
  TAUNT: 'taunt', // { id }
  // Stop your OWN currently-playing taunt for everyone. The host relays S2C.EVENT
  // kind:'tauntStop' tagged with the sender — UNLESS that taunt was forced uncancellable by
  // the (future) prop-finder tool (referee.forceTaunt), in which case the stop is ignored.
  STOP_TAUNT: 'stopTaunt', // {}
  TAG: 'tag', // {}                            -> hunter attempts a tag (legacy melee; the rifle replaces it)
  // HUNTER-TOOLS v1 — fire the assault rifle. { dx, dy, dz } = the shooter's camera-forward
  // aim direction (the SAME screen-centre ray the disguise pick uses). The host is the
  // authority: it re-runs the shot against its own physics world from the shooter's
  // authoritative eye, decides what was hit, applies damage, and broadcasts the tracer
  // (S2C.EVENT kind:'shot'). Trusting only the AIM direction (not any claimed hit) is not a
  // cheat vector — a player can always aim where they like; the host validates the WORLD.
  SHOOT: 'shoot', // { dx, dy, dz }
  // PROP FINDER (hunter tool #2). Activate the finder: no payload — the host knows the
  // hunter's authoritative position, radius, and PER-HUNTER cooldown, so it decides
  // everything. The host validates (sender is a LIVING HUNTER in HUNTING, off cooldown),
  // then forces a RANDOM UNCANCELLABLE taunt out of EVERY living prop within rules.finderRadius
  // (2D distance — the AOE cylinder is effectively infinite in height, so height is ignored)
  // via referee.forceTaunt, and replies S2C.EVENT kind:'find' to the acting hunter with the
  // authoritative cooldown (ok:true) or the remaining cooldown (ok:false, so a click during
  // cooldown is a host-confirmed denial → the client's short denied buzz). The cooldown is
  // enforced host-side so a hacked client can't skip it. See shared/referee.js applyFind.
  FIND: 'find', // {}
  // HUNTER GRENADES (hunter tool #3). Throw a grenade: { dx, dy, dz } = the shooter's
  // camera-forward aim direction (the SAME ray SHOOT sends). The client NEVER sends a hit
  // point — the HOST is the authority: it raycasts that aim through its own world (reusing the
  // rifle's shot raycast), explodes INSTANTLY at the first hit (no arc/travel/fuse), and
  // resolves all damage. So a hacked client can aim anywhere (legal) but can never move the
  // blast to fake a kill or dodge the backfire. NO COOLDOWN (grenades are balanced by risk).
  // Damage vs distance from the blast centre falls off (full within fullDamageRadius, ~0 at
  // fullDamageRadius+falloffDistance): prop PLAYERS take baseDamage×size-multiplier×falloff;
  // the THROWING hunter takes backfire (flat baseDamage×falloff, no size mult) through
  // non-player DECOY props only — never other hunters, never direct self-damage. If the blast
  // kills a prop player the thrower is REDEEMED to full HP. See shared/referee.js applyGrenade.
  GRENADE: 'grenade', // { dx, dy, dz }
  // PAUSE-MENU TEAM SWITCH (2026-07-17, VRmike). No payload — the host knows the sender's current
  // team. The host respawns the sender as a FRESH player on the OPPOSITE team (prop→hunter or
  // hunter→prop): full HP, no disguise (a new disguise if they become a prop and re-disguise),
  // fresh tools. Host-authoritative; active-round only (HIDING/HUNTING). NO cooldown / anti-abuse
  // (accepted per VRmike — it's an intentional, abusable-for-laughs feature). The host broadcasts a
  // PUBLIC log line everyone sees (S2C.EVENT kind:'log'). See shared/referee.js applySwitchTeam.
  SWITCH_TEAM: 'switchTeam', // {}
  // DEBUG family (?debug=1 only). A host-authoritative developer command routed like any
  // other C2S message. The referee DROPS every DEBUG message unless the HOST itself loaded
  // with ?debug=1 (referee.debugEnabled), so a tampered guest can't inject debug commands
  // into a normal match. Payloads:
  //   { action:'team', role:'hunter'|'prop' } -> switch the sender's team
  //   { action:'reset' }                      -> host restarts the round
  //   { action:'morph', type:'<catalogType>' }-> force-disguise the sender (bypasses range)
  // See js/debug.js + shared/referee.js handleDebug. NOT part of normal play.
  DEBUG: 'debug',
};

// Referee -> Client message types.
export const S2C = {
  JOINED: 'joined', // { id, room, host }
  LOBBY: 'lobby', // { room, hostId, players:[{id,name,ready}], phase, mapId, result:{winner}|null }
  STARTED: 'started', // { mapId, props:[ propEntry ] }
  //   propEntry = every DYNAMIC object (disguise-pool props + knockable fixtures):
  //     { id, type, disguisable, x, y, z, rot }              (spawn: x/z floor pos, y surface offset)
  //   OR, for a MID-ROUND joiner catching up to a knocked-about world (fix #8):
  //     { id, type, disguisable, x, y, z, qx, qy, qz, qw }   (live: x/y/z body centre + quaternion)
  //   `disguisable:false` = a knockable fixture (table/dish/food) — solid + shovable
  //   but never wearable. Presence of `qx` marks the live-transform form.
  ROLE: 'role', // { role }                     -> your secret role for the round
  SNAPSHOT: 'snapshot', // authoritative world state. players:[{id,name,x,y,z,yaw,alive,
  //   hunter,disguise,health,ack}] + awake dynamic-prop transforms props:[{id,x,y,z,qx,qy,qz,qw}]
  //   (sleeping props omitted — they haven't moved). `health` = 0..100 % (HUNTER-TOOLS v1);
  //   `ack` = last INPUT.seq the host consumed from that player, for client reconciliation.
  EVENT: 'event', // { kind, ... }               -> discrete game events
  //   kind:'shot'       { by, ox,oy,oz, ix,iy,iz, hit } -> draw muzzle flash + tracer from
  //                     the rifle muzzle (o*) to the host-confirmed impact point (i*).
  //   kind:'hurt'       { victim, by, self, dmg, health } -> a player took damage.
  //   kind:'eliminated' { by, victim, name, hunter } -> a player died (hunter=true if a hunter).
  //   kind:'roundOver'  { winner } -> ROLE.HUNTER or ROLE.PROP (props win if all hunters die).
  //   kind:'log'        { text } -> a PUBLIC log line for EVERY player's feed (a team switch or a
  //                     mid-round join, e.g. "VRmike switched to hunters" / "Sam joined the props").
  //   kind:'world'      { props:[ propEntry ] } -> a ONE-TIME full world snapshot of every dynamic
  //                     body's CURRENT transform (same live-form entries as STARTED's catch-up:
  //                     { id, x, y, z, qx, qy, qz, qw } for moved props, spawn-form for never-moved).
  //                     Handed to a HUNTER the instant they're released from the HIDING blindfold, so
  //                     they see knocked-over objects where they actually rest — never the factory-fresh
  //                     map. Rides the SAME anti-cheat gate as the blindfold (withheld until HUNTING).
  //                     The client SNAPS its rendered props + prediction colliders to it. See
  //                     shared/referee.js setPhase + js/main.js onEvent + js/scene.js applyWorldSnapshot.
  //   kind:'taunt'      { by, id, uncancellable } -> play taunt clip `id` as 3D positional
  //                     audio at player `by`'s live position for everyone. A new taunt from the
  //                     same `by` cuts off their previous one (one voice per prop; different
  //                     props overlap). `uncancellable`=true marks a prop-finder-forced taunt
  //                     the taunter's stop button can't kill.
  //   kind:'tauntStop'  { by } -> stop player `by`'s currently-playing taunt for everyone.
  //   kind:'find'       { ok, cooldownMs?, remainMs?, hits? } -> PRIVATE reply to the hunter who
  //                     activated the prop finder. ok:true  => activated; cooldownMs is the full
  //                     per-hunter cooldown just started (client shows the countdown on the tool
  //                     button) and hits = how many props were forced to taunt. ok:false => the
  //                     hunter was still cooling down; remainMs is the time left (client plays the
  //                     short denied buzz + keeps its countdown synced). The forced taunts themselves
  //                     ride the normal kind:'taunt' broadcast (uncancellable:true) to EVERYONE.
  //   kind:'grenade'    { by, x, y, z, hits, backfire, redeemed } -> a grenade exploded at the
  //                     host-computed blast centre (x,y,z). Everyone draws the explosion flash
  //                     there. hits = prop players killed; backfire = HP the thrower took from
  //                     decoy props (0 when redeemed); redeemed = a prop-player kill restored the
  //                     thrower to full HP. Per-target damage/deaths still ride the normal
  //                     kind:'hurt' / kind:'eliminated' events + the health snapshot.
  ERROR: 'error', // { msg }
};

// Game phases owned by the server.
export const PHASE = {
  LOBBY: 'lobby',
  HIDING: 'hiding',
  HUNTING: 'hunting',
  ENDING: 'ending',
};

// Player roles assigned by the server at match start.
export const ROLE = {
  PROP: 'prop',
  HUNTER: 'hunter',
};
