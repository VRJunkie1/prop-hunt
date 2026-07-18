# Hunter tool visibility on the model (B7)

Built 2026-07-18 (VRmike task "B7 — HUNTER TOOL VISIBILITY ON MODEL"; branch
`build/161-b7-hunter-tool-visibility`; the original build #154 was killed mid-run by a usage
hard-stop). NOT playtested live yet (headless can't load the GLB rig or render the swap — see
"Verification").

## The problem

Other players saw the hunter holding a **rifle no matter what** on their third-person SWAT
model. If the hunter switched to the grenade or the prop finder, everyone else still saw a gun —
so props couldn't read the tell ("he's pulled the finder, scatter!"). Before B7 the held item was
NOT networked at all: `_buildHunterModel` always parented the rifle, and `setViewModel` (the
first-person held item) was purely local. The tool a hunter held was invisible to everyone else.

## Salvage (build #154)

The branch was synced from `main` (HEAD = B6, f44a1b6) core-side before this session. Confirmed
nothing from the killed #154 landed: no `tool` field in the snapshot, `setViewModel` still
local-only, `setWeaponVisible` unused. Same story as the other killed builds (#152, #127) —
nothing usable, built fresh from the B6 baseline.

## What ships — host-authoritative tool relay + per-hunter held-item swap

Two halves: (1) the SELECTED tool now travels over the network (host-authoritative), (2) the
third-person model swaps the item shown in the hunter's hands to match.

### (1) Netcode — the tool is synced, host-authoritative

- **`shared/protocol.js`**: NEW `C2S.SELECT_TOOL { tool }` + NEW `export const HUNTER_TOOL_IDS =
  ['rifle', 'finder', 'grenade']` — the ONE canonical tool-id list both sides read (the client's
  `HUNTER_TOOLS` UI array in `main.js` carries the same ids + key bindings; the guard asserts it
  stays a subset). The snapshot player entry gains a documented `tool` field.
- **`shared/referee.js`**:
  - `player.tool` initialised to `'rifle'` in `addPlayer`, and RESET to `'rifle'` at every fresh-
    spawn / round / lobby seam (`_spawnOnTeam` + the two round-reset loops) — the same places
    `_lastFindAt` resets, so a stale tool can't leak across a spawn/round/flip. (4 reset sites; the
    guard counts them.)
  - `handleMessage` routes `C2S.SELECT_TOOL` → `applySelectTool(player, tool)`, which accepts it
    ONLY from a **living hunter** and ONLY a real id (`HUNTER_TOOL_IDS.includes`), else ignores and
    keeps the current value. So a modified client can only change ITS OWN held item (legal — it's
    their choice), never spoof another player's or push a bogus id. No broadcast — the change rides
    the next snapshot like every other player field.
  - `broadcastSnapshot` rides a COERCED `tool` per entry:
    `p.role === HUNTER ? (HUNTER_TOOL_IDS.includes(p.tool) ? p.tool : 'rifle') : null` — a valid id
    for hunters, `null` for non-hunters. Because `blindHunterSnapshot`/`hunterSafeSnapshot` spread
    `...full` players, `tool` rides all snapshot variants automatically (no separate wiring).
- **`js/main.js`**: `syncSelectedTool()` (called from `applyToolView`, which fires on tool select /
  role / alive change) sends `C2S.SELECT_TOOL` — but ONLY for a live hunter and ONLY when the value
  CHANGED (deduped via `state.toolSynced`), so it's safe to call every snapshot without spamming
  the wire. When not a live hunter it clears `toolSynced` so becoming a hunter again re-sends (the
  host reset us to rifle on our fresh spawn; local state may differ). Also reset at the two
  teardown seams alongside `state.tool = 'rifle'`.

**Purely cosmetic.** `tool` changes NO damage/hitbox/gameplay — which tool actually FIRES is still
the client-only fire path (`SHOOT`/`FIND`/`GRENADE`, unchanged). This only decides what MESH other
players see in the hunter's hand.

### (2) Render — swap the held item on the third-person model (`js/scene.js`)

- `_buildHunterModel` now builds **all three** held meshes on the wrist bone (was: rifle only):
  the real rifle GLB (unchanged sizing/orientation math, refactored to share `_scaleHeldToBone`),
  plus cheap grenade + prop-finder primitives matching the first-person viewmodels (`_buildView
  Model`) — no new asset files. Stored on the animation controller as `ctl.heldTools = { rifle,
  finder, grenade }` (any may be null if its GLB/bone is missing). Seeds the rifle visible.
- `_buildHeldPrimitive(toolId)` — the grenade (dark-green sphere + grey cap) / finder (blue box),
  same colours/shapes as the first-person viewmodel so the hand item reads the same in both views.
- `_scaleHeldToBone(root, worldLen, bone, group)` — normalises a held mesh's longest axis to
  `worldLen` metres in the wrist bone's frame (the bone carries the sized group scale × the
  armature's baked `[100,100,100]`, so a bare local scale would blow it up / shrink it away). Same
  math the rifle already used, now shared. Finder ≈ 0.22 m, grenade ≈ 0.14 m in hand.
- `_applyHeldTool(ctl, toolId)` — shows ONLY the selected tool's mesh (others hidden), per-hunter,
  falling back to rifle for an unknown/missing tool. Cheap: just toggles `.visible`. Called on
  build (initial) AND every snapshot from `syncPlayers` (`this._applyHeldTool(entry.hunterCtl,
  p.tool)`), so a tool switch — or a hunter who JOINED mid-game already holding the finder/grenade
  — reflects immediately.

### Anti-flicker (the strobe trap)

Every player-attached mesh must go through the ONE `preparePlayerModel` choke point (culling OFF)
or it blinks at the screen edge (the 2026-07-13 strobe bug — see `flicker-culling.md`). The new
held meshes are built INSIDE `_buildHunterModel`, which `meshForPlayer` wraps through
`preparePlayerModel`, so they're covered. Belt-and-braces: `_buildHeldPrimitive` AND
`_scaleHeldToBone` also set `frustumCulled = false` directly. `check-flicker.mjs` §3 was extended
to assert both.

## Guard — `tools/check-tool-visibility.mjs` (NEW)

Static acceptance check (headless can't render the swap). Asserts the wire contract
(`C2S.SELECT_TOOL` + `HUNTER_TOOL_IDS` + snapshot `tool` doc), the host-authoritative validation
(living hunter + id whitelist + coerced snapshot field + 4 reset sites), the render swap
(`heldTools` set built, `_applyHeldTool` defined + toggles visibility + rifle fallback +
syncPlayers wiring), and the client report (`syncSelectedTool` sends + dedupes + live-hunter-only;
`HUNTER_TOOLS` ids ⊆ shared list). Covers BOTH past bug classes: a scene method called-but-not-
defined (via `_applyHeldTool` existence + wiring) and culling on a player mesh (via check-flicker
§3). GREEN (29 ✓). Regression sweep GREEN: check-flicker (extended), check-blindfold,
check-hunter-model, check-combat, check-team-flip, check-finder, check-grenade. Page boots clean
(0 console errors, desktop).

## Verification (honest — headless can't load a GLB or render)

**OWED — live 2-window pass:** one player as hunter cycling rifle → grenade → finder, the other
watching that the held item on the hunter's model changes each time; AND a hunter who joins
MID-GAME already holding a non-rifle tool shows it correctly. Tune the in-hand size / grip anchor
(`_scaleHeldToBone` worldLen for finder/grenade; they reuse the rifle's grip `position`) if the
grenade/finder sits oddly in the hand — hot-tunable, no rebuild of the netcode needed.
