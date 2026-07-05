// OBSOLETE — kept only as a tombstone. Physically delete this file when a shell
// is available (`git rm server/Room.js`).
//
// The P2P rebuild moved the authoritative referee out of the server entirely.
// The game logic that used to live here now runs in the HOST's browser:
//   -> shared/referee.js   (the ported Room: rules, tick, phases, tags, wins)
//
// The server is now only a WebRTC matchmaker (server/index.js) with no game
// state. Nothing imports this file. See memory/architecture.md.
export {};
