# game loop & rules

Everything here is referee-owned in `shared/referee.js`, which since the P2P
rebuild runs in the **host's browser** (it was ported from the old
`server/Room.js`, now deleted). The rules below are unchanged by that move —
only where the code runs changed. Tunables are in `shared/config/rules.json` —
change data, not code.

## Phases (state machine)
`LOBBY → HIDING → HUNTING → ENDING → LOBBY`, driven by `phaseEndsAt` timestamps
checked each tick.

- **LOBBY**: no simulation. Host `start` with ≥ `minPlayers` → `startMatch`.
- **HIDING** (`hidingSeconds`): props move + disguise; hunters are frozen
  (`integrate` skips hunters this phase). → HUNTING.
- **HUNTING** (`huntingSeconds`): hunters move + tag. Ends early if all props
  eliminated (hunters win); ends on timer with any prop alive (props win).
- **ENDING** (`endingSeconds`): result shown → `resetToLobby`.

`setPhase(phase, seconds)` sets the timer and broadcasts an `event{kind:'phase'}`.

## Map selection (lobby)
The host picks the map before starting via `C2S.PICK_MAP{mapId}` →
`Referee.setMapId(id, byId)`, the single validation gate (host-only, LOBBY-only,
must exist). Stored in `this.mapId` and echoed in every `S2C.LOBBY` (so late
joiners see it). `startMatch`/`integrate` read `this.mapId` without re-validating.
Full detail in `memory/notes/map-selection.md`.

## startMatch
1. Guard: LOBBY + ≥ minPlayers.
2. Build authoritative prop instances from `maps[this.mapId].props` (assign ids) —
   `this.mapId` is the host's lobby pick, trusted (validated at pick time).
3. Shuffle players; `hunterCount = max(1, round(n * hunterRatio))`. First N are
   hunters (spawn at `map.hunterSpawn`), rest are props (round-robin
   `map.spawns`). Send each a private `role`.
4. Broadcast `started{mapId, props}`; `setPhase(HIDING)`.

## Disguise (`applyDisguise`)
Prop only, alive, phase HIDING/HUNTING, target prop within `disguiseRange` of the
player. Sets `player.disguise = prop.type` (a type string, so the client just
renders that catalog shape). Client picks the *nearest* in-range prop id and
sends it.

## Tag (`applyTag`)
Hunter only, alive, phase HUNTING. Server computes the hunter's forward vector
from `yaw`, then finds alive prop players within `tagRange` and inside the
`tagAngleDeg` aim cone; the nearest one is eliminated.
Miss → private `event{kind:'miss'}`. Hit → broadcast `eliminated` +
`checkRoundOver`. NOTE: tag currently checks all alive props regardless of
whether they've disguised — an undisguised prop can still be tagged. Fine for
skeleton; revisit alongside the "undisguised props are visible" gap.

## Win / reset
`checkRoundOver`: if props existed and none are alive → hunters win → ENDING.
Hunt-timer expiry in `tick` → props win → ENDING. `resetToLobby` clears roles /
alive / disguise / ready and broadcasts `lobby{phase:'lobby'}` (how clients know
to show the lobby screen again). **It deliberately does NOT reset `this.mapId`** —
the map is a lobby setting, not per-player state, so the pick survives a
reset-to-lobby (documented carve-out; see map-selection.md).

## Extending (intended seams)
- New map: add to `maps.json`. New prop type: add to `props.json` + reference it
  in a map. No engine edits. (The lobby map picker renders new maps automatically.)
- New abilities/rules: add fields to `rules.json`, read them in `Room`.
- Map selection: DONE — `Referee.setMapId()` + `C2S.PICK_MAP` + lobby picker. See
  `memory/notes/map-selection.md`.
