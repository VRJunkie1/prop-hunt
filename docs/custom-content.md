# Custom maps, models & textures

The game builds its world from three plain JSON files — no engine code needed to
add content:

- `shared/config/maps.json` — arenas: size, colors, spawns, prop placements.
- `shared/config/props.json` — the catalog of prop *types* (their shape/size).
- `shared/config/rules.json` — timers, speeds, ratios.

Out of the box every prop and map is a **colored primitive shape**. You can now
point any map or prop type at a **real 3D model** (glTF/`.glb`) and/or **image
textures**. These are *view-only*: the referee (the host's rule-keeper) never
opens a model file — it reads only `type`, `x`, `z`, `rot` — so richer visuals
can never change game rules. If a file is missing or fails to load, the game
quietly falls back to the colored shape and keeps running.

Drop asset files anywhere under `assets/` and reference them by path.

## Path rules

A `model` / `texture` value can be:

- a bare path — resolved under `assets/`, e.g. `"models/crate.glb"` → `/assets/models/crate.glb`
- an absolute path — `"/assets/models/crate.glb"`
- a full URL — `"https://example.com/crate.glb"` (e.g. a CDN or Sketchfab-hosted file)

## Custom prop model

Add a `model` (and optional tuning) to any type in `props.json`. **Keep the
shape/size fields** — they stay the source of truth for the fallback shape *and*
for the size the referee/future physics use. The model just changes what you see.

```jsonc
"crate": {
  "shape": "box", "w": 1.2, "h": 1.2, "d": 1.2, "color": "#b5793a",
  "model": "models/crate.glb",   // real 3D model, shown instead of the box
  "modelScale": 1,               // optional, default 1
  "modelYOffset": 0              // optional nudge if the model's pivot isn't at its base
}
```

Author the model so its **base sits at the origin** (y=0) facing forward; the
loader drops it to the ground automatically using the primitive's height.

## Custom prop texture (no model)

To keep the primitive shape but paint an image on it, add a `texture` (used only
when there is no `model`):

```jsonc
"crate": { "shape": "box", "w": 1.2, "h": 1.2, "d": 1.2, "color": "#b5793a", "texture": "textures/wood.jpg" }
```

## Custom map

A whole arena can point at a model and/or a tiled ground texture:

```jsonc
"my_map": {
  "name": "My Map",
  "size": 40,                       // gameplay bounds — players are clamped to this square
  "ground": "#6b4b8a",              // fallback ground color
  "sky": "#d98cff",
  "groundTexture": "textures/floor.jpg",   // optional tiled floor image
  "groundTextureRepeat": 8,                // optional tiles across, default 8
  "model": "maps/my_map.glb",              // optional full environment model
  "modelScale": 1,
  "modelYOffset": 0,
  "hunterSpawn": { "x": 0, "z": 0 },
  "spawns": [ { "x": -15, "z": -15 }, { "x": 15, "z": 15 } ],
  "props": [ { "type": "crate", "x": -6, "z": -4 } ]
}
```

A "custom map" is then just: drop the files in `assets/`, add one entry here.
(Map selection UI isn't built yet — the referee defaults to the first map in the
file, so make yours first, or wire a picker later.)

**Important — the model is decoration, not collision.** Gameplay bounds still
come from `size`, and props still live where their `x`/`z` say. If the model's
floor is bigger/smaller than `size`, players will still be clamped to the `size`
square. Match your model to `size` (and align spawns/props to it by eye) so the
visuals and the play-space agree.

## Honest caveats for "maps found online"

- **Format:** must be glTF (`.gltf`) or binary glTF (`.glb`). Other formats (FBX,
  OBJ, `.blend`) need converting first (e.g. Blender's glTF export). Draco/Meshopt
  *compressed* glTF is **not** supported here (no decoder wired up) — export
  uncompressed.
- **Performance:** big, high-poly maps and 4K textures can tank phone framerates.
  Prefer low-poly models and ≤1–2K textures. Playtest on a real phone.
- **Licensing:** you can't just grab any model. Use free-license sources — e.g.
  Sketchfab's Creative Commons / CC0 filter, Poly Pizza, Kenney.nl — and respect
  attribution terms.

## What still isn't here (next session)

**Physics.** Nothing can be bumped, tipped, or trampled yet — props are static
and players move on a flat plane. Knockable props are scoped as a separate,
host-side module (deliberately *not* inside the referee's movement/tag math) and
depend on a group design decision about whether shoving a hidden player-prop
reveals it. See `memory/project-state.md` and the approved plan.
