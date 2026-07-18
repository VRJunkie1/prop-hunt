# Combat SFX — gunshot / grenade / finder ping / size-pitched prop ouch

Built 2026-07-18 (VRmike, branch `build/145-b5-combat-sfx-playtest`), spec B5. Four synthesized combat
sounds added on top of the existing audio graph — NO gameplay/damage/netcode changes, only new client
listeners on events that were already broadcast. Everything is fail-silent (no audio backend → no-op)
and routes through the master limiter (465666e); per-source gains are modest so the limiter stays a
safety net, not the mixer. All sounds are OUR OWN synthesized tones (generator scripts under `tools/`),
nothing ripped.

## The four sounds
| Sound | Event hooked (existing) | How it's played | Volume | Pitch |
|---|---|---|---|---|
| **Gunshot** | `S2C.EVENT kind:'shot'` (broadcast to all) | shooter (`by===selfId`): NON-positional/close (`playUiSound`); everyone else: POSITIONAL at the muzzle `(ox,oy,oz)` | 0.4 self / 0.7 others | 1.0 |
| **Grenade blast** | `kind:'grenade'` (broadcast to all) | POSITIONAL at the blast centre `(x,y,z)` — the thrower is near it, so they hear it positionally too | 0.8 | 1.0 |
| **Finder ping** | `kind:'find'` `ok:true` (host's PRIVATE reply → the activating hunter's own local ping) **+** `kind:'finderPing'` (host BROADCAST → everyone else, 2026-07-18) | activating hunter: POSITIONAL at `state.self` off the private reply; EVERYONE ELSE: POSITIONAL at the ping's world pos `(x,y,z)` off the broadcast, IGNORING their own echo (`by===selfId`) | 0.6 | 1.0 |
| **Prop ouch** | `kind:'hurt'` `self:false` on a PROP-role victim | POSITIONAL at the prop, ONE shared clip **pitch-shifted by prop size** | 0.7 | `ouchRateForDisguise` |

## Gunshot: positional for others, plain for the shooter
The `shot` event already goes to everyone (muzzle flash + tracer). We branch on `msg.by === state.selfId`:
the shooter hears their own shot as a flat 2D blip (`scene.playUiSound`) so it isn't weirdly HRTF-panned
in their own ears; every other client hears `scene.playPositionalSound` at the muzzle so direction +
distance read through the inverse-square + HRTF path (33166c8 / 15ea82f).

## Prop ouch: pitch-from-size (the interesting bit)
- **One shared clip** (`assets/combat/ouch.wav`, authored NEUTRAL at rate 1.0 = a mid/undisguised prop)
  is pitched at PLAYBACK with Web Audio `playbackRate` — the cheap correct pitch lever.
- **The rate is derived from the SAME size the damage curve uses.** `shared/damage.js` gained
  `ouchPlaybackRate(size, cfg)` + `ouchRateForDisguise(disguiseType, catalog, cfg)`, mirroring
  `multiplierForDisguise`: same `catalog[disguise]` lookup, same `entrySize` (→ `halfExtentsFor`)
  footprint. So pitch and damage read ONE size — they can never disagree about how big a prop is.
- **Direction:** monotonic DECREASING in size. Tiny burger (~0.6 m) → `maxRate` 1.8 (high squeak);
  big table/fridge (≥2.2 m) → `minRate` 0.7 (deep groan); undisguised/unknown → 1.0 (neutral).
- **Anchors track the damage curve:** `resolveOuchCfg` defaults `smallSize`/`largeSize` to the damage
  defaults (0.72 / 2.2). `main.js playPropOuch` passes the LIVE `resolveDamageCfg(rules.damage)` anchors,
  so if VRmike retunes `damage.smallSize`/`largeSize` the pitch band follows automatically.
- **The knobs (re-tunable feel):** `maxRate` 1.8 / `minRate` 0.7 (pitch bounds) in `resolveOuchCfg`
  (`shared/damage.js`). The curve is a linear lerp across the size band; if a gentler feel is wanted,
  narrow the bounds or swap the lerp — VRmike's call after a live listen.
- **Gate:** `kind:'hurt'` with `self:false` (skip the hunter's wrong-guess/backfire self-damage, which
  is `self:true`) AND the victim is a PROP (`!victim.hunter` from the newest snapshot roster). Fires for
  BOTH rifle and grenade hits — they share the `_damagePlayer` → `hurt` event. The victim's `disguise`
  is present in every client's roster during HUNTING (only the `name` is blanked for hunters — the
  render-facing `disguise` field must stay, see referee `hunterSafeSnapshot`), so the shooter computes
  the right pitch too.

## Finder ping FOR ALL (2026-07-18, VRmike)
Originally the ping was private to the activating hunter (played off the `kind:'find' ok` reply). Now
everyone hears it: `referee.applyFind`, on a SUCCESSFUL activation, ALSO broadcasts
`S2C.EVENT kind:'finderPing' {by, x, y, z}` with ONLY the hunter's world position. `main.js onEvent`
`case 'finderPing'` plays `playCombatSoundAt('finderPing', {x, y:y+1.2, z}, 0.6)` positionally through
the same master-limiter path — BUT ignores its own echo (`msg.by !== state.selfId`), so the hunter
keeps the instant local ping from the private reply (no double-ping, no net lag on their own click). A
cooldown-REJECTED activation broadcasts nothing. Position-only payload → no prop-data leak, blindfold
rules untouched (finder is HUNTING-only anyway). Guarded in `check-finder.mjs` §G.

## Audio plumbing (`js/scene.js`)
- New **`playPositionalSound(pos, buffer, opts)`** — a fire-and-forget POSITIONAL one-shot at a FIXED
  world point (unlike taunts, which follow a player). Same engine as `playTaunt`: `PositionalAudio`
  wired to the ONE shared `AudioListener` (→ preGain → master limiter → destination), inverse-square
  exponential distance model (`COMBAT_FALLOFF_TARGET` 0.03, `COMBAT_FALLOFF_EXP` 2 — mirrors the taunt
  knobs), HRTF panning (`TAUNT_PANNING`), per-source `setVolume`, optional `setPlaybackRate`. `opts`:
  `{ volume, rate, mapSize }`.
- One-shots are tracked in `this._oneShots` and reaped when finished inside `updateTauntEmitters`
  (already called every render frame). `_stopAllOneShots()` clears them in the `buildWorld` teardown
  next to `_stopAllTaunts()` — a PositionalAudio's source is a Web Audio node, not a scene-graph child,
  so it must be STOPPED, not just dropped, or a combat sound could bleed into the next match.
- **Fail-silent** at every layer: `playPositionalSound` no-ops on a missing buffer/pos, on no listener
  (audio unavailable), and wraps node setup in try/catch (never throws) — same house rule as `playTaunt`.

## Wiring (`js/main.js`)
- `COMBAT_SFX` registry maps `gunshot/grenade/ouch/finderPing` → asset URL + a lazily-decoded buffer
  cache (`_withCombatSfx`, same lazy-load pattern as the finder deny buzz `_finderDenyBuf`). Decoding
  runs once per sound through `scene.loadAudioBuffer`.
- Helpers: `playCombatSoundAt(key,pos,volume,rate)` (positional), `playCombatSound2D(key,volume)`
  (non-positional), `playPropOuch(victim)` (computes the size rate, plays positionally at the prop).
- Event hooks live in `onEvent`: `case 'shot'` (gunshot), `case 'grenade'` (boom), `case 'find'`
  (ping on `ok`), `case 'hurt'` (ouch). Imports `ouchRateForDisguise` + `resolveDamageCfg` from
  `/shared/damage.js`.

## Generated assets (our own tones — `tools/`)
`tools/_wav.mjs` (shared mulberry32 PRNG + normalize + PCM-16 WAV writer, deterministic re-runs) plus:
- `tools/gen-gunshot.mjs` → `assets/combat/gunshot.wav` (bright noise crack + low body thump, 0.18 s)
- `tools/gen-grenade.mjs` → `assets/combat/grenade.wav` (noise punch + deep descending boom + low
  rumble tail, 0.62 s)
- `tools/gen-finder-ping.mjs` → `assets/finder/ping.wav` (ASCENDING clean bell tones 784→1175 Hz —
  deliberately the opposite of the DESCENDING buzzy deny buzz `deny.wav`, so success ≠ denial)
- `tools/gen-prop-ouch.mjs` → `assets/combat/ouch.wav` (voice-ish "ow" pitch contour, mid base pitch)

Same authoring model as `tools/gen-finder-deny.mjs`: the WAVs ship, the scripts don't. These generated
WAVs are NOT in `assets/manifest.json`/`CREDITS.md` (those are for `fetch_asset` downloads — `deny.wav`
follows the same convention). Re-run a generator only to retune; the committed WAV is what ships.

## Headless guard — `tools/check-combat-sfx.mjs` (build-gating)
- **A)** drives the REAL `ouchPlaybackRate`/`ouchRateForDisguise` on a synthetic burger/crate/table/
  fridge catalog: strictly decreasing with size, tiny > 1 > big, clamps at the anchors, a true gradient
  in between, monotonic across a 0.3→3.0 m sweep, neutral 1.0 for undisguised/unknown/degenerate — a
  RELATIONSHIP (tiny=higher, big=lower), not frozen numbers, per the balance-tuning guard policy.
- **A2)** the ouch size anchors default to the damage curve's `smallSize`/`largeSize` (one size band,
  not two lists) and passing retuned anchors actually moves the crossover.
- **B)** the four WAVs exist on disk as real RIFF/WAVE files + their generators are present.
- **C)** source: `playPositionalSound` routes `PositionalAudio(listener)` (→ limiter) with the
  exponential model, HRTF, a volume trim, `setPlaybackRate`, and fail-silent guards; `main.js` registers
  the four URLs and hooks shot/grenade/find/hurt with the right positional-vs-2D + prop-only-ouch gates.

## OWED — live pass (headless can't do audio/render/peers)
One real match on headphones: fire the rifle — you hear your own shot plainly, a teammate's shot pans by
direction/distance; throw a grenade — a positional boom at the blast; activate the finder — the ascending
ping (clearly not the deny buzz); shoot/blast props of different sizes — the ouch squeaks for a burger
and groans for a fridge, positioned at the prop. Confirm several overlapping combat sounds stay loud but
clean (limiter). Spot-check on a phone (iOS audio unlocks in a tap — the fire/tool gestures already
unlock; a passive listener hears sounds once the graph is warm).
