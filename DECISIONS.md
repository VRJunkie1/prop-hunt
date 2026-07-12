# Prop Hunt — design rulings

Numbered, dated rulings the humans have signed off on, so nobody re-litigates them in a
later build. Newest at the bottom. If a build reverses one of these, add a NEW numbered
entry that supersedes it (don't silently edit history).

---

## 1. Hunters do NOT respawn; all hunters dead → PROPS WIN (2026-07-12, VRmike)

**Context.** The HUNTER-TOOLS v1 + health/damage build introduced hunter death (a hunter
can reach 0 HP by shooting a decoy prop that could-have-been-a-player, or by friendly fire).
An earlier working assumption was that dead players respawn. VRmike's approved scope for this
build **overrides that assumption**:

- **Dead hunters stay dead.** No respawn. On reaching 0 HP a hunter becomes a spectator
  (world still renders; they can look around from their death spot) rather than a black
  screen.
- **New win condition.** If a round has hunters and they are **all dead**, the round ends
  immediately: **HUNTERS LOSE, PROPS WIN.** This is wired into the existing round-end flow
  (`Referee.checkRoundOver` → `endRound(ROLE.PROP)`), alongside the pre-existing conditions
  (all props caught → hunters win; hunt timer expires → surviving props win).
- A zero-hunter solo round never triggers this (there are no hunters to all-die), so a lone
  host testing a map is unaffected — it just runs on the timer.

**Where it lives.** `shared/referee.js` (`checkRoundOver`, `_damagePlayer`), guarded by
`tools/check-combat.mjs` (the all-hunters-dead → props-win case is an assertion, so a
regression fails the build).
