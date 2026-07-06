// Shared message protocol between the browser client and the in-browser referee.
// Dependency-free ESM, loaded by the client (served at /shared/protocol.js) and
// by the referee (shared/referee.js) — same file, one language.
//
// Only ONE protocol lives here: C2S/S2C, client <-> referee. It used to ride a
// WebSocket to a server-side referee; now it rides a PeerJS DataConnection to
// the host's in-browser referee (or a local loopback for the host itself). The
// referee speaks exactly the same language regardless of transport.
//
// The old SIG (client <-> matchmaker) protocol is gone: PeerJS's public broker
// now does the room-code + WebRTC handshake introduction, so there is no
// signaling protocol of our own to define. See client/js/net.js.

// Client -> Referee message types (over the PeerJS DataConnection, or loopback).
export const C2S = {
  PICK_TEAM: 'pickTeam', // { team:'hunter'|'prop'|null }  -> choose a lobby team (replaces ready)
  PICK_MAP: 'pickMap', // { mapId }                     -> host chooses which map to play (host + lobby only)
  START: 'start', // {}                            -> host starts the match
  INPUT: 'input', // { mx, mz, yaw, pitch, jump, crouch } -> movement + look + jump/crouch intent
  DISGUISE: 'disguise', // { propId }                    -> prop takes an object's shape
  TAG: 'tag', // {}                            -> hunter attempts a tag
};

// Referee -> Client message types.
export const S2C = {
  JOINED: 'joined', // { id, room, host }
  LOBBY: 'lobby', // { room, hostId, phase, canStart, mapId, players:[{id,name,team}] }
  //   mapId is the SOLE carrier of the selected map — the client remembers the
  //   latest one it sees here and builds its scene from it at match start.
  STARTED: 'started', // { props:[{id,type,x,z,rot}] }  (map comes from the remembered LOBBY mapId)
  ROLE: 'role', // { role }                     -> your secret role for the round
  SNAPSHOT: 'snapshot', // authoritative world state (see Referee.broadcastSnapshot)
  EVENT: 'event', // { kind, ... }               -> discrete game events
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
