#!/usr/bin/env node
// COMBAT SFX — SHARED PROP "OUCH" generator (authoring-only; the OUTPUT ships, this script does not).
//
//     node tools/gen-prop-ouch.mjs
//
// Synthesizes ONE shared, cartoonish "ouch"/"oof" yelp into assets/combat/ouch.wav — played (ONE clip
// for every prop) when a prop PLAYER takes a hit. It is pitch-shifted AT PLAYBACK by prop size (Web
// Audio playbackRate): high squeak for a tiny burger, deep groan for a big fridge/table — see
// shared/damage.js ouchPlaybackRate + js/scene.js playPositionalSound. The clip is authored at a
// NEUTRAL mid pitch (rate 1.0 = a mid/undisguised prop) so scaling reads clearly BOTH ways. Our OWN
// generated voice-ish tone, NOT a ripped sound. Re-run only to retune; the committed WAV ships.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalize, writeWav } from './_wav.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 44100;
const DUR = 0.34; // short yelp
const n = Math.round(DUR * RATE);
const samples = new Array(n);

// A voice-ish "ow": a pitch contour that rises then falls (like the vowel in "ow"), built from a
// fundamental plus a couple of harmonics so it reads as a cartoon yelp rather than a pure beep. The
// frequency VARIES over time, so the phase is INTEGRATED sample-by-sample (never freq*t, which would
// glitch). Base pitch is mid so playbackRate up (tiny prop) squeaks and down (big prop) groans.
let ph = 0;
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  const p = i / n; // 0..1 progress
  // Contour: quick rise 300 -> 430 Hz over the first 15%, then fall to 250 Hz over the rest.
  const f = p < 0.15 ? 300 + 130 * (p / 0.15) : 430 - 180 * ((p - 0.15) / 0.85);
  ph += (2 * Math.PI * f) / RATE;
  const tone = Math.sin(ph) + 0.42 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph);
  const attack = Math.min(1, t / 0.008); // 8 ms attack
  const decay = Math.exp(-t / 0.15);     // yelp decays away
  samples[i] = tone * attack * decay;
}

normalize(samples, 0.9);
const out = join(root, 'assets', 'combat', 'ouch.wav');
const { bytes, seconds } = writeWav(out, samples, RATE);
console.log(`wrote ${out} (${bytes} PCM bytes, ${seconds.toFixed(3)}s)`);
