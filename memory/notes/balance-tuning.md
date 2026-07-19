# Balance tuning — playtest knob values

Central record of deliberate PLAYTEST-TUNING values (not arbitrary defaults). A future
session/planner should treat these as intentional balance decisions, freely re-tunable, and
NOT "restore to some prettier round number." All are HOT-TUNABLE config/CSS — no rebuild.

## PROP HEALTH SCALING — SIZE-COMPARISON FACTOR (2026-07-19, VRmike, branch build/196-prop-player-health-scaling)

**One line:** bigger prop players were too easy to kill — the disguise-damage curve is now a size
RATIO to the player, with a 0.6× pivot, so mid/large props (fridge/table) get properly tanky. One knob.

### What changed (host-side damage formula only — no netcode/UI/physics)
- **`shared/damage.js sizeMultiplier` replaced the old size LERP with a ratio:**
  `mult = 1 / (propSize / (playerSize * sizeComparisonFactor)) = (playerSize*factor)/propSize`, clamped
  to `[largeMult, smallMult]`. Neutral (mult 1.0 = plain base) at `propSize == playerSize*factor`.
- **Why the old lerp was wrong for VRmike's complaint:** it only gave the tanky `largeMult` (0.34×) to
  props ≥ `largeSize` 2.2 m, so a fridge (1.88 m) sat at **2.43×** — took MORE than base, died in ~9 hits.
  The ratio pins the fridge at **0.57×** (~35 hits). Burger 0.72 m → **1.5×** (~14 hits, still faster than
  the 20-hit plain player), table 2.25 m → **0.48×** (~42 hits). Monotonic: bigger ⇒ tankier.
- **`playerSize` is derived, not authored:** `playerSizeFromRules(rules)=2*(playerRadius+playerHalfHeight)`
  = 1.8 m, injected live by `referee._damageCfg()` (rifle + grenade both use it). No new authored field.

### The one tuning knob (rules.json `damage` block — HOT-TUNABLE, no rebuild)
- **`sizeComparisonFactor` = 0.6** (NEW). Lower ⇒ pivot drops ⇒ EVERY (unclamped) prop tankier, big props
  gaining the most. This is the single lever if hunts run long/short. `_damageComment` documents it.
- **Side effect flagged to VRmike:** this buffs *every* prop's effective health (neutral moved from
  ~player-size down to 0.6× player), so all props are tankier and hunts run a bit longer. Intended; if it
  overshoots, drop this one number.
- **`smallMult` 10 / `largeMult` 0.34 kept as pure guardrail clamps** (ceiling/floor); neither binds for any
  real catalog prop now. **`smallSize`/`largeSize` kept in config but NO LONGER read by the damage curve** —
  they still anchor the prop-"ouch" pitch curve only (don't delete; `check-combat-sfx.mjs` A2 depends on them).

### Guard
`tools/check-combat.mjs` **section A** rewritten to assert the ratio formula (pivot ⇒ 1.0, exact
`1/(propSize/(playerSize*factor))` unclamped, both clamps, monotonic, lower-factor-⇒-tankier lever, and
VRmike's three named cases burger HIGH / fridge LOW / table<fridge). Sections B–G untouched + green.
`check-grenade.mjs` / `check-combat-sfx.mjs` green (grenade rides the same `multiplierForDisguise`; ouch is
independent). Page boots clean. See `notes/hunter-tools-combat.md` (2026-07-19 head section).

## SIZE-BASED PROP WEIGHT + KNOCKABILITY (2026-07-19, VRmike, branch build/195-prop-size-based-weight)

**One line:** a burger flies when hit, a fridge barely scoots — but *everything* budges at least a
little, no matter how big. Big props hard for hunters to move around, but never immovable. Hunters
untouched.

### What actually changed (small, host-side physics only — no netcode/UI)
1. **Mass already scaled with size — we kept it.** Every dynamic prop's rigid body is created with
   `.setDensity(rules.propDensity)` in `shared/physics.js _buildProps`, and Rapier computes
   `mass = density × collider VOLUME`. Volume grows with size³, so a prop twice as big is ~8× heavier
   — exactly the cubic relationship VRmike asked for, already in place and automatic (no per-prop
   authoring; a body rebuilt from a bigger footprint gets the bigger mass immediately). **We did NOT
   add a separate mass field** — that would have duplicated what setDensity already does.
2. **The real fix: discrete hits now RESPECT mass.** The rifle shot (`applyShotImpulse`) and grenade
   fling (`applyBlastImpulse`) used to be **mass-COMPENSATED** (`impulse = speed × mass` → the SAME
   velocity change for every prop, so a fridge and a burger flew identically — the opposite of the new
   spec). Both now route through one helper **`_nudgeImpulseMag(m, s)`**:
   - `refJ = s × NUDGE_REFERENCE_MASS` → resulting Δv = `s × (REF/mass)`: **heavy props resist,
     light props fly**. `NUDGE_REFERENCE_MASS` (module const, **0.35 kg**) is the mass at which a hit
     delivers its full target speed `s` 1:1; it is NOT a balance knob (density is the heaviness dial),
     just the internal scale that keeps `shotImpulse`/`flingSpeed` in intuitive m/s units. ≈ a small
     food prop, so anything bigger than a burger resists.
   - `floorJ = min(minNudgeSpeed, s) × mass` → the **minimum-nudge floor**: even a huge prop gets a
     visible Δv (≥ `minNudgeSpeed`) from any hit. Capped at `s` so a weak far-edge grenade shove is
     never amplified into a launch.
   - `J = max(refJ, floorJ)`.

### The two tuning knobs (rules.json — HOT-TUNABLE, no rebuild)
- **`propDensity` = 1.0** — THE heaviness dial. Raise → every prop heavier (harder to shove/fling,
  small props included, and harder for a walking hunter to push); lower → everything lightens. Left at
  1.0 this build (already-playtested settle/walk feel undisturbed; the size *spread* is what VRmike
  wanted and that comes free from the cubic mass). Expanded `_propWeightComment` documents it.
- **`minNudgeSpeed` = 0.6 m/s** (NEW) — the "even a fridge budges" floor. Up → huge props more
  nudgeable; down → more stubborn heavies. `_minNudgeSpeedComment` documents it.

No mass floor/ceiling clamps (Rapier's own tiny-mass guard is the only hidden safety, kept off the
balance surface so the light end stays lively). No Δv ceiling either — light props flinging fast from a
grenade IS the "easy to yeet" feel; if it's ever too wild, raise `propDensity` (it tames the light end
too). The continuous **walk-into-a-prop** shove already scales with mass via Rapier's
`setApplyImpulsesToDynamicBodies` + `characterMass` (unchanged) and always imparts motion, so it needs
no floor — the two discrete-impulse sources were the only stragglers, and both now share the one floor.

### Measured defaults (from `tools/check-prop-mass.mjs`, real Rapier, density 1.0)
- masses: burger 0.26 kg, kitchen_table 2.53, fridge-sized box 4.74 (cubic: 2× dims = 8× mass, exact).
- rifle shot (s=1.5): burger Δv **2.0 m/s** (flies), fridge Δv **0.6 m/s** (floored — a slight scoot).
- grenade fling at centre (s=32): burger Δv **43 m/s** / travels ~18 m, fridge Δv **2.4 m/s** / ~0.18 m
  (**18× spread**). Weak fling (s=0.15) on fridge → Δv 0.15 (NOT amplified to the 0.6 floor). ✓

### Guard
`tools/check-prop-mass.mjs` (new; SKIPs if the Rapier dev-dep is absent, like check-physics-live):
stands up the REAL PhysicsWorld and asserts cubic mass, mass-tracks-footprint, burger-flies-vs-fridge-
resists (Δv + travel), everything-budges (floor), floor-not-amplified, and characterMass unchanged.
`check-grenade.mjs` I-block updated: asserts the fling routes through `_nudgeImpulseMag` (was: asserts
"mass-scaled, both react the same") and its body-extraction regex now anchors on the 2-space-indented
method decl so a comment mentioning the method name can't fool it. `check-combat.mjs` / `check-physics-
live.mjs` unchanged and still green (the shot Δv on a medium crate is now the floored 0.6, still > their
0.2 threshold). Round-trip: nothing new over the wire — mass is host-side only; peers interpolate
positions as before.

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
