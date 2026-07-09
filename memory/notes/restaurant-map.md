# Restaurant map + the static/dynamic (fixtures vs props) split

Built on `vrmike/dev`. A third selectable map (`restaurant`) themed on Kay
Lousberg's CC0 "Restaurant Bits" pack, plus the small engine seam that lets a map
carry **immovable world fixtures** separately from its **movable disguise props**.

## The one engine change: `map.fixtures`
Before this, `maps[id].props` was the ONLY per-map object list, and it was
overloaded: every entry was BOTH rendered scenery AND a disguisable target (the
referee builds the disguise pool from `map.props` at `startMatch`). There was no
way to say "this object is solid scenery but NOT a disguise."

STEP 3 of the task (static world colliders vs dynamic disguise props) needed that
distinction, so maps now optionally carry a second array:

- **`map.fixtures[]`** — static building pieces (walls, counters, stove, oven,
  fridge, cabinets, sinks, large/anchored tables). Rendered by `js/scene.js`
  `buildWorld` and pushed into `scene.colliders`, but **the referee never sees
  them** — it still builds props only from `map.props`, so fixtures can't be
  disguised into and don't join the prop pool.
- **`map.props[]`** — unchanged meaning: the dynamic disguise pool (chairs,
  stools, crates, pots, pans, plates, bowls, cutting boards, food/burgers).

Why this is the *correct* mapping of "collision + static/dynamic" onto THIS engine
(not a physics engine): the project has **no rigid-body sim and no player-vs-object
collision** — players pass through props/walls (documented gap in project-state).
The only "collision" primitive that exists is `scene.colliders`, the set the
third-person camera raycasts against for pull-in. So "give everything collision"
here = "add it to `scene.colliders`", which both fixtures and props now do.
Movement is still bound only by the map-edge clamp in `Referee.integrate`. If real
player collision is ever wanted, that's a separate, bigger change (referee
`integrate` + client prediction must add the same per-object math in lockstep).

### Where it's wired (no protocol change)
- `js/scene.js` `buildWorld(map, propInstances, catalog)` — new `for (const f of
  map.fixtures || [])` loop renders fixtures + adds them to `colliders`. `|| []`
  means circus_lot / toy_workshop (no `fixtures` key) are untouched.
- Fixtures render from **local** map data. `js/main.js` STARTED does
  `state.map = state.cfg.maps[msg.mapId]` (every client has maps.json), so host and
  guests draw identical fixtures with **zero** referee/protocol involvement. The
  referee's `started{mapId, props}` still only carries the dynamic props.
- No `shared/referee.js` change was needed — it already builds
  `this.props = (map.props||[]).map(...)`, which now naturally excludes fixtures.

## Catalog additions (`shared/config/props.json`)
`props.json` is really a **shape catalog** (box/cylinder/cone/sphere + color); both
props and fixtures resolve their mesh through it via `makePropMesh`. Added:
- Dynamic: `diner_chair`, `kitchen_stool`, `food_crate`, `pot`, `pan`, `plate`,
  `bowl`, `cutting_board`, `burger`, `sauce_bottle`.
- Static (fixtures): `counter`, `stove`, `oven`, `fridge`, `cabinet`, `sink`,
  `round_table`, `large_table`, `kitchen_wall`.
Adding a catalog entry is inert until a map references it (referee's pool = only
map.props), so the new fixture shapes never leak into any disguise pool.

## The map (`shared/config/maps.json` → `restaurant`)
size 36. Kitchen along the north wall (z≈−15.5): fridge/oven/stove/counter/sink/
cabinets, plus two mid-kitchen counter islands. Two `kitchen_wall` partitions at
z≈−4 split kitchen from dining while leaving a central + two outer passages (mixed
sightlines / cover). Dining (south): four round tables + one large table (all
static fixtures) ringed with `diner_chair`/`kitchen_stool` disguise props. ~38
dynamic props scattered (chairs, stools, crates, pots, pans, plates, bowls, cutting
board, burgers, bottles) as hiding options. 8 prop spawns spread to the corners/
edges; hunterSpawn centre.

Selectable with **zero extra wiring**: the lobby picker renders `Object.entries(
maps)` (`ui.renderMapPicker`, fed by `ui.maps = cfg.maps`), and
`Referee.setMapId`/`C2S.PICK_MAP` validate any map that exists in `maps.json`. See
`map-selection.md`.

## Assets — GLB NOT fetched (honest)
The task wanted the actual 111 GLB meshes from
https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q (CC0, Kay Lousberg). The build
sandbox has **no working network/shell tool** (shell permission stream fails —
same wall prior sessions hit; the write tool is text-only) so binary GLB download
was impossible. No fake/empty `.glb` files were created. The map runs on primitive
stand-ins now. Attribution + the shape→model mapping + the follow-up to add a lazy
`GLTFLoader` are in `/CREDITS.md` and `assets/restaurant/README.md`. Keep any future
GLB load lazy (inside buildWorld / match start only) — never at page boot.

## Playtest owed
Pick `restaurant` in the lobby → everyone spawns in it; walls/appliances/tables
read as an enclosed kitchen+dining; disguise into a chair/crate/burger works; tag
works; camera pulls in on fixtures; circus_lot + toy_workshop still load unchanged.
