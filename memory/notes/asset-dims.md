# asset-dims — measured collider/mesh bounds (the drop-in seam)

Added 2026-07-10 on `physics-net`. Read this before touching collider sizes or the
render scale of GLB props/fixtures.

## What it is

`shared/config/asset-dims.json` is the single source of truth for **measured**
object sizes. It is the output slot for the **bounding-box normalization build**:
per catalog type (keys match `props.json` / `fixtures.json`), it holds the item's
**normalized WORLD-SPACE bounding box** as actually placed in a map —
`{ w, h, d }` in world units (same units `maps.json` positions use).

```json
{ "dims": { "diner_chair": { "w": 0.62, "h": 1.05, "d": 0.58 }, ... } }
```

Contract note: store the **final placed world size**, NOT the GLB's raw native
bbox. That keeps physics + rendering consuming it directly with zero scale
inference (no chance of a wrong-scale surprise). If the normalization build only
has native bboxes, it must multiply by the render scale before writing here.

## Why it exists / history

The big physics+netcode pass (2026-07-09) baked colliders from the **hand-authored
primitive footprints** in `props.json`/`fixtures.json` (eyeballed `w/h/d/r`) —
deliberately, because measured GLB bounds weren't available and GLBs load async and
can fail. The follow-up task required colliders baked from **measured** bounds
("never guess sizes"), assuming a measured `asset-dims.*` file already existed. It
did **not** exist, and GLB bounding boxes cannot be measured in the headless
sandbox (no shell; `Write` is text-only, can't decode binary `.glb`). So instead of
guessing, this session wired the **seam** and shipped the file **empty** — the
moment the bounding-box build populates `dims`, colliders and meshes bake from real
bounds with no further code change.

## Wiring (one mutation, three consumers)

`js/config.js loadConfig()` fetches `asset-dims.json` (tolerant of absence) and, for
each populated type, attaches `entry.measured = {w,h,d}` onto the matching
`props`/`fixtures` catalog entry. Because that same `cfg` object flows to:
- the **host referee**'s authoritative `PhysicsWorld` (`config.props/fixtures`),
- every client's **prediction** `PhysicsWorld` (merged catalog in `main.js`),
- the **renderer** (`scene.js` merged catalog),

one attach reaches all three. No parallel path.

- **Collider** (`shared/physics.js shapeFor`): if `c.measured` is present, bake a
  **cuboid** from it (`cuboid(w/2,h/2,d/2)`) — matches the design ("cuboid from the
  measured bounds; trimesh only where a cuboid is clearly wrong"). Else fall back to
  the primitive shape (box/cylinder/cone/ball from `c.w/h/d/r`).
- **Mesh** (`scene.js`): `dims` for `_instantiateModel` is now
  `c.measured || c.modelDims || null`, so a GLB with measured bounds is scaled
  per-axis to the **same** box the collider uses → mesh and collider stay in
  lockstep. Covers the three scale paths: queued fixtures/props (`_queueModel`),
  the deferred loader (`slot.dims`), and disguise meshes (`meshForPlayer`).

## Behavior today (empty file)

`dims: {}` → the config loop attaches nothing → `c.measured` is `undefined`
everywhere → every `||` falls through to the exact pre-seam path. **Byte-for-byte
the prior build; zero regression.** Verified by inspection, not runtime (headless).

## When you populate it

- A **round** item that genuinely needs a cylinder/cone collider (barrel, ball,
  crystal, stool): simply **omit** it from `asset-dims.json` — it keeps its
  primitive shape. Adding a measured entry forces a cuboid.
- Partial/garbage entries (missing or non-positive `w/h/d`) are ignored by the
  loader — safe to leave placeholders.
- Populating a type changes BOTH its collider and its mesh scale together; check the
  item still sits on the floor (base at y=0) after — the y-placement uses `h/2`.
