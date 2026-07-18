// MASTER AUDIO LIMITER — shared config + installer for the game's ONE audio output.
//
// WHY. Every game sound — 3D positional taunts (one PositionalAudio emitter per taunting prop, full
// volume inside refDistance), the prop-finder deny buzz, any future UI/grenade audio — is summed at
// THREE's shared AudioListener gain node before it reaches ctx.destination. When several loud sources
// overlap, their samples ADD past 0dBFS and the overflow is the audible distortion/clipping players
// reported. The fix is a single choke point: splice a headroom trim + a near-brickwall compressor
// (used as a limiter) into that final hop so the summed mix can never clip:
//
//     listener.gain  →  preGain (headroom)  →  limiter (ceiling)  →  ctx.destination
//
// One insert covers EVERYTHING routed through the listener, current and future — no per-sound wiring.
//
// PURE Web Audio, NO THREE dependency on purpose: js/scene.js installs it on the real listener, and
// tools/check-audio-limiter.mjs runs this EXACT function against a mock AudioContext, so what ships
// is what's verified. NEVER throws — audio must never break the game (fail-silent, same philosophy
// as the rest of the audio code). See memory/notes/audio-limiter.md, incl. the "no true lookahead
// yet" rationale (Web Audio's DynamicsCompressorNode has no lookahead; the zero-latency version
// ships first and works everywhere incl. iOS Safari).

// Tuning for a near-brickwall limiter on the SUMMED master output. It's a SAFETY NET, not the mixer —
// per-source gains (taunt/UI volumes) are trimmed at their source so the limiter rarely has to work.
export const MASTER_LIMITER = {
  preGain: 0.7,   // headroom trim BEFORE the limiter so transients rarely slam the ceiling
  threshold: -6,  // dBFS ceiling (below 0dBFS → the summed mix is clamped before it clips)
  knee: 0,        // hard knee → brickwall-ish, not a gentle compressor curve
  ratio: 20,      // near-infinite gain reduction above threshold → a limiter
  attack: 0.002,  // ~2 ms clamp (as fast as Web Audio allows; there is no true lookahead)
  release: 0.15,  // smooth gain recovery (s) so limiting doesn't pump audibly
};

// Splice the headroom-trim + limiter into a THREE.AudioListener's output hop. `listener` only needs
// `.gain` (an AudioNode) and `.context` (an AudioContext) — no THREE import required, so a mock works.
// Returns { preGain, limiter } on success, or null if audio is unavailable / on any failure (in which
// case audio still plays through THREE's default direct connection — just uncapped). Never throws.
export function installMasterLimiter(listener) {
  if (!listener || !listener.gain || !listener.context) return null;
  const ctx = listener.context;
  if (typeof ctx.createDynamicsCompressor !== 'function' || typeof ctx.createGain !== 'function') return null;
  try {
    const preGain = ctx.createGain();
    preGain.gain.value = MASTER_LIMITER.preGain;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = MASTER_LIMITER.threshold;
    limiter.knee.value = MASTER_LIMITER.knee;
    limiter.ratio.value = MASTER_LIMITER.ratio;
    limiter.attack.value = MASTER_LIMITER.attack;
    limiter.release.value = MASTER_LIMITER.release;

    // Detach THREE's default listener.gain → destination hop, then insert our chain in its place.
    // At splice time gain → destination is gain's only outgoing edge; emitters connect INTO gain
    // (listener.getInput()), so disconnecting gain's OUTPUT never touches them.
    try { listener.gain.disconnect(); } catch { /* nothing connected yet — fine */ }
    listener.gain.connect(preGain);
    preGain.connect(limiter);
    limiter.connect(ctx.destination);
    return { preGain, limiter };
  } catch {
    // Best-effort restore of THREE's default direct connection so audio still plays (uncapped)
    // rather than going silent. Never throw — audio must not break the game.
    try { listener.gain.disconnect(); listener.gain.connect(ctx.destination); } catch { /* silent */ }
    return null;
  }
}
