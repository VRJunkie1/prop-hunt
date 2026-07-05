// Shared message protocol between client and server.
// Imported by the Node server (../shared/protocol.js) and by the browser
// client (served at /shared/protocol.js). Keep it dependency-free ESM so both
// runtimes can load it unchanged.

// Client -> Server message types.
export const C2S = {
  CREATE: 'create', // { name }                     -> create a room, become host
  JOIN: 'join', // { name, room }               -> join an existing room
  READY: 'ready', // { ready }                     -> toggle ready in lobby
  START: 'start', // {}                            -> host starts the match
  INPUT: 'input', // { mx, mz, yaw, pitch }        -> movement + look intent
  DISGUISE: 'disguise', // { propId }                    -> prop takes an object's shape
  TAG: 'tag', // {}                            -> hunter attempts a tag
};

// Server -> Client message types.
export const S2C = {
  JOINED: 'joined', // { id, room, host }
  LOBBY: 'lobby', // { room, hostId, players:[{id,name,ready}] }
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
