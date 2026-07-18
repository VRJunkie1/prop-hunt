#!/usr/bin/env node
// COMBAT SFX — GRENADE BLAST WAV generator (authoring-only; the OUTPUT ships, this script does not).
//
//     node tools/gen-grenade.mjs
//
// Synthesizes a low grenade BOOM into assets/combat/grenade.wav — played positionally at the blast
// point when a grenade resolves. Our OWN synthesized sound (an initial noise punch, a deep descending
// body tone, and a rumbling low-passed noise tail), NOT a ripped explosion sample. Same generated-tone
// approach as tools/gen-finder-deny.mjs. Re-run only to retune; the committed WAV ships.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32, normalize, writeWav } from './_wav.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 44100;
const DUR = 0.62; // a heavier, longer decay than the gunshot — reads as a blast, not a shot
const n = Math.round(DUR * RATE);
const rnd = mulberry32(0x2ee7);
const samples = new Array(n);

let lp = 0;      // heavy low-pass state for the rumble tail
let bodyPh = 0;  // integrated phase for the deep descending body tone
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  const nz = rnd() * 2 - 1;
  // Initial PUNCH: a very short bright noise burst for the "crack" of detonation.
  const punch = nz * Math.exp(-t / 0.02) * 0.7;
  // Deep BODY: descending sine 95 -> 34 Hz with a long decay — the felt "boom". Phase integrated.
  const f = 95 - 61 * Math.min(1, t / 0.3);
  bodyPh += (2 * Math.PI * f) / RATE;
  const body = Math.sin(bodyPh) * Math.exp(-t / 0.26);
  // RUMBLE tail: strongly low-passed noise, medium decay — the debris/echo after the boom.
  lp += (nz - lp) * 0.06; // aggressive one-pole → only low rumble survives
  const rumble = lp * Math.exp(-t / 0.34) * 2.4;
  const attack = Math.min(1, t / 0.002);
  samples[i] = (0.6 * punch + 1.0 * body + 0.8 * rumble) * attack;
}

normalize(samples, 0.94);
const out = join(root, 'assets', 'combat', 'grenade.wav');
const { bytes, seconds } = writeWav(out, samples, RATE);
console.log(`wrote ${out} (${bytes} PCM bytes, ${seconds.toFixed(3)}s)`);
