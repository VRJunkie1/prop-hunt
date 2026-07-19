# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. It's a **static site**
(deployable to Cloudflare Pages — no server, no backend, no build step). Play is
**peer-to-peer over WebRTC**; the room creator's browser hosts the referee.
Browsers are introduced by **PeerJS's free public broker** (no matchmaker of
ours). Strict NATs relay through a free public TURN.

## Latest: PROP PLAYER HEALTH SCALING — SIZE-COMPARISON FACTOR (#196, 2026-07-19, VRmike, branch build/196-prop-player-health-scaling). Bigger prop players were too easy to kill — the disguise-damage curve is now a size RATIO to the player with a 0.6× neutral pivot, so mid/large props (fridge/table) get properly tanky. ONE new knob. Host-side damage formula only; no netcode/UI/physics/render change. FULL DETAIL: `notes/hunter-tools-combat.md` (2026-07-19 head section) + `notes/balance-tuning.md` (SIZE-COMPARISON FACTOR section).

- **THE FORMULA (`shared/damage.js sizeMultiplier`).** Replaced the old size-anchor LERP with a ratio: `mult = 1 / (propSize / (playerSize * sizeComparisonFactor)) = (playerSize*factor)/propSize`, CLAMPED to `[largeMult, smallMult]`. Neutral (mult 1.0 = plain base) is a prop whose size == `playerSize*factor`. Default factor 0.6 ⇒ pivot ≈ 1.08 m (0.6× the 1.8 m player). Monotonic: bigger prop ⇒ tankier.
- **WHY (the old lerp was the bug).** It only handed the tanky `largeMult` (0.34×) to props ≥ `largeSize` 2.2 m, so a fridge (1.88 m) sat at **2.43×** — took MORE than base, ~9 hits (VRmike's "too easy to kill"). New: burger 0.72 m → **1.5×** (~14 hits, still faster than the 20-hit plain player), fridge → **0.57×** (~35 hits), table 2.25 m → **0.48×** (~42 hits).
- **THE KNOB (rules.json `damage.sizeComparisonFactor` = 0.6, hot-tunable).** Lower ⇒ pivot drops ⇒ EVERY unclamped prop tankier (big props gain most). Buffs *all* props' effective health (hunts run a bit longer) — flagged + intended; drop this one number if it overshoots.
- **`playerSize` DERIVED, not authored.** `playerSizeFromRules(rules)=2*(playerRadius+playerHalfHeight)`=1.8 m; `referee._damageCfg()` injects the LIVE value into the damage cfg used by BOTH the rifle (`_playerHitDamage`) and the grenade blast, so the pivot tracks the real capsule. `resolveDamageCfg` defaults it to 1.8 for pure/offline callers.
- **KEPT unchanged:** `smallMult`10/`largeMult`0.34 are now pure guardrail clamps (ceiling/floor; neither binds for real props). `smallSize`/`largeSize` stay in config but the damage curve NO LONGER reads them — they anchor ONLY the prop-"ouch" pitch curve (don't delete; `check-combat-sfx.mjs` A2 depends on them). Wrong-guess penalty still flat `base`.
- **Files:** EDITED `shared/damage.js` (ratio `sizeMultiplier` + `playerSize`/`sizeComparisonFactor` in `resolveDamageCfg` + new `playerSizeFromRules`), `shared/referee.js` (new `_damageCfg()` helper; `_playerHitDamage` + grenade path use it; import `playerSizeFromRules`), `shared/config/rules.json` (NEW `damage.sizeComparisonFactor` 0.6 + rewritten `_damageComment`), `tools/check-combat.mjs` (section A rewritten for the ratio formula + VRmike's 3 named cases; import `playerSizeFromRules`), `notes/hunter-tools-combat.md`, `notes/balance-tuning.md`, this file.
- **VERIFY:** `node tools/check-combat.mjs` ALL GREEN incl. new section A (pivot⇒1.0; exact `1/(propSize/(playerSize*factor))` unclamped; both clamps; monotonic; lower-factor-⇒-tankier lever; burger HIGH / fridge LOW / table<fridge) and sections B–G untouched (incl. live Rapier sensor). `check-grenade` (burger 1.50 > plain > table 0.48) / `check-combat-sfx` (ouch independent) GREEN. `browser_check` boots clean (0 console errors, desktop). **OWED — live feel pass:** confirm a fridge/table-disguised prop now soaks noticeably more hits while a burger still dies fast-ish; if hunts drag, lower `sizeComparisonFactor` (one number, no rebuild).

## Latest: PROP SIZE-BASED WEIGHT + KNOCKABILITY (#195, 2026-07-19, VRmike, branch build/195-prop-size-based-weight). Big props hard for hunters to shove/fling, small props easy to yeet — but EVERYTHING always budges at least a little (a fridge is sluggish, never immovable). Host-side physics only; no netcode/UI/render change. Hunters untouched. FULL DETAIL: `notes/balance-tuning.md` (SIZE-BASED PROP WEIGHT section).

- **MASS was already cubic — kept it.** Every dynamic prop's body is built with `.setDensity(rules.propDensity)` (`shared/physics.js _buildProps`); Rapier bakes `mass = density × collider VOLUME`, and volume ∝ size³, so a prop 2× bigger is ~8× heavier — the cubic law VRmike asked for, already automatic (a body rebuilt from a bigger disguise footprint gets the bigger mass instantly). No separate mass field added (would duplicate setDensity). NOTE: disguised PLAYERS are kinematic (infinite mass, script-driven) — this only governs free-standing dynamic PROPS; "get fridge mass on disguise-swap" applies to prop-body rebuilds, not players.
- **THE FIX — discrete hits now RESPECT mass.** `applyShotImpulse` (rifle) + `applyBlastImpulse` (grenade fling) were mass-COMPENSATED (`impulse = speed × mass` → identical Δv for every prop — a fridge flew like a burger, the OPPOSITE of the new spec). Both now route through one helper **`_nudgeImpulseMag(m, s)`**: `refJ = s × NUDGE_REFERENCE_MASS` (module const 0.35 kg, ≈ a small food prop) gives Δv = `s×(REF/mass)` → **heavy resists, light flies**; `floorJ = min(minNudgeSpeed, s) × mass` guarantees even a huge prop gets a visible Δv (never below `minNudgeSpeed`, never amplified above the hit's own `s`); `J = max(refJ, floorJ)`.
- **TWO KNOBS (rules.json, hot-tunable):** `propDensity` (1.0, unchanged — THE heaviness dial; raise → everything heavier incl. small props + harder for a walking hunter to push) and NEW `minNudgeSpeed` (0.6 m/s — the "even a fridge budges" floor). No mass floor/ceiling clamps, no Δv ceiling (light props flinging fast IS the yeet feel; density tames it if needed). The continuous walk-into-a-prop shove already scales with mass via Rapier `setApplyImpulsesToDynamicBodies`+`characterMass` (unchanged) and always imparts motion → needs no floor; the two discrete sources were the only stragglers.
- **MEASURED (real Rapier, density 1.0):** burger 0.26 kg / table 2.53 / fridge-box 4.74; shot Δv burger **2.0** vs fridge **0.6** (floored); grenade-centre fling Δv burger **43 m/s** (~18 m travel) vs fridge **2.4** (~0.18 m) — **18× spread**; weak fling (s=0.15) → fridge Δv 0.15 (NOT amplified to 0.6). ✓
- **Files:** EDITED `shared/physics.js` (module const `NUDGE_REFERENCE_MASS`, ctor `_minNudgeSpeed`, new `_nudgeImpulseMag`, both impulse fns route through it + comments), `shared/config/rules.json` (NEW `minNudgeSpeed` 0.6 + `_minNudgeSpeedComment` + `_propWeightComment`; rewrote `_shotImpulseComment` + grenade `flingSpeed` note — no longer "same nudge for both"), `tools/check-grenade.mjs` (I-block asserts `_nudgeImpulseMag` routing; body-extraction regex anchored on the 2-space method decl so a comment mention can't fool it), NEW `tools/check-prop-mass.mjs` (live-sim guard), `notes/balance-tuning.md`, `architecture.md`, this file.
- **VERIFY:** `node tools/check-prop-mass.mjs` ALL GREEN (cubic mass, mass-tracks-footprint, burger-flies-vs-fridge-resists Δv+travel, everything-budges floor, floor-not-amplified, characterMass unchanged). `check-grenade` / `check-combat` / `check-physics-live` / `check-settle` GREEN (shot Δv on a medium crate is now the floored 0.6, still > their 0.2 threshold). `browser_check` boots clean (0 console errors, desktop). **OWED — live playtest FEEL pass:** confirm a burger yeets and a big table/fridge-sized prop only scoots when shot/grenaded and when a hunter walks into them, and nothing ever feels bolted down; if the light end flings too wildly or heavies feel stuck, `propDensity` / `minNudgeSpeed` tune it with no rebuild.

## Latest: VOTE-KICK SYSTEM (#194, 2026-07-19, VRmike, branch build/194-vote-kick-system-vrmike). Player-driven kicks — the HUMAN replacement for the automatic AFK-boot removed by #192 (liveness). Host-authoritative; clients only ASK. FULL DETAIL: `notes/vote-kick.md` + `architecture.md` (Vote-kick section).

- **THE BRAIN (`shared/referee.js`, `this.voteKick`).** At most ONE vote game-wide. `startVoteKick(initiator, targetId)` (C2S.START_VOTEKICK) opens it — the electorate = everyone present at start (target + initiator INCLUDED; a mid-vote joiner just watches), the initiator is an automatic YES. `castVote` (C2S.CAST_VOTE) records Yes/No from eligible, not-yet-voted members. `_maybeResolveVoteKick` resolves EARLY the instant everyone eligible has cast; `_tickVoteKick(now)` (called each tick during HIDING/HUNTING) resolves on the 12s timer. `_resolveVoteKick`: **majority YES of votes CAST** (`yes>no`) → send the target a private `kind:'kicked'` then `removePlayer(target,'vote-kicked')` (the SAME leaver cleanup — body/disguise/spectator/roster/counts + public "X left (vote-kicked)"); a **tie/majority-NO** → stay + that target's button on a per-target 5s cooldown. (Timer expiry counts only cast votes, so a lone YES over an AFK target IS a kick — the point of the feature.)
- **GUARDS/RULES.** ONE vote at a time (2nd start refused → `voteKickDenied`), no self / host / on-cooldown / absent target, active-round only. The target CAN vote. A departure adjusts an in-flight vote (`_voteKickOnLeave` via removePlayer: target left → cancel quietly; voter left → shrink electorate so early-resolve still fires). Cancelled at round end (`setPhase(ENDING)`), cleared each round start (`_launchRound`) + `resetToLobby`.
- **LIVE TALLY on the wire.** Rides EVERY snapshot as `full.voteKick` (`_voteKickPublic()`; spreads through blindfold/hunter-safe variants; carries NO positions/roles), so the banner counts + countdown update live and mid-vote joiners see it. `voters` = electorate (client tells if IT is eligible).
- **CLIENT.** `#voteKick` banner pinned top-centre BELOW the HUD health bar (`ui.setVoteKick`), Yes/No labelled **(Y)/(N)**; a "vote kick" button on every OTHER player's pause-scoreboard row except the host's (`ui.updatePauseScoreboard` voteCtx — greyed while any vote is active or during that target's cooldown); Y/N hotkeys matched by the PHYSICAL key (`input.matchVoteKey`→`e.code`, modifier-independent so a Shift-held sprint doesn't eat the vote); `main.js` `castVote()` (one path for buttons + hotkeys) + `kicked`/`voteKickResult`/`voteKickDenied` handlers; `state.hostId` from LOBBY. NO kick button on the HOST's row (host = server; host-kick would need host migration — out of scope).
- **CONFIG:** `rules.json` `voteKickSeconds` (12) / `voteKickCooldownSeconds` (5), hot-tunable.
- **Files:** EDITED `shared/protocol.js` (C2S.START_VOTEKICK/CAST_VOTE + S2C event/snapshot docs), `shared/referee.js` (vote brain + hooks in handleMessage/removePlayer/tick/setPhase/_launchRound/resetToLobby/broadcastSnapshot), `shared/config/rules.json`, `index.html` (#voteKick banner), `css/style.css` (.votekick* + .ps-kick), `js/ui.js` (setVoteKick + scoreboard kick button + callbacks), `js/input.js` (matchVoteKey + onVote wiring), `js/main.js` (state, LOBBY hostId, snapshot banner drive, castVote, event handlers, teardown resets), NEW `tools/check-votekick.mjs`, `tools/check-team-flip.mjs` (2 static regexes tolerate the added voteCtx arg), `notes/vote-kick.md`, `architecture.md`, this file.
- **VERIFY:** `node tools/check-votekick.mjs` ALL GREEN (48 assertions — full lifecycle, one-at-a-time, per-target cooldown, early + timer resolution, target-leaves/voter-leaves, guards, snapshot tally in every variant, modifier-independent hotkey). `check-lifecycle` / `check-input-mode` / `check-team-flip` / `check-spectator` GREEN. `browser_check` boots clean (0 console errors, desktop + phone). **OWED — live multi-client pass:** start a vote from the pause scoreboard; confirm the banner + live counts + countdown show for ALL players, Y/N (and Shift+Y/N) vote on PC, tap buttons on phones, a majority kick actually removes the target (with their "You were vote-kicked" screen), a tie keeps + greys that button 5s, and only one vote runs at a time.

## Latest: CONNECTION LIVENESS VIA DEDICATED PINGS — STOP BOOTING AFK PLAYERS (#192, 2026-07-19, VRmike, branch build/192-connection-liveness-via-dedicated, implements the fix from `notes/disconnect-diagnosis.md`). Replaces INPUT-based liveness with a dedicated ~1Hz keepalive ping in BOTH directions; an AFK-but-connected player (idle in the bathroom) now stays in indefinitely, and only a GENUINELY dead connection is swept/booted. FULL DETAIL: `notes/netcode.md` (2026-07-19 CONNECTION LIVENESS section) + `notes/disconnect-diagnosis.md` (fix-landed note).

- **THE PROBLEM (per the diagnosis).** Two 5s silence timers (host `_sweepSilentPlayers`, guest `HostWatchdog`) tripped on the ~1Hz-throttled-with-multi-second-jitter timing of a backgrounded WebRTC tab — so "not moving / backgrounded" got confused with "not connected" and kicked people every round or two.
- **(1) DEDICATED KEEPALIVE PING (both directions), always-on.** Repurposed net.js's existing debug-only `__ping`/`__pong` RTT frames into the SINGLE liveness signal: `Session._startKeepalive()` starts a 1Hz `setInterval` on link-open (host→each guest, guest→host), tiny `{t:'__ping',ts}`, FAIL-SILENT (try/catch — a failed send never crashes the loop). A backgrounded tab holding a live WebRTC connection still fires setInterval ~1Hz (never frozen), so the heartbeat keeps flowing while the app is backgrounded. RTT for the debug panel is now a free by-product (no `?debug=1` gate; `enablePing()` removed).
- **(2) HOST SWEEP judges LAST MESSAGE OF ANY KIND, not input.** `_handlePingPong` now calls `_markAlive(peerId)` on every incoming ping/pong: host → `referee.markSeen(id)` (NEW; stamps the SAME `_lastSeen` the sweep reads), guest → `onKeepalive()`. So `_sweepSilentPlayers` removes a peer ONLY when pings (and all C2S) have stopped — never on "no input". `handleMessage` still stamps `_lastSeen` too (any C2S is proof of life).
- **(3) GUEST WATCHDOG fed by pings AND snapshots.** `main.js` wires `session.onKeepalive = () => hostWatchdog.feed(nowMs())`, so a throttled host whose snapshot stream briefly stalls is still held up by its ~1Hz pings.
- **(4) THRESHOLD 5→15s, in rules.json.** `rules.leaveTimeoutSeconds` 5 → **15** (one knob drives BOTH the host sweep via `referee._leaveTimeoutMs` AND the guest watchdog via `main.js hostSilenceMs()`). 15s tolerates the backgrounded-tab jitter; only a truly dead link (tab closed / phone asleep / network drop → pings stop entirely) crosses it. HOT-TUNABLE.
- **ANTI-CHEAT UNTOUCHED:** pings carry NO positions/game data — the blindfold/spectator snapshot gates are byte-identical (check-blindfold / check-spectator GREEN).
- **Files:** EDITED `shared/config/rules.json` (leaveTimeoutSeconds 15 + rewritten comment), `js/net.js` (`_startKeepalive`/`_markAlive`/`onKeepalive`, always-on keepalive, fail-silent `_sendPings`, removed `enablePing`/`_pingOn`), `shared/referee.js` (`markSeen()` + liveness comments + default 15), `js/main.js` (`session.onKeepalive`→watchdog feed, `hostSilenceMs` comment/default 15, dropped `if(DEBUG)enablePing`), `tools/check-lifecycle.mjs` (A′: markSeen wiring + AFK-stays-5-min + dead-connection-swept + boundary), `tools/check-host-disconnect.mjs` (NEW §C3 BEHAVIORAL: guest fed only by host→guest pings, NO snapshots, survives 60s then boots once when pings stop; + §D onKeepalive/keepalive/markSeen wiring), `tools/check-debug-menu.mjs` (always-on keepalive asserts), notes + this file. NO protocol message added (the ping was already a control frame), NO physics/damage/render/referee-gameplay change.
- **VERIFY:** `node tools/check-lifecycle.mjs` ALL GREEN incl. new A′ (AFK player with pings-only survives 5 simulated minutes; ping-silence past 15s still sweeps; a peer 0.5s under the threshold is NOT swept). `check-host-disconnect` (incl. new §C3 behavioral: pings-only keep an armed guest in for 60s, then a boot within the timeout once pings stop) / `check-debug-menu` / `check-blindfold` / `check-spectator` GREEN. `browser_check` boots clean (0 console errors). **OWED — live 2-window pass:** background the guest tab for a few minutes with NO input (bathroom sim) → stays in the round; then hard-close the guest tab → host sweeps it within ~15s and the guest side (if host dies) boots to lobby with "Lost connection to host."
- **(Note) attached `assets/attached_0.webp`** (a troll-face channel meme illustrating "AFK players get booted") is NOT wired into the game — this is a netcode change with no visual component; nothing to integrate.

## Latest: HUNTER HELD-ITEM OFFSET — DOWN NUDGE (#190, 2026-07-19, VRmike, branch build/190-hunter-held-item-offset, follows #188/6e8005f). One-vector follow-up: #188's forward-only push (`weapon.forwardOffset` 0.2) fixed "item behind the hand" but left the grip floating ~0.15-0.2 m ABOVE the outstretched hand. Added a DOWN component so the grip drops INTO the hand, keeping a touch more forward.

- **THE FIX** (`shared/config/character-models.json`): new `weapon.downOffset` **0.17**; `forwardOffset` **0.2 → 0.22**. `js/scene.js` `_buildHunterModel` now applies the SUM of two group-frame offsets converted to bone-local: forward `_boneLocalDir(bone,group,0,0,-1)`×forwardOffset **+** down `_boneLocalDir(bone,group,0,-1,0)`×downOffset (group −Y = model-vertical down; group is upright+yaw-only so −Y is world-down), each ×`invBoneScale`. Still bone-local ⇒ rides the pitched arm (composes with the #188 look-pitch rig). Applies to all three held meshes (rifle/grenade/finder share the `Wrist.R` grip anchor).
- **VERIFY (anchored, not blind):** NEW `tools/_probe_hand_offset.mjs` walks the GLB skeleton — rest-pose `Wrist.R` ~1.03 m up, forearm ~0.23 m, shoulder→wrist vertical drop ~0.37 m, so a ~0.17 m drop is a real hand-scale correction. `node tools/check-hunter-model.mjs` ALL GREEN (forwardOffset now 0.22); `browser_check` boots clean (0 console errors). Direction is geometrically guaranteed; EXACT grip landing still OWED a live 2-client screenshot (headless can't render a remote hunter). Hot-tunable: raise `downOffset` if it still floats, lower/negative if it now sinks below the hand.
- **Files:** EDITED `shared/config/character-models.json` (`weapon.downOffset` + `forwardOffset` 0.22 + rewritten comment), `js/scene.js` (down component in `_buildHunterModel` offset block), NEW `tools/_probe_hand_offset.mjs` (authoring-only rig probe), notes (`hunter-character-model.md`) + this file. NOTHING else — first-person view, aim, hitboxes, netcode, referee all untouched.

## Latest: GRENADE BACKFIRE FLING + HUNTER HELD-ITEM POSITION + REMOTE LOOK PITCH (2026-07-19, VRmike, branch build/186-grenade-backfire-fling-hunter). Three playtest fixes. check-grenade (§J new) / check-hunter-model (§5 new) / check-tool-visibility / check-combat / check-flicker / check-round-flip-blindfold / check-object-sync ALL GREEN; page boots clean (0 console errors, desktop). Items 2–3 are cosmetic-only on the REMOTE hunter model and OWE a live 2-client pass (headless can't render the soldier). FULL DETAIL: `notes/hunter-grenades.md` (self-kill fling) + `notes/hunter-character-model.md` (held-item offset + look pitch) + `notes/netcode.md` (snapshot `pitch`).

- **(1) GRENADE BACKFIRE NO LONGER CANCELS THE FLING.** When the hunter's own grenade self-kills them (backfire off decoys, no prop-kill redemption), the props used to freeze instead of flying. ROOT CAUSE (an ordering/lifecycle bug, NOT an early-return): `_resolveGrenadeBlast` DID apply the fling impulses, but AFTER the backfire damage — a self-kill ends the round → `setPhase(ENDING)`, and `tick()` only STEPPED the physics world during HIDING/HUNTING, so the impulse was applied to the Rapier bodies but never integrated (frozen mid-blast). FIX (`shared/referee.js`): (a) the fling loop is now step (2), applied BEFORE the prop/backfire damage — death never cancels the shove; (b) `tick()` now also runs `integrate(dt)` during ENDING with ALL players FROZEN (`frozen = phase===ENDING || (hunter && HIDING)`), so the flung props fly + settle on the results screen and keep streaming via the existing awake-prop snapshots. `_sweepSilentPlayers` is NOT run during ENDING. Redemption/backfire math UNCHANGED. Guard: `check-grenade.mjs` §J (lone hunter self-kills → dies, round flips ENDING, every loose prop still flung) + §I source asserts (fling precedes backfire; physics steps during ENDING; players frozen).
- **(2) HELD ITEM SITS IN THE HAND ON REMOTE VIEWS.** The gun/grenade/finder floated ~0.2 m BEHIND the hand on OTHER players' machines. It was already joint-parented to `Wrist.R` (not world-space), so the fix is a forward NUDGE: new `weapon.forwardOffset` (m, 0.2) added to all three held meshes along the wrist bone's LOCAL forward (`scene._boneLocalDir(bone,group,0,0,-1)` → bone-local, yaw-independent; converted to bone units via `_boneWorldScale`). Bone-local so it RIDES the arm as it pitches (item 3). Hot-tunable.
- **(3) REMOTE HUNTER LOOK PITCH.** Remote models always aimed dead-horizontal (yaw networked, pitch not). Added `pitch` to the snapshot (hunters only; `player.pitch` was already host-stored + clamped ±1.5 from INPUT — no new C2S). `scene.js` tilts the `Head` + `UpperArm.R` bones to it: `_buildPitchRig` precomputes each bone's LOCAL nod axis (character right = group +X via `_boneLocalDir`); `syncPlayers` stashes `p.pitch`→`ctl.targetPitch`; `updateAnimations` calls `_applyLookPitch` AFTER `mixer.update` (adds on top of the pose — both bones ARE animated every clip so no accumulation, verified via `tools/_probe_bones.mjs`), smoothed + CLAMPED (`hunter.pitch` block: maxUp 45°/maxDown 40°, sign/factors hot-tunable). Purely visual — hitboxes/aim untouched. The held item (child of the pitched `UpperArm.R`→`Wrist.R`) rides the tilt for free, so items 2+3 compose on ONE attachment chain.
- **Files:** EDITED `shared/referee.js` (fling reorder + ENDING-phase stepping/freeze + snapshot `pitch`), `shared/config/character-models.json` (`weapon.forwardOffset` + `hunter.pitch` block), `js/scene.js` (`_boneLocalDir`/`_boneWorldScale`/`_buildPitchRig`/`_applyLookPitch` + held-item offset in `_buildHunterModel` + pitch in `updateAnimations`/`syncPlayers`), `tools/check-grenade.mjs` (§J + §I source asserts), `tools/check-hunter-model.mjs` (§5), NEW `tools/_probe_bones.mjs` (authoring-only bone probe), notes (`hunter-grenades.md`/`hunter-character-model.md`/`netcode.md`) + `architecture.md` + this file. NO change to protocol messages, physics engine, damage math, or the first-person view.
- **OWED — live 2-client pass:** (a) a self-kill grenade sends nearby props flying on BOTH screens (not frozen); (b) from an OBSERVER's view the hunter's held item sits in the hand at level, full-up, and full-down look pitch; (c) head + arm tilt smoothly with the hunter's look pitch, no fold at the clamps. Nudge `forwardOffset` / flip `pitch.sign` / tighten clamps live if any reads off (all hot-tunable, no rebuild).

## Latest: GRENADE FLING FORCE ×4 (2026-07-19, VRmike, branch build/183-grenade-fling-force-4). One-constant balance tweak — the grenade prop-fling impulse now flings loose props 4× harder. `rules.grenade.flingSpeed` 8 → **32** (`shared/config/rules.json`), and the matching `resolveGrenadeCfg` fallback default in `shared/damage.js` bumped 8 → 32 to stay in sync. Linear-with-damage shape UNCHANGED — the whole curve just scales up (centre 32 m/s, mid-falloff 16 m/s). NOTHING else touched: blast radius, damage numbers, backfire, redemption, mass-scaling all as-is. `tools/check-grenade.mjs` GREEN (§I derives its expected magnitudes from config, so no hardcoded assertions needed editing — centre=32, mid=16 confirmed). Easy one-number revert/re-tune if playtest finds it too comedic.

## Latest: HOST-DISCONNECT → BOOT TO LOBBY + STALE-SESSION GHOST FIX (2026-07-19, VRmike, branch build/180-host-disconnect-handling-stale). Netcode: a guest whose host dies SILENTLY now detects it and returns to the menu instead of freezing on a stale world. FULL DETAIL: `notes/netcode.md` (2026-07-19 section) + `architecture.md` (main.js/net.js bullets).

- **DIAGNOSIS (the requested audit).** The reported ghost session — two windows both PROPS, a collision-less statue hunter players walk through, no ability to transform/interact, timer stuck at 0:00 — is ONE bug in four costumes: the host's snapshot stream silently STOPPED and the client kept rendering the last one. Timer 0:00 = `HudTimer` clamped after its last anchor ran out; statue hunter = remote players are pure interpolation toward the last snapshot and aren't in the local predict world (only the host simulates player collision); dead transforms = `C2S.DISGUISE`/INPUT posted into a dead `DataConnection`. ROOT CAUSE: no snapshot-staleness watchdog, and the guest's `conn.on('error')` was swallowed once the link was live — so a SILENT host death (tab suspended / phone locks, no PeerJS event) was never detected.
- **FIX.** NEW pure `js/host-watchdog.js` (`HostWatchdog`, like `hud-timer.js`): armed GUEST-ONLY at `S2C.STARTED`, fed by every snapshot, polled each frame in `frameBody` while the tab is visible; on silence past `hostSilenceMs()` it trips ONCE → `session.close()` + the SHARED `backToMenu('Lost connection to host.')` (reuses the existing return path — clears blindfold/spectator/frozen-look/wake-lock/HUD-timer/predict, fresh Session). Disarmed on menu + between-rounds lobby returns; `resume()` grants a grace period on `visibilitychange→visible` so backgrounding your OWN tab doesn't false-kick. `js/net.js`: post-ready guest `conn.on('error')` now routes to `onStatus('closed',…)` + teardown (both loud signals → one place); public `Session.close()` for the silent-stall teardown. HOST + referee + protocol UNCHANGED (solo host is a valid game).
- **TIMEOUT** = `max(3000, rules.leaveTimeoutSeconds*1000)` = 5s = the SAME "no traffic = gone" threshold the host uses to sweep silent guests (B2), ≈ 75 missed 15 Hz snapshots. Derived from the documented rate, floored, not hardcoded.
- **SCOPE:** auto-reconnect/rejoin-in-place is OUT (rejoin from the menu is the recovery path; easy follow-up).
- **Files:** NEW `js/host-watchdog.js`, `tools/check-host-disconnect.mjs`; EDITED `js/main.js`, `js/net.js`, `notes/netcode.md`, `architecture.md`, this file. NO physics/referee/protocol/audio/anti-cheat/lighting change.
- **VERIFY:** `node tools/check-host-disconnect.mjs` ALL GREEN (42 assertions — pure watchdog timing/latch, background-grace, timeout derivation, a faithful mini-client through BOTH disconnect paths landing in clean lobby state, + client/net.js source wiring). `browser_check` boots clean (0 console errors). **OWED:** a human live two-window playtest — background/suspend the host tab mid-round and confirm the guest drops to the menu with "Lost connection to host." within ~5s (and that a brief phone-app-switch on the GUEST does NOT kick it).

## Latest: SHADOW RECEIVING REGRESSION + BIAS TUNING (2026-07-19, VRmike, branch build/178-shadow-receiving-regression-shadow, follows the 3 lighting builds bb40a2e/c07bafa/f53143f). Two playtest bugs, DIAGNOSED VIA GIT (not guess-patched). FULL DETAIL: `notes/lighting.md` (SHADOW RECEIVING REGRESSION section).

- **(1) CAST SHADOWS ONLY LANDED ON THE BEIGE PRIMITIVE FLOOR — regression.** The hunter's shadow showed on the build-created beige `ground` plane but NOT on the tiled kitchen floor or any asset-pack GLB (AO showed everywhere). **ROOT CAUSE (via git across the 3 lighting builds):** `receiveShadow` is only set by `scene._applyShadowFlags()`, a ONE-SHOT `scene.traverse` at the end of `buildWorld()` (and on tier changes). But every loaded map GLB — the tiled floor + all asset-pack meshes — swaps in ASYNCHRONOUSLY via `_loadModels()`→`_applyModel()`→`instantiateModel()`, AFTER that traversal already ran. `instantiateModel` set `castShadow=true` but never `receiveShadow`, so async GLBs cast but couldn't RECEIVE; only the synchronously-built primitives (beige ground, walls, primitive props) got `receiveShadow`. Latent since the shadow system landed (bb40a2e); f53143f's T3-first default (shadows ON by default for everyone) made it visible. **FIX:** one line at the shared world-GLB choke point — `instantiateModel` now also sets `o.receiveShadow = true` in its mesh traverse (harmless when shadows off; a later tier change's `_applyShadowFlags` still re-syncs the whole scene). Guarded so a future material/darkening pass can't silently regress it.
- **(2) WHITE SPOTS IN SHADOW CENTERS at close ground contact.** A bright hole in the shadow blob under a prop/player where the model nearly touches the ground = anti-acne `normalBias` pushed too high (light leaks through at contact). The old flat `normalBias 0.02` / `bias −0.0006` over-shot on the 2048 top tier (now the default). **FIX:** resolution-aware `shadowBiasFor(shadowMapSize)` in `lighting-tiers.js` scales both bases by `min(1, 1024/size)` — HALVES them at 2048 (`normalBias 0.01`, `bias −0.0003`, killing the leak) while leaving the 512/1024 tiers at their prior known-good values. `lighting.js` sets the contact light's `shadow.bias`/`normalBias` from it per-tier. Starting point per VRmike ("roughly halve it"); retune the two bases in one place.
- **Files:** EDITED `js/scene.js` (`instantiateModel` sets `receiveShadow`), `js/lighting-tiers.js` (`shadowBiasFor` + `SHADOW_BIAS_BASE`/`SHADOW_NORMAL_BIAS_BASE`/`SHADOW_BIAS_REF_MAPSIZE`), `js/lighting.js` (contact light bias from `shadowBiasFor(cfg.shadowMapSize)`), `tools/check-lighting.mjs` (§4d: receive-shadow regression guard + bias math + wiring), `notes/lighting.md` + this file. NO change to netcode/physics/referee/protocol/audio/anti-cheat.
- **VERIFY STATUS (resumed attempt 3 — runner recovered):** ALL GREEN. `node tools/check-lighting.mjs` passes end-to-end incl. §4d (receiveShadow set at the `instantiateModel` choke point + `_applyShadowFlags` re-sync; `shadowBiasFor(2048)`→`normalBias 0.01`/`bias −0.0003` halved, 512/1024 unchanged, garbage→reference base) and §6 LightingRig object-graph. `browser_check` boots clean (0 console errors); the per-tier render self-test (`?lightingtest=all`, T0–T3 swept in a real headless browser) ran clean — no console.error on any tier, and the top-tier (2048) frame shows floating props casting SOLID contact shadows with NO white hole in the centre and no acne striping (bias fix confirmed visually). NOTE ON ROOT CAUSE: it was async-load TIMING (loaded GLBs swap in after the one-shot `_applyShadowFlags` traverse), NOT a material clone/replace — `receiveShadow` is a MESH property and the darkening pass only recolours primitive albedos, so it never touched it; diagnosed via git across bb40a2e→c07bafa→f53143f.
- **OWED:** only a human live-match re-playtest, VRmike's two camera angles — (1) a cast shadow on the tiled/checkered kitchen floor AND on an asset-pack model (not just the beige floor); (2) a prop at close ground contact showing a solid dark blob (no white hole) on a high AND a low tier. (The empty `_`-prefixed scratch `tools/_tmp-bias-check.mjs` can't be removed — no delete tool in-sandbox — but it's authoring-only, unimported, never shipped, like the other `tools/_*.mjs` scratch files.)

## Latest: LIGHTING TUNING ROUND 2 (2026-07-19, VRmike, branch build/175-lighting-tuning-round-2, follows c07bafa). Four presentation-layer playtest items, all landed + verified (check-lighting all green incl. new §4c; lighting-selftest passes all 4 tiers on desktop + phone; no black-screen regression). FULL DETAIL: `notes/lighting.md` (TUNING ROUND 2 section).

- **(1) FLIPPED TIER DEFAULT (T3-first).** The device heuristic was too conservative (VRmike's high-end phone defaulted low yet runs T3 fine). `js/main.js` now seeds `MAX_TIER` (T3) on ALL devices when there's no saved/manual choice; the runtime FPS probe (`auto-tier.js`) steps DOWN only if the frame actually lags (the existing safety net). Saved/manual pick STILL wins. `guessTierFromDevice` is still computed (perf HUD) but no longer seeds the start tier. `lightingState.tier` inits to `MAX_TIER`.
- **(2) TONEMAP DEFAULTS + RANGE (~30% hotter).** `multiply` stays the DEFAULT (VRmike prefers it to ACES). `MULTIPLY_FACTOR` 1.25 → **1.6**; `EXPOSURE_RANGE.max` 2.0 → **2.6** (`index.html` slider `max` + the `1.6× Multiply` button label mirror it). A/B toggle + persistence unchanged.
- **(3) BUILD-GEOMETRY DARKEN (anti-bleach).** Our build-added primitives (beige floor, walls, columns, canisters, any catalog entry without a GLB — all flat `MeshLambertMaterial` from map/catalog JSON) blew out to near-white under the hotter light while Kenney GLB props sat fine. ONE shared scalar `BUILD_GEOMETRY_BRIGHTNESS = 0.6` (`lighting-tiers.js`) multiplies those albedos DOWN, applied in `scene.js` at `makePropMesh` + the ground + the walls via `THREE.Color.multiplyScalar`. **Asset-pack GLB materials untouched** (they load their own; the primitive is only a pre-swap fallback).
- **(4) SSAO NEAR-RANGE FALLOFF.** AO was darkening geometry dozens of meters away — three r161 SSAOPass `min/maxDistance` are NORMALIZED depth deltas over near..far, NOT meters, so with far=500 the old `maxDistance=0.1` ≈ 50 m of bleed. Now world-space meter constants (`AO_MAX_DISTANCE_METERS=1.5`, `AO_MIN_DISTANCE_METERS=0.02`, `AO_KERNEL_RADIUS_METERS=0.8`) converted per-camera by `ssaoDistanceRange(near, far)` in `lighting.js _buildComposer` (1.5 m → normalized 0.0030 at far=500).
- **Files:** EDITED `js/lighting-tiers.js` (MULTIPLY_FACTOR/EXPOSURE_RANGE, `BUILD_GEOMETRY_BRIGHTNESS`, AO constants + `ssaoDistanceRange`), `js/lighting.js` (SSAO distance from camera near/far), `js/scene.js` (darken primitive/ground/wall albedo), `js/main.js` (MAX_TIER default seed), `index.html` (slider max 2.6 + button label), `tools/check-lighting.mjs` (§4c + MAX_TIER wiring guard), `notes/lighting.md` + this file. NO change to netcode / physics / referee / protocol / audio / anti-cheat.
- **OWED:** human live-match playtest to confirm the T3-first default feels good on a range of real phones (and the probe demotes a genuinely weak one within ~10 s), and that the darkened build-geometry sits level with the GLB props in a real map.

## Latest: LIGHTING HOTFIX — black screen on T2/T3 + ambient washout (2026-07-19, VRmike, branch build/173-lighting-hotfix-black-screen, follows bb40a2e). Two playtest-blocking visual bugs from the 4-tier build, both FIXED + verified per-tier in a real browser (desktop + phone) via a new gated render self-test. FULL DETAIL: `notes/lighting.md` (HOTFIX section).

- **(1) BLACK SCREEN on the SSAO/bloom tiers (T2/T3).** Rendered ~1s then went SOLID BLACK (UI stayed up). ROOT CAUSE: `LightingRig._buildComposer()` used `SSAOPass` as the FIRST composer pass with NO `RenderPass` ahead of it. In three **r161** `SSAOPass.OUTPUT.Default` doesn't render the beauty — it reads the incoming colour from `readBuffer.texture` and composites AO over it (confirmed against the r161 SSAOPass source + the official SSAO example: RenderPass → SSAOPass → OutputPass). With nothing feeding readBuffer the beauty was an empty black buffer → black frame. The ~1s was the LAZY CDN import of the postprocessing addons resolving (direct-render fallback covered the load, then the broken composer took over). FIX: always add `RenderPass` first, then `SSAOPass`/bloom/`OutputPass`. Tier switches are already atomic (auto-tier `tick()` runs AFTER `scene.render()`, between frames), so the rebuild path is safe now that it always leads with a RenderPass.
- **(2) AMBIENT washout — floor near-white, shadows drowned.** Inventory found TWO flat-fill sources, both at 1.0: the base **HemisphereLight** (`scene.buildWorld`, all tiers) and the **SH ambient probe** (`lighting.js`, T1+). No `AmbientLight`/`scene.environment`/`envMap` exist (checked). FIX: ONE tunable `AMBIENT_INTENSITY_DEFAULT = 0.3` (LOW) in `lighting-tiers.js`, per-map overridable via `map.ambientIntensity` (`resolveAmbientIntensity`, clamped 0..2); BOTH sources route through it (HemisphereLight intensity + SH probe `_ambient`). Editor preview uses the same helper. The contact (straight-down, shadow-casting) light was bumped **0.5 → 1.0** so the down-shadow — the jump-accuracy cue — reads CLEARLY once ambient is low. Default is intentionally darker/moodier than before (per the approved plan).
- **RENDER SELF-TEST (NEW, `js/lighting-selftest.js`, DEV-ONLY gated `?lightingtest=…`).** `main.js` lazy-loads it ONLY when `?lightingtest` is in the URL (never in normal play). Boots the real `Scene3D`, forces each tier for >3s (past the lazy-import window), READS BACK canvas pixels, asserts not-black on all 4 tiers + shadows-read on T1+ (grey-floor lit−shadow contrast inside the projected prop-ring; test props FLOAT so their down-shadows land on open floor = the jump case). `?lightingtest=all` sweeps; `?lightingtest=2` holds one for a screenshot. VERIFIED 4/4 tiers pass desktop + phone.
- **Files:** EDITED `js/lighting.js` (RenderPass-first composer, SH probe intensity off `_ambient`, contact light 1.0), `js/lighting-tiers.js` (ambient tunable + `resolveAmbientIntensity`), `js/scene.js` (HemisphereLight off the tunable), `js/editor.js` (same), `js/main.js` (gated self-test hook), `tools/check-lighting.mjs` (§4b ambient + §5 two source guards); NEW `js/lighting-selftest.js`; notes. NO change to netcode/physics/referee/protocol/audio.
- **OWED:** human live-match playtest (real map/props/players, the "Get ready…" SH bake, disguise swaps) for tonemap/bloom feel + auto-tier stepping a slow phone. The render path itself is now verified.

## Latest: LIGHTING OVERHAUL — 4-tier quality + SH ambient + tonemap + perf HUD (2026-07-19, VRmike, branch lighting-overhaul). A big renderer-touching build, done in 3 landable increments, all guarded by NEW `tools/check-lighting.mjs` (8 headless sections, ALL GREEN) + boot-clean on desktop + phone (0 console errors). Visual effects owe a live match pass (they can't be headless-checked; boot-clean was the bar, like B4). FULL DETAIL: `notes/lighting.md` + `architecture.md` (scene.js + the new lighting modules).

- **(1) EFFECT SWITCHBOARD + 4 TIERS.** `js/lighting-tiers.js` (PURE, no THREE/DOM) is the one source of truth: 5 INDEPENDENT effect switches (`shProbe`/`contactShadow`/`angledFill`/`ssao`/`bloom`) and a `TIERS` preset table — T0 = today's look (potato, no shadows); T1 = SH probe + ONE straight-down contact-shadow directional @512 (jump accuracy); T2 = + angled fill + SSAO @1024; T3 = + bloom @2048. `resolveTierConfig(t)` → the full config incl. `usesComposer` (only T2/T3 allocate an EffectComposer). Retuning a tier = editing the table.
- **(2) LightingRig (THREE, `js/lighting.js`)** maps the config onto real objects, owned by scene.js as `scene.lighting`. `render()` picks direct render (T0/T1) vs the SSAO/bloom composer (T2/T3), falling back to direct while the addon passes LAZY-import (like GLTFLoader — cheap tiers + headless boot allocate nothing). Per-frame render is allocation-free.
- **(3) SH AMBIENT PROBE** baked once per map at `buildWorld` (behind the "Get ready…" banner): 64px `CubeCamera` from the room center → `LightProbeGenerator` → a `LightProbe` (9 SH coeffs) added as ambient fill. Manual override: a map JSON `sh`/`shCoefficients` (flat-27 or nested-9) skips the bake (`parseSHCoefficients`/`mapSHOverride`, guarded). Runs on all tiers ≥ T1 (T0 stays exactly today's lighting per spec).
- **(4) TONEMAP A/B + EXPOSURE** on the renderer (works on EVERY tier, no composer needed): `multiply` = `LinearToneMapping` with exposure folded to 1.25×slider (flat "1.25× multiply"); `filmic` = `ACESFilmicToneMapping`. Exposure = the PRE-tonemap multiplier. Three only tone-maps to SCREEN, so the composer's `OutputPass` applies it once at the end (no double-apply, verified vs r161).
- **(5) CPU/GPU ATTRIBUTION** — `js/perfmon.js` (allocation-free): `beginFrame`/`endCpu` around physics+logic+render submission = CPU ms; total frame time − CPU = inferred GPU ms; `verdict()` = cpu/gpu/even. Wired in `main.js frame()`.
- **(6) AUTO-TIER** — `js/auto-tier.js` (PURE state machine): device guess (`guessTierFromDevice`, GPU string via `WEBGL_debug_renderer_info`) → ~10s FPS probe → if lagging AND GPU-bound, step DOWN one tier → re-measure → improved: keep + SAVE; not improved: revert + mark CPU-bound + cooldown (one-way ratchet, no yo-yo). Ambiguous → a render-scale probe (drop ~30%, FPS jump ⇒ GPU-bound). A MANUAL pause pick calls `disable()` and wins forever.
- **(7) PERF READOUT** in the `?debug=1` overlay (NOT the pause menu): framerate, CPU ms, inferred GPU ms, active tier (`(manual)`/`(auto…)`), CPU/GPU-bound verdict.
- **PAUSE MENU:** "Lighting Quality" row (4 tier buttons) + "Tonemap" A/B + exposure slider (`index.html`/`js/ui.js`/`css`), shown on all devices. Persisted to localStorage (`prophunt.lightingTier`/`.lightingUserSet`/`.tonemap`/`.exposure`) the same way as mouse sensitivity.
- **CONTEXT-LOSS (phones):** NEW `webglcontextrestored` handler rebuilds the composer + shadow map + re-bakes the probe (the classic way phones lose new render state on a tab-switch).
- **Files:** NEW `js/lighting-tiers.js`, `js/lighting.js`, `js/perfmon.js`, `js/auto-tier.js`, `tools/check-lighting.mjs`, `notes/lighting.md`; EDITED `js/scene.js` (LightingRig wiring: render delegate, `_reattachLighting`/`_applyShadowFlags`/`setLightingTier`/`setTonemap`/`setRenderScale`, context-restore, `preparePlayerModel` castShadow), `js/main.js` (persistence + device guess + perf instrumentation + auto-tier + pause callbacks + debug ctx), `js/ui.js` (tier/tonemap/exposure controls), `js/debug.js` (Perf section), `index.html` (pause rows), `css/style.css` (tier/tonemap styles), `architecture.md`, this file. NO change to netcode / physics / referee / protocol / audio / combat — this is renderer + client-settings only.
- **Guards GREEN:** check-lighting (NEW, 8 sections), check-flicker / check-pc-controls / check-blindfold (no regression; the blindfold render-loop guard auto-picked up the new scene methods `setRenderScale`/`setLightingTier`/`setTonemap`). Boot clean desktop + phone.
- **OWED — live match pass:** SH ambient fill on load; contact shadows under props/players (T1 jump accuracy); SSAO (T2); bloom (T3); tonemap A/B + exposure feel; auto-tier actually stepping a slow phone down + saving (and NOT yo-yoing on a CPU-bound one); an OLD phone surviving T0/T1; the phone tab-switch context-loss rebuilding shadows + probe.

## Latest: CHECK-REPAIR — clean Windows exit for check-lifecycle (2026-07-18, branch build/170-b8-re-queue-the). Automated check reported `tools/check-lifecycle.mjs` aborting on the WINDOWS runner with `exit 3221226505` (0xC0000409) + `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`. All assertions PASS (verified via run_node: exit 0 both before + after) — the abort is a **teardown race**: the trailing synchronous `process.exit(fails?1:0)` fired while the Rapier WASM / libuv async handles were still closing (Windows-only; not reproducible in the Linux sandbox). FIX: one line — `process.exit(...)` → `process.exitCode = fails ? 1 : 0`, letting Node drain the loop and close handles on its own. Safe because by that point every `Referee` interval is cleared (`ref.destroy()`) and every `PhysicsWorld` is freed (`w.destroy()` → `world.free()`), so nothing keeps the loop alive — verified it still exits promptly (no hang). ONLY `tools/check-lifecycle.mjs` touched (+ new `notes/tooling-exit.md`); the other Rapier checks were left alone (minimal-change), with the pattern documented for them if they ever throw the same abort. NO game/runtime code changed.

## Latest: B8 (re-queue) — ROLE-FILTERED CONTROLS LIST + ROUND-2 BLINDFOLD (2026-07-18, VRmike, branch build/170-b8-re-queue-the). The prior build #156 was a NO-OP; rebuilt fresh on the current tip (B6 spectator + B7 tool-visibility landed since B8 was first specced, so both were read in their CURRENT state). NEW `tools/check-round-flip-blindfold.mjs` GREEN (drives the REAL referee through round1→caught-prop→ENDING→flip→round2 HIDING→HUNTING); check-pc-controls / check-spectator / check-blindfold / check-team-flip / check-input-mode / check-tool-visibility / check-sync-convergence / check-key-repeat GREEN (no regression); page boots clean (0 console errors, desktop). Owes a live 2-player round-2 pass. FULL DETAIL: `notes/pc-feel-controls.md` (role-filtered list) + `notes/anti-cheat-blindfold.md` (§6 round-2).

- **(1) ROLE-FILTERED CONTROLS LIST.** `js/ui.js _controlsHtml()` used to MERGE prop + hunter (+ spectating) rows into one blob ("Left-click: Hunter rapid-fire · Prop disguise"). Now it renders ONLY the current role's controls: `common` movement rows + `hunter` (fire · 1/2/3 tools · V) OR `prop` (disguise · turn · E · T taunt · V), OR the `spectator` fly-cam rows while dead, OR just `common` before a role (lobby/pre-spawn). Driven by a new `this._controlsRole` ('hunter'|'prop'|'spectator'|null) set via `ui.setControlsRole(mode)` (idempotent — re-renders the visible corner panel + the open pause "Controls" panel). `js/main.js` pushes the mode on EVERY role change through `updateControlsList()` (reads `controlsMode()` = spectating? 'spectator' : role): called from `applyRole` (role assign / self-heal / **round flip** / team switch), the onSnapshot alive-flip (death/respawn), and `setSpectating`. Single source of truth preserved (corner panel + pause panel both from `_controlsHtml()`). Touch vs PC branch unchanged. check-pc-controls / check-spectator stayed green (they slice the `_controlsHtml` SOURCE, which still contains every literal + "Spectating").
- **(2) ROUND-2 BLINDFOLD — investigated + hardened.** Deep-verified the round-flip lifecycle: the CURRENT code is already correct at the message/state level (a faithful headless client reducer over the real referee's captured stream RELEASES the round-2 hunter every time — alive reset in `_launchRound`, blindfold derived fresh from role+phase, world catch-up delivered at HUNTING to `role===HUNTER||!alive`). Could NOT reproduce a server/logic defect headlessly. The one real residual was a BROWSER-ONLY transient: between round-2 `STARTED`/`phase(HIDING)` and the first round-2 snapshot, stale round-1 view-state (spectator fly-cam, blindfold overlay, `lookFrozen`) wasn't explicitly cleared, so the frame loop kept running the spectator/blindfold view until the next snapshot self-healed — read by playtesters as "permanently blindfolded/unspawned on round 2". **FIX (belt-and-suspenders, doesn't weaken anti-cheat):** the `S2C.STARTED` handler now resets `ui.setBlindfold(false)` + `input.lookFrozen=false` + `setSpectating(false)` at the fresh-round seam (matches the existing backToMenu/resetToLobby resets). The correct blindfold is still DERIVED from role+phase by the HIDING phase event that follows, so a round-2 hunter re-blinds for HIDING then releases at HUNTING — the gate is unchanged. `tools/check-round-flip-blindfold.mjs` locks the full round-flip→blindfold→release sequence (incl. the caught-prop-spectator→round-2-hunter path + a no-death flip + the STARTED-reset source guard) so round 2 can't quietly regress.
- **Files:** `js/ui.js` (`_controlsRole` + `setControlsRole` + role-filtered `_controlsHtml`), `js/main.js` (`controlsMode`/`updateControlsList` + call sites in applyRole/onSnapshot/setSpectating + STARTED view-state reset), `tools/check-round-flip-blindfold.mjs` (new), `tools/_b8_repro.mjs` (scratch repro, authoring-only), `notes/pc-feel-controls.md` + `notes/anti-cheat-blindfold.md` + `architecture.md` + this file. NO change to the referee/protocol/physics/netcode/snapshot gate/disguise render — item 2 is a client view-state reset only; the anti-cheat data gate is untouched.
- **OWED — live 2-player round-2 pass:** play a full round, let it flip, and confirm the new hunter is blindfolded during round-2 HIDING then RELEASES cleanly at HUNTING (no stuck blackout / fly-cam / frozen look); include a caught-prop-becomes-hunter case. Confirm the corner + pause controls panels show ONLY your role's controls and re-filter on a team switch / round flip / death.

## Latest: KEY AUTO-REPEAT GUARD — held T/ESC no longer flicker the menus (2026-07-18, Jie, branch build/167-key-auto-repeat-guard). HOLDING a toggle key on PC fired the OS key auto-repeat, delivering a burst of `keydown` events that our menu toggles each treated as a fresh press — so the taunt menu (T) and pause menu (ESC) strobed open/closed. FIX is ONE choke point at the top of `Input.onKeyDown` (js/input.js): `if (e.repeat) { if (e.code==='Space') e.preventDefault(); return; }` — `KeyboardEvent.repeat===true` marks an OS auto-repeat, so ignoring ALL of them makes every toggle/one-shot below the guard (editor Ctrl/Cmd+E, UI-mode `, pause Esc, taunt T, disguise E, view V, tool-select 1..9) fire EXACTLY ONCE on the initial press; a future toggle key added below inherits the fix free. NEW `tools/check-key-repeat.mjs` GREEN (drives the REAL Input with a mocked DOM: held T/Esc/V/number fire their toggle exactly once, held W keeps moving through the burst); check-input-mode / check-taunts / check-pc-controls GREEN (no regression); page boots clean (0 console errors, desktop). FULL DETAIL: `notes/input-mouselook.md` (auto-repeat section).

- **CONTINUOUS held inputs are UNAFFECTED.** WASD movement is read every frame off `this.keys`; Space jump off the `this.jump` flag — both set by the FIRST keydown and cleared on keyup, so they never needed the repeat events. The Space carve-out only preserves its page-scroll `preventDefault` while held.
- **ESC path double-checked (plan step 4):** Esc-while-LOCKED opens pause from `pointerlockchange` (the browser releasing the lock) — NOT a keydown, so auto-repeat can't reach it; only Esc-while-unlocked routes through the guarded `onKeyDown`. Both correct.
- **Editor covered too.** `js/editor.js#_onKey` has its OWN separate window keydown listener; it got the same `if (e.repeat) return;` guard so holding a number can't spam-spawn props and holding `?` can't strobe the help panel. Side effect: hold-to-nudge on R / +/- now needs repeated presses (intended — a stuck key no longer runs away).
- **Files:** `js/input.js` (repeat guard at top of `onKeyDown`), `js/editor.js` (repeat guard in `_onKey`), `tools/check-key-repeat.mjs` (new), `notes/input-mouselook.md` (auto-repeat section), this file. NO change to movement/jump/mouse-look/touch controls/netcode/physics. (The stale `client/js/input.js` dead-code copy was left untouched per the standing note.)
- **OWED — live PC pass:** hold T (taunt menu opens once, stays open — no flicker), hold ESC (pause opens once), hold a number key (selects one tool, no spam), and confirm holding W still walks continuously.

## Latest: PROP JUMP FIXED — mis-sized depenetration proxy (2026-07-18, VRmike, branch build/162-prop-jump-broken-debug). Disguised prop players got a ~5-inch hop instead of a full jump on plain ground (worked against a wall). DEBUG-FIRST via 3 headless harnesses over the REAL PhysicsWorld: root-caused to the anti-tunnel depenetration failsafe zeroing jump velocity because its bounding-capsule PROXY dipped below the floor for WIDE-SHORT disguises (crate/table/counter/chair) — while still it was masked by a stale broad-phase, but the moment the body moved the query refreshed and killed the jump. ONE-LINE FIX in `_buildMoveColliderDesc`: cap the proxy radius at the shape half-height (`radius = max(0.05, min(hx, hz, halfH))`) so the proxy stays inscribed and never pokes below the foot. Only the FAILSAFE proxy shrinks; real movement collision (the true prop shape) is UNCHANGED. NEW `tools/check-jump.mjs` GREEN (standing + moving jump reaches full height for hunter + all disguise sizes; self-test proves it bites on the pre-fix proxy); check-physics-live / check-solid-players / check-physics-solidity / check-settle GREEN (no regression); page boots clean (0 console errors). FULL DETAIL: `notes/physics.md` (2026-07-18 section).

- **Files:** `shared/physics.js` (`_buildMoveColliderDesc` proxy-radius cap), `tools/check-jump.mjs` (new guard), scratch probes `tools/_jump_probe.mjs` / `_jump_cosim.mjs` / `_jump_pen.mjs` (debugging record), `notes/physics.md` + this file. NO change to the jump code, snap-to-ground, grounded clamp, reconciliation, or the real collision shape.
- **OWED — live pass:** disguise as a crate/table on flat ground and jump while walking → full ~5-foot jump (not a stub); confirm tall disguises (bottle) and the hunter still jump normally, and that disguised players still feel solid to a hunter (unchanged).

## Latest: PROP FINDER SOUND FOR ALL + GRENADE FLING (2026-07-18, VRmike, branch build/159-prop-finder-sounds-for). Two playtest additions, both riding EXISTING rails (audio graph / referee events / Rapier object sync) — NO new netcode. check-finder (§G new, all ✓) + check-grenade (§I new, all ✓) GREEN; check-combat-sfx / check-object-sync / check-combat GREEN (no regression); page boots clean (0 console errors, desktop). Owes a live 2-player pass. FULL DETAIL: `notes/prop-finder.md` (sound-for-all) + `notes/combat-sfx.md` (finder ping FOR ALL) + `notes/hunter-grenades.md` (FLING section).

- **(1) FINDER PING HEARD BY EVERYONE.** Before, the finder ping was PRIVATE to the activating hunter (played off the `kind:'find' ok` reply). Now `referee.applyFind`, on a SUCCESSFUL activation, ALSO broadcasts `S2C.EVENT kind:'finderPing' {by, x, y, z}` carrying ONLY the ping's world position. `main.js onEvent case 'finderPing'` plays it POSITIONALLY (`playCombatSoundAt('finderPing', …, 0.6)`) through the SAME combat-SFX path / master limiter as the other sounds — but IGNORES its own echo (`msg.by !== state.selfId`), so the hunter keeps their instant local ping (no double-ping, no net lag on their own click). A cooldown-REJECTED activation broadcasts nothing. ANTI-LEAK: position-only payload, never prop data; finder is HUNTING-only → blindfold/withholding rules untouched. Side effect (the point of the ask): props get an audio warning a hunter is scanning nearby.
- **(2) GRENADES FLING LOOSE PROPS.** `_resolveGrenadeBlast` step (4): for each loose DYNAMIC prop in the blast (`d < outer`, `grenadeFalloff > 0`), the host calls NEW `physics.applyBlastImpulse(prop.id, center, flingSpeed × falloff)` — outward shove, speed LINEAR to the damage (close = big fling, edge = a nudge), reusing the SAME `outer`/`grenadeFalloff` as the damage loops (B3-tuned radii, no new balance math). `applyBlastImpulse` derives an outward dir from the body's live translation (+0.35 up bias), MASS-SCALES the impulse (heavy table vs light burger both react, no tiny-prop launch, like the shot kick), wakes the body, fail-silent for a missing/non-dynamic body (disguised PLAYERS are kinematic → never flung, only loose world objects fly) / no physics / speed≤0. Config `rules.grenade.flingSpeed` (8; 0 disables) via `resolveGrenadeCfg`. NO new netcode — rides the existing host→peers awake-prop snapshot stream; blindfold data-gate still applies.
- **Files:** `shared/protocol.js` (kind:'finderPing' doc), `shared/referee.js` (applyFind broadcast + _resolveGrenadeBlast fling loop), `shared/physics.js` (applyBlastImpulse), `shared/damage.js` (resolveGrenadeCfg flingSpeed), `shared/config/rules.json` (grenade.flingSpeed + comment), `js/main.js` (case 'finderPing'), `tools/check-finder.mjs` (§G) + `tools/check-grenade.mjs` (§I), `notes/prop-finder.md` + `notes/combat-sfx.md` + `notes/hunter-grenades.md` + this file. NO change to damage math / redemption / cooldown / snapshot format / disguise render / the settle physics or shot-impulse path.
- **OWED — live 2-player pass:** one player throws a grenade near a cluster of loose props (they fly outward, close ones harder), the other listens for the finder ping from across the map (positional, hears a hunter scanning); confirm the thrower hears their own ping once (no double), a disguised-player crate is NOT flung.

## Latest: B7 — HUNTER TOOL VISIBILITY ON MODEL (2026-07-18, VRmike, branch build/161-b7-hunter-tool-visibility). Other players now see WHICH tool the hunter has selected on the hunter's third-person model — before, everyone saw a rifle no matter what (grenade + prop finder were invisible to others). NEW `tools/check-tool-visibility.mjs` GREEN (29 ✓); check-flicker (extended §3) / check-blindfold / check-hunter-model / check-combat / check-team-flip / check-finder / check-grenade GREEN (no regression); page boots clean (0 console errors, desktop). Owes a live 2-window pass. FULL DETAIL: `notes/hunter-tool-visibility.md`.

- **SALVAGE:** the killed build #154 landed NOTHING — branch synced from `main` (HEAD = B6, f44a1b6), no `tool` in the snapshot, `setViewModel` still local-only, `setWeaponVisible` unused. Built fresh from the B6 baseline (same as killed #152/#127).
- **AUDIT (plan step 3 — is the tool already synced?): it was NOT.** The held item was purely local before B7 — `_buildHunterModel` always parented the rifle; `setViewModel` (first-person) was local-only; the snapshot carried no tool. So the tool selection was genuinely MISSING from the wire. Added it.
- **(1) NETCODE — host-authoritative tool relay.** NEW `C2S.SELECT_TOOL {tool}` + `HUNTER_TOOL_IDS = ['rifle','finder','grenade']` (protocol.js, the ONE canonical id list both sides read). `js/main.js syncSelectedTool()` reports the selection (deduped via `state.toolSynced`, living-hunter-only, called from `applyToolView`). `referee.applySelectTool` accepts it ONLY from a living hunter + a whitelisted id (else keeps current — a modified client can only change its OWN held item, never spoof another's), stores `player.tool` (init'd + reset to `'rifle'` at every spawn/round/lobby seam), and `broadcastSnapshot` rides a COERCED `tool` per entry (valid id for hunters, null otherwise). Rides all snapshot variants free (blind/hunterSafe spread `...full` players).
- **(2) RENDER — per-hunter held-item swap (`js/scene.js`).** `_buildHunterModel` now pre-builds ALL THREE held meshes on the `Wrist.R` bone (rifle GLB + cheap grenade/finder primitives matching the first-person viewmodels — no new assets), stored as `ctl.heldTools`. `_applyHeldTool(ctl, toolId)` shows only the selected tool's mesh (per-hunter, rifle fallback), called on build + every snapshot from `syncPlayers`. Grenade/finder sized to the bone via the shared `_scaleHeldToBone`. A mid-game joiner already holding a non-rifle tool reflects immediately.
- **(3) ANTI-FLICKER.** New held meshes are built inside `_buildHunterModel` → routed through the ONE `preparePlayerModel` choke point (culling OFF); belt-and-braces `frustumCulled=false` in `_buildHeldPrimitive` + `_scaleHeldToBone`. `check-flicker.mjs` §3 extended to assert it.
- **Purely cosmetic:** `tool` changes NO damage/hitbox/gameplay — the FIRE path (`SHOOT`/`FIND`/`GRENADE`) is unchanged, still client-driven. Only which MESH others see in the hand.
- **Files:** `shared/protocol.js` (C2S.SELECT_TOOL + HUNTER_TOOL_IDS + snapshot doc), `shared/referee.js` (import + player.tool init/4 resets + handleMessage case + applySelectTool + snapshot field), `js/scene.js` (_buildHunterModel held-tools rebuild + _buildHeldPrimitive/_scaleHeldToBone/_applyHeldTool + ctl.heldTools + syncPlayers wiring + setWeaponVisible superseded-note), `js/main.js` (state.tool doc + toolSynced + syncSelectedTool + applyToolView call + 2 teardown resets), `tools/check-tool-visibility.mjs` (new), `tools/check-flicker.mjs` (§3 held-tool culling), `notes/hunter-tool-visibility.md` (new) + `hunter-character-model.md` + `architecture.md`, this file. NO change to physics/damage/settle/audio/the fire path.
- **OWED — live 2-window pass:** hunter cycles rifle → grenade → finder while a second player watches the held item change on the hunter's model each time; a hunter who JOINS mid-game holding a non-rifle tool shows it right. Tune the in-hand grenade/finder size/grip (`_scaleHeldToBone` worldLen) if it sits oddly — hot-tunable.

## Latest: B6 — SPECTATOR MODE (2026-07-18, VRmike, branch build/160-b6-spectator-mode-playtest). Dead/spectating players get a free-fly camera + the ability to switch between watching live players, with the controls documented. NEW `tools/check-spectator.mjs` GREEN (data-gate + client wiring); check-object-sync / check-blindfold / check-team-flip / check-sync-convergence / check-combat / check-lifecycle / check-pc-controls GREEN (no regression); page boots clean (0 console errors, desktop + phone). Owes a live 2-device pass. FULL DETAIL: `notes/spectator-mode.md` + `notes/anti-cheat-blindfold.md` (§5) + `notes/third-person-camera.md`.

- **RECOVERY:** the killed build #152 landed NOTHING usable — `main` HEAD is B5 (36c650c) and B6/B7 never committed (B8 was a no-op). No partial spectator work to keep or throw away; built fresh on a clean tree.
- **AUDIT (VRmike's "missing vs. undocumented"):** before B6 a dead player's camera was PINNED to the death spot (`state.movable=false` → no prediction; the referee skips `!alive` in `integrate`). Look-in-place worked (`lookFrozen` is hunter-only); fly cam + player switching were genuinely **MISSING**, documented only by the vignette subtitle.
- **(1) FLY CAM** — a dead player free-flies: `scene.updateSpectateFly` reuses the debug free-cam math (`_flyStep`, extracted so both share it) CLAMPED to the map (`±size/2` horizontal, `[0.6,size]` vertical) so nobody flies into the void. No collision. PC WASD + mouse, Space up / Shift down; phone joystick + drag-look (reused touch controls), JUMP up. Its eye (`_specPos`) is separate from the debug cam's `_fcPos`.
- **(2) PLAYER SWITCHING — reuse, not rebuild** — `scene.spectateFollow` orbits the SAME third-person camera props use (the orbit block was extracted from `setCamera` into `scene._orbitCameraTo`; follow calls it pointed at the watched player — no drifting second cam). `spectateCycle` rings `[free-fly, ...live players]`: PC left-click cycles (`onAction` routes 'primary'→cycle while dead), phone ◀/FLY/▶ bar, Space snaps follow→free-fly. Watched player dies/leaves → auto-hop to the next; none → free-fly. Target pos from `scene.playerViewPos` (interpolated mesh).
- **(3) ANTI-CHEAT GATE (data)** — a dead teammate on voice watching props hide is the blindfold leak. The `broadcastSnapshot` gate EXTENDED from `hunter-during-HIDING` to `hunter-OR-dead-during-HIDING` (`blindHunterSnapshot`), and the `setPhase(HUNTING)` `kind:'world'` catch-up now also goes to dead spectators. From HUNTING onward a spectator sees EVERYTHING incl. disguised-prop names (a dead hunter falls through to the FULL feed, NOT the name-blanked `hunterSafeSnapshot` — that stays for LIVING hunters). Decided per plan rev 2, not accidental. Living hunters/props byte-identical.
- **(4) DOCS** — a "Spectating" block in both PC + touch `_controlsHtml()` lists (pause "Controls" + corner reference), plus a live on-death hint line (`ui.setSpectateHint` on the `#spectateHint` vignette subtitle) that reflects fly vs follow.
- **Files:** `shared/referee.js` (broadcastSnapshot gate + setPhase catch-up), `js/scene.js` (`_orbitCameraTo`/`_flyStep` extractions + `enterSpectate`/`updateSpectateFly`/`spectateFollow`/`playerViewPos`/`_specPos`), `js/main.js` (`state.spectate` + `setSpectating`/`spectateCycle`/`setSpectateMode`/`updateSpectateHint`/`updateSpectatorCamera` + frame-loop branch + onAction cycle + teardown resets + spectate button callbacks), `js/ui.js` (`setSpectateHint`/`setSpectateControls` + els + button wiring + `_controlsHtml` Spectating rows), `index.html` (`#spectateHint` + `#spectateBar`), `css/style.css` (`.spectate-bar`/`.spectate-btn`), `tools/check-spectator.mjs` (new), `tools/check-blindfold.mjs` (extended-gate assertion), `notes/spectator-mode.md` (new) + `anti-cheat-blindfold.md` + `third-person-camera.md` + `architecture.md`, this file. NO change to physics / combat / netcode beyond the one snapshot gate.
- **OWED — live 2-device pass:** die → free-fly (clamped inside walls, Space/Shift), left-click to follow a player (name shows), cycle everyone + back to free-fly, Space snaps back, watched player dies → auto-hop; phone joystick + ◀/FLY/▶. Confirm a spectator during HIDING sees no props then the full world at HUNTING. Retune the follow look-at height (`_camHeadY + meshY`) if it sits high/low on some models.

## Latest: B5 — COMBAT SFX (2026-07-18, VRmike, branch build/145-b5-combat-sfx-playtest). Four synthesized combat sounds added to the EXISTING audio graph — NO gameplay/damage/netcode change, only new client listeners on already-broadcast events. All routed through the master limiter (465666e), all fail-silent, per-source gains modest. NEW `tools/check-combat-sfx.mjs` GREEN (48 ✓); check-audio-limiter / check-taunts / check-combat / check-grenade / check-finder GREEN (no regression); page boots clean (0 console errors, desktop). Owes a headphone live pass. FULL DETAIL: `notes/combat-sfx.md`.

- **(1) GUNSHOT on rifle fire** — hooks the existing `kind:'shot'` event. The shooter (`msg.by===selfId`) hears their own shot NON-positional/close (`scene.playUiSound`, 0.4) so it isn't weirdly HRTF-panned; everyone else hears it POSITIONAL at the muzzle `(ox,oy,oz)` (0.7) through the inverse-square + HRTF path.
- **(2) GRENADE blast** — hooks `kind:'grenade'`; POSITIONAL boom at the blast centre `(x,y,z)` (0.8) for everyone (the thrower is near it, so positional too).
- **(3) FINDER activation PING** — hooks the `kind:'find'` `ok:true` reply (host's PRIVATE reply to the activating hunter — so local-only); an ASCENDING bell tone, deliberately DISTINCT from the DESCENDING deny buzz. POSITIONAL at the hunter's own position (0.6).
- **(4) PROP OUCH pitch-by-size** — hooks `kind:'hurt'` with `self:false` on a PROP-role victim (skips the hunter's `self:true` wrong-guess/backfire; fires for BOTH rifle + grenade — shared `_damagePlayer`→`hurt`). ONE shared clip PITCH-SHIFTED by prop size via Web Audio `playbackRate`: tiny burger squeaks HIGH (rate 1.8), big table/fridge groans LOW (0.7), undisguised = neutral 1.0. The rate is derived from the SAME `entrySize`/`halfExtentsFor` footprint the damage curve scales by (`shared/damage.js` NEW `ouchPlaybackRate`/`ouchRateForDisguise`, mirroring `multiplierForDisguise`) so pitch + damage can never disagree about prop size; anchors default to (and are passed) the live `damage.smallSize/largeSize`. Positional at the prop. Pitch bounds (`maxRate 1.8`/`minRate 0.7` in `resolveOuchCfg`) are re-tunable feel knobs.
- **Audio plumbing:** NEW `js/scene.js playPositionalSound(pos,buffer,opts)` — a fire-and-forget POSITIONAL one-shot at a FIXED world point (taunts follow a player; these don't), reusing `playTaunt`'s engine verbatim: `PositionalAudio(listener)` → preGain → master limiter → destination, exponential inverse-square falloff (COMBAT_FALLOFF_TARGET 0.03 / EXP 2), HRTF (`TAUNT_PANNING`), per-source `setVolume`, optional `setPlaybackRate` (the ouch pitch lever). One-shots tracked in `_oneShots`, reaped in `updateTauntEmitters`, cleared via `_stopAllOneShots()` in the buildWorld teardown (a PositionalAudio source is a Web Audio node, not a scene child — must be STOPPED, not dropped). Fail-silent at every layer (no buffer/pos/listener → no-op, try/catch, never throws).
- **Sounds are OUR OWN generated tones** (`tools/gen-gunshot.mjs`, `gen-grenade.mjs`, `gen-finder-ping.mjs`, `gen-prop-ouch.mjs` + shared `tools/_wav.mjs`, same authoring model as `gen-finder-deny.mjs`) → `assets/combat/{gunshot,grenade,ouch}.wav` + `assets/finder/ping.wav`. Nothing ripped. Generated WAVs are NOT in `manifest.json`/`CREDITS.md` (those are for `fetch_asset` downloads; `deny.wav` follows the same convention). The WAVs ship; the generators don't.
- **Files:** `shared/damage.js` (`resolveOuchCfg`/`ouchPlaybackRate`/`ouchRateForDisguise`), `js/scene.js` (`playPositionalSound`/`_disposeOneShot`/`_stopAllOneShots`/`_oneShots` + reap in `updateTauntEmitters` + teardown clear), `js/main.js` (import from damage.js + `COMBAT_SFX` registry + `_withCombatSfx`/`playCombatSoundAt`/`playCombatSound2D`/`playPropOuch` + hooks in `onEvent` shot/grenade/find/hurt), `tools/_wav.mjs` + `tools/gen-{gunshot,grenade,finder-ping,prop-ouch}.mjs` (new) → 4 WAVs, `tools/check-combat-sfx.mjs` (new), `notes/combat-sfx.md` (new, cross-linked from `audio-taunts.md`), this file. NO change to referee/protocol/physics/netcode/damage math/snapshot/disguise render.
- **OWED — live pass (headphones):** own shot plays plainly, a teammate's shot pans by direction/distance; grenade booms positionally at the blast; finder ping (ascending, ≠ deny buzz); shoot/blast props of different sizes → ouch squeaks for a burger, groans for a fridge, at the prop's position; several overlapping combat sounds stay loud-but-clean (limiter); spot-check iOS (audio unlocks in the fire/tool tap gesture).

## Latest: B4 — PC FEEL/CONTROLS (2026-07-18, VRmike, branch build/144-b4-pc-feel-controls). Three PC/keyboard-side playtest fixes; the mobile touch UI is UNTOUCHED. NEW `tools/check-pc-controls.mjs` GREEN (38 ✓); check-solid-players / check-input-mode / check-physics-live / check-combat GREEN (no regression from the speed bump); page boots clean (0 console errors, desktop). Owes a live PC + mobile pass. FULL DETAIL: `notes/pc-feel-controls.md` (sensitivity + controls panel) + `notes/balance-tuning.md` (run speed).

- **(1) RUN SPEED +50%.** `shared/config/rules.json` → `moveSpeed` **6 → 9** m/s (+ a `_moveSpeedComment`). The SINGLE authoritative run speed, read from this ONE knob by the host's movement (`shared/referee.js integrate` + `shared/physics.js _substep`) AND every client's prediction (`js/main.js`), so everyone speeds up in lockstep — no desync. NO movement sanity-check to update: movement is host-authoritative from input INTENT (`mx,mz`), never client-reported positions, so there's no "moving too fast" guard to false-flag legit players. Hot-tunable playtest value (VRmike will retune; may be zoomy in tight corridors). `check-solid-players` already reads `moveSpeed` relationally (asserts the disguised-nudge stays `< moveSpeed*0.4`) — auto-tracks the retune, green at 9.
- **(2) MOUSE SENSITIVITY slider (PC only).** Pause-menu `<input type=range>` 0.2×–3× (default 1× = the historical 0.0022 feel exactly). `js/input.js`: `BASE_SENSITIVITY×multiplier` + exported `SENSITIVITY_RANGE` + `setSensitivity(mult)` (clamps, applies LIVE — the drag changes feel with no Apply/restart; touch `touchLookSens` is a separate untouched knob). `js/main.js`: persisted to **localStorage** `prophunt.sensitivity` (NOT cookies), restored on boot, silent fall-back to 1× on missing/corrupt/out-of-range. `js/ui.js`: `#pauseSensRow` hidden on touch (same `prefersTouchControls()` check), `input` event → `onSensitivityChange` live, `setSensitivityValue()`.
- **(3) PC CONTROLS REFERENCE panel.** `#controlsRef` — always-visible bottom-right corner list of every binding, visible by default, tiny ▾/▸ collapse toggle. `ui.buildControlsRef()` populates it from the SAME `_controlsHtml()` rows the pause "Controls" panel uses (ONE source of truth — can't drift), hidden on touch. Lives inside `#game` so it only shows during a match.
- **Files:** `shared/config/rules.json` (moveSpeed 6→9 + comment), `js/input.js` (BASE_SENSITIVITY + SENSITIVITY_RANGE + setSensitivity + sensitivityMult), `js/main.js` (SENS_KEY save/load + boot apply/wire + ui.buildControlsRef), `js/ui.js` (sensitivity slider els/wire/hide + setSensitivityValue + buildControlsRef/_toggleControlsRef + els), `index.html` (#pauseSensRow slider + #controlsRef panel), `css/style.css` (.pause-sens* + .controls-ref*), `tools/check-pc-controls.mjs` (new), `notes/pc-feel-controls.md` (new), `notes/balance-tuning.md` (B4 speed), `architecture.md`, this file. NO change to physics/audio/tools/netcode beyond the one speed number, and NO change to the mobile touch UI.
- **OWED — live pass:** PC — drag the sensitivity slider (look changes live), reload (setting persists), controls panel reads clearly + collapses; mobile — pause menu has NO slider + NO corner controls panel; confirm +50% speed feels right (or dial `moveSpeed` back).

## Latest: B3 — BALANCE KNOBS (2026-07-18, VRmike, branch build/143-b3-balance-knobs-small). Three config/CSS number changes from playtest feedback, NO new systems or logic. check-grenade / check-finder GREEN; page boots clean (0 console errors, desktop). FULL DETAIL: `notes/balance-tuning.md`.

- **(1) GRENADE radii −40% (was OP).** `rules.grenade.fullDamageRadius` 1→**0.6**, `falloffDistance` 2→**1.2** (kept the core+falloff authoring style; derived outer 3→**1.8 m**). baseDamage/size-mult/backfire/redemption UNCHANGED — only blast geometry shrank. `shared/damage.js grenadeFalloff` untouched (scales off config).
- **(2) PROP FINDER range +70%.** `rules.finderRadius` 8→**13.6 m** (cooldown 20 s unchanged). WATCH: may feel too strong in the restaurant's tight rooms — dial down if so.
- **(3) DEAD VIGNETTE darker.** `css/style.css` `.spectate` gradient `#00000000 40% → #00000066 100%` became `#00000000 25% → #00000099 100%` — tint starts sooner + ~60% black at edges (~10%→~30% perceived). Centre stays clear (spectator view preserved). The literal old corner alpha was already 0x66 (40%); VRmike's "10%" was a perceived-average estimate. One-line re-tunable.
- **Guard scripts made tuning-proof:** `tools/check-grenade.mjs` + `tools/check-finder.mjs` now READ these knobs from `rules.json` and assert RELATIONSHIPS (outer = full+falloff, radius > 0, targets in/out of the CONFIGURED radius) with test positions derived from config — so a future balance pass changing these numbers won't break either check. No re-hardcoded literals left.
- **Files:** `shared/config/rules.json` (grenade radii + finderRadius + grenade comment), `css/style.css` (.spectate vignette), `tools/check-grenade.mjs` + `tools/check-finder.mjs` (config-driven asserts), `notes/balance-tuning.md` (new), this file. NO netcode / physics / referee / snapshot / disguise change.
- **OWED — live pass:** confirm grenades feel less corner-clearing but still lethal up close; watch the finder's 13.6 m reach on the restaurant map (too strong?); die and confirm the death vignette reads clearly darker without hiding the spectator view.

## Latest: LIFECYCLE BUGS — GHOST PLAYERS + HUNTER SPAWN CLIPPING/EMBEDDING (2026-07-18, VRmike, branch build/142-b2-lifecycle-bugs-ghost). Three playtest fixes, all HOST-SIDE in `shared/referee.js` + `shared/physics.js` (no protocol change). NEW `tools/check-lifecycle.mjs` GREEN (31 ✓: part A pure referee, part B live Rapier); check-solid-players / check-combat / check-team-flip / check-sync-convergence / check-physics all GREEN (no regression); page boots clean (0 console errors, desktop). Owes a live pass. FULL DETAIL: `notes/netcode.md` (ghost players) + `notes/spawn-system.md` (spawn clipping/embedding).

- **(1) GHOST PLAYERS.** A player who left persisted as an uncontrolled ghost. GRACEFUL close already ran `removePlayer` (unchanged); the SILENT case (phone locks/signal drops, NO WebRTC `'close'`) never did. Now the referee times it out: every C2S message stamps `player._lastSeen` (`handleMessage`), and `tick → _sweepSilentPlayers(now)` (active phases only, where INPUT streams at 20Hz; host never swept; `rules.leaveTimeoutSeconds`=5) removes a silent peer via the SAME `removePlayer` path. `removePlayer(id, reason)` now also broadcasts a public "X left" `kind:'log'` line.
- **(1b) RECOUNT is leave-proof both ways.** A leave removes the player from the roster, so the old `checkRoundOver` (`props.length>0 && …`) could NOT fire when the LAST prop left → round limped to the timer with zero props (ghost-kept-alive). Fix: per-round flags `_roundHadHunters`/`_roundHadProps` (set in `_launchRound`, kept monotonically true in `_spawnOnTeam`/`debugSetTeam`); `checkRoundOver` resolves if EITHER team has no living members AND `_roundHad*` that team → last prop gone → hunters win, last hunter gone → props win. Hunter-less solo round (`_roundHadHunters` false) still runs on the timer. Flags fall back to the live roster count when unset (so check-combat's manual harness keeps death-only behaviour). Flipped-round assignment verified crash-free on a shrunk roster.
- **(2+3) HUNTER SPAWN CLIPPING + PROP EMBEDDING** via ONE resolver, `physics.resolveSpawnOverlap` (extended from the faf3d6b seam-D3 machinery — no new placement math). Phase 1 = player separation (existing, staggers the shared hunter spawn apart, wall-clamped). Phase 2 (NEW `_clearSpawnObstruction`) lifts/nudges the newcomer out of any PROP (`_propHandles`) or interior static FIXTURE (`_staticFixtureTypeByHandle`; NOT the ground/boundary walls), reusing the `_depenetrateFromProps` projectPoint push-out (drops ONTO the obstacle when its top is nearest — verified footY≈crate-top — else nudges beside, floor-clamped + wall-clamped, `updateSceneQueries` each pass for the pre-first-`step` broad-phase). Runs even solo; the `size<2` early-return now gates only phase 1.
- **Files:** `shared/referee.js` (_lastSeen stamp + _sweepSilentPlayers + removePlayer log/reason + leave-proof checkRoundOver + _roundHad* flags), `shared/physics.js` (resolveSpawnOverlap two-phase + _clearSpawnObstruction), `shared/config/rules.json` (leaveTimeoutSeconds + comments), `tools/check-lifecycle.mjs` (new), `notes/netcode.md` + `notes/spawn-system.md` + `architecture.md`, this file. NO change to audio / hunter tools (rifle/finder/grenade) / balance / settle physics / snapshot format / disguise render / the graceful-leave net path.
- **Guards GREEN:** check-lifecycle (new, 31 ✓), check-solid-players (16 ✓ — resolveSpawnOverlap phase-1 unchanged for the no-prop case), check-combat (win conditions incl. death-only), check-team-flip, check-sync-convergence, check-physics. Page boots clean (desktop).
- **OWED — live pass:** a player leaves mid-round (graceful tab-close AND a locked-phone silent drop) → they vanish from everyone's view + roster within ~5s, "X left" shows, and if they were the last prop/hunter the round resolves; round start with 2+ hunters at one spawn (no clip/stick), and a spawn with a prop settled on it (hunter lands on top / beside, never embedded or in a wall).

## Latest: SYNC BUGS — ROLE DESYNC + GAME TIMER DESYNC (2026-07-18, VRmike, branch build/140-b1-sync-bugs-role). Two playtest-reported sync-integrity bugs, both fixed CLIENT-SIDE (the fix data was ALREADY on the wire — no protocol change). NEW `tools/check-sync-convergence.mjs` GREEN (46 ✓); check-team-flip GREEN (no regression); page boots clean (0 console errors, desktop). Owes a live 2-device pass. FULL DETAIL: `notes/netcode.md` (2026-07-18 section) + `architecture.md`.

**AUDIT FIRST: for BOTH bugs the authoritative data already reached the client — the client just wasn't USING it.**
- **(1) ROLE DESYNC** (a player saw THEMSELVES a HUNTER while the host had them a PROP; a real hunter killed them). Root cause: the client's OWN role came ONLY from the one-time private `S2C.ROLE`; a missed/mis-applied announcement during a flip/switch/mid-join stranded the client as the wrong role forever. **Fix — role authoritative-and-ACKNOWLEDGED:** role already rides every snapshot as each player's `hunter` flag and a recipient is ALWAYS in its own snapshot (full / blindfolded-hunter / hunter-safe variants), so `js/main.js onSnapshot` derives `serverRole = me.hunter?HUNTER:PROP` and self-heals via the ONE new `applyRole()` path on any mismatch — converges within one snapshot (~66 ms). Private `S2C.ROLE` kept as belt-and-suspenders. The blindfold's role-based withholding rides the same self-healing role.
- **(2) GAME TIMER DESYNC** (~4s; Jie saw 5s left while the host hit 0 and ended). Root cause: HUD rendered each snapshot's `timeLeft` directly → a snapshot stall froze/drifted it. **Fix — local tick:** NEW PURE `js/hud-timer.js` (`HudTimer`+`formatClock`, no DOM/imports); `main.js` re-anchors `endsAt` on every snapshot + phase event and ticks `ui.setTimer(hudTimer.remaining(now))` each frame. Clamps at 0:00 — round END stays host-authoritative (waits for the host's phase/roundOver event). `stop()` on lobby+menu.
- **Files:** `js/hud-timer.js` (new), `js/main.js` (applyRole + onSnapshot role converge + HudTimer anchor/tick/stop), `js/ui.js` (setTimer + formatClock import + setHud split), `tools/check-sync-convergence.mjs` (new), `notes/netcode.md` + `architecture.md` + this file. NO change to settle physics / audio / tools (rifle/finder/grenade) / solid-player collision / snapshot format / referee logic.
- **Guards GREEN:** check-sync-convergence (new: role converge across flip+switch+midjoin incl. blindfold variant + timer local-tick vs stalled snapshots + source wiring), check-team-flip (unchanged, no regression). Page boots clean (desktop).
- **OWED — live 2-device pass:** one flipped round + one manual team switch + one mid-round join, everyone confirming their role label matches the host; two phones side-by-side watching the timer hit 0 together (and a deliberate network stall — timer keeps ticking, clamps at 0, host ends the round).

## Latest: SOLID DISGUISED PROP PLAYERS — match the real prop (2026-07-18, Jie, branch build/136-make-disguised-prop-players). A disguised player should collide the way the real prop of their disguise does (MOVEMENT collision only — not full realism, no tip/ragdoll). NEW `tools/check-solid-players.mjs` GREEN (16 ✓); check-physics-live / check-combat / check-settle GREEN; page boots clean (0 console errors). Owes a live feel pass. FULL DETAIL: `notes/solid-disguised-players.md`.

**AUDIT FIRST corrected the framing.** The disguised player's MOVEMENT collider is ALREADY the disguise's real prop shape (uncapped `_buildMoveColliderDesc`→`shapeFor`) and other players ALREADY collide against it — a base hunter walking into a big-table disguise already stops ≈1.6 m out (table-half + radius). So part **A (solid contact)** and seam **D1 (collider swaps on disguise change, via the existing `setPlayerCollider` hook)** and **D2 (standing on top — full cuboid incl. top face)** already worked; no separate "outward shell" was added (the movement collider IS the shell — building a second blocker was the ghost-blocker the plan critique warned against). **Plan divergence, noted:** the plan assumed an inward-capped/outward-full asymmetry, but the shipped code has NO inward cap (a deliberate earlier ruling — a big disguise is genuinely big both ways), so inward == outward full size and the asymmetry is moot. The REAL tell was the inverse of "pass through": a disguised player is KINEMATIC (infinite mass) so a shove that bulldozes a real dynamic prop stops dead — an immovable wall. Two gaps closed:
- **(B) HEAVY-OBJECT NUDGE** — `physics._applyHeavyNudges` (host-only, per-substep, ≥2 players): a SUSTAINED push from another player slides a DISGUISED target SLOWLY (`rules.heavyNudgeSpeed` 0.8 m/s, warm-up 3 frames, contact-skin 0.12) along the push, resolved THROUGH the target's own controller (collide-and-slide vs walls, horizontal-only → no tip). Capped + host-authoritative → no teleport-abuse; clients reconcile via existing player-sync (NO new netcode). Gated to disguised targets → hunter-vs-hunter / general player-vs-player is byte-identical (nudge-off == nudge-on, asserted).
- **(D3) SPAWN OVERLAP** — `physics.resolveSpawnOverlap(id)` nudges a freshly spawned player out of anyone it materialised inside (shared hunter spawn / team switch / mid-join), wall-clamped, iteration-bounded; wired at `_spawnOnTeam` + `_buildPhysics` add-loop + the `integrate()` join-race. Gotcha found+fixed: pre-first-`step` spawns read a STALE broad-phase → `intersectionWithShape` returned null; it now calls `world.updateSceneQueries()` each iter.
- **Files:** `shared/physics.js` (`_applyHeavyNudges`+`resolveSpawnOverlap`+`_clearNudgeState`+`heavyNudge` opt+knobs+`WALL_INSET_PHYS`/`clampScalar`), `shared/referee.js` (3 `resolveSpawnOverlap` calls), `shared/config/rules.json` (heavyNudge* + spawnOverlapPushMax), `tools/check-solid-players.mjs` (new), `notes/solid-disguised-players.md` (new), `architecture.md`, this file. NO change to settle physics / object-sync / taunts / finder / grenade+rifle raycast classification / snapshot format / disguise render.
- **Guards GREEN:** check-solid-players (new, 16 ✓), check-physics-live (all ✓), check-combat (incl. shot classification), check-settle (239/239 dynamic, all rest). Page boots clean (desktop).
- **OWED — live feel pass:** run a hunter into a disguised table (blocked at table size, no pass-through/bounce) → hold into it (crawls slowly like heavy furniture, not an immovable wall, not flung); stand on a disguised table; team-switch / mid-join / round-start with several hunters (nobody spawns fused). Guest side is predict→reconcile (brief predict-through then host block snaps back — unchanged model).

## Latest: HRTF BINAURAL PANNING FOR TAUNT AUDIO (2026-07-18, Jie, branch build/134-hrtf-binaural-panning-for). Flipped positional taunts from Web Audio's default `equalpower` pan (cheap L/R only) to `HRTF` (Head-Related Transfer Function — convolves a measured per-ear impulse response) so headphones get TRUE binaural 3D: real front/back + up/down cues equalpower can't produce (before, a taunt dead ahead sounded identical to one dead behind). Zero dependencies — native Web Audio; the realism step BEFORE any external HRTF lib. Touch point exactly as Jie named: `playTaunt` (js/scene.js) sets `sound.panner.panningModel` on each `THREE.PositionalAudio` emitter (THREE exposes the PannerNode as `.panner`). GUARDED + fail-silent — its own try/catch reading `sound.panner` behind `if (panner)`; if `.panner` is missing or the set throws we silently keep equalpower and still play (audio never throws). CLIENT-SIDE knob `TAUNT_PANNING = { model:'HRTF', fallback:'equalpower' }` at the top of js/scene.js — this is render behaviour on THIS machine, NOT authoritative game data, so deliberately NOT in `shared/config/`; applied value is `model || fallback`. Spec-exact strings ('HRTF' uppercase / 'equalpower' lowercase — wrong case is silently ignored by browsers) verified against MDN, not memory. MOBILE-CPU CAVEAT (the one real unknown): HRTF costs a bit more CPU/emitter and the finder's `forceTaunt` can drive ~5+ at once; desktop is trivially fine and a handful is light on modern mobile too, but NOT verified on a real low-end phone under the worst case (headless can't measure audio CPU) — if a phone ever stutters, flip `model`→`fallback` globally or per-platform instead of reverting. `tools/check-taunts.mjs` §C extended (knob exists, guarded `panner.panningModel = model||fallback`, no hard-coded equalpower) — GREEN; page boots clean (0 console errors, desktop). Everything else in the audio path (inverse-square falloff, master limiter, setVolume 0.85, cut-off, iOS unlock) UNTOUCHED. Owes a headphone live pass (walk past a taunting prop → sound moves front→side→behind) + a ~5-taunt phone stutter spot-check. FULL DETAIL: `notes/audio-taunts.md` (HRTF section).

## Latest: INVERSE-SQUARE TAUNT AUDIO FALLOFF (2026-07-18, Jie, branch build/133-inverse-square-taunt-audio). Swapped `playTaunt`'s distance falloff (js/scene.js) from the old LINEAR model to realistic INVERSE-SQUARE decay. Web Audio has no literal "inverse-square" distanceModel, but the EXPONENTIAL model with rolloffFactor=2 IS exactly it (`gain = (d/ref)^-2`). refDistance derived from map size so a taunt one full MAP WIDTH away lands at exactly 3% volume: `ref = size * √0.03 ≈ 0.1732*size` (≈6.24 units on the 36-unit map). Two named knobs `TAUNT_FALLOFF_TARGET=0.03` / `TAUNT_FALLOFF_EXP=2` for one-line retunes. `setMaxDistance` REMOVED (non-linear models ignore it → misleading). KNOWN TRADEOFF (intentional, Jie's experiment): inverse-square never reaches true zero, so distant taunts stay faintly audible (~3%) everywhere instead of going silent like linear did — the two knobs make it cheap to dial down or revert. Everything else in the audio path (emitters, cut-off, iOS unlock, master limiter, setVolume 0.85 trim) untouched. Added falloff assertions (incl. a numeric end-to-end 3%-at-map-width check) to `tools/check-taunts.mjs` §C — GREEN; check-audio-limiter GREEN; page boots clean (0 console errors). Owes a live listen pass (close = full, across map = faint whisper). FULL DETAIL: `notes/audio-taunts.md`.

## Latest: MASTER AUDIO LIMITER — stop the clipping (2026-07-18, Jie, branch build/131-master-audio-limiter-stop). Players reported audible distortion/clipping when several sounds overlap (a few taunting props + finder buzz + a grenade). Root cause is SUMMING, not any one clip: every game sound funnels through THREE's ONE shared `AudioListener` on the camera, and overlapping samples ADD past 0dBFS at that node → the overflow crunches. Fix is purely the OUTPUT audio graph — no change to taunt/finder/grenade logic. NEW `tools/check-audio-limiter.mjs` GREEN (runs the REAL installer against a mock AudioContext, not source regex); check-taunts GREEN; page boots clean (0 console errors). Owes a real-phone listen test. FULL DETAIL: `notes/audio-limiter.md`.

- **ONE choke point.** THREE's `AudioListener` wires `listener.gain → ctx.destination`, and every emitter (`PositionalAudio`, `THREE.Audio`) connects INTO `listener.gain`. We splice a headroom trim + near-brickwall compressor into that single hop: `listener.gain → preGain(0.7) → DynamicsCompressor(limiter) → destination`. One insert covers ALL current + future audio automatically.
- **NEW `shared/audio-limiter.js`** — pure Web Audio, NO THREE import (so the game AND the headless check run the same install code; the check passes a mock ctx). Exports `MASTER_LIMITER` tuning (`preGain 0.7`, `threshold -6dB`, `knee 0`, `ratio 20`, `attack 0.002s`, `release 0.15s`) + `installMasterLimiter(listener)` → `{preGain,limiter}` or `null`; NEVER throws.
- **`js/scene.js`** — `_ensureMasterLimiter()` (idempotent) called from `_ensureAudioListener()`, so the limiter is in place before any emitter plays. Chain lives on the AudioContext, not the scene graph → survives `buildWorld`'s `scene.clear()`. Per-source trim: taunt emitters `setVolume(0.85)` (were full 1.0 inside refDistance) so the limiter is a safety net, not the mixer; `playUiSound` finder buzz already 0.5; grenades are visual-only (no audio node).
- **FAIL-SILENT (audio must never break the game).** `installMasterLimiter` returns null on missing/limited audio (no `createDynamicsCompressor`); if it throws mid-splice it restores THREE's default direct `gain → destination` so audio still plays uncapped. iOS `unlockAudio` gesture path UNTOUCHED.
- **NO true lookahead YET — Jie's ask, answered honestly (approved).** Web Audio's `DynamicsCompressorNode` has no lookahead/sidechain, so a fast transient can poke slightly above the ceiling before the ~2ms attack clamps; the `preGain` headroom makes that rare. A real lookahead = an AudioWorklet with a few-ms delay line + graceful fallback to exactly this compressor. Ship the zero-latency version first (works everywhere incl. iOS Safari); escalate to the worklet ONLY if the live listen test still reveals crunch. `installMasterLimiter` is the single seam to swap.
- **Files:** `shared/audio-limiter.js` (new), `js/scene.js` (import + `_ensureMasterLimiter` + call from `_ensureAudioListener` + taunt `setVolume(0.85)` + 2 constructor fields), `tools/check-audio-limiter.mjs` (new), `notes/audio-limiter.md` (new, linked from `audio-taunts.md`), this file. NO change to referee/protocol/physics/netcode/taunt-finder-grenade logic.
- **OWED — live pass:** real phone — stack 3–4 taunts near your ear + throw a grenade → confirm loud-but-CLEAN (no crunch). If crunch persists on transient spikes, escalate to the AudioWorklet lookahead limiter.

## Latest: HOST-AUTHORITATIVE PHYSICS OBJECT SYNC + WORLD SNAPSHOT ON SPAWN/JOIN (2026-07-17, VRmike, branch physics-object-sync). Fixes the desync where one player knocks an object over and OTHERS — especially hunters spawning in after the hide phase — still see it UPRIGHT. NEW `tools/check-object-sync.mjs` GREEN (17 ✓, drives a real Rapier world + real Referee); check-settle / check-blindfold / check-combat GREEN; page boots clean (0 console errors). Owes a live 2-player pass. FULL DETAIL: `notes/netcode.md` (2026-07-17 OBJECT SYNC section) + `notes/anti-cheat-blindfold.md`.

**AUDIT FIRST (the plan's step 1): the pipe already existed — the gap was the blindfold path, not a missing channel.** The host ALREADY streams AWAKE dynamic-prop transforms every snapshot (`physics.awakeProps()` → `broadcastSnapshot.props`), clients ALREADY interpolate them (`scene.syncProps`), and a mid-round joiner ALREADY gets a live catch-up (`referee._propsCatchup()` in STARTED). So (A) host-authority-over-objects and (C)-for-mid-joiners were live. The REAL desync: a HUNTER is fed ZERO prop transforms through HIDING (blindfold `blindHunterSnapshot` → `props:[]`), and by HUNTING every shoved object has settled ASLEEP — so the awake stream won't resend it — leaving the released hunter rendering the FACTORY-FRESH map. Three surgical fixes, NO new parallel channel:
- **(1) WORLD SNAPSHOT ON BLINDFOLD RELEASE.** `referee.setPhase(HUNTING)` now hands every HUNTER a ONE-TIME `S2C.EVENT kind:'world' {props: _propsCatchup()}` (all dynamic bodies' live transforms). Client (`main.js onEvent 'world'`) → `scene.applyWorldSnapshot` SNAPS the rendered props (+ `predict.syncPropTransforms` the local colliders) to it. HIDING→HUNTING is the only path into HUNTING, so it can't double-fire. This is the "hunter released from hide phase" case = the reported bug.
- **(2) MID-JOIN CATCH-UP IS BLINDFOLD-GATED (anti-cheat).** `_propsCatchup(blind)` returns SPAWN-form props (no live leak) when `blind`; `admitMidGame` passes `blind = role===HUNTER && phase===HIDING` so a hunter joining mid-HIDING can't peek where props were shoved. They get the full world at the HUNTING release (fix 1) — the two mechanisms are ONE.
- **(3) FINAL REST TRANSFORM ON SLEEP (part D).** `physics.awakeProps()` now emits ONE last transform on the awake→asleep EDGE (via `_wasAwake` per body), then goes silent — so a continuously-connected client's pose isn't left marginally off the true rest. A body that stays asleep still streams NOTHING (steady-state traffic near zero, unchanged).
- **NOT done this session (documented OWED, deliberately deferred):** (B) client-side PREDICTION of the object the local player is *directly* pushing (local dynamic sim + reconcile). The current model already propagates a guest's shove correctly THROUGH the host (the guest's avatar shoves the real dynamic body on the host, which streams back) — B is a *feel/responsiveness* upgrade, the riskiest surface (it'd make predict-world props dynamic + add an interaction message), and out of scope for the reported desync. See `notes/netcode.md` for the design so a follow-up can pick it up.
- **Files:** `shared/physics.js` (awakeProps final-rest edge + `_wasAwake`), `shared/referee.js` (`_propsCatchup(blind)` + admitMidGame gate + setPhase release snapshot), `shared/protocol.js` (document `kind:'world'`), `js/main.js` (onEvent 'world'), `js/scene.js` (`applyWorldSnapshot`), `tools/check-object-sync.mjs` (new), `notes/netcode.md` + `anti-cheat-blindfold.md` + `architecture.md`, this file. NO change to settle physics / taunts / finder / grenade / player-sync / the blindfold's withholding logic (gated THROUGH it, never reworked).
- **Guards GREEN:** check-object-sync (new: a-d all pass), check-settle (203/239 asleep after 10s, all rest on a support — final-rest edge added no floaters), check-blindfold (auto-picked up `scene.applyWorldSnapshot`; the referee HIDING gate spelling intact), check-combat. Page boots clean (desktop).
- **OWED — live 2-player pass:** knock a table over on the HOST, a second player JOINS LATE and sees it knocked over (not upright); one blindfolded-hunter round — confirm NO early peek during HIDING, and the world is correct the instant HUNTING starts.

## Latest: TEAM SWITCH + ENDLESS FLIPPED ROUNDS + MID-ROUND JOIN + DISGUISE-LEAK FIX (2026-07-17, VRmike, branch build/128-pause-menu-team-switch). Rebuilt from scratch — the prior build #127 (2df30b8) committed only two PNGs, ZERO code (confirmed via git_show: main HEAD touched only assets/attached_*.png). ALL headless guards GREEN incl. a NEW `tools/check-team-flip.mjs` (55 ✓); page boots clean (0 console errors). Owes a live 2-device pass. FULL DETAIL: `notes/team-switch-flipped-rounds.md`.

Four host-authoritative pieces over the existing referee, NO change to physics/settle/taunts/finder/grenade or the disguise render path:
- **(A) TEAM SWITCH** — pause-menu button → `C2S.SWITCH_TEAM` → `referee.applySwitchTeam` respawns the sender FRESH on the opposite team via the shared `_spawnOnTeam` routine + a PUBLIC `kind:'log'` line ("X switched to hunters"). Active-round only, NO cooldown/anti-abuse (accepted per VRmike).
- **(B) ENDLESS FLIPPED ROUNDS** — `tick()`'s ENDING-expiry now calls `startFlippedRound()` (was `resetToLobby`): flips every team then re-launches via the shared `_launchRound()`. `startMatch` refactored to assign-roles-then-`_launchRound`; the prop-build block is byte-identical (settle/hide-spot mirrors unaffected). Solo guard keeps ≥1 prop.
- **(C) ROOM-CODE COPY** — pause menu shows the room code + a copy button (`navigator.clipboard` w/ feed fallback) so friends can be added mid-game.
- **(D) MID-ROUND JOIN** — `admitMidGame` now assigns the SMALLER team (coin-flip on a tie) via the SAME `_spawnOnTeam`, + a public "joined the …" log (was: always hunter).
- **(E) DISGUISE-LEAK FIX** — host `hunterSafeSnapshot` blanks the NAME on disguised-prop entries in a HUNTER's snapshot (roster label withheld) while KEEPING `disguise` (render shape byte-for-byte — hunters still see the burger). Client `updatePauseScoreboard` hides disguise labels from hunter viewers. Check asserts BOTH halves.
- **Guards GREEN:** check-team-flip (new), check-combat, check-taunts, check-finder, check-grenade, check-settle, check-blindfold, check-disguise-eligibility. Page boots clean (desktop).
- **OWED — live pass:** 2 devices — a switch, a round flip, a mid-join onto the smaller team, and a hunter's pause menu showing no disguise names while disguised props still render normally; room-code copy (+ mobile clipboard fallback).

## Latest: HUNTER GRENADES — third hunter tool (2026-07-17, VRmike, branch build/124-hunter-grenades-third-hunter). The hunter's THIRD selectable tool beside the rifle + prop finder, built on the finder's tool-selection infra (three slots now). ALL headless guards GREEN incl. a NEW `tools/check-grenade.mjs` (56 ✓); page boots clean (0 console errors). Owes a live pass. FULL DETAIL: `notes/hunter-grenades.md`.

LEFT-CLICK (PC) / the fire button (mobile) while the grenade is selected sends ONLY the aim direction (`C2S.GRENADE {dx,dy,dz}`) — the HOST raycasts it and explodes INSTANTLY at the first hit (no arc/travel/fuse/cooldown), reusing the rifle's `raycastShot`. `_resolveGrenadeBlast` (host-authoritative): prop PLAYERS in range take `baseDamage×size-mult×falloff` (same size curve the rifle uses, so tiny props die); the THROWING hunter takes BACKFIRE off non-player DECOY props only (flat `baseDamage×falloff`, NO size mult — ~3 direct decoy hits lethal, math not hardcoded); NO friendly fire, NO direct self-damage. **REDEMPTION** (ordering load-bearing): compute all prop-player damage + all backfire → apply prop damage → if any prop PLAYER died, thrower restored to FULL HP and backfire forgiven; else backfire lands (may kill). Config `rules.grenade` all hot-tunable, authored as **1 + 2** (fullDamageRadius 1 + falloffDistance 2, NEVER a stored outer of 3): d≤1 full, d=2 half, d=2.99 ~0, d≥3 zero. baseDamage 0.45 = 45% of full health.

- **Tool selection reused, THREE tools, MOBILE too:** `HUNTER_TOOLS` gains `{id:'grenade',key:'3'}`; the finder's data-driven tool bar (`ui.buildToolbar` + `onSelectTool`) makes it selectable on PC (key 3 / click) and mobile (tap the same button — no separate mobile UI). Fire button → `tryFire` → `tryGrenade` when selected.
- **Rifle / finder / taunt / settle physics UNTOUCHED** — grenade only reuses `raycastShot`, `describeCollider` classification, `multiplierForDisguise`, and `_damagePlayer`. Damage math is a NEW pure block in `shared/damage.js` (`grenadeFalloff`); no existing damage path changed.
- **Files:** `shared/config/rules.json` (grenade block), `shared/damage.js` (resolveGrenadeCfg/grenadeOuterRadius/grenadeFalloff), `shared/protocol.js` (C2S.GRENADE + grenade event), `shared/referee.js` (applyGrenade + _resolveGrenadeBlast + _propBlastPos + dist3 + case), `js/main.js` (grenade tool + tryGrenade + routing + event), `js/scene.js` (spawnExplosion + blastFlashAt + grenade viewmodel + updateEffects blast + buildWorld reset), `js/ui.js` (flashScreen + controls help), `css/style.css` (.blast-flash), `tools/check-grenade.mjs` (new), `notes/hunter-grenades.md` (new), `architecture.md`, this file. NO snapshot-format / disguise-rule / settle-physics change.
- **Guards GREEN:** check-grenade (new), check-finder, check-combat, check-taunts, check-blindfold (auto-picked up the new scene methods), check-floating-props, check-settle, check-disguise-eligibility, check-debug-menu. Page boots clean (desktop).
- **OWED — live pass:** throw at a crowd (props die, thrower redeemed to full even amid decoys) vs a lone decoy pile (~3 direct decoy hits kill the thrower, no redemption); tiny burger prop dies where a big table prop soaks it; explosion + screen flash read; confirm the redemption heal on BOTH mobile and PC; grenade selectable + throwable on mobile.

## Latest: PROP FINDER — new hunter tool (2026-07-17, VRmike, branch build/122-prop-finder-new-hunter). The hunter's SECOND selectable tool beside the rifle. ALL headless guards GREEN incl. a NEW `tools/check-finder.mjs` (46 ✓); page boots clean (0 console errors). Owes a live pass. FULL DETAIL: `notes/prop-finder.md`.

Selectable weapon-slot tool: while selected it draws a large TRANSLUCENT CYLINDER centred on the hunter (radius `rules.finderRadius`=8 m, effectively infinite height), GREEN@40% ready / GREY@20% cooling, following the hunter. LEFT-CLICK (PC) / the fire button (mobile) activates it. Host-authoritative like the rifle: `C2S.FIND` → `referee.applyFind` forces a RANDOM UNCANCELLABLE taunt out of EVERY living prop within 8 m (2D distance — height ignored, matching the infinite cylinder) via the pre-existing `forceTaunt` hook; victims taunt positionally for everyone through the untouched 3D-taunt path. PER-HUNTER cooldown (`rules.finderCooldownSeconds`=20 s, `player._lastFindAt`, never shared, host-enforced) shown as "Finder (14s)" on the tool button; resets clean to ready on round/lobby transitions + on elapse. A click during cooldown plays a short synthesized denied buzz (`assets/finder/deny.wav`, generated by `tools/gen-finder-deny.mjs` — our own tone, no ripped MS sound). The forced prop's taunt UI LOCKS (greyed/disabled) until the clip finishes — they can't stop it or start their own.

- **TAUNT SYSTEM + physics UNTOUCHED** — `applyFind` only reuses `forceTaunt`; `applyTaunt`/`applyStopTaunt`/`forceTaunt` and all settle physics are zero-diff.
- **Both knobs hot-tunable** (VRmike will adjust in testing): `finderRadius` + `finderCooldownSeconds` in `shared/config/rules.json`, read live by host + client.
- **Files:** `shared/config/rules.json` (2 knobs), `shared/protocol.js` (`C2S.FIND` + `find` event), `shared/referee.js` (`applyFind` + `_finderRadius`/`_finderCooldownMs` + `_lastFindAt` init/reset), `js/main.js` (tryFinder/updateFinderHud/setTauntLocked/resetFinderState/playFinderDenied + `find` event + finder routing + 2 state fields), `js/scene.js` (`updateFinderZone` cylinder + `playUiSound` + buildWorld reset), `js/ui.js` (`setToolCooldown` + `setTauntLocked`), `css/style.css` (`.tool-btn.cooling`, `.taunt-btn.locked`), `tools/gen-finder-deny.mjs` + `assets/finder/deny.wav` (new), `tools/check-finder.mjs` (new), `notes/prop-finder.md` (new), `architecture.md`, this file. NO snapshot-format / disguise-rule / settle-physics change.
- **Guards GREEN:** check-finder (new), check-taunts (relay/hook unchanged), check-combat. Page boots clean (desktop).
- **OWED — live pass:** cylinder colours + follow; mobile fire-button activation; victims audibly taunt for everyone; "Finder (14s)" countdown ticks + resets across a round; two hunters' cooldowns independent; forced prop's taunt button locks then releases; denied buzz on a cooldown click.

## Latest: FLOATING FIXED PROPS — physics saga round 4 (2026-07-17, VRmike, branch build/118-floating-fixed-props-round). Root-caused first, guarded with a fail-first check, then fixed. ALL headless guards GREEN; page boots clean (0 console errors, phone viewport). FULL DETAIL: `notes/physics.md` + `notes/grounding.md` (both 2026-07-17 sections).

Symptom (VRmike screenshot): plates of food + other clutter hung FIXED in mid-air (you could stand on them) and jittered nearby dynamic objects.

- **ROOT CAUSE (git-diagnosed, stated plainly).** Commit `75c900e` ("everything a physics object") added a **`pinClutterAboveY` PIN** (referee.startMatch sets `pinned:(y>0.5)`; physics `_buildProps` keeps `pinned` items a FIXED collider even on the host). EVERY surface prop authored above 0.5 m — plates/food/dishes/pots/condiments on counters/tables — stayed a fixed collider frozen at its authored on-surface height. A fixed body is an infinite-mass obstacle → the solver fights nearby dynamic bodies against it → the jitter. This DIRECTLY contradicts VRmike's standing rule (everything non-architecture is dynamic + falls). The pin was a workaround for clutter LAUNCHING out of tall/degenerate combined-model hulls when made dynamic.
- **THE CHECK THAT PROVES ITSELF — NEW `tools/check-floating-props.mjs`.** Keyed to the physics classifier (`isFixedBodyEntry`), NOT the disguise list. (A) no non-arch/non-wall-attached object is ever a fixed collider — run `--assume-pin=0.5` to simulate main and it NAMES every frozen surface prop (~100 items incl. the plates). (B) floor-standing fixed pieces (pillars) rest on the floor. (C) after seating, nothing spawns embedded in a taller hull. Plus a synthetic self-test so it can't pass by checking nothing. **Fail→pass captured** (report): `--assume-pin=0.5` FAILS naming plates/dinner/food/canisters/condiments; shipped (no pin) PASSES.
- **FIX — reclassify + seat + only-wall-attached-stays-fixed.** (1) NEW `wallAttached` flag on the catalog: door, extractor(vent), pillar, pillar_b. Kept SEPARATE from the disguise list (critic's catch) so doors/vents stay BOTH disguisable AND immovable. (2) ONE rule `isFixedBodyEntry(c) = isArchEntry(c) || isWallAttachedEntry(c)` — physics `_buildStatic`/`_buildProps`, referee prop-split, `scene.js` scenery/prop split, `bounds.js` debug overlay all read it (no drift). (3) The `pin` is GONE (referee + physics + `rules.pinClutterAboveY` deleted). (4) NEW `seatMapData` in `grounding.js` (run at load after `groundMapData`) raises any dynamic item embedded in the collider beneath it up ONTO that collider top, so nothing spawns interpenetrating a tall hull → no launch (verified: worst match-start rise 0.075 m). (5) Props spawn **SEATED + ASLEEP** (`body.sleep()`) — a resting prop costs nothing (phone budget) and doesn't spontaneously tumble; it wakes the instant a player/shot/shoved-neighbour touches it, so it's fully dynamic and stops LOOKING fixed.
- **TWO degenerate hulls fixed (surfaced by "everything dynamic").** `shelf` (asymmetric-COM hull → tipped itself over) and `stove_plain` (0.20 m hull for a 0.9 m stove → pot floated) get a NEW `noHull` flag → use their symmetric primitive box collider. Both now stable/correct.
- **PHONE BUDGET.** `maxDynamicProps` stays 150; referee still sorts biggest-first (fridge/tables/counters/chairs win dynamic bodies, only the tiniest food scraps overflow to a still-collidable static collider — and they're SEATED, so resting not floating). Asleep-spawn makes the fresh map 100% quiet.
- **Taunt system UNTOUCHED** (separate queued build) — `js/taunts.js` zero diff.
- **Files:** `shared/physics.js` (isWallAttachedEntry/isFixedBodyEntry/noHull guard, `_buildStatic`/`_buildProps` keyed to isFixedBodyEntry, pin removed, asleep-spawn), `shared/grounding.js` (seatMapData/findEmbedded/findFloatingProps/supportTopUnder + SEAT_TOL), `shared/referee.js` (isFixedBodyEntry split, pin removed), `shared/bounds.js` (isFixedBodyEntry), `js/scene.js` (isFixedBodyEntry), `js/config.js` (seatMapData at load), `shared/config/fixtures.json` (wallAttached×4 + noHull×2 + doc), `shared/config/rules.json` (pinClutterAboveY removed), `tools/check-floating-props.mjs` (new), `tools/check-settle.mjs` (updated: seat + isFixedBodyEntry + Phase A quiet / Phase B disturbance), `notes/physics.md`+`grounding.md`+this file. Scratch probes `tools/_probe_seat.mjs`/`_probe_shelf.mjs`/`_probe_settle_detail.mjs` (_-prefixed). NO netcode/protocol/scene-render/taunt/disguise-rule change.
- **Guards GREEN:** check-floating-props (new, fail→pass proven), check-settle (Phase A: 150/150 asleep at spawn; Phase B: no launch, all furniture stable), check-grounding, check-disguise-eligibility (doors/vents/pillars/shelf/stove STILL disguisable), check-physics, check-physics-solidity, check-hide-spot-density (render==collider==overlay across 200 seeds — bounds.js consistent). Page boots clean.
- **KNOWN COSMETIC (honest, follow-up).** On the few DOMED combined-model hulls (esp. `table_food`, which already has food modelled), a couple of authored food items seat at the hull-AABB top so they rest a bit HIGH / tumble off when disturbed — the "dynamic & falls" behaviour VRmike asked for, but a tad high on those specific models. Real fix = better collider hulls (or remove the redundant clutter) for `table_food`/the bar tables. Not the reported bug (those items are dynamic, at a real collider extent, and shove when touched).
- **OWED — live pass:** shove plates/pots (they scatter, no jitter, can't stand on one); confirm no plate hangs fixed in mid-air at VRmike's screenshot angle; watch phone-host FPS at match start (should be quiet — all props asleep).

## Latest: TAUNT MENU + PAUSE MENU UX FIXES FOR PC (2026-07-16, Jie, branch build/116-taunt-menu-pause-menu). All keyboard-side; the mobile touch UI (on-screen Taunt button, floating stop, joystick) is UNTOUCHED. `check-taunts.mjs` extended with a section D and GREEN; page boots clean (0 console errors). FULL DETAIL: `notes/audio-taunts.md` (PC UX FIXES section) + `notes/pause-menu.md` (Esc TOGGLES section).

Five specific changes Jie asked for:
1. **Taunt hotkey = T, opens menu + frees the mouse in ONE press.** Already true since the taunt system shipped (`input.js` `KeyT`→`onToggleTaunt`→`openTauntMenu` which `exitPointerLock()`s) — no tilde-first two-step. Verified NO conflict on T in `input.js` (bound keys: KeyE/KeyV/KeyT/Digit1-9/Space/Backquote/Escape; T was already the taunt key). Added a discoverable **`.taunt-hint`** ("T / Esc to close") in the menu header (hidden on touch via `@media (pointer: coarse)`).
2. **In-menu STOP button** (`#tauntStopInline` in `.taunt-head`) — silences your current taunt WITHOUT closing the menu. Same `ui.onTauntStop`→`C2S.STOP_TAUNT` path as the floating button; `ui.setTauntStop` now toggles BOTH together, so it shows only while your cancellable taunt plays.
3. **Menu docked LEFT** — `.taunt-menu` `justify-content: center`→`flex-start`.
4. **Tint REMOVED** — dropped `background:#060010cc` + `backdrop-filter: blur(3px)` from `.taunt-menu`; the game world stays fully visible. Container keeps `pointer-events:auto` so a stray click can't punch through to the canvas and re-lock (which would close the menu); `.taunt-card` bumped to a near-opaque bg (`#170b28fa`) so it reads over the live world.
5. **Esc TOGGLES the pause menu** (was open-only). `main.js input.onRequestPause` now DERIVES the action from live state: taunt menu open→`closeTauntMenu(true)`; pause open→`closePause(true)` (re-locks); else `openPause()`. Pointer-lock minefield sidestepped: Esc reaches this handler ONLY while the mouse is already free (pause/menu open ⇒ unlocked), so the keydown isn't swallowed; the OPEN-from-play path still routes through the browser lock-release→`onLockChange`→`openPause`. Locked/unlocked are mutually exclusive so the two routes never double-fire.
- **Files:** `index.html` (hint + `#tauntStopInline`), `js/ui.js` (wire inline stop + `setTauntStop` toggles both + controls-help text), `css/style.css` (`.taunt-menu` left+untinted, `.taunt-hint`, `.taunt-stop-inline`, `.taunt-head` layout, `.taunt-card` opacity), `js/main.js` (`onRequestPause` toggle), `tools/check-taunts.mjs` (section D), `notes/audio-taunts.md`, `notes/pause-menu.md`, this file. NO change to `input.js` runtime (T already wired), netcode, referee, physics, or scene.
- **OWED — live pass:** desktop — T opens menu + frees cursor, Stop halts a taunt mid-play with the menu staying open, T/Esc closes and re-locks, Esc toggles pause both ways repeatedly without jamming, world visible behind the left-docked menu; phone — taunt button + menu still work (hint hidden).

## Latest: EVERYTHING IS A PHYSICS OBJECT + counters seated ON the floor (2026-07-16, VRmike, branch build/114-make-everything-a-physics — attempt #3; the two earlier attempts shipped nothing). ALL headless guards GREEN incl. a NEW `tools/check-settle.mjs`; page boots clean (0 console errors). Owes a live FEEL + phone-FPS pass. FULL DETAIL: `notes/physics.md` + `notes/grounding.md` (both 2026-07-16 sections).

VRmike: "the physics changes I asked for aren't in; I can't nudge everything and the counters are still stuck below the floor, making my counter disguise useless (it's higher)." Both fixed, root-caused first.

- **DIAGNOSIS (git, not guesswork).** The 6 cm sunken counters are ORIGINAL to commit `9ee0f7d` ("fix #5 THICK FLOORS", 2026-07-10) — the kitchen sits on a raised `floor_kitchen` tile (collider top y=0.06) but every kitchen fixture was authored at y=0, so each buried 6 cm; a counter-disguised player stands ON the tile (0.06) so the disguise floated 6 cm above the real counters. The two suspect collider-overhaul commits (35487c1, 013d9d0) are CLEARED — not a regression, a latent day-one bug hidden by tolerance.
- **GUARD PROVES ITSELF (contract §3).** `check-grounding` PASSED while the screenshot showed sunk counters → the CHECK was wrong. Split the tolerance: `SINK_TOL = 0.02` (tight — clipping a floor is never OK) vs `GROUND_TOL = 0.12` (float). It then FAILED on 44 sunk kitchen items → seated them → PASSES. Fail→pass evidence captured.
- **SEATED (contract §1).** `tools/_seat_kitchen.mjs` shifted the whole kitchen stack up by the tile height (fixtures + the clutter on them, coherently), so every counter's bottom face sits ON the tile and the disguise costume matches the real object exactly. Baked into `maps.json` (clean authored data).
- **EVERYTHING SHOVABLE (contract §2).** Removed `static:true` from 11 built-in types (counters, oven, stove(s), fridge, cabinet, cabinet_corner, prep_sink, table_sink, shelf) → real dynamic bodies. STILL static: arch (floor/walls), pillars (structural columns, wall-class), door, vent/extractor (both `noGround`). One flag flip does it all (dynamic body + drops static collider + still renders + still disguisable, no double collider). Mass=volume×density so fridge is heavy, pot skittery for free.
- **STABILITY.** Surface clutter (authored y>0.5) is `pinned` → fixed collider (was effectively fixed already; waking it dynamic launched plates out of the `table_food` tall hull). Referee orders dynamic candidates GLOBALLY biggest-first; `maxDynamicProps` 130→150 (phone-tunable). Two authored spawn-overlaps fixed (divider `cabinet_corner`↔`wall_post`; back-corner condiments).
- **NEW GATE `tools/check-settle.mjs`** (contract §8b): full map, no players, step 6 s, assert nothing launches/sinks/drifts/tips + ≥90% asleep. GREEN (132 dynamic bodies, 98% asleep). This is the offline gate that would have caught a fridge launching itself out of the floor.
- **Taunt system UNTOUCHED** (contract): `js/taunts.js` zero diff; `check-taunts` GREEN (drives the real referee).
- **Merge mess:** CREDITS.md + assets/manifest.json checked — NO conflict markers or duplicates from the WIP-RECOVERY hand-merge (repo-wide grep clean). Nothing to resolve.
- **Files:** `shared/grounding.js` (+SINK_TOL), `tools/check-grounding.mjs` (msg), `shared/config/maps.json` (seating + 2 overlap fixes), `shared/config/fixtures.json` (un-static 11 + doc comments), `shared/config/rules.json` (maxDynamicProps 150 + pinClutterAboveY), `shared/referee.js` (global biggest-first + pin flag), `shared/physics.js` (pinned→fixed branch), `tools/check-settle.mjs` (new gate), `tools/_seat_kitchen.mjs`/`_counter_diag.mjs`/`_dyn_budget.mjs`/`_embed_probe.mjs` (diagnostics, _-prefixed), `notes/physics.md`+`grounding.md`+`restaurant-map.md`+`architecture.md`, this file. NO change to netcode/protocol/scene render/taunts/disguise rules.
- **Guards GREEN:** check-settle (new), check-grounding (fail→pass proven), check-physics, check-physics-live, check-physics-solidity, check-combat, check-true-colliders, check-collider-visual, check-disguise-eligibility, check-hide-spot-density, check-blindfold, check-debug-menu, check-flicker, check-input-mode, check-taunts. Page boots clean (phone viewport, 0 console errors).
- **OWED — live pass:** shove a fridge (heavy) and a pot (skittery) — tune `propDensity`/damping for feel; disguise as a counter next to a real one and confirm equal height at VRmike's screenshot angle; watch phone-host FPS at match-start settle (~132 dynamic bodies) — drop `maxDynamicProps` toward 120-130 if it hitches.

## Latest: REAL AUDIO TAUNTS WIRED IN + placeholder beeps removed (2026-07-16, VRmike, branch build/112-wire-the-real-audio). The 29 real meme .mp3s VRmike/Teravortryx uploaded via Discord (landed on main via hand-merge 9647253, sitting FLAT in `assets/`) are now registered in `assets/taunts/manifest.json` — unique stable ids, human labels, `file` = bare filename (loader resolves under `/assets/`). Hard-gate PASSED this time: `assets/*.mp3` globs all 29. Removed the 3 placeholder beep entries (beep_high/beep_low/warble); `tools/gen-taunt-placeholders.mjs` retired to a no-op stub. NO mp3 move (canonical root `assets/manifest.json` + `CREDITS.md` already register them flat + `UNVERIFIED` — moving would break those refs). NO UI change needed (menu already scrolls: `.taunt-card` max-height 86dvh + `.taunt-list` overflow-y:auto). `check-taunts.mjs` GREEN (reads ids dynamically — never assumed 3); page boots clean (0 console errors). CAVEAT: no shell/`rm` in sandbox → stale `assets/taunts/beep_*.wav` binaries remain on disk but are unreferenced (delete in a normal commit). OWED: same live iOS/mobile + directional second-device pass. See `notes/audio-taunts.md`.

## Latest: AUDIO TAUNT SYSTEM for props (2026-07-16, VRmike, branch build/100-audio-taunt-system-for). Resumed the interrupted attempt-1 tree (`0a3ce19` WIP-RECOVERY) and FINISHED it. All headless guards GREEN incl. a NEW `check-taunts.mjs` (40 assertions); page boots clean (0 console errors). Owes the live mobile/iOS + directional/second-device pass. FULL DETAIL: `notes/audio-taunts.md`.

A prop presses a taunt button → a scrolling menu of audio taunts opens → picking one plays it as DIRECTIONAL 3D audio at the prop's world position for ALL players (hunters locate props by ear — taunting is a self-snitch by design). Data-driven from a manifest; ~50 real clips drop in later with ZERO code changes.

- **What attempt-1 already had (verified, kept):** the DATA + host half. `assets/taunts/manifest.json` (3 placeholder clips) + `assets/taunts/*.wav` (synthesized by `tools/gen-taunt-placeholders.mjs`, WAV bytes — `Write` can't emit binary); `js/config.js` loads the manifest (tolerant of absent/empty → `cfg.taunts.taunts`); `shared/protocol.js` `C2S.TAUNT{id}` / `C2S.STOP_TAUNT` + `S2C.EVENT` kinds `taunt{by,id,uncancellable}` / `tauntStop{by}`; `shared/referee.js` `applyTaunt` (validates living-prop + active-phase + real id, then broadcasts) / `applyStopTaunt` (ignored when uncancellable) / **`forceTaunt(propId)`** (finder-tool hook, dormant — one line to wire, marks the taunt uncancellable); `js/scene.js` positional-audio engine (`AudioListener` on the camera, one `PositionalAudio` emitter per taunter keyed by id, `playTaunt`/`stopTaunt`/`updateTauntEmitters`, per-emitter CUT-OFF, linear falloff tuned to `map.size`, `unlockAudio`).
- **What THIS session added (the missing client half):**
  - **`js/taunts.js` (NEW) — `TauntLibrary`:** lazy per-clip fetch+decode with a cached PROMISE (no double-fetch), `prefetch()` for the whole library, decode via `scene.loadAudioBuffer` (THREE.AudioLoader → shared ctx, Safari-safe). NEVER preloads at join.
  - **`js/scene.js`:** `loadAudioBuffer(url)` (AudioLoader→AudioBuffer, null on fail) + `clearAllTaunts()`; buildWorld cleanup now `_stopAllTaunts()` (was `.clear()` — a PositionalAudio is a Web Audio node, NOT a scene child, so clearing the map left it playing into the next match).
  - **`index.html` + `css/style.css`:** taunt button + stop button (TOP-CENTRE band — clear of the joystick bottom-left, action/jump/rotate bottom-right, pause ☰ top-right, mid banner) + the scrolling menu overlay (big touch targets, ✕ close, empty-state note).
  - **`js/ui.js`:** `buildTauntList` (data-driven rows from the manifest), `openTauntMenu`/`closeTauntMenu`, `setTauntButton`/`setTauntStop`; callbacks `onTauntButton/Pick/Stop/Close/Prefetch` (UI holds no game logic).
  - **`js/input.js`:** `T` key → `onToggleTaunt` (handled before the pointer-lock gate so it opens while captured AND closes while the menu freed the mouse; no-op on touch / while typing).
  - **`js/main.js`:** wiring in `boot()`; `openTauntMenu`/`closeTauntMenu` (a UI-mode-like state — `state.tauntMenuOpen` frees the desktop mouse WITHOUT opening pause; `onLockChange` + `openPause` respect it; added to the input-loop `halt`); `sendTaunt` (unlocks audio in-gesture); `onTaunt` (lazy-load buffer → `scene.playTaunt`, shows own STOP button unless uncancellable, auto-hides on clip end); `onTauntStop`; `updateTauntUi` (taunt button = living prop in an active phase, called from `applyToolView` + the phase event); full teardown in `backToMenu`.
- **MENU STAYS OPEN across picks (spam is the feature); ✕/T/Esc close.** CUT-OFF is per-emitter on each client (a prop's new taunt stops their previous one; different props overlap). iOS: audio ctx resumed inside the open/pick gesture (`scene.unlockAudio`).
- **Verify — NEW `tools/check-taunts.mjs` (build-gating, 40 ✓):** (A) manifest ids unique + every clip file exists + non-empty now; (B) drives the REAL referee — taunt relayed to every player tagged by taunter; second taunt re-relayed; stop relayed; hunter/dead-prop/bogus-id/lobby-phase REJECTED; forceTaunt fires uncancellable + the prop's stop is then ignored; a normal taunt clears the flag; empty library degrades gracefully; (C) scene/main/ui/config audio-API source assertions (the "missing scene method silently kills the render loop" guard). Page boots clean.
- **Files:** `js/taunts.js` (new), `js/scene.js`, `js/ui.js`, `js/input.js`, `js/main.js`, `index.html`, `css/style.css`, `tools/check-taunts.mjs` (new), `memory/notes/audio-taunts.md` (new), `architecture.md`, this file. From attempt-1 (already committed): `assets/taunts/*`, `js/config.js`, `shared/protocol.js`, `shared/referee.js`, `tools/gen-taunt-placeholders.mjs`.
- **OWED — live pass:** taunt from a PHONE (confirm sound actually plays on iPhone — the iOS unlock), hear it DIRECTIONALLY on a second device (loud/panned when near, faint when far), spam back-to-back (cut-off, menu stays open), STOP button kills it, ✕ closes without playing. Then drop the ~50 real clips into `assets/taunts/` + manifest lines and confirm ZERO code change is needed.

## Latest: TWO BUG FIXES — spawn-trap lock + grounding (2026-07-16, VRmike, branch build/98-two-bug-fixes-requested). All headless guards GREEN; page boots clean (0 console errors). Owes one live confirm (walk toy_workshop far corners; disguise as a counter next to a real one).

**PART 1 — far-side "locked, snapped back" lock. DIAGNOSED root cause with evidence, not a guess.**
- Mechanism: a spawn placed INSIDE a solid → host depenetration escape-hatch flags the wedged
  player → the `referee.integrate` failsafe teleports them back to `p.spawn` (the SAME trapped
  spot) → repeat. That's the exact "move a little, snapped back to that spot" loop. It requires the
  SPAWN ITSELF to be the trap (else a teleport-to-spawn would free them).
- Ruled the three suspects in/out with a diagnostic that tests every spawn against ALL colliders:
  - (a) spawn-in-object: **CONFIRMED** on `toy_workshop` — `crystal` props sat exactly on spawn
    (12,-12) and 1 m from (-12,12) [both far corners = "far side"]. Overlap −1.15 m / −0.15 m.
  - restaurant (VRmike's dense map): every spawn CLEAR (min 0.35 m) — the density edit (013d9d0)
    did NOT introduce a spawn trap; its added items are all properly grounded.
  - (b) reconciliation-to-stale-pos and (c) bounds-clamp shrink: **REFUTED** — the 013d9d0 bounds
    diff only added the removed-fixtures skip; `wallBound` is derived from wall geometry (unchanged).
- FIX: relocated toy_workshop's two crystals off the spawns (→(9,-9),(-9,9); 2.78 m clearance).
- GUARD: `tools/check-physics.mjs` open-middle guard now tests spawns against **prop/knockable
  colliders** (was static-only, which passed the crystal trap) AND asserts each spawn is inside the
  **walkable area**. Verified it FAILS on the pre-fix data (caught both crystals) then passes.

**PART 2 — floating props / sunken objects + disguise alignment. DELIBERATELY CONSERVATIVE after the data disproved blind grounding.**
- New `shared/grounding.js` `groundMapData(map,catalog)` — ONE pure, physics-free, deterministic
  pass, wired into `js/config.js` loadConfig (the SINGLE shared load point: host referee + every
  client read the same grounded `y`; no per-machine settle → no desync). Guard: `tools/check-grounding.mjs`.
- WHY CONSERVATIVE (proven by dry-run, not assumed): several restaurant GLBs carry a convex hull
  whose TOP is NOT their flat surface — `table_food` hull 1.39 m (a table WITH food modelled),
  `stove_plain` hull 0.20 m though a pot rests on its ~0.9 m cooktop. A blind "rest on the hull-top
  beneath you" relocated ~36 correctly-authored items (sank pots into stoves, flung plates onto
  tabletops) and wasn't idempotent. So the pass ONLY corrects the two UNAMBIGUOUS, support-
  independent failures: **orphan floaters** (piece hanging with nothing under it → drop to the
  floor/kitchen-tile) and **below-floor sinkers** (→ rise to the floor). A piece resting on ANY
  support is left byte-identical. Exempt: architecture + new `noGround` flag on the vent
  (`extractor`) and `door`. On the CURRENT maps the pass is a clean, idempotent NO-OP (no gross
  floaters/sinkers exist today) — it is a deterministic safety-net + regression gate for future edits.
- `check-grounding.mjs` also (A) fails the build if authored maps.json floats/sinks a non-exempt
  piece, and (B) self-tests a synthetic map to prove the pass drops floaters / raises sinkers /
  leaves supported+exempt pieces / is idempotent — so it can't "pass by checking nothing".
- HONEST LIMITS (see notes/grounding.md): the subtler visual mismatches VRmike may have seen
  (authored-`y` vs a GLB's real working-surface, e.g. combined tables/cooktops; a ~6 cm kitchen-
  floor-tile step) are per-ASSET data issues the collider hulls can't adjudicate — NOT auto-
  "fixed" here because doing so demonstrably breaks correct placements. Recommended follow-up:
  bake accurate surface heights / asset-dims for the combined GLBs, or a visual editor pass.
- **Files:** `shared/grounding.js` (new), `js/config.js` (import + load-time pass), `shared/config/fixtures.json`
  (noGround on extractor+door), `shared/config/maps.json` (2 crystal relocations), `tools/check-physics.mjs`
  (spawn guard: props + bounds), `tools/check-grounding.mjs` (new), `memory/notes/spawn-system.md` +
  `grounding.md` (new), this file. Diagnostics left in tools/: `_spawn_diag.mjs`, `_ground_diag.mjs`,
  `_ground_dryrun.mjs` (throwaway, _-prefixed like the existing probes).
- **Guards GREEN:** check-physics (extended spawn guard), check-grounding (new), check-hide-spot-density,
  check-combat, check-disguise-eligibility. Page boots clean (0 console errors).

## Check-repair (2026-07-16, branch build/96-map-density-hide-spot): `check-hunter-model.mjs` was failing on its "main.js passes the character-model registry into buildWorld" assertion. NOT a code bug — the MAP DENSITY commit (013d9d0) correctly appended a new `state.removedFixtures` arg AFTER `characterModels` in the `buildWorld(...)` call, but the check's regex `buildWorld\([^)]*characterModels\)` assumed `characterModels` was the LAST arg (immediately before `)`). Fixed the stale regex to `buildWorld\([^)]*characterModels\b` (still asserts the registry is passed, now tolerant of trailing args). check-hunter-model now GREEN; page boots clean (0 console errors). Check-only change; no runtime code touched.

## Latest: MAP DENSITY + HIDE-SPOT EXPANSION (2026-07-16, VRmike, branch build/96-map-density-hide-spot). ALL headless guards GREEN incl. a NEW `check-hide-spot-density.mjs` + page boots clean (0 console errors, ?debug=1). Owes a live pass (walk the new dining clusters + a round where a built-in was removed). Three parts:

1. **DINING DENSITY (data-only, maps.json → restaurant).** +4 `round_table` fixtures at (±6,3)
   and (±6,10) pairing with the x=±11 columns (clusters of 2 per side, not sparse singles), each
   ringed with 4 inward-facing `diner_chair` props. round_table 6→10, diner_chair 28→44.
2. **GROUPED IDENTICAL PROPS MAP-WIDE (data-only).** Disguisable `ketchup`/`mustard` **bottle
   props** in tight groups on the (0,6) bar top, both back-corner floors, and the (11,3) table
   (16 bottle props, was 0 — a bottle-disguised player blends into a cluster now). `kitchen_stool`
   bunches of 4 at (-15,5)/(15,5)/(0,-8) (8→20). 4-`canister` row on the (4.5,-16.5) cabinet
   (9→13). All knockable/disguisable → subject to the removal pass. Documented in the map's
   `_density` key + `notes/restaurant-map.md`.
3. **HIDE-SPOT REMOVAL 20%→25% + WIDENED TO EVERYTHING DISGUISABLE.** `rules.mapRandomizeSkip`
   0.20→0.25. The load-time removal pass (`referee.startMatch`) now deletes ~25% of DISGUISABLE
   **fixtures** too (knockable + bolted-in built-ins), not just `map.props` — same shared
   `isDisguisableEntry` rule; architecture (floors/walls/ceilings) never removed. **Single upstream
   trim, one place:** the host decides `removedFixtures` (indices into map.fixtures) once and
   broadcasts it in `STARTED` (and the mid-join `admitMidGame` catch-up); every downstream consumer
   keys off it so a removed built-in loses BOTH its LOCAL mesh (`scene.buildWorld` static loop) AND
   its collider (`physics._buildStatic`, mirrored in `bounds.worldColliderBoxes` for the debug
   overlay) — no invisible wall, no ghost-walkable mesh (the stuck-spot failure mode). `main.js`
   threads `state.removedFixtures` into `buildWorld` + `buildPredict`. Overflow past the
   `maxDynamicProps` cap still degrades to a solid static collider (existing machinery, no hand-
   marking). Intended quirk (VRmike): some rounds a pillar/fridge/door is simply absent.
- **Files:** `shared/config/rules.json` (0.25), `shared/config/maps.json` (density + `_density`),
  `shared/referee.js` (removal widening + `this.removedFixtures` + both STARTED sends + `_buildPhysics`
  opts), `shared/physics.js` (`_removedFixtures` + `_buildStatic` skip), `shared/bounds.js`
  (`worldColliderBoxes` optional `removedFixtures`), `js/main.js` (STARTED store + thread), `js/scene.js`
  (`buildWorld` param + static-loop skip + debug overlay), `tools/check-hide-spot-density.mjs` (new),
  `tools/_density_sanity.mjs` (diagnostic), `memory/notes/map-randomization.md` (new) +
  `restaurant-map.md` + `architecture.md`, this file. NO protocol constant / snapshot-format / physics-
  feel / disguise-rule change.
- **Guards GREEN:** check-hide-spot-density (new: ratio 0.25, removal reaches fixtures, arch never
  removed, render==collider==overlay set across 200 seeds, determinism + min-keep, spawn/doorway
  clearance under worst-case density), check-physics, check-physics-solidity, check-physics-live,
  check-combat, check-disguise-eligibility, check-collider-visual, check-true-colliders, check-blindfold,
  check-debug-menu, check-flicker. Page boots clean (?debug=1, 0 console errors).
- **OWED — live pass:** walk the new dining clusters as hunter + prop; wedge into the tightest new
  gaps (chair rows, stool bunches); play a round where a pillar/fridge/door got removed and confirm
  the space is open (no invisible wall) and you can walk a removed spot; disguise as a bottle in a
  cluster and check the blend; eyeball that clusters actually cluster.

## Latest: CONVEX HULLS FOR EVERYTHING — round 3 (2026-07-13, VRmike, branch build/94-convex-hulls-for-everything). Hull the CODE-BUILT architecture (white walls, columns, archway) that round 2 skipped. ALL headless guards GREEN + page boots clean (0 console errors, ?debug=1). Owes a live True-collider eyeball. FULL DETAIL: `notes/convex-hull-colliders.md` (ROUND 3 section).

Round 2 (`600ddcf`) hulled every MODEL-bearing prop but skipped `arch` + code-built (model-less)
geometry, so VRmike's debug screenshots still showed loose boxes floating outside the walls /
columns / archway. Round 3 makes it truly everything.
- **Two sources of the oversized boxes, both fixed:** (a) the arch pieces (`kitchen_wall`,
  `wall_post`, `wall_header`) were model-less box primitives the hull bake skipped; (b)
  `_buildStatic`'s anti-tunnel thin-wall THICKENING grew `wall_header`/`kitchen_wall`/`door`/
  `shelf` to 1.2 m deep around a 0.4–0.58 m mesh — the floating boxes.
- **`tools/build-hulls.mjs`** drops the `arch` skip + adds a `bakeBox` path: a model-less box is
  hulled from the SAME `w/h/d` the renderer draws (`BoxGeometry`), so the hull can't drift (plan
  step 2 — no separate geometry module needed for a plain box). 94 hull types (was ~89): +arch
  +`crate`/`chair`. Safety scan still "all pieces, no room shells."
- **`shared/physics.js` + `shared/bounds.js`** gate the thickening behind `hasTrueShape` (hull or
  measured) → hulled panels use their mesh-hugging shape, no oversizing. Tunnel safety kept
  without growth: panels are backed by boundary walls / high lintels + swept controller + CCD +
  depenetration + floor clamp. bounds.js mirrors the gate so the `?debug=1` AABB overlay +
  check-physics agree with the engine.
- **Two documented exceptions** (reported by the checks, not silent): `floor_kitchen` (thick-down
  slab, visible top flush) + round primitives (`canister`). Arch flags UNTOUCHED → walls stay
  non-disguisable (plan step 6).
- **Verify (Rapier installed dev-only):** `check-true-colliders.mjs` NEW live-restaurant coverage
  section reports **92/92 box-collidable types on hulls, 0 over-coverage**, 2 documented
  exceptions. `check-collider-visual` (all 94 hull AABBs == render), `check-physics`,
  `check-physics-solidity`, `check-physics-live`, `check-combat`, `check-disguise-eligibility`,
  `check-debug-menu` all GREEN. Page boots clean.
- **Files:** `tools/build-hulls.mjs`, `shared/config/hulls.json` (regenerated), `shared/physics.js`
  (`_buildStatic` gate), `shared/bounds.js` (mirror gate), `tools/check-{true-colliders,
  collider-visual,physics,physics-solidity}.mjs`, notes (`convex-hull-colliders.md`,
  `physics.md`, `collider-debug.md`), this file. NO netcode/protocol/referee/render change; NO
  disguise-rule change.
- **Latent bug noted, not fixed (out of scope):** `asset-dims.json` is stale for a few appliances
  (fridge native depth 1.51 vs GLB 2.24) AND `js/config.js` fetches it with a broken backslash
  path — both inert at runtime (hulls supersede `measured`), so no gameplay impact.
- **OWED — live pass:** True Colliders (magenta) — archway posts/beams, walls, columns hug the
  visible geometry (no floating boxes); walk through the archway/doorways (no bouncing off empty
  air), stand on floors, jump the divider (no tunnel), disguise + get hit.

## DEPLOY-ONLY SHIP: hull ALL model-bearing props `600ddcf` (2026-07-13, VRmike, branch build/92-deploy-only-no-code). NO code changed this session — a prior direct push failed on credentials, so this build re-runs delivery through the real pipeline. Gate re-run and GREEN in the deploy env: tree clean, HEAD == 600ddcf; full seven-check suite passed — check-true-colliders (89 baked hulls, 0 box fallbacks), check-physics-live, check-physics, check-physics-solidity, check-collider-visual (89 hull AABB == mesh, 0 under-coverage), check-disguise-eligibility, check-input-mode; headless desktop smoke clean (0 console errors, menu renders). The commit removes the round-primitive skip in `tools/build-hulls.mjs` so every model-bearing non-arch prop (incl. cylinder/ball/cone props: plates, pots, barrels) gets a convex hull from real mesh verts; `hulls.json` 49→89 entries; safety scan still "all pieces, no room shells" (0 exclusions). Push + Cloudflare Pages deploy + fresh pages.dev URL handled core-side after this branch fast-forwards to main. OWED: live feel-test — walking into tables/props should feel snug, not sticky (static checks can't judge feel). See `notes/convex-hull-colliders.md`.

## DEPLOY-ONLY SHIP: mobile input fix `59cbfac` (2026-07-13, VRmike, branch build/90-deploy-only-no-code). NO code changed this session — a prior direct push failed on credentials, so this build re-runs the delivery step through the real pipeline. Gate re-run and GREEN: tree clean (`git_diff HEAD` empty, HEAD == 59cbfac), `check-input-mode.mjs` 9/9 (incl. the stylus-phone regression case), headless smoke clean on desktop AND phone (0 console errors, lobby renders). The fix (`js/input.js`) classifies by PRIMARY pointer, not any-pointer: `(pointer: coarse)` ⇒ touch even with a secondary S-Pen/mouse; `(pointer: fine)`/hover ⇒ desktop. Fixes Samsung/stylus phones mis-wired as desktop (pointer-lock request impossible on mobile, dead touch controls under a stuck overlay). Push + Cloudflare Pages deploy + URL post are handled core-side after this branch fast-forwards to main. See INPUT-MODE FIX in `notes/touch-controls.md`.

## Latest: CONVEX-HULL COLLIDERS for props & fixtures (2026-07-13, VRmike, branch build/83-convex-hull-colliders-for). Collider-overhaul option 1. ALL headless guards GREEN incl. new hull assertions + page boots clean (0 console errors). Owes a live pass (True-collider eyeball + phone-host FPS). FULL DETAIL: `notes/convex-hull-colliders.md`.

Replaced hand-guessed BOX colliders on model-bearing, non-architecture props/fixtures with
**convex hulls baked from each model's REAL mesh vertices** at final world scale. 49 types
hulled; round items (barrels/balls/plates/pots/…) keep their primitive; floors/walls stay
cuboids. Now bullets + players collide with something that hugs the real furniture.

- **SAFETY SCAN FIRST (VRmike's entombment concern):** `tools/build-hulls.mjs` scans every
  candidate for room-scale bounds or a multi-object (disjoint-island) mesh — either would
  become one solid block that seals players in. **Verdict: "all pieces, no room shells" — 0
  exclusions** (every candidate is a single-island, sub-room-scale PIECE; the known multi-panel
  KIT GLBs aren't referenced by any catalog entry).
- **ONE decision point:** hulls are the new FIRST branch in `shared/physics.js shapeFor()`
  (hull → measured cuboid → primitive). World props, static fixtures, AND — coordinating with
  the disguise-collider build (`54fb2bf`, landed first) — a disguised player's MOVEMENT collider
  and SHOT sensor all inherit hulls through that one selector. Constraint 4 satisfied: the
  second-landing build (this one) gives disguised players hull colliders at their rescaled size.
- **BAKED, not load-time (deliberate deviation from plan step 3):** hull point clouds are baked
  offline into committed `shared/config/hulls.json` (like asset-dims.json), attached by
  `config.js` as `hullVerts`/`hullAabb`. Deterministic across peers, synchronous at match start,
  NO new runtime collider-swap machinery in the physics/netcode layer, NO async spawn-swap
  window. Re-run `node tools/build-hulls.mjs` after changing any GLB. Degenerate hull → falls
  through to primitive (guard).
- **Scale trap handled:** the bake scales verts by the SAME `native × map.modelScale (0.75)` and
  recenter the renderer uses; verified hull AABB == fresh GLB mesh bbox for all 49
  (`check-collider-visual.mjs` hull section).
- **Accepted "filled-in" cost:** hulls seal concavities — worst offenders `shelf`/`dishrack`
  (open racks solid), tables (can't hide under), `diner_chair` (seals under seat). Can't shoot
  through a shelf's gaps / hide under a table anymore. Option 2 (V-HACD decomposition) is the
  future fix if it hurts gameplay.
- **Verify:** `check-true-colliders.mjs` (all 49 build as convex-hull colliders, 0 fall back to
  a box; bases on floor; disguised-as-hull move+shot = hulls); `check-collider-visual.mjs` (hull
  AABB == mesh); `check-physics-live.mjs` §hull-disguise (hull movement body grounds/walks).
  Full harness GREEN: combat, physics, physics-solidity, physics-feel, blindfold,
  disguise-eligibility, flicker. Page boots clean normal + ?debug=1.
- **Files:** `tools/build-hulls.mjs` (new), `shared/config/hulls.json` (new/generated),
  `js/config.js`, `shared/physics.js` (shapeFor + halfExtentsFor hull-first branch),
  `tools/check-{collider-visual,true-colliders,physics-live}.mjs`,
  `memory/notes/convex-hull-colliders.md` (new) + physics.md/asset-dims.md/architecture.md, this
  file. NO change to netcode/protocol/referee/scene render.
- **OWED — live pass:** True-collider (magenta) overlay shows hulls hugging chairs/crates/
  appliances/tables; shoot a chair/table at its real silhouette (no more whiff on the loose box
  around legs); confirm the filled-in tradeoff is OK; disguise as a chair/crate and check
  fit+collision; watch phone-host FPS with ~49 hull colliders (lower `maxDynamicProps` if it
  hitches).

## Latest: LOBBY NAME CHANGES (2026-07-13, VRmike, branch build/78-lobby-name-changes-requested). All headless guards GREEN incl. a NEW `check-lobby-rename.mjs` + page boots clean (zero console errors). Simple additive feature — rides the existing host-authoritative roster rebroadcast. Owes only a live 2-player eyeball (headless can't reach the lobby — it needs PeerJS).

Let ANY player (host OR an invite-link guest) change their display name from the lobby at any
time; edits propagate live to all peers and carry into the game. Rode entirely on plumbing that
was already live — one new message type down the roster pipe.

- **Editable field for everyone (`js/ui.js`).** In `renderLobby`, your OWN row is now an
  editable `<input class="name-edit">` (tap to edit — phone-friendly), built by
  `_buildSelfNameField`; other rows stay read-only spans (you can only rename yourself). Commit
  on blur/Enter, cancel on Escape → `ui.onRename`. **Mid-edit re-render guard:** `renderLobby`
  clears `playerList.innerHTML` on every `S2C.LOBBY`; the new `_rerendering` flag turns the
  torn-down input's blur into a no-op, and `_editingName`/`_nameDraft` + focus/caret restore keep
  your typing intact when an unrelated lobby update (join/ready/map-pick) lands.
- **Relay + transport (`js/main.js`, `js/net.js`).** `ui.onRename` → `saveName` (localStorage,
  pre-fills next time) + `session.rename(name)`; new `Session.rename` updates the cached name and
  sends `C2S.RENAME{name}` over the host loopback or the guest DataConnection (net.js now imports
  `C2S`). Name also saved on create/join; menu field pre-filled from localStorage at boot.
- **Authority (`shared/referee.js`).** New `C2S.RENAME` case → `applyRename(player, name)`:
  LOBBY-only (mid-round ignored so scoreboards/"who tagged whom" stay stable), trim + cap
  `NAME_MAX` (16) + REJECT empty (keep old) + de-dupe via `_uniqueName` (smallest free integer
  suffix, case-insensitive: "Host"→"Host2"), then `broadcastLobby()` — the SAME rebroadcast a
  join fires, so late joiners/invite-link players update live for free. A player can only rename
  ITSELF (sender resolved by connection id; no target in the payload).
- **Carries into the game — automatically.** Snapshots + `STARTED` already send `p.name` live and
  the scoreboard/feed read it per-message; there are NO nameplates in `scene.js` caching a name, so
  the final lobby name shows in-game with zero scene change (verified by reading scene.js).
- **Protocol/CSS:** `shared/protocol.js` +`C2S.RENAME`; `css/style.css` +`.name-edit`/`.name-self`/
  `.you-tag` styling (host row keeps the ★).
- **Verify — NEW `tools/check-lobby-rename.mjs` (build-gating):** drives the real referee — a
  NON-HOST peer rename updates the roster AND the rebroadcast `S2C.LOBBY` carries the new name to
  every peer (the exact requested assertion); length cap; empty rejection; de-dupe incl.
  case-insensitive; host renames itself; mid-round ignored; unknown sender no-op. GREEN. Regression
  sweep GREEN: check-combat (referee), check-blindfold (scene/ui API), check-debug-menu (Esc/lock +
  `_isTyping` name-field guard still holds — the ` hotkey already no-ops while typing in the new
  field), check-input-mode. Page boots clean (zero console errors).
- **Files:** `shared/protocol.js`, `shared/referee.js`, `js/net.js`, `js/ui.js`, `js/main.js`,
  `css/style.css`, `tools/check-lobby-rename.mjs` (new), `memory/notes/lobby-rename.md` (new),
  `memory/architecture.md`, this file. NO change to physics/netcode/snapshot format/scene.
- **OWED — live 2-player pass:** in the lobby, a GUEST (invite-link) edits their name → the HOST's
  list and all peers update live; the host renames itself too; two players pick the same name → one
  auto-suffixes; start a round → the scoreboard/feed use the final names; back in the lobby you can
  rename again; a rename attempt mid-round does nothing.

## Latest: INPUT + JUMP FIXES (2026-07-13, VRmike, branch build/76-input-jump-fixes-requested). All headless guards GREEN + page boots clean (zero console errors). Two independent fixes; each root-caused before touching code.

**Part 1 — PC pause is ESCAPE-ONLY (ambient focus loss never pauses/blurs).** Before, ANY
pointer-lock loss (Alt-Tab, Windows key, clicking another window) opened the pause menu, whose
`backdrop-filter: blur(3px)` made the screen blurry/useless when the player just wanted to
switch windows. The wrinkle: Escape-while-captured is delivered by the browser as "pointer lock
lost" (`pointerlockchange`), the SAME event Alt-Tab fires — you can't listen for the Esc key. The
tell: Escape keeps window focus (`document.hasFocus()===true`); a focus change doesn't (and fires
`window 'blur'`). New `main.js unlockWasEscape()` = `document.hasFocus() && !(blur within 250ms)`;
`onLockChange`'s unlocked branch now returns silently (no pause, no overlay, no blur, keeps
rendering) on ambient loss and only pauses on a real Escape. Camera stops turning (mouse
uncaptured) until the player clicks back in to re-lock. Added `input._releaseHeldInput()` on
`window 'blur'` so a key held at focus-loss can't "stick down" and walk the avatar off. Touch/
phone untouched. Detail: `notes/pause-menu.md`.

**Part 2 — jerky first-person jump = vertical reconciliation snapping mid-arc (ROOT-CAUSED).**
Clue that cracked it: OTHER players' jumps were smooth, own view juddered, even for the HOST.
Built an instrumented host-case harness (`tools/_jumpdiag.mjs`) tracing displayed camera-Y vs
authoritative-Y through a jump. Found: the local predict world and the authoritative world compute
the fast arc slightly OUT OF PHASE (60fps predict vs 30fps referee tick + 1cm snapshot
quantisation), and the 15Hz reconcile snapped the local VERTICAL position onto that phase-shifted
value every snapshot — injecting a decaying `corr.y` up to **0.45 m** (a sawtooth on
`camera.position.y`). Remote players interpolate the smooth authoritative arc → never juddered;
the host has zero latency but its two worlds still step out of phase → juddered too. Fix
(`reconcilePredict`): while the local player is AIRBORNE (`!state.grounded`), SKIP reconciliation —
local prediction OWNS the deterministic jump arc (same shared gravity/jumpSpeed both sides). A real
large teleport (>2.5 m) while airborne still snaps; `pending` still trims by `ack`; GROUNDED play
unchanged. Harness confirms injected correction 0.449 m → **0.000 m**, against-arc jerks 3 → **0**.
Detail: `notes/netcode.md` (2026-07-13 section). NOTE: the plan's leading suspect (ground-snap
firing mid-jump) was NOT the cause — that's already disabled while `vy>0`; the harness pointed at
reconciliation instead, so the fix targets the real mechanism, not camera smoothing.

- **Files:** `js/main.js` (state.grounded + predictStep readback + reconcilePredict airborne-skip +
  onLockChange Escape/focus split + blur tracker), `js/input.js` (`_releaseHeldInput` on blur),
  `tools/_jumpdiag.mjs` (new diagnostic), `memory/notes/netcode.md`, `notes/pause-menu.md`,
  `architecture.md`, this file. NO change to `shared/` (physics/referee/protocol), scene render
  loop, or touch controls.
- **Guards GREEN:** check-blindfold (render-loop API), check-debug-menu (Esc/lock invariants still
  hold), check-input-mode, check-physics, check-physics-live (grounded stability), check-combat,
  check-flicker. Page boots clean (normal). Diagnostic harness reproduces baseline judder + proves
  the fix.
- **OWED — live pass:** (1) own jump as HOST, own jump as a JOINING player, and watching someone
  else jump — all smooth + identical. (2) Alt-Tab / Windows key / click-away → NO pause, NO blur,
  game keeps rendering, camera stops turning; click back in → resume. (3) Escape → pause still
  works. (4) phones unaffected.

## Latest: FLICKER FIX — hunter & disguise strobe/blink (2026-07-13, Jie via VRmike, branch build/75-flicker-fix-requested-by). All headless guards GREEN incl. a NEW `check-flicker.mjs` + page boots clean (zero console errors). Owes ONLY a live 2-player eyeball (headless can't render a moving skinned mesh).

Problem (Jie): the hunter and the prop a player is disguised as flash/strobe from certain camera angles. Root cause (VRmike's diagnosis, confirmed) = three.js FRUSTUM CULLING with stale bounds — it judges "off-screen" from a bounding sphere computed ONCE at load: (a) the hunter is a SKINNED animated mesh whose animation swings limbs outside the bind-pose sphere → culled/blinked mid-stride; (b) disguise GLBs are cloned + RESCALED at runtime so their bounds lag the new scale.

- **Fix (surgical — only the few player-attached objects; world props keep culling).** New module-level `preparePlayerModel(root)` in `js/scene.js`: traverse → `frustumCulled=false` on every mesh + recompute geometry bounding sphere/box (belt-and-braces for aim raycast + highlight box after a swap/rescale). `meshForPlayer` is now a thin wrapper `return preparePlayerModel(this._buildPlayerMesh(p, opts))` — the ONE choke point both remote (`syncPlayers`, animated) and self (`_syncSelf`) use, so the skinned hunter, GLB disguise, primitive disguise, and capsule are ALL covered, no branch bypassing. Defence-in-depth flag kept at `_buildHunterModel` (rig) + `_buildViewModel` (first-person held rifle). Old `meshForPlayer` body moved verbatim into `_buildPlayerMesh` — zero behaviour change beyond the flag.
- **Secondary suspects checked, NOT the cause:** (1) visibility flap — `entry.mesh.visible=p.alive` is safe because the referee sets `alive` true at spawn, false only on death (monotonic), always present in the snapshot; (2) z-fighting disguise-vs-world-prop — you disguise as a TYPE at YOUR position, nothing duplicates a world prop in place. Documented in `notes/flicker-culling.md`.
- **Verify:** NEW `tools/check-flicker.mjs` (18 static guards, same family as `check-blindfold.mjs`): preparePlayerModel exists/exported + does both jobs; `meshForPlayer` routes through it with exactly one wrapped return via `_buildPlayerMesh`; both consumers use it; hunter rig + viewmodel keep the flag; `instantiateModel` does NOT (world props keep culling); `alive`→visible wiring intact. Full suite GREEN (blindfold, hunter-model, hunter-model-size, combat, disguise-eligibility, debug-menu, input-mode, physics, collider-visual, true-colliders) + clean headless boot.
- **Files:** `js/scene.js` (preparePlayerModel + meshForPlayer split), `tools/check-flicker.mjs` (new), `memory/notes/flicker-culling.md` (new), `memory/architecture.md`, this file. NO change to `shared/`, netcode, referee, physics, or collider geometry (additive render flag only — low risk).
- **OWED — live pass:** walk the hunter across the screen edge and disguise as a few different-sized props; confirm the strobing is gone.

## Latest: TRUE RAPIER COLLIDER VISUALIZER (diagnostic) + LOCAL-PLAYER COLLIDER FIX (2026-07-13, VRmike, branch build/73-debug-real-collider-visualization). All headless guards GREEN incl. a NEW live-Rapier check + page boots clean. Owes a live pass (see below). Foundation for diagnosing the counter/standing bug — this build ONLY makes colliders visible, it does NOT touch collider geometry/sizes or the counter behaviour.

Problem (VRmike): can't stand on some counters as a tiny prop even though the box-collider debug display shows nothing in the way → the ACTUAL Rapier colliders (mesh/convex/compound) likely differ from the AABB box helpers. So: make the REAL physics shapes visible, and fix the local player's own collider never showing. TWO parts:

1. **NEW "True Colliders" debug toggle** (`js/debug.js` `_toggleTrueColliders` → `js/scene.js setTrueColliderView`/`updateTrueColliders`). SEPARATE from the existing box/capsule "Colliders" toggle so both can be on at once for side-by-side comparison. It reads collider shapes STRAIGHT from the live Rapier world (`world.forEachCollider`) each frame and draws each in its REAL form — cuboid / ball / capsule / cylinder / cone / convex hull / trimesh (a "compound" is just several colliders on one body → several wires) — in a distinct **MAGENTA** so any disagreement with the old box overlay is obvious. Geometry is built once per collider handle (a trimesh read is expensive); only the transform is tracked each frame; shape-change (disguise resize) rebuilds; vanished handles are pruned. Source world (`debug._trueWorld()`): HOST → the authoritative world `session.referee.physics` (holds EVERY player capsule, local + remote, + all props/shot-sensors); GUEST → the LOCAL prediction world `state.predict` (static + props + our OWN capsule — remote players aren't simulated in-browser on a guest, an inherent limit). Torn down on toggle-off AND on return-to-menu/lobby (`debug.resetView`).

2. **EXISTING collider display now renders the LOCAL player too** (the bug VRmike hit: it only drew OTHER players' capsules). Root cause: `_buildColliderView`/`syncPlayers` iterate `scene.players` (remote only); the local player uses `scene.selfMesh` (not in that map) and was never wired. Fix: new `scene._addSelfColliderWires()` attaches the SAME green movement-capsule + orange shot-sensor wires to `selfMesh`, called from both `_syncSelf` (live) and `_buildColliderView` (toggle-on rebuild). Only shows when a self body exists (`_wantSelfMesh()` = third-person OR free cam) — a first-person hunter still has no self mesh, but VRmike-as-a-prop is third-person so his own capsule now shows. (The new true-collider renderer also covers the local capsule regardless of mesh.)

- **Verify:** `tools/check-debug-menu.mjs` §7 (NEW) asserts (a) the True Colliders toggle exists + is separate; (b) local AND remote wired into the EXISTING display; (c) local AND remote wired into the NEW renderer — both paths, so a builder can't satisfy the new one while leaving the own-capsule bug. NEW `tools/check-true-colliders.mjs` stands up the REAL `PhysicsWorld` and proves the shape dispatch: a live world's 12 colliders all classify (7 cuboid / 1 cylinder / 1 cone / 1 ball / 2 capsule, zero "unsupported"), transforms readable, + directly-constructed TriMesh(type 6)/ConvexPolyhedron(type 9) classify as mesh wires. `check-blindfold.mjs` auto-picks up the two new `scene.*` seams (defined). Full suite GREEN; page boots clean under `?debug=1`.
- **Files:** `js/scene.js` (true-collider overlay + self-wire fix), `js/debug.js` (toggle + `_trueWorld` + frame update + teardown), `tools/check-debug-menu.mjs` (§7), `tools/check-true-colliders.mjs` (new), `memory/notes/collider-debug.md`, `notes/debug-menu.md`, this file. NO change to `shared/` (physics/referee/bounds), collider geometry, sizes, or counter behaviour.
- **OWED — live pass:** open the debug menu, enable "True Colliders" — the counter's REAL shape shows in magenta; stand as a tiny prop where you can't → SEE whether the true collider extends past the box helper (the likely counter bug, to be FIXED in a follow-up build). Confirm your OWN capsule (green) shows in the existing "Colliders" view as a third-person prop. On a guest the true view shows static+props+own capsule; on the host it also shows remote capsules.

## Latest: INPUT-MODE FIX + RIFLE 180 FLIP + SHOT IMPULSE + DEBUG PANEL LAYOUT (2026-07-12, VRmike, branch build/71-input-mode-fix-touchscreen). All headless guards GREEN (incl. two NEW checks) + page boots clean (zero console errors). Owes a live pass: touchscreen-PC controls, remote rifle facing, prop kick feel, in-match HUD/debug layout.

Four-part fix. Full detail: `notes/touch-controls.md` (classification), `notes/hunter-character-model.md` (rifle), `notes/physics.md` (impulse), `notes/debug-menu.md` (layout).

1. **INPUT-MODE DETECTION (root cause of VRmike's "no mouse lock / no Esc / no left-click fire" on a touchscreen PC).** `js/input.js` classified by "can this be touched?" (`'ontouchstart' in window || maxTouchPoints > 0`) → a Windows PC with a touchscreen got the PHONE scheme (no pointer lock / Esc pause / hold-fire). NEW pure+injectable **`prefersTouchControls(env?)`** decides by POINTER CAPABILITY: `matchMedia('(any-pointer: fine)')` OR `'(hover: hover)'` ⇒ DESKTOP wiring even when touch is also present; only coarse-only/no-fine-pointer ⇒ TOUCH. Old touch signals are the fallback for matchMedia-less browsers. `this.touch = prefersTouchControls()` re-routes EVERY downstream branch at once (Esc handler, backtick guard, click/tap overlay text, editor gate, and `ui.js _controlsHtml` now imports the SAME function instead of re-deriving). **Hybrid support: shipped desktop-classification ALONE** (the plan's OK'd fallback — dual-wiring the on-screen pads on a fine-pointer device would race the mouse over `primaryHeld` + the canvas look-zone). Unit-tested: NEW `tools/check-input-mode.mjs` (8 cases: touchscreen-PC⇒desktop, phone⇒touch, plain-desktop⇒desktop, hybrid⇒desktop, tablet⇒touch, both fallbacks, matchMedia-throws⇒desktop). GREEN.
2. **RIFLE FACING BACKWARDS (remote/3rd-person).** The prior "solve" ASSUMED the GLB barrel was the -X end and pointed that forward; VRmike's live view proved the muzzle is the +X end, so the gun fired behind the hunter. Re-ran `tools/_solve_rifle.mjs` and switched `character-models.json` `weapon.rotationDeg` {178.8,-10.1,87.6} → **{-1.2,10.1,92.4}** — the tool's `[muzzle+X, up+Y]` variant, verified numerically against the ACTUAL Wrist.R pose (barrel=(0,0,-1) forward, up=(0,1,0) across Idle_Gun_Pointing/Run_Shoot/Gun_Shoot/Idle_Gun_Shoot). This is exactly the requested 180° turn (barrel reversed, gun still upright). Headless RENDER isn't possible in the sandbox → eyeball live; hot-tunable. `check-hunter-model` GREEN.
3. **SHOT IMPULSE.** A shot on a DYNAMIC prop now gives it a small host-authoritative kick. NEW `physics.applyShotImpulse(propId, point, dir, speed)` — host-only (`dynamicProps` gate + no-op on guests / capped-static / bad input), WAKES a sleeping body, applies `applyImpulseAtPoint` at the hit point along the shot dir. `speed` (`rules.shotImpulse` = **1.5** m/s, config-tunable) is scaled by the body MASS so the visible nudge is consistent across a heavy table and a light burger (not a mass-based launch of the tiny props — "a nudge, not a rocket launcher"). Called from `referee.applyShot` after damage (cosmetic only; damage untouched); rides the normal prop stream to everyone (no new netcode). Verified: `tools/check-physics-live.mjs` §6 — a settled/asleep crate goes 0→1.5 m/s along the shot dir + wakes; guest/bad-input no-op.
4. **DEBUG PANEL LAYOUT.** The DEBUG button (`#dbgToggle`) covered the top-left role pill and the OPEN panel covered the health bar. Now: the button is a PILL at the top row (top/left 12px matching `.hud-top`), and `body.dbg-present .hud-top{padding-left:104px}` reserves room so the role/timer/props/health pills flow to its RIGHT (no overlap). The OPEN panel starts BELOW the HUD rows — new `_positionPanel()` measures `.hud-top`'s live bottom (handles the wrap to 2 rows) and drops the panel there (default top:96px), so no HUD readout is covered. z-index 52/51 unchanged (still above the pause menu). `check-debug-menu` GREEN (z-order regex intact).

Regression sweep GREEN: check-input-mode (new), check-physics-live (incl. new §6 + all pass-#5 invariants), check-combat (§F fire-rate cap 700rpm, §G disguise-shaped shot sensor), check-blindfold (scene-API), check-physics, check-hunter-model, check-debug-menu (backtick UI mode + pause + z-order). Do-not-regress list confirmed intact: backtick UI-mode hotkey (9111997), pause menu, rapid-fire rate cap, disguise-shaped hitboxes (d10b075).

## Latest: HITBOX ACCURACY FIX — disguise-shaped shot sensor + collider/visual audit (2026-07-13, Jie, branch build/69-hitbox-accuracy-fix-requested). ALL headless guards GREEN incl. a NEW live-Rapier combat section; page boots clean. Owes a live playtest (disguise as a table, shoot the corners; check ?debug=1 orange wires).

Problem (Jie): shots tested against physics primitives that didn't match the visible models — worst for
disguised players, who registered hits ONLY on their movement capsule (a person-shaped capsule squeezed
into the disguise footprint), so shots at a table disguise's visible corners whiffed and shots ABOVE a
low disguise (where the tall capsule pokes over) hit empty air. FOUR parts, all shipped:

1. **Disguise-shaped SHOT SENSOR** (`shared/physics.js`). Every player now carries a second collider on
   the SAME kinematic body: a `setSensor(true)` shot-only shape built from the SAME `shapeFor()` the real
   prop uses (cuboid/cylinder/ball/cone from catalog dims), based at the foot like the drawn disguise;
   capsule-matching when undisguised. `setShotCollider(id,type)` / `setShotColliderYaw(id,yaw)` build/keep
   it in sync; the HOST referee calls them on disguise/undisguise/morph/join and every tick (yaw←dispYaw).
   The MOVEMENT capsule (`setPlayerCollider`) is UNTOUCHED — the sensor never collides/pushes/depenetrates
   (excluded from every EXCLUDE_SENSORS movement/projectPoint query). `raycastShot` now EXCLUDES all
   movement capsules (predicate) so a player is hit ONLY through the sensor — no phantom hit above a short
   disguise, no capsule+sensor double-hit (castRay returns one nearest anyway). `describeCollider` maps the
   sensor → `{kind:'player',id}` (capsule kept as a fallback if a sensor fails to build). Host stays authoritative.
2. **Collider↔visual audit** (`tools/check-collider-visual.mjs`, NEW). Parses every referenced GLB's true
   native bbox directly from the GLB binary (same approach as measure-glbs/check-hunter-model-size, no
   Three, no deps), computes the RENDERED size via `bounds.meshSize` (native × map.modelScale 0.75, or
   modelDims), and fails any entry whose collider UNDER-covers the visual (>5 cm AND >8%). Found 31
   offenders → fixed in props.json/fixtures.json (see note). Round colliders' horizontal is inscribed by
   design (reported); their height is asserted.
3. **Debug visibility** (`js/scene.js`). The ?debug=1 / debug-menu collider overlay now ALSO draws each
   player's SHOT hitbox — the disguise-shaped sensor — as an ORANGE wire (`_addPlayerShotWire`), distinct
   from the GREEN movement-capsule wire, parented to the (yawed) player mesh. Mismatches are now visible.
4. **Verify** (`tools/check-combat.mjs` section G, NEW — live Rapier). Fires rays at a table disguise's
   corner/edge (hit=player), just outside + above the low silhouette (miss), a rotated-45° corner (hit —
   yaw tracking), and post-undisguise (sensor tracks the current shape). Damage-vs-current-disguise stays
   proven in section E. Rapier added to devDependencies (pinned 0.14.0) so the live sections run in CI/sandbox.

Regression sweep GREEN: check-physics, check-physics-solidity, check-physics-live (depenetration failsafe +
disguise-capsule sizing byte-identical — only shots changed, not how bodies move), check-combat, check-debug-menu,
check-disguise-eligibility, check-blindfold. Finding: `asset-dims.json` is STALE vs the current GLBs (e.g.
fridge depth 1.51→ actually 2.24 native), so the old fridge collider under-covered the real model by 0.55 m —
the fresh-parse audit caught what the stale-data check-physics missed. asset-dims.json left as-is (not
consumed at runtime; regenerating would clobber its curated notes) — see notes/asset-dims.md follow-up.

## Latest: DEBUG MENU ACCESS ON PC MID-GAME — desktop "UI mode" on backtick (2026-07-12, Jie, branch build/67-debug-menu-access-on). All headless guards GREEN + page boots clean (zero console errors). Owes a live desktop pass (pointer-lock behaviour can't be seen headless).

Problem (Jie): on desktop the pointer lock trapped the mouse so the top-left DEBUG button couldn't
be clicked; Esc opened the pause menu which COVERED the debug button; and the "Click to play"
overlay popped up on every unlock, intercepting clicks. Fix = a deliberate THIRD input state.

- **NEW desktop "UI mode" on the backtick (`) key** (`state.uiMode` in `js/main.js`;
  `input.onToggleUiMode`). Pressing ` mid-game RELEASES pointer lock WITHOUT opening the pause menu:
  the mouse is free, the "Click to play" overlay is SUPPRESSED, and the DEBUG button + open panel are
  fully clickable. ` again (or clicking the game canvas) re-locks and resumes.
- **"Click to play" is now STATE-DRIVEN, not event-driven** — `onLockChange` shows it only when the
  pointer is unlocked AND `!uiMode` AND `!paused`. Kills the race Jie flagged (overlay decided by
  whoever's event fired last). `onLockError` suppresses it in UI mode too.
- **Flag lifecycle is derive/reset, never latch** (same discipline as the blindfold): `uiMode` is
  cleared on EVERY resume/pause/exit path — the instant the pointer re-locks (`onLockChange` locked
  branch), `openPause()` (Esc→pause from UI mode hands over to the menu), `exitUiMode`, back-to-menu,
  return-to-lobby, and match START. So the overlay rule can never see a stale on-flag.
- **Resume click can't shoot** — the canvas `mousedown` fire/hold path is gated on `this.locked`
  (already was), which is false until the lock engages, so the click that re-locks never registers a
  shot or arms hold-to-fire. `primaryHeld` also clears on any lock loss.
- **Hotkey is text-input-guarded** — `input._isTyping()` (focus in INPUT/TEXTAREA) makes ` a no-op
  while naming a room, so a backtick in a name is just a character. Also Esc-while-unlocked opens
  pause (so UI mode can still reach the pause menu); Esc-while-locked defers to the browser's native
  pointer-lock release (unchanged path). Both desktop-only.
- **Z-ORDER fix** — the injected `#dbgToggle` (52) / `#dbgPanel` (51) now sit ABOVE the pause menu
  overlay (`.pause-menu` z-index 50, `js/debug.js` styles), so debug is reachable from BOTH paths:
  backtick UI mode OR Esc→pause (button/panel visible over the pause backdrop).
- **Movement halts in UI mode** like pause (input loop sends zeroed movement, prediction skipped) so
  the avatar holds still while you fiddle with debug; `tryFire` also guards `uiMode`.
- **Docs:** pause-menu Controls list gains a `` ` `` row ("Free the mouse for debug/UI — click the
  view to resume"), `js/ui.js _controlsHtml`.
- **Guards:** `tools/check-debug-menu.mjs` +section 6 statically asserts all the above (hotkey +
  typing guard, state-driven overlay, no-race flag set-before-unlock, resume-click-not-firing, every
  reset clears the flag, z-order above pause, docs row). Also fixed 2 STALE assertions in
  `check-blindfold.mjs` that predated this work (the prop-aim `setAimMode` pass changed the aim ray to
  `this._aimNDC || SCREEN_CENTER`; the literal-`SCREEN_CENTER` regex hadn't been updated — now accepts
  the unified form). Full suite green: check-debug-menu, check-blindfold, check-combat, check-physics.
- **Files:** `js/input.js`, `js/main.js`, `js/debug.js`, `js/ui.js`, `tools/check-debug-menu.mjs`,
  `tools/check-blindfold.mjs`, notes. Zero gameplay/netcode/referee change; touch untouched.
- **OWED — live desktop pass:** mid-game ` → mouse free, no "Click to play", DEBUG button + panel
  clickable (and clickable over the pause menu too); click the canvas → back in the action with no
  phantom shot; Esc pause still behaves; ` → Esc → Resume leaves no stuck state; a `` ` `` typed in
  the name field stays a character.

## RESUME NOTE (2026-07-12, resume of the crashed pose/anim/damage/debug/fire/pause run): the crashed attempt had already COMMITTED its full work as `9cb60ad` (the harness commits partial trees); the HTTPException struck AFTER the commit, during the final deploy/link-posting step — NOT mid-edit. Working tree verified CLEAN at HEAD (`git diff HEAD` empty — no partial/uncommitted leftovers). Re-ran the WHOLE guard suite on resume, ALL GREEN: `check-combat` (incl. §E re-disguise small→large multiplier + §F fire-rate 700 rpm/66 ms), `check-debug-menu` (collapsed default + collider toggle), `check-hunter-model` (idle = `Idle_Gun_Pointing` gun-up clip), `check-blindfold` (scene-API guard), `check-physics`, `check-hunter-model-size`. Page boots with ZERO console errors in normal + `?debug=1` + phone-portrait; DEBUG menu confirmed COLLAPSED-by-default by screenshot (only the `DEBUG ▸` button top-left). No code changes needed — the seven-part pass below is complete and coherent. Still owes the live 2-player pass noted at the end of that section.

## Latest: HUNTER RIFLE POSE/ANIM POLISH + DAMAGE-MULT PROOF + DEBUG UPGRADES + RAPID-FIRE/MOUSE-LOCK/PAUSE MENU (2026-07-12, VRmike, on `main`). All headless checks GREEN + page boots clean (normal + ?debug=1 + phone). Rifle pose, hold-to-fire feel, mouse-lock/pause flow owe a live 2-player pass.

Seven-part pass. Full detail: `notes/hunter-character-model.md` (rifle pose/anim), `notes/hunter-tools-combat.md`
(damage proof + rapid fire), `notes/debug-menu.md` (collapsed + collider toggle), `notes/pause-menu.md` (new).

1. **RIFLE POINTS DOWN — ROOT-CAUSED at the rig pose (not a number guess).** The wrist-bone
   orientation DIFFERS per clip: in the shoot/aim clips (`Idle_Gun_Pointing`/`Gun_Shoot`/
   `Idle_Gun_Shoot`/`Run_Shoot`) a rifle attached at rotation=0 points nearly straight DOWN, and
   the old `Idle_Gun` idle pointed it BACKWARD — so no single grip rotation fixed both. Loaded the
   real rig headlessly (three+GLTFLoader, `tools/_solve_rifle.mjs`), posed each clip, read the
   Wrist.R world quaternion, and SOLVED the bone-local rotation that maps the muzzle (the rifle's
   -X end — thin barrel, fewer verts, `tools/_muzzle.mjs`) to the character's forward and gun-up to
   world-up. `weapon.rotationDeg = {178.8, -10.1, 87.6}` lands the barrel within ~1° of level-
   forward, upright, across EVERY shoot/aim clip. Hot-tunable; confirmed live post-deploy.
2. **IDLE keeps the gun up — use the real aim-idle.** idle clip `Idle_Gun` → **`Idle_Gun_Pointing`**
   (a static aim-idle that holds the rifle raised + forward AND shares the shoot clips' wrist
   orientation, so one rotation fixes idle + movement). Movement stays `Run_Shoot`. The code still
   can NEVER select an arms-at-side idle while tool=rifle (every configured clip is a Gun/Shoot
   clip; `check-hunter-model.mjs` asserts it by parsing the GLB).
3. **DAMAGE MULTIPLIER — the referee was ALREADY correct; proven, not blindly re-patched.** A probe
   + git history showed `_applyShotDamage` has ALWAYS derived the size multiplier FRESH from
   `target.disguise` at damage time (no cache anywhere; the client also allows + sends a re-disguise).
   Made the guarantee explicit via `referee._playerHitDamage(target)` and LOCKED it with
   `check-combat.mjs` section E (disguise small → re-disguise large → assert per-hit damage now
   matches the LARGE prop). If the bug still reproduces live, the deployed build predates this / the
   root cause is elsewhere — flagged honestly (see summary).
4. **DEBUG MENU: (a) live "Colliders" toggle** driving new `scene.setColliderView(on)` — build/
   teardown ALL collider wireframes (props, players CAPSULES [new geometry], static fixtures, world
   architecture) via the SAME `shared/bounds.js` source + wire builders the `?debug=1` overlay uses.
   **(b) starts COLLAPSED** — only the `DEBUG ▸` button top-left; panel opens on click.
5. **RAPID FIRE.** Rifle is HOLD-to-fire at `rules.fireRateRpm` (700, config-tunable, 600-800 band).
   Host derives its authoritative rate cap from it (`referee._fireCooldownMs` = 60000/rpm − grace);
   the client paces held-fire off the same number. Damage/bullet unchanged (5%). `input.primaryHeld`
   tracks the held left-click / touch ACTION; `main.js` auto-repeats for a live hunter.
6. **MOUSE LOCK + HOLD-LEFT-CLICK.** Pointer lock already captures on the in-game canvas click for
   BOTH roles (unchanged). Left-click is now HELD to rapid-fire (props still single-tap disguise).
7. **PAUSE MENU (overlay, does NOT pause the sim).** Escape releases pointer lock → opens a menu
   with a live scoreboard (everyone + health), a Controls/help panel, Resume (re-locks), and Exit.
   Touch: a ☰ button opens the same menu (no pointer lock there). While open the avatar holds still
   (zeroed input) but the world keeps running on the host. `notes/pause-menu.md`.
- **Guards:** `check-combat.mjs` +E (re-disguise multiplier) +F (fire-rate config/cap);
  `check-debug-menu.mjs` +collapsed-default +collider-toggle +`setColliderView`/player-capsule;
  `check-hunter-model.mjs` (idle clip is a gun clip) still GREEN; `check-blindfold.mjs` picks up the
  new `scene.setColliderView` seam; `check-physics`/`check-hunter-model-size` still GREEN. Page boots
  clean normal + ?debug=1 + phone (debug menu confirmed collapsed by screenshot).
- **OWED — live 2-player pass:** remote hunter holds the rifle UP + pointing forward while running
  AND standing idle (no barrel-down, no arms-at-side); hold-left-click rapid-fires at a realistic
  rate; Escape opens the pause menu + releases the mouse, Resume re-locks; scoreboard shows everyone's
  health; the debug "Colliders" toggle draws every collider incl. player capsules and tears down clean.
  Nudge `weapon.rotationDeg` if the grip roll/facing reads off (hot-tunable, no rebuild).

## RESUME NOTE (2026-07-12, resume of the crashed rifle/tuning run): the crashed attempt had already COMMITTED its full work as `959fc2c` (the harness commits partial trees); the Exception struck AFTER the commit, during the final deploy/link-posting step — NOT mid-edit. Working tree verified CLEAN at HEAD (no partial/uncommitted leftovers to discard). Re-ran the whole guard suite on resume: `check-hunter-model`, `check-combat`, `check-debug-menu`, `check-blindfold`, `check-physics`, `check-hunter-model-size` all GREEN; page boots clean with zero console errors in normal + `?debug=1` + phone-portrait; debug menu confirmed visible by default (screenshot). No code changes were needed — the six-part pass below is complete and coherent. Still owes the live 2-player pass noted at the end of that section.

## Latest: REMOTE RIFLE ANIMATION FIX + INPUT/DAMAGE/HUD TUNING (2026-07-12, VRmike, on `main`). All headless checks GREEN + page boots clean (normal + ?debug=1); remote-animation look + HUD-in-match + live damage feel owe a 2-player pass.

Six-part tuning pass on the HUNTER-TOOLS build. Full detail: `notes/hunter-character-model.md`
(clip change), `notes/hunter-tools-combat.md` (damage), `notes/debug-menu.md` (default-on).

1. **Remote rifle animations — ROOT-CAUSED at the asset.** Parsed the SWAT GLB (its clip names
   live as plain text in the glTF JSON chunk — no 3D math): 24 clips, and only **two** hold the
   rifle up — `Idle_Gun` and `Run_Shoot` (a real rifle-run). The old config pointed
   backward/left/right at `Run_Back`/`Run_Left`/`Run_Right`, which are the pack's PLAIN
   arms-down directional runs — THAT was the "arms-at-sides while holding the rifle" VRmike saw
   whenever a hunter strafed/backpedalled (the mixer/velocity/wiring were all fine). There is no
   gun-up strafe/backpedal clip in the asset, so **all movement now maps to `Run_Shoot`** and
   idle stays `Idle_Gun` — the rifle stays raised in every direction (`character-models.json`,
   hot-tunable). Trade-off: legs use the forward-run cycle while strafing (documented). Tool
   state is NOT networked (finder is a no-op; the rifle is always shown to remotes), so
   "animation follows the rifle" = a remote hunter always animates gun-up — which is now true.
2. **PC left-click fire — already correct, verified.** `input.js` already fires on `mousedown`
   button 0 gated on pointer lock (→ `onAction('primary')` → `tryFire`), so a locked in-game
   left-click shoots and menu/UI clicks never do. No change (avoided a regression).
3. **Debug MENU on by default.** `main.js` now constructs `DebugMenu` unconditionally (lazy
   import). `?debug=1` is UNCHANGED and still governs the separable heavy features: the collider
   wireframe overlay (read directly in `scene.js`), per-peer ping, and the referee's
   host-authoritative debug-command gate. So the two links differ: normal = menu; `?debug=1` =
   menu + wireframes + host debug commands.
4. **Damage tuning (config + one referee line).** base **10 → 5** (5%/hit; undisguised = 20
   hits). **Wrong-guess penalty is now a FLAT `base` (5%), NEVER size-scaled** — new
   `damage.wrongGuessPenalty()`; referee's two decoy branches call it instead of the size curve;
   `selfScalesWithSize` retired to false + unread (20 wrong guesses = dead). Prop-PLAYERS keep
   the size curve, rescaled `smallMult` **5 → 10** so a burger still dies in ~2 hits at base 5;
   `largeMult` 0.34 kept → a table soaks ~59 hits ≈ ~3× the 20-hit default. Smooth lerp intact.
5. **HUD health BAR.** The numeric `#hudHealth` pill became a filled BAR (green→amber→red) that
   grows to fill the top row's spare width (≥220px, >2× the old readout) with the number centred
   inside; `.hud-top` spans the width and `flex-wrap`s so mobile portrait drops the bar to its
   own full-width second row — two fixed layouts, no runtime measurement.
6. **Guards extended.** `check-hunter-model.mjs` now PARSES the GLB (glbClipNames) and asserts
   every configured clip resolves in the asset AND is a rifle/aim clip (gun stays up).
   `check-combat.mjs` asserts the flat, size-independent wrong-guess penalty (burger decoy ==
   table decoy == base) + burger ~2 hits + table ~3×. `check-debug-menu.mjs` updated for
   default-on. All green; `check-blindfold.mjs` + `check-physics.mjs` still green.
- **OWED — live 2-player pass:** remote hunter holds the rifle UP running in every direction (no
  arms-at-sides); left-click fires on PC; debug menu visible without ?debug=1 (and wireframes
  with it); burger dies in ~2 hits / table tanky / 20 wrong guesses kill a hunter flat; health
  BAR fills the HUD row on PC and wraps to its own row on mobile portrait, number centred.

## Latest: HUNTER TOOLS v1 + HEALTH/DAMAGE + all-hunters-dead win (2026-07-12, VRmike). Crash-retry; started from a CLEAN tree at 8e28bc3 (the crashed run committed nothing). All headless checks GREEN; the tool bar / rifle visuals / actual raycast hits owe a live 2-player pass.

Adds the hunter tool framework (built for 4+ tools; 2 ship), a host-authoritative assault
rifle with tracers, a no-op prop finder, a health/damage system, and a new win condition.
Full detail: `memory/notes/hunter-tools-combat.md` + `DECISIONS.md` #1.

- **Tool framework (client-only, NOT networked in v1).** `HUNTER_TOOLS` in `js/main.js`;
  always-on `#toolbar` for a live hunter (tap on phone, click or number keys 1/2 on PC,
  current highlighted). A first-person weapon **VIEWMODEL** (`scene.setViewModel`) makes
  switching visible to the shooter (first-person hunters draw no body): rifle GLB (primitive
  barrel fallback, upgrades on load) vs a ~0.3 m box for the finder. The camera is added to
  the scene graph so its child viewmodel renders. Only the FIRE event is broadcast — which
  tool a hunter holds is deliberately not synced (finder is a no-op → netcode for no payoff).
- **Assault rifle (host-authoritative).** `C2S.SHOOT {dx,dy,dz}` = the camera-forward from
  `scene.aimDirection()` — the SAME screen-centre ray as the disguise pick (reused).
  `referee.applyShot` re-casts from the shooter's authoritative eye in its own Rapier world
  (`physics.raycastShot`→`castRay`, own capsule excluded); `physics.describeCollider` maps the
  hit collider to player / prop / static-fixture-by-type / world via handle maps built at
  construction. Broadcasts `EVENT kind:'shot'` → `scene.spawnTracer` (muzzle flash + tracer
  rifle-tip→impact) for EVERYONE, faded by `scene.updateEffects`. No physics → no-damage tracer.
- **Prop finder.** Tool 2: hides the rifle viewmodel, shows a ~1 ft box, does nothing —
  proves tool/weapon switching end to end (later: directional taunt audio).
- **Health/damage (all host-side).** Start 100 % (`rules.startHealth`), on the HUD
  (`#hudHealth`) + every snapshot player entry. `shared/damage.js` (PURE, shared by referee +
  guard) lerps a SIZE multiplier from `rules.damage` anchors over `entrySize` = the SAME
  footprint physics bakes colliders from (`halfExtentsFor`, auto-upgrades to measured bounds):
  base 10; burger (0.72 m) ×5 → ~2 hits; table (2.25 m) ×0.34 → ~30 hits (≈3× the default
  player's 10); undisguised → ×1. Rules: player hit → base×disguise-size; a disguisable decoy
  (prop or non-arch fixture) → the HUNTER takes it instead; architecture/world → free miss;
  a prop KILL refills the hunter to full.
- **Death + new win condition (DECISIONS.md #1).** Hunters do NOT respawn; a dead player
  spectates (`#spectate`, first-person look-around). `checkRoundOver` now also ends the round
  PROPS-WIN when a round's hunters are ALL dead (alongside all-props-caught → hunters win and
  timer-expiry → props win).
- **Verification.** NEW `tools/check-combat.mjs` (build-gating) drives the real referee
  paths: size→mult lerp, player-damage scaling, kill-refill, wrong-prop self-damage vs
  architecture free-miss, and BOTH win conditions. `check-blindfold.mjs` covers the new
  `scene.*` methods; `check-physics.mjs` still green (handle maps are additive); page boots
  with zero console errors. **All GREEN.**
- **Files:** `shared/config/rules.json` (+startHealth/shootRange/fireCooldownMs/damage),
  `shared/damage.js` (new), `shared/protocol.js` (+C2S.SHOOT, health/event docs),
  `shared/physics.js` (raycastShot/describeCollider + handle maps), `shared/referee.js`
  (health + shot + damage + win), `js/scene.js`, `js/main.js`, `js/ui.js`, `js/input.js`,
  `index.html`, `css/style.css`, `DECISIONS.md` (new), `tools/check-combat.mjs` (new),
  `memory/notes/hunter-tools-combat.md` (new), architecture.
- **OWED — live 2-player pass:** tool bar select (PC+phone) + highlight; viewmodel switch;
  muzzle flash + tracer seen by BOTH; size-scaled prop damage; decoy self-damage; wall
  free-miss; kill-refill; hunter death → spectator; last hunter down → PROPS WIN. Tune
  `rules.damage` + muzzle offset if off (hot-tunable).

## Latest: HUNTER MODEL SIZING FIX (bone-derived, verified) + DISGUISE-ANYTHING (2026-07-11, VRmike, on `main`). The third try at the hunter model — this one has a build-gating check that asserts the OUTPUT, not just that the code exists. Headless checks GREEN; the render/facing + a pillar disguise still owe a live 2-player pass.

- **PART A — hunter model TINY/ORBITING, root-caused + fixed for real.** The GLB stores its
  skinned mesh ~3.6 mm tall and inflates it via a baked **[100,100,100] BONE scale**;
  `Box3.setFromObject` reads that 4 mm phantom (ignores the skeleton), so the old
  `targetH/size.y` + bbox-centring derived a ~450× scale and an off-origin pivot → ~100×-too-
  small model on a lever arm that orbited as the player yawed. **Fix:** measure the SKELETON.
  New pure `shared/hunter-sizing.js` (`sizeHunterRig`/`measureRigBones`/`findBone`, `THREE`
  injected) traverses the bones for true height/feet/centre, scales the WRAPPER GROUP, rests
  feet at y=0, x/z centroid on-axis, keeps `yawOffsetDeg 180`. `js/scene.js _buildHunterModel`
  now delegates to it. Degenerate rig → armature-scale fallback, never the geometry bbox.
  - **2nd bug caught:** GLTFLoader sanitizes `Wrist.R` → `WristR`, so the rifle never attached
    (masked by the sizing bug). `findBone` matches tolerantly. Weapon now sized by
    `weapon.worldLength` (0.8 m) normalised against the wrist bone's world scale — robust to
    the rig-scale change. All hot-tunable.
  - **VERIFICATION THAT BITES:** `tools/check-hunter-model-size.mjs` loads the REAL GLB with
    three+GLTFLoader (dev-only `three@0.161.0`, `npm install`; game still CDN) and asserts the
    OUTPUT of the shipped `sizeHunterRig` — height ±10% of 1.8 m, feet ≤0.1 m off y=0, x/z
    centroid ≤0.1 m off origin. Runtime `?debug=1` tripwire warns if a hunter's live bone
    height is outside 1.2–2.5 m. `check-blindfold.mjs` (a) updated: it used to assert the OLD
    broken bbox path (the check that let this ship twice) — now asserts the bone path. See
    `memory/notes/hunter-model.md`. (Diagnostic screenshot: `assets/attached_0.jpg`.)
- **PART B — DISGUISE-ANYTHING (everything except architecture).** New shared classifiers
  `physics.isArchEntry` / `isDisguisableEntry` ("renderable mesh AND not architecture").
  `fixtures.json` flags the 4 arch entries `"arch": true` (floor_kitchen, kitchen_wall,
  wall_post, wall_header). `referee.startMatch` promotes EVERY non-arch fixture into the prop
  stream `disguisable:true` (dynFixtures flip false→true; static built-ins — counters, oven,
  fridge, cabinets, sinks, shelves, vent, doors, **pillars** — appended). `physics._buildProps`
  skips `isStaticEntry` props (their collider stays in `_buildStatic`, so physics/bounds/
  check-physics are UNCHANGED); `scene.buildWorld` renders static props as **invisible aim
  proxies** (visible mesh from the scenery loop). Capsule cap (0.55 → 1.1 m dia) keeps giant
  disguises door-passable. `tools/check-disguise-eligibility.mjs` asserts vent/counter/oven/
  pillar IN, floor/wall/ceiling OUT + passability. See `memory/notes/disguise-anything.md`.
- **OWED — live 2-player pass:** (1) remote hunter is right-sized, grounded, facing forward,
  and does NOT orbit when the hunter turns; rifle sits in-hand at a sane size; (2) a **pillar
  disguise** actually works (aim, disguise, wear it, fit through a doorway) — and a couple of
  other new targets (counter/fridge/vent) disguise cleanly.

## Prior: HUNTER MODEL FIX + FIRST-PERSON HUNTERS + CENTERED RETICLE/AIM (2026-07-11, VRmike, on `main`). Bundle of 3 fixes from live 2-player testing. Headless checks GREEN; render/camera/aim can't be seen headless → owed a live 2-player pass.

Resumed from an interrupted attempt-2 tree that had already re-anchored the hunter
model to the player body + measured its scale/foot-offset (Part A was in place). This
session finished Part A's facing, then did Parts B + C. Full detail:
`memory/notes/hunter-character-model.md`, `notes/third-person-camera.md`.

- **PART A — hunter model (mostly already in tree; verified + facing fixed).** The remote
  SWAT soldier is anchored to the PLAYER BODY position in `syncPlayers` (mesh at `p.x/p.y/p.z`,
  yaw from the snapshot) — NOT the orbiting third-person camera (the diagnosed root cause of
  the "orbits when the hunter turns, floats a few metres off" symptom was that camera
  attachment; the tree already had the body-anchored path). Scale + foot-offset are MEASURED
  from the loaded GLB bbox in `_buildHunterModel` (`s = targetH / size.y`, feet at `-box2.min.y`)
  — not magic numbers. **FIXED this session:** `character-models.json` `yawOffsetDeg` 0 → **180**
  (soldier faced backwards; native forward +Z vs game −Z). Hot-tunable if live shows it off.
- **PART B — FIRST-PERSON HUNTERS.** `main.js applyRoleView()` sets `scene.setThirdPerson(role !==
  HUNTER)` on the ROLE message and after `buildWorld`: HUNTERS are first-person (camera at the
  eye, `setCamera` first-person branch: y=1.6, YXZ yaw/pitch) and draw NO own body to themselves;
  PROPS stay third-person (see their disguise). Remote players still see the hunter's full animated
  soldier (Part A). Free-cam debug still shows the local body: `scene._wantSelfMesh()` = `thirdPerson
  || _freeCam`, and the free-cam branch of `setCamera` parks the self body at the predicted pose so
  it's visible from the fly-cam.
- **PART C — ONE CENTERED RETICLE + CAMERA-CENTER AIM.** Removed the floating reticle
  (`scene.aimScreenPoint` + `ui.setCrosshair` deleted): `#crosshair` is now fixed dead-centre by
  CSS only. `scene.aimedDisguiseTarget` raycasts from the CAMERA CENTRE through that reticle
  (`setFromCamera(SCREEN_CENTER)`) instead of a player-origin look-ray — the SAME `SCREEN_CENTER`
  (0,0 NDC) `debugPick` uses, so one crosshair/raycast system. Client still only PROPOSES the prop
  id; the host's `applyDisguise` stays authoritative (a courtesy player-range gate keeps the
  highlight honest). The generic "gun-aiming reuses this" half is DEFERRED (a gun would need a
  different target set than disguisable props) — noted in the roadmap, not built.
- **Guards:** extended `tools/check-blindfold.mjs` (same file, per plan) — measured scale/foot-offset
  path present (not hardcoded), hunters first-person, `#crosshair` centered, disguise ray from
  `SCREEN_CENTER`, aimScreenPoint gone. `node tools/check-blindfold.mjs` + `check-hunter-model.mjs`
  + `check-debug-menu.mjs` all GREEN; headless browser boot = zero console errors.
- **Files:** `js/scene.js`, `js/main.js`, `js/ui.js`, `shared/config/character-models.json`,
  `tools/check-blindfold.mjs`, `memory/notes/{hunter-character-model,third-person-camera,roadmap}.md`,
  architecture.
- **OWED — live 2-player pass:** (1) remote hunter is right-sized, grounded, facing forward, and does
  NOT orbit when the hunter turns; (2) local hunter is first-person with no self-body (free-cam still
  reveals the body); (3) reticle is a fixed centre crosshair; (4) aiming at a prop disguises as THAT
  prop. Tune `yawOffsetDeg`/grip if facing still off.

## Latest: IN-GAME DEBUG MENU behind `?debug=1` (2026-07-11, Jie, on `main`). Code + guards done; NOT live-tested (headless can't open a browser).

An in-game developer/debug panel, gated on the SAME `?debug=1` switch as the collider
wireframe view. OFF for normal play (zero debug DOM/listeners/styles without the flag).
Full detail + how-to: `memory/notes/debug-menu.md`.

- **New self-contained module `js/debug.js`** (`DebugMenu`) — plain, phone-usable DOM overlay
  (thumb toggle + collapsible panel, self-injected styles, no framework, no imports). `main.js`
  constructs it ONLY under `?debug=1` (lazy `import()`); `debugMenu` defaults null and every
  hook (`onSnapshot`, per-frame `frame`) is null-guarded.
- **Read-only displays** (can't break anything): smoothed FPS, live coords, velocity, the
  local-player state list (role/phase/disguise/grounded/frozen-blind/alive/capsule r+half/vel),
  the player roster, and per-peer **ping**.
- **Ping** measured in the netcode layer (`js/net.js`): a `__ping`/`__pong` pair intercepted
  BEFORE the referee, filling a `pings` map the panel reads. "—" when unmeasurable. _(SUPERSEDED
  2026-07-19 #192: the ping is now an ALWAYS-ON ~1Hz keepalive that IS the connection-liveness
  signal, not a debug-only toggle — `enablePing()`/`_pingOn` are gone and RTT is a free by-product.
  See `notes/netcode.md` CONNECTION LIVENESS.)_
- **Host-authoritative actions** via a gated **`C2S.DEBUG`** family in the referee — change
  team, reset game, force-morph. All route through the referee like normal state changes;
  force-morph reuses `setPlayerCollider` (capsule resizes right), bypassing only the range
  check. The referee **drops every `debug:` message unless the HOST loaded with `?debug=1`**
  (`referee.debugEnabled`, read from the host tab's URL) — a tampered guest can't inject debug
  commands into a normal match. "Exit game" is purely local.
- **Free cam / focus box / click-to-inspect** via NEW `scene.js` seams (`setFreeCam`/
  `updateFreeCam`/`debugPick`/`setFocusBox`) so camera + raycast math stay in scene.js. Free
  cam is rendering-only (main.js freezes the physics player: skips prediction, sends zeroed
  movement). Focus box is a MAGENTA box, its own instance, never in `scene.colliders`. Inspect
  reveals a disguised player (the point of a debug tool); sleep state shows "host-only".
- **Guard rails:** `tools/check-blindfold.mjs` WIDENED to also scan `debug.js`'s `scene.*()`
  calls (the "missing scene method blanks the render loop" guard now covers this module) +
  named the four new seams. NEW `tools/check-debug-menu.mjs` — the headless smoke check:
  `debug.js` parses + exports, ZERO debug DOM/CSS without the flag, main.js gates
  construction/ping behind the flag with null-guarded hooks, the referee host-gate, and the
  protocol/net plumbing. **Not executed here (no shell)** — hand-traced; run both + a live
  browser pass to close.
- **Files:** `js/debug.js` (new), `js/main.js`, `js/net.js`, `js/scene.js`,
  `shared/referee.js`, `shared/protocol.js`, `tools/check-blindfold.mjs`,
  `tools/check-debug-menu.mjs` (new), `memory/notes/debug-menu.md` (new), architecture.
- **OWED — live browser pass:** panel renders + phone-usable; team/reset/morph apply on host
  & guest (debug host); free cam flies while the body stays put; focus box + inspect pick the
  right entity + reveal a disguise; ping shows plausible RTT; and — the acceptance bar —
  loading WITHOUT `?debug=1` shows zero debug UI and a clean console.

## Latest: PHYSICS PASS #4 — bouncy-invisible-wall ROOT CAUSE + `?debug=1` collider view + alignment guard (2026-07-11, Jie, on `main`). Geometry guard hand-traced GREEN; behavioural fix owes a live browser pass.

Attempt #4. Jie: the relaunch made it WORSE — (1) still phases through props, (2) NEW "invisible
bouncy wall" confines the player to a strip along one wall, can't reach the middle. Both attached
screenshots are **circus_lot** (primitives, perfect collider==mesh) → the acute bug is
**map-independent player physics, NOT a collider misalignment** (prime hypothesis refuted by the
screenshots' own map). Full detail: `memory/notes/physics.md` (pass #4) + `notes/collider-debug.md`.

- **ROOT CAUSE (behavioural):** the pass-#2 depenetration failsafe `_isPenetrating` tested the
  capsule against ALL solids (only `EXCLUDE_SENSORS`). With the world now ~130 **knockable**
  props (fix #2) and a **fatter disguised capsule** (pass #3), a player pushing through props
  overlapped one every substep → snapped back to `safePos` = "bounce off empty air, can't reach
  the middle, confined to a strip." The failsafe is only meant to recover from IMMOVABLE
  geometry (wall-top/floor tunnel), never to fight a prop being shoved.
- **FIX (minimal):** `_buildStatic` records the static WORLD collider handles
  (`_staticHandles`); `_isPenetrating` passes Rapier's `filterPredicate` so depenetration
  considers ONLY those — props (dynamic on host, fixed on guest) are excluded on BOTH sims (no
  rubber-band). Wall/floor tunnel recovery preserved; prop collide-and-slide unchanged (still
  blocks + shoves). Cleans up symptom 1 too (the failsafe was degrading prop-collision feel).
- **`?debug=1` collider view (NEW):** wireframe of EVERY collider in-world (ground grey, walls
  red, static fixtures cyan, each prop's collider yellow + tracking the shove). Bugs are now
  SEEN, not guessed. Doc: `notes/collider-debug.md`.
- **`shared/bounds.js` (NEW) — ONE shared bounds source** read by the debug view, the guard,
  and diagnosis, reusing physics.js's own size helpers → the check can't drift from the engine.
- **`tools/check-physics.mjs` (NEW):** asserts every collider AABB overlaps its mesh AABB and
  isn't smaller (misalignment guard), and every spawn + hunter spawn is collider-free with no
  arena-sized fixture (open-middle guard). **Hand-traced GREEN** on all three maps (no shell in
  sandbox; some GLBs UNVERIFIED = not in asset-dims, keep the primitive footprint = the mesh).
- **Config unchanged** (no blind tuning). **Files:** `shared/physics.js`, `shared/bounds.js`
  (new), `js/scene.js`, `js/main.js`, `tools/check-physics.mjs` (new), notes + architecture.
- **OWED — live browser pass (Jie, phone):** disguise as a big crate, walk INTO props toward the
  middle → push through/past instead of bouncing; jump onto the divider/wall top → no tunnel/void;
  props still shove + trampleable. Run `node tools/check-physics.mjs` (+ the other check-*.mjs)
  to gate. Open `?debug=1` to eyeball collider alignment.

## [prev] PHYSICS SOLIDITY PASS #3 — RELAUNCH: floor clamp + runnable check (2026-07-11, Jie/Teravortryx, on `main`). Headless invariants pass (hand-traced); live browser pass still owed.

Relaunch of pass #3 (first attempt's session was lost). Pass #3's code (disguise-sized capsule
+ thin-panel min-thickness) was already in the tree; this session re-traced from data, refuted
the empty-measurements theory, and closed the one concrete remaining defect. Full detail:
`memory/notes/physics.md` (top "RELAUNCH").

- **Diagnosis (data-verified):** colliders MATCH meshes on all shipped maps — the primitive
  footprints were already normalized to `native × modelScale(0.75)` (door 2.1, fridge 1.88,
  counter 0.75, food_crate 1.5×0.72, …), so there is no collider-smaller-than-visuals gap and
  no wall top-face height gap. `asset-dims.json` isn't even read at runtime (its keys are GLB
  paths, not the `{dims:{}}` shape config.js expects) — a genuine red herring. The "fall
  through the ground → purple void" in BOTH screenshots is the host respawn's ~0.5 s throttled
  RECOVERY WINDOW (only fires >2 m below floor), not a permanent fall.
- **Fix (minimal, guaranteed):** a per-substep HARD FLOOR CLAMP in `physics.js _substep` — the
  capsule foot can never pass `y=FLOOR_Y` in any substep, applied in the SHARED substep so host
  + every guest predictor match. Kills the void window; lands a tunnelling capsule ON the floor
  instead. Purely additive (no legit sub-floor space anywhere). `FLOOR_Y` is now an exported
  constant. Throttled referee respawn kept as the higher net.
- **Shared pure helpers** `halfExtentsFor` + `thickenWallHalfExtents` extracted from the inline
  collider math; `_buildStatic` uses them (behaviour-identical) and the check imports the SAME
  ones — engine + guard can't drift on collider sizes / which walls thicken.
- **`tools/check-physics-solidity.mjs` REWRITTEN** to a pure-JS, zero-dep, deterministic guard
  that actually runs on bare `node` (the old Rapier-sim SKIPPED everywhere and guarded nothing).
  Asserts, per real map+catalog: (A) world-prop box colliders ≥ their mesh (no sink-in gap) +
  bounded disguise overhang; (B) static box colliders ≥ mesh HEIGHT (no top-face gap) + thin
  panels thickened past the capsule radius; (C) slab top == FLOOR_Y, covers arena, ≫ one-substep
  fall + the engine floor-clamp. **Hand-traced GREEN on all three maps** (no shell to execute in
  sandbox). Run `node tools/check-physics-solidity.mjs` to gate.
- **Props stay movable/trampleable** — the clamp only touches below-floor Y; nothing frozen.
- **Config unchanged.** Did NOT blind-tune `disguiseColliderMaxRadius` (build #38's mistake);
  the ~0.2 m disguise mesh overhang on the widest disguises is the documented passability
  tradeoff.
- **OWED — live browser pass (Jie/Teravortryx, phone):** jump into the divider top / walk a
  crate-disguise into world props / drop off a ledge — confirm no void screen, no walk-inside,
  props still shove + trampleable; watch the console anti-fall warning stays silent.

## [prev] PHYSICS SOLIDITY PASS #3 — disguise-sized capsule + thin-wall min-thickness (2026-07-11, Jie/Teravortryx, on `main`). Code done; NOT live-tested (no shell / headless).

Third pass at the known-hard collision area. Two players reported (1) a player prop passing
through / hiding fully INSIDE world props and (2) jumping into a wall tunnelling through then
falling through the floor. Passes #1/#2 already refuted the movement theories, so this pass
TRACED the two remaining mechanisms and fixed those (not constant-tuning). Full detail:
`memory/notes/physics.md` (top "SOLIDITY PASS #3").

- **Bug 1 root cause = the accepted caveat, now fixed.** A disguised player's physics body
  was a fixed tiny capsule (r0.4) regardless of disguise size, so a big disguise clipped into
  / slid inside world props. New `PhysicsWorld._capsuleDimsFor` + `setPlayerCollider(id,type)`
  grow the capsule GIRTH to the disguise footprint (clamped `[0.4, rules.disguiseColliderMaxRadius=0.55]`
  for doorway passability), keeping TOTAL height/centre constant so grounding/jump feel is
  unchanged. Wired host (`referee.applyDisguise` + load-race) AND each client's own prediction
  (`main.js onSnapshot`) so authority + prediction match. Residual: 0.55 cap leaves ~0.2 m
  edge-clip on the very widest disguises (was ~0.35) — bounded by door width; documented.
- **Bug 2 root cause = thin wall panels.** Divider/side walls are d0.4 static boxes, thinner
  than the capsule is wide → a fast jump into the face can pop through to the far side then
  drop through the floor. `_buildStatic` now enforces `rules.minWallHalfThickness=0.6` on thin
  wall PANELS only (wide+thin: kitchen_wall/wall_header/door/shelf); narrow posts/pillars and
  bulky appliances untouched. Swept mover / CCD / depenetration / terminal-fall clamp kept.
- **Anti-fall teleport now `console.warn`s** counts+map when it fires (should be ~never after
  this pass → early regression signal). Kept as the last-resort net.
- **NEW `tools/check-physics-solidity.mjs`** (authoring-only, LIVE-sim sibling to the static
  checks): asserts prop-can't-penetrate-prop, player-at-jump-speed-can't-cross-wall, player-
  never-below-floor. Rapier-in-Node caveat: tries dev-only `npm i --no-save
  @dimforge/rapier3d-compat@0.14.0` then the CDN, else SKIP+exit 3. **Not executed here (no
  shell)** — hand-traced; run it + a live phone playtest to close.
- **Config:** `rules.json` +`disguiseColliderMaxRadius:0.55` +`minWallHalfThickness:0.6`.
  **Files:** `shared/physics.js`, `shared/referee.js`, `js/main.js`, `shared/config/rules.json`,
  `tools/check-physics-solidity.mjs` (new), notes.
- **OWED — live playtest (Jie/Teravortryx, bring a phone):** disguised prop rests against world
  props (no walk-through/hide-inside); wall jumps don't tunnel/fall-through; props still push +
  trampleable; disguised movement fits through doors; console anti-fall warning stays silent.

## Latest: HUNTER CHARACTER MODEL v1 — animated SWAT soldier for remote hunters (2026-07-11, VRmike, on `main`). NOT live-tested (headless can't load a GLB / animate).

Remote **hunters** now render as an animated third-person SWAT soldier — what OTHER
players (props) see. The LOCAL hunter is UNTOUCHED (first-person, no own body this pass).
Props untouched (still their disguise). No netcode/protocol/physics/collider changes —
reuses the existing position/yaw snapshot state. Full detail:
`memory/notes/hunter-character-model.md`.

- **Assets fetched** (both CC0, Quaternius via poly.pizza; auto-added to
  `assets/manifest.json` + `CREDITS.md`): SWAT body
  `assets/713f6535-f4f3-4367-a4c6-ced126ae0936.glb` (24 `CharacterArmature|*` clips,
  `Wrist.R` bone) + assault rifle `assets/9a0e478c-de82-4773-9b70-a0219bb0057c.glb`.
- **NEW registry `shared/config/character-models.json`** — separate from
  `props.json`/`fixtures.json` ON PURPOSE (those feed collider-baking; a player character
  must not get a collider). Holds body/weapon GLB paths, capsule-match `heightMeters`,
  the 5 clip suffixes, anim tunables, and the HOT-TUNABLE rifle grip offset + facing
  (`yawOffsetDeg`) — grip/facing fixable without a rebuild. `js/config.js` loads it into
  `cfg.characterModels` (tolerant of absence → capsule fallback).
- **`js/scene.js` subsystem** (view-only): lazy GLTFLoader + `SkeletonUtils`; per-hunter
  **rig-safe `SkeletonUtils.clone`** (a plain `.clone()` breaks skinned rigs — avoided);
  sized to the capsule (feet at origin); rifle parented to `Wrist.R`; `AnimationMixer`
  with a velocity-driven idle/run state machine (`Idle_Gun` / `Run_Shoot` / `Run_Back` /
  `Run_Left` / `Run_Right`), timeScale by speed, ~0.15s crossfades. **Velocity is DERIVED
  from successive snapshots** in `syncPlayers` (snapshot has none). Clips matched by
  SUFFIX (guards the `CharacterArmature|` prefix). Only REMOTE players get the model
  (`meshForPlayer(p,{animated:true})`); self stays a capsule. Model-ready state folded
  into the entry kind (`hunter:cap`→`hunter:swat`) so it rebuilds when the GLB lands;
  failed load stays capsule. `setWeaponVisible(bool)` (default visible) hides the rifle
  for later tool-switching. `js/main.js` passes the registry to `buildWorld` + calls
  `scene.updateAnimations(dt)` each frame.
- **Verification (static only — honest):** `node tools/check-hunter-model.mjs` (new,
  authoring-only) asserts assets present+registered+real glTF, registry self-consistent
  + separate from props/fixtures, clip suffixes are real pack clips, scene methods +
  rig-safe clone + wiring exist. `tools/check-blindfold.mjs`'s "every `scene.X()` is
  defined" guard covers `updateAnimations`. **OWED — live browser pass:** props see the
  animated soldier, idle/run play without console errors, rifle sits in the hand, model
  tracks the capsule, local hunter still sees no own body. Then tune grip/facing.
- **Files:** `shared/config/character-models.json` (new), `js/config.js`, `js/scene.js`,
  `js/main.js`, `tools/check-hunter-model.mjs` (new), notes + architecture.

## Latest: "STUCK BLINDFOLD" bugfix #2 — REAL root cause was a render-loop crash, NOT the blindfold (2026-07-11, VRmike, on `main`)

The prior two sessions kept "re-verifying the blindfold" and finding it correct — because
it **was** correct. The actual bug was elsewhere and the blindfold was a red herring.

- **Symptom (live screenshot):** a PROP in the HUNT phase sees a solid dark blue/purple
  screen; HUD ticks fine; world never draws — for EVERYONE, any role, any phase.
- **Root cause:** `js/main.js` `frame()` calls `scene.aimedDisguiseTarget(...)` and
  `scene.highlightProp(...)` (the crosshair-disguise API) but **neither method existed in
  `js/scene.js`** — a half-landed refactor. The `TypeError` threw every frame BEFORE
  `scene.render()` and the `requestAnimationFrame(frame)` re-arm, so the render loop ran
  once and died. Network snapshots kept updating the DOM HUD. A never-rendered transparent
  WebGL canvas showed the body's dark `radial-gradient` CSS background → the "blue/purple".
- **Fix (this session):** implemented the two missing methods in `js/scene.js`
  (`aimedDisguiseTarget` = raycast look-ray vs disguisable prop primitives → hit prop id;
  `highlightProp` = one reused wireframe outline box). Prop render records now carry
  `disguisable`; primitives tagged `userData.propId`. Client-side selection aid only — the
  host's `applyDisguise` stays authoritative. NO blindfold/referee/netcode/physics change.
- **Blindfold confirmed correct & untouched:** overlay present in `index.html`, gate derived
  fresh (`role===HUNTER && phase===HIDING`) off snapshot + phase event, `.hidden`
  `!important` beats `.blindfold`, referee `blindHunterSnapshot` data-half gated the same.
- **Restaurant = default map:** `maps.json` reordered so `restaurant` is the FIRST key.
  The referee default is `Object.keys(this.maps)[0]` and the picker renders in key order,
  so first-key == default-selected. Data-only reorder; block contents byte-identical.
- **New headless check `tools/check-blindfold.mjs`** (authoring-only, never shipped):
  statically asserts every `scene.<method>()` main.js calls IS defined in scene.js (the
  exact regression that broke this), + blindfold decision a/b/c + referee data-half d.
  Run: `node tools/check-blindfold.mjs`. NOTE: authored + hand-traced against source; the
  sandbox has no shell, so it was not executed here — run it + a live browser pass to close.
- **OWED:** one live browser run (prop + hunter) to confirm the world draws with no console
  error and the blindfold behaves; run the two check tools. Files: `js/scene.js`,
  `shared/config/maps.json`, `tools/check-blindfold.mjs`, notes.
  Detail: `memory/notes/anti-cheat-blindfold.md` (Attempt #2).

## Latest: HUNTER BLINDFOLD fix RE-VERIFIED on-disk on `main` (2026-07-11, VRmike bugfix, follow-up session)

A follow-up session (resuming a cut-off attempt) re-read all six pieces on `main` and
confirmed the fix is fully present and correct — **nothing to build.** Checked the SERVED
root files (not the dead `client/` stubs): root `index.html` `#blindfold` div; `css/style.css`
`.blindfold` (z-index:12, `pointer-events:none`, blur, `.hidden`=display:none default off);
`js/ui.js` `setBlindfold` (plain show/hide, non-latched); `js/main.js` `updateBlindfold`
derives `role===HUNTER && phase===HIDING` and is called from BOTH `onSnapshot` (L348) and the
`phase` event (L413), plus force-cleared on back-to-menu (L316) + return-to-lobby (L199);
`shared/referee.js` L708 data-half gated on the same condition via `blindHunterSnapshot`.
No edits made (touching the already-correct gate would be an out-of-scope regression). Still
OWED: the live per-role browser test + deploy/link (can't be done headless). Detail below +
`memory/notes/anti-cheat-blindfold.md`.

## HUNTER BLINDFOLD visual half restored on `main` (2026-07-11, VRmike bugfix)

Reported as "everyone loads into a solid blue/blindfold screen that never clears — props
too." Root cause was NOT a mis-gated overlay: `js/main.js` already derived the blindfold
correctly (`role === HUNTER && phase === HIDING`, driven off both snapshot and phase event),
`shared/referee.js` already withheld prop positions from a blinded hunter correctly, and
`js/input.js` `lookFrozen` was wired. **The visual half was simply missing** — `ui.setBlindfold`
was called but never defined in `js/ui.js`, and there was no overlay div/CSS. So *every*
client (props included) threw `ui.setBlindfold is not a function` on the first snapshot,
breaking the game for everyone.

Fix (additive, no gate/referee/netcode changes):
- `index.html`: added `#blindfold` overlay div (+ `#blindfoldTimer`) inside `#game`.
- `css/style.css`: added `.blindfold` — dark blackout + `backdrop-filter: blur`, z-index:12,
  `pointer-events:none`.
- `js/ui.js`: registered the two elements and added `setBlindfold(blind, seconds)` — a plain
  show/hide + countdown, driven by main.js's existing derived condition (never latches).

Acceptance verified by reading the flow (no live run available in sandbox): props always
compute `blind=false` → world visible at all times; a hunter sees the blackout through HIDING;
the phase event flips `state.phase=HUNTING` and re-derives `blind=false` → overlay clears the
instant HUNT starts. Edge cases (solo/host-start prop, mid-phase hunter joiner) fall out of the
derived condition. Full detail: `memory/notes/anti-cheat-blindfold.md`.

## Status: PHYSICS SOLIDITY PASS #2 on `main` (2026-07-11, Jie) — three specific bugs. Code/wiring done; all three need a LIVE re-test (headless can't verify runtime physics).

Second solidity pass after Jie's playtest. Scope: player controller + disguise rotation +
fall path only (no map/netcode/editor). Full detail: `memory/notes/physics.md` (top
"SOLIDITY PASS #2"). Honest per-bug summary:

1. **Deep-inside-props (Bug 1).** *Filter-excludes-dynamic theory REFUTED* — the movement
   query passed no filter and Rapier's default never excluded dynamic bodies; they were
   already obstacles the capsule blocks against (impulses are the ADDITIONAL shove). Added
   an explicit `EXCLUDE_SENSORS` filter to make that unambiguous (behaviour-identical here).
   Confirmed the controller offset (0.02) is controller-global → applies to dynamic contacts
   too. Residual "looks embedded" is the player-sized capsule < disguise mesh + empty
   asset-dims footprints + a one-substep shove lag — documented, not a controller bug.
2. **Wall-top fall-through (Bug 2).** *Raw-gravity theory REFUTED* — all vertical motion
   already goes through the swept `computeColliderMovement`; no raw translation exists. The
   controller sweeps, so the real cause is the query STARTING inside geometry (wall-top jump
   leaves the capsule a hair inside a thin edge). Added: **depenetration failsafe** (snap
   back to last collision-free pos if a substep starts penetrating; skin-shrunk test so
   resting/pressing never trips it; `feel.depenetrate`, default ON) + **terminal fall clamp**
   (`rules.maxFallSpeed` 20). Verified the void→respawn failsafe is host-level + global to
   all maps (kept). No redundant step-clamp (sweep already covers a single-frame leap).
3. **Rotation snap (Bug 3).** Right-click no longer snaps `dispYaw` to look-yaw; it now
   eases at a capped `rules.disguiseRotSpeedDeg` (270°/s) with a per-increment footprint
   shape-cast gate (`physics.rotationWouldCollide`) that STOPS the turn if it would rotate
   the prop into a wall. Honest caveat: the physics body is a symmetric capsule (yaw can't
   truly wedge it) — the gate tests the PROP footprint so the disguise won't rotate into
   geometry; the fix is mostly the continuous (non-teleport) turn. Client mirrors the ease
   on the own-model (cosmetic; host authoritative + gates).

**Config:** `rules.json` +`maxFallSpeed:20` +`disguiseRotSpeedDeg:270`; `physics-feel.json`
+`depenetrate:true`. **Files:** `shared/physics.js`, `shared/referee.js`, `js/main.js`,
`shared/config/{rules,physics-feel}.json`. **OWED — live re-test:** solidity feel, wall-top
jumps, rotation wedging; watch depenetration for stutter (flip `depenetrate` off if so).

## Status: PHYSICS FEEL TUNING on `main` (2026-07-11, Jie) — three dials + anti-bob. Config/wiring done; FEEL still owed a live playtest (can't be verified headless).

Small focused feel pass after a live playtest: players push deep INTO props before they
react; standing on objects bobs up/down; everything feels bouncy/jello. No architecture
change — tuning constants + one minimal controller-grounding tweak. Full detail:
`memory/notes/physics.md` (top "FEEL TUNING" section). Exact values set:

- **NEW `shared/config/physics-feel.json`** (physics-owned tunables, NOT `rules.json`).
  `config.js` loads it into `cfg.feel`; that ONE object flows to the host's authoritative
  world (`referee.js`) AND every client's prediction world (`main.js buildPredict`), so
  the two sims can't derive mismatched feel and rubber-band. `physics.js resolveFeel()`
  is the single derivation point (null-safe defaults).
- **Restitution → 0** on ALL colliders (ground, walls, static + floor fixtures, dynamic
  props, static-overflow props), from `feel.restitution`. Player capsule is kinematic →
  restitution is a no-op there, so not pretend-edited. Swept: no stray non-zero values.
- **Solver iterations 4 → 12**, `numAdditionalFrictionIterations → 4`
  (`world.integrationParameters`, Rapier 0.14 TGS-soft API, feature-detected + guarded
  with a pre-TGS fallback). Main fix for sink-into-props + most bobbing.
- **Prop damping:** linear 0.5 → **0.4**, angular 0.7 → **0.4** (from config).
- **Anti-bob (`feel.capGroundedImpulse`, default ON):** a player grounded AND standing
  still stops feeding impulses into the prop underfoot (kills the push-down/spring-back
  bob loop); walking into a prop still shoves it (tell preserved).
- **`tools/check-physics-feel.mjs`** (new, authoring-only, never shipped): asserts
  host==client feel derivation + range-checks the dials. `node tools/check-physics-feel.mjs`.
- Files: `shared/config/physics-feel.json` (new), `js/config.js`, `shared/physics.js`,
  `shared/referee.js`, `js/main.js`, `tools/check-physics-feel.mjs` (new), notes.
- **OWED — live feel-test (Jie):** props stop sinking / feel rigid; standing bob gone;
  shoved props settle without wobble; a real shove still reads as a tell. **Bring a
  phone** — if the host phone drops below 60fps, lower `numSolverIterations` first (12→8).

## Status: POLISH/FIX PASS on `main` — 7-item playtest punch list (2026-07-10, VRmike+Jie). Structural-verified; physics FEEL + button VISUALS still owed a live playtest.

Post-merge fix pass on `main` from a VRmike+Jie playtest. All seven landed; the
headless caveat holds (items about physics feel / button visuals can't be eye-tested
here). Per-item:

1. **Tabletop clutter dynamic / built-ins static — ROOT CAUSE FOUND.** `fixtures.json`
   had **no `static`/`decor` flags at all** on `main` (a merge dropped them), so
   `isStaticEntry()` returned false for EVERYTHING → floors, walls, pillars, doors,
   appliances were all becoming DYNAMIC rigid bodies (biggest-first, so the floor/walls
   won the dynamic-cap budget and the room collapsed; tables sank into the jittering
   floor tiles). Fix: re-added `"static": true` to the genuine built-ins ONLY (floor,
   walls, pillars, door, the new divider wall, oven/stove(s)/fridge/cabinets/extractor
   hood/counters/sinks/shelf). Everything else — **all tables** (dining + prep + bar),
   dishrack, every plate/bowl/pot/pan/lid/dish/food/condiment/canister — is left
   UNFLAGGED = dynamic/knockable. The now-dynamic tables settle on a SOLID static floor
   with their clutter instead of fighting it. Files: `shared/config/fixtures.json`.
2. **Jar/cannister rows split.** `jars.glb` is a merged multi-jar cluster with ONE box
   collider (the float/vibrate tell — mesh wider than its single box, one dynamic body).
   No single-jar GLB exists and a baked GLB can't be decomposed here, so per the plan's
   fallback each `jars` placement was replaced with a ROW of individual `canister`
   bodies (primitive cylinders, r0.16×h0.5), each its own dynamic rigid body + matching
   collider. 3 spots × 3 canisters = 9. `jars` catalog entry removed; `jars.glb` now
   inert on disk. Files: `fixtures.json`, `maps.json`.
3. **Dev Map Editor button on PC.** Added `#editBtn` "🛠 Map Editor (dev use only)"
   (index.html) + `.dev-btn` CSS; `main.js` `updateEditorButton()` shows it on desktop
   host/solo (never touch, guest, or host-with-guests — reuses `canEnterEditor`) and
   refreshes on every transition. Click → `enterEditor(true)` which forces the help
   panel open (new public `editor.showHelp()`); Ctrl+E keeps its first-open-only
   auto-help. Editor is reachable (main.js already lazy-imports `js/editor.js`).
4. **Fall-through failsafe** (host referee, `integrate` physics branch, ~0.5 s throttle):
   any live player whose capsule top < floorTop(0) − 2 → teleported to their stored
   `player.spawn` at y0, velocity zeroed (via `physics.setPlayerPosition`); any dynamic
   prop below y=−2 → `physics.respawnEscaped()` sends it back to its spawn transform,
   velocities zeroed. Host-authoritative only; correction rides the normal snapshot (no
   client teleport). Files: `shared/referee.js`, `shared/physics.js`.
5. **Thick floors + outer walls** (`physics.js` `_buildStatic`): ground slab → 3 m thick
   extended DOWN (top still y=0); boundary walls → 1.5 m thick pushed OUTWARD (inner
   face unchanged) + 5 m tall (base y0, can't be jumped/flown over); floor fixtures
   flagged `"floor": true` get a ≥1 m collider extended DOWNWARD with the visible top
   held flush (top = 2·halfH + y). Render meshes untouched.
6. **CCD** enabled on the player capsule (`body.enableCcd(true)`) and on dynamic prop
   bodies (`setCcdEnabled(true)`), both method-guarded. `physics.js`.
7. **Kitchen divider service-window wall** (`fixtures.json` + `maps.json`): no wall-with-
   window GLB exists (modular_walls is an unusable multi-panel kit), so per the approved
   plan it's built from plain static boxes at true height (~2.8 u): the existing divider
   COUNTERS are the waist-high window sills, new `wall_post` verticals frame the bays,
   `wall_header` lintels (base y2.1) close the tops → open service windows facing +z
   (dining), with the two existing walkway gaps (x≈±7.5) kept clear.

**HEADLESS CAVEAT (unchanged rule):** items 1/2/5/7 are verified STRUCTURALLY (right
flags, right sizes, tops flush, wall geometry in the data) — NOT by eye. Physics FEEL
(tables settling, jars behaving, no residual jitter), the divider wall LOOK, and the dev
button's on-screen placement need the live playtest. A small follow-up nudge on wall
placement or table/jar behaviour is a realistic outcome. Detail in
`memory/notes/{physics,restaurant-map,level-editor}.md`.

## Status: IN-GAME LEVEL EDITOR (debug mode) COMPLETE + COMMITTED (attempt 3, 2026-07-10, vrmike). Desktop-only, not live-tested (headless).

## Status: PHYSICS FIX PASS — controller + knockable world + calm start (2026-07-10, on `physics-net`). NOT feel-tested.

Playtest-driven fix pass on the ALREADY-BUILT physics/netcode. Full detail in
`memory/notes/physics.md` (top section) + `netcode.md`. Honest summary:

- **MERGE NOT DONE (blocked, honest).** Task said FIRST `git merge origin/main`
  (bbox-normalized layout + populated `asset-dims.json`). No shell here by design →
  can't run the merge; main's populated blobs are zlib git objects the file tools
  can't inflate. The measured-bounds CONSUMPTION path is already wired on this branch
  (`shapeFor`→`c.measured`, scene→`c.measured`) with a graceful fallback to authored
  footprints, so colliders bake from measured bounds automatically once the data
  lands. `asset-dims.json` is still `dims:{}` → authored footprints in use.
  **OWED: someone with a shell must merge origin/main into physics-net.**
- **Fix #1 controller** (`shared/physics.js`): diagnosis corrected — the branch code
  was ALREADY compute-before-move (`computeColliderMovement` + apply corrected delta)
  and prediction ALREADY shares the same `PhysicsWorld` as the host, so the
  "translate-first eject" hypothesis didn't match. Real fixes: (a) **jump jitter** —
  snap-to-ground toggled OFF while `vy>0`, ON otherwise; (b) **character mass** 3.0 +
  **prop density** 1.0 so shoving a chair feels natural (needs feel-test); (c)
  **fixed timestep** — `step()` runs whole 1/60 substeps via an accumulator, no
  variable partial tail; (d) offset/autostep/slope/snap tunables in rules.json.
- **Fix #2 flip static→dynamic** (`physics.js` `isStaticEntry` + catalog flags +
  `referee.js`): world now defaults KNOCKABLE. Static only for `"static"`-flagged
  built-ins (floor/walls/pillars/doors/hood/counters/cabinets/oven/fridge/sinks/
  shelves) and `"decor"`-flagged tiny garnish. Tables, cookware, plates, dishes,
  food, condiments → dynamic. Decoupled dynamic-ness from the disguise pool: referee
  builds ONE prop stream = disguise props (disguisable) + non-static fixtures
  (non-disguisable); disguise gates skip non-disguisable. Cap raised 60→130. Disguise
  range now reads LIVE prop positions (`referee.propLive`).
- **Fix #8 mid-join** (deliberate change): late joiners get CURRENT prop transforms
  (centre+quaternion via `PhysicsWorld.allProps()`), not spawn — a kicked chair stays
  kicked. STARTED prop entry gained `disguisable` + optional live quaternion form.
- **Fix #3 calm start**: dynamic bodies spawn `SPAWN_EPS` (0.02) above rest so
  nothing interpenetrates at match start; settle + sleep. Nothing overlaps at spawn
  by construction.
- **Files:** `shared/physics.js`, `shared/referee.js`, `shared/protocol.js` (doc),
  `js/scene.js`, `js/main.js`, `shared/config/fixtures.json` (static/decor flags),
  `shared/config/rules.json` (cap 130 + controller/prop tunables), notes.
- **NEEDS A LIVE FEEL-TEST (can't be done headless):** does jumping feel smooth; does
  shoving a chair/table feel natural (tune characterMass + propDensity); is the
  match-start settle of ~130 bodies calm on all 3 maps; does a phone HOST hold frame
  rate with the bigger dynamic set (lower `maxDynamicProps` if not); mid-join shows
  the knocked-about room correctly; prediction/reconciliation still smooth with the
  fixed-timestep mover.

## Status: MEASURED-BOUNDS COLLIDER SEAM + PROP CAP (2026-07-10, on `physics-net`). NOT playtested.

Context correction first: the "big pass" below (Rapier physics + full prediction/
reconciliation netcode) was **already built and wired** on this branch by the
2026-07-09 session — it is NOT re-done here. This follow-up task assumed two things
that were both FALSE on disk: (a) that physics still needed implementing, and (b)
that a measured `shared/config/asset-dims.*` file from a bounding-box normalization
build already existed. It did **not** — colliders were (and by default still are)
baked from the hand-authored primitive footprints in `props.json`/`fixtures.json`.

I could NOT produce measured GLB bounds here (no shell; `Write` is text-only, can't
decode binary `.glb` to compute a bbox — that measurement IS the "prior build" that
never landed its output). Rather than **guess sizes** (explicitly forbidden) or
silently declare victory, I wired the **drop-in seam** so measured bounds bake
automatically the moment they exist, and shipped the file EMPTY (zero behavior
change today). Asked VRmike which path to take; got no answer, took the
non-destructive recommended one.

- **`shared/config/asset-dims.json`** (NEW, ships empty `dims:{}`): the output slot
  for the bounding-box build — per catalog type, the normalized **world-space**
  `{w,h,d}` box. Documented contract in the file + `memory/notes/asset-dims.md`.
- **`js/config.js`**: `loadConfig` fetches it (tolerant of absence) and attaches
  `entry.measured` onto the matching catalog entry. One mutation reaches all three
  consumers via the shared `cfg` object: host referee's `PhysicsWorld`, each
  client's prediction `PhysicsWorld`, and the renderer.
- **`shared/physics.js` `shapeFor`**: if `c.measured` present → bake a **cuboid from
  the measured bounds** ("cuboid from measured bounds; trimesh only where clearly
  wrong"); else fall back to the primitive footprint. Also added the plan's
  **phone-safety cap** (`rules.maxDynamicProps`, default 60): props past the cap are
  solid STATIC colliders (collidable, not shovable). Restaurant (~56) is under it →
  inert today.
- **`js/scene.js`**: GLB mesh scale now prefers `c.measured` over `modelDims`, so
  mesh and collider stay in lockstep once measurements land (all 3 scale paths).
- **Regression**: with `dims:{}` empty, every `c.measured` is `undefined` → all `||`
  chains fall through to the exact pre-seam path. Byte-for-byte prior behavior;
  verified by inspection (headless can't runtime-test). Files: `shared/config/
  asset-dims.json` (new), `js/config.js`, `shared/physics.js`, `js/scene.js`,
  `shared/config/rules.json`, `memory/notes/asset-dims.md` (new), `physics.md`.
- **STILL OWED**: run the bounding-box normalization build and populate
  `asset-dims.json` so colliders bake from real measurements instead of the
  eyeballed footprint fallback. Until then, collider sizes = the same footprints the
  big pass shipped. Live multiplayer playtest still the only real QA for netcode.

## Status: IN-GAME LEVEL EDITOR (debug mode) BUILT (2026-07-10, vrmike). Desktop-only, not live-tested (headless).

A lightweight edit mode baked into the client so a human can fix placement/rotation/
scale by eye instead of iterating blind builds. **Ctrl+E** (desktop) toggles it. Full
detail: `memory/notes/level-editor.md`.

**Attempt history:** attempt 1 built the core editor in the working tree (fly/select/
move/rotate-R/scale-±/palette/delete/export + the `scene.js` visual-scale support +
`main.js`/`input.js` wiring) but was cancelled before committing; attempt 2 died on a
sandbox wall and committed nothing useful. **Attempt 3 (this session)** found all of
attempt 1's work intact in the working tree, filled the three missing listed
requirements — **help panel (req 9)**, **mouse-wheel rotate (req 4)**, **inspector
scale slider (req 5)** — in `js/editor.js` + `css/style.css`, verified the round-trip
and the client-only/no-shared-touch guarantees, and committed the whole feature.
`js/input.js` was checked for the "stray stub" the brief warned about: none — its only
editor code is the legitimate Ctrl+E→`onToggleEdit` detection. Highlights:

- **Help (req 9):** a **?** footer button + **?** key opens a modal with every control
  and a "how to save" note (Copy map JSON → paste to DevBot in Discord #devbot naming
  the map → bot commits). **Auto-opens the first time** edit mode is entered, then a
  `localStorage` flag stops it nagging.
- **Rotate (req 4):** mouse wheel now rotates the selection ±15° (Shift = fine), the
  same yaw-only path as R (was previously a no-op).
- **Scale (req 5):** inspector gained a 0.1×–5× range slider alongside the +/- keys.

- **Client-local SANDBOX, not a paused match** — the honest reason it's genuinely
  client-only. Ctrl+E steps OUT of the game loop into `Editor` (`js/editor.js`), which
  owns its own THREE scene + free-fly camera and loads the map fresh from config. The
  referee/netcode/match-flow are never touched (they keep ticking; the editor ignores
  them). Gated to solo/local play (`canEnterEditor`): desktop only, blocked as a guest
  or as a host with guests. Frame loop + input loop early-return while `state.editing`.
- **Reuses ONE renderer + scene.js mesh helpers** (`makePropMesh`, `instantiateModel`,
  `targetSizeForEntry` now exported) so edited objects size EXACTLY like the game.
  Own isolated GLTF loader (game renderer untouched). NO pointer lock — free cursor,
  right-drag to look — so it never contends with input.js's desktop lock path.
- **Controls:** WASD+Space/Shift fly; click select (outline + inspector: name/pos/rotY/
  scale/REAL bbox size from asset-dims.json, lazy-fetched); left-drag move (Shift=up/
  down), G snap-to-floor; R rotate 15° (Shift fine, Alt reverse); +/− scale 0.1–5×;
  palette (click / 1–9) spawns at crosshair ground point at normalized scale; Del
  delete + **U undelete** (restore stack); footer map dropdown; Copy/Download full
  `maps.json` (edited map's fixtures/props replaced, others byte-identical).
- **Prerequisite that landed with it — per-object `scale` (VISUAL-ONLY).** The loader
  read y/rot but NOT scale. Added additive, inert-for-existing-maps `scale` support in
  `scene.js` only (fixture + prop visuals), plus a CLIENT-side zip in `main.js` STARTED
  that reattaches authored prop `scale` onto the referee's prop instances by index. Per
  the approved "client-side fix" scope + constraint 9, `shared/physics.js` and
  `shared/referee.js` are UNTOUCHED — so scaled objects render exact but their COLLIDERS
  stay base-size (documented gap; most edits are at scale 1).
- **Touched files:** `js/editor.js` (new), `js/main.js`, `js/input.js` (Ctrl+E →
  `onToggleEdit` only), `js/scene.js`, `css/style.css`. NO change to shared/ (referee/
  protocol/net/physics). **Zero boot fetches** (editor + its dims fetch are lazy).
- **Playtest owed:** Ctrl+E in lobby → fly/select/transform/spawn/delete/undelete →
  export → paste back into maps.json → reload → layout matches incl. rot + scale; and
  confirm Ctrl+E refuses during a real multiplayer match.

## Status: RESTAURANT BOUNDING-BOX NORMALIZATION — measured scales (2026-07-10, vrmike). Not playtested (headless).

Stops guessing per-object scales; every restaurant GLB is sized from its MEASURED
native bounding box. Prereq for the physics build (colliders bake from these bounds).
Full detail: `memory/notes/restaurant-map.md` (top "THIRD PASS"). Highlights:
- **Measurement step** `tools/measure-glbs.mjs` (authoring-only, never shipped/imported):
  parses each GLB's JSON chunk, transforms POSITION accessor min/max by node world
  matrices (FBX2glTF bakes ×100 on the mesh node — must apply it). Output committed to
  `shared/config/asset-dims.json` (build-time reference; NOT fetched at page boot →
  headless load stays green).
- **One measured scale.** The KayKit pack is internally consistent, so a single world
  scale normalises all of it: `restaurant.modelScale = 0.75` (door 2.8→2.1, fridge
  2.5→1.88, chair 1.21→0.9, counters/tables→0.75). scene.js `_instantiateModel` gained a
  `scale` branch (native×scale, base flush at y=0); `map.modelScale`/per-entry
  `modelScale` feed it; disguises worn at the same scale (burger-sized, not player-sized).
- **Fixed the actual bugs:** floor podium (native tile 0.5 thick → modelDims `8×0.06×8`,
  flush); ankle-height counters + dollhouse walls were multi-module KITS
  (`modular_kitchen_parts` = 12 modules across ~15u; `modular_walls` = panel variants)
  fit-to-target into one tiny blob → `counter` now uses `kitchen_cabinet.glb`,
  `kitchen_wall` is a primitive box. Chairs flipped +π to face inward (pass-2 note
  predicted the +z front). Food `y` re-derived from new surface tops.
- **Physics bounds** (primitive w/h/d — what `physics.shapeFor` bakes colliders from) set
  to native×0.75 for measured items. Loader/fallback/referee/protocol untouched;
  circus_lot/toy_workshop untouched (no modelScale key → legacy path).
- **Playtest owed:** pick restaurant → floor at ground level, full-height walls,
  hip-height counters/sinks, player-scale door/fridge, chairs facing tables, food ON
  surfaces. Verify the two kit GLBs no longer appear. circus/toy still load.

## Status: PHYSICS + MULTIPLAYER NETCODE — THE BIG PASS (2026-07-09, on `physics-net`). NOT playtested (can't be, headless).

The single-pass "yolo" build VRmike approved: Rapier physics + host-authoritative
netcode with full client-side prediction + reconciliation, all at once. Full detail
in `memory/notes/physics.md` + `netcode.md`. **Which architecture shipped: the
TARGET** (prediction + rewind/replay reconciliation for the local player), NOT the
interpolation-only fallback. Honest status below.

- **Rapier engine** (`shared/physics.js`, `PhysicsWorld` + `loadRapier`): WASM,
  lazy-loaded at match start (zero boot fetch — headless load check stays green).
  Cuboid/cyl/cone/ball colliders from the catalog primitive footprint (NOT convex
  hulls from the GLBs — deliberate: GLBs load async/can fail; documented).
- **Players** = kinematic capsule character bodies (run, JUMP, real collide-and-
  slide vs walls/fixtures — fixes the old clip-through-everything gap — shove
  dynamic props, never knocked over). **Fixtures/walls/ground** = static colliders.
  **Props** = dynamic rigid bodies that get shoved (the TELL vs kinematic disguises).
- **Host** runs the one authoritative world (`referee.integrate` → physics.step),
  broadcasts player transforms + AWAKE-only prop transforms at 15 Hz with per-player
  `ack` seq. **Guests + host** predict their own player in a local Rapier world and
  reconcile (rewind to authoritative + replay unacked inputs + ease/snap residual).
  Remote players + awake props interpolate.
- **Disguise orientation lock**: disguised prop keeps a fixed facing while moving;
  hold right-click (desktop) / ROTATE (touch) to yaw-rotate — never tips. This is
  the roadmap "locked orientation" + the fake-nudge precursor.
- **Jump**: Space / JUMP button. Input protocol gained `seq, jump, rotUnlock`;
  snapshot gained `y, ack` per player + `props[]`.
- **GRACEFUL DEGRADE**: if Rapier can't load, BOTH sides fall back to the old flat
  2D movement (no collision/jump/props) — playable, never a hard stop.
- **Regression-safe**: circus_lot/toy_workshop (no fixtures) build ground+walls+
  dynamic props only; solo play = host-only physics (no netcode); mid-game join adds
  a physics body; persistent lobby tears the world down on reset. Rules/referee phase
  machine unchanged. 2D fallback preserves exact prior behaviour.
- **UNTESTED — the load-bearing caveat**: the bot check is a headless LOAD test; it
  CANNOT feel-test physics/netcode. Prediction jitter, prop-shove rubber-band, jump
  smoothness, and the reconcile snap threshold all need a LIVE multiplayer playtest
  with real people + real pings. Expect a tuning pass. Files: `shared/physics.js`
  (new), `shared/referee.js`, `shared/protocol.js`, `js/main.js`, `js/scene.js`,
  `js/input.js`, `css/style.css`, `shared/config/rules.json`.

## Status: RESTAURANT MAP — SECOND PASS / LAYOUT FIX (2026-07-09, on `vrmike/dev`). Not yet playtested.

The `restaurant` map got a full layout rework on the SAME footprint (size 36 — density
by ADDING objects, never shrinking bounds). Full detail: `memory/notes/restaurant-map.md`
(top "SECOND PASS" section). Highlights:
- **Floor slab clipping FIXED** via a new non-uniform `modelDims:{w,h,d}` scale path in
  `js/scene.js _instantiateModel` — the floor was scaling uniformly to width 8, which
  inflated its thickness into a ~2-foot checkerboard slab. `floor_kitchen` now forces
  8×0.2×8 (flush, thin) regardless of the GLB's native proportions.
- **Prop `y` offset** added (referee `this.props` build → `STARTED` → scene props loop),
  mirroring the existing `rot` pass-through, so a disguisable food item can sit ON a
  table. Disguise range is x/z-only, so y is purely visual.
- **Kitchen/dining split** by a divider counter line at z=−4.5 (two walkways). Kitchen
  gear along the back + a prep row; dining = 6 round tables (chairs each rotated to face
  their table via `rot=atan2(dx,dz)`) + large/small tables. ~90 fixtures, ~56 props.
- **Food on surfaces** (fixtures with y), most decorative food is fixed (non-disguisable,
  zero bandwidth); only ~6 disguisable food props remain, on tables.
- **All pack assets now referenced** (menu, knife, planks, towels, jars, dinner, extra
  stoves/crates/dishes/raw+cut foods). New catalog entries in fixtures.json + props.json.
- **Pass-2 FINISH (this session):** every remaining catalog GLB that was defined-but-
  never-placed (~27) is now instanced as a decorative FIXTURE — side cook-line
  (stove_plain/stove_single), a modular_walls panel per kitchen side, all leftover
  prepped/raw food + whole produce on kitchen surfaces, and ketchup+mustard PAIRS on
  every dining table. Props-catalog keys (ketchup, mustard, pan, plate, whole veg)
  referenced from fixtures[] render via the merged catalog but never join the disguise
  pool (built from props[] only) — zero bandwidth, non-disguisable. DATA-ONLY append to
  the restaurant map object; no engine change; other two maps untouched. Req 3 (use ALL
  assets) now fully closed. Detail: `memory/notes/restaurant-map.md` (pass-2 finish).
- ONLY three tiny engine changes (`modelDims` non-uniform scale, prop `y` thread, dims
  pass-through); circus_lot/toy_workshop untouched (no `fixtures`/`modelDims`/prop-`y`
  keys → same code paths as before). ⚠️ Playtest note: if chairs face OUTWARD, chair
  GLB native front is +z not −z → add π to every chair `rot`. See restaurant-map.md.

## Status: RESTAURANT REAL GLB MESHES WIRED IN (first pass, 2026-07-09, on `vrmike/dev`). Superseded by the layout fix above.

The `restaurant` map now renders the real CC0 "Restaurant Bits" GLB meshes (Kay
Lousberg) instead of primitive boxes. An earlier bulk fetch had downloaded the GLBs
into `assets/restaurant/` but never hooked them into rendering (and left scratch
junk behind); this session did the wiring + cleanup handoff.

- **Map rebuilt from the real GLBs** (`shared/config/maps.json` → `restaurant`): a
  coherent small restaurant — tiled kitchen (floor_kitchen, fridge/oven/stove/
  extractor/counter/sink/cabinets/shelf along the back, counter islands +
  kitchen_table), a modular_walls + pillars divider with passages, a dining room
  (round/large/small tables), and a door. Static geometry → `fixtures[]`; small
  movable items → `props[]`.
- **Two catalogs now** (requirement 3, defense-in-depth): `props.json` is the
  disguise catalog (movable items ONLY) and the new `shared/config/fixtures.json`
  holds the static building pieces. Kept in separate files so a fixture can never
  enter the disguise pool. Each entry carries a `model:` path to the clean GLB name,
  keeping the primitive shape as fallback + size target. `config.js` loads both;
  `scene.js` merges them (`{...cfg.props, ...cfg.fixtures}`) purely for rendering.
  The referee still builds the pool from `map.props` only — it never reads either
  catalog.
- **Lazy client-side GLTFLoader** in `js/scene.js`: primitives render instantly at
  match start, then the referenced GLBs load (CDN import, deduped) and swap in over
  them; the primitive stays as an invisible camera collider. Missing/failed GLB →
  primitive stays visible (per-item fallback). Disguises wear the real mesh once
  cached. `index.html` importmap gained a `three/addons/` entry (declares only — no
  boot fetch). Referee untouched (still builds the pool from `map.props` only).
  Full detail: `memory/notes/restaurant-map.md`.
- **CLEANUP OWED — needs a shell (this sandbox has none).** The bulk fetch dumped
  junk that is inert but still on `main` and could NOT be deleted here (no shell /
  rm; Write is text-only; there is no file-delete tool). Nothing references any of
  it. Delete from a shell session:
  ```
  git rm -r _meshwork
  git rm bundle.html fetch_meshes.sh assets/restaurant/manifest.json
  # 18 hash-suffixed GLB duplicates (each has a clean twin that is KEPT). Do NOT use
  # a `*_??????????.glb` glob — it would also match the legit shelf_papertowel.glb
  # (`papertowel` is exactly 10 chars). Enumerate them:
  git rm assets/restaurant/tomato_EVTveOjwHG.glb \
         assets/restaurant/round_table_KZXCuGx1WZ.glb \
         assets/restaurant/round_table_oravj1kSy2.glb \
         assets/restaurant/door_MSIuI2jpqb.glb \
         assets/restaurant/pan_O5t9nVpPjd.glb \
         assets/restaurant/kitchen_cabinet_corner_Pieyzl60FA.glb \
         assets/restaurant/kitchen_cabinet_sS6Llv1TG5.glb \
         assets/restaurant/potato_acwBoZQNdm.glb \
         assets/restaurant/stove_cT99QUoCCn.glb \
         assets/restaurant/chair_eGccH9cqom.glb \
         assets/restaurant/kitchen_table_hM1OMnevjc.glb \
         assets/restaurant/kitchen_table_jrwQfpN0LV.glb \
         assets/restaurant/kitchen_table_ocdwmd2IKZ.glb \
         assets/restaurant/dishrack_phJwmk2B4X.glb \
         assets/restaurant/stew_rPa4vEsC9c.glb \
         assets/restaurant/shelf_papertowel_uJ60T0cGEG.glb \
         assets/restaurant/lettuce_yC6B73sG9s.glb \
         assets/restaurant/pot_of_stew_zXG0jZ4QiC.glb
  ```
  `assets/restaurant/manifest.json` and `_meshwork/fetch.log` are the fetch script's
  own artifacts (they list the dupes above) — removed by the lines above. NOTE:
  `kitchentable_sink_la.glb` has a 2-char suffix and is NOT a dup — KEEP it. The map
  references only clean names, so no config reference fix is needed. `fetch.log`
  confirms all 111 downloads succeeded (fail=0), so every clean GLB the map uses is
  a real, non-empty binary.

## Status: EARLIER restaurant map build (primitive stand-ins) — superseded by the GLB wiring above.

A third selectable map (`restaurant`) + the small engine seam for STEP 3's
static/dynamic split. Data-driven, so it's host-selectable through the existing
picker with no new wiring.

- **New `map.fixtures[]` seam** — maps can now carry immovable **fixtures**
  (walls, counters, stove, oven, fridge, cabinets, sinks, large/anchored tables)
  separately from **props** (the movable disguise pool: chairs, stools, crates,
  pots, pans, plates, bowls, cutting boards, food/burgers). Fixtures render +
  join `scene.colliders` client-side but the referee never treats them as
  disguisable (it still builds the pool from `map.props` only). ONE engine change:
  a `for (const f of map.fixtures || [])` loop in `js/scene.js buildWorld` — older
  maps (no `fixtures` key) are untouched. No protocol/referee change (every client
  has maps.json locally). Files: `shared/config/props.json` (restaurant shape
  catalog), `shared/config/maps.json` (`restaurant` map), `js/scene.js` (fixtures
  loop). Full detail: `memory/notes/restaurant-map.md`.
- **Honest mapping of "collision + static/dynamic":** this engine has NO
  rigid-body physics and NO player-vs-object collision (players pass through
  everything — documented gap). Its only collision primitive is the third-person
  camera's `scene.colliders` raycast; "give everything collision" = adding it to
  that set, which both fixtures and props now do. Real player collision would be a
  separate, bigger lockstep change (referee `integrate` + client prediction).
- **[HISTORICAL] GLBs were unfetchable in the two prior sessions** (no shell /
  network / binary-write in that sandbox), so the map shipped on primitive
  stand-ins and reported it honestly. That is now RESOLVED: a later bulk fetch put
  the real GLBs on disk, and the 2026-07-09 wiring session (top of file) hooked them
  into rendering. The prediction held — no client code assumptions changed; only the
  assets had been missing, plus the lazy-loader wiring the notes had pre-scoped.
- **Playtest owed:** pick `restaurant` in lobby → everyone spawns in it; enclosed
  kitchen+dining reads right; disguise into a chair/crate/burger; tag works;
  camera pulls in on fixtures; circus_lot + toy_workshop still load unchanged.

## Status: THIRD-PERSON CAMERA BUILT (earlier session, on `vrmike/dev`). Not yet playtested.

The local player is now **third-person by default** (was first-person). A camera
orbits behind + slightly above them off the existing yaw/pitch; they now see their
OWN model/prop (built via the same disguise/role path other peers are drawn with).
**Camera/view change only** — movement, roles, collision, networking, and the
referee are untouched.

- **Aim decision (the one gotcha):** the referee's tag cone / disguise still
  compute from yaw-forward — NOT touched. Since the third-person eye is off the
  player, the reticle is now driven off that yaw-forward vector
  (`scene.aimScreenPoint` → `ui.setCrosshair`), not screen center, so tag/disguise
  land where the reticle points. First-person recenters the reticle.
- **Collision-aware:** the engine already exposes `THREE.Raycaster` (so pass two
  was cheap). Walls + static props go into `scene.colliders`; a per-frame ray from
  the player pulls the camera in on a hit (min dist 1.2, 0.3 skin). Ground and
  avatars are excluded on purpose. Snap-in / ease-out (0.12) smoothing.
- **Own model:** `syncPlayers` no longer skips self — `_syncSelf` builds the local
  avatar via `meshForPlayer`; positioned each frame from the PREDICTED pos/yaw so
  it tracks the camera without snapshot lag.
- **First-person toggle kept** (it was clean): desktop **V** flips camera +
  own-model + reticle behind one `scene.setThirdPerson()` flag. No touch button.
- Files: `js/scene.js`, `js/main.js`, `js/input.js`, `js/ui.js`. No CSS/HTML/
  referee/protocol/net changes, no new deps. Full detail:
  `memory/notes/third-person-camera.md`. **Playtest owed** (orbit, wall pull-in,
  tag/disguise-under-reticle, V toggle; desktop + phone).

## Status: MULTIPLAYER + MOBILE UPDATE BUILT (earlier session, on `vrmike/dev`). Not yet playtested.

Four things landed together, all against the seams the notes already named:

1. **Solo launch.** `minPlayers` → 1 (`rules.json`). `startMatch` role math now
   keeps ≥1 prop (`hunterCount = min(max(1,round(n*hunterRatio)), n-1)`), so a lone
   host is a **prop** and can walk/disguise while testing a map; a zero-hunter
   round has no instant win and runs on the timer. `checkRoundOver` already only
   ends early when props existed and all died, so no change needed there.
2. **Mid-game join.** `Referee.addPlayer` is the single gate; during HIDING/HUNTING
   it routes to new `admitMidGame(player)`, which slots the newcomer in as a
   **hunter**, spawns them, and sends the SAME filtered catch-up every guest gets
   (`STARTED` + private `ROLE` + current phase/clock + normal snapshots) — never the
   host's full state. `net.js` already called `addPlayer` on every guest connect
   regardless of phase, so no network change was needed. Guest side is pure
   presentation (`STARTED` drops it into the running game).
3. **Persistent lobby.** Already returned ENDING→LOBBY keeping the map; this session
   confirmed nothing else resets (peers stay open, host stays host, list survives)
   and added `lastResult` (rides `S2C.LOBBY`) so the lobby shows the previous
   winner. `main.js` tidies per-round view state on return WITHOUT reconnecting.
4. **Phone / touch controls.** Whole layer in `js/input.js`: nipplejs joystick
   (lazy CDN), hand-rolled drag-to-look, on-screen action button, "Tap to play" +
   iOS audio unlock, portrait/landscape CSS, `touch-action:none`, `100dvh`, DPR cap
   (pre-existing), wake lock (+ phone-host warning), `webglcontextlost` guard. Only
   wired on touch devices — desktop WASD + mouse-look is UNCHANGED. Full detail:
   `memory/notes/touch-controls.md`.

Files touched: `shared/config/rules.json`, `shared/referee.js`, `shared/protocol.js`
(doc), `js/main.js`, `js/input.js`, `js/ui.js`, `js/scene.js`, `index.html`,
`css/style.css`. See `memory/notes/{game-loop,touch-controls,input-mouselook}.md`.

## Status: LOBBY MAP SELECTION BUILT (earlier session, on `vrmike/dev`).

The host can now pick the round's map from the lobby (two maps: `circus_lot` +
`toy_workshop`). One validation gate (`Referee.setMapId`), one new lobby message
(`C2S.PICK_MAP`), a data-driven picker UI, and the pick survives reset-to-lobby.
Full detail: `memory/notes/map-selection.md`. **Not yet playtested** (see the
map-selection checklist under Open threads).

**Why this was a "finish the broken build":** an earlier map-selection attempt
lived on branch **`jie/dev`** (commits "The lobby host should be able to see a list
of available maps to play" + "BUILD IT"). The active branch became `vrmike/dev`,
cut from a point *before* that work, so the partial build was stranded on `jie/dev`
and the working tree looked untouched ("someone broke it by renaming the channel"
= the branch switch). I could not reach `jie/dev`'s file contents (no shell; git
objects are compressed), so I reimplemented cleanly on `vrmike/dev` against the
seam the notes already named, per VRmike's approved plan. **If `jie/dev` is ever
pulled back, diff — do NOT blind-merge; this `vrmike/dev` version is intended.**

## Status: FIRST REAL P2P JOIN CONFIRMED. Earlier session: CDN deps made lazy so the headless load check is clean (no boot-time external fetches).

**2026-07 playtest update (VRmike):** the game launches and **two players joined a
lobby together** — first confirmation the PeerJS/WebRTC join path actually works
across the wire (partly closes gap [9]; a full round still unverified). One bug
found and fixed this session: the "Click to play" overlay never dismissed, so
mouse-look was dead (WASD still worked). See [I] below.

## Status: static-Pages deploy fix + PeerJS signaling done in code.

This session fixed the **broken Cloudflare Pages deploy**. Root cause: the P2P
rebuild left a Node matchmaker in `server/` and the game nested under `client/`.
Pages serves static files only (can't run the matchmaker) and serves from where
`index.html` sits, so the nested layout 404'd. Fix = flatten to the repo root +
retire the matchmaker in favour of PeerJS's public broker. Game rules/referee are
unchanged. **Not yet verified across real networks** — see the playtest gap [9].

### Done this session
- [A] **Flattened to the repo root.** `index.html`, `js/`, `css/` now sit at the
      root alongside `shared/` and `assets/`. All refs are root-absolute, so they
      survived the move. Pages: output dir = repo root, no build.
- [B] **Retired the Node matchmaker.** Signaling is now **PeerJS's free public
      broker**. No server of ours anywhere.
- [C] **Rewrote `js/net.js` onto PeerJS.** Host = `Peer('prophunt-<code>')`;
      guest = anonymous `Peer` + `peer.connect(..., {reliable:true,
      metadata:{name}})`. Reliable+ordered kept via `{reliable:true}`. ICE
      servers injected via the `Peer` `config` option (STUN + TURN preserved).
      Host bridges each guest `DataConnection` into the referee. Referee itself is
      transport-agnostic and was NOT touched.
- [D] **Join/leave now = PeerJS events** (`conn.on('close')`), replacing the old
      SIG host-left/peer-left messages. Deleted the `SIG` protocol and the dead
      `C2S.CREATE/JOIN` from `shared/protocol.js`.
- [E] **Direct/relayed lobby badge preserved** — detection now reads
      `conn.peerConnection.getStats()` (PeerJS exposes the RTCPeerConnection).
- [F] **Join-by-link**: `#CODE` in the URL auto-joins on boot; the lobby "Copy invite
      link" button AND the pause menu "Copy link" button both copy the full join link
      (`<origin><path>#CODE`). Format is single-sourced: `buildJoinLink(code)` +
      `parseRoomFromHash()` in `main.js` back all three sites (both builders + the boot
      parser `tryJoinFromHash`) so build/parse can't drift. See `wireMenu` / pause note.
- [G] `package.json` trimmed to a static project (dropped `ws` + node scripts).
      README + all memory notes updated.

### Follow-up session (check-repair)
- [H] **CDN imports moved to jsDelivr** to clear two `net::ERR_FAILED` from the
      automated headless-load check. three.js (`index.html` importmap) and PeerJS
      (`js/net.js`) were the only two boot-time external fetches; esm.sh's runtime
      transpile in particular can cold-start/redirect slowly enough to fail a
      headless load. Now `https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js`
      and `.../peerjs@1.5.4/+esm` — prebuilt ESM, no build step. Broker/TURN
      services unchanged (this was the *library* download only).

### Follow-up session (check-repair — lazy CDN loading)
- [J] **Killed two boot-time `net::ERR_FAILED`s for good by lazy-loading the CDN
      deps.** The headless load check kept flagging the same two external fetches
      (three.js + PeerJS) even after [H] swapped esm.sh → jsDelivr. Root cause: the
      check runs with **no outbound network**, so *any* fetch during page-load
      fails — the CDN *provider* was never the problem, doing the fetch at boot
      was. Fix (small, in-lane):
      - `js/net.js`: removed the top-level `import { Peer }`. New `loadPeer()`
        dynamic-imports PeerJS once on the first `create()`/`join()`; `_startHost`/
        `_startGuest` are now `async` and `await` it (graceful onStatus error if the
        CDN is down).
      - `js/main.js`: removed the top-level `import { Scene3D }`. `scene` starts
        `null`; `ensureScene()` dynamic-imports `scene.js` (which pulls Three.js)
        on the first `STARTED`. All `scene.*` calls are guarded (`if (scene)`), and
        `setSelf` is re-applied when the scene finally builds.
      Result: a bare landing page makes **zero** external requests → the headless
      load is clean. Gameplay still pulls both libs from jsDelivr on demand (CDN
      import, no build step — constraint intact). `index.html` importmap unchanged
      (it declares, doesn't fetch). Details in `memory/notes/netcode.md`.

### Earlier session (mouse-capture fix)
- [I] **Fixed the stuck "Click to play" overlay** (pointer-lock never engaged).
      Root cause: `#clickToPlay` (`.overlay`, `position:absolute; inset:0`, no
      `pointer-events:none`) is painted **over** the canvas and swallowed the
      click, so `canvas`'s `click`→`requestPointerLock()` never fired; the overlay
      then stayed up forever (per-frame poll `!input.locked`). WASD worked because
      keys listen on `window`. Fix, keeping modules in lane:
      - `js/input.js` now takes a second arg `lockTrigger` (the overlay element)
        and requests capture on **its** click, not just the canvas's. It also
        listens for `pointerlockchange`/`pointerlockerror` and broadcasts
        `onLockChange(locked)` / `onLockError(reason)`.
      - `js/main.js` passes `ui.el.clickToPlay` as the trigger, wires the two
        callbacks to `ui.setClickToPlay(...)`, shows the overlay on match start,
        and **removed the per-frame poll**. Overlay now hides only when the browser
        *confirms* lock and reappears on release (Esc/alt-tab) — re-clickable.
      - `js/ui.js` `setClickToPlay(visible, msg?)` can show a refusal message; a
        `pointerlockerror` surfaces "browser blocked mouse capture…" instead of
        silence.
      - CSS: `.overlay` got `text-align/padding/line-height` so a long refusal
        message wraps cleanly.
      Details in `memory/notes/input-mouselook.md`. **Still needs a real 2-player
      re-test**: click through overlay → mouse-look works → Esc → overlay returns →
      re-click re-captures, as both host and guest.

## Open threads / not done — READ BEFORE BUILDING ON THIS

- [TOMBSTONES — physically delete when a shell is available.] I could **not**
      run mutating git/shell commands this session (the Monitor shell tool's
      permission stream failed on every write; read-only commands worked). So the
      flatten was done by **writing the canonical files at the root** and reducing
      the old `client/` and `server/` files to one-line **tombstone stubs**. They
      are dead (nothing loads them — the app is served from the root), but they
      should be removed for real:
      ```
      git rm -r client server
      ```
      Do this first thing next session if you have a shell. Everything canonical
      is at the root; `client/` and `server/` contain only stubs.
- [9] **NEVER PLAYTESTED — still the load-bearing gap, now bigger.** Two things
      are unverified across real networks: (a) the original P2P assumption that
      connections form across home NATs, and (b) the NEW PeerJS wiring. **Do this
      next:** deploy to Pages, open on two computers on *different* networks,
      create a room, **join via the invite link**, play a full round (hide →
      hunt → win screen → back to lobby), and check the direct/relayed badge.
      Include a strict-NAT setup if possible — with TURN configured that player
      should succeed via relay (badge reads `relayed`). Two tabs on one machine is
      NOT a valid test (loopback).
- [PeerJS/TURN are shared free services.] The broker (PeerJS cloud) and TURN
      (OpenRelay) are community services with modest quotas. Fine for 2–8 friends;
      if joining hiccups, suspect a service before the code. For a dedicated TURN
      quota, swap the three `turn:` entries in `js/net.js` for your own
      Metered/OpenRelay creds. The relay password ships in client code
      (unavoidable, backend-less) — only risk is quota drain.
- **Phones now IN scope (this session).** Full touch controls added (joystick +
      drag-to-look + tap buttons + "Tap to play", portrait & landscape). Desktop
      WASD + mouse-look untouched. **Playtest owed** (see the mobile checklist in
      the new-work status above and open thread below). Details in
      `memory/notes/touch-controls.md`.
- **PLAYTEST OWED for this session's work.** Do a desktop + phone pass: (a) start
      SOLO on desktop, walk/disguise alone; (b) phone joins MID-ROUND via the invite
      link → confirm it drops into the running game as a hunter and sees only what
      other guests see (never undisguised props); (c) play with touch in BOTH
      portrait and landscape (joystick moves, drag looks, action button
      tags/disguises, "Tap to play" dismisses, no pinch-zoom); (d) finish the round
      and start ANOTHER from the persistent lobby with nobody reconnecting (host
      stays host, map stays picked, last winner shown). Two tabs on one machine is
      still not a valid P2P test.
- **Anti-cheat given up.** The host holds full unfiltered state (can see
      undisguised props / tamper). Accepted cost of host authority; no neutral
      referee. See architecture.md.
- **Undisguised props are visible** (render as neutral capsules and move). Fine
      for skeleton; future: auto-disguise at hunt start, or hide undisguised props.
- ~~No client-side prediction of collisions; players can overlap props/walls.~~
  RESOLVED by the physics pass (`physics-net`): players now collide-and-slide vs
  walls/fixtures/props via a local Rapier prediction world, reconciled to the host.
  (Prediction of DYNAMIC prop motion is host-authoritative only — guests treat props
  as fixed obstacles and reconcile; a guest shoving a prop can rubber-band slightly.)
- `ready` flag exists in lobby but host can start regardless — intentional.
- **Map selection: BUILT this session** (host picks from the lobby; `circus_lot`
  + `toy_workshop`). Adding more maps stays data-only. **Playtest still owed:**
  host picks a non-default map → everyone spawns in it; a late lobby joiner sees
  the current selection; a non-host's pick attempt is ignored; disguise + tag work
  on the second map; after a reset-to-lobby the pick survives. See
  `memory/notes/map-selection.md`.
- **Reconnection/host migration**: none. If the host drops, the match is over.

## Key decisions

- **Static site + PeerJS public broker** (this session) — the way to keep P2P
      WebRTC with no server of ours, deployable to Cloudflare Pages. Trade-off:
      depends on shared free services (broker + TURN). See architecture.md.
- **P2P WebRTC, host-authoritative** — REVERSED the earlier server-authoritative
      / "do not move authority to clients" directive, on Manny's instruction. Full
      rationale + trade-offs in architecture.md. A future session may revisit.
- Movement math is duplicated (referee + client prediction) **on purpose** and
      must stay identical — see architecture.md.
- Roles hidden via snapshot shape (`hunter`/`disguise` only) — but the host tab
      still holds everything (see anti-cheat note).
- Theme: colorful circus (art in `assets/`, used on the menu screen).

## Where things live

Entry/served root: `index.html` + `js/` + `css/` (flattened). Referee (host
browser): `shared/referee.js`. Protocol: `shared/protocol.js` (C2S/S2C only now).
Network layer (PeerJS): `js/net.js`. Client entry: `js/main.js`. Input (all
schemes, incl. touch): `js/input.js`. Rendering + **third-person camera**:
`js/scene.js`. **Level editor (desktop debug tool)**: `js/editor.js` (toggled by
Ctrl+E; a client-local sandbox that never touches the referee/netcode). Tunables:
`shared/config/rules.json`. Notes: `memory/notes/` (netcode, game-loop,
input-mouselook, map-selection, touch-controls, third-person-camera, level-editor). Dead code awaiting `git rm`: `client/`, `server/`.

- The agent loop went live 2026-07-07 (per VRmike). (noted 2026-07-07 by VRmike)

- prop-hunt physics WIP — LATER/suggestion (not v1): "fake nudge" for disguised players. When a hunter shoves a disguised player, play a scripted cosmetic reaction so it mimics a real dynamic prop and preserves the disguise (instead of a hard 100% tell). CONSTRAINT (VRmike): the fake nudge may ONLY translate and rotate on the vertical (yaw) axis — it must NEVER tip over (no pitch/roll). Players stay kinematic and un-knockable; this is purely a visual mimic. The genuine tell then becomes subtle (real dynamic props tumble/settle differently) rather than binary. To be written into the game repo's WIP notes when the physics build runs. (noted 2026-07-09 by VRmike)

- prop-hunt PHYSICS + MULTIPLAYER architecture — DECIDED with VRmike, for the big single-pass "yolo" build (do it all at once; roll back if it fails):
- ENGINE: Rapier (rapier3d, WASM). Lazy-load at match start like three.js/PeerJS — ZERO boot-time network fetch (headless load check must stay clean).
- COLLIDERS: static fixtures (walls/floor/counters/stove/oven/fridge/cabinets/sinks/large tables) = fixed colliders (box/trimesh). Dynamic props (chairs/stools/crates/pots/pans/plates/bowls/cutting boards/food) = dynamic rigid bodies with per-mesh CONVEX HULL colliders (convex decomposition only if a hull isn't enough). Reuse the existing map.fixtures[] vs map.props[] split already in the engine.
- PLAYERS: KINEMATIC character bodies via Rapier KinematicCharacterController. Have colliders; run + jump (manual gravity/vertical velocity); collide-and-slide vs walls/fixtures (FIXES the current pass-through-everything gap); shove dynamic props (applyImpulsesToDynamicBodies); but CANNOT be knocked/tipped over.
- NETWORKING: host-authoritative. TARGET for the yolo build = full client-side PREDICTION + server RECONCILIATION — every client runs a local Rapier sim for instant response; host streams authoritative transforms; clients blend/reconcile toward host (smooth, no hard pops). FALLBACK if that's too much in one pass: host-only sim + guest interpolation (guests don't sim, just interpolate received transforms).
- BANDWIDTH: only sync AWAKE bodies (Rapier sleeping = ~0 traffic when still); quantize transforms (~16 bytes); traffic is bursty. Rapier is NOT a networked engine — all netcode is hand-written.
- DETERMINISM: Rapier deterministic only given identical inputs/order/build; cross-browser drift is expected → reconciliation corrects it. Don't rely on determinism alone to stay synced.
- TELL MECHANIC: real props are physics-driven (get shoved), disguised players are kinematic (don't) = the tell. Fake-nudge softener already noted (later; yaw+translate only, never tip).
- CONSTRAINTS: static site, no build step, P2P WebRTC via PeerJS broker, referee stays authoritative & transport-agnostic, flat repo-root layout, lazy CDN. Build on vrmike/dev.
- VERIFICATION CAVEAT: bot auto-check is a headless LOAD test only — it CANNOT feel-test physics/netcode. This build needs a live multiplayer playtest as real QA. (noted 2026-07-09 by VRmike)

- prop-hunt FEATURE ROADMAP (VRmike's high-level todo list) lives in the prop-hunt repo at memory/notes/roadmap.md — NOT kept in main context. LOAD it (read the repo / read_project_state) whenever discussing prop-hunt plans, and be ready to post it on request and edit it. Written 2026-07-09. (noted 2026-07-09 by VRmike)

- - TODO (2026-07-13, VRmike): Post-game hiding-spot reveal. After a round, hunters AND everyone can see where each prop player was hiding: a giant flashing 3D arrow pointing straight down over each spot, plus a flashing ghost copy of the prop they were disguised as, spawned at their exact final position, NO collision, scaled to ~110% so it's still visible overlapping the real prop. Everyone becomes immortal and free to run around exploring all the hiding spots. PREREQUISITE — build spectate mode FIRST: dead players can either fly around freecam OR switch to follow living players in 3rd person, swapping between targets at will. Spectate mode is the foundation; the reveal feature comes after it. (noted 2026-07-13 by VRmike)

- - TODO amendment (2026-07-13, VRmike) to the post-game hiding-spot reveal above: the reveal is TWO phases. Phase 1 — WHILE DEAD (spectating/free-cam, mid-round): a dead player sees the down-arrow + flashing ghost prop over EVERY currently-hiding prop player, live, so they can watch where survivors are hiding. Phase 2 — AT GAME END: that same reveal becomes visible to EVERYONE, and each ghost prop FREEZES in place at the player's final position (110% scale, no collision) as described earlier. So it's a live per-dead-player reveal during the round that promotes to an all-players frozen reveal when the round ends. (noted 2026-07-13 by VRmike)

- PLAYTEST TODO (VRmike, 2026-07-18, #devbot) — grouped into builds, not yet launched:
- B1 PC feel/controls: mouse-sensitivity slider in pause menu (persist via localStorage), run speed +50%, always-visible PC controls list panel (mobile exempt, buttons visible).
- B2 Combat SFX: gun shot + grenade blast + prop-finder activation sounds; shot props play an "ouch" — ONE sound, pitch-shifted by prop size (high=tiny, low=big).
- B3 Balance knobs (small): grenade radii −40% (both fullDamageRadius + falloffDistance, it's OP), prop-finder radius wider, dead-player vignette ~10%→~30% opacity.
- B4 Lifecycle bugs: players who leave persist as uncontrolled GHOSTS until new lobby — remove on disconnect; hunters spawn clipped together and stick — stagger spawn points (without clipping into objects).
- B5 Sync bugs (serious): a player saw themselves as HUNTER while actually a PROP (hunter could kill them) — role desync; game timers differ ~4s between players — client should compute local endsAt from snapshots and tick locally.
- B6 Spectator: fly cam + switch-between-players (may partially exist — controls unknown/undocumented); document spectator controls.
- B7 Hunter tool visibility: other players currently only see the gun on the hunter model — show grenade + prop finder when selected.
- ASSETS (hunt, not build): find a prop-finder model; find a real CC0 asset pack for a CIRCUS level (ideally incl. bathroom pieces) then remake that map with it. (noted 2026-07-18 by VRmike)

- PLAYTEST TODO UPDATE (2026-07-18): B1–B7 ALL LAUNCHED/QUEUED as builds (B1 sync bugs building; B2 lifecycle +embedded-hunter-spawn check added; B3 balance — finder range set to +70% (8→13.6) per VRmike, nade radii −40%, vignette 30%; B4 PC feel; B5 combat SFX; B6 spectator; B7 tool visibility). Jie's 2026-07-18 audio quartet (limiter 465666e, inverse-square 33166c8, HRTF 15ea82f, solid disguised props faf3d6b) all landed on main. STILL TODO (later, asset hunts, NOT launched): prop-finder model; CC0 circus asset pack (ideally with bathroom pieces) → remake circus map. (noted 2026-07-18 by VRmike)
