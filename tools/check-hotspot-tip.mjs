#!/usr/bin/env node
// tools/check-hotspot-tip.mjs — acceptance guard for the HOTSPOT TIP on the "failed to find
// lobby" screen (VRmike, #devbot 2026-07-21). AUTHORING-ONLY, never shipped/imported. Run:
//
//     node tools/check-hotspot-tip.mjs
//
// WHY THIS EXISTS. The tip is static help text that must survive future UI refactors: a player
// who follows a join link and can't connect (the common cause: carrier NAT when everyone's on
// mobile data) needs the hotspot workaround right on the failure screen. A headless browser boot
// can't drive a real failed WebRTC join, so this asserts the wiring statically across the three
// files that make the tip appear ONLY in the failure state:
//   A) index.html renders a #hotspotTip box carrying BOTH parts — the how-to (one player hosts a
//      hotspot, everyone joins its local network) AND the client-isolation fallback.
//   B) js/ui.js — menuError() toggles the tip, and it defaults to HIDDEN (so "Connecting…", a
//      cleared error, and lobby validation never surface troubleshooting advice prematurely).
//   C) js/main.js — the connection-error path (the failed-to-find-lobby screen) shows the tip,
//      while the 'connecting' path does NOT.
// The build FAILS if any assertion fails.

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

// Normalise HTML entities + collapse whitespace so wording assertions don't hinge on markup
// details (&rsquo; vs ', &mdash;, line wraps).
const flat = (s) =>
  s
    .replace(/&rsquo;/g, "'")
    .replace(/&mdash;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

console.log('HOTSPOT TIP: failed-to-find-lobby help-text acceptance check');

// ---------------------------------------------------------------------------
// A) index.html renders the tip with BOTH parts of the wording.
// ---------------------------------------------------------------------------
console.log('\nA) index.html — #hotspotTip box carries the how-to AND the client-isolation note');
{
  const html = read('index.html');
  const m = html.match(/<div[^>]*id=["']hotspotTip["'][^>]*>([\s\S]*?)<\/div>/i);
  ok(!!m, 'a #hotspotTip element exists in the menu markup');
  const inner = flat(m ? m[1] : '');
  const outer = flat(m ? html.slice(m.index, m.index + m[0].length) : '');

  // Ships hidden by default — only the failure path unhides it.
  ok(/class=["'][^"']*\bhidden\b[^"']*["']/i.test(outer), 'the tip ships with the "hidden" class (revealed only on failure)');

  // Part 1 — the how-to: mobile-data framing, the hotspot fix, and the direct/local-network payoff.
  ok(/on mobile data/i.test(inner), 'how-to: names the mobile-data situation');
  ok(/carrier/i.test(inner), "how-to: explains it's the carrier network blocking peers");
  ok(/hotspot/i.test(inner), 'how-to: tells them to use a phone hotspot');
  ok(/\bhosts?\b/i.test(inner), 'how-to: the hotspot player hosts the game');
  ok(/local network/i.test(inner), 'how-to: promises a direct/local-network connection');

  // Part 2 — the client-isolation fallback (must NOT be dropped in wording polish).
  ok(/client isolation/i.test(inner), 'fallback: mentions client isolation by name');
  ok(/different phone/i.test(inner), 'fallback: suggests trying a different phone\'s hotspot');
}

// ---------------------------------------------------------------------------
// B) js/ui.js — menuError toggles the tip and defaults it hidden.
// ---------------------------------------------------------------------------
console.log('\nB) js/ui.js — menuError() drives #hotspotTip, hidden by default');
{
  const ui = read('js', 'ui.js');
  ok(/hotspotTip:\s*\$\(['"]hotspotTip['"]\)/.test(ui), 'ui caches the #hotspotTip element');
  // The signature carries an opt-in flag that DEFAULTS to hidden.
  ok(/menuError\s*\(\s*msg\s*,\s*showTip\s*=\s*false\s*\)/.test(ui), 'menuError(msg, showTip=false) — tip is opt-in, off by default');
  // The tip visibility is bound to that flag (hidden when !showTip).
  ok(/hotspotTip\.classList\.toggle\(\s*['"]hidden['"]\s*,\s*!showTip\s*\)/.test(ui), 'the tip is shown/hidden strictly by the showTip flag');
}

// ---------------------------------------------------------------------------
// C) js/main.js — the failure path shows the tip; 'connecting' does not.
// ---------------------------------------------------------------------------
console.log('\nC) js/main.js — tip rides the connect-error path, never the connecting path');
{
  const main = read('js', 'main.js');

  // The connecting status must NOT pass a truthy tip flag.
  const connecting = main.match(/ui\.menuError\(\s*['"]Connecting[^)]*\)/);
  ok(!!connecting, "found the 'Connecting…' menuError call");
  ok(connecting && !/,\s*true/.test(connecting[0]), "the 'Connecting…' call does NOT show the tip");

  // The error path (menu visible) DOES pass true.
  ok(/ui\.menuError\([^)]*,\s*true\s*\)/.test(main), 'the connection-error path shows the tip (menuError(..., true))');
}

console.log(fails ? `\nFAILED (${fails})` : '\nAll hotspot-tip checks passed.');
process.exit(fails ? 1 : 0);
