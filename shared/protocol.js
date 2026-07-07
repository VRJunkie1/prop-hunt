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
  START: 'start', // {}                            -> host starts the match
  PICK_MAP: 'pickMap', // { mapId }                     -> host chooses the lobby map (host-only; referee is the gate)
  INPUT: 'input', // { mx, mz, yaw, pitch }        -> movement + look intent
  DISGUISE: 'disguise', // { propId }                    -> prop takes an object's shape
  TAG: 'tag', // {}                            -> hunter attempts a tag
};

// Referee -> Client message types.
export const S2C = {
  JOINED: 'joined', // { id, room, host }
  LOBBY: 'lobby', // { room, hostId, players:[{id,name,ready}], phase, mapId, result:{winner}|null }
  STARTED: 'started', // { mapId, props:[{id,type,x,z,rot}] }
  ROLE: 'role', // { role }                     -> your secret role for the round
  SNAPSHOT: 'snapshot', // authoritative world state (see Room.buildSnapshot)
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
