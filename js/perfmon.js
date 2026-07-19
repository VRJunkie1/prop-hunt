// js/perfmon.js — allocation-free per-frame cost instrumentation (LIGHTING OVERHAUL, 2026-07-19).
//
// CPU/GPU ATTRIBUTION (spec item 4). We measure CPU frame cost DIRECTLY with performance.now()
// around the physics + game logic + render SUBMISSION, and infer GPU cost by SUBTRACTION: the wall-
// clock frame time (gap between frames) minus the measured CPU time is roughly what the GPU +
// vsync wait accounts for. When the two are close it's ambiguous — the auto-tuner then runs a brief
// render-scale probe to disambiguate (js/auto-tier.js).
//
// Everything here is a fixed set of number fields updated in place — NO per-frame object/array
// allocation (old phones are the whole audience). PURE (no THREE / DOM beyond the `now` passed in),
// so tools/check-lighting.mjs can drive it headlessly.
//
// Usage per frame (main.js):
//   perf.beginFrame(now);         // at the very top — records the inter-frame gap (total frame time)
//   ... physics + logic + scene.render() ...
//   perf.endCpu(nowAfterRender);  // right after render submission — closes the CPU stopwatch
//
// See memory/notes/lighting.md.

export class PerfMon {
  constructor(alpha = 0.1) {
    this.fps = 60;        // smoothed frames/sec
    this.cpuMs = 0;       // smoothed CPU cost per frame (physics+logic+render submit)
    this.frameMs = 1000 / 60; // smoothed wall-clock frame time (gap between frames)
    this.gpuMs = 0;       // inferred GPU cost = max(0, frameMs - cpuMs)
    this._alpha = alpha;  // EMA smoothing factor
    this._cpuStart = 0;
    this._lastFrame = 0;
    this._warm = 0;       // frames seen (so the first frame doesn't poison the average)
  }

  // Call at the very start of the frame's work. Records the total frame time (gap since the last
  // beginFrame) and opens the CPU stopwatch.
  beginFrame(now) {
    if (this._lastFrame > 0) {
      const ft = now - this._lastFrame;
      // Ignore absurd gaps (tab was backgrounded, first frame) so a stall doesn't skew the EMA.
      if (ft > 0 && ft < 1000) {
        this.frameMs += (ft - this.frameMs) * this._alpha;
        this.fps += (1000 / ft - this.fps) * this._alpha;
        if (this._warm < 1000) this._warm++;
      }
    }
    this._lastFrame = now;
    this._cpuStart = now;
  }

  // Call immediately after render submission — closes the CPU stopwatch and re-derives the inferred
  // GPU cost. `now` is performance.now() taken right after scene.render().
  endCpu(now) {
    const cpu = now - this._cpuStart;
    if (cpu >= 0 && cpu < 1000) this.cpuMs += (cpu - this.cpuMs) * this._alpha;
    const gpu = this.frameMs - this.cpuMs;
    this.gpuMs = gpu > 0 ? gpu : 0;
  }

  // Has the monitor seen enough frames for its averages to be trustworthy?
  get warmedUp() { return this._warm >= 30; }

  // A cheap per-frame verdict for the debug HUD: which side dominates this frame's cost. NOT the
  // auto-tuner's decision (that also weighs "are we even lagging" + a resolution probe) — just a
  // readout. GPU-bound when the inferred GPU time clearly exceeds the measured CPU time.
  verdict() {
    if (this.gpuMs > this.cpuMs * 1.3) return 'gpu';
    if (this.cpuMs > this.gpuMs * 1.3) return 'cpu';
    return 'even';
  }
}
