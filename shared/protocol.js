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
  INPUT: 'input', // { seq, mx, mz, yaw, pitch, jump, rotUnlock } -> movement + look intent
  //   seq: monotonic per-client input id, echoed back as `ack` in each player's
  //        snapshot entry so a guest can reconcile/replay unacked inputs.
  //   jump: rising-edge jump request (physics: only when grounded).
  //   rotUnlock: right-click held — a disguised prop may rotate on yaw (never tips);
  //              otherwise a disguise keeps its locked orientation while moving.
  DISGUISE: 'disguise', // { propId }                    -> prop takes an object's shape
  TAG: 'tag', // {}                            -> hunter attempts a tag
};

// Referee -> Client message types.
export const S2C = {
  JOINED: 'joined', // { id, room, host }
  LOBBY: 'lobby', // { room, hostId, players:[{id,name,ready}], phase, mapId, result:{winner}|null }
  STARTED: 'started', // { mapId, props:[{id,type,x,y,z,rot}] }
  ROLE: 'role', // { role }                     -> your secret role for the round
  SNAPSHOT: 'snapshot', // authoritative world state. players:[{id,name,x,y,z,yaw,alive,
  //   hunter,disguise,ack}] + awake dynamic-prop transforms props:[{id,x,y,z,qx,qy,qz,qw}]
  //   (sleeping props omitted — they haven't moved). `ack` = last INPUT.seq the host
  //   consumed from that player, for client reconciliation.
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
