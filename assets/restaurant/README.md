# assets/restaurant/ — Restaurant Bits (Kay Lousberg, CC0)

Source pack: https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q
License: CC0 1.0 (public domain). Author: Kay Lousberg. Full credit in `/CREDITS.md`.

## Status: real GLB meshes present and WIRED INTO the restaurant map

These `.glb` files are the real low-poly Restaurant Bits models, and the
`restaurant` map now renders them (not primitive boxes). How it hangs together:

- `shared/config/props.json` — every restaurant catalog entry carries a `model:`
  path (e.g. `"restaurant/oven.glb"`) **plus** its old primitive shape as a
  fallback + size target. Small movable items are disguise **props**; building
  pieces are static **fixtures** — the two never mix (see below).
- `js/scene.js` — at match start (`buildWorld`, off `S2C.STARTED`) it renders the
  primitives immediately, then **lazily** imports a CDN `GLTFLoader`, downloads only
  the GLBs the active map references, and swaps each real mesh in over its
  placeholder. Loading is scale-normalised by bounding box, so a model lands at
  roughly the intended size regardless of its native units.
- **Fallback:** if a referenced GLB is missing or fails mid-load, that one item
  keeps its primitive shape — one bad file can never blank the map.
- **Lazy, client-only:** the loader import and the GLB downloads happen only on the
  viewing client at match start — never at page boot, never in `shared/referee.js`
  (which stays render-agnostic). The headless boot-time load check makes zero
  external requests.

## Item → model mapping

Disguise **props** (small / movable — the disguise pool, from `map.props`):
| props.json type | GLB                          |
|-----------------|------------------------------|
| `diner_chair`   | `chair.glb`                  |
| `kitchen_stool` | `chair_stool.glb`            |
| `food_crate`    | `crate_of_potatoes.glb`      |
| `crate_buns`    | `crate_of_buns.glb`          |
| `crate_veg`     | `crate_of_tomatoes.glb`      |
| `crate_cheese`  | `crate_cheese.glb`           |
| `pot`           | `pot.glb`                    |
| `large_pot`     | `large_pot.glb`              |
| `stew_pot`      | `pot_of_stew.glb`            |
| `pan`           | `pan.glb`                    |
| `plate`         | `plate.glb`                  |
| `bowl`          | `bowl.glb`                   |
| `stew_bowl`     | `stew_bowl.glb`              |
| `cutting_board` | `cutting_board.glb`          |
| `burger`        | `burger.glb`                 |
| `veg_burger`    | `vegetable_burger.glb`       |
| `tomato`        | `tomato.glb`                 |
| `lettuce`       | `lettuce.glb`                |
| `cheese`        | `cheese.glb`                 |
| `onion`         | `onion.glb`                  |
| `potato`        | `potato.glb`                 |
| `carrot`        | `carrot.glb`                 |
| `ketchup`       | `ketchup.glb`                |
| `mustard`       | `mustard_bottle.glb`         |

Static **fixtures** (immovable building pieces — from `map.fixtures`, NEVER
disguisable):
| props.json type  | GLB                            |
|------------------|--------------------------------|
| `floor_kitchen`  | `floor_kitchen.glb`            |
| `kitchen_wall`   | `modular_walls.glb`            |
| `pillar`         | `pillar.glb`                   |
| `pillar_b`       | `pillar_b.glb`                 |
| `oven`           | `oven.glb`                     |
| `stove`          | `stove_with_multi_burner.glb`  |
| `fridge`         | `fridge.glb`                   |
| `cabinet`        | `kitchen_cabinet.glb`          |
| `cabinet_corner` | `kitchen_cabinet_corner.glb`   |
| `extractor`      | `extractorhood.glb`            |
| `shelf`          | `shelf_papertowel.glb`         |
| `counter`        | `modular_kitchen_parts.glb`    |
| `prep_sink`      | `kitchentable_sink.glb`        |
| `dishrack`       | `dishrack.glb`                 |
| `round_table`    | `round_table.glb`              |
| `kitchen_table`  | `kitchen_table.glb`            |
| `large_table`    | `table.glb`                    |
| `small_table`    | `table_round_a_small.glb`      |
| `door`           | `door.glb`                     |

The pack ships many more food/cookware variants (steaks, hams, onions rings, buns,
sauces, lids, jars, …) not yet placed in the map — they're available to reference
from `props.json`/`maps.json` with no engine change.

## Duplicate files awaiting removal

The original bulk fetch saved ~19 models a second time under hash-suffixed names
(`round_table_KZXCuGx1WZ.glb`, `tomato_EVTveOjwHG.glb`, `door_MSIuI2jpqb.glb`, …).
The map references only the clean names; the hash-suffixed twins are unused junk to
be `git rm`'d (this build's sandbox has no shell to delete them — see
`memory/project-state.md`).
