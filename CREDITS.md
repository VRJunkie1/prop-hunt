# Credits & Asset Attribution

## Art / 3D models

### Restaurant Bits — Kay Lousberg (CC0 / Public Domain)
- **Pack:** "Restaurant Bits" (111 low-poly GLB models — stoves, ovens, fridges,
  kitchen cabinets, counters, sinks, round/kitchen tables, chairs, stools, crates,
  pots, pans, plates, bowls, cutting boards, food incl. burgers).
- **Author:** Kay Lousberg (kaylousberg.com)
- **License:** CC0 1.0 (Public Domain) — no attribution required, credited here anyway.
- **Source:** https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q

**Status — GLB models fetched and WIRED IN.** The real Restaurant Bits `.glb`
meshes now live in `assets/restaurant/` and the `restaurant` map renders them:
`shared/config/props.json` carries a `model:` path on each restaurant entry, and
`js/scene.js` lazily loads the referenced GLBs (via a CDN `GLTFLoader`) at match
start and swaps them in over the primitive placeholders. If any single GLB is
missing or fails to load, that one item falls back to its primitive shape, so a bad
file never blanks the map. See `assets/restaurant/README.md` for the item→model
mapping and `memory/notes/restaurant-map.md` for the loader wiring.

## Menu / UI art
- `assets/attached_*.{jpg,png,webp}` — provided with the project (see README/menu).
