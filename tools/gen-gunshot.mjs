#!/usr/bin/env node
// COMBAT SFX — RIFLE GUNSHOT WAV generator (authoring-only; the OUTPUT ships, this script does not).
//
//     node tools/gen-gunshot.mjs
//
// Synthesizes a short, sharp gunshot CRACK into assets/combat/gunshot.wav — the report played when a
// rifle fires (positionally for nearby players, plainly/close for the shooter). Our OWN synthesized
// sound (a bright noise transient + a low body thump), NOT a ripped copyrighted gunshot. Same
// generated-tone approach as tools/gen-finder-deny.mjs. Re-run only to retune; the committed WAV ships.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32, normalize, writeWav } from './_wav.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 44100;
const DUR = 0.18; // a short, punchy crack — not a long boom
const n = Math.round(DUR * RATE);
const rnd = mulberry32(0x9151); // seeded so the noise texture is byte-deterministic
const samples = new Array(n);

let lp = 0;      // one-pole low-pass state (takes the harsh fizz off the noise)
let bodyPh = 0;  // integrated phase for the swept low body tone (integrate — never f*t)
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  // Bright noise CRACK: raw white noise, very fast exponential decay. Blend a touch of the
  // low-passed copy back in so it reads as a sharp report, not white hiss.
  const nz = rnd() * 2 - 1;
  lp += (nz - lp) * 0.5;
  const crack = (0.62 * nz + 0.38 * lp) * Math.exp(-t / 0.028);
  // Low BODY thump: a short sine sweep 165 -> 72 Hz that gives the shot weight. Phase integrated.
  const f = 165 - 93 * Math.min(1, t / 0.12);
  bodyPh += (2 * Math.PI * f) / RATE;
  const body = Math.sin(bodyPh) * Math.exp(-t / 0.05);
  // 2 ms attack ramp so the very first sample isn't a click.
  const attack = Math.min(1, t / 0.002);
  samples[i] = (0.85 * crack + 0.55 * body) * attack;
}

normalize(samples, 0.92);
const out = join(root, 'assets', 'combat', 'gunshot.wav');
const { bytes, seconds } = writeWav(out, samples, RATE);
console.log(`wrote ${out} (${bytes} PCM bytes, ${seconds.toFixed(3)}s)`);
