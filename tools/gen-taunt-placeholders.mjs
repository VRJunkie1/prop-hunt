#!/usr/bin/env node
// PLACEHOLDER TAUNT CLIP GENERATOR — RETIRED (authoring-only; never shipped to the browser).
//
// This script used to synthesize 3 tiny beep/tone WAV placeholders (beep_high/beep_low/warble)
// into assets/taunts/ so the audio-taunt path was testable before real clips existed. Those
// placeholders have been REMOVED (requested by VRmike): the 29 real Discord clips are now wired
// into assets/taunts/manifest.json and replace the beeps entirely. This generator is intentionally
// kept as a no-op stub so it is never re-run to recreate the beeps.
//
// The stale placeholder WAV files (assets/taunts/beep_high.wav, beep_low.wav, warble.wav) are no
// longer referenced by anything (manifest, loader, or checker). If they are still on disk, delete
// them in a normal commit — this sandbox has no shell/rm and cannot remove binary files itself.
//
// Real clips are a data-only change: drop the audio file into assets/ and add a line to
// assets/taunts/manifest.json (id/label/file). tools/check-taunts.mjs enforces unique ids + that
// every referenced file exists.

console.log('gen-taunt-placeholders is RETIRED — the placeholder beeps were removed; nothing to generate.');
console.log('Real taunt clips live in assets/ and are listed in assets/taunts/manifest.json.');
