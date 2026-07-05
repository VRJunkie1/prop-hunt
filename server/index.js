// TOMBSTONE — the Node matchmaker is retired.
//
// Cloudflare Pages serves static files only, so this signaling server can't run
// there. Signaling now rides PeerJS's free public broker (browser-to-browser
// handshake) — see /js/net.js. There is no server of ours anymore.
//
// This whole `server/` directory is dead. Physically remove it with
// `git rm -r server` when a shell is available. See memory/project-state.md.
