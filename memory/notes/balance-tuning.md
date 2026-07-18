# Balance tuning — playtest knob values

Central record of deliberate PLAYTEST-TUNING values (not arbitrary defaults). A future
session/planner should treat these as intentional balance decisions, freely re-tunable, and
NOT "restore to some prettier round number." All are HOT-TUNABLE config/CSS — no rebuild.

## B4 — RUN SPEED +50% (2026-07-18, VRmike, branch build/144-b4-pc-feel-controls)

**`shared/config/rules.json` → `moveSpeed` 6 → 9 m/s** (+50%, playtest feel). This is the SINGLE
authoritative player run speed, read from this one knob by BOTH the host's authoritative movement
(`shared/referee.js integrate` 2D fallback + `shared/physics.js _substep` collide-and-slide) AND
every client's own prediction world (`js/main.js` frame loop + its physics world). So raising it
speeds EVERY player up in lockstep — no desync, and no movement sanity-check to update (movement is
host-authoritative from input INTENT `mx,mz`, never client-reported positions, so there is no
"moving too fast" guard that could false-flag a legit player). Added `_moveSpeedComment` in the
config next to it.

- WATCH ITEM next playtest: +50% changes *feel* beyond raw speed — hiding spots get reachable
  faster, hunters sweep rooms quicker. If 9 is too zoomy in the restaurant's tight corridors, dial
  it back here — one number, no rebuild. VRmike said explicitly it WILL get retuned.
- Guard: no check hardcodes the number. `tools/check-solid-players.mjs` already reads
  `rules.moveSpeed` and asserts the disguised-player nudge stays *well under* walk speed
  (`avg < moveSpeed * 0.4`) — a RELATIONSHIP, so it auto-tracks the retune (verified green at 9).
  `tools/check-pc-controls.mjs` (new, B4) asserts moveSpeed is read from config and never
  hardcoded in the JS movement paths.

See also the sibling B4 feel/controls work in `notes/pc-feel-controls.md` (mouse-sensitivity slider
+ PC controls reference panel).

## B3 — BALANCE KNOBS (2026-07-18, VRmike, branch build/143-b3-balance-knobs-small)

Three number-only changes from playtest feedback. No new systems, no logic changes.

1. **GRENADE radii −40% (was OP).** `shared/config/rules.json` → `grenade`:
   - `fullDamageRadius` 1 → **0.6**
   - `falloffDistance` 2 → **1.2**
   - Kept the "core + falloff" authoring style (two separate knobs, NOT a single stored outer
     radius). Outer range is derived = 0.6 + 1.2 = **1.8 m** (was 3 m). The whole falloff curve
     scales with the two config values — `shared/damage.js grenadeFalloff` is unchanged.
   - Effect: grenades still punish sloppy hiding but no longer clear a whole corner. baseDamage
     (0.45 = 45% of full health) and the size-multiplier / backfire / redemption logic are all
     UNCHANGED — only the blast geometry shrank.

2. **PROP FINDER range +70%.** `shared/config/rules.json` → `finderRadius` 8 → **13.6 m**.
   `finderCooldownSeconds` (20 s) unchanged.
   - Effect: the finder pings props from much farther out. WATCH ITEM next playtest: whether 13.6
     feels too strong in the restaurant map's tight rooms — dial down if so.

3. **DEAD VIGNETTE darker.** `css/style.css` → `.spectate` background radial-gradient.
   - Was `radial-gradient(circle at center, #00000000 40%, #00000066 100%)` — transparent until
     40% radius, only ~40% black at the extreme corner, so the perceived screen darkening was
     faint (VRmike described it as ~10%).
   - Now `radial-gradient(circle at center, #00000000 25%, #00000099 100%)` — tint begins at 25%
     radius and reaches ~60% black at the edges, roughly tripling the screen darkening
     (~10% → ~30% perceived). Centre stays clear so the spectator view is never hidden.
   - NOTE on the numbers: VRmike's request said "~10% → ~30% opacity." The literal pre-change
     corner alpha was already 0x66 (40%), so the "10%" is a perceived-average estimate, not the
     hex value. The change makes it unambiguously DARKER (the intent). Easy to re-tune — one CSS
     line. (The dead nested copy `client/css/style.css` is unused and was left alone.)

### Guard-script policy (important for future tuning passes)
`tools/check-grenade.mjs` and `tools/check-finder.mjs` were updated to READ these knobs from
`rules.json` and assert RELATIONSHIPS (falloff full≥half≥0, outer = full+falloff, radius > 0,
targets inside vs outside the configured radius) instead of re-hardcoding the old literals
(1/2/8). Their test positions are now derived from the config values (e.g. `R = rules.finderRadius`,
`HALF = fullDamageRadius + falloffDistance/2`). So the NEXT balance pass that changes these numbers
should NOT break either check — no need to touch the guards when re-tuning. If you add a new knob,
follow the same pattern (assert shape/relationship, not a frozen constant).

See also: `notes/hunter-grenades.md`, `notes/prop-finder.md`.
