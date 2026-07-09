# Credits & Asset Attribution

## Art / 3D models

### Restaurant Bits — Kay Lousberg (CC0 / Public Domain)
- **Pack:** "Restaurant Bits" (111 low-poly GLB models — stoves, ovens, fridges,
  kitchen cabinets, counters, sinks, round/kitchen tables, chairs, stools, crates,
  pots, pans, plates, bowls, cutting boards, food incl. burgers).
- **Author:** Kay Lousberg (kaylousberg.com)
- **License:** CC0 1.0 (Public Domain) — no attribution required, credited here anyway.
- **Source:** https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q

**Status — GLB models NOT yet fetched (honest note).** The `restaurant` map ships
in this build using the game's existing **primitive-shape** prop system (box /
cylinder / cone / sphere from `shared/config/props.json`), themed as restaurant
items — NOT the actual GLB meshes. The dev sandbox that built this map has no
working network/shell tool (binary download is not possible here, and the editor's
file-write tool is text-only), so the 111 GLB files could not be downloaded. No
placeholder/empty `.glb` files were created — nothing here is faked. See
`assets/restaurant/README.md` for the intended asset list, the shape→pack mapping,
and what a future session needs to do to swap in the real GLB meshes (which also
requires adding a lazy `GLTFLoader` path — see that file and
`memory/notes/restaurant-map.md`).

## Menu / UI art
- `assets/attached_*.{jpg,png,webp}` — provided with the project (see README/menu).
