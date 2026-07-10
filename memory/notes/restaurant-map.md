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

## Catalogs — TWO files (split in the 2026-07-09 GLB rebuild)
There are now two shape catalogs (both: box/cylinder/cone/sphere + color, plus a
`model` GLB path + optional `modelSize`; both resolved via `makePropMesh`):
- `shared/config/props.json` — the **disguise catalog**, movable items ONLY:
  `diner_chair`, `kitchen_stool`, `food_crate`/`crate_buns`/`crate_veg`/
  `crate_cheese`, `pot`/`large_pot`/`stew_pot`, `pan`, `plate`, `bowl`/`stew_bowl`,
  `cutting_board`, `burger`/`veg_burger`, `tomato`/`lettuce`/`cheese`/`onion`/
  `potato`/`carrot`, `ketchup`/`mustard`.
- `shared/config/fixtures.json` — the **static building-piece catalog**:
  `floor_kitchen`, `kitchen_wall`, `pillar`/`pillar_b`, `oven`, `stove`, `fridge`,
  `cabinet`/`cabinet_corner`, `extractor`, `shelf`, `counter`, `prep_sink`,
  `dishrack`, `round_table`, `kitchen_table`, `large_table`, `small_table`, `door`.
They are separate FILES on purpose (requirement 3): a fixture can never enter the
disguise pool. The referee builds the pool from `map.props` only and reads NEITHER
catalog; `config.js` loads both and `main.js` merges them (`{...props, ...fixtures}`)
purely for rendering. (Earlier this map kept fixtures inside props.json with generic
primitives — `sink`, `sauce_bottle`, etc.; that single-file version is superseded.)

## The map (`shared/config/maps.json` → `restaurant`)
size 36. Kitchen (north, z≈−15.5): fridge/cabinet_corner/oven/stove(+extractor at
y2.4)/counter/prep_sink/cabinet/shelf along the back wall, two counter islands + a
kitchen_table + dishrack mid-kitchen, and a 3×2 grid of `floor_kitchen` tiles. A
`modular_walls` + `pillar`/`pillar_b` divider at z≈−4 splits kitchen from dining
leaving passages (mixed sightlines / cover). Dining (south): four `round_table` + a
`large_table` + a `small_table` (static fixtures) ringed with `diner_chair`/
`kitchen_stool` props; a `door` fixture at the south wall. ~45 disguise props
scattered (chairs, stools, crates, pots/pans, plates/bowls, cutting board, burgers,
veg, bottles). 8 prop spawns spread to the edges; hunterSpawn centre.

Selectable with **zero extra wiring**: the lobby picker renders `Object.entries(
maps)` (`ui.renderMapPicker`, fed by `ui.maps = cfg.maps`), and
`Referee.setMapId`/`C2S.PICK_MAP` validate any map that exists in `maps.json`. See
`map-selection.md`.

## Assets — real GLB meshes now WIRED IN (2026-07-09 rebuild)
The 111 CC0 "Restaurant Bits" GLBs (Kay Lousberg,
https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q) are real binary files in
`assets/restaurant/` (fetched by an earlier bulk pull) and the map now renders them.

**How it's wired (the swap):**
- `props.json` — each restaurant catalog entry gained a `model:"restaurant/x.glb"`
  field. The primitive shape/dims stay as the fallback AND as the GLB size target
  (a fixture/prop's largest bounding dimension is scaled to match the primitive's,
  or to an explicit `modelSize` for floors/walls/pillars/door). Only clean model
  names are referenced — never the fetch's hash-suffixed dupes.
- `js/scene.js` — `buildWorld` builds primitives immediately, then queues each
  model-bearing item into `_modelSlots` and calls `_loadModels()` (fire-and-forget).
  `_loadModels` **lazily** `import('three/addons/loaders/GLTFLoader.js')` (CDN, via
  the new `three/addons/` importmap entry) ONCE on first match start, downloads only
  the GLBs this map references (deduped by path), and swaps each real mesh in over
  its placeholder (`_applyModel`). `_instantiateModel` clones + bbox-normalises the
  scale + sits it on the ground, wrapped in a group.
- **Primitive stays as the invisible camera collider.** On swap the primitive is
  set `visible=false` but kept in `scene.colliders` (Three's raycaster does NOT skip
  invisible objects), so third-person pull-in behaves identically regardless of the
  GLB silhouette. This also IS the fallback: if a GLB is missing/errors, the
  primitive simply stays visible (`_modelCache` marks the path `'failed'`).
- **Disguises too:** `meshForPlayer` wears the real GLB when its template is already
  cached (`_modelCache`), else the primitive. So a player disguised as a burger
  becomes `burger.glb` once loaded.
- **Lazy/boot rules honoured:** the GLTFLoader import + GLB downloads happen only on
  the viewing client at match start — never at page boot, never in `shared/referee.js`.
  `index.html`'s importmap only DECLARES `three/addons/` (no fetch), so the headless
  boot-time load check still makes zero external requests. `_buildToken` invalidates
  in-flight loads from a superseded match.

**Junk from the bulk fetch — NOT deletable in this sandbox (no shell).** `_meshwork/`
(scratch HTML + fetch.log), root `bundle.html`, `fetch_meshes.sh`, and ~19
hash-suffixed GLB dupes are inert but still on disk. Nothing references them. They
need a `git rm` from a shell session — see the cleanup block in `project-state.md`.

## Playtest owed
Pick `restaurant` in the lobby → everyone spawns in it; real 3D models (appliances,
tables, chairs, food) render instead of boxes; walls/appliances/tables read as an
enclosed kitchen+dining; disguise into a chair/crate/burger shows the real mesh; tag
works; camera pulls in on fixtures; circus_lot + toy_workshop still load unchanged.
Watch for per-model scale/orientation that needs tuning (esp. `modular_walls` rot,
floor tiles, `extractorhood` height) — adjust `modelSize`/`rot`/`y` in the configs.
