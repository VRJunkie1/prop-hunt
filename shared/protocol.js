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
  //   kind:'taunt'      { by, id, uncancellable } -> play taunt clip `id` as 3D positional
  //                     audio at player `by`'s live position for everyone. A new taunt from the
  //                     same `by` cuts off their previous one (one voice per prop; different
  //                     props overlap). `uncancellable`=true marks a prop-finder-forced taunt
  //                     the taunter's stop button can't kill.
  //   kind:'tauntStop'  { by } -> stop player `by`'s currently-playing taunt for everyone.
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
