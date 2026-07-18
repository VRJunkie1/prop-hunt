# Spectator mode (dead-player fly cam + player switching) — B6, 2026-07-18, VRmike

A dead player is a **spectator**. Hunters don't respawn (DECISIONS #1) and a caught prop is out for
the round, so from death until the round ends you get a **free-flying camera** plus the ability to
**switch between watching live players**. Requested because spectating previously had NO controls at
all (see the audit below). Purely **client-side** — the physics body stays dead/frozen on the host
and nothing new crosses the wire; the one server change is an anti-cheat gate (see §Data rule).

## Audit — what existed BEFORE B6 (VRmike: "missing vs. undocumented")
- On death the referee sets `victim.alive=false` + broadcasts `eliminated`. Client: `state.alive=false`,
  `state.movable=false`, a 3 s "You died — spectating" banner, and the darkened **death vignette**
  (`.spectate`, centre kept clear — re-tuned in B3).
- **Camera was PINNED to the death spot.** `state.movable=false` → no prediction; `setCamera` pins to
  the authoritative dead-body pose every frame. Look (mouse/drag) still worked (`lookFrozen` is only set
  for a blindfolded hunter), so you could rotate in place — nothing else.
- The referee **skips `!p.alive` in `integrate`**, so a dead player's input never moves the body.
- **Fly cam = MISSING. Player switching = MISSING.** Only look-in-place worked, and the sole documentation
  was the vignette subtitle. So VRmike's answer: genuinely missing, not just undocumented.

## Client (js/main.js + js/scene.js)
`state.spectate = { on, mode:'fly'|'follow', targetId, _prevJump }`. Entered/left by `setSpectating(on)`,
called from `onSnapshot` off `!state.alive && activePhase` (so it's authoritative, and self-clears at
ENDING / respawn / back-to-menu). The camera is driven each frame by `updateSpectatorCamera(dt)`, called
in the frame loop **after** `scene.interpolate()` (so a followed player is tracked at the smoothed mesh,
not the 15 Hz pose). While spectating, the normal `setCamera` / finder HUD / disguise targeting are skipped.

- **Fly mode** (default on death): `scene.updateSpectateFly(inp)` — the SAME fly math as the debug free
  cam (`_flyStep`, extracted so both share it), CLAMPED to the map: horizontal to `±map.size/2` (inside
  the walls), vertical to `[0.6, map.size]`. No collision (fly through walls), just the outer arena box —
  "kept inside the map bounds so nobody flies into the void." Its eye is `_specPos`, SEPARATE from the
  debug cam's `_fcPos`, seeded from the live camera in `enterSpectate()` (which also hides the own dead
  body). PC: WASD + mouse, **Space up / Shift down**. Phone: joystick + drag-look (reused touch controls),
  **JUMP = up**.
- **Follow mode**: `scene.spectateFollow(pos, yaw, pitch)` orbits the SAME third-person camera props use,
  pointed at a watched player — it calls `scene._orbitCameraTo(target, yaw, pitch)`, the orbit block
  **extracted from `setCamera`** so following is byte-identical to third-person play (NOT a second
  follow-cam that could drift — the plan was explicit about reuse). Target position comes from
  `scene.playerViewPos(id)` (public wrapper over `_playerWorldPos` → the interpolated mesh).
- **Switching** (`spectateCycle(dir)`): a ring `['fly', ...live player ids]`; `dir` +1 next / −1 prev,
  wrapping through free-fly. PC **left-click** cycles (`input.onAction` routes 'primary' → cycle while
  dead, so no fire/disguise). Phone: on-screen **◀ / FLY / ▶** bar (`#spectateBar`, `ui.setSpectateControls`).
  **Space** while following snaps straight back to free-fly (`_prevJump` edge). If the watched player
  dies/leaves → auto-hop to the next live one; none left → free-fly. `liveWatchables()` = everyone alive
  in the latest snapshot except self.

## Data rule (anti-cheat) — shared/referee.js
A dead player can still TALK to living hunters on voice, so a spectator watching props scatter during
HIDING is the exact leak the hunter **blindfold** guards. The withholding gate was therefore EXTENDED
from *hunter-during-HIDING* to *hunter-OR-dead-during-HIDING*:
- `broadcastSnapshot` dispatch: `if (phase===HIDING && (role===HUNTER || !alive))` → `blindHunterSnapshot`
  (zero prop transforms + no prop-player entries). Living hunter during HUNTING → still `hunterSafeSnapshot`
  (name-blanked disguised props); **living props and any DEAD spectator during HUNTING → the FULL feed**.
- `setPhase(HUNTING)` one-time `kind:'world'` catch-up now goes to `role===HUNTER || !alive` (a spectator
  withheld through HIDING needs it too, else the fly cam shows the factory-fresh map).
- **Consequence, decided not accidental (plan rev 2 §5):** from HUNTING onward a spectator sees everything
  including disguised props' NAMES — a dead hunter falls through to the FULL feed, NOT the name-blanked
  `hunterView`. They're a dead teammate on voice anyway; that's normal prop-hunt spectating (and the
  follow UI needs names). Dying during HIDING is rare (hunters frozen + blindfolded then) but the rule
  closes the hole cleanly instead of special-casing it. Living hunters/props are byte-identical to before.

## Docs (undocumented controls were half the complaint)
- `_controlsHtml()` (js/ui.js) — a **Spectating** block in BOTH the PC and touch control lists (the one
  source of truth for the pause "Controls" panel AND the always-visible corner reference).
- On death, `#spectateHint` (the vignette subtitle) shows a live one-liner via `ui.setSpectateHint` —
  e.g. "Free-fly — WASD + mouse, Space/Shift up-down · click to follow players" / "Watching NAME · …".

## Guards
- `tools/check-spectator.mjs` (pure, no Rapier): (A) a dead prop during HIDING gets ZERO prop transforms
  + no prop entries while a live prop still sees the world; (B) a dead spectator gets the world catch-up at
  HUNTING (a live prop does not); (C) a dead hunter sees a disguised prop's NAME (full feed) while a live
  hunter still gets it blanked — relationships, not hardcoded counts. Plus static asserts that the whole
  client chain (scene fly/follow seams reusing `_orbitCameraTo`, main controller, ui hint/bar, docs) is wired.
- `tools/check-blindfold.mjs` — its "referee gate" assertion updated to the B6 extended spelling; its
  render-loop contract auto-covers the new `scene.*` calls (a missing one blanks the render loop).
- No regression: check-object-sync / check-team-flip / check-sync-convergence / check-combat / check-lifecycle
  / check-pc-controls all GREEN; page boots clean (desktop + phone).

## OWED — live pass (headless can't test feel/multiplayer)
- Die in a 2-device match → free-fly around (clamped inside the walls, Space/Shift up-down); left-click to
  follow a live player (name shows), cycle through everyone and back to free-fly, Space snaps back;
  watched player dies → auto-hop to the next. Phone: joystick flies, ◀/FLY/▶ switch.
- Confirm a spectator during HIDING sees no props then the full world the instant HUNTING starts (rare but
  the anti-cheat path). Confirm the follow-cam look-at height reads well (uses `_camHeadY + meshY`; a model's
  baseY could nudge it — retune `_camHeadY`/target-y if it sits high/low on some meshes).
