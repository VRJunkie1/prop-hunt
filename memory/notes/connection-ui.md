# Connection UI — menu, errors, and the hotspot tip

How join/connect status and failures are surfaced to the player. This is UI/DOM only;
the actual networking lives in `js/net.js` (see `netcode.md` / `disconnect-diagnosis.md`).

## There is no dedicated "failed to find lobby" screen

A failed **guest join** is NOT its own screen — it's the **menu screen (`#menu`) showing an
error string in `#menuError`**. The flow:

- `js/net.js _startGuest(room)` emits `onStatus('error', msg)` for every join failure:
  - `'peer-unavailable'` → `Room "X" not found — double-check the code.`
  - the 10 s (`CONNECT_TIMEOUT_MS`) bounded give-up → `Couldn't connect — check the room code …`
  - PeerJS CDN load failure → `Couldn't load the networking library …`
  - a pre-open DataConnection error → `Couldn't connect — tell the host …`
- `js/main.js handleStatus(kind, detail)`:
  - `'connecting'` → `ui.menuError('Connecting…')`
  - `'error'` → if the menu is visible, `ui.menuError(detail, /*showTip*/ true)`; if we're
    already in-game it's a passing blip → `ui.feed(detail)` instead.
  - `'closed'` → `backToMenu(detail)` (host left / lost link mid-match).
- Join-by-link: `tryJoinFromHash()` reads `#CODE` from the URL and auto-`session.join`s, so a
  friend who "just clicks" a bad/expired link lands straight on this error state.

`ui.menuError` is the single sink; `#menuError` is a `<p class="error">` in the menu card.

## Hotspot tip (#224, 2026-07-21, VRmike)

Carrier NAT blocks WebRTC P2P when everyone's on mobile data — the #1 real-world cause of a
failed join outdoors. So the failure state now carries a fixed help box, `#hotspotTip`, in the
menu card **directly under `#menuError`** and **above** the `.hint` + Create/Join controls
(placed there so it never pushes the controls off-screen; they stay at the top of the card).

Two parts, both required by spec (keep both through any wording polish):
1. **How-to** (`.hotspot-tip-main`): on mobile data, peer connections can't cross carrier
   networks; fix = ONE player runs a phone hotspot, everyone else joins that wifi, the hotspot
   player hosts → all connect directly over the local network.
2. **Client-isolation fallback** (`.hotspot-tip-note`, smaller + muted): some carriers block
   hotspot devices from talking to each other (client isolation) → try a different phone's
   hotspot.

### Shows ONLY on a real failure

`ui.menuError(msg, showTip = false)` toggles the tip:
```js
this.el.hotspotTip.classList.toggle('hidden', !showTip);
```
The tip ships `.hidden`. `showTip` is true from exactly ONE caller — `handleStatus('error')`
while the menu is visible. Every other `menuError` caller uses the default `false`:
`'Connecting…'`, cleared errors, the `'Enter a room code.'` validation, and the `backToMenu`
disconnect messages → tip stays hidden. So a player never sees troubleshooting advice before
anything has actually failed. (Deliberately scoped to the guest connect-error path, not
mid-match `backToMenu('Lost connection…')` — the task was specifically the join-failure screen.)

### Phone-first styling (`css/style.css`)

- `.hotspot-tip` — compact inset box (`#170e2c` bg, `#4d357f` border), width capped by the
  320 px `.menu-card`; `.hotspot-tip-main strong` uses `--accent2`; `.hotspot-tip-note` is
  11.5 px / `opacity:0.7`.
- `#menu { overflow-y:auto; padding:16px 0 }` + `#menu > .menu-card { margin-block:auto }` —
  keeps the card vertically centred when it fits, but lets a short phone scroll (and collapses
  the auto margins to top-align on overflow — the standard flex-centring-clips-the-top fix) so
  Create/Join stay reachable once the tip is shown. Scoped to `#menu` — never the game canvas
  or lobby.

## Guard

`tools/check-hotspot-tip.mjs` (static, Rapier-free) asserts: `#hotspotTip` exists + ships
`.hidden`; both wording parts are present (mobile-data/carrier/hotspot/hosts/local-network AND
client-isolation/different-phone); `ui.menuError(msg, showTip=false)` toggles by the flag; and
`main.js` shows the tip on the error path but NOT the `'Connecting…'` path. Run:
`node tools/check-hotspot-tip.mjs`.
