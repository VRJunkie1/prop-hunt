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
    smallSize: num(c.smallSize, 0.72),
    largeSize: num(c.largeSize, 2.2),
    smallMult: num(c.smallMult, 5.0),
    largeMult: num(c.largeMult, 0.34),
    defaultMult: num(c.defaultMult, 1.0),
    selfScalesWithSize: c.selfScalesWithSize !== false, // default ON
  };
}

// Characteristic SIZE (metres) of a catalog entry's footprint — the longest full
// dimension of the collider box physics bakes. Tiny food ~0.6–0.9; a table ~2.25.
// Reuses halfExtentsFor so mesh, collider, and damage curve can never disagree.
export function entrySize(c) {
  if (!c) return 0;
  const h = halfExtentsFor(c);
  return 2 * Math.max(h.hx, h.hy, h.hz);
}

// Map a size (metres) to a damage multiplier by lerping between the two anchor points,
// clamped outside them. smallSize -> smallMult (tiny things die fast), largeSize ->
// largeMult (big things soak bullets). Monotonic decreasing when smallMult > largeMult.
export function sizeMultiplier(size, cfg) {
  const c = resolveDamageCfg(cfg); // idempotent: accepts a resolved or a raw config
  const { smallSize, largeSize, smallMult, largeMult } = c;
  if (!(size > 0)) return c.defaultMult; // unknown size => treat as a default player
  if (size <= smallSize) return smallMult;
  if (size >= largeSize) return largeMult;
  const t = (size - smallSize) / (largeSize - smallSize);
  return smallMult + (largeMult - smallMult) * t;
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
