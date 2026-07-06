# Lobby map selection

Added 2026-07. The lobby host picks which map is played; guests see the same list
read-only. Groundwork for multiple maps — there is only `circus_lot` today, so the
default (first map in the file) means the feature is invisible until a second map
is added to `maps.json`.

## The one-road principle

The whole design exists to keep the selected map id in exactly ONE place at a time
and moving down exactly ONE channel. Two copies of "which map" is the classic
source of "the host built map A, a guest built map B, props don't line up" bugs.

- **Referee holds it:** `referee.mapId` (defaults to `Object.keys(maps)[0]`).
  Already consumed by `beginRound` (props/spawns/hunterSpawn) and `integrate`
  (bounds). Nothing new had to read it.
- **One carrier to clients:** `S2C.LOBBY.mapId`, sent by `broadcastLobby`. Clients
  store it in `state.selectedMapId` (`main.js`, on every LOBBY). `S2C.STARTED`
  intentionally dropped its old `mapId` field — the client builds its scene from
  the remembered lobby id instead. Because the data channel is reliable + ordered
  (and the host's is a synchronous loopback), the latest LOBBY always lands before
  STARTED, so the remembered id is current at match start.

## Who is the host

The referee used to infer the host as "first player added". Now the network layer
tells it explicitly: `net.js` `_becomeHost` adds its loopback player with
`host: true`, and `referee.addPlayer` sets `hostId` from that flag (falling back to
first-added if no flag is passed, preserving old behaviour). Guests never carry the
flag — they only ever arrive over data channels. This flag is the single source of
truth for host-only actions (pick map + start).

## The gates (referee is the truth)

`C2S.PICK_MAP {mapId}` is accepted only if ALL hold, else silently dropped:
1. `player.id === hostId` — only the host.
2. `phase === LOBBY` — a click mid-round is ignored (mirrors START re-validating).
3. `maps[mapId]` exists — no picking a map that isn't in the file.

So a guest forging the message in dev tools, or a stale click after the round
started, changes nothing. The buttons are a convenience; the referee decides.

## UI

`ui.renderMaps(selectedMapId, isHost)` (called from `renderLobby`) lists every map
from the catalog set once at boot via `ui.setMaps(cfg.maps)`. Each row shows name +
`size×size`, the selected one gets a `selected` class (✓). Host rows are clickable;
guest rows get `locked` (no hover/pointer, click short-circuited in `main.js`). The
click handler is event-delegated on `#mapList` because rows re-render each lobby
update. Markup: `.maps-panel` in `index.html`; styles in `style.css`
(`.map-row`/`.map-row.selected`/`.map-row.locked`).

## To add a real second map

Just add another entry to `shared/config/maps.json` (same shape: size, ground/sky,
hunterSpawn, spawns, props with stable ids). No engine/UI change — the list, the
picker, and the referee all read the file. That was the point of doing this now.

## Related rename

"Start match" button → "Start game" (`index.html`), same session. No behaviour
change.
