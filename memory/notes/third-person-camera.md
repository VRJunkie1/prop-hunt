# Third-person follow camera (local player)

Built on `vrmike/dev`. The local player used to be first-person (camera at the
eyes, no self avatar). It is now **third-person by default**: a camera orbiting
behind and slightly above the player, so they see their own model/prop and can
peek around cover. **Camera/view change only** — movement, roles, collision,
networking, and the referee are all untouched.

## The one real gotcha — where "aim" lives (settled up front)

The referee's tag cone (`applyTag`) and disguise both compute from the player's
**yaw-forward vector** `(-sin yaw, -cos yaw)` — a 2D cone in x/z. That did NOT
change. In first-person the screen-center crosshair happened to coincide with
that vector; in third-person the eye sits off the player, so screen-center no
longer equals the aim line.

Fix: the reticle is driven off yaw-forward, not screen center.
`scene.aimScreenPoint(pos, yaw)` projects a world point a few metres ahead of the
player (`_camHeadY - 0.4` height) through the camera and returns pixel coords;
`main.js` passes them to `ui.setCrosshair(pt)` each frame. Returns `null` in
first-person → reticle recenters (the `#crosshair` CSS keeps `translate(-50%,-50%)`,
so left/top land it on the point). The referee was never touched, so tag/disguise
land exactly where the reticle points regardless of where the camera sits.

## Camera placement (`scene.setCamera`)

Third-person branch (when `this.thirdPerson`):
- Camera-forward `f = (-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch)` — the
  same convention as the old first-person camera and the referee's aim vector.
- Look-at target = player at `_camHeadY` (1.5). Desired camera spot = `target −
  f·dist + heightBias·up` (behind + slightly lifted). yaw orbits horizontally,
  pitch orbits vertically.
- `camera.lookAt(target)` frames the player. Because aim is projected separately,
  the height bias / off-axis framing don't affect where the reticle lands.

First-person branch is the original code verbatim (eye at y=1.6, YXZ euler from
yaw/pitch), reached only when toggled off.

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
Rebuilt on appearance change (disguise/role) via the `kind` signature; removed in
first-person.

## First-person toggle (kept — it was clean)

Desktop **V** key → `input.onToggleView` → `scene.setThirdPerson(!thirdPerson)`.
One flag flips all three together: camera (orbit ↔ eyes), own-model visibility
(`_removeSelfMesh` on the way to first-person; rebuilt on next snapshot returning),
and reticle (`aimScreenPoint` returns null → centered). No touch button for it —
third-person is the default and a phone toggle wasn't worth the seam.

## Tunables (all in `Scene3D` constructor)

`_camDesiredDist` 5.0, `_camHeadY` 1.5, `_camHeightBias` 0.4, `_camMinDist` 1.2,
ease-out 0.12, collision skin 0.3, aim-point lead distance 3.0.

## Files touched

`js/scene.js` (camera + colliders + self avatar + aim projection),
`js/main.js` (reticle each frame + toggle wiring), `js/input.js`
(`onToggleView` + V key), `js/ui.js` (`setCrosshair`). No CSS/HTML/referee/
protocol/net changes. No new deps.

## Playtest owed

Desktop + phone: orbit with mouse-look / drag-to-look, wall pull-in (walk the
camera into a corner — it should slide in, not clip), movement unchanged, and
especially **tag/disguise landing where the reticle points** (hunter tags a prop
in third-person; prop disguises). Confirm V toggles cleanly on desktop. Two tabs
on one machine is fine for the camera/view check (it's not a P2P test).
