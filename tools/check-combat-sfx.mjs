#!/usr/bin/env node
// Offline acceptance check for COMBAT SFX (VRmike B5, 2026-07-18). AUTHORING-ONLY — never imported by
// the page / shipped. Run from the sandboxed node:
//
//     node tools/check-combat-sfx.mjs
//
// WHY THIS EXISTS. B5 adds four synthesized combat sounds — a rifle GUNSHOT, a grenade BLAST, a prop
// finder activation PING, and ONE shared prop OUCH pitch-shifted by prop size — all routed through the
// existing positional-audio graph (inverse-square + HRTF) and the master limiter, all fail-silent. A
// headless BROWSER boot never builds an audio graph (no gesture, no clips), so this instead:
//   A) drives the REAL pitch-from-size mapping (shared/damage.js ouchPlaybackRate / ouchRateForDisguise)
//      and asserts it VARIES with prop size in the right direction — tiny=higher, big=lower — as a
//      RELATIONSHIP, not frozen numbers (per the balance-tuning guard policy), tied to the SAME size
//      anchors the damage curve uses, and neutral (1.0) for an undisguised/unknown prop;
//   B) confirms the four generated WAV assets exist on disk + their generator scripts are present
//      (our own tones, not ripped);
//   C) SOURCE assertions that scene.js + main.js register + ROUTE the four sounds through the limited
//      listener (PositionalAudio(listener) → limiter), the shooter's own shot is non-positional, the
//      ouch is gated to PROP players + pitched, and everything is fail-silent (guards, never throws).
// The build FAILS if any assertion fails.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ouchPlaybackRate, ouchRateForDisguise, resolveOuchCfg, resolveDamageCfg } from '../shared/damage.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('COMBAT SFX: pitch-from-size mapping + generated assets + routing/fail-silent source check');

// A synthetic catalog mirroring the real size band: a tiny burger, a mid prop, a big table. entrySize
// reads halfExtentsFor(box) = max(w,h,d), so these sizes are exactly 0.6 / 1.2 / 2.4 metres.
const box = (w, h, d) => ({ shape: 'box', w, h, d });
const CATALOG = {
  burger: box(0.6, 0.4, 0.6),   // tiny  → 0.6 m
  crate: box(1.2, 1.2, 1.2),    // mid   → 1.2 m
  table: box(2.4, 1.0, 2.4),    // big   → 2.4 m
  fridge: box(2.6, 3.0, 1.0),   // bigger → 3.0 m (clamps to minRate)
};

// ---------------------------------------------------------------------------
// A) PITCH-FROM-SIZE: the ouch rate must VARY with size, tiny=higher, big=lower (a relationship).
// ---------------------------------------------------------------------------
console.log('\nA) prop-ouch playbackRate varies with size (tiny squeaks HIGH, big groans LOW)');
{
  const cfg = resolveOuchCfg();
  ok(cfg.maxRate > 1 && cfg.minRate < 1 && cfg.maxRate > cfg.minRate,
    `pitch bounds straddle 1.0 (min=${cfg.minRate} < 1 < max=${cfg.maxRate})`);

  const rBurger = ouchRateForDisguise('burger', CATALOG);
  const rCrate = ouchRateForDisguise('crate', CATALOG);
  const rTable = ouchRateForDisguise('table', CATALOG);
  const rFridge = ouchRateForDisguise('fridge', CATALOG);

  // The core relationship (NOT exact values): strictly monotonic DECREASING with size.
  ok(rBurger > rCrate && rCrate > rTable && rTable >= rFridge,
    `strictly decreasing with size: burger ${rBurger.toFixed(3)} > crate ${rCrate.toFixed(3)} > table ${rTable.toFixed(3)} >= fridge ${rFridge.toFixed(3)}`);
  ok(rBurger > 1, `tiny burger is pitched UP (>1): ${rBurger.toFixed(3)}`);
  ok(rTable < 1, `big table is pitched DOWN (<1): ${rTable.toFixed(3)}`);

  // Undisguised / unknown => neutral 1.0 (no crash, no weird pitch).
  ok(ouchRateForDisguise(null, CATALOG) === 1, 'undisguised prop => neutral rate 1.0');
  ok(ouchRateForDisguise('does-not-exist', CATALOG) === 1, 'unknown disguise => neutral rate 1.0');
  ok(ouchRateForDisguise('burger', null) === 1, 'missing catalog => neutral rate 1.0 (never throws)');

  // Clamps: at/below smallSize => maxRate; at/above largeSize => minRate; and it's a real gradient
  // between (a mid size lands strictly between the two bounds — proves it's not a 2-value step).
  ok(ouchPlaybackRate(0.1, cfg) === cfg.maxRate, 'size below smallSize clamps to maxRate (squeak)');
  ok(ouchPlaybackRate(99, cfg) === cfg.minRate, 'size above largeSize clamps to minRate (groan)');
  const mid = ouchPlaybackRate((cfg.smallSize + cfg.largeSize) / 2, cfg);
  ok(mid < cfg.maxRate && mid > cfg.minRate, `a mid size interpolates strictly between the bounds: ${mid.toFixed(3)}`);

  // Monotonic sweep across the band (a relationship over many points, not two anchors).
  let monotonic = true;
  let prev = Infinity;
  for (let s = 0.3; s <= 3.0; s += 0.1) {
    const r = ouchPlaybackRate(s, cfg);
    if (r > prev + 1e-9) monotonic = false;
    prev = r;
  }
  ok(monotonic, 'playbackRate is monotonic non-increasing across a 0.3→3.0 m size sweep');

  // Unknown/degenerate size => neutral (matches the damage curve's "unknown => default" behaviour).
  ok(ouchPlaybackRate(0, cfg) === 1 && ouchPlaybackRate(-1, cfg) === 1 && ouchPlaybackRate(NaN, cfg) === 1,
    'non-positive / NaN size => neutral rate 1.0');
}

// ---------------------------------------------------------------------------
// A2) TIED TO THE DAMAGE CURVE: the ouch anchors default to damage smallSize/largeSize, so pitch and
//     the damage multiplier read the same size band (they can't drift). Assert the defaults agree.
// ---------------------------------------------------------------------------
console.log('\nA2) ouch size anchors track the damage curve (one size band, not two lists)');
{
  const d = resolveDamageCfg();
  const o = resolveOuchCfg();
  ok(o.smallSize === d.smallSize, `ouch.smallSize (${o.smallSize}) == damage.smallSize (${d.smallSize})`);
  ok(o.largeSize === d.largeSize, `ouch.largeSize (${o.largeSize}) == damage.largeSize (${d.largeSize})`);
  // And passing retuned anchors actually moves the crossover, proving they're wired through (not frozen).
  const shifted = ouchPlaybackRate(1.2, { smallSize: 1.2, largeSize: 2.2 });
  ok(shifted === resolveOuchCfg().maxRate, 'passing smallSize=1.2 makes a 1.2 m prop clamp to maxRate (anchors are live)');
}

// ---------------------------------------------------------------------------
// B) GENERATED ASSETS exist on disk + generator scripts present (our own tones, nothing ripped).
// ---------------------------------------------------------------------------
console.log('\nB) the four synthesized WAVs + their generators exist');
{
  const assets = [
    ['assets', 'combat', 'gunshot.wav'],
    ['assets', 'combat', 'grenade.wav'],
    ['assets', 'combat', 'ouch.wav'],
    ['assets', 'finder', 'ping.wav'],
  ];
  for (const a of assets) ok(existsSync(join(root, ...a)), `${a.join('/')} exists`);
  // Each WAV is a real RIFF/WAVE file with a non-trivial payload (not an empty/placeholder stub).
  for (const a of assets) {
    const p = join(root, ...a);
    if (!existsSync(p)) continue;
    const b = readFileSync(p);
    ok(b.length > 1000 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE',
      `${a[a.length - 1]} is a real WAV (${b.length} bytes)`);
  }
  const gens = ['gen-gunshot.mjs', 'gen-grenade.mjs', 'gen-finder-ping.mjs', 'gen-prop-ouch.mjs'];
  for (const g of gens) ok(existsSync(join(root, 'tools', g)), `tools/${g} generator present`);
}

// ---------------------------------------------------------------------------
// C) SOURCE: scene.js exposes a positional one-shot routed through the limited listener, and main.js
//    hooks the four existing events + gates/pitches the ouch. Fail-silent guards intact.
// ---------------------------------------------------------------------------
console.log('\nC) scene.js positional one-shot routes through the limiter; main.js hooks the events');
{
  const scene = readText('js', 'scene.js');
  const play = (scene.match(/playPositionalSound\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(play.length > 0, 'scene.js defines playPositionalSound');
  ok(/new THREE\.PositionalAudio\(\s*listener\s*\)/.test(play),
    'playPositionalSound emits PositionalAudio(listener) → routes through the SAME limiter as taunts');
  ok(/_ensureAudioListener\(\)/.test(play), 'playPositionalSound goes through _ensureAudioListener (installs the limiter)');
  ok(/setDistanceModel\(\s*['"]exponential['"]\s*\)/.test(play) && /setRolloffFactor\(/.test(play),
    'playPositionalSound uses the inverse-square (exponential, rolloff) distance model like taunts');
  ok(/panningModel\s*=\s*TAUNT_PANNING\.model/.test(play), 'playPositionalSound applies HRTF binaural panning');
  ok(/setVolume\(/.test(play), 'playPositionalSound applies a per-source volume trim (limiter stays a safety net)');
  ok(/setPlaybackRate\(/.test(play), 'playPositionalSound supports playbackRate (the prop-ouch pitch lever)');
  // Fail-silent: guards on missing buffer/pos/listener + a try/catch around node setup.
  ok(/if\s*\(\s*!buffer\s*\|\|\s*!pos\s*\)\s*return/.test(play), 'playPositionalSound no-ops on a missing buffer/pos');
  ok(/if\s*\(\s*!listener\s*\|\|\s*!THREE\.PositionalAudio\s*\)\s*return/.test(play),
    'playPositionalSound no-ops when audio is unavailable (fail-silent, no throw)');
  ok(/catch\s*\{\s*return\s*;?\s*\}/.test(play), 'playPositionalSound wraps node setup in try/catch (never throws)');
  // In-flight one-shots are reaped + cleared on teardown (no bleed into the next match).
  ok(/_oneShots/.test(scene) && /_stopAllOneShots\s*\(\)/.test(scene),
    'scene tracks one-shots and clears them on buildWorld teardown');
}
{
  const main = readText('js', 'main.js');
  ok(/from\s*['"][^'"]*shared\/damage\.js['"]/.test(main) && /ouchRateForDisguise/.test(main),
    'main.js imports ouchRateForDisguise from shared/damage.js');
  // The registry names all four sounds with their asset URLs.
  for (const url of ['/assets/combat/gunshot.wav', '/assets/combat/grenade.wav', '/assets/combat/ouch.wav', '/assets/finder/ping.wav']) {
    ok(main.includes(url), `main.js registers ${url}`);
  }

  // GUNSHOT on the shot event: shooter hears it 2D (own), others positional at the muzzle.
  const shot = (main.match(/case 'shot':[\s\S]*?break;/) || [''])[0];
  ok(/msg\.by === state\.selfId.*playCombatSound2D\('gunshot'/s.test(shot),
    "gunshot: the shooter (msg.by === selfId) hears it NON-positional (playCombatSound2D)");
  ok(/playCombatSoundAt\('gunshot',\s*\{\s*x:\s*msg\.ox/.test(shot),
    'gunshot: everyone else hears it POSITIONALLY at the muzzle (msg.ox/oy/oz)');

  // GRENADE on the grenade event: positional at the blast centre.
  const gren = (main.match(/case 'grenade':[\s\S]*?break;/) || [''])[0];
  ok(/playCombatSoundAt\('grenade',\s*\{\s*x:\s*msg\.x/.test(gren), 'grenade: positional boom at the blast centre (msg.x/y/z)');

  // FINDER PING on the find success reply (distinct from the deny buzz).
  const find = (main.match(/case 'find':[\s\S]*?break;/) || [''])[0];
  ok(/msg\.ok/.test(find) && /playCombatSoundAt\('finderPing'/.test(find),
    'finder ping: plays on the find OK reply (the success path, not the deny buzz)');

  // PROP OUCH on the hurt event: gated to !self (not the hunter backfire) and !hunter (prop only),
  // and pitched via playPropOuch → ouchRateForDisguise.
  const hurt = (main.match(/case 'hurt':[\s\S]*?break;/) || [''])[0];
  ok(/if\s*\(\s*!msg\.self\s*\)/.test(hurt), 'ouch: skips msg.self (hunter wrong-guess/backfire — not a prop)');
  ok(/!victim\.hunter/.test(hurt) && /playPropOuch\(/.test(hurt), 'ouch: only PROP-role victims yelp, via playPropOuch');
  const propOuch = (main.match(/function playPropOuch[\s\S]*?\n\}/) || [''])[0];
  ok(/ouchRateForDisguise\(\s*victim\.disguise/.test(propOuch), 'playPropOuch derives the rate from the victim disguise size');
  ok(/playCombatSoundAt\('ouch',[\s\S]*?rate\)/.test(propOuch), 'playPropOuch plays the ouch positionally with the size-derived rate');

  // Fail-silent plumbing: the loader no-ops without a scene / loadAudioBuffer, mirroring the deny buzz.
  const loader = (main.match(/function _withCombatSfx[\s\S]*?\n\}/) || [''])[0];
  ok(/if\s*\(\s*!s\s*\|\|\s*!scene\s*\|\|\s*!scene\.loadAudioBuffer\s*\)\s*return/.test(loader),
    '_withCombatSfx no-ops when audio is unavailable (fail-silent)');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll combat-sfx checks passed.');
process.exit(fails ? 1 : 0);
