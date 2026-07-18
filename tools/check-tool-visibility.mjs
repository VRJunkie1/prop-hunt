#!/usr/bin/env node
// Offline acceptance check for HELD-TOOL VISIBILITY (B7, 2026-07-18, VRmike).
// AUTHORING-ONLY — never imported by the page or shipped to a browser (like
// tools/check-flicker.mjs / check-blindfold.mjs). Run from a shell:
//
//     node tools/check-tool-visibility.mjs
//
// WHY THIS EXISTS. Other players used to see the hunter holding a RIFLE no matter what — a
// hunter who switched to the grenade or the prop finder still looked armed with a gun on
// everyone else's screen. B7 syncs the hunter's SELECTED tool (host-authoritative relay) and
// swaps the item shown on their third-person model. A headless check can't RENDER the swap, so
// it asserts the wire contract + the code path, statically, and guards the two bug classes this
// repo has been burned by before: (1) a scene.*() method called but never defined (blank render
// loop), and (2) a player-attached mesh left cullable (the strobe — covered by check-flicker).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

// Pull out a named function/method body: from `NAME(...) {` to the matching close brace.
function extractFn(src, name) {
  const m = new RegExp('(?:function\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!m) return '';
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return src.slice(m.index);
}

console.log('held-tool visibility (B7) acceptance check');

const protoSrc = read('shared', 'protocol.js');
const refSrc = read('shared', 'referee.js');
const sceneSrc = read('js', 'scene.js');
const mainSrc = read('js', 'main.js');

// ---------------------------------------------------------------------------
// 1) THE WIRE CONTRACT. A new C2S.SELECT_TOOL and one canonical tool-id list, plus the `tool`
//    field documented on the snapshot. The id list is the ONE source of truth both sides read.
// ---------------------------------------------------------------------------
ok(/SELECT_TOOL:\s*'selectTool'/.test(protoSrc), 'protocol: C2S.SELECT_TOOL is defined');
const idsMatch = /export const HUNTER_TOOL_IDS\s*=\s*\[([^\]]*)\]/.exec(protoSrc);
ok(!!idsMatch, 'protocol: HUNTER_TOOL_IDS is exported (canonical tool-id list)');
const sharedIds = idsMatch ? idsMatch[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, '')) : [];
for (const id of ['rifle', 'finder', 'grenade']) {
  ok(sharedIds.includes(id), `protocol: HUNTER_TOOL_IDS includes '${id}'`);
}
ok(/`tool`|tool,ack|health,tool/.test(protoSrc), 'protocol: the snapshot doc mentions the new `tool` field');

// ---------------------------------------------------------------------------
// 2) HOST-AUTHORITATIVE. The referee validates the sender + the id, stores tool, and rides it
//    in the snapshot. A modified client can only change its OWN held item (its choice), never
//    spoof another player's or push a bogus id.
// ---------------------------------------------------------------------------
ok(/HUNTER_TOOL_IDS/.test(refSrc) && /from '.\/protocol.js'/.test(refSrc), 'referee: imports HUNTER_TOOL_IDS from protocol (no drift with the client)');
ok(/case C2S\.SELECT_TOOL:\s*\n\s*this\.applySelectTool\(/.test(refSrc), 'referee: handleMessage routes C2S.SELECT_TOOL to applySelectTool');
const applySel = extractFn(refSrc, 'applySelectTool');
ok(applySel.length > 0, 'referee: defines applySelectTool()');
ok(/role\s*!==\s*ROLE\.HUNTER/.test(applySel) && /!\s*player\.alive|player\.alive/.test(applySel), 'referee: applySelectTool accepts only a LIVING HUNTER');
ok(/HUNTER_TOOL_IDS\.includes\(tool\)/.test(applySel), 'referee: applySelectTool rejects any id not in HUNTER_TOOL_IDS (no bogus tool)');
ok(/player\.tool\s*=\s*tool/.test(applySel), 'referee: applySelectTool stores the validated tool on the player');
// The snapshot must carry a COERCED tool for hunters (never an unknown/garbage id) and null for
// non-hunters (no meaningless tool on a prop).
ok(/tool:\s*p\.role\s*===\s*ROLE\.HUNTER\s*\?[^\n]*HUNTER_TOOL_IDS\.includes\(p\.tool\)[^\n]*:\s*null/.test(refSrc),
  'referee: broadcastSnapshot rides a COERCED `tool` per player (valid id for hunters, null otherwise)');
// tool resets to rifle wherever the other per-spawn/per-round fields reset (so a stale tool can't
// leak across a fresh spawn / round / lobby). Count the resets: addPlayer + _spawnOnTeam + the two
// round-reset loops = at least 4.
const toolResets = (refSrc.match(/(?:player|p)\.tool\s*=\s*'rifle'/g) || []).length;
ok(toolResets >= 4, `referee: player.tool resets to 'rifle' at every spawn/round/lobby seam (found ${toolResets}, expect >= 4)`);

// ---------------------------------------------------------------------------
// 3) THE RENDER SWAP. All three held meshes are pre-built on the wrist bone; _applyHeldTool
//    toggles which is visible; syncPlayers drives it from the snapshot `tool` each frame. Guards
//    the "scene method called but not defined" class: _applyHeldTool must exist AND be wired.
// ---------------------------------------------------------------------------
const buildHunter = extractFn(sceneSrc, '_buildHunterModel');
ok(/heldTools\s*=\s*\{\s*rifle:[^}]*finder:[^}]*grenade:/.test(buildHunter), '_buildHunterModel builds a heldTools { rifle, finder, grenade } set on the wrist bone');
ok(/for\s*\(const toolId of \['finder', 'grenade'\]\)/.test(buildHunter), '_buildHunterModel attaches the grenade + finder primitives (not just the rifle)');
ok(/heldTools,/.test(buildHunter), '_buildHunterModel stores heldTools on the animation controller');
const applyHeld = extractFn(sceneSrc, '_applyHeldTool');
ok(applyHeld.length > 0, 'scene.js defines _applyHeldTool() (the per-hunter tool swap)');
ok(/ctl\.heldTools\[toolId\]\s*\?\s*toolId\s*:\s*'rifle'/.test(applyHeld), '_applyHeldTool falls back to the rifle for an unknown/missing tool');
ok(/\.visible\s*=\s*k\s*===\s*id/.test(applyHeld), '_applyHeldTool shows ONLY the selected tool (others hidden)');
ok(/this\._applyHeldTool\(ctl,\s*'rifle'\)/.test(buildHunter), '_buildHunterModel seeds the rifle so a fresh model is not all-visible for a frame');
// syncPlayers drives it from the snapshot tool every frame — this is what makes a mid-game
// joiner (or a switch) reflect immediately.
ok(/this\._applyHeldTool\(entry\.hunterCtl,\s*p\.tool\)/.test(sceneSrc), 'syncPlayers applies each hunter entry.hunterCtl to the snapshot p.tool every frame');

// ---------------------------------------------------------------------------
// 4) THE CLIENT REPORTS ITS SELECTION. main.js sends C2S.SELECT_TOOL, deduped, only for a live
//    hunter, and its tool-bar id set stays a SUBSET of the shared canonical list (no drift).
// ---------------------------------------------------------------------------
const syncSel = extractFn(mainSrc, 'syncSelectedTool');
ok(syncSel.length > 0, 'main.js defines syncSelectedTool()');
ok(/C2S\.SELECT_TOOL/.test(syncSel), 'syncSelectedTool sends C2S.SELECT_TOOL to the host');
ok(/state\.toolSynced\s*===\s*state\.tool/.test(syncSel), 'syncSelectedTool dedupes (does not re-send an unchanged tool each snapshot)');
ok(/liveHunter/.test(syncSel), 'syncSelectedTool only reports for a LIVING HUNTER');
ok(/syncSelectedTool\(\)/.test(extractFn(mainSrc, 'applyToolView')), 'applyToolView calls syncSelectedTool (fires on select / role / alive change)');
const uiIdsMatch = /const HUNTER_TOOLS\s*=\s*\[([\s\S]*?)\];/.exec(mainSrc);
const uiIds = uiIdsMatch ? (uiIdsMatch[1].match(/id:\s*'([^']+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, '')) : [];
ok(uiIds.length > 0 && uiIds.every((id) => sharedIds.includes(id)), `main.js HUNTER_TOOLS ids ${JSON.stringify(uiIds)} are all in the shared HUNTER_TOOL_IDS (no drift)`);

// ---------------------------------------------------------------------------
if (fails) {
  console.error(`\nheld-tool visibility check FAILED (${fails} problem${fails > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log('\nheld-tool visibility check passed');
