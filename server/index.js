// OBSOLETE — kept only as a tombstone. Physically delete this whole `server/`
// directory when a shell is available (`git rm -r server/`). This environment
// has no file-deletion tool, so past sessions (and this one) could not remove it.
//
// The Node matchmaker that used to live here is GONE. Peer introduction (room
// codes + WebRTC handshake relay) is now done by PeerJS's free public broker,
// wired up entirely client-side in client/js/net.js. The app is fully static and
// deploys to Cloudflare Pages with no backend of ours.
//
// Nothing imports or runs this file. It no longer even parses against the
// current protocol (the SIG message set it relied on was deleted from
// shared/protocol.js). See memory/architecture.md.
export {};
