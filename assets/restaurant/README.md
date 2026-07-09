# assets/restaurant/ — Restaurant Bits (Kay Lousberg, CC0)

Source pack: https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q
License: CC0 1.0 (public domain). Author: Kay Lousberg. Full credit in `/CREDITS.md`.

## Status: GLB models were NOT fetched in the build session (reported honestly)

The build sandbox had **no working way to download binary files** (no functional
network/shell tool — the shell permission stream fails; the editor's write tool is
text-only). So this folder does **not** yet contain the `.glb` meshes, and none
were faked with empty placeholders.

The `restaurant` map is fully playable *now* using the engine's existing
**primitive-shape** catalog (`shared/config/props.json`), themed as restaurant
items. Swapping in the real GLB meshes is a follow-up (see bottom).

## Intended models → current primitive stand-in (shape/color in props.json)

Dynamic props (disguise pool — small/movable):
| Restaurant Bits item        | props.json type   | stand-in shape       |
|-----------------------------|-------------------|----------------------|
| Chair (diner)               | `diner_chair`     | box                  |
| Stool                       | `kitchen_stool`   | cylinder             |
| Crate                       | `food_crate`      | box                  |
| Pot                         | `pot`             | cylinder             |
| Pan                         | `pan`             | flat cylinder        |
| Plate                       | `plate`           | flat cylinder        |
| Bowl                        | `bowl`            | sphere               |
| Cutting board               | `cutting_board`   | flat box             |
| Burger / food               | `burger`          | short cylinder       |
| Sauce/bottle                | `sauce_bottle`    | cylinder             |

Static fixtures (world colliders — immovable building pieces):
| Restaurant Bits item        | props.json type   | stand-in shape       |
|-----------------------------|-------------------|----------------------|
| Kitchen counter             | `counter`         | box                  |
| Stove                       | `stove`           | box                  |
| Oven                        | `oven`            | box                  |
| Fridge                      | `fridge`          | tall box             |
| Kitchen cabinet             | `cabinet`         | box                  |
| Sink                        | `sink`            | box                  |
| Round/kitchen table (large) | `round_table`     | cylinder             |
| Large table                 | `large_table`     | box                  |
| Interior wall / partition   | `kitchen_wall`    | wide thin box        |

## To swap in the real GLB meshes later (follow-up work)
1. Download the pack's GLBs into this folder (e.g. `stove.glb`, `fridge.glb`, …).
2. Add a **lazy** `GLTFLoader` path in `js/scene.js` `makePropMesh` — load GLB when
   a catalog entry carries a `model:"restaurant/xxx.glb"` field, fall back to the
   current primitive when it doesn't. MUST stay lazy: models load only inside
   `buildWorld` (match start), never at page boot, to keep the headless load check
   at zero external requests (same rule as three.js/PeerJS).
3. Add `model` fields to the restaurant entries in `props.json`; keep the primitive
   fields as fallback. No map or referee change needed — types stay the same.
