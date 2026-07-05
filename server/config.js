// OBSOLETE — kept only as a tombstone. Physically delete this file when a shell
// is available (`git rm server/config.js`).
//
// The matchmaker (server/index.js) no longer loads game config — it holds no
// game state. The referee now runs in the browser and gets its config from the
// client, which already fetches shared/config via client/js/config.js.
// Nothing imports this file. See memory/architecture.md.
export {};
