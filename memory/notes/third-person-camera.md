# Third-person follow camera (local player)

Built on `vrmike/dev`. The local player used to be first-person (camera at the
eyes, no self avatar). It is now **third-person by default**: a camera orbiting
behind and slightly above the player, so they see their own model/prop and can
peek around cover. **Camera/view change only** — movement, roles, collision,
networking, and the referee are all untouched.

## Where "aim" lives — UPDATED 2026-07-11 (centered reticle + camera-center ray)

The referee's tag cone (`applyTag`) and disguise both compute from the player's
**yaw-forward vector** `(-sin yaw, -cos yaw)` — a 2D cone in x/z. That did NOT
change and the referee stays authoritative.

**Superseded:** an earlier pass FLOATED the reticle to a projected aim point
(`scene.aimScreenPoint` → `ui.setCrosshair(pt)`) so it marked the yaw-forward line
in third-person. That created two competing crosshair systems (the floating reticle
vs. `debugPick`, which always raycast from screen-centre). Both `aimScreenPoint` and
`ui.setCrosshair` are now **removed**.

**Now:** the reticle is a FIXED crosshair at the EXACT screen centre, positioned by
CSS only (`#crosshair`: top/left 50% + `translate(-50%,-50%)`). Client-side prop
targeting raycasts from the CAMERA CENTRE through that reticle —
`scene.aimedDisguiseTarget` uses `this._raycaster.setFromCamera(SCREEN_CENTER, camera)`
(the shared `SCREEN_CENTER` = 0,0 NDC, the SAME point `debugPick` uses), picks the
first disguisable prop primitive hit, and gates it by a courtesy player-range check.
For a first-person hunter that's the eye ray; for a third-person prop it's the orbit
camera ray — whatever the centre crosshair overlaps is what gets picked. The `far` is
extended by ~the camera distance so a third-person prop within reach is still reached.
The client only PROPOSES the prop id; the host's `applyDisguise` re-checks
role/phase/range authoritatively.

## Camera placement (`scene.setCamera`)

Third-person branch (when `this.thirdPerson`):
- Camera-forward `f = (-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch)` — the
  same convention as the old first-person camera and the referee's aim vector.
- Look-at target = player at `_camHeadY` (1.5). Desired camera spot = `target −
  f·dist + heightBias·up` (behind + slightly lifted). yaw orbits horizontally,
  pitch orbits vertically.
- `camera.lookAt(target)` frames the player. Because aim is projected separately,
  the height bias / off-axis framing don't affect where the reticle lands.

First-person branch (eye at y=1.6, YXZ euler from yaw/pitch) is now the DEFAULT for
HUNTERS — `main.js applyRoleView()` calls `scene.setThirdPerson(role !== HUNTER)` on
the ROLE message and after `buildWorld`, so hunters see first-person (no own body) and
props stay third-person (they see their disguise). Remote players still see a hunter's
full animated soldier (that's `meshForPlayer`, unaffected by the local view).

## Collision pull-in (step 5 of the plan — the only real engineering)

The render engine DOES expose a reusable raycaster (`THREE.Raycaster`), so pass
two was cheap as hoped. `buildWorld` collects the arena walls + static props into
`this.colliders` (ground and player meshes deliberately excluded — we don't want
the camera colliding with the floor or with avatars). Each frame `setCamera` casts
from the player toward the desired camera spot; on a hit within range it clamps the
distance to `hit.distance − 0.3` (min `_camMinDist` 1.2). The self avatar is NOT a
collider, so the camera never fights the player's own model.

## Smoothing

`_camDist` is the smoothed current distance. **Snap IN** immediately when the
allowed distance shrinks (so the camera never clips through a wall it just moved
behind), **ease OUT** at 0.12/frame when clear (natural pull-back). Distance-only
smoothing (target is followed hard from the predicted position) keeps the camera
from lagging into geometry. Reset to `_camDesiredDist` in `buildWorld`.

## Own model rendering

`syncPlayers` used to `continue` past the self id (no avatar). Now it calls
`_syncSelf(p)`, which builds the local avatar via the SAME `meshForPlayer` path
every other peer is drawn with (snapshot carries `hunter`+`disguise` for self too),
so the host sees exactly what the referee/other clients believe this player is.
The mesh is positioned each frame from the **predicted** local position/yaw in
`setCamera` (not the lagging 20 Hz snapshot), so it tracks the camera cleanly.
Rebuilt on appearance change (disguise/role) via the `kind` signature.

Whether the self body is drawn at all is `_wantSelfMesh()` = `thirdPerson ||
_freeCam`: third-person (props) draws it; a first-person hunter does NOT (they'd see
their own capsule floating), EXCEPT while the ?debug=1 free cam is flying — then the
body reappears so you can see yourself from the fly-cam. The free-cam branch of
`setCamera` parks that body at the predicted pose (it's the only place a first-person
hunter's temporarily-shown body gets positioned, since the normal follow-cam path is
skipped while free cam owns the camera).

## First-person toggle (kept — it was clean)

Desktop **V** key → `input.onToggleView` → `scene.setThirdPerson(!thirdPerson)`. A
manual override on top of the role default (`applyRoleView`): flips the camera (orbit
↔ eyes) and own-model visibility (`_removeSelfMesh` via `_wantSelfMesh`) together. The
reticle no longer changes with it — it is ALWAYS the centred crosshair now. No touch
button for it — a phone toggle wasn't worth the seam.

## Tunables (all in `Scene3D` constructor)

`_camDesiredDist` 5.0, `_camHeadY` 1.5, `_camHeightBias` 0.4, `_camMinDist` 1.2,
ease-out 0.12, collision skin 0.3, aim-point lead distance 3.0.

## Files touched

Original pass: `js/scene.js` (camera + colliders + self avatar),
`js/main.js`, `js/input.js` (`onToggleView` + V key), `js/ui.js`.
2026-07-11 update (first-person hunters + centered reticle/aim): `js/scene.js`
(`_wantSelfMesh`, camera-center `aimedDisguiseTarget`, removed `aimScreenPoint`,
free-cam self body), `js/main.js` (`applyRoleView`, dropped the per-frame reticle
float), `js/ui.js` (removed `setCrosshair`). No referee/protocol/net changes. No
new deps.

## Playtest owed

Desktop + phone: orbit with mouse-look / drag-to-look, wall pull-in (walk the
camera into a corner — it should slide in, not clip), movement unchanged, and
especially **tag/disguise landing where the reticle points** (hunter tags a prop
in third-person; prop disguises). Confirm V toggles cleanly on desktop. Two tabs
on one machine is fine for the camera/view check (it's not a P2P test).
