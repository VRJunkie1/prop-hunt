# prop-hunt

A **skeleton multiplayer Prop Hunt** game. It's a **static site** (no server, no
build step) that plays **peer-to-peer over WebRTC**; the room creator's browser
is the referee. Browsers find each other through **PeerJS's free public broker**.
Built to be basic but extendable — see `memory/` for design notes.

Built collaboratively via DevBot. Started by Manny.

## Architecture: static site, P2P, host-authoritative

Players connect **directly to each other** over WebRTC data channels. The room
**creator hosts**: their browser runs the referee (owns true game state, judges
every outcome) and streams snapshots to the other players; the host's own inputs
take the same path through a zero-latency local loopback. Guests send intent and
render snapshots.

There is **no server of ours**. To introduce two browsers, we use
[PeerJS](https://peerjs.com)'s free public broker (a shared community rendezvous
service) — it only passes the WebRTC handshake so the browsers can open a direct
link, and never sees a game message. Strict/symmetric home NATs that can't form a
direct link fall back to a free public **TURN relay** (see below).

> **Heads up — trade-offs.** Leaning on shared free services (PeerJS's broker,
> OpenRelay's TURN) means the price of "no server, no bill" is the occasional
> hiccup if one of them has a bad day — fine for 2–8 friends, retry and it works.
> The host also sees the full game state (including which players are undisguised)
> — there's no neutral referee. Read `memory/architecture.md` for the full
> rationale before building on this.

## Play it

It's a static site — just open `index.html` over **HTTPS** (browsers require a
secure context for WebRTC off `localhost`). Deploy to any static host, or serve
the folder locally (see below).

In one browser: **Create room** — you get a 4-letter code and become the host,
and can **Copy invite link** to share. In the others: enter the code and **Join**
(or just click the invite link). The host presses **Start match** (needs at least
2 players).

> Two tabs on one machine connect via loopback and always work — the real test is
> two *different* homes (see the playtest note in `memory/project-state.md`).

### Controls

- **WASD / arrows** — move
- **Mouse** — look (click the view to lock the pointer)
- **E** or **left-click** (as a Prop) — disguise as the nearest object
- **F / Space** or **left-click** (as a Hunter) — tag what you're aiming at

Desktop-only: controls are keyboard + mouse-look (touch controls are out of scope).

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

## Deploy (static — Cloudflare Pages or any static host)

There is **no build step and no backend**. Point a static host at this repo's
**root** (that's where `index.html` lives). For **Cloudflare Pages**: framework
preset "None", build command empty, output directory `/` (repo root). That's it —
share the URL.

Everything the site needs is served as static files from the root: `index.html`,
`js/`, `css/`, `shared/` (protocol, referee, and the config JSON), and `assets/`.
PeerJS and Three.js load from CDNs. Nothing runs server-side.

To serve locally for a quick look, any static file server over the folder works,
e.g. `npx serve` or `python -m http.server` — then open the URL it prints. (For
real P2P across networks you still want an HTTPS deploy.)

### Strict networks and TURN

The client uses free public **STUN** servers, which get most home networks a
direct peer link. Strict/symmetric NATs that can't form one fall back to a free
public **TURN relay** (OpenRelay), already configured in `js/net.js`
(`ICE_SERVERS`). It's a shared community relay with a modest free quota — fine for
a small friend group. For a dedicated quota, make a free Metered/OpenRelay account
and swap the three `turn:` entries for its credentials. The lobby paints a
`direct`/`relayed` badge per peer so you can see whether the relay is being used.

## Project layout

```
index.html         screens: menu / lobby / game (served at the site root)
js/                browser game (no build step; Three.js + PeerJS via CDN)
  main.js          glue + render loop + client-side prediction
  net.js           PeerJS network layer (broker signaling + WebRTC + host loopback)
  input.js         keyboard + pointer-lock mouse look
  scene.js         all Three.js rendering
  ui.js            DOM screens / HUD / feed
  config.js        fetches the static config JSON
css/style.css
shared/
  protocol.js      C2S/S2C game protocol (client <-> in-browser referee)
  referee.js       the authoritative referee — runs in the HOST's browser
  config/          content-as-data: rules.json, maps.json, props.json
assets/            theme art
```

Maps, props, and rules are **data, not code** — add a map to `maps.json` or a
prop to `props.json` and it shows up with no engine changes.
