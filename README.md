# prop-hunt

A **skeleton multiplayer Prop Hunt** game. Browser clients play **peer-to-peer
over WebRTC**; the room creator's browser is the referee. A tiny Node
**matchmaker** only introduces players. Built to be basic but extendable — see
`memory/` for design notes.

Built collaboratively via DevBot. Started by Manny.

## Architecture: P2P, host-authoritative

Players connect **directly to each other** over WebRTC data channels. The room
**creator hosts**: their browser runs the referee (owns true game state, judges
every outcome) and streams snapshots to the other players; the host's own inputs
take the same path through a zero-latency local loopback. Guests send intent and
render snapshots, exactly as before.

The only always-on piece is the **matchmaker**: a small Node process that mints
4-letter room codes and passes the WebRTC handshake (SDP + ICE) between peers. It
holds **no game state** and sees **no gameplay** — once two browsers shake hands,
the match runs entirely between them.

> **Heads up — this reversed an earlier decision.** The previous design put a
> single authoritative server in the middle (guaranteed no port forwarding, and
> a neutral referee for anti-cheat). Going P2P trades those away: strict home
> networks may fail to form a direct link **without a paid TURN relay** (see
> below), and the host can see the full game state (including which players are
> undisguised). Read `memory/architecture.md` for the full rationale before
> building on this.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000** in two or more browser tabs/windows (a match
needs at least 2 players). In one: **Create room** — you'll get a 4-letter code
and become the host. In the others: enter the code and **Join**. The host presses
**Start match**. (Two tabs on one machine always connect via loopback; the real
test is two *different* homes — see below.)

### Controls

- **WASD / arrows** — move
- **Mouse** — look (click the view to lock the pointer)
- **E** or **left-click** (as a Prop) — disguise as the nearest object
- **F / Space** or **left-click** (as a Hunter) — tag what you're aiming at

### How a round goes

1. The **host referee** randomly splits players into **Props** and **Hunters**.
2. **Hiding phase**: Hunters are frozen; Props run and press **E** near an object
   to take its shape.
3. **Hunt phase**: Hunters look for out-of-place props and tag them. The host
   referee judges every tag — hit a disguised player and they're eliminated; hit
   a real prop and nothing happens.
4. **Win**: Hunters win if all Props are found before time runs out; Props win if
   anyone survives. Then everyone returns to the lobby.

If the **host leaves**, the match ends and everyone returns to the menu (host
migration is intentionally out of scope for the skeleton).

## Deploy the matchmaker (so friends across different homes can play)

Any host that runs a Node process and gives you a public URL works. The
matchmaker serves the client and the signaling WebSocket on the **same** port and
honours the `PORT` env var, so most platforms need zero extra config:

- **Render / Railway / Fly.io / Heroku**: point it at this repo, build command
  `npm install`, start command `npm start`. Share the URL they give you.
- Use an `https://` URL — the client upgrades signaling to `wss://` automatically
  (and browsers require a secure context for WebRTC off `localhost`).

### Strict networks and TURN (a go/no-go you must make)

The client uses free public **STUN** servers, which get most home networks a
direct peer link. Some strict/symmetric NATs can't form one — those players need
a **TURN relay**, which is a *paid, always-on* server that carries live game
traffic (the opposite of "no server"). It's currently a **NO-GO**: no TURN is
configured, so a few networks simply won't connect. To enable one, add a `turn:`
entry to `ICE_SERVERS` in `client/js/net.js`.

## Project layout

```
server/            matchmaker only (Node + ws) — NO game logic
  index.js         HTTP static server + WebRTC signaling relay (room codes)
client/            browser game (no build step; Three.js via CDN)
  index.html       screens: menu / lobby / game
  js/              main, net (signaling + WebRTC + loopback), input, scene, ui, config
shared/
  protocol.js      SIG (client<->matchmaker) + C2S/S2C (client<->referee)
  referee.js       the authoritative referee — runs in the HOST's browser
  config/          content-as-data: rules.json, maps.json, props.json
assets/            theme art
```

Maps, props, and rules are **data, not code** — add a map to `maps.json` or a
prop to `props.json` and it shows up with no engine changes.
