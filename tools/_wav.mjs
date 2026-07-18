// Tiny shared helpers for the COMBAT-SFX generators (gen-gunshot / gen-grenade / gen-finder-ping /
// gen-prop-ouch). Authoring-only — these helpers run under the sandboxed Node (run_node) to write
// WAV bytes with fs, because `Write` can't emit binary. The generated WAVs are what SHIP; this file
// (and the generators) do NOT. Same generated-tone approach as tools/gen-finder-deny.mjs — nothing
// ripped, everything synthesized from oscillators + seeded noise so re-runs are byte-deterministic.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Deterministic PRNG (mulberry32) so noise-based sounds regenerate identically every run — no
// Math.random (also unavailable in some sandboxes). Seed per-sound so each has its own texture.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Peak-normalise a sample array to `peak` (default 0.9) so every generated clip lands at a known,
// modest level — the per-source playback volume + master limiter do the rest (limiter is a safety
// net, not the mixer). Mutates + returns the array.
export function normalize(samples, peak = 0.9) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max > 0) { const g = peak / max; for (let i = 0; i < samples.length; i++) samples[i] *= g; }
  return samples;
}

// Write PCM-16 mono WAV bytes for `samples` (each in [-1,1]) at `rate` to `outPath`.
export function writeWav(outPath, samples, rate = 44100) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (const s of samples) {
    const v = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE(Math.round(v * 32767), o);
    o += 2;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  return { bytes: dataBytes, seconds: samples.length / rate };
}
