// shared/item-tuner.js — HELD-ITEM ALIGNMENT TUNER (debug-only) merge + export logic.
//
// WHY THIS MODULE EXISTS. The rifle/grenade/finder never lined up in the hunter's hand on OTHER
// players' third-person views (builds #188/#190/#208/#212 kept guessing offset numbers blind and
// missing). Per VRmike this switched to a HUMAN-IN-THE-LOOP tuner: the ?debug=1 debug menu gives
// live knobs (position x/y/z, rotation pitch/yaw/roll, scale) PER held item, the player nudges
// until it looks right in first-person AND on the character model, then EXPORTS the numbers to
// paste into chat so they can be baked into shared/config permanently in a follow-up build.
//
// This module is the PURE merge/normalize/serialize core so js/debug.js (browser), js/scene.js
// (the two mount sites that apply the override), and tools/check-item-tuner.mjs (the headless
// check) all run the SAME code — no copy-paste drift, and the check verifies on real output.
//
// An override is a LAYER on top of the shipped defaults: a zeroed override (position 0, rotation
// 0, scale 1) means "leave the shipped placement exactly as it is". So a normal launch (no
// ?debug=1, no stored tuning) never touches the defaults — the whole feature is inert until a
// player deliberately turns a knob.

// The held items that can be tuned independently. Matches shared/protocol.js HUNTER_TOOL_IDS and
// the client's HUNTER_TOOLS ids ('rifle' fires, 'finder' reveals props, 'grenade' throws).
export const TUNER_ITEMS = ['rifle', 'finder', 'grenade'];

function num(v) {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
}

// A zeroed override for one item: shipped placement untouched (no offset, no rotation, scale ×1).
export function zeroTuning() {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { pitch: 0, yaw: 0, roll: 0 },
    scale: 1,
  };
}

// Normalize ONE item's override to finite numbers with safe defaults (scale must stay > 0 so a
// stray 0/negative can't collapse or mirror the mesh). Tolerates a bare `rotation` alias.
export function normalizeItem(t) {
  const n = zeroTuning();
  if (t && typeof t === 'object') {
    const p = t.position || {};
    const r = t.rotationDeg || t.rotation || {};
    n.position.x = num(p.x);
    n.position.y = num(p.y);
    n.position.z = num(p.z);
    n.rotationDeg.pitch = num(r.pitch);
    n.rotationDeg.yaw = num(r.yaw);
    n.rotationDeg.roll = num(r.roll);
    n.scale = +t.scale > 0 ? +t.scale : 1;
  }
  return n;
}

// Normalize the WHOLE override store: every known item present + normalized (missing → zeroed).
// scene.js reads this shape directly, so every item id is guaranteed to exist.
export function normalizeTuning(obj) {
  const out = {};
  for (const id of TUNER_ITEMS) out[id] = normalizeItem(obj && obj[id]);
  return out;
}

// True when the whole store is at defaults (no item has any offset/rotation/scale change). Lets
// callers skip applying entirely so the "no override → shipped behaviour unchanged" path is exact.
export function isDefaultTuning(obj) {
  const n = normalizeTuning(obj);
  for (const id of TUNER_ITEMS) {
    const t = n[id];
    if (t.position.x || t.position.y || t.position.z) return false;
    if (t.rotationDeg.pitch || t.rotationDeg.yaw || t.rotationDeg.roll) return false;
    if (t.scale !== 1) return false;
  }
  return true;
}

// Serialize the store to a copy-pasteable, VALID-JSON block shaped to drop into shared/config in a
// follow-up build. Self-documenting via a `_comment` (the existing config files use that idiom).
export function exportTuning(obj) {
  const block = {
    _comment:
      'HELD-ITEM ALIGNMENT — tuned live via the ?debug=1 debug menu (human-in-the-loop, attempt 4). ' +
      'Per item: position offset (metres, character space x=right y=up z=forward), rotation ' +
      '(degrees pitch/yaw/roll layered on the shipped orientation), scale (multiplier). These are ' +
      'OVERRIDES layered on the shipped defaults; zeros = no change. To bake permanently, teach both ' +
      'held-item mount sites (js/scene.js _buildHunterModel third-person + _buildViewModel first-person) ' +
      'to fold these into the shipped placement — see memory/notes/held-item-tuner.md.',
    heldItemTuning: normalizeTuning(obj),
  };
  return JSON.stringify(block, null, 2);
}

// Parse an exported block back into a normalized store (round-trip). Accepts either the wrapped
// { heldItemTuning: {...} } shape or a bare item map. Throws on invalid JSON (caller handles).
export function importTuning(text) {
  const o = JSON.parse(text);
  const map = o && typeof o === 'object' && o.heldItemTuning ? o.heldItemTuning : o;
  return normalizeTuning(map);
}
