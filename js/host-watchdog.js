// Client host-connection watchdog (PURE — no DOM, no CDN, no imports), so it runs
// identically in the browser and in the headless check (tools/check-host-disconnect.mjs).
//
// THE BUG IT FIXES (HOST-DISCONNECT / STALE-SESSION GHOST, VRmike 2026-07-19). A guest whose
// host dies SILENTLY — the host tab is suspended, a phone locks, WebRTC stalls with NO 'close'
// or 'error' event — simply stops receiving the host's snapshot stream. Nothing tells the guest
// the link is gone, so the client keeps drawing the LAST snapshot forever. Every symptom of the
// reported ghost session flows from that one stall:
//   - the HUD countdown ticks its last anchor down to 0:00 and clamps there (frozen timer),
//   - remote players (the uncontrolled hunter) are pure interpolation toward the last snapshot,
//     so they stand as a collision-less statue — only the host simulates their physics,
//   - disguise/interact inputs post into a dead pipe and do nothing.
// PeerJS's 'close'/'error' events cover a LOUD disconnect; they never fire for a silent stall.
// This watchdog is the heartbeat check that catches the silent case.
//
// THE RULE (CONNECTION LIVENESS, 2026-07-19, VRmike). The watchdog is fed by ANY proof the host is
// alive: the snapshot stream (rules.snapshotRate 15 Hz ≈ one every ~66 ms) during an active round,
// AND the dedicated ~1Hz host→guest keepalive ping (net.js → main.js session.onKeepalive → feed())
// which keeps flowing even in the gaps where snapshots don't — a between-round seam or a briefly-
// throttled host. So only if NEITHER a snapshot NOR a keepalive arrives for the whole timeout has the
// host genuinely dropped. The timeout is derived (main.js hostSilenceMs()) from rules.leaveTimeoutSeconds
// (15 s) — the SAME "connection genuinely dead" threshold the HOST uses to sweep silent guests (referee
// _sweepSilentPlayers). 15 s tolerates the multi-second jitter of a backgrounded WebRTC tab so an
// AFK-but-connected peer is never false-booted; see notes/disconnect-diagnosis.md. One shared threshold,
// both directions.
//
// This module owns ONLY the timing + fire-once latch (mirrors HudTimer's split). main.js decides
// WHEN to arm/disarm (a GUEST that is in a match — never the host, whose loopback always feeds and
// who is a valid solo game) and gates the poll on tab visibility (a backgrounded tab throttles the
// frame loop, so the gap is our fault, not the host's — see resume()).
export class HostWatchdog {
  // timeoutMs: how long of snapshot silence declares the host dead. Overridable per-arm so the
  // value can be pinned to config (rules.leaveTimeoutSeconds) once it's loaded.
  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
    this.lastSnapshotAt = 0; // local-clock ms of the most recent host snapshot (or grace reset)
    this.armed = false;      // true only while actively watching (guest, in a live match)
    this.tripped = false;    // latched once we've declared the host dead (fire the boot ONCE)
  }

  // Begin watching from a clean slate — call at match start on a GUEST. `nowMs` seeds the clock so
  // the first snapshot gets a full timeout interval to arrive.
  arm(nowMs, timeoutMs) {
    if (Number.isFinite(timeoutMs)) this.timeoutMs = timeoutMs;
    this.armed = true;
    this.tripped = false;
    this.lastSnapshotAt = nowMs;
  }

  // Stop watching — leaving the match (menu / between-rounds lobby) or becoming host.
  disarm() {
    this.armed = false;
    this.tripped = false;
    this.lastSnapshotAt = 0;
  }

  // A host snapshot arrived — the link is alive; reset the silence clock.
  feed(nowMs) {
    if (this.armed) this.lastSnapshotAt = nowMs;
  }

  // Our OWN tab just returned to the foreground. The frame loop (rAF) is throttled/paused while
  // hidden, so a large gap here is the local tab's fault, not the host's — grant a fresh grace
  // period instead of instantly tripping. A host that is truly dead simply won't send the next
  // snapshot and trips one timeout later.
  resume(nowMs) {
    if (this.armed) this.lastSnapshotAt = nowMs;
  }

  // Milliseconds since the last snapshot (0 when not armed) — for diagnostics/tests.
  silenceFor(nowMs) {
    if (!this.armed) return 0;
    return Math.max(0, nowMs - this.lastSnapshotAt);
  }

  // Decide whether to declare the host dead. Returns true at most ONCE (latched via `tripped`) so
  // the caller boots to the lobby exactly one time; false unless armed. Poll it from the frame
  // loop while the tab is visible.
  poll(nowMs) {
    if (!this.armed || this.tripped) return false;
    if (nowMs - this.lastSnapshotAt > this.timeoutMs) {
      this.tripped = true;
      return true;
    }
    return false;
  }
}
