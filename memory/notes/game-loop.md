# game loop & rules

Everything here is referee-owned in `shared/referee.js`, which since the P2P
rebuild runs in the **host's browser** (it was ported from the old
`server/Room.js`, now deleted). The rules below are unchanged by that move —
only where the code runs changed. Tunables are in `shared/config/rules.json` —
change data, not code.

## Phases (state machine)
`LOBBY → HIDING → HUNTING → ENDING → (next round, teams swapped) → HIDING …`,
driven by `phaseEndsAt` timestamps checked each tick. **It no longer loops back
to LOBBY on its own** — see "Round loop & lobby exits" below.

- **LOBBY**: no simulation. Host `start` (validates picked teams) → `beginRound`.
- **HIDING** (`hidingSeconds`): props move + disguise; hunters are frozen
  (`integrate` skips hunters this phase) **and blindfolded** (snapshot sends them
  only themselves; client shows a black overlay). → HUNTING.
- **HUNTING** (`huntingSeconds`): hunters move + tag. Ends early if all props
  eliminated (hunters win); ends on timer with any prop alive (props win).
- **ENDING** (`endingSeconds`, ~10s scoreboard): → `nextRoundOrLobby`.

`setPhase(phase, seconds)` sets the timer and broadcasts an `event{kind:'phase'}`.

## Teams & round assignment (replaces random-by-ratio)
Players pick a team in the lobby (`C2S.PICK_TEAM`, stored as `player.team`).
- **startMatch**: guard LOBBY + ≥minPlayers + everyone picked + ≥1 per side, then
  `beginRound(hunterIds, propIds)` from the picks. (`hunterRatio` is now unused.)
- **beginRound(hunterIds, propIds)**: build prop instances; reset every player to
  clean spectator state; assign hunters (spawn `map.hunterSpawn`) and props
  (round-robin `map.spawns`); send each assigned player a private `role`;
  broadcast `started{mapId,props}`; `setPhase(HIDING)`. Ids in neither list
  spectate (role null).

## Round loop & lobby exits
- **ENDING elapses → `nextRoundOrLobby`**: `computeSwappedTeams` swaps roles
  (hunters↔props; role-null spectators fold into the smaller side), then
  `beginRound` with the swapped rosters. Players stay in-game across rounds.
- **Back to LOBBY only via `resetToLobby(reason)`**, triggered from exactly two
  spots: (1) a swap would leave a side empty (`nextRoundOrLobby`); (2) a
  disconnect empties a team mid-round (`bailIfTeamEmpty`, called from the single
  `removePlayer` path before the normal `checkRoundOver`). Host leaving is handled
  by the network layer (whole match torn down). `resetToLobby` clears
  roles/teams and broadcasts a `toLobby` event + fresh lobby.

## Disguise (`applyDisguise`) — AIM-based since 2026-07
Prop only, alive, phase HIDING/HUNTING. **You disguise as the prop you're looking
at**, not merely the nearest one. The client raycasts from the camera
(`scene.propUnderCrosshair`) and sends that prop's **stable id** (from
`maps.json`); the referee re-checks the id loosely (range + facing, NO occlusion)
and sets `player.disguise = prop.type`. See `memory/notes/disguise.md` for the
full client-strict / referee-loose split. `disguiseRange` doubles as the client's
max look distance; `disguiseAngleDeg` / `disguiseVertPad` tune the referee's
facing gate.

## Tag (`applyTag`)
Hunter only, alive, phase HUNTING. Server computes the hunter's forward vector
from `yaw`, then finds alive prop players within `tagRange` and inside the
`tagAngleDeg` aim cone; the nearest one is eliminated.
Miss → private `event{kind:'miss'}`. Hit → broadcast `eliminated` +
`checkRoundOver`. NOTE: tag currently checks all alive props regardless of
whether they've disguised — an undisguised prop can still be tagged. Fine for
skeleton; revisit alongside the "undisguised props are visible" gap.

## Jump / crouch (added 2026-07)
Held-state booleans in the INPUT message (`jump`, `crouch`), judged in
`integrate` (vertical `pos.y`/`vy` + gravity; crouch = ×`crouchSpeedMult` and a
shrunk tag hitbox). Same math duplicated in `main.js` prediction — see
architecture.md "Movement convention". Controls: Space = jump (was tag; **tag
moved to F / left-click only**), Ctrl or C = crouch, E = disguise.

## Win / reset
`checkRoundOver`: if props existed and none are alive → hunters win → ENDING.
Hunt-timer expiry in `tick` → props win → ENDING. ENDING then rolls into the next
round (swapped teams), NOT the lobby. `resetToLobby(reason)` (team-empty / not
enough players only) clears roles / alive / disguise / **team** and broadcasts a
`toLobby` event + `lobby{phase:'lobby'}` (how clients know to show the lobby
screen again).

## Extending (intended seams)
- New map: add to `maps.json`. New prop type: add to `props.json` + reference it
  in a map. No engine edits.
- New abilities/rules: add fields to `rules.json`, read them in `Room`.
- Map selection: the referee currently defaults `this.mapId` to the first map in
  `maps.json`; add a lobby setting + a `Referee.mapId` setter to choose.
