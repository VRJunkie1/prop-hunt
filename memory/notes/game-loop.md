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
  `minPlayers` is now **1** (SOLO LAUNCH): the host can start alone to walk a map,
  and friends join afterward (mid-game join, below).
- **HIDING** (`hidingSeconds`): props move + disguise; hunters are frozen
  (`integrate` skips hunters this phase). → HUNTING.
- **HUNTING** (`huntingSeconds`): hunters move + tag. Ends early if all props
  eliminated (hunters win); ends on timer with any prop alive (props win).
- **ENDING** (`endingSeconds`): result shown → `resetToLobby`.

`setPhase(phase, seconds)` sets the timer and broadcasts an `event{kind:'phase'}`.

## Solo launch & the role-count math
`startMatch` splits players into hunters/props. To keep a round meaningful there
is **always ≥ 1 prop**: `hunterCount = min(max(1, round(n*hunterRatio)), n-1)`.
For a solo start (`n === 1`) the `n-1` cap is 0 → the lone host is a **prop** and
can walk/disguise while testing a map. `checkRoundOver` never fires a hunter-win
when there are no hunters (it only ends early when props existed and all died), so
a zero-hunter round just runs on the timer and the surviving prop "wins" at expiry.

## Mid-game join (the referee's single add-player gate)
`addPlayer` is the ONE entry point for every newcomer (host loopback + each guest
DataConnection), so it's where lobby-join vs mid-round-join is decided. If the
phase is HIDING/HUNTING it calls **`admitMidGame(player)`**, which (as of
2026-07-17):
- assigns the newcomer to the team with the **FEWER players** (coin-flip on a tie —
  was "always hunter"), then spawns them FRESH via the shared `_spawnOnTeam(player,
  role)` routine (full HP, no disguise, physics body + private ROLE);
- sends the **same filtered catch-up every guest gets**: `STARTED{mapId, props}`
  (FIRST, so the client is in the running world before it hears its role), the
  private `ROLE` (from `_spawnOnTeam`), an `event{kind:'phase'}` with the current
  phase + seconds left, then the normal per-tick snapshot. Never the host's full
  state, so the role-hiding invariant holds for late joiners too;
- broadcasts a public `event{kind:'log'}` ("X joined the props/hunters").
Joins during the brief ENDING window fall to the lobby branch and just wait the
few seconds until the next round starts. The guest side needs no game logic —
`STARTED` already switches it into the running game (see `main.js`).

## Map selection (lobby)
The host picks the map before starting via `C2S.PICK_MAP{mapId}` →
`Referee.setMapId(id, byId)`, the single validation gate (host-only, LOBBY-only,
must exist). Stored in `this.mapId` and echoed in every `S2C.LOBBY` (so late
joiners see it). `startMatch`/`integrate` read `this.mapId` without re-validating.
Full detail in `memory/notes/map-selection.md`.

## startMatch → _launchRound (refactored 2026-07-17 for endless rounds)
`startMatch` now only: guard LOBBY + ≥ minPlayers; shuffle + `hunterCount =
min(max(1, round(n*hunterRatio)), n-1)` (always ≥1 prop; solo → 0 hunters) → SET
each player's `role`; then delegate to **`_launchRound()`**. `_launchRound()` is the
shared round-start flow (used by both a fresh match AND each flipped round), assuming
roles are already assigned:
1. Clear `this.lastResult` (a new round supersedes the previous result).
2. Build authoritative prop instances (hide-spot removal pass) from
   `maps[this.mapId]` — byte-identical to the old startMatch body.
3. Spawn EVERY player FRESH by their assigned role: hunters at `map.hunterSpawn`,
   props round-robin `map.spawns`; full reset (alive, full HP, no disguise, cleared
   taunt/finder). Send each a private `role`.
4. Broadcast `started{mapId, props}`; `setPhase(HIDING)`; stand up physics.

## Endless flipped rounds (2026-07-17)
A round END no longer returns to the lobby. `tick()`'s ENDING-expiry calls
**`startFlippedRound()`** (flip every player's team prop↔hunter, ≥1-prop solo guard,
then `_launchRound()`) instead of `resetToLobby()`. Rounds chain while the host (=
the referee's tab) is connected; `resetToLobby()` stays as the empty-room fallback.
The lobby is now only used for the FIRST round's start.

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

## Win / reset (persistent lobby)
`checkRoundOver`: if props existed and none are alive → hunters win → ENDING.
Hunt-timer expiry in `tick` → props win → ENDING. `endRound(winner)` also stores
`this.lastResult = {winner}`. `resetToLobby` clears roles / alive / disguise /
ready and broadcasts `lobby{phase:'lobby'}` (how clients know to show the lobby
screen again). **It deliberately does NOT reset `this.mapId`** — the map is a
lobby setting, not per-player state, so the pick survives a reset-to-lobby
(documented carve-out; see map-selection.md).

The **lobby persists across rounds**: nothing tears down between rounds — peer
connections stay open, the player list survives, the host stays host, the map
stays picked. `this.lastResult` rides `S2C.LOBBY` (`{winner}|null`) so the lobby
screen shows "HUNTERS/PROPS won the last round" for back-to-back play. Client side:
`main.js`'s LOBBY handler detects it *was* in-game and tidies per-round view state
(`input.exitGame()`, release wake lock, reset the ready button, clear role) WITHOUT
reconnecting.

## Extending (intended seams)
- New map: add to `maps.json`. New prop type: add to `props.json` + reference it
  in a map. No engine edits. (The lobby map picker renders new maps automatically.)
- New abilities/rules: add fields to `rules.json`, read them in `Room`.
- Map selection: DONE — `Referee.setMapId()` + `C2S.PICK_MAP` + lobby picker. See
  `memory/notes/map-selection.md`.
