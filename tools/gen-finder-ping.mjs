#!/usr/bin/env node
// COMBAT SFX — PROP FINDER ACTIVATION PING generator (authoring-only; the OUTPUT ships, not this).
//
//     node tools/gen-finder-ping.mjs
//
// Synthesizes a bright, ASCENDING two-tone "ping" into assets/finder/ping.wav — the success pulse
// played when the prop finder actually FIRES (opposite of the deny buzz). Deliberately DISTINCT from
// assets/finder/deny.wav: the deny buzz is a DESCENDING, buzzy square-ish "nope" (220->165 Hz); this
// ping is a CLEAN, ASCENDING pair of bell-like sine tones (784->1175 Hz) that reads as "activated".
// Our OWN generated tone, NOT a ripped sound. Same approach as tools/gen-finder-deny.mjs. Re-run only
// to retune; the committed WAV ships.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalize, writeWav } from './_wav.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 44100;
// Two ASCENDING bell tones (G5 -> D6): clean sine + a touch of the 2nd/3rd partial for shimmer, quick
// attack + exponential decay so each reads as a crisp "ping", not a sustained beep.
const SEGMENTS = [
  { freq: 784, dur: 0.085 },   // G5
  { freq: 1175, dur: 0.11 },   // D6 — higher = ascending = success
];

function bell(freq, t) {
  const w = 2 * Math.PI * freq * t;
  return (Math.sin(w) + 0.28 * Math.sin(2 * w) + 0.12 * Math.sin(3 * w)) / 1.4;
}

const samples = [];
for (const seg of SEGMENTS) {
  const n = Math.round(seg.dur * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.003); // 3 ms attack
    const decay = Math.exp(-t / (seg.dur * 0.45)); // bell-like exponential ring-out
    samples.push(bell(seg.freq, t) * attack * decay);
  }
}

normalize(samples, 0.85); // a UI cue, kept modest
const out = join(root, 'assets', 'finder', 'ping.wav');
const { bytes, seconds } = writeWav(out, samples, RATE);
console.log(`wrote ${out} (${bytes} PCM bytes, ${seconds.toFixed(3)}s)`);
