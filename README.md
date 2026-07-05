# prop-hunt

A **skeleton multiplayer Prop Hunt** game. Browser client, one authoritative
server. Built to be basic but extendable — see `memory/` for design notes.

Built collaboratively via DevBot. Started by Manny.

## The one big design decision: no port forwarding

Nobody hosts a match on their own PC. Everyone's browser connects **outward** to
a single small server we run online, over WebSockets. Outbound connections work
through any home router, so **no player ever needs to port forward**. That server
is also the **referee**: it owns the true game state and decides every outcome;
each player's screen just renders what the server sends. This solves the
networking problem once, up front, so it never has to be rebuilt.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000** in two or more browser tabs/windows (a match
needs at least 2 players). In one: **Create room** — you'll get a 4-letter code.
In the others: enter the code and **Join**. The host presses **Start match**.

### Controls

- **WASD / arrows** — move
- **Mouse** — look (click the view to lock the pointer)
- **E** or **left-click** (as a Prop) — disguise as the nearest object
- **F / Space** or **left-click** (as a Hunter) — tag what you're aiming at

### How a round goes

1. Server randomly splits players into **Props** and **Hunters**.
2. **Hiding phase**: Hunters are frozen; Props run and press **E** near an object
   to take its shape.
3. **Hunt phase**: Hunters look for out-of-place props and tag them. The server
   judges every tag — hit a disguised player and they're eliminated; hit a real
   prop and nothing happens.
4. **Win**: Hunters win if all Props are found before time runs out; Props win if
   anyone survives. Then everyone returns to the lobby.

## Deploy the server (so friends across different homes can play)

Any host that runs a Node process and gives you a public URL works. The server
serves the client and the WebSocket on the **same** port and honours the `PORT`
env var, so most platforms need zero extra config:

- **Render / Railway / Fly.io / Heroku**: point it at this repo, build command
  `npm install`, start command `npm start`. Share the URL they give you.
- Use an `https://` URL — the client automatically upgrades to `wss://`.

## Project layout

```
server/            authoritative referee (Node + ws)
  index.js         HTTP static server + WebSocket + room manager
  Room.js          one lobby + one match; owns game state and rules
  config.js        loads shared/config
client/            browser game (no build step; Three.js via CDN)
  index.html       screens: menu / lobby / game
  js/              main, net, input, scene (Three.js), ui, config
shared/
  protocol.js      message types shared by client & server
  config/          content-as-data: rules.json, maps.json, props.json
assets/            theme art
```

Maps, props, and rules are **data, not code** — add a map to `maps.json` or a
prop to `props.json` and it shows up with no engine changes.
