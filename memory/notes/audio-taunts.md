# Audio taunt system (prop players)

Built 2026-07-16 (VRmike, branch build/100-audio-taunt-system-for), finishing an interrupted
attempt-1 tree (`0a3ce19` WIP-RECOVERY). Lets a prop play an audio taunt as DIRECTIONAL 3D audio at
its own world position for EVERYONE — hunters locate props by ear, so taunting is a deliberate
self-snitch. Allowed in any active phase (HIDING or HUNTING); a prop taunting while hiding only
hurts itself, so no special rule.

## The whole loop
prop presses taunt (T key on desktop / on-screen button on phones) → a large scrolling menu opens →
pick a taunt → client sends `C2S.TAUNT{id}` → host validates + broadcasts `S2C.EVENT kind:'taunt'`
tagged with who taunted → EVERY client plays the clip as `THREE.PositionalAudio` at that prop's live
position. The menu STAYS OPEN across picks (back-to-back spam is the intended feature); ✕ / T / Esc
close it. A STOP button appears while your own taunt plays and kills it for everyone.

## Data-driven library (ZERO code to add clips)
- `assets/taunts/manifest.json` = `{ taunts: [{ id, label, file }] }`. `id` unique+stable, `label` =
  menu text, `file` = path relative to `assets/`. The client loader (`js/taunts.js` `_url`) resolves
  it under `/assets/` and tolerates a leading `/` or an `assets/` prefix.
- **REAL CLIPS ARE WIRED IN (2026-07-16, build/112).** 29 real meme .mp3s VRmike/Teravortryx
  uploaded via Discord are registered in the manifest. They sit FLAT in `assets/` (e.g.
  `assets/Never_Gonna_Give_You_Up.mp3`) — that's where the canonical root `assets/manifest.json`
  + `CREDITS.md` register them — so the taunt manifest `file` fields are bare filenames
  (`"Never_Gonna_Give_You_Up.mp3"`), NOT `taunts/…`. There is no `assets/audio/` dir. LICENSE is
  UNVERIFIED on every clip (Discord attachments) — recorded in CREDITS.md.
- Adding more clips: drop the audio file into `assets/` and add one manifest line (id/label/file).
  NO code change. An empty/absent manifest is valid (menu shows the empty-state note; the host
  rejects every taunt id).
- **The 3 synthesized placeholder beeps (beep_high / beep_low / warble) were REMOVED** (VRmike) —
  their manifest entries are gone and `tools/gen-taunt-placeholders.mjs` is now a RETIRED no-op stub.
  Note: this sandbox has no shell/`rm` and `Write` can't touch binaries, so the stale
  `assets/taunts/beep_*.wav` files may still be on disk — nothing references them; delete in a normal
  commit if desired.

## Files / responsibilities
- **`shared/protocol.js`** — `C2S.TAUNT{id}`, `C2S.STOP_TAUNT`; `S2C.EVENT` kinds
  `taunt{by,id,uncancellable}` and `tauntStop{by}`.
- **`shared/referee.js`** (host-authoritative relay, same pattern as SHOOT):
  - `applyTaunt(player,id)` — accepts only a LIVING PROP in HIDING/HUNTING with a real manifest id
    (`_tauntIds` set built in the constructor from injected `config.taunts.taunts`), then broadcasts.
    A self-chosen taunt clears the uncancellable flag.
  - `applyStopTaunt(player)` — broadcasts `tauntStop`, UNLESS the current taunt was forced
    uncancellable (then the prop's stop button is a no-op).
  - `forceTaunt(propId)` — **FINDER-TOOL HOOK, dormant.** Forces a RANDOM taunt from a prop, marked
    `uncancellable:true` (their stop button can't kill it). The future prop-finder tool wires it in
    ONE line: `referee.forceTaunt(propId)`. The host picks the clip once + relays so every client
    plays the same one. Returns false on a non-prop / dead prop / empty library.
  - The cut-off rule is NOT enforced here — the referee just relays; each client cuts off per-emitter.
- **`js/config.js`** — loads the manifest into `cfg.taunts.taunts` (tolerant of absent/empty). Clips
  themselves are NOT fetched here.
- **`js/taunts.js` — `TauntLibrary`** (client lazy loader/cache): `load(id)` fetch+decode a clip on
  first use, caching the PROMISE (concurrent/repeat loads share one fetch); `prefetch()` loads the
  whole library in the background. Decodes via a passed `loadBuffer(url)` (→ `scene.loadAudioBuffer`)
  so it holds no THREE reference. NEVER preloads at join.
- **`js/scene.js`** — the positional-audio engine:
  - `AudioListener` parented to the CAMERA (so Web Audio's listener tracks the player's eye →
    real stereo direction). Created lazily on first taunt; survives buildWorld's `scene.clear()`
    (camera is re-added).
  - One `PositionalAudio` emitter per taunting player, keyed by player id, on a bare `Object3D` added
    to the scene and repositioned every frame (`updateTauntEmitters`, called from the render loop) to
    that player's live mesh position — so the taunt FOLLOWS a moving prop.
  - `playTaunt(playerId, buffer, {mapSize})` — CUT-OFF: stops this player's previous emitter first
    (one voice per prop); different players overlap. **INVERSE-SQUARE distance model** tuned to the
    map (Jie, 2026-07-18) — see the falloff section below. Never throws (audio must not break the game).
  - `stopTaunt(id)` / `clearAllTaunts()` / `loadAudioBuffer(url)` (AudioLoader → AudioBuffer, null on
    fail, Safari-safe) / `unlockAudio()` (resume the shared ctx inside a gesture, for iOS).
  - **buildWorld cleanup uses `_stopAllTaunts()`, NOT `.clear()`** — a PositionalAudio's source is a
    Web Audio node wired to the listener, NOT a scene-graph child, so removing the Object3D does NOT
    stop the sound. Clearing the map alone would leak a taunt into the next match.
- **`js/ui.js`** — DOM only, no game logic: `buildTauntList(taunts)` (data-driven rows from the
  manifest), `openTauntMenu`/`closeTauntMenu`, `setTauntButton`/`setTauntStop`; callbacks
  `onTauntButton/Pick/Stop/Close/Prefetch` injected by main.js. Rows fire on `pointerdown`.
- **`js/input.js`** — `T` key → `onToggleTaunt`, handled BEFORE the pointer-lock gate (like Backquote)
  so it opens while the mouse is captured AND closes while the menu has freed it. No-op on touch (the
  on-screen button covers it) / while typing.
- **`js/main.js`** — the glue:
  - `openTauntMenu`/`closeTauntMenu`: `state.tauntMenuOpen` is a UI-mode-like state that frees the
    DESKTOP mouse (exit pointer lock) so the scrolling list is clickable, WITHOUT opening pause.
    `onLockChange` returns silently on it (no overlay/pause), `openPause` supersedes it, and it's in
    the input-loop `halt` (movement zeroed while the menu is open). Touch skips the pointer-lock dance.
  - `sendTaunt(id)` relays `C2S.TAUNT` and unlocks audio in the gesture.
  - `onTaunt(msg)`: lazy-load the buffer → `scene.playTaunt`; for OUR OWN taunt show the STOP button
    (unless `uncancellable`) and auto-hide it when the clip ends. `onTauntStop(msg)` kills that
    player's emitter and hides our stop button.
  - `updateTauntUi()`: the taunt button shows for a living prop in an active phase; called from
    `applyToolView` (role/alive/scene rebuild) and the phase event. Full teardown in `backToMenu`.

## Distance falloff — inverse-square (Jie, 2026-07-18)
Replaced the old **linear** model (`refDistance ≈ size*0.08`, `maxDistance ≈ size*1.3`, rolloff 1)
with realistic **inverse-square** decay. Web Audio has no literal "inverse-square" `distanceModel`, but
the **exponential** model with `rolloffFactor = 2` IS exactly it: `gain = (d / refDistance)^-2`.
- Config in `playTaunt`: `setDistanceModel('exponential')`, `setRolloffFactor(TAUNT_FALLOFF_EXP)` (=2),
  `setRefDistance(size * TAUNT_FALLOFF_TARGET^(1/EXP))`. Two named knobs, one-line retunes:
  - `TAUNT_FALLOFF_TARGET = 0.03` — gain (fraction of full volume) at ONE MAP WIDTH away.
  - `TAUNT_FALLOFF_EXP = 2` — distance exponent; 2 = true inverse-square.
- The refDistance math: solve `(size/ref)^-EXP = target` → `ref = size * target^(1/EXP) = size * √0.03
  ≈ 0.1732 * size` (≈6.2 units on the 36-unit restaurant map). Full volume inside that radius,
  inverse-square beyond, exactly **3% at one map width**. Derived from `mapSize` so it's per-map generic.
- **`setMaxDistance` was REMOVED** — non-linear distance models silently IGNORE it, so leaving the old
  `size*1.3` in place would only mislead the next reader. (The linear model needed it to reach ~0.)
- **KNOWN TRADEOFF (intentional, not a bug to "fix"):** inverse-square never reaches true zero, so a
  taunt anywhere on the map stays **faintly audible (~3%)** instead of going fully silent like the old
  linear model did past maxDistance. That audible-everywhere realism is the whole point of the
  experiment Jie asked to try. If it proves annoying (hunters echo-locating props by the faint tail),
  the two knobs above dial it down cheaply, or revert to linear entirely.
- Asserted in `tools/check-taunts.mjs` §C: exponential model, rolloff 2, the two knobs, the
  `refDistance = size * target^(1/exp)` formula, `setMaxDistance` absent, and a numeric end-to-end
  check that gain lands at 3% one map width out.

## HRTF binaural panning (Jie, 2026-07-18)
Flipped positional taunts from Web Audio's default **equalpower** pan (cheap constant-power L/R only)
to **HRTF** (Head-Related Transfer Function — convolves a measured per-ear impulse response). On
headphones this gives true binaural 3D: real **front/back** and up/down cues that equalpower simply
cannot produce (before this, a taunt dead ahead and one dead behind sounded identical). Zero
dependencies — native to every browser's Web Audio engine; this is the realism step BEFORE any
external HRTF library.
- **Touch point:** `playTaunt` in `js/scene.js` sets `sound.panner.panningModel` on each
  `THREE.PositionalAudio` emitter (THREE exposes the underlying Web Audio `PannerNode` as `.panner`).
- **Guarded + fail-silent:** the assignment is in its OWN try/catch, OUTSIDE the emitter-create block.
  If `.panner` is missing or the set throws, we silently keep THREE's default equalpower pan and STILL
  play the taunt — audio must never throw (house rule).
- **CLIENT-SIDE knob, NOT shared/config:** module-level `TAUNT_PANNING = { model: 'HRTF', fallback:
  'equalpower' }` near the top of `js/scene.js`. This is how audio RENDERS on this machine, not
  authoritative game data, so it deliberately does not live in `shared/config/`. Applied value is
  `model || fallback`, so an empty/unset `model` degrades to equalpower rather than an invalid string.
- **Spec-exact spelling matters:** the Web Audio `PanningModelType` enum is `'HRTF'` (UPPERCASE) and
  `'equalpower'` (lowercase). Browsers SILENTLY IGNORE a wrong case (you'd get default panning and no
  error), so both strings are taken verbatim from the spec (verified against MDN), not from memory.
- **Mobile CPU caveat (the one real unknown):** HRTF costs a bit more CPU per emitter than equalpower,
  and the prop-finder's `forceTaunt` can drive ~5+ simultaneous taunt emitters. Desktop handles this
  trivially; a handful of HRTF panners is light on modern mobile too, but this was NOT verified on a
  real low-end phone under the worst case (headless boot can't measure audio CPU). If a weak phone
  ever stutters, the fix is to flip `TAUNT_PANNING.model` to the `fallback` value — globally, or
  gate it per-platform (desktop keeps HRTF, mobile → equalpower) — rather than reverting the feature.
- **Owed live pass:** one headphone listen in a real match — walk past a taunting prop and confirm the
  sound clearly moves front → side → behind you (the front/back distinction is the whole point), and
  spot-check ~5 simultaneous forced taunts on a phone for stutter.
- Asserted in `tools/check-taunts.mjs` §C: the `TAUNT_PANNING` knob exists (model HRTF, fallback
  equalpower), `playTaunt` sets `panner.panningModel = model || fallback`, reads `sound.panner` behind
  an `if (panner)` guard, and never hard-codes equalpower onto the panner.

## Master audio limiter (stop the clipping)
Every taunt emitter + `playUiSound` sums at THREE's shared `AudioListener` before the speakers, so
overlapping loud sounds can clip. A **master limiter** is spliced into the listener's single output
hop (`listener.gain → preGain → limiter → destination`) so the summed mix can't exceed 0dBFS. Taunt
emitters were trimmed from full `1.0` to `0.85` in `playTaunt` so the limiter stays a safety net.
This is purely the output graph — no change to the relay/cut-off/finder logic above. See
**`memory/notes/audio-limiter.md`** for the full design (incl. the "no true lookahead yet" rationale)
and `tools/check-audio-limiter.mjs`.

## iOS / mobile
Audio unlocks only inside a user gesture on iOS. `scene.unlockAudio()` (resume THREE's shared
AudioContext) is called inside the menu-open and pick gestures. THREE's AudioLoader lazily creates
the same context, so decoding + playback ride the unlocked graph.

## UI placement (why top-centre)
The taunt + stop buttons sit TOP-CENTRE (just below the HUD pills). That band is clear of every other
touch control: joystick (bottom-left, tall), action/jump/rotate stack (bottom-right), pause ☰
(top-right corner), and the mid-screen banner (top:30%). Bottom-left/right were both taken.

## PC UX fixes (Jie, 2026-07-16, branch build/116-taunt-menu-pause-menu)
Keyboard-side polish; the mobile touch controls (on-screen Taunt button, floating stop) are UNTOUCHED.
- **Menu docks LEFT + NO tint.** `.taunt-menu` (css/style.css) is `justify-content: flex-start` and
  has NO `background`/`backdrop-filter` — the game world stays fully visible while the menu is open.
  The full-screen container still keeps `pointer-events: auto` so a stray click on empty space can't
  punch through to the canvas and re-lock the mouse (which would close the menu). The `.taunt-card`
  carries its own near-opaque background (`#170b28fa`) so it reads over the live world.
- **In-menu STOP button** (`#tauntStopInline`, in `.taunt-head`) silences your current taunt WITHOUT
  closing the menu — same `onTauntStop` → `C2S.STOP_TAUNT` path as the floating button. `setTauntStop`
  toggles BOTH buttons together, so the in-menu one shows only while your cancellable taunt plays.
- **Hotkey hint** `.taunt-hint` ("T / Esc to close") in the header; hidden on touch via
  `@media (pointer: coarse)` (the same primary-pointer signal input.js classifies control scheme by).
- **T already opens+frees the mouse in one press** (was true since the taunt system shipped — no
  tilde-first two-step). T or Esc closes and re-locks.
- **Esc TOGGLES the pause menu** (previously open-only). `main.js` `input.onRequestPause` now DERIVES
  the action from live state (derive-don't-latch): taunt menu open → `closeTauntMenu(true)`; pause open
  → `closePause(true)` (re-locks); else `openPause()`. The pointer-lock minefield is sidestepped because
  each of these Esc presses happens while the mouse is ALREADY free (menu/pause open ⇒ unlocked), so the
  Esc keydown reaches the page normally; the OPEN-from-play path still routes through the browser's
  lock-release → `onLockChange` → `openPause`. Locked⇔unlocked are mutually exclusive so the two paths
  never double-fire. Controls-help text (ui.js `_controlsHtml`) updated for the Esc toggle + a T row.
- `tools/check-taunts.mjs` section **D** asserts all of the above from source.

## Headless check — `tools/check-taunts.mjs` (build-gating, passes with the 29 real clips)
(A) manifest ids unique + every referenced file exists + library non-empty now. The check reads
ids DYNAMICALLY from the manifest (`taunts[0]`/`taunts[1]`), so it never assumed exactly 3 entries
and needed no logic change for 29 — only stale "placeholder" wording was updated. (B) drives the REAL
referee: taunt relayed to every player tagged by the taunter; a second taunt re-relayed; stop relayed;
hunter / dead prop / bogus id / lobby-phase all REJECTED; `forceTaunt` fires an uncancellable taunt and
the prop's stop is then ignored; a normal taunt clears the flag; empty library degrades gracefully.
(C) source assertions that scene/main/ui/config expose the audio API the render loop + event handler
call (the "a missing scene method silently kills the render loop every frame" lesson), the
inverse-square falloff knobs/formula, AND the HRTF panning setup (the `TAUNT_PANNING` knob + the
guarded `panner.panningModel = model || fallback` in `playTaunt`).

## Owed live pass
Taunt from a phone (iOS sound actually plays), hear it directionally on a second device, spam cut-off
with the menu staying open, stop button kills it, ✕ closes without playing. Then confirm dropping real
clips + manifest lines needs ZERO code change.
