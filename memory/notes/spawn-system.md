# Spawn system + the far-side "locked / snapped-back" bug

## How spawns work
- `map.spawns[]` = prop spawn points; `map.hunterSpawn` = the hunter's. `referee.startMatch`
  assigns props round-robin through `map.spawns` (`spawnIdx++ % length`) and stamps `player.spawn`
  = `{x,z}`. Hunters all use `map.hunterSpawn`.
- `player.spawn` is ALSO the recovery target: `referee.integrate`'s per-0.5 s failsafe teleports a
  player back to `player.spawn` if they (fell below the floor) OR (escaped past the wall inner
  face) OR (the physics depenetration escape-hatch flagged them WEDGED for ~0.33 s).

## The bug (VRmike 2026-07-16): "locked at the far side, move a little, snapped back to that spot"
- ROOT CAUSE: a spawn point placed INSIDE a solid collider. The player spawns wedged → the
  escape-hatch can't free them → the failsafe teleports them to `player.spawn` = the SAME wedged
  spot → they predict a little movement → next failsafe snaps them back → loop. The symptom
  REQUIRES the spawn itself to be the trap (a teleport-to-spawn only helps if spawn is clear).
- FOUND: `toy_workshop` `crystal` props sat on far-corner spawns (12,-12) exactly, (-12,12) at
  1 m — overlap −1.15 m / −0.15 m against the player capsule. Both corners = "far side of the map".
  These maps ARE playable (lobby map-picker → PICK_MAP), so a prop player lands there.
- NOT the cause: the restaurant density edit (013d9d0). All restaurant spawns are clear (min
  0.35 m to the back-wall crates), and the bounds clamp / reconciliation were unchanged by that
  commit (the bounds diff only added the removed-fixtures skip; `wallBound` is wall-geometry-derived).

## Fix + permanent guard
- Data fix: relocated the two crystals off the spawns (→(9,-9),(-9,9), 2.78 m clearance).
- Guard: `tools/check-physics.mjs` OPEN-MIDDLE section now tests every spawn + hunterSpawn against
  BOTH the static world (walls + static fixtures) AND every **prop / knockable-fixture collider**
  (`propColliderBoxes`) at rest pose — the old check was static-only, so a spawn buried in a
  knockable prop passed straight through. It also asserts each spawn sits inside the walkable area
  (`|x|,|z| ≤ size/2 − WALL_INSET − playerRadius`). Confirmed it FAILS on the pre-fix crystals.
- Rule of thumb for future map edits: a spawn needs real clearance from EVERY collider, props
  included. `tools/_spawn_diag.mjs` prints per-spawn nearest-collider clearance for quick checks.

## Wedged auto-respawn DISABLED for diagnosis (2026-07-16, VRmike)
- STATUS: the WEDGED path of the failsafe (`stuck` → teleport-to-spawn) is turned OFF in
  `shared/referee.js` `integrate()` as a diagnostic experiment. Fell-through-floor and
  out-of-arena recoveries are UNCHANGED and stay live. This is a reversible switch-flip.
- WHY: VRmike still hit the "locked at spawn, move a little, snap back" loop even after the
  spawn-clearance data/guard fix above (6d459fe). New hypothesis: the wedged flag is a FALSE
  POSITIVE for DISGUISED players. `_isPenetrating` in `shared/physics.js` runs its penetration
  test against a bounding-capsule PROXY that can be FATTER than the real disguise collider, so
  a disguised player with nothing actually colliding gets flagged wedged → the ~0.5 s failsafe
  teleports them to spawn → they nudge → flagged again → infinite lock. Disabling the teleport
  should stop the loop and confirm the theory.
- STILL LIVE while disabled: the escape-hatch flagging itself is untouched; `consumeStuckPlayers()`
  is still drained each sweep (so the set can't accumulate), and a `console.warn` names the
  flagged id(s) as SUPPRESSED so the host console keeps collecting evidence.
- LIKELY REAL FIX (follow-up, once confirmed): make the penetration test accurate — test against
  the player's REAL disguise collider shape instead of the fat capsule proxy — AND strip a player
  back to their normal capsule on an emergency respawn so a re-spawned player can't immediately
  re-wedge. Only then re-enable the wedged respawn.

## Related
- Failsafe / clamp: `shared/referee.js` `integrate` (~L953 arena-edge clamp, ~L985 failsafe).
- `check-hide-spot-density.mjs` §5 also checks spawn clearance but only vs STATIC fixtures on
  restaurant — the check-physics guard is the general (all-maps, props+bounds) one.
