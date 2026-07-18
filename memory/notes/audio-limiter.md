# Master audio limiter (stop the clipping)

Built 2026-07-18 (Jie, branch `build/131-master-audio-limiter-stop`). Players reported audible
distortion/clipping when several sounds overlap. Root cause is summing, not any one clip: every game
sound funnels through THREE's ONE shared `AudioListener` (on the camera), and when a few overlapping
positional taunts (one full-volume emitter per taunting prop inside `refDistance`) + the finder deny
buzz + any other UI/grenade audio play at once, their samples ADD past 0dBFS at the listener and the
overflow is the crunch. Fix: a **master limiter** on that single output so the summed mix can't clip.

## The one choke point
THREE's `AudioListener` wires its own summing node straight to the speakers:
`listener.gain → ctx.destination`. EVERY emitter (`PositionalAudio`, `THREE.Audio`) connects INTO
`listener.gain` (`listener.getInput()`), so that one hop is where the whole mix exists. We splice a
headroom trim + a near-brickwall compressor into it:

```
listener.gain  →  preGain (0.7)  →  DynamicsCompressor (limiter)  →  ctx.destination
```

One insert ⇒ every current and future sound routed through the listener is covered automatically. No
per-sound wiring, no changes to taunt/finder/grenade logic — purely the output audio graph.

## Where it lives
- **`shared/audio-limiter.js`** — pure Web Audio, NO THREE import. Exports `MASTER_LIMITER` (the
  tuning) and `installMasterLimiter(listener)`. Being THREE-free is deliberate: the game AND the
  headless check run the exact same install code (the check passes a mock AudioContext). Returns
  `{ preGain, limiter }` or `null`; **never throws**.
- **`js/scene.js`**:
  - `_ensureMasterLimiter()` — calls `installMasterLimiter(this._audioListener)` once, stashes
    `this._masterPreGain` / `this._masterLimiter`. Idempotent (guards on `_masterLimiter`).
  - Called from `_ensureAudioListener()`, so the limiter is spliced the moment the listener exists —
    before any emitter can play. The listener is created lazily on the first taunt/UI sound (never at
    boot, so the headless page load builds no audio graph — unchanged).
  - The chain lives on the AudioContext, not the scene graph, so it SURVIVES `buildWorld`'s
    `scene.clear()` (like the listener itself). No teardown needed.

## Tuning (`MASTER_LIMITER`) — a safety net, not the mixer
- `preGain: 0.7` — headroom trim BEFORE the limiter so transients rarely slam the ceiling.
- `threshold: -6` dBFS — the ceiling (below 0dBFS → clamp before clip).
- `knee: 0` — hard knee → brickwall-ish, not a gentle compressor curve.
- `ratio: 20` — near-infinite reduction above threshold → a limiter.
- `attack: 0.002` s (~2 ms) — as fast as Web Audio allows.
- `release: 0.15` s — smooth recovery so limiting doesn't pump audibly.

Per-source gain staging (so the limiter rarely has to work):
- **Taunt emitters** were at full `1.0` inside `refDistance` — now `sound.setVolume(0.85)` in
  `playTaunt` (a modest trim, still loud).
- **`playUiSound`** (finder deny buzz) is already called at `0.5` — left as-is.
- Grenades are VISUAL only (`spawnExplosion`) — no grenade audio node exists to trim.

## Why no true lookahead (yet) — Jie's ask, answered honestly
Web Audio's native `DynamicsCompressorNode` has **no true lookahead** and no external sidechain — it
reacts to samples as they pass, so a very fast transient can poke slightly above the ceiling before
the ~2 ms attack clamps it. A REAL lookahead limiter means an **AudioWorklet** with a few-ms delay
line + gain-reduction envelope: more code, and it must degrade gracefully where AudioWorklet is
unavailable (falling back to exactly this compressor anyway). Plan of record (approved): ship the
zero-latency compressor version first — simple, well-supported everywhere incl. iOS Safari, and the
`preGain` headroom means transients rarely reach the ceiling hard in the first place. **Escalate to
the worklet only if a real-phone listen test still reveals crunch on transient spikes.** If/when we
do, `installMasterLimiter` is the single seam to swap.

## Fail-silent (audio must never break the game)
`installMasterLimiter` returns `null` (never throws) if audio is unavailable — no listener/gain/
context, or a browser lacking `createDynamicsCompressor`/`createGain`. If it throws mid-splice it
**restores THREE's default direct `gain → destination`** connection so audio still plays (just
uncapped) rather than going silent. Same never-throws philosophy as the rest of the audio code. The
**iOS unlock path (`unlockAudio` → resume the shared ctx in a gesture) is untouched.**

## Headless check — `tools/check-audio-limiter.mjs` (build-gating)
Runs the REAL `installMasterLimiter` against a mock AudioContext (records connect/disconnect + param
writes) — not brittle source regex — and asserts:
- **A) Config** is a sane limiter: ceiling below 0dBFS, ratio ≥10, fast attack, sane release, trim in (0,1).
- **B) Install** builds a GainNode + DynamicsCompressorNode with the right params AND rewires the graph
  to `listener.gain → preGain → limiter → destination` (the default direct hop is gone → the limiter is
  truly in the path, last).
- **C) Fail-silent**: null/absent audio → `null`, never throws; a throwing context is caught and the
  direct connection is restored (audio not silenced).
- **D) Routing (source)**: scene.js installs from `_ensureAudioListener`, and BOTH audio paths
  (`playTaunt` → `PositionalAudio(listener)`, `playUiSound` → `THREE.Audio(listener)`) emit through the
  SAME listener, so one insert covers them; the per-source taunt trim + iOS `unlockAudio` are asserted intact.

## Owed live pass
Real-phone listen test: stack 3–4 taunts near your ear + throw a grenade → confirm it's **loud but
clean** (no crunch). If crunch persists on transient spikes, escalate to the AudioWorklet lookahead
limiter (see above).
