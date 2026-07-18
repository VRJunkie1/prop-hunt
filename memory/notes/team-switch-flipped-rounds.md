# Team switch + endless flipped rounds + mid-round join + disguise-leak fix (2026-07-17, VRmike)

Branch `build/128-pause-menu-team-switch`. Four host-authoritative pieces over the existing referee.
Guard: `tools/check-team-flip.mjs`. NO change to physics/settle, taunts, prop finder, grenades,
snapshot prop-transform stream, or the disguise render path.

## A) Pause-menu TEAM SWITCH
- `C2S.SWITCH_TEAM` (no payload) → `referee.applySwitchTeam(player)`. Active-round only
  (HIDING/HUNTING; ignored in lobby/ending). Respawns the sender on the OPPOSITE team via the shared
  `_spawnOnTeam` routine, then `broadcastLog("X switched to hunters"/"…props")` — a public
  `S2C.EVENT kind:'log'{text}` that lands in EVERY player's feed. **NO cooldown / anti-abuse**
  (accepted per VRmike — intentional, abusable-for-laughs). `checkRoundOver()` after (counts by
  CURRENT role, so a switch never fires a false win; the switcher leaves their old team's count).
- Client: pause-menu `#pauseSwitch` button → `main.js ui.onPauseSwitch` sends `C2S.SWITCH_TEAM` +
  `closePause(true)`. The new private `ROLE` re-runs `applyRoleView`/`applyToolView` + banner; the
  host teleports the physics body (snapshot reconcile SNAP handles the >2.5 m jump).

## B) ENDLESS FLIPPED ROUNDS
- When a round ends it NO LONGER returns to the lobby. `tick()`'s ENDING-expiry branch now calls
  `startFlippedRound()` (was `resetToLobby()`), which flips EVERY player's team (prop↔hunter) then
  runs the shared `_launchRound()`. Rounds chain while the host is connected (the referee only runs
  in the host tab, so "host present" is always true here); `resetToLobby()` stays as the empty-room
  fallback. The ENDING window (roundOver banner / `endingSeconds`) still plays, then flips into HIDING.
- **Refactor (load-bearing):** `startMatch()` now only assigns the random hunter/prop split then
  delegates to `_launchRound()`. `startFlippedRound()` flips roles then delegates to the SAME
  `_launchRound()`. `_launchRound()` = the old startMatch body: builds props (hide-spot removal),
  spawns every player FRESH BY THEIR ALREADY-ASSIGNED role (full HP, no disguise, cleared taunt/finder,
  round-robin prop spawns / shared hunter spawn), sends private ROLEs, broadcasts STARTED, enters
  HIDING, stands up physics. The prop-build block is byte-identical to before (the settle/hide-spot
  checks that mirror it independently are unaffected).
- **Solo guard:** a lone host (solo → prop, 0 hunters) would flip to a 0-prop round; `startFlippedRound`
  forces one player back to PROP so a round always has ≥1 prop (mirrors startMatch's invariant).
- Client: a fresh `STARTED` mid-game rebuilds the world through the SAME path a first match uses
  (`main.js` S2C.STARTED handler); no lobby round-trip between rounds. `state.spawned=false` → next
  snapshot hard-places.

## C) ROOM-CODE COPY (mid-game join support)
- Pause menu shows the room code (`#pauseRoomCode`, set by `ui.setPauseRoom(state.room)` in
  `openPause`) with a `#pauseCopyRoom` button → `main.js ui.onPauseCopyRoom`: `navigator.clipboard`
  with a phone-friendly fallback (shows the code in the feed if clipboard is blocked / insecure ctx).

## D) MID-ROUND JOIN → smaller team
- `admitMidGame` no longer forces HUNTER. It counts the CURRENT teams (excluding the newcomer) and
  assigns the SMALLER team; a tie is a coin-flip. Then it sends STARTED (world catch-up) FIRST, spawns
  the newcomer fresh via the shared `_spawnOnTeam` (same routine team-switch uses — they can't drift),
  sends phase, and `broadcastLog("X joined the hunters"/"…props")`.

## Shared fresh-spawn routine — `_spawnOnTeam(player, role)`
The ONE place a single mid-round player is (re)born: role, alive, full HP, no disguise, cleared
taunt/finder, motion zeroed; placed at the team spawn (hunters share `hunterSpawn`; props round-robin
`map.spawns` via `this._propSpawnRR`); physics body repositioned-or-created + movement collider + shot
sensor reset to a plain capsule; sends the private ROLE. Guarded so it works on the 2D fallback.

## E) DISGUISE-INFO LEAK FIX (the narrow, correct one)
**The tension:** hunters MUST keep receiving each prop's render `disguise` (a burger-disguised prop
has to draw AS a burger on the hunter's screen — `scene.meshForPlayer` reads `p.disguise`). So we can
NOT strip `disguise` from hunter snapshots. The leak is the pause-menu ROSTER pairing a NAME to a
disguise ("VRmike — burger").
**The fix (host-side, per-recipient, blindfold-pattern):** `broadcastSnapshot` now sends HUNTER
recipients (during HUNTING) `hunterSafeSnapshot(full)` — identical to `full` EXCEPT every DISGUISED
prop entry has its `name` BLANKED. So a hunter's data keeps the render shape (byte-for-byte) but never
pairs a real player NAME with a disguise. Undisguised props + hunters keep names. During HIDING the
existing blindfold already withholds ALL prop entries, so no leak there.
**Client half (belt-and-suspenders):** `ui.updatePauseScoreboard(players, selfId, selfIsHunter)` shows
the disguise label ONLY when the viewer is a prop; a name-blanked entry renders anonymously as "a prop".
`main.js` passes `state.role === ROLE.HUNTER` from both `openPause` and the live snapshot refresh.
**Residual (honest):** render fundamentally needs id→disguise and the roster shows id→name for the
self; a determined hacked hunter still can't get name↔disguise from the roster because names are
withheld on disguised props. The general host-holds-full-state caveat (architecture.md) is unchanged.

## Files
`shared/protocol.js` (C2S.SWITCH_TEAM + kind:'log'), `shared/referee.js` (applySwitchTeam,
_spawnOnTeam, startFlippedRound, _launchRound refactor, admitMidGame smaller-team, broadcastLog,
hunterSafeSnapshot + snapshot dispatch, tick ENDING→flip, _propSpawnRR), `js/main.js` (onEvent 'log',
pause switch/copy wiring, viewer-role scoreboard, setPauseRoom in openPause), `js/ui.js` (pause room +
switch/copy bindings + callbacks, setPauseRoom, role-gated updatePauseScoreboard), `index.html`
(pause room-code row + Switch-teams button), `css/style.css` (.pause-room), `tools/check-team-flip.mjs`
(new), notes + architecture + project-state.

## OWED — live pass
Two devices: see a team switch (public log + fresh spawn on the other team); a round end flip both
teams into a new round (no lobby); a friend join mid-round onto the smaller team (public log); a
HUNTER's pause menu showing NO disguise names while disguised props still render as their disguise in
the world; the room-code copy button (+ mobile clipboard fallback).
