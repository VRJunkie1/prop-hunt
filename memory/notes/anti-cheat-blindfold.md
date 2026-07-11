# Hunter blindfold (anti-cheat)

At the start of a map, while props scatter, hunters are **blindfolded** during the
`HIDING` phase so they can't watch where props hide. It clears the instant the host
flips `HIDING → HUNTING`. **Props are never blindfolded**; they see the world normally
at all times.

The feature has three cooperating halves — a hacked client that deletes the visual half
still gets nothing to peek at, because the data half is enforced server-side.

## 1. Visual half — screen blackout (client)
- `index.html`: `#blindfold` overlay div (title + `#blindfoldTimer` countdown) inside `#game`.
- `css/style.css`: `.blindfold` — near-opaque dark blackout + `backdrop-filter: blur`,
  `z-index:12` (above `.overlay`=10 and touch controls=5), `pointer-events:none`.
- `js/ui.js` `setBlindfold(blind, seconds)`: plain show/hide + timer text. **Not a latched
  toggle** — it just reflects whatever `blind` it's handed.
- `js/main.js` `updateBlindfold(seconds)`: **derives** the state fresh every time from
  `blind = state.role === ROLE.HUNTER && state.phase === PHASE.HIDING`, then calls
  `ui.setBlindfold(blind, seconds)` and `input.lookFrozen = blind`. Called from both the
  `SNAPSHOT` handler (`msg.timeLeft`) and the `phase` event (`msg.seconds`) — driving it
  off the phase event too means a hunter's overlay drops the instant HUNTING starts,
  without waiting for the next snapshot. Also force-cleared with `setBlindfold(false)` on
  `backToMenu` and return-to-lobby.

Because it's **derived from live role+phase**, it can never get stuck on: props always
compute `false`; a mid-phase joiner gets the correct current state; solo/host-start (lone
player is a prop) is never blindfolded — all for free, no special-casing.

## 2. Look freeze (client)
`js/input.js` `lookFrozen` — set to the same `blind` value in `updateBlindfold`. Freezes
yaw/pitch so a blindfolded hunter can't pre-aim. Movement is frozen separately by the
referee.

## 3. Data half — position withholding (server, authoritative)
`shared/referee.js` per-recipient snapshot dispatch: `if (p.role === ROLE.HUNTER &&
this.phase === PHASE.HIDING) send(blindHunterSnapshot(full)) else send(full)`.
`blindHunterSnapshot(full)` strips every prop-role player entry and all dynamic-prop
transforms (`props: []`), keeping hunter entries and the propsAlive/propsTotal counts.
Full prop data resumes automatically at `HUNTING`. This gate is gated on the same
`role === HUNTER && phase === HIDING` rule as the client, so the two stay in lockstep.

## Bug history
Originally the **visual half was entirely missing**: `ui.setBlindfold` was called from
main.js but never defined in `js/ui.js` (no overlay div / CSS either). So *every* client —
props included — threw `ui.setBlindfold is not a function` on the first snapshot, breaking
the game for everyone (read by humans as "everyone stuck on a blindfold screen"). The
server data half and main.js's derived gate were already correct and were left untouched;
the fix only added the missing visual overlay. See project-state.md.
