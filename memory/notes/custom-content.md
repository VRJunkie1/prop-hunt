# custom content (models & textures)

Groundwork so the group can design their own maps or drop in maps/props found
online, without engine surgery. Implemented in the scene layer only — game rules
untouched. Player-facing authoring guide: `docs/custom-content.md`.

## What's data vs code
- **Data** (`shared/config/`): the world is already built from JSON. New content
  = edit JSON + drop asset files in `assets/`. No new format, no new fetch path
  (`config.js` still fetches the same three files).
- **Code** (`client/js/scene.js`): the only place that reads the visual fields.
  The referee (`shared/referee.js`) is geometry-blind — it maps map props to
  `{id,type,x,z,rot}` and never touches `color`/`shape`/`model`/`texture`. This
  is the load-bearing separation: visuals cannot drift game rules.

## Optional fields (all additive, all ignored by the referee)
- Prop type (`props.json`): `model` (glTF/.glb path), `modelScale`, `modelYOffset`,
  `texture` (image path, used only when there's no `model`).
- Map (`maps.json`): `model`, `modelScale`, `modelYOffset`, `groundTexture`,
  `groundTextureRepeat`.
- **Keep the primitive shape/size fields** (`shape`,`w/h/d`,`r`,`h`,`color`). They
  are (1) the fallback look and (2) the SINGLE source of prop size — a future
  physics pass reuses those same numbers rather than a second size field that
  could drift from the tag hitbox. Models are purely what you see.

## Loader design (scene.js)
- `three/addons/` added to the `index.html` importmap →
  `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'`. Same
  Three@0.161.0, same unpkg CDN, no build step.
- `makePropMesh` = build colored primitive synchronously (still returns
  `{mesh, baseY}`, so disguised players + instant display keep working), then
  `applyCustomVisual` kicks off async model/texture load and swaps in on success.
- Model swap: clone cached gltf scene, scale, set `y = -baseY + modelYOffset` so
  the model's origin lands on the ground, `mesh.material.visible = false` (hides
  the fallback shape while its children — the model — still render), `mesh.add(model)`.
- `assetURL()` resolves bare paths under `/assets/`; absolute paths / full URLs
  pass through (CDN or Sketchfab-hosted OK).
- gltf sources cached by URL (`gltfCache`, Promise) and cloned per instance so a
  map with 14 crates downloads the model once.
- **Every load path has a `.catch` that keeps the fallback** — a missing/broken
  asset degrades to the colored shape, never a crash or black screen.
- Map model: overlaid on top; procedural ground+walls built first and hidden only
  on successful model load (they're the fallback). Ground texture applied to the
  procedural floor material with `RepeatWrapping`.

## Gotchas / limits
- Custom map model is **decoration, not collision**. Bounds still come from
  `map.size` (referee clamps to it; client mirrors in `main.js`). Match the model
  to `size`. Physics/real collision is the separate next session.
- No Draco/Meshopt decoder wired — export **uncompressed** glTF or it won't load
  (it'll silently fall back to primitives).
- `.clone(true)` is fine for static meshes; shared skinned skeletons would need
  `three/addons/utils/SkeletonUtils.js` — not needed yet.
- Local dev server (`server/index.js`) now sends MIME for `.glb/.gltf/.bin/.jpeg`.
  Cloudflare Pages (the real deploy target) already serves these.
- Not yet tested with a real `.glb` (none in repo, no browser here). Plan step 7:
  phone playtest tunes model/texture size for mobile framerate.
