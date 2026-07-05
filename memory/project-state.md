# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable, and **no player needs to
port forward**. Approved plan solves that by making everyone connect outward to
one authoritative referee server.

## Status: skeleton complete (plan steps 1–9 implemented in code)

A full walkable multiplayer sandbox + the core prop-hunt loop exist end to end.
Not yet run/playtested in this environment (no shell available this session).

Implemented:
- [1] Browser game, no installs. Three.js via CDN importmap (no build step).
- [2] Central referee server: Node `http` + `ws`, authoritative state, same-port
      static + WebSocket. Honours `PORT` for deploy.
- [3] Lobby: create room → 4-char code; join by code; host starts. One room = one
      match, managed by the server.
- [4] Minimal 3D scene: flat map, boundary walls, ~14 scattered props.
- [5] Movement under referee model: client sends intent, server integrates &
      broadcasts; local prediction for feel.
- [6] Roles assigned by server (random split). Props press E to disguise;
      hunters frozen during a server-timed hiding period.
- [7] Tag judged by server (aim-cone raycast vs disguised props only).
- [8] Win conditions + round loop enforced by server; return to lobby.
- [9] Content as data: rules/maps/props JSON, loaded by both sides.

## Open threads / not done

- [10] **Deploy + real multi-home playtest** to prove the no-port-forward goal in
      practice. Not done — needs a cloud host. README has deploy steps.
- **Never run here.** Next session: `npm install` then `npm start`, open two tabs
  on :3000, verify create/join/start/move/disguise/tag/win. Watch for movement
  formula drift and the STARTED→ROLE→SNAPSHOT ordering.
- **Undisguised props are visible** (render as neutral capsules and move). Fine
  for skeleton; future: auto-disguise at hunt start, or hide/lock undisguised
  props. See architecture "Role/identity hiding".
- No client-side prediction of collisions; players can overlap props/walls
  (walls are visual; server only clamps to map bounds).
- `ready` flag exists in lobby but host can start regardless — intentional for
  skeleton; wire it into a start gate later if wanted.
- Single map (`circus_lot`). Map selection UI not built (server uses
  `DEFAULT_MAP_ID`). Adding maps is data-only.

## Key decisions

- Server-authoritative + outbound connections = the whole networking model. Do
  not give clients authority over outcomes.
- Movement math is duplicated (server + client prediction) **on purpose** and
  must stay identical — see architecture.md.
- Roles hidden via snapshot shape (`hunter`/`disguise` only), not by trusting the
  client.
- Theme: colorful circus (art in `assets/`, used on the menu screen). Mascot
  image `assets/attached_2.webp` on the landing card.

## Where things live

Server referee: `server/Room.js`. Protocol: `shared/protocol.js`. Tunables:
`shared/config/rules.json`. Client entry: `client/js/main.js`. Notes:
`memory/notes/` (netcode, game-loop).
