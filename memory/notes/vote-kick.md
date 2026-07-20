# Vote-kick system (2026-07-19, VRmike, build/194)

Player-driven removal of an AFK/problem player. The **human replacement** for the automatic AFK-boot
that the preceding liveness build (#192, keepalive pings) removed — instead of the host silently kicking
a quiet-but-connected player, players now *choose* to remove someone. Host-authoritative like everything
else: clients only ASK; the host owns the whole vote.

## Shape (all authority in `shared/referee.js`)

`this.voteKick` — at most ONE vote game-wide, or null. When active:
`{ targetId, targetName, initiatorId, endsAt, electorate:Set<id>, votes:Map<id,bool> }`.

- **Start** (`startVoteKick(initiator, targetId)`, C2S.START_VOTEKICK). Gate refuses: a second vote while
  one runs (→ `voteKickDenied`), a self / host / absent target, a target on post-fail cooldown, and any
  non-active phase (HIDING/HUNTING only, like the team switch). The **electorate = everyone present at
  start** (the target and initiator INCLUDED — a target is a player too and gets a vote; a mid-vote
  joiner is NOT added, they just watch). The **initiator is an automatic YES**.
- **Cast** (`castVote(voter, bool)`, C2S.CAST_VOTE). Accepted from any electorate member. An elector MAY
  **change their pick** any time before the vote resolves — a re-cast OVERWRITES the previous vote (it
  never adds a second entry, so `votes.size` and early resolution are unaffected). This is what lets the
  **initiator flip their auto-YES to NO and just watch** (VRmike, 2026-07-20, build/205). A mid-vote
  joiner is still refused (not in the electorate). Each cast may trigger early resolution.
- **Early resolution** (`_maybeResolveVoteKick`): the instant `votes.size >= electorate.size` (everyone
  eligible has cast), resolve without waiting for the timer.
- **Timer** (`_tickVoteKick(now)`, called each tick during an active round): resolve when `now >= endsAt`.
- **Resolve** (`_resolveVoteKick`): clears `this.voteKick` FIRST, then **majority YES of votes CAST**
  (`yes > no`) → KICK; a **tie or majority NO** → stay. Note: at timer expiry only *cast* votes count, so
  a lone initiator's YES over an AFK target that never voted IS a kick — that's the whole point (removing
  someone unresponsive). A tie keeps them (2-player rooms: initiator YES vs target NO = 1-1 = stay).
- **Kick path**: send the target a private `S2C.EVENT kind:'kicked'` (their client → `backToMenu`), then
  `removePlayer(targetId, 'vote-kicked')` — the **exact same cleanup as a leaver** (despawns body/disguise/
  spectator, drops from roster + counts, recounts the round, public "X left (vote-kicked)" log line). Plus
  a broadcast `voteKickResult{kicked:true}`.
- **Stay path**: `voteKickResult{kicked:false}` + a public "vote failed" log, and the survived target's
  button goes on a **per-target cooldown** (`_voteKickCooldownUntil.set(targetId, now+cd)`). Only that
  target is penalised; every other player is votable the instant the vote ends.

## Concurrency + anti-spam

- ONE vote game-wide (a second start is refused server-side; the greyed scoreboard button is the polite
  half). `voteKickSeconds` (12) window, `voteKickCooldownSeconds` (5) per-target post-fail cooldown — both
  hot-tunable in `rules.json`.
- **Departures adjust an in-flight vote** (`_voteKickOnLeave`, called from `removePlayer`): target left →
  cancel quietly (`voteKickResult{cancelled:true}`); a voter left → shrink the electorate + tally so early
  resolution still fires. No-op during the kick's own removePlayer (voteKick is already null by then).
- Cancelled on round end (`setPhase(ENDING)` → `_cancelVoteKick`) and cleared at every round start
  (`_launchRound`) + `resetToLobby` (cooldowns cleared there too).

## Live tally on the wire

Rides **every snapshot** as `full.voteKick` (`_voteKickPublic()` → null when idle, else
`{ target, name, yes, no, waiting, timeLeft, voters:[ids] }`). Spreads through all 3 snapshot variants
(`blindHunterSnapshot`/`hunterSafeSnapshot` do `...full`), so the banner counts + countdown update live
for everyone and a mid-vote joiner sees it at once. Carries NO positions/secret roles — anti-cheat gates
unchanged. `voters` = the electorate, so a client can tell if IT is eligible (a mid-joiner isn't). Chose
snapshot-embedded over a separate stream: free live updates + free mid-join catch-up, negligible size.

## Client

- **`index.html`** `#voteKick` banner pinned TOP-CENTRE, BELOW `.hud-top` (health bar) inside `#hud`
  (pointer-events:none; the Yes/No buttons re-enable it). `css` `.votekick*` (media query drops it lower
  on narrow/portrait where `.hud-top` wraps). Buttons labelled **Yes (Y)** / **No (N)** so PC learns the
  hotkeys; tappable on phones.
- **`ui.js`** `setVoteKick(vote, selfId, myChoice)` renders the text + shows Yes/No for **every** eligible
  elector (electorate member) — incl. the target and the INITIATOR — and keeps the buttons LIVE after
  casting so the pick can be **changed** (initiator starts on YES, can flip to NO). `myChoice`
  (`true|false|null`) highlights the chosen button (`.chosen`). A mid-vote joiner (not in `voters`) sees
  the banner but no buttons. `updatePauseScoreboard(..., voteCtx)` adds a "vote kick" button on every
  OTHER player's row for EVERY viewer (host and guests alike — anyone can start a vote), greyed while any
  vote is active or during that target's cooldown. The HOST's own row shows a greyed, non-interactive
  `.ps-kick-host` "host · can't kick" note (not a button — the host is the server; kicking them would end
  the match, needs host migration) so a guest in a 2-player room sees WHY there's no button rather than
  reading it as broken. `onVoteKick(targetId)` / `onVoteCast(bool)` callbacks.
- **`main.js`**: `onSnapshot` drives the banner off `msg.voteKick` and passes `state.myVoteChoice`
  (`true|false|null`, scoped to the current target) so the banner highlights our pick; both `votedTarget`
  and `myVoteChoice` reset on a new target / vote end. The INITIATOR is set to an optimistic `myVoteChoice
  = true` in `ui.onVoteKick` (so the banner + YES highlight show the instant the vote opens) — NOT a
  latch that hides the buttons, so they can flip. `onEvent` handles `kicked` (→ backToMenu),
  `voteKickResult` (hide banner + feed + local per-target cooldown latch), `voteKickDenied` (feed the
  reason + drop the optimistic pick). `castVote(yes)` is the ONE path the banner buttons AND the Y/N
  hotkeys use — eligibility-gated, allows CHANGING the pick (only skips a re-send of the identical pick).
  `state.hostId` from the LOBBY message (host row gets the "can't kick" note, not a button). Vote state
  cleared on backToMenu + lobby return.
- **`input.js`** `matchVoteKey(e)` (PURE, exported) matches the **physical key** (`e.code` 'KeyY'/'KeyN'),
  which the browser reports UNCHANGED by Shift/Ctrl/Alt — so a Shift-held (sprinting) player never loses
  their vote. `onKeyDown` fires `onVote(bool)` before the pointer-lock gate (works locked or paused),
  no-op while typing / on touch. `main.js` gates it to an actual eligible live vote.

## Design choices

- **No kick button on the HOST's row** (host = the server; kicking them ends the match — that needs host
  migration, a separate feature). Refused server-side too. The row shows a greyed "host · can't kick"
  note so the exclusion reads as intentional. NOTE (build/205): VRmike's "buttons next to every OTHER
  player" playtest ask was verified against a 2-player room where the guest's only other player IS the
  host → no button. Kept the host unkickable (safe default; a host-kick has nowhere to migrate to) and
  labelled the row instead. If a future ask really wants the host votable, it needs host migration first.
- **The target CAN vote** (they're a player; host counts it like any other).
- **Any elector can CHANGE their vote** before it resolves — the initiator's auto-YES is a default, not a
  lock; they can flip to NO and watch (build/205). A re-cast overwrites; it never double-counts.
- Majority is of votes CAST, not of the electorate — an ignored vote still resolves on its cast tally.

## Guard

`tools/check-votekick.mjs` (pure, Rapier-free): full lifecycle (start→votes→majority-kick / tie-no-kick /
AFK-timer-kick), one-at-a-time, per-target cooldown, early resolution, timer resolution, target-leaves
cancel + voter-leaves shrink, guards (no self/host, lobby-refused), snapshot tally in every variant,
**vote-change/flip** (initiator YES→NO overwrites, doesn't double-count or early-resolve; tally reflects
it), and the modifier-independent hotkey matcher (Shift-held Y/N still votes) incl. a static check that
`matchVoteKey` keys off `e.code` and never consults a modifier flag.
