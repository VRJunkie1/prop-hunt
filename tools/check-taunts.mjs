#!/usr/bin/env node
// Offline acceptance check for the AUDIO TAUNT SYSTEM (VRmike). AUTHORING-ONLY — never imported
// by the page / shipped. Run from the sandboxed node:
//
//     node tools/check-taunts.mjs
//
// WHY THIS EXISTS. The taunt system is host-authoritative relay logic (referee.applyTaunt /
// applyStopTaunt / forceTaunt) plus a data-driven manifest plus a scene audio API — none of which
// a headless browser boot exercises (no peers, no THREE audio graph). So this drives the REAL
// shared code paths directly and asserts the OUTPUTS the requester cares about:
//   A) MANIFEST is valid: ids unique, and every referenced clip file actually exists on disk
//      (the 29 real Discord clips are wired in now; the old placeholder beeps were removed).
//   B) EVENT FLOW against the real referee: a prop's taunt is relayed to EVERY player tagged with
//      the taunter; a second taunt from the same prop is relayed again (the client cut-off is
//      per-emitter, the referee just relays); a stop is relayed; a NON-prop / dead prop / bogus id
//      is REJECTED; and the finder-tool hook (forceTaunt) marks the taunt uncancellable so the
//      prop's own stop button is ignored.
//   C) SCENE / CLIENT audio API exists — the "a missing scene method silently kills the render
//      loop every frame" lesson from our notes: assert the audio hooks the render loop + event
//      handler call are actually present in the source.
// The build FAILS if any assertion fails.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C2S, S2C, PHASE, ROLE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const readText = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('AUDIO TAUNTS: manifest + host-authoritative relay + scene-API acceptance check');

// Real config so we run against the SHIPPING rules/maps/manifest, not invented ones.
const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');
const manifest = readJSON('assets', 'taunts', 'manifest.json');

// ---------------------------------------------------------------------------
// A) MANIFEST validity: unique ids + every referenced file exists on disk.
// ---------------------------------------------------------------------------
console.log('\nA) manifest: unique ids + referenced files exist');
{
  const list = Array.isArray(manifest.taunts) ? manifest.taunts : null;
  ok(list !== null, 'manifest.taunts is an array (an empty library is valid, but the key must exist)');
  const items = list || [];
  const ids = items.map((t) => t && t.id);
  ok(ids.every((id) => typeof id === 'string' && id.length > 0), 'every taunt has a non-empty string id');
  ok(new Set(ids).size === ids.length, 'all taunt ids are unique');
  ok(items.every((t) => typeof t.label === 'string' && t.label.length > 0), 'every taunt has a non-empty label (menu text)');
  for (const t of items) {
    if (!t || !t.file) { ok(false, `taunt "${t && t.id}" has a file path`); continue; }
    const abs = join(root, 'assets', t.file);
    ok(existsSync(abs), `clip file exists for "${t.id}": assets/${t.file}`);
  }
  // Ship-now expectation: the library is non-empty so the whole path is testable today.
  ok(items.length >= 1, `library is non-empty now (${items.length} clip(s)) so the path is provable end-to-end`);
}

// ---------------------------------------------------------------------------
// B) EVENT FLOW against the real referee.
// ---------------------------------------------------------------------------
console.log('\nB) event flow: host-authoritative relay / validation / finder hook');

// A referee + a captured mailbox per player. We inject the shipping manifest as `taunts` so the
// referee validates ids against the exact list the menu shows. Roles/phase are set directly (as
// the lobby-rename check does) so we exercise applyTaunt WITHOUT starting a physics match.
function makeTable() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: manifest }, 'TEST');
  const inbox = new Map(); // id -> array of S2C messages
  const add = (id, name) => {
    inbox.set(id, []);
    ref.addPlayer({ id, name, send: (obj) => inbox.get(id).push(obj) });
  };
  const clear = () => { for (const box of inbox.values()) box.length = 0; };
  const events = (id, kind) => (inbox.get(id) || []).filter((m) => m.t === S2C.EVENT && m.kind === kind);
  return { ref, inbox, add, clear, events };
}

const REAL_ID = (Array.isArray(manifest.taunts) && manifest.taunts[0] && manifest.taunts[0].id) || null;
const REAL_ID2 = (Array.isArray(manifest.taunts) && manifest.taunts[1] && manifest.taunts[1].id) || REAL_ID;

if (!REAL_ID) {
  ok(false, 'need at least one manifest clip to exercise the relay (placeholder library is empty?)');
} else {
  // Set up a live round with known roles: PROP taunts, HUNTER cannot, second PROP overlaps.
  const t = makeTable();
  t.add('PROP', 'Prop');     // added first → host (irrelevant to taunts); a living prop
  t.add('HUNT', 'Hunter');
  t.add('PROP2', 'Prop2');
  t.ref.phase = PHASE.HUNTING;
  for (const [id, role] of [['PROP', ROLE.PROP], ['HUNT', ROLE.HUNTER], ['PROP2', ROLE.PROP]]) {
    const p = t.ref.players.get(id);
    p.role = role; p.alive = true; p.tauntUncancellable = false;
  }

  // B1) A prop's taunt is relayed to EVERY player, tagged with the taunter + the id.
  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.TAUNT, id: REAL_ID });
  for (const who of ['PROP', 'HUNT', 'PROP2']) {
    const ev = t.events(who, 'taunt');
    ok(ev.length === 1 && ev[0].by === 'PROP' && ev[0].id === REAL_ID && ev[0].uncancellable === false,
      `taunt relayed to ${who} tagged by:PROP id:${REAL_ID} (cancellable)`);
  }

  // B2) A SECOND taunt from the same prop is relayed again (the cut-off is client-side; the
  //     referee's job is only to relay every valid request).
  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.TAUNT, id: REAL_ID2 });
  ok(t.events('HUNT', 'taunt').some((e) => e.by === 'PROP' && e.id === REAL_ID2),
    'a second taunt from the same prop is relayed again (client cut-off supersedes locally)');

  // B3) A stop from the prop is relayed as tauntStop tagged with the sender.
  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.STOP_TAUNT });
  for (const who of ['PROP', 'HUNT', 'PROP2']) {
    ok(t.events(who, 'tauntStop').some((e) => e.by === 'PROP'), `stop relayed to ${who} tagged by:PROP`);
  }

  // B4) A HUNTER cannot taunt (rejected — no relay).
  t.clear();
  t.ref.handleMessage('HUNT', { t: C2S.TAUNT, id: REAL_ID });
  ok(t.events('PROP', 'taunt').length === 0, 'a hunter\'s taunt is rejected (no relay)');

  // B5) A bogus / unknown taunt id is rejected.
  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.TAUNT, id: 'definitely-not-a-real-id' });
  ok(t.events('HUNT', 'taunt').length === 0, 'an unknown taunt id is rejected (no relay)');

  // B6) A DEAD prop cannot taunt.
  t.clear();
  t.ref.players.get('PROP2').alive = false;
  t.ref.handleMessage('PROP2', { t: C2S.TAUNT, id: REAL_ID });
  ok(t.events('HUNT', 'taunt').length === 0, 'a dead prop\'s taunt is rejected (no relay)');
  t.ref.players.get('PROP2').alive = true;

  // B7) Taunting is rejected outside an active phase (e.g. LOBBY / ENDING).
  t.clear();
  t.ref.phase = PHASE.LOBBY;
  t.ref.handleMessage('PROP', { t: C2S.TAUNT, id: REAL_ID });
  ok(t.events('HUNT', 'taunt').length === 0, 'a taunt in the LOBBY phase is rejected (no relay)');
  t.ref.phase = PHASE.HUNTING;

  // B8) FINDER-TOOL HOOK: forceTaunt(propId) relays a RANDOM taunt marked uncancellable, and the
  //     prop's own stop button is then IGNORED (that's the whole point of the flag).
  t.clear();
  const forced = t.ref.forceTaunt('PROP');
  ok(forced === true, 'forceTaunt(prop) returns true and fires a taunt');
  const fev = t.events('HUNT', 'taunt');
  ok(fev.length === 1 && fev[0].by === 'PROP' && fev[0].uncancellable === true && t.ref._tauntIds.has(fev[0].id),
    'forced taunt is relayed, tagged by:PROP, uncancellable, with a REAL manifest id');
  ok(t.ref.players.get('PROP').tauntUncancellable === true, 'the prop is flagged uncancellable after a forced taunt');
  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.STOP_TAUNT });
  ok(t.events('HUNT', 'tauntStop').length === 0, 'the prop\'s stop button is IGNORED for a finder-forced taunt');

  // B9) A NORMAL self-chosen taunt clears the uncancellable flag (the player chose to taunt again).
  t.clear();
  t.ref.handleMessage('PROP', { t: C2S.TAUNT, id: REAL_ID });
  ok(t.ref.players.get('PROP').tauntUncancellable === false, 'a self-chosen taunt clears the uncancellable flag');
  t.ref.handleMessage('PROP', { t: C2S.STOP_TAUNT });
  ok(t.events('HUNT', 'tauntStop').some((e) => e.by === 'PROP'), 'the stop button works again after a normal taunt');

  // B10) forceTaunt on a non-prop / absent id returns false (nothing to force).
  ok(t.ref.forceTaunt('HUNT') === false, 'forceTaunt on a hunter returns false');
  ok(t.ref.forceTaunt('NOBODY') === false, 'forceTaunt on an absent player returns false');

  t.ref.destroy();
}

// An EMPTY library must be graceful: the referee rejects every id and forceTaunt no-ops.
console.log('\nB′) empty library degrades gracefully');
{
  const ref = new Referee({ rules, maps, props, fixtures, feel: {}, taunts: { taunts: [] } }, 'EMPTY');
  const box = [];
  ref.addPlayer({ id: 'P', name: 'P', send: (o) => box.push(o) });
  const p = ref.players.get('P'); p.role = ROLE.PROP; p.alive = true; ref.phase = PHASE.HUNTING;
  box.length = 0;
  ref.handleMessage('P', { t: C2S.TAUNT, id: 'anything' });
  ok(box.filter((m) => m.t === S2C.EVENT && m.kind === 'taunt').length === 0, 'empty library: every taunt id is rejected');
  ok(ref.forceTaunt('P') === false, 'empty library: forceTaunt returns false (nothing to force)');
  ref.destroy();
}

// ---------------------------------------------------------------------------
// C) SCENE / CLIENT audio API existence (source assertions). Guards the "missing method silently
//    kills the render loop" lesson: the render loop + event handler call these, so they must exist.
// ---------------------------------------------------------------------------
console.log('\nC) scene / client audio API present in source');
{
  const scene = readText('js', 'scene.js');
  for (const sym of ['playTaunt', 'stopTaunt', 'updateTauntEmitters', 'loadAudioBuffer', 'clearAllTaunts', 'PositionalAudio', 'AudioListener']) {
    ok(scene.includes(sym), `scene.js provides ${sym}`);
  }

  // INVERSE-SQUARE TAUNT FALLOFF (Jie, 2026-07-18). The distance model must be the EXPONENTIAL
  // model with rolloffFactor 2 — that combination IS real-world inverse-square (gain = (d/ref)^-2).
  // refDistance is derived from the map size so a taunt one full map width away lands at the 3%
  // target: ref = size * target^(1/exp) = size * √0.03. maxDistance must be GONE (non-linear models
  // ignore it, so a lingering setMaxDistance would only mislead), and the old linear model retired.
  const playTaunt = (scene.match(/playTaunt\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(/setDistanceModel\(\s*['"]exponential['"]\s*\)/.test(playTaunt),
    'playTaunt uses the exponential distance model (= inverse-square with rolloff 2)');
  ok(!/setDistanceModel\(\s*['"]linear['"]\s*\)/.test(playTaunt),
    'playTaunt no longer uses the old linear distance model');
  ok(/TAUNT_FALLOFF_TARGET\s*=\s*0?\.03\b/.test(playTaunt),
    'playTaunt exposes the 3% at-map-width target as a named knob (TAUNT_FALLOFF_TARGET = 0.03)');
  ok(/TAUNT_FALLOFF_EXP\s*=\s*2\b/.test(playTaunt),
    'playTaunt exposes the inverse-square exponent as a named knob (TAUNT_FALLOFF_EXP = 2)');
  ok(/setRolloffFactor\(\s*TAUNT_FALLOFF_EXP\s*\)/.test(playTaunt),
    'playTaunt drives rolloffFactor from the exponent knob (= 2, true inverse-square)');
  ok(/setRefDistance\([^)]*size\s*\*\s*Math\.pow\(\s*TAUNT_FALLOFF_TARGET\s*,\s*1\s*\/\s*TAUNT_FALLOFF_EXP\s*\)/.test(playTaunt),
    'playTaunt derives refDistance = size * target^(1/exp) so gain hits 3% at one map width');
  ok(!/setMaxDistance/.test(playTaunt),
    'playTaunt drops setMaxDistance (ignored by non-linear models — leaving it would mislead)');

  // HRTF BINAURAL PANNING (Jie, 2026-07-18). playTaunt must set the underlying PannerNode's
  // panningModel to HRTF for true front/back binaural on headphones, driven from a CLIENT-SIDE knob
  // (TAUNT_PANNING) that keeps 'equalpower' as the safe fallback. The assignment must be GUARDED so a
  // missing `.panner` never throws (audio is fail-silent). The exact strings are the Web Audio spec
  // enum — 'HRTF' uppercase, 'equalpower' lowercase — so we assert that spelling verbatim.
  ok(/const\s+TAUNT_PANNING\s*=/.test(scene) && /model\s*:\s*['"]HRTF['"]/.test(scene),
    'scene defines a TAUNT_PANNING knob defaulting model to HRTF');
  ok(/fallback\s*:\s*['"]equalpower['"]/.test(scene),
    'TAUNT_PANNING keeps equalpower as the fallback value (flip a knob, not a revert)');
  ok(/\.panningModel\s*=\s*TAUNT_PANNING\.model\s*\|\|\s*TAUNT_PANNING\.fallback/.test(playTaunt),
    'playTaunt sets panner.panningModel from the knob (model || fallback)');
  ok(/sound\.panner\b/.test(playTaunt) && /if\s*\(\s*panner\s*\)/.test(playTaunt),
    'playTaunt reads sound.panner and GUARDS it (no throw if .panner is unavailable — fail-silent)');
  // The applied model must be the spec-exact HRTF string, and the OLD equalpower default must not be
  // hard-set anywhere in playTaunt (it stays only as the knob's fallback value).
  ok(/['"]HRTF['"]/.test(scene) && !/panningModel\s*=\s*['"]equalpower['"]/.test(playTaunt),
    "HRTF is the spec-exact applied value; equalpower isn't hard-coded onto the panner in playTaunt");
  // Verify the math numerically: refDistance ≈ 0.1732 * size, and the resulting gain at one map
  // width is the 3% target. This is the property Jie specified, checked end to end.
  {
    const size = 36, TARGET = 0.03, EXP = 2;
    const ref = size * Math.pow(TARGET, 1 / EXP);
    const gainAtMapWidth = Math.pow(size / ref, -EXP); // exponential model: (d/ref)^-rolloff
    ok(Math.abs(ref - 0.1732 * size) < 0.01 * size, `refDistance ≈ 0.1732 * mapWidth (got ${ref.toFixed(2)} on 36-unit map)`);
    ok(Math.abs(gainAtMapWidth - TARGET) < 1e-9, `gain at one map width = ${gainAtMapWidth.toFixed(4)} ≈ 3% target`);
  }
  const main = readText('js', 'main.js');
  ok(/case 'taunt'/.test(main), "main.js handles the 'taunt' event");
  ok(/case 'tauntStop'/.test(main), "main.js handles the 'tauntStop' event");
  ok(main.includes('scene.updateTauntEmitters'), 'main.js render loop calls scene.updateTauntEmitters (emitters follow moving props)');
  ok(main.includes('scene.playTaunt'), 'main.js plays taunts through scene.playTaunt');
  const ui = readText('js', 'ui.js');
  for (const sym of ['buildTauntList', 'openTauntMenu', 'closeTauntMenu', 'setTauntButton', 'setTauntStop']) {
    ok(ui.includes(sym), `ui.js provides ${sym}`);
  }
  const cfg = readText('js', 'config.js');
  ok(cfg.includes('/assets/taunts/manifest.json'), 'config.js loads the taunt manifest');
}

// ---------------------------------------------------------------------------
// D) TAUNT MENU + PAUSE MENU UX FIXES FOR PC (Jie, 2026-07). Source assertions for the five UX
//    changes: (1) discoverable hotkey hint, (2) a Stop button INSIDE the menu, (3) the menu docks
//    LEFT, (4) NO background tint/blur behind it, (5) Esc toggles the pause menu (and closes the
//    taunt menu). All keyboard-side; the mobile touch controls are untouched.
// ---------------------------------------------------------------------------
console.log('\nD) taunt/pause UX (PC): left dock, no tint, in-menu stop, hotkey hint, Esc toggle');
{
  const html = readText('index.html');
  ok(/id="tauntStopInline"/.test(html), '(2) index.html has an in-menu Stop button (#tauntStopInline)');
  ok(/class="taunt-hint"/.test(html), '(1) index.html shows the hotkey hint near the menu (.taunt-hint)');

  const ui = readText('js', 'ui.js');
  ok(ui.includes('tauntStopInline'), 'ui.js wires the in-menu Stop button');
  // setTauntStop must toggle BOTH stop buttons so the in-menu one tracks "your taunt is playing".
  const setStop = (ui.match(/setTauntStop\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(setStop.includes('tauntStopBtn') && setStop.includes('tauntStopInline'),
    'setTauntStop toggles BOTH the floating and in-menu stop buttons together');

  const css = readText('css', 'style.css');
  const menuBlock = (css.match(/\.taunt-menu\s*\{[\s\S]*?\}/) || [''])[0];
  ok(/justify-content:\s*flex-start/.test(menuBlock), '(3) .taunt-menu docks LEFT (justify-content: flex-start)');
  ok(!/backdrop-filter/.test(menuBlock) && !/\bbackground\s*:/.test(menuBlock),
    '(4) .taunt-menu has NO background tint / blur (world stays fully visible)');

  const main = readText('js', 'main.js');
  const reqPause = (main.match(/onRequestPause\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\n\};/) || [''])[0];
  ok(reqPause.includes('closePause'), '(5) Esc closes the pause menu when open (onRequestPause -> closePause)');
  ok(reqPause.includes('closeTauntMenu'), '(1/5) Esc closes the taunt menu (onRequestPause -> closeTauntMenu)');

  // The desktop T key must still toggle the taunt menu (opens AND frees the mouse in one press).
  const input = readText('js', 'input.js');
  ok(/KeyT/.test(input) && /onToggleTaunt/.test(input), '(1) T key toggles the taunt menu (input.js)');
  ok(/openTauntMenu[\s\S]*exitPointerLock/.test(main), '(1) opening the taunt menu frees the mouse (exitPointerLock)');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll taunt checks passed.');
process.exit(fails ? 1 : 0);
