// Client HUD countdown ticker (PURE — no DOM, no CDN, no imports), so it runs
// identically in the browser and in the headless check (tools/check-sync-convergence.mjs).
//
// THE BUG IT FIXES (GAME TIMER DESYNC, VRmike 2026-07-18). The HUD used to render each
// snapshot's `timeLeft` DIRECTLY, so the countdown only changed when a network snapshot
// arrived (snapshotRate = 15 Hz). A snapshot stall then FROZE the display — Jie saw "5s
// left" while the host had already hit 0 and ended the round (~4 s of drift, reported twice).
//
// THE FIX. On every snapshot AND every phase event the client re-anchors an `endsAt`
// against its OWN clock (anchor: nowMs + timeLeft) and TICKS the countdown locally each
// frame (remaining), re-syncing on the next anchor. So the display can never freeze and can
// never drift more than one snapshot interval (~66 ms), regardless of network hiccups.
//
// ROUND END STAYS HOST-AUTHORITATIVE. The ticker is DISPLAY-ONLY: it clamps at 0 (never
// negative, never past the phase) and waits for the host's phase / roundOver events. No
// client ever ends a round on its own clock — the local tick only decides what NUMBER shows.
export class HudTimer {
  constructor() {
    this.endsAt = 0;   // local-clock ms at which the current phase's countdown reaches 0
    this.active = false;
  }

  // Re-anchor from an authoritative time-remaining (seconds) at local time nowMs (ms).
  // Ignores a non-finite value so a malformed snapshot can't blank the clock.
  anchor(timeLeft, nowMs) {
    if (!Number.isFinite(timeLeft)) return;
    this.endsAt = nowMs + Math.max(0, timeLeft) * 1000;
    this.active = true;
  }

  // Stop ticking (leaving a match / back to the lobby) so a stale anchor can't paint a HUD.
  stop() {
    this.active = false;
    this.endsAt = 0;
  }

  // Seconds to DISPLAY at local time nowMs, clamped at 0 — the local tick between snapshots.
  // Clamps at 0 (never negative) because the round's actual end is host-authoritative; the
  // display just waits at 0:00 for the host's end event.
  remaining(nowMs) {
    if (!this.active) return 0;
    return Math.max(0, (this.endsAt - nowMs) / 1000);
  }
}

// Format seconds as m:ss, clamped at 0:00. `ceil` so a partial second still reads as the
// higher number (0.4 s left shows 0:01) and only true 0 shows 0:00 — matches the prior HUD.
export function formatClock(seconds) {
  const t = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
