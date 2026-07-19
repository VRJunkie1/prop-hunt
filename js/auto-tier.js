// js/auto-tier.js — runtime auto-tier controller (LIGHTING OVERHAUL, 2026-07-19, spec items 3+4).
//
// The device heuristic (js/lighting-tiers.js guessTierFromDevice) makes the FIRST guess; this
// controller refines it at runtime with an FPS probe, and only ever steps the lighting tier DOWN,
// once, when the evidence says the frame is GPU-bound:
//
//   warmup  — collect ~10s of FPS/CPU/GPU readings (perfmon).
//   decide  — if not lagging (fps >= target): DONE, device is fine.
//             else classify CPU vs GPU bound:
//               • clearly CPU-bound  → mark session CPU-bound, DONE (dropping lighting won't help).
//               • clearly GPU-bound  → step down + settle.
//               • ambiguous          → run a render-scale probe (drop scale ~30%, ~2s): if FPS
//                                       jumps meaningfully it was GPU-bound → step down; else CPU.
//   settle  — after a step, wait a few seconds and re-measure: if FPS improved meaningfully, KEEP
//             the step and SAVE it to localStorage; if not, REVERT the step, mark CPU-bound, DONE.
//
// It's a ONE-WAY ratchet with a cooldown: after it finishes (kept or reverted) it disables itself,
// so it never yo-yos. A MANUAL pause-menu pick calls disable() and permanently wins.
//
// PURE + injectable: no THREE / DOM. All effects go through the injected ctx callbacks, and the
// clock + perf snapshot are passed into tick(), so tools/check-lighting.mjs drives the whole state
// machine headlessly with synthetic readings. See memory/notes/lighting.md.

export const AUTO_TIER_DEFAULTS = {
  targetFps: 45,      // below this sustained = "lagging"
  warmupMs: 10000,    // initial FPS probe window (~10s per spec)
  settleMs: 3000,     // wait after a step before re-measuring
  probeMs: 2000,      // render-scale probe window
  improveRatio: 1.12, // FPS must rise ≥12% to count as a meaningful improvement / GPU-bound signal
  probeScale: 0.7,    // render scale during the resolution probe (~30% drop)
  minTier: 0,
};

export class AutoTier {
  // ctx: {
  //   getTier(): number             — current applied tier
  //   setTier(t, save): void        — apply tier t; persist to localStorage iff save
  //   setRenderScale(scale): void   — set the render scale (1 = full) for the resolution probe
  //   markCpuBound(): void          — record that this session is CPU-bound (stops adjusting)
  //   onVerdict?(v): void           — optional: report 'cpu'|'gpu' when known (for the HUD)
  // }
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.cfg = { ...AUTO_TIER_DEFAULTS, ...opts };
    this.enabled = true;
    this.phase = 'warmup';   // warmup | settle | resprobe | done
    this.verdict = null;     // 'cpu' | 'gpu' | null (once classified)
    this.cpuBound = false;
    this._phaseStart = 0;
    this._started = false;
    this._baselineFps = 0;   // FPS captured just before a step / probe, for the improvement test
    this._preProbeScale = 1;
    this._steppedFrom = null; // tier we stepped down FROM (to revert if it didn't help)
    this._lastReason = '';
  }

  // Stop auto-adjusting for good (manual override, or we've finished). Idempotent.
  disable(reason = '') {
    if (this.phase === 'resprobe') { try { this.ctx.setRenderScale(this._preProbeScale); } catch { /* ignore */ } }
    this.enabled = false;
    this.phase = 'done';
    if (reason) this._lastReason = reason;
  }

  // Drive the machine. Call once per frame with the shared clock + a perf snapshot
  // { fps, cpuMs, gpuMs, frameMs, warmedUp }. Cheap + allocation-free; most frames just compare
  // the phase timer. `now` is performance.now() (ms).
  tick(now, perf) {
    if (!this.enabled || this.phase === 'done') return;
    if (!this._started) { this._started = true; this._phaseStart = now; }
    const el = now - this._phaseStart;

    if (this.phase === 'warmup') {
      if (el >= this.cfg.warmupMs && perf.warmedUp) this._decide(now, perf);
      return;
    }
    if (this.phase === 'resprobe') {
      if (el >= this.cfg.probeMs) this._resolveProbe(now, perf);
      return;
    }
    if (this.phase === 'settle') {
      if (el >= this.cfg.settleMs) this._resolveSettle(now, perf);
      return;
    }
  }

  // ---- internal transitions ------------------------------------------------
  _enter(phase, now) { this.phase = phase; this._phaseStart = now; }

  _decide(now, perf) {
    if (perf.fps >= this.cfg.targetFps) { this._finish('fps ok'); return; } // not lagging → done

    // Classify. Clear GPU dominance → step down. Clear CPU dominance → can't help, mark + done.
    // Ambiguous → resolution probe.
    if (perf.gpuMs > perf.cpuMs * 1.3) {
      this.verdict = 'gpu';
      if (this.ctx.onVerdict) this.ctx.onVerdict('gpu');
      this._stepDown(now, perf);
    } else if (perf.cpuMs > perf.gpuMs * 1.3) {
      this.verdict = 'cpu';
      if (this.ctx.onVerdict) this.ctx.onVerdict('cpu');
      this._cpuBoundStop();
    } else {
      // Ambiguous — drop render scale and see if FPS jumps (→ GPU-bound).
      this._baselineFps = perf.fps;
      this._preProbeScale = 1;
      try { this.ctx.setRenderScale(this.cfg.probeScale); } catch { /* ignore */ }
      this._enter('resprobe', now);
    }
  }

  _resolveProbe(now, perf) {
    try { this.ctx.setRenderScale(this._preProbeScale); } catch { /* ignore */ }
    if (perf.fps >= this._baselineFps * this.cfg.improveRatio) {
      // Fewer pixels → faster → GPU-bound. Step lighting down.
      this.verdict = 'gpu';
      if (this.ctx.onVerdict) this.ctx.onVerdict('gpu');
      this._stepDown(now, perf);
    } else {
      // Dropping pixels didn't help → CPU-bound.
      this.verdict = 'cpu';
      if (this.ctx.onVerdict) this.ctx.onVerdict('cpu');
      this._cpuBoundStop();
    }
  }

  _stepDown(now, perf) {
    const tier = this.ctx.getTier();
    if (tier <= this.cfg.minTier) { this._finish('already at min tier'); return; }
    this._steppedFrom = tier;
    this._baselineFps = perf.fps;
    // Apply WITHOUT saving yet — we only persist if the step actually helps.
    this.ctx.setTier(tier - 1, false);
    this._enter('settle', now);
  }

  _resolveSettle(now, perf) {
    if (perf.fps >= this._baselineFps * this.cfg.improveRatio) {
      // The step helped — keep it and SAVE. One ratchet; then stop (no yo-yo).
      this.ctx.setTier(this.ctx.getTier(), true); // persist the current (already-applied) tier
      this._finish('stepped down, improved, saved');
    } else {
      // No meaningful improvement — revert the step and mark the session CPU-bound.
      if (this._steppedFrom != null) this.ctx.setTier(this._steppedFrom, false);
      this._cpuBoundStop();
    }
  }

  _cpuBoundStop() {
    this.cpuBound = true;
    this.verdict = 'cpu';
    if (this.ctx.markCpuBound) this.ctx.markCpuBound();
    if (this.ctx.onVerdict) this.ctx.onVerdict('cpu');
    this._finish('cpu-bound, cooldown');
  }

  _finish(reason) {
    this._lastReason = reason;
    this.enabled = false;
    this.phase = 'done';
  }
}
