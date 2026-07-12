# Hunter model SIZING — bone-derived (the real fix, 2026-07-11)

The animated SWAT hunter (see `hunter-character-model.md` for the whole subsystem) shipped
**tiny + orbiting the player TWICE** before this build. This note is the root cause + the
fix + the verification that finally bites. Requested & approved by VRmike (Fable plan).

## Root cause (confirmed by byte-level GLB parse)

`assets/713f6535-…​.glb` is an FBX2glTF export. Its skinned mesh geometry is stored
**~3.6 mm tall** (POSITION accessor Y span 0.0036) and is inflated to human size only by a
baked **`CharacterArmature` node scale of [100,100,100] on the BONES** (the `Swat_Legs/Feet/
Body` mesh nodes carry it too). `THREE.Box3.setFromObject()` measures the RAW skinned
geometry and **ignores the skeleton**, so the old sizing code:

```js
const box = new THREE.Box3().setFromObject(inner);  // reads the 4 mm phantom
const s = targetH / size.y;                          // ⇒ a garbage ~450–500× scale
inner.position.set(-c.x, -box2.min.y, -c.z);         // ⇒ pivot from a garbage bbox
```

derived a wrong scale AND planted the pivot metres off the group origin. Result: the visible
model rendered ~100× too small and *orbited* the player as they yawed (the model sat on a
lever arm — rotating the group swept it around). The previous two builds' checks only
asserted **the code exists**, not that its **output** is right — so the bug shipped twice.
(The attached diagnostic phone screenshot `assets/attached_0.jpg` shows the debug collider
overlay + the red capsule fallback state that motivated this pass.)

## The fix — measure the SKELETON, not the geometry

`shared/hunter-sizing.js` (pure given an injected `THREE` + a cloned rig, so the browser and
the Node check run the SAME code — no copy-paste):

- **`measureRigBones(THREE, root)`** — `updateMatrixWorld(true)`, then traverse `o.isBone`
  and accumulate their WORLD positions. Bones carry the armature's baked scale, so their
  feet-to-head span is the TRUE rendered height. Returns `{height, footY, cx, cz, count}`.
- **`sizeHunterRig(THREE, inner, cfg)`** — order matters:
  1. apply `yawOffsetDeg` (180°) FIRST so measure + centre happen in the final oriented
     frame (rotation-correct for any off-centre rig);
  2. measure the bones (never `setFromObject`);
  3. centre `inner` from those bone bounds (feet → y=0, x/z centroid → axis);
  4. scale the **WRAPPER GROUP** by `targetH / trueHeight`, so the bones — and the skinned
     mesh they drive — actually scale.
  Degenerate rig (no/one bone, zero span) → fall back to **armature-world-scale × 1.8 u**,
  NEVER to the raw-geometry bbox that caused the bug.

For THIS GLB: 62 bones, raw bone span **1.556 m**, scale **1.157×**, placed height **1.800 m**,
feet **0.000**, x/z centroid **(0.000, 0.000)**. Correct + planted on the player's spot.

## Weapon (second bug this build caught)

The rifle parents to the wrist bone, but **GLTFLoader sanitizes node names** — the GLB's
`Wrist.R` loads as **`WristR`**, so the old strict `o.name === "Wrist.R"` never matched and
the rifle silently never attached (masked while the body was mis-sized). Fix: `findBone()`
in `hunter-sizing.js` matches tolerantly (strips `._:|-`/spaces, case-insensitive); scene.js
+ the size check both use it. Config keeps the readable `Wrist.R`.

Weapon SIZE is now normalised to a **world length** (`weapon.worldLength`, default 0.8 m):
scene.js measures the rifle's native bbox + the wrist bone's world scale and sizes the gun to
that length, so it stays correct whatever the body scaling does (the old bare `scale` on a
bone whose world scale changed would blow up / vanish). `weapon.scale` is now a multiplier
nudge on `worldLength`. All hot-tunable.

## Verification that BITES (the missing piece)

- **`tools/check-hunter-model-size.mjs`** (build-gating) — imports `three` +
  `GLTFLoader` + `SkeletonUtils`, loads the ACTUAL GLB (this pack has 0 image textures, so
  GLTFLoader runs headless), runs the SHIPPED `sizeHunterRig`, and asserts on the **OUTPUT**:
  final bone height within ±10% of ~1.8 m, feet within 0.1 m of y=0, x/z centroid within
  0.1 m of the origin, plus the wrist bone resolves. `three` is a **dev-only** dependency
  (`npm install`; the game still uses the CDN importmap) — pinned to the app's 0.161.0.
- **Runtime tripwire (`?debug=1`)** — `scene.updateAnimations` measures each hunter's real
  bone height after its first animated frame and `console.warn`s loudly if outside 1.2–2.5 m.
- `tools/check-blindfold.mjs` (a) was UPDATED: it used to assert the OLD broken
  `setFromObject`/`targetH/size.y`/`-box2.min.y` path — those were the checks that let the
  bug ship. Now it asserts `_buildHunterModel` uses `sizeHunterRig` and does NOT
  `setFromObject` the rig.

## OWED — live 2-player pass (can't be seen headless)

The size math is proven on the real asset offline, but a second device must confirm: the
remote hunter renders at human size, **stands on the player's spot without orbiting** as they
yaw, faces travel direction (yawOffsetDeg 180), and the rifle sits in the hand at a sane
size. Tune `yawOffsetDeg` / `weapon.worldLength` / grip offset (hot, no rebuild) if off.
