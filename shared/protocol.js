// Shared message protocol.
// Imported by the Node matchmaker (../shared/protocol.js) and by the browser
// client (served at /shared/protocol.js). Keep it dependency-free ESM so both
// runtimes can load it unchanged.
//
// Two separate protocols live here since the P2P rebuild:
//   - SIG: client <-> matchmaker over WebSocket. Room codes + WebRTC handshake
//     relay only. The matchmaker never sees a game message.
//   - C2S/S2C: client <-> referee. Unchanged by the rebuild — they used to ride
//     a WebSocket to a server-side referee; now they ride an RTCDataChannel to
//     the host's in-browser referee (or a local loopback for the host itself).
//     The referee speaks exactly the same language regardless of transport.

// ---- Signaling: client <-> matchmaker (WebSocket) -------------------------
export const SIG = {
  // Client -> matchmaker
  CREATE: 'sig-create', // { name }              -> make a room, become its host
  JOIN: 'sig-join', // { name, room }        -> ask to join; matchmaker links you to the host
  RELAY: 'sig-relay', // { to, payload }       -> pass a WebRTC handshake blob to peer `to`
  // Matchmaker -> client
  CREATED: 'sig-created', // { room, id }          -> you are host; `id` is your peer/player id
  JOINED: 'sig-joined', // { room, id, hostId }  -> you may now offer/answer to `hostId`
  PEER_JOIN: 'sig-peer-join', // { id, name }          -> (to host) a new peer wants to connect
  PEER_LEFT: 'sig-peer-left', // { id }                -> a peer's signaling socket dropped
  HOST_LEFT: 'sig-host-left', // {}                    -> the host is gone; the room is dead
  ERROR: 'sig-error', // { msg }
};

// Client -> Referee message types (over DataChannel to the host, or loopback).
export const C2S = {
  CREATE: 'create', // { name }                     -> create a room, become host
  JOIN: 'join', // { name, room }               -> join an existing room
  PICK_TEAM: 'pickTeam', // { team:'hunter'|'prop'|null }  -> choose a lobby team (replaces ready)
  START: 'start', // {}                            -> host starts the match
  INPUT: 'input', // { mx, mz, yaw, pitch, jump, crouch } -> movement + look + jump/crouch intent
  DISGUISE: 'disguise', // { propId }                    -> prop takes an object's shape
  TAG: 'tag', // {}                            -> hunter attempts a tag
};

// Referee -> Client message types.
export const S2C = {
  JOINED: 'joined', // { id, room, host }
  LOBBY: 'lobby', // { room, hostId, canStart, players:[{id,name,team}] }
  STARTED: 'started', // { mapId, props:[{id,type,x,z,rot}] }
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
