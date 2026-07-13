#!/usr/bin/env node
// Offline acceptance check for LOBBY NAME CHANGES (VRmike). AUTHORING-ONLY — never
// imported by the page / shipped. Run from a shell:
//
//     node tools/check-lobby-rename.mjs
//
// WHY THIS EXISTS. Letting any player rename themselves in the lobby is host-authoritative
// roster logic (referee.applyRename) that a headless browser boot can't exercise (no peers,
// no lobby round-trip). So this drives the REAL shared code path directly and asserts the
// OUTPUTS the requester cares about:
//   A) a NON-HOST peer's rename updates the shared roster AND the rebroadcast (S2C.LOBBY)
//      carries the new name to every connected peer (the core requirement);
//   B) the host cleans it up: trims whitespace, caps length (~16), REJECTS empty names,
//      and de-dupes so two players never share a name (auto-suffix);
//   C) the host can rename ITSELF the same way (no special-casing);
//   D) a rename mid-round is IGNORED (lobby-only) so scoreboards stay stable;
//   E) a rename can only touch the SENDER (the referee resolves the player by connection id,
//      never a name/id in the payload) — an unknown sender is a no-op.
// The build FAILS if any assertion fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C2S, S2C, PHASE } from '../shared/protocol.js';
import { Referee } from '../shared/referee.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJSON = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

let fails = 0;
const ok = (cond, msg) => {
  console[cond ? 'log' : 'error']((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails++;
};

console.log('LOBBY NAME CHANGES: host-authoritative rename acceptance check');

// Real config so we run against the SHIPPING rules/maps, not invented ones.
const rules = readJSON('shared', 'config', 'rules.json');
const maps = readJSON('shared', 'config', 'maps.json');
const props = readJSON('shared', 'config', 'props.json');
const fixtures = readJSON('shared', 'config', 'fixtures.json');

// A referee + a captured mailbox per player: whatever the referee `send()`s to that player
// lands in its inbox, so we can inspect the rebroadcast every peer actually receives.
function makeTable() {
  const ref = new Referee({ rules, maps, props, fixtures, feel: {} }, 'TEST');
  const inbox = new Map(); // id -> array of S2C messages
  const add = (id, name) => {
    inbox.set(id, []);
    ref.addPlayer({ id, name, send: (obj) => inbox.get(id).push(obj) });
  };
  const lastLobby = (id) => {
    const box = inbox.get(id) || [];
    for (let i = box.length - 1; i >= 0; i--) if (box[i].t === S2C.LOBBY) return box[i];
    return null;
  };
  const nameFor = (lobby, id) => {
    const e = lobby && lobby.players.find((p) => p.id === id);
    return e ? e.name : undefined;
  };
  return { ref, inbox, add, lastLobby, nameFor };
}

// ---------------------------------------------------------------------------
// A) A NON-HOST peer's rename updates the roster AND rides the rebroadcast to everyone.
// ---------------------------------------------------------------------------
console.log('\nA) non-host rename → shared roster + rebroadcast to all peers');
{
  const t = makeTable();
  t.add('HOST', 'Host');   // added first → becomes host
  t.add('GUEST', 'Guest'); // an invite-link peer (non-host)
  ok(t.ref.hostId === 'HOST', 'first player added is the host; GUEST is a non-host peer');

  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: '  New Name  ' });

  ok(t.ref.players.get('GUEST').name === 'New Name', 'roster updated + whitespace trimmed (referee is authoritative)');
  // The rebroadcast every peer receives carries the new name — check the HOST's inbox AND
  // the renamer's own inbox (both are "connected peers").
  ok(t.nameFor(t.lastLobby('HOST'), 'GUEST') === 'New Name', "HOST's rebroadcast LOBBY carries GUEST's new name");
  ok(t.nameFor(t.lastLobby('GUEST'), 'GUEST') === 'New Name', "GUEST's own rebroadcast LOBBY carries the new name");
  // Nobody else's name moved.
  ok(t.nameFor(t.lastLobby('HOST'), 'HOST') === 'Host', 'the other player\'s name is unchanged');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// B) Host cleans it up: length cap, empty rejection, de-dupe.
// ---------------------------------------------------------------------------
console.log('\nB) host cleanup: length cap / empty rejection / de-dupe');
{
  const t = makeTable();
  t.add('HOST', 'Host');
  t.add('GUEST', 'Guest');

  // Length cap (~16). 30 chars in → 16 out.
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: 'x'.repeat(30) });
  const capped = t.ref.players.get('GUEST').name;
  ok(capped.length === 16, `over-long name capped to 16 chars (got ${capped.length})`);

  // Empty / whitespace-only → REJECTED (keep the current name, no rebroadcast churn).
  const before = t.ref.players.get('GUEST').name;
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: '    ' });
  ok(t.ref.players.get('GUEST').name === before, 'empty/whitespace name rejected — current name kept');
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: '' });
  ok(t.ref.players.get('GUEST').name === before, 'empty-string name rejected too');

  // De-dupe: GUEST tries to take HOST's exact name → gets an auto-suffix, never a clash.
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: 'Host' });
  const deduped = t.ref.players.get('GUEST').name;
  ok(deduped !== 'Host' && deduped.toLowerCase().startsWith('host'), `duplicate name auto-suffixed (got "${deduped}")`);
  ok(t.ref.players.get('HOST').name === 'Host', 'the original holder of the name is untouched');
  // Case-insensitive clash too.
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: 'HOST' });
  ok(t.ref.players.get('GUEST').name.toLowerCase() !== 'host', 'case-insensitive duplicate also disambiguated');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// C) The HOST can rename itself the same way (no special-casing).
// ---------------------------------------------------------------------------
console.log('\nC) host renames itself');
{
  const t = makeTable();
  t.add('HOST', 'Host');
  t.add('GUEST', 'Guest');
  t.ref.handleMessage('HOST', { t: C2S.RENAME, name: 'Chief' });
  ok(t.ref.players.get('HOST').name === 'Chief', 'host renamed itself');
  ok(t.nameFor(t.lastLobby('GUEST'), 'HOST') === 'Chief', "the guest's lobby sees the host's new name");
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// D) Lobby-only: a rename during a live round is ignored.
// ---------------------------------------------------------------------------
console.log('\nD) rename mid-round is ignored (lobby-only)');
{
  const t = makeTable();
  t.add('HOST', 'Host');
  t.add('GUEST', 'Guest');
  t.ref.phase = PHASE.HUNTING; // simulate a live round
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: 'MidMatch' });
  ok(t.ref.players.get('GUEST').name === 'Guest', 'name unchanged while HUNTING');
  t.ref.phase = PHASE.HIDING;
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: 'MidHide' });
  ok(t.ref.players.get('GUEST').name === 'Guest', 'name unchanged while HIDING');
  // Back in the lobby it works again.
  t.ref.phase = PHASE.LOBBY;
  t.ref.handleMessage('GUEST', { t: C2S.RENAME, name: 'BackInLobby' });
  ok(t.ref.players.get('GUEST').name === 'BackInLobby', 'rename works again back in the lobby');
  t.ref.destroy();
}

// ---------------------------------------------------------------------------
// E) A rename can only touch the SENDER; an unknown sender is a no-op.
// ---------------------------------------------------------------------------
console.log('\nE) rename is self-only (resolved by connection id) — unknown sender is a no-op');
{
  const t = makeTable();
  t.add('HOST', 'Host');
  t.add('GUEST', 'Guest');
  // There is no target id/name in the payload — the referee resolves the player by the
  // connection id it was received on, so a peer can only ever rename itself. A message
  // from an id that isn't a player must change nothing (handleMessage returns early).
  t.ref.handleMessage('GHOST', { t: C2S.RENAME, name: 'Injected' });
  ok(t.ref.players.get('HOST').name === 'Host' && t.ref.players.get('GUEST').name === 'Guest',
    'a rename from an unknown/absent sender changes no one');
  t.ref.destroy();
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll lobby-rename checks passed.');
process.exit(fails ? 1 : 0);
