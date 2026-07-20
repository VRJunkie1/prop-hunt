// HUNTER-TOOLS v1 — damage math. PURE + dependency-light (imports only the pure
// halfExtentsFor size helper from physics.js — no Rapier, no DOM), so BOTH the host
// referee and the offline guard (tools/check-combat.mjs) run the EXACT same numbers.
//
// The one design rule that matters here: the size a disguise's damage scales by is the
// SAME footprint physics builds its collider from (halfExtentsFor). One size source →
// the day asset-dims.json is populated with measured bounds, this curve upgrades with
// it automatically (halfExtentsFor prefers `c.measured`). No second list to drift.
import { halfExtentsFor } from './physics.js';

// Fill in defaults for a partial/absent rules.damage block. Kept in sync with the
// documented block in shared/config/rules.json.
export function resolveDamageCfg(d) {
  const c = d || {};
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  return {
    base: num(c.base, 10),
    // playerSize + sizeComparisonFactor drive the SIZE→multiplier curve (see sizeMultiplier).
    // The neutral point (multiplier 1.0) is at prop size == playerSize * sizeComparisonFactor.
    // playerSize defaults to the shipping capsule height 2*(playerRadius+playerHalfHeight)=1.8;
    // the referee injects the LIVE value (playerSizeFromRules) so the pivot tracks the real player.
    playerSize: num(c.playerSize, 1.8),
    sizeComparisonFactor: num(c.sizeComparisonFactor, 0.6),
    // smallSize/largeSize are NO LONGER read by the damage curve (that's a size-ratio now); they are
    // KEPT because the prop-"ouch" pitch curve (resolveOuchCfg / main.js) still anchors to them.
    smallSize: num(c.smallSize, 0.72),
    largeSize: num(c.largeSize, 2.2),
    // smallMult/largeMult are now the multiplier CLAMPS (guardrails): smallMult = ceiling (a tiny
    // prop can't be one-shot-vaporised), largeMult = floor (a huge prop can't become immortal).
    smallMult: num(c.smallMult, 5.0),
    largeMult: num(c.largeMult, 0.34),
    defaultMult: num(c.defaultMult, 1.0),
    selfScalesWithSize: c.selfScalesWithSize !== false, // default ON
  };
}

// The player's characteristic SIZE (metres) — the longest dimension of the movement capsule,
// = 2*(playerRadius+playerHalfHeight), the same "longest full dimension" entrySize gives a prop.
// The referee derives the disguise-damage pivot (playerSize * sizeComparisonFactor) from this so
// "same source of truth" holds: retune the capsule dims and the neutral prop size moves with it.
export function playerSizeFromRules(rules) {
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const r = num(rules && rules.playerRadius, 0.4);
  const h = num(rules && rules.playerHalfHeight, 0.5);
  return 2 * (r + h);
}

// Characteristic SIZE (metres) of a catalog entry's footprint — the longest full
// dimension of the collider box physics bakes. Tiny food ~0.6–0.9; a table ~2.25.
// Reuses halfExtentsFor so mesh, collider, and damage curve can never disagree.
export function entrySize(c) {
  if (!c) return 0;
  const h = halfExtentsFor(c);
  return 2 * Math.max(h.hx, h.hy, h.hz);
}

// SIZE-COMPARISON DAMAGE CURVE (2026-07-19, VRmike). Map a prop's characteristic size (metres) to a
// damage multiplier by comparing it to the PLAYER's size, shrunk by sizeComparisonFactor:
//
//     multiplier = 1 / (size / (playerSize * sizeComparisonFactor))    (== pivot / size)
//
// So the NEUTRAL point (multiplier 1.0 — the disguise takes plain base damage) is a prop whose size
// equals playerSize * sizeComparisonFactor. With the default 0.6 that's 0.6× the player: SMALLER props
// (burger) take MORE than base (multiplier > 1, fragile), LARGER props (fridge/table) take LESS
// (multiplier < 1, tanky). Lowering sizeComparisonFactor moves the pivot down and makes every prop
// tankier; it's the ONE tunable in rules.json. The result is CLAMPED to [largeMult, smallMult] — the
// same guardrails as before (tiny props stay fragile-not-vaporised, huge props never immortal).
export function sizeMultiplier(size, cfg) {
  const c = resolveDamageCfg(cfg); // idempotent: accepts a resolved or a raw config
  const { smallMult, largeMult, playerSize, sizeComparisonFactor } = c;
  if (!(size > 0)) return c.defaultMult; // unknown size => treat as a default player
  const pivot = playerSize * sizeComparisonFactor; // prop size that yields the neutral multiplier 1.0
  const mult = pivot / size; // = 1 / (size / (playerSize * sizeComparisonFactor))
  return Math.min(smallMult, Math.max(largeMult, mult)); // clamp to the [largeMult, smallMult] guardrails
}

// Multiplier for a player wearing `disguiseType` (null/unknown => defaultMult, i.e. an
// undisguised player takes the plain base hit). `catalog` is the merged props+fixtures
// lookup; `cfg` is a resolved (or raw) damage config.
export function multiplierForDisguise(disguiseType, catalog, cfg) {
  const c = resolveDamageCfg(cfg);
  if (!disguiseType) return c.defaultMult;
  const entry = catalog && catalog[disguiseType];
  if (!entry) return c.defaultMult;
  return sizeMultiplier(entrySize(entry), c);
}

// Damage a hunter's rifle deals to a player disguised as `disguiseType` (base * size
// multiplier). Convenience used by the referee and asserted by the guard.
export function damageForPlayerHit(disguiseType, catalog, cfg) {
  const c = resolveDamageCfg(cfg);
  return c.base * multiplierForDisguise(disguiseType, catalog, c);
}

// COMBAT SFX — PROP "OUCH" PITCH-BY-SIZE (2026-07-18, VRmike B5). One shared ouch clip is played
// for every prop hit (rifle or grenade), PITCH-SHIFTED by prop size via Web Audio playbackRate.
// The rate is derived from the SAME characteristic size the damage curve scales by (entrySize /
// halfExtentsFor) so pitch and damage can never disagree about how big a prop is. Monotonic
// DECREASING in size: tiny props (burger) squeak HIGH (rate > 1), big props (table/fridge) groan
// LOW (rate < 1); an undisguised/unknown player plays NEUTRAL (rate 1.0). Pure + dependency-light so
// the guard (tools/check-combat-sfx.mjs) asserts the mapping (a relationship, not frozen numbers).
//
// Anchors default to the damage curve's own smallSize/largeSize so the pitch tracks the size band
// the multiplier uses; pass { smallSize, largeSize } (e.g. from resolveDamageCfg) to keep them in
// lockstep if those knobs are retuned. minRate/maxRate are the pitch bounds (playback speed).
export function resolveOuchCfg(o) {
  const c = o || {};
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  return {
    smallSize: num(c.smallSize, 0.72), // <= this => tiniest => maxRate (matches damage.smallSize)
    largeSize: num(c.largeSize, 2.2),  // >= this => biggest => minRate (matches damage.largeSize)
    maxRate: num(c.maxRate, 1.8),      // tiniest prop — highest squeak (fastest playback)
    minRate: num(c.minRate, 0.7),      // biggest prop — deepest groan (slowest playback)
  };
}

// Map a characteristic SIZE (metres, from entrySize) to an ouch playbackRate. Lerps the rate DOWN as
// size grows across [smallSize, largeSize], clamped outside — the inverse of the size→damage curve's
// shape (small => high number), so tiny = high pitch and big = low pitch. Unknown size => 1 (neutral).
export function ouchPlaybackRate(size, cfg) {
  const c = resolveOuchCfg(cfg);
  if (!(size > 0)) return 1; // unknown size => neutral pitch (undisguised player)
  if (size <= c.smallSize) return c.maxRate;
  if (size >= c.largeSize) return c.minRate;
  const t = (size - c.smallSize) / (c.largeSize - c.smallSize);
  return c.maxRate + (c.minRate - c.maxRate) * t;
}

// Ouch playbackRate for a player wearing `disguiseType` (null/unknown => 1.0, a neutral yelp).
// Mirrors multiplierForDisguise: same catalog lookup, same entrySize source — so the pitch and the
// damage multiplier are computed from one size, never two lists that can drift.
export function ouchRateForDisguise(disguiseType, catalog, cfg) {
  if (!disguiseType) return 1;
  const entry = catalog && catalog[disguiseType];
  if (!entry) return 1;
  return ouchPlaybackRate(entrySize(entry), cfg);
}

// WRONG-GUESS PENALTY (2026-07-12) — the self-inflicted damage a hunter takes for shooting
// a disguisable DECOY (a prop or non-arch fixture that could have been a player). This is a
// FLAT `base` hit with NO size multiplier, EVER — a small burger decoy and a big table decoy
// cost the hunter exactly the same (20 wrong guesses at base 5 = dead). This is the ONE place
// the wrong-guess cost is defined; the referee calls it instead of the size curve. Deliberately
// does NOT touch multiplierForDisguise — prop-PLAYERS still scale by size; only the decoy
// self-penalty is flat. (Real architecture is a free miss and never reaches here.)
export function wrongGuessPenalty(cfg) {
  return resolveDamageCfg(cfg).base;
}

// ---- HUNTER GRENADES (2026-07-17, VRmike) ---------------------------------
// PURE grenade tuning + falloff math, shared by the host referee (applyGrenade) and the
// offline guard (tools/check-grenade.mjs) so both run the EXACT same numbers.
//
// Fill in defaults for a partial/absent rules.grenade block. Kept in sync with the
// documented block in shared/config/rules.json.
//   baseDamage      : FRACTION of full health (0.45 = 45%). The referee scales by startHealth.
//   fullDamageRadius: metres of MAX damage (d <= this => full).
//   falloffDistance : metres ADDED past fullDamageRadius over which damage lerps to ~0.
//   flingSpeed      : TARGET outward physics-shove speed (m/s) for a loose DYNAMIC prop at FULL
//                     damage (blast centre); scaled by the same falloff, so it lerps to ~0 at the
//                     outer edge. Mass-scaled in physics so tiny props aren't launched. 0 disables.
// Authored as fullDamageRadius + falloffDistance (1 + 2), NEVER as an outer radius of 3 —
// VRmike wants the two knobs editable independently without doing the 1+2 math by hand.
export function resolveGrenadeCfg(g) {
  const c = g || {};
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  return {
    baseDamage: num(c.baseDamage, 0.45),
    fullDamageRadius: num(c.fullDamageRadius, 1),
    falloffDistance: num(c.falloffDistance, 2),
    flingSpeed: num(c.flingSpeed, 32),
  };
}

// Total outer radius of a blast (metres) = fullDamageRadius + falloffDistance. Derived, never
// stored — so editing either knob moves the edge with no second number to keep in sync.
export function grenadeOuterRadius(cfg) {
  const c = resolveGrenadeCfg(cfg);
  return c.fullDamageRadius + c.falloffDistance;
}

// Distance falloff multiplier (0..1) for a target `d` metres from the blast CENTRE:
//   d <= fullDamageRadius            => 1                       (full)
//   fullDamageRadius < d < outer     => 1 - (d - fullDamageRadius) / falloffDistance  (lerp)
//   d >= outer (= full + falloff)    => 0                       (out of range)
// With the shipping 1 + 2: d=1 => 1, d=2 => 0.5, d=2.99 => ~0.005, d>=3 => 0. Applied to BOTH
// the prop-player damage and the hunter backfire. Pure so the guard asserts the exact curve.
export function grenadeFalloff(d, cfg) {
  const c = resolveGrenadeCfg(cfg);
  const outer = c.fullDamageRadius + c.falloffDistance;
  if (!(d > c.fullDamageRadius)) return 1; // within the full-damage radius (incl. d <= 0)
  if (d >= outer) return 0; // past the outer edge — no damage
  return 1 - (d - c.fullDamageRadius) / c.falloffDistance;
}

// NEAREST-SURFACE BLAST DISTANCE — bounding-box fallback (2026-07-20, VRmike). The grenade now
// measures damage/fling from the nearest point on a target's SURFACE, not its centre, so a big prop
// (fridge/table) isn't bomb-proof when the blast is on its side but its pivot is metres away. The host
// prefers Rapier's exact closest-point on the live collider (physics.nearest*SurfaceDistance); THIS is
// the fallback for when that's unavailable (the offline guard has no Rapier; or a target with no
// queryable collider): the nearest point on an axis-aligned BOUNDING BOX carrying the target's collider
// half-extents (halfExtentsFor), seated with its BASE at `pos` (x/z = footprint centre, y = base
// height) exactly how physics seats a prop/disguise collider on the ground. Returns 0 when `center` is
// inside the box (=> full damage, never a divide-by-zero / negative). Cruder than the real collider but
// NEVER worse than the old centre distance. Pure so the referee and the offline guard compute the
// identical curve. The blast RADIUS is unchanged — this only moves where the distance is measured FROM.
export function boxBlastDistance(center, pos, entry) {
  const h = halfExtentsFor(entry);
  const p = pos || {};
  const cx = p.x || 0;
  const cy = (p.y || 0) + h.hy; // the box base sits at pos.y; its centre is hy above that
  const cz = p.z || 0;
  const dx = Math.max(Math.abs((center.x || 0) - cx) - h.hx, 0);
  const dy = Math.max(Math.abs((center.y || 0) - cy) - h.hy, 0);
  const dz = Math.max(Math.abs((center.z || 0) - cz) - h.hz, 0);
  return Math.hypot(dx, dy, dz);
}
