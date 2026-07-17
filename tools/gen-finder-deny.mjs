#!/usr/bin/env node
// PROP FINDER — denied-buzz WAV generator (authoring-only; the OUTPUT ships, this script does not).
//
//     node tools/gen-finder-deny.mjs
//
// Synthesizes a tiny, quiet, DETERMINISTIC "denied" buzz into assets/finder/deny.wav — the short
// rejection sound played when a hunter clicks the prop finder while it is still on cooldown
// (spec item 5, "windows-error-click vibe"). It is our OWN generated tone (same generator approach
// as the old placeholder taunt beeps, tools/gen-taunt-placeholders) — NOT a ripped Microsoft sound.
//
// `Write` can't emit binary, so this runs under the sandboxed Node (run_node) and writes the WAV
// bytes with fs. Re-run only if you want to retune the sound; the committed WAV is what ships.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const RATE = 44100;
// Two short descending buzz tones (a classic "nope"): a harsh-ish square-flavoured wave, low
// volume, quick attack + decay so it reads as a curt click-buzz, not a musical beep.
const SEGMENTS = [
  { freq: 220, dur: 0.075 },
  { freq: 165, dur: 0.095 },
];
const PEAK = 0.32; // quiet — a UI blip, never startling

// Square-ish tone: fundamental + a touch of the odd harmonics for a buzzy edge (kept mild).
function tone(freq, t) {
  const w = 2 * Math.PI * freq;
  return (Math.sin(w * t) + 0.33 * Math.sin(3 * w * t) + 0.2 * Math.sin(5 * w * t)) / 1.53;
}

const samples = [];
for (const seg of SEGMENTS) {
  const n = Math.round(seg.dur * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // Per-segment envelope: 4 ms attack, linear decay to zero over the tail.
    const attack = Math.min(1, t / 0.004);
    const decay = 1 - i / n;
    samples.push(tone(seg.freq, t) * PEAK * attack * decay);
  }
}

// ---- WAV (PCM 16-bit mono) ----
const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); // fmt chunk size
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 2, 28); // byte rate
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

const outDir = join(root, 'assets', 'finder');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'deny.wav');
writeFileSync(outPath, buf);
console.log(`wrote ${outPath} (${dataBytes} PCM bytes, ${(samples.length / RATE).toFixed(3)}s)`);
