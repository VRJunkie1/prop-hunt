#!/usr/bin/env node
// PLACEHOLDER TAUNT CLIP GENERATOR (authoring-only; never shipped to the browser).
//
// The AUDIO TAUNT SYSTEM is data-driven: ~50 real clips will be dropped into assets/taunts/
// LATER with matching manifest.json lines, needing ZERO code changes. To make the whole path
// testable end-to-end NOW, we ship 2–3 tiny synthesized beep/tone clips. `Write` can't emit
// binary safely, so this script SYNTHESIZES valid 16-bit PCM mono WAV files (a trivial,
// well-specified container) and writes them into assets/taunts/. Run under the repo's sandboxed
// node:
//
//     node tools/gen-taunt-placeholders.mjs
//
// It writes assets/taunts/<id>.wav for each entry below. The ids/files MUST match
// assets/taunts/manifest.json (tools/check-taunts.mjs asserts every manifest file exists). Real
// clips later simply replace/extend these — the game loads whatever the manifest lists.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'assets', 'taunts');
mkdirSync(outDir, { recursive: true });

const SR = 8000; // 8 kHz mono is plenty for a short beep and keeps files tiny (~a few KB).

// Build a mono 16-bit PCM WAV Buffer from a per-sample amplitude function f(t) → [-1,1].
function makeWav(seconds, sampleFn) {
  const n = Math.max(1, Math.round(seconds * SR));
  const bytesPerSample = 2;
  const dataLen = n * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  // RIFF header
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  // fmt chunk (PCM)
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels = 1
  buf.writeUInt32LE(SR, 24); // sample rate
  buf.writeUInt32LE(SR * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Short fade in/out (5 ms) so the clip can't click on start/stop.
    const fade = Math.min(1, t / 0.005, (seconds - t) / 0.005);
    let s = sampleFn(t) * Math.max(0, fade) * 0.6; // headroom so it isn't harsh
    s = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * bytesPerSample);
  }
  return buf;
}

const tone = (f) => (t) => Math.sin(2 * Math.PI * f * t);
// A two-note warble that alternates every 80 ms — reads clearly as a distinct "voice".
const warble = (a, b) => (t) => Math.sin(2 * Math.PI * (Math.floor(t / 0.08) % 2 ? b : a) * t);

const clips = [
  { id: 'beep_high', seconds: 0.4, fn: tone(880) },
  { id: 'beep_low', seconds: 0.45, fn: tone(300) },
  { id: 'warble', seconds: 0.5, fn: warble(440, 660) },
];

for (const c of clips) {
  const wav = makeWav(c.seconds, c.fn);
  const path = join(outDir, `${c.id}.wav`);
  writeFileSync(path, wav);
  console.log(`wrote ${path} (${wav.length} bytes)`);
}
console.log('Placeholder taunt clips generated. Keep ids in sync with assets/taunts/manifest.json.');
