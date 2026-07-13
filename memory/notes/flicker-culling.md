# Flicker / strobe fix — frustum culling of player-attached models (2026-07-13)

Requested by Jie via VRmike (branch `build/75-flicker-fix-requested-by`). The hunter and
the prop a player is disguised as **flashed/strobed** from certain camera angles.

## Root cause (VRmike's diagnosis, confirmed)

three.js frustum culling decides "off-screen" from a bounding sphere computed ONCE when a
mesh's geometry is created. Two player-attached cases break that assumption:

- **(a) Skinned hunter.** The SWAT soldier is a `SkinnedMesh` driven by an `AnimationMixer`.
  Its bind-pose bounding sphere doesn't grow when the animation swings limbs out — so from
  an angle where the bind-pose sphere is just off-frustum but a swung arm is on-screen, the
  renderer culls the whole soldier mid-stride and he **blinks**.
- **(b) Rescaled disguise clone.** Disguise GLBs are `clone(true)`'d and **rescaled at
  runtime** (`instantiateModel`), so their bounds can lag the new scale and cull from
  oblique views.

## The fix — one choke point

`js/scene.js`:

- New module-level `export function preparePlayerModel(root)`: traverses the model, sets
  `o.frustumCulled = false` on every mesh (renderer can never skip it), and recomputes
  `geometry.computeBoundingSphere()/computeBoundingBox()` (belt-and-braces so anything that
  DOES still read bounds — aim raycast, highlight/focus box — stays correct after a
  swap/rescale).
- `meshForPlayer(p, opts)` is now a thin wrapper: `return preparePlayerModel(this._buildPlayerMesh(p, opts))`.
  The old body moved verbatim into `_buildPlayerMesh`. **This is the single guaranteed path**
  — both remote players (`syncPlayers` → `meshForPlayer(p,{animated:true})`) and the local
  player (`_syncSelf` → `meshForPlayer(p)`) go through it, so the skinned hunter, GLB
  disguise, primitive disguise, and capsule are ALL covered with no branch able to bypass.
- Defence in depth kept at the two hand-built sites: `_buildHunterModel` still flags the rig
  meshes, and `_buildViewModel` (first-person held rifle/box parented to the camera) still
  flags its meshes.

**World props/scenery are untouched** — `instantiateModel` and the `buildWorld` scenery/prop
loops do NOT disable culling, so world geometry keeps the optimization. The fix is only the
few player-attached objects, exactly as scoped.

## Secondary suspects (checked, NOT the cause)

- **Visibility flag flap:** `entry.mesh.visible = p.alive`. The referee sets `player.alive`
  true at spawn and only false on death (monotonic within a round) and always includes
  `alive` in the snapshot (`shared/referee.js` `broadcastSnapshot`, `alive: p.alive`). So
  visibility can't strobe between snapshots. Clean.
- **Z-fighting between a disguise clone and the world prop it copied:** not a systematic
  issue — you disguise as a prop **TYPE**, and your disguise mesh renders at YOUR position,
  not on top of the specific world instance. No code duplicates a world prop into the same
  spot. (A player standing exactly on a like prop can overlap — that's gameplay blending, not
  a render bug.)

## Guard

`tools/check-flicker.mjs` (same static-guard family as `check-blindfold.mjs`; scene.js can't
be imported in Node — it imports `three` + root-absolute paths). Asserts: preparePlayerModel
exists/exported and does both jobs; `meshForPlayer` routes through it with exactly one wrapped
return via `_buildPlayerMesh`; both consumers use `meshForPlayer`; the hunter rig + viewmodel
keep the flag; `instantiateModel` does NOT (world props keep culling); and the `alive`→visible
wiring is intact. 18 checks, GREEN. Add to the regression sweep.

## Still owed

A **live 2-player eyeball** (headless can't render a moving skinned mesh): walk the hunter
across the screen edge and disguise as a few different-sized props to confirm the strobe is
gone. Everything else (checks + clean headless boot) is done.
