# Level editor (in-game, debug mode)

A desktop-only debug tool baked into the client: press **Ctrl+E** to walk around
inside a map and fix fixture/prop placement, rotation and scale by eye, then export
the result back to `maps.json`. Built 2026-07-10. Files: `js/editor.js` (new, the whole
tool), `js/main.js`, `js/input.js`, `js/scene.js`, `shared/physics.js`, `css/style.css`.

## The load-bearing design call: it's a client-local SANDBOX, not a paused match

Ctrl+E does **not** pause a running round or reach into the referee. It steps the
client OUT of gameplay into a private local scene (`Editor` owns its own
`THREE.Scene` + free-fly camera) that loads the map fresh from config. The host
referee, its phase timers, and netcode keep doing whatever they like — the editor
just isn't listening. That is *why* "client-only, never touches referee/netcode/
match flow" is honestly true rather than aspirational.

- **Gate** (`main.js canEnterEditor`): desktop only (`!input.touch`); allowed pre-
  session (landing), solo host lobby, or a solo host match; **blocked** when a guest
  (`session.conn`) or a host WITH guests (`session.conns.size > 0`) — i.e. never
  mid-multiplayer.
- **Frame routing** (`main.js frame`): while `state.editing`, the loop calls
  `editor.frame(dt)` and returns before any gameplay predict/render. The fixed-rate
  input loop also early-returns, so no INPUT is sent — the client is fully detached.
- **Exit** returns to whatever screen you came from (menu/lobby/game). We never
  stopped the underlying solo match, so returning to `game` just resumes it. (The
  plan said "returns to lobby"; restoring the prior screen is the same idea without
  poking the referee to force a lobby transition — deliberately kept out of scope.)

## Rendering reuse — one renderer, one GL context, no second pointer-lock path

- Reuses the game's single `WebGLRenderer` (passed in from `Scene3D` via
  `ensureScene()`), so there's never a second GL context on `#view`. The editor
  renders its own scene THROUGH it; `Scene3D.render()` is simply not called while
  editing.
- Reuses `scene.js`'s mesh helpers — now exported: `makePropMesh`,
  `instantiateModel`, `targetSizeForEntry` — so a spawned/edited object is sized
  EXACTLY as the game draws it (primitive placeholder → real GLB swap, same
  measured `modelScale`/`modelDims`/target sizing).
- Has its own tiny GLTF loader (module-level cache) isolated from `Scene3D`'s, so
  the game's load-bearing renderer is untouched. Costs one extra GLB fetch per file
  across the page's life (debug tool — fine).
- **No pointer lock.** The editor uses a free cursor with **right-drag to look**
  (not pointer-lock mouse-look) precisely so it never contends with `input.js`'s
  desktop lock path (the "one pointer-lock path" boundary) AND so the cursor stays
  free for the HUD palette/inspector. `input.js`'s only change is Ctrl+E detection →
  `onToggleEdit` (handled before the lock gate so it works from the lobby, and
  before KeyE's disguise action). Fly movement reads the shared `input.keys` set via
  `editor.setKeySource(() => input.keys)`.

## Controls (all in `editor.js`)

- **Fly:** WASD + arrows; Space/E up, Shift/Q down; right-drag look.
- **Select:** left-click an object → yellow `BoxHelper` outline + inspector (name,
  pos, rot Y in degrees, scale, and REAL in-world size in metres).
- **Move:** left-drag along the ground plane (grab-offset preserved); hold **Shift**
  while dragging for vertical. **G** snaps the base flush to the floor (y-offset 0).
- **Rotate:** **R** = +15° about Y; Shift = 1° fine; Alt = reverse.
- **Scale:** **+/−** uniform, clamped 0.1×–5× (Shift = 0.02 fine).
- **Add:** left palette lists every catalog entry (props green, fixtures blue);
  click one (or number keys 1–9 for the first nine) to spawn at the screen-centre
  crosshair's ground point, at normalized default scale (objScale 1).
- **Delete:** Delete/Backspace → pushed to a restore stack; **U** undeletes (so one
  fat-fingered Delete isn't unrecoverable). Full undo/redo intentionally out of scope.
- **Map select:** footer dropdown edits any map (clones it; never mutates `cfg.maps`).
- **Export:** "Copy map JSON" (clipboard) / "Download maps.json" — both emit the
  FULL `maps.json` with the edited map's `fixtures`/`props` arrays replaced and every
  other map byte-identical (drop-in file). A human pastes it to the bot or commits
  it — the game never writes files.

## Real in-world sizes come from asset-dims.json

`Editor._realSize` fetches `shared/config/asset-dims.json` LAZILY on first enter
(never at boot → headless load stays green). Size priority: exact `modelDims` →
measured native bbox × effective `modelScale` × objScale → primitive footprint
(labelled `approx`) → "size unknown" if the fetch failed / no data. The palette
spawns at the normalized default (the measured `modelScale` the renderer already
applies); per-object scale is a fine-tune on top.

## The prerequisite that had to land first: per-object `scale`

The map format already carried per-object `y` and `rot` and the loader applied
them. It did **not** carry `scale`. Without applying it, the editor would edit a
number the game ignores and the round-trip would drift. The approved plan scoped the
fix as "a small **client-side** fix", so `scale` is applied **VISUAL-ONLY** in
`scene.js` — `shared/physics.js` and `shared/referee.js` are NOT touched (constraint
9). Additive + inert for every existing map (none has a `scale` field):

- **`scene.js` (visual):** fixtures and props read `entry.scale` (default 1). The
  primitive is scaled and its base kept flush (centre at `baseY*s`); the GLB is
  scaled by `objScale` on top of the measured sizing (base still rests on the floor
  because `instantiateModel` puts the base at the group origin). Threaded through
  `_queueModel`/`_applyModel` as `objScale`.
- **Props scale reaches the renderer WITHOUT touching the referee:** the referee
  builds `this.props` by mapping `map.props` in order, so `msg.props[i]` ⟷
  `map.props[i]` on every client. `main.js` (STARTED) zips the authored `scale` back
  onto the prop instances client-side, then `scene.js` renders it.
- **Colliders are deliberately NOT scaled.** `physics.js` bakes fixture/prop
  colliders from the base catalog footprint (the measured `modelScale` IS in those
  numbers; per-object `scale` is not). So a scaled object's *visual* is exact but its
  *collision volume* stays base-size. Accepted for a placement/debug tool: most edits
  spawn at scale 1, and touching the physics/match-flow path was out of scope. A
  future one-liner (`shapeFor(R, c, s)` + a referee prop-scale pass-through) would
  close it if wanted.

## Known limitations / gaps

- Per-object `scale` is visual-only — colliders use base size (see above).
- Editing is only available in solo/local play; you can't edit *while* a
  multiplayer round runs (the whole point of the sandbox trade).
- Not playtested live (headless boot check can't feel-test a 3D editor). Verify by
  hand: Ctrl+E in the lobby → fly/select/move/rotate/scale/spawn/delete/undelete →
  export → paste back into maps.json → reload → layout matches (incl. rot + scale).
