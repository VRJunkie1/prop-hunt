# lobby map selection

The host chooses which map the next round is played on, from the lobby, before
starting. Data-driven: the picker renders straight from `shared/config/maps.json`,
so adding a map needs **zero code** (just a new entry in that file).

## Where it lives (one gate, one source of truth)
- **`Referee.mapId`** (`shared/referee.js`) is the single source of truth. It
  defaults to the first map in `maps.json` (`DEFAULT_MAP_ID`) and is changed ONLY
  through `setMapId(id, byId)`.
- **`Referee.setMapId(id, byId)`** is the ONE validation gate. All rails live here
  and nothing downstream re-checks:
  - only the host (`byId === this.hostId`),
  - only during `PHASE.LOBBY`,
  - only an `id` that exists in `this.maps`.
  On success it stores `this.mapId` and calls `broadcastLobby()`. A tampered
  client can send anything; if it fails a rail, nothing changes.
- Once stored, `this.mapId` is **trusted** by `startMatch` (builds props from
  `maps[mapId]`, broadcasts `started{mapId}`) and `integrate` (map bounds). They
  do NOT re-validate — so the pick-time check and the round-start read can't drift.

## The wire (mirrors team/ready picking)
- New client→referee message: **`C2S.PICK_MAP { mapId }`** (`shared/protocol.js`).
  The host's client sends it exactly like `READY`/`START` ride the peer link.
  Both sender (`js/main.js`) and receiver (`shared/referee.js`) reference the same
  shared `C2S.PICK_MAP` constant, so the "channel" name can't drift between them.
- `broadcastLobby()` now includes **`mapId`** in the `S2C.LOBBY` payload, so every
  lobby screen — including a **late joiner** — shows the host's current pick.

## The UI is dumb on purpose (house rule: no game logic in the DOM)
- `js/ui.js` `renderMapPicker(mapId, isHost)` renders one button per map from
  `this.maps` (the shared catalog, injected by `main.js` at boot), highlights the
  selected id (`.selected`), and emits `onPickMap(id)` on tap.
- Non-hosts get their buttons `disabled` — **cosmetic only**. Enforcement is the
  referee, never the UI. A tapped map does NOT change local state; the choice
  comes back authoritatively in the next `S2C.LOBBY`.
- Buttons are ≥48px tall (touch-friendly — friends join on phones). CSS:
  `.map-list` / `.map-btn` in `css/style.css`.

## Deliberate carve-out: reset-to-lobby keeps the pick
`resetToLobby()` clears per-player round state (roles/alive/disguise/ready) but
**does NOT reset `this.mapId`** — a map is a lobby *setting*, not per-player state,
so the last-picked map stays selected for the next round. This is a documented
exception to "fresh lobby", not a silent branch.

## Maps present
`circus_lot` (default), `toy_workshop`, and `restaurant`. The first two reference
only existing prop types from `props.json`. `restaurant` added new restaurant-
themed prop types AND introduced the optional `map.fixtures[]` array (static world
pieces, separate from the disguise `props`) — one small `js/scene.js` change; see
`restaurant-map.md`. Picker still renders every map in `maps.json` automatically.

## History (why this was a "finish", not a "start")
An earlier map-selection build happened on the `jie/dev` branch (commits
"The lobby host should be able to see a list of available maps to play" + several
"BUILD IT"). The active branch later became `vrmike/dev`, which was cut from a
point *before* that work — so the partial build was stranded on `jie/dev` and the
working tree looked like map selection had never been started ("broke it by
renaming the channel" = the branch switch). This session reimplemented the feature
cleanly on `vrmike/dev` against the seam the notes already named. If you ever pull
`jie/dev` back, diff it against this — don't blindly merge; this version is the
intended one.
