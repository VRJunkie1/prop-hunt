#!/usr/bin/env node
// Offline acceptance check for the MASTER AUDIO LIMITER (Jie, 2026-07-18). AUTHORING-ONLY — never
// imported by the page / shipped. Run from the sandboxed node:
//
//     node tools/check-audio-limiter.mjs
//
// WHY THIS EXISTS. Players reported audible distortion/clipping when several sounds overlap
// (a few taunting props + the finder buzz + a grenade): their samples sum past 0dBFS at the shared
// AudioListener and the overflow clips. The fix splices a headroom trim + a near-brickwall
// compressor into the listener's ONE output hop so the summed mix can't clip. A headless BROWSER
// boot never builds an audio graph (no gesture, no clips), so this instead runs the REAL installer
// (shared/audio-limiter.js — the exact code the game calls) against a MOCK AudioContext and asserts:
//   A) CONFIG is a sane limiter (ceiling below 0dBFS, high ratio, fast attack, sane release, <1 trim).
//   B) INSTALL builds the right nodes with the right params AND rewires the graph to
//      listener.gain → preGain → limiter → destination (i.e. the limiter is really IN the path, and
//      THREE's default direct gain→destination hop is gone).
//   C) FAIL-SILENT: missing Web Audio / a throwing context → returns null, never throws, and leaves
//      audio playing through a direct connection (audio must never break the game).
//   D) ROUTING (source): scene.js installs the limiter from _ensureAudioListener, and BOTH audio
//      paths (positional taunts + playUiSound) emit through the SAME listener, so everything is
//      covered by the one insert; iOS unlock + taunt/finder/grenade logic are untouched.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installMasterLimiter, MASTER_LIMITER } from '../shared/audio-limiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('MASTER AUDIO LIMITER: config + real-installer graph + fail-silent + routing check');

// --- a minimal mock of the Web Audio surface the installer touches -----------------------------
// Nodes record their outgoing connect()/disconnect() so we can read back the final graph.
function mockNode(kind) {
  return {
    kind,
    out: [],
    connect(dest) { this.out.push(dest); return dest; },
    disconnect() { this.out.length = 0; },
  };
}
function mockGain() { const n = mockNode('gain'); n.gain = { value: 1 }; return n; }
function mockCompressor() {
  const n = mockNode('compressor');
  for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = { value: null };
  return n;
}
function mockCtx(opts = {}) {
  const destination = mockNode('destination');
  return {
    destination,
    createGain: opts.noGain ? undefined : () => mockGain(),
    createDynamicsCompressor: opts.noComp
      ? undefined
      : (opts.throwComp ? () => { throw new Error('boom'); } : () => mockCompressor()),
  };
}
// A THREE.AudioListener stand-in: its own gain node wired to destination (THREE's default hop).
function mockListener(ctx) {
  const gain = mockGain();
  gain.connect(ctx.destination); // the direct connection our installer must REPLACE
  return { gain, context: ctx };
}

// ---------------------------------------------------------------------------
// A) CONFIG sanity — the tuning must actually behave like a brickwall-ish limiter with headroom.
// ---------------------------------------------------------------------------
console.log('\nA) config is a sane limiter with headroom');
{
  const c = MASTER_LIMITER;
  ok(typeof c.threshold === 'number' && c.threshold < 0 && c.threshold >= -12,
    `ceiling below 0dBFS and sane (threshold=${c.threshold}dB)`);
  ok(typeof c.ratio === 'number' && c.ratio >= 10, `ratio is limiter-grade (>=10): ${c.ratio}`);
  ok(typeof c.knee === 'number' && c.knee >= 0 && c.knee <= 3, `knee near-hard (brickwall-ish): ${c.knee}`);
  ok(typeof c.attack === 'number' && c.attack > 0 && c.attack <= 0.01, `attack is fast (<=10ms): ${c.attack}s`);
  ok(typeof c.release === 'number' && c.release >= 0.05 && c.release <= 0.5, `release is smooth (0.05-0.5s): ${c.release}s`);
  ok(typeof c.preGain === 'number' && c.preGain > 0 && c.preGain < 1, `pre-limiter headroom trim in (0,1): ${c.preGain}`);
}

// ---------------------------------------------------------------------------
// B) INSTALL builds the right nodes and rewires the graph so the limiter is truly in the path.
// ---------------------------------------------------------------------------
console.log('\nB) install wires listener.gain -> preGain -> limiter -> destination');
{
  const ctx = mockCtx();
  const listener = mockListener(ctx);
  const chain = installMasterLimiter(listener);

  ok(chain && chain.preGain && chain.limiter, 'install returns the { preGain, limiter } chain');
  if (chain) {
    ok(chain.preGain.kind === 'gain' && chain.limiter.kind === 'compressor',
      'preGain is a GainNode and limiter is a DynamicsCompressorNode');
    // Params landed on the real nodes:
    ok(chain.preGain.gain.value === MASTER_LIMITER.preGain, `preGain.gain=${chain.preGain.gain.value} (headroom trim)`);
    ok(chain.limiter.threshold.value === MASTER_LIMITER.threshold, `limiter.threshold=${chain.limiter.threshold.value}`);
    ok(chain.limiter.knee.value === MASTER_LIMITER.knee, `limiter.knee=${chain.limiter.knee.value}`);
    ok(chain.limiter.ratio.value === MASTER_LIMITER.ratio, `limiter.ratio=${chain.limiter.ratio.value}`);
    ok(chain.limiter.attack.value === MASTER_LIMITER.attack, `limiter.attack=${chain.limiter.attack.value}`);
    ok(chain.limiter.release.value === MASTER_LIMITER.release, `limiter.release=${chain.limiter.release.value}`);
    // Graph: gain now feeds preGain (NOT destination directly), preGain feeds limiter, limiter feeds destination.
    ok(listener.gain.out.length === 1 && listener.gain.out[0] === chain.preGain,
      'listener.gain now feeds ONLY the preGain (default direct gain->destination hop removed)');
    ok(!listener.gain.out.includes(ctx.destination), 'listener.gain no longer connects straight to destination');
    ok(chain.preGain.out.length === 1 && chain.preGain.out[0] === chain.limiter, 'preGain -> limiter');
    ok(chain.limiter.out.length === 1 && chain.limiter.out[0] === ctx.destination, 'limiter -> destination (the ceiling is last)');
  }
}

// ---------------------------------------------------------------------------
// C) FAIL-SILENT — audio unavailable or a throwing context must never throw and must not go silent.
// ---------------------------------------------------------------------------
console.log('\nC) fail-silent: null/absent audio never throws, direct connection preserved');
{
  let threw = false;
  try {
    ok(installMasterLimiter(null) === null, 'null listener -> null (no throw)');
    ok(installMasterLimiter({}) === null, 'listener without gain/context -> null');
    ok(installMasterLimiter({ gain: mockGain(), context: mockCtx({ noComp: true }) }) === null,
      'context lacking createDynamicsCompressor -> null (older/limited browser)');
    ok(installMasterLimiter({ gain: mockGain(), context: mockCtx({ noGain: true }) }) === null,
      'context lacking createGain -> null');

    // A context that THROWS mid-install must be caught AND leave audio playing via a direct hop.
    const ctx = mockCtx({ throwComp: true });
    const listener = mockListener(ctx);
    const chain = installMasterLimiter(listener);
    ok(chain === null, 'a throwing createDynamicsCompressor -> null (caught, not propagated)');
    ok(listener.gain.out.length === 1 && listener.gain.out[0] === ctx.destination,
      'after a failed install, listener.gain is restored to a DIRECT destination connection (audio not silenced)');
  } catch (e) {
    threw = true;
    console.error('    (installer threw: ' + e.message + ')');
  }
  ok(!threw, 'installMasterLimiter never throws to the caller (audio must not break the game)');
}

// ---------------------------------------------------------------------------
// D) ROUTING (source): the game installs the limiter at the one listener, and every audio path
//    (positional taunts + UI sounds) emits through that SAME listener → all covered by one insert.
// ---------------------------------------------------------------------------
console.log('\nD) scene.js routes all audio through the limited listener; unlock/taunt logic untouched');
{
  const scene = readText('js', 'scene.js');
  ok(/import\s*\{\s*installMasterLimiter\s*\}\s*from\s*['"][^'"]*audio-limiter\.js['"]/.test(scene),
    'scene.js imports installMasterLimiter from the shared module');
  ok(/_ensureMasterLimiter\s*\(\)/.test(scene), 'scene.js defines/calls _ensureMasterLimiter');
  // The install must hang off _ensureAudioListener so it's spliced the moment the listener exists,
  // before any emitter plays.
  const ensureListener = (scene.match(/_ensureAudioListener\s*\(\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(ensureListener.includes('_ensureMasterLimiter'),
    '_ensureAudioListener installs the limiter (so it is in place before any sound plays)');

  // BOTH sound paths build their node from the listener → both feed listener.gain → the limiter.
  const playTaunt = (scene.match(/playTaunt\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(/new THREE\.PositionalAudio\(\s*listener\s*\)/.test(playTaunt),
    'playTaunt emits PositionalAudio(listener) → routes through the limiter');
  const playUi = (scene.match(/playUiSound\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(/new THREE\.Audio\(\s*listener\s*\)/.test(playUi),
    'playUiSound emits THREE.Audio(listener) → routes through the limiter');

  // Per-source trim (limiter is a safety net, not the mixer): taunt emitters are pulled below 1.0.
  ok(/setVolume\(0?\.\d+\)/.test(playTaunt), 'playTaunt applies a per-source volume trim (<1.0)');

  // Untouched: the iOS unlock path stays as-is (resume the shared ctx inside a gesture).
  ok(/unlockAudio\s*\(\)\s*\{[\s\S]*?ctx\.resume\(\)/.test(scene), 'unlockAudio (iOS gesture resume) is untouched');
  // Constructor still declares the limiter handles (kept null until installed).
  ok(/this\._masterLimiter\s*=\s*null/.test(scene), 'scene declares _masterLimiter (null until installed)');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll audio-limiter checks passed.');
process.exit(fails ? 1 : 0);
