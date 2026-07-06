# disguise — aim-based (2026-07)

Props used to disguise as the **nearest** in-range prop. Now they disguise as the
prop they're **looking at**: trace a ray from the camera, first prop hit within
range wins. An occluding barrel in front of a crate gets you the barrel — that's
the point.

## Stable prop ids (the shared language)
Every placement in `shared/config/maps.json` carries an `id`. Both sides build
from that same file, so they already agree on what exists:
- **Referee** (`beginRound`) builds `this.props` with `id: p.id` (no more runtime
  `nextPropId` counter — ids are content, not generated).
- **Client scene** (`buildWorld`) tags each prop mesh with
  `userData.propId`/`userData.propType`, and STARTED re-broadcasts the same
  instances so `state.props` matches.

A DISGUISE request is `{ propId }` — a specific id, never a mesh or raw coords the
referee would have to reverse-match. Lookup is a trivial `find`.

## Client does the precise aiming
`Scene3D.propUnderCrosshair(maxDist)` — a `THREE.Raycaster` from screen-centre
(the crosshair) against **static prop meshes only** (you disguise as scenery, not
other players). Returns `{ id, type, mesh }` of the FIRST hit within `maxDist`, or
null. `maxDist` = `rules.disguiseRange` (one number, shared with the referee's
range check). Nothing hit / too far → nothing happens.

- Trigger: `main.js` `tryDisguise` raycasts and sends the id (E key or left-click).
- Crosshair feedback each frame (`updateDisguiseTarget`): the **scene** glows the
  targeted mesh (`highlightProp`, emissive); the **UI** shows a hint string
  ("Click to disguise as Crate", `ui.setTargetHint`). The raycast + "valid
  target?" decision live in `main.js` (game code) — the scene only glows a mesh,
  the UI only prints text. No game logic in the DOM layer (house rule).

## Referee is looser than the client — ON PURPOSE
`applyDisguise` re-checks: id exists, requester is a live prop in HIDING/HUNTING,
prop within `disguiseRange`, and roughly facing it — a yaw cone
(`disguiseAngleDeg`) plus a vertical gate (aim-ray height at the prop's distance
must land in the prop's body column ± `disguiseVertPad`). Eye height + pitch come
from the **same crouch-aware helpers the tag gate uses** (`eyeHeight`,
`propHeight`), so crouch/jump can't make the two sides disagree about aim height.

**Deliberate asymmetry:** the client's check includes occlusion (first-hit ray);
the referee's does NOT — range + facing only. The referee will therefore accept a
request the client would never send. That's fine: the referee's job is stopping a
tampered "I aimed at a prop across the map" claim, not re-simulating the scene.
**Do NOT "fix" this by porting 3D geometry into the referee** — that duplication
is exactly what we're avoiding (same reasoning as the movement-math duplication,
but inverted: here we intentionally DON'T duplicate the occlusion geometry).

## Tunables (`rules.json`)
- `disguiseRange` (4.5) — max look distance (client ray far) AND referee range.
- `disguiseAngleDeg` (45) — referee facing cone half-angle; loose by design.
- `disguiseVertPad` (1.0) — referee vertical slack around the prop column.

## Playtest edge cases (see project-state)
Disguise while crouched, mid-jump, aiming at a prop partly behind another, and
right at the range limit — the spots where "looks valid on my screen" and
"referee says yes" could drift apart. `propHeight` derives from the catalog
(`sphere` → `2r`, else `h`) — keep it in step with `makePropMesh`'s baseY.
