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
- **713f6535-f4f3-4367-a4c6-ced126ae0936.glb** — https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb
  - license: CC0
  - added: 2026-07-11 (requested by VRmike)
- **9a0e478c-de82-4773-9b70-a0219bb0057c.glb** — https://static.poly.pizza/9a0e478c-de82-4773-9b70-a0219bb0057c.glb
  - license: CC0
  - added: 2026-07-11 (requested by VRmike)
- **Never_Gonna_Give_You_Up.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **John_Cena.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Hey_Kappa_Kappa.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Bad_Boys.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Alert_Sound.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Santa_Claus.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Scary_music_mixdown.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **scaryMusic.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **myaah.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **NOPE.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **ILLUMINATI.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **I_GOTTA_BAD_FEELING_ABOUT_THIS_HAN_SOLO.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **HA_HA_NELSON.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **GET_OVER_HERE.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **SAD_MUSIC_2.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **SAD_MUSIC.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **You_get_nothing.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Look_At_This_Dube_Sound_Effect.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **ManDownGrenade.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Why_are_we_still_here.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Stahp.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Minecraft_Alpha_Damage.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Jesus_Christ_its_Jason_Bourne.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **End_credits.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **Coffin_Dance.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **SUSPENSE_2.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **SUSPENSE_1.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **SAY_WHAT.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **RUBBER_DUCK.mp3** — Discord attachment from Teravortryx (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by Teravortryx)
- **image.png** — Discord attachment from VRmike (2026-07-17)
  - license: UNVERIFIED
  - added: 2026-07-17 (requested by VRmike)
