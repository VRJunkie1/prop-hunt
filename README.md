# prop-hunt

A **skeleton multiplayer Prop Hunt** game. A fully **static** browser app — no
build step, no server of our own. Browser clients play **peer-to-peer over
WebRTC**; the room creator's browser is the referee. Built to be basic but
extendable — see `memory/` for design notes.

Built collaboratively via DevBot. Started by Manny.

## Architecture: P2P, host-authoritative

Players connect **directly to each other** over WebRTC data channels. The room
**creator hosts**: their browser runs the referee (owns true game state, judges
every outcome) and streams snapshots to the other players; the host's own inputs
take the same path through a zero-latency local loopback. Guests send intent and
render snapshots.

Browsers still need a rendezvous to find each other. That job is done by
**[PeerJS](https://peerjs.com)'s free public broker** — it mints/pairs peers by
id and relays the WebRTC handshake (SDP + ICE). We don't run it and we don't run
anything else: **there is no backend**. A room's peer id is `prophunt-<CODE>`;
the 4-letter CODE is what you paste to friends (e.g. in Discord). Once two
browsers have shaken hands, the match runs entirely between them.

> **Heads up — this is host-authoritative P2P.** An earlier design put a single
> authoritative server in the middle (guaranteed no port forwarding, and a
> neutral referee for anti-cheat). Going P2P trades those away: strict home
> networks may fail to form a direct link **without a paid TURN relay** (see
> below), and the host can see the full game state (including which players are
> undisguised). Read `memory/architecture.md` for the full rationale before
> building on this.

## Run it locally

There's no build and no backend — you just need to serve the files over HTTP so
the ES modules and `fetch()`ed config load (opening `index.html` from `file://`
won't work). Any static server works, e.g.:

```bash
npx serve .        # or: python3 -m http.server 8000
```

Then open the URL it prints in two or more browser tabs/windows (a match needs at
least 2 players). In one: **Create room** — you'll get a 4-letter code and become
the host. In the others: enter the code and **Join**. The host presses **Start
game**. (Two tabs on one machine always connect via loopback; the real test is
two *different* homes — see below.)

### Controls

- **WASD / arrows** — move
- **Mouse** — look (click the view to lock the pointer)
- **Space** — jump · **Ctrl / C** — crouch
- **E** or **left-click** (as a Prop) — disguise as the object you're aiming at
- **F** or **left-click** (as a Hunter) — tag what you're aiming at

### How a round goes

1. Players pick **Hunters** or **Props** in the lobby; the host picks the map.
2. **Hiding phase**: Hunters are frozen **and blindfolded**; Props run and aim at
   an object, then press **E** to take its shape.
3. **Hunt phase**: Hunters look for out-of-place props and tag them. The host
   referee judges every tag — hit a disguised player and they're eliminated; hit
   a real prop and nothing happens.
4. **Win**: Hunters win if all Props are found before time runs out; Props win if
   anyone survives. Then the next round starts with **teams swapped**.

If the **host leaves**, the match ends and everyone returns to the menu (host
migration is intentionally out of scope for the skeleton).

## Deploy (static hosting)

The whole app is static files, so any static host works. It's set up for
**Cloudflare Pages** (free tier):

- Point Cloudflare Pages at this repo. **Build command: none.** **Output
  directory: the repo root** (`/`) — `index.html` lives there.
- No environment variables, no functions, no database. PeerJS's public broker
  handles peer introduction; there is nothing of ours to run.
- Serve over `https://` — browsers require a secure context for WebRTC off
  `localhost`, and the PeerJS broker is contacted over `wss://`.

### Strict networks and TURN (a go/no-go you must make)

The connection uses free public **STUN** servers, which get most home networks a
direct peer link. Some strict/symmetric NATs can't form one — those players need
a **TURN relay**, a *paid, always-on* server that carries live game traffic (the
opposite of "no server"). It's currently a **NO-GO**: no TURN is configured, so a
few networks simply won't connect. To enable one, add a `turn:` entry to
`PEER_CONFIG.iceServers` in `client/js/net.js`.

## Project layout

```
index.html         site entry (screens: menu / lobby / game) — at the ROOT so
                   static hosts serve it as the index
client/            browser game (no build step; Three.js via CDN)
  css/style.css
  js/              main, net (PeerJS P2P + loopback), input, scene, ui, config
shared/
  protocol.js      C2S/S2C — client <-> in-browser referee
  referee.js       the authoritative referee — runs in the HOST's browser
  config/          content-as-data: rules.json, maps.json, props.json
assets/            theme art
```

Maps, props, and rules are **data, not code** — add a map to `maps.json` or a
prop to `props.json` and it shows up with no engine changes.
