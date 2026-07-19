# Diagnosis: frequent client disconnect regression (report only — NO fix in this build)

**Requested by:** VRmike, #devbot 2026-07-19. **Scope:** diagnosis only. This build changes NO
game code — it adds this note and nothing else. The fix is to be discussed in-channel first.

## Symptom
In local 2-browser-window testing, a client gets booted to the lobby with **"Lost connection to
host."** every round or two. It used to NEVER disconnect. The regression appeared in the last ~day.

## TL;DR — root cause
Two **new** 5-second silence timers landed yesterday, and both now act on the normal timing gaps of
a **backgrounded browser tab** — which in 2-window local testing is *always* present (only one window
can be foreground). Before these commits, the same gaps occurred but nothing acted on them, so nobody
ever got kicked.

- **`js/host-watchdog.js` + `js/main.js` (commit `657847e`, TODAY)** — the guest's client-side
  snapshot-staleness **watchdog**. If the guest receives no host snapshot for `hostSilenceMs()` = **5 s**
  it declares the host dead and boots to the lobby with *"Lost connection to host."* → **this is the
  exact symptom.**
- **`shared/referee.js` `_sweepSilentPlayers` (commit `be19b5b`, yesterday)** — the host-side
  **silent-player sweep**. If the host receives no C2S traffic from a guest for `leaveTimeoutSeconds`
  = **5 s**, it removes that guest from the round as a "timed out" leaver.

Both thresholds are the **same 5 s** (`rules.leaveTimeoutSeconds`; the watchdog derives from it via
`hostSilenceMs() = max(3000, leaveTimeoutSeconds*1000)`). 5 s is too tight for a backgrounded tab.

## Which mechanism boots the client? (untangling the two suspects)
They are **symmetric but produce different symptoms**, and which one you hit depends on *which window
you are looking at*:

| You are looking at | The other (backgrounded) window is | Its throttled timer that stalls | Who acts | Observed result |
|---|---|---|---|---|
| the **GUEST** window | the **HOST** | host's snapshot broadcast (setInterval) slows/stalls | **guest watchdog** trips | **"Lost connection to host." → booted to lobby** ✅ matches the report |
| the **HOST** window | the **GUEST** | guest's INPUT send (setInterval) slows/stalls | **host sweep** removes the guest | guest silently dropped from the roster → becomes a ghost/spectator (a *different* symptom) |

**The reported symptom ("Lost connection to host") is specifically the guest watchdog (`657847e`)
firing because the backgrounded HOST tab stopped sending snapshots for >5 s.** The host sweep
(`be19b5b`) is a real second culprit but its failure mode is "guest quietly vanishes from the round,"
not the lobby-boot message — so it's a compounding bug, not the one in the ticket text.

Note the guest watchdog is already visibility-aware for the guest's *own* tab: `frameBody` gates
`poll()` on `document.visibilityState === 'visible'`, and `visibilitychange → resume()` re-seeds a
grace window. That correctly prevents the guest from kicking itself while *it* is backgrounded. What
it **cannot** see is the *remote* host being merely backgrounded vs. genuinely dead — from the guest's
side both look identical (no snapshots), so a throttled-but-alive host is indistinguishable from a
dead one. That's the core design gap. The host sweep has **no** visibility/grace logic at all.

## Why these are `setInterval` timers (this is what gets throttled)
- Host snapshots: `shared/referee.js:125` `setInterval(() => this.tick(), 1000/tickRate)`; `tick()`
  broadcasts at `snapshotRate` (`referee.js:1417`). Purely `setInterval` — not rAF.
- Guest input: `js/main.js:1750` `setInterval(..., 1000/20)` → C2S.INPUT at 20 Hz, which stamps
  `player._lastSeen` on the host (`referee.js:322`).

Backgrounded browser tabs throttle `setInterval`/`setTimeout`; `requestAnimationFrame` is paused
entirely. Both suspect timers are `setInterval`, so both keep firing when backgrounded — but slowly
and jitterily.

## Realistic backgrounded-tab timing (the numbers the 5 s is up against)
From Chrome's documented timer policy (sources below), for a **hidden** tab holding an **active
WebRTC connection** (exactly our PeerJS data connection):

- **Standard background throttle:** `setInterval` is clamped to run **at most once per ~1000 ms**.
  This clamp applies **even with WebRTC in use**. So a backgrounded host's snapshot stream drops from
  ~15 Hz to ~**1 Hz**, and a backgrounded guest's input stream from 20 Hz to ~1 Hz.
- **Intensive throttling (once per 60 s):** kicks in after a tab is hidden >5 min AND silent AND
  **WebRTC is *not* in use**. Because our game holds a live WebRTC data channel, we are **exempt**
  from this tier — good, but it also means the tab is *not* frozen, just running at ~1 Hz.
- **Jitter is the killer.** The 1 Hz clamp is a *floor*, not a ceiling: a throttled, deprioritized
  callback can be *delayed* far past 1 s when the machine is busy. In local 2-window testing the
  single machine runs **two** heavy Three.js + Rapier(WASM) + WebRTC tabs at once; the backgrounded
  one is CPU-starved and its ~1 s timer routinely slips to multi-second stalls (GC pauses, long
  physics frames, OS deprioritization of a background window). **A single such stall exceeding 5 s
  ends the round.**

So realistic gaps are ~1 s *most* of the time (survives) with occasional multi-second spikes; one
spike >5 s boots. That probabilistic "usually fine, occasionally >5 s" profile is exactly why it's
"every round or two" rather than "every round" or "never."

## Headless simulation results
Ran a throwaway sim (`tools/_disconnect_sim.mjs`, since deleted — not shipped) importing the real
`HostWatchdog` and modelling the host sweep with the exact `_sweepSilentPlayers` formula
(`now - _lastSeen > leaveTimeoutMs`). Config: snapshotRate 15 Hz, input 20 Hz, leaveTimeoutSeconds 5.

Steady snapshot/input gap vs. which timer fires:

| gap between snapshots/inputs | guest watchdog | host sweep |
|---|---|---|
| 1 s (basic background throttle) | survives | survives |
| 2 s / 3 s / 4 s | survives | survives |
| 5 s (exactly) | survives (needs to *exceed* 5 s) | survives |
| **6 s** | **boots @ 5.0 s** | **removes @ 5.0 s** |
| 8 s / 60 s | boots @ 5.0 s | removes @ 5.0 s |

Single-spike test — an otherwise-healthy ~1 s throttled stream with one long stall:

| spike length | result |
|---|---|
| 3.0 s | survives |
| 5.0 s | survives |
| **5.5 s** | **BOOTED 5.0 s into the stall** |
| 7.0 s / 12.0 s | BOOTED 5.0 s into the stall |

**Conclusion:** the boot needs a *single* snapshot/input gap **> 5 s**. Basic 1 Hz throttling alone
never trips it; a jitter spike past 5 s does. Both timers trip at the same 5.0 s, so whichever tab is
backgrounded decides which mechanism you observe.

## Confirmed genuinely new (why "it never used to disconnect")
- Before `be19b5b` (Jul 18): no `_sweepSilentPlayers` — the host never removed a silent guest.
- Before `657847e` (Jul 19, today): no client watchdog — a guest with a stalled host kept rendering
  the last snapshot forever (the "ghost session" bug 657847e set out to fix), but was **never booted**.

The same backgrounded-tab gaps have always existed in 2-window testing; before these commits nothing
watched for them, so they were harmless. The fixes added two watchers with a threshold (5 s) that a
throttled tab routinely crosses. **The disconnect regression is the direct, expected side effect of
those two watchers being tuned too tight for the backgrounded-tab case.**

## Fix options (for the channel — NOT implemented here)
1. **Simply lengthen the timeout(s).** Bump `rules.leaveTimeoutSeconds` from 5 → ~15–20 s (one config
   value; the guest watchdog auto-derives from it via `hostSilenceMs()`, so both timers widen together).
   - *Pro:* one-line, lowest-risk, immediately buys a big margin over realistic 1 Hz+jitter gaps.
   - *Con:* doesn't *fix* the mismatch, only widens it — a genuinely dead host / ghost player now
     lingers ~15–20 s before cleanup (weakening exactly what `657847e`/`be19b5b` set out to do). A
     very long freeze still boots. **Recommended as the immediate mitigation.**
2. **Visibility-aware / keepalive heartbeat that survives throttling.** Since WebRTC keeps the tab at
   ~1 Hz (never frozen), a *dedicated* lightweight "still here" ping (~1/s, cheaper than a full
   snapshot so it's less likely to be starved) lets a throttled-but-alive peer stay connected while a
   truly dead one still goes silent. Pairs well with a modestly larger timeout.
   - *Pro:* durable — distinguishes "throttled" from "dead" far better than a raw snapshot gap.
   - *Con:* more code on both host and guest; new C2S/S2C message; must be tested against throttling.
3. **Host-side grace before sweeping (symmetry with the guest watchdog).** Give `_sweepSilentPlayers`
   the same courtesy the guest watchdog already has — e.g. a grace window, and/or a bigger timeout for
   the sweep specifically — so a briefly-throttled guest isn't yanked from the roster.
   - *Pro:* directly addresses the second (host-sweep) culprit, which today has zero grace logic.
   - *Con:* only fixes the host→guest direction; the guest→host watchdog still needs option 1 or 2.

**Recommendation (decide in-channel):** ship **option 1** (bump `leaveTimeoutSeconds` to ~15–20 s) as
the immediate, low-risk stopgap, then pursue **option 2** (keepalive heartbeat) as the durable fix and
fold **option 3**'s grace into the host sweep for symmetry. Do **not** drop the watchdog/sweep — they
fixed real bugs (frozen ghost sessions, lingering ghost players); the regression is purely a tuning +
throttle-awareness problem, not a reason to revert.

## Key references
- `js/host-watchdog.js` — the pure watchdog (arm/feed/resume/poll, 5 s default).
- `js/main.js` — `hostSilenceMs()` (~L60), arm on STARTED (~L910, guest-only), `feed` in `onSnapshot`
  (~L1084), visibility-gated `poll` in `frameBody` (~L1614), `resume` on visibilitychange (~L505).
- `shared/referee.js` — `_leaveTimeoutMs` (~L114), `_sweepSilentPlayers` (~L250), `_lastSeen` stamp in
  `handleMessage` (~L319), snapshot broadcast in `tick` (~L1417).
- `shared/config/rules.json` — `leaveTimeoutSeconds: 5`, `snapshotRate: 15`, `tickRate: 30`.

Sources (browser throttling): [Heavy throttling of chained JS timers (Chrome 88)](https://developer.chrome.com/blog/timer-throttling-in-chrome-88),
[Background tabs in Chrome 57](https://developer.chrome.com/blog/background_tabs).
