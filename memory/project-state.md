# prop-hunt — current state

## Goal

Skeleton multiplayer Prop Hunt: basic but extendable. It's a **static site**
(deployable to Cloudflare Pages — no server, no backend, no build step). Play is
**peer-to-peer over WebRTC**; the room creator's browser hosts the referee.
Browsers are introduced by **PeerJS's free public broker** (no matchmaker of
ours). Strict NATs relay through a free public TURN.

## RESUME NOTE (2026-07-12, resume of the crashed pose/anim/damage/debug/fire/pause run): the crashed attempt had already COMMITTED its full work as `9cb60ad` (the harness commits partial trees); the HTTPException struck AFTER the commit, during the final deploy/link-posting step — NOT mid-edit. Working tree verified CLEAN at HEAD (`git diff HEAD` empty — no partial/uncommitted leftovers). Re-ran the WHOLE guard suite on resume, ALL GREEN: `check-combat` (incl. §E re-disguise small→large multiplier + §F fire-rate 700 rpm/66 ms), `check-debug-menu` (collapsed default + collider toggle), `check-hunter-model` (idle = `Idle_Gun_Pointing` gun-up clip), `check-blindfold` (scene-API guard), `check-physics`, `check-hunter-model-size`. Page boots with ZERO console errors in normal + `?debug=1` + phone-portrait; DEBUG menu confirmed COLLAPSED-by-default by screenshot (only the `DEBUG ▸` button top-left). No code changes needed — the seven-part pass below is complete and coherent. Still owes the live 2-player pass noted at the end of that section.

## Latest: HUNTER RIFLE POSE/ANIM POLISH + DAMAGE-MULT PROOF + DEBUG UPGRADES + RAPID-FIRE/MOUSE-LOCK/PAUSE MENU (2026-07-12, VRmike, on `main`). All headless checks GREEN + page boots clean (normal + ?debug=1 + phone). Rifle pose, hold-to-fire feel, mouse-lock/pause flow owe a live 2-player pass.

Seven-part pass. Full detail: `notes/hunter-character-model.md` (rifle pose/anim), `notes/hunter-tools-combat.md`
(damage proof + rapid fire), `notes/debug-menu.md` (collapsed + collider toggle), `notes/pause-menu.md` (new).

1. **RIFLE POINTS DOWN — ROOT-CAUSED at the rig pose (not a number guess).** The wrist-bone
   orientation DIFFERS per clip: in the shoot/aim clips (`Idle_Gun_Pointing`/`Gun_Shoot`/
   `Idle_Gun_Shoot`/`Run_Shoot`) a rifle attached at rotation=0 points nearly straight DOWN, and
   the old `Idle_Gun` idle pointed it BACKWARD — so no single grip rotation fixed both. Loaded the
   real rig headlessly (three+GLTFLoader, `tools/_solve_rifle.mjs`), posed each clip, read the
   Wrist.R world quaternion, and SOLVED the bone-local rotation that maps the muzzle (the rifle's
   -X end — thin barrel, fewer verts, `tools/_muzzle.mjs`) to the character's forward and gun-up to
   world-up. `weapon.rotationDeg = {178.8, -10.1, 87.6}` lands the barrel within ~1° of level-
   forward, upright, across EVERY shoot/aim clip. Hot-tunable; confirmed live post-deploy.
2. **IDLE keeps the gun up — use the real aim-idle.** idle clip `Idle_Gun` → **`Idle_Gun_Pointing`**
   (a static aim-idle that holds the rifle raised + forward AND shares the shoot clips' wrist
   orientation, so one rotation fixes idle + movement). Movement stays `Run_Shoot`. The code still
   can NEVER select an arms-at-side idle while tool=rifle (every configured clip is a Gun/Shoot
   clip; `check-hunter-model.mjs` asserts it by parsing the GLB).
3. **DAMAGE MULTIPLIER — the referee was ALREADY correct; proven, not blindly re-patched.** A probe
   + git history showed `_applyShotDamage` has ALWAYS derived the size multiplier FRESH from
   `target.disguise` at damage time (no cache anywhere; the client also allows + sends a re-disguise).
   Made the guarantee explicit via `referee._playerHitDamage(target)` and LOCKED it with
   `check-combat.mjs` section E (disguise small → re-disguise large → assert per-hit damage now
   matches the LARGE prop). If the bug still reproduces live, the deployed build predates this / the
   root cause is elsewhere — flagged honestly (see summary).
4. **DEBUG MENU: (a) live "Colliders" toggle** driving new `scene.setColliderView(on)` — build/
   teardown ALL collider wireframes (props, players CAPSULES [new geometry], static fixtures, world
   architecture) via the SAME `shared/bounds.js` source + wire builders the `?debug=1` overlay uses.
   **(b) starts COLLAPSED** — only the `DEBUG ▸` button top-left; panel opens on click.
5. **RAPID FIRE.** Rifle is HOLD-to-fire at `rules.fireRateRpm` (700, config-tunable, 600-800 band).
   Host derives its authoritative rate cap from it (`referee._fireCooldownMs` = 60000/rpm − grace);
   the client paces held-fire off the same number. Damage/bullet unchanged (5%). `input.primaryHeld`
   tracks the held left-click / touch ACTION; `main.js` auto-repeats for a live hunter.
6. **MOUSE LOCK + HOLD-LEFT-CLICK.** Pointer lock already captures on the in-game canvas click for
   BOTH roles (unchanged). Left-click is now HELD to rapid-fire (props still single-tap disguise).
7. **PAUSE MENU (overlay, does NOT pause the sim).** Escape releases pointer lock → opens a menu
   with a live scoreboard (everyone + health), a Controls/help panel, Resume (re-locks), and Exit.
   Touch: a ☰ button opens the same menu (no pointer lock there). While open the avatar holds still
   (zeroed input) but the world keeps running on the host. `notes/pause-menu.md`.
- **Guards:** `check-combat.mjs` +E (re-disguise multiplier) +F (fire-rate config/cap);
  `check-debug-menu.mjs` +collapsed-default +collider-toggle +`setColliderView`/player-capsule;
  `check-hunter-model.mjs` (idle clip is a gun clip) still GREEN; `check-blindfold.mjs` picks up the
  new `scene.setColliderView` seam; `check-physics`/`check-hunter-model-size` still GREEN. Page boots
  clean normal + ?debug=1 + phone (debug menu confirmed collapsed by screenshot).
- **OWED — live 2-player pass:** remote hunter holds the rifle UP + pointing forward while running
  AND standing idle (no barrel-down, no arms-at-side); hold-left-click rapid-fires at a realistic
  rate; Escape opens the pause menu + releases the mouse, Resume re-locks; scoreboard shows everyone's
  health; the debug "Colliders" toggle draws every collider incl. player capsules and tears down clean.
  Nudge `weapon.rotationDeg` if the grip roll/facing reads off (hot-tunable, no rebuild).

## RESUME NOTE (2026-07-12, resume of the crashed rifle/tuning run): the crashed attempt had already COMMITTED its full work as `959fc2c` (the harness commits partial trees); the Exception struck AFTER the commit, during the final deploy/link-posting step — NOT mid-edit. Working tree verified CLEAN at HEAD (no partial/uncommitted leftovers to discard). Re-ran the whole guard suite on resume: `check-hunter-model`, `check-combat`, `check-debug-menu`, `check-blindfold`, `check-physics`, `check-hunter-model-size` all GREEN; page boots clean with zero console errors in normal + `?debug=1` + phone-portrait; debug menu confirmed visible by default (screenshot). No code changes were needed — the six-part pass below is complete and coherent. Still owes the live 2-player pass noted at the end of that section.

## Latest: REMOTE RIFLE ANIMATION FIX + INPUT/DAMAGE/HUD TUNING (2026-07-12, VRmike, on `main`). All headless checks GREEN + page boots clean (normal + ?debug=1); remote-animation look + HUD-in-match + live damage feel owe a 2-player pass.

Six-part tuning pass on the HUNTER-TOOLS build. Full detail: `notes/hunter-character-model.md`
(clip change), `notes/hunter-tools-combat.md` (damage), `notes/debug-menu.md` (default-on).

1. **Remote rifle animations — ROOT-CAUSED at the asset.** Parsed the SWAT GLB (its clip names
   live as plain text in the glTF JSON chunk — no 3D math): 24 clips, and only **two** hold the
   rifle up — `Idle_Gun` and `Run_Shoot` (a real rifle-run). The old config pointed
   backward/left/right at `Run_Back`/`Run_Left`/`Run_Right`, which are the pack's PLAIN
   arms-down directional runs — THAT was the "arms-at-sides while holding the rifle" VRmike saw
   whenever a hunter strafed/backpedalled (the mixer/velocity/wiring were all fine). There is no
   gun-up strafe/backpedal clip in the asset, so **all movement now maps to `Run_Shoot`** and
   idle stays `Idle_Gun` — the rifle stays raised in every direction (`character-models.json`,
   hot-tunable). Trade-off: legs use the forward-run cycle while strafing (documented). Tool
   state is NOT networked (finder is a no-op; the rifle is always shown to remotes), so
   "animation follows the rifle" = a remote hunter always animates gun-up — which is now true.
2. **PC left-click fire — already correct, verified.** `input.js` already fires on `mousedown`
   button 0 gated on pointer lock (→ `onAction('primary')` → `tryFire`), so a locked in-game
   left-click shoots and menu/UI clicks never do. No change (avoided a regression).
3. **Debug MENU on by default.** `main.js` now constructs `DebugMenu` unconditionally (lazy
   import). `?debug=1` is UNCHANGED and still governs the separable heavy features: the collider
   wireframe overlay (read directly in `scene.js`), per-peer ping, and the referee's
   host-authoritative debug-command gate. So the two links differ: normal = menu; `?debug=1` =
   menu + wireframes + host debug commands.
4. **Damage tuning (config + one referee line).** base **10 → 5** (5%/hit; undisguised = 20
   hits). **Wrong-guess penalty is now a FLAT `base` (5%), NEVER size-scaled** — new
   `damage.wrongGuessPenalty()`; referee's two decoy branches call it instead of the size curve;
   `selfScalesWithSize` retired to false + unread (20 wrong guesses = dead). Prop-PLAYERS keep
   the size curve, rescaled `smallMult` **5 → 10** so a burger still dies in ~2 hits at base 5;
   `largeMult` 0.34 kept → a table soaks ~59 hits ≈ ~3× the 20-hit default. Smooth lerp intact.
5. **HUD health BAR.** The numeric `#hudHealth` pill became a filled BAR (green→amber→red) that
   grows to fill the top row's spare width (≥220px, >2× the old readout) with the number centred
   inside; `.hud-top` spans the width and `flex-wrap`s so mobile portrait drops the bar to its
   own full-width second row — two fixed layouts, no runtime measurement.
6. **Guards extended.** `check-hunter-model.mjs` now PARSES the GLB (glbClipNames) and asserts
   every configured clip resolves in the asset AND is a rifle/aim clip (gun stays up).
   `check-combat.mjs` asserts the flat, size-independent wrong-guess penalty (burger decoy ==
   table decoy == base) + burger ~2 hits + table ~3×. `check-debug-menu.mjs` updated for
   default-on. All green; `check-blindfold.mjs` + `check-physics.mjs` still green.
- **OWED — live 2-player pass:** remote hunter holds the rifle UP running in every direction (no
  arms-at-sides); left-click fires on PC; debug menu visible without ?debug=1 (and wireframes
  with it); burger dies in ~2 hits / table tanky / 20 wrong guesses kill a hunter flat; health
  BAR fills the HUD row on PC and wraps to its own row on mobile portrait, number centred.

## Latest: HUNTER TOOLS v1 + HEALTH/DAMAGE + all-hunters-dead win (2026-07-12, VRmike). Crash-retry; started from a CLEAN tree at 8e28bc3 (the crashed run committed nothing). All headless checks GREEN; the tool bar / rifle visuals / actual raycast hits owe a live 2-player pass.

Adds the hunter tool framework (built for 4+ tools; 2 ship), a host-authoritative assault
rifle with tracers, a no-op prop finder, a health/damage system, and a new win condition.
Full detail: `memory/notes/hunter-tools-combat.md` + `DECISIONS.md` #1.

- **Tool framework (client-only, NOT networked in v1).** `HUNTER_TOOLS` in `js/main.js`;
  always-on `#toolbar` for a live hunter (tap on phone, click or number keys 1/2 on PC,
  current highlighted). A first-person weapon **VIEWMODEL** (`scene.setViewModel`) makes
  switching visible to the shooter (first-person hunters draw no body): rifle GLB (primitive
  barrel fallback, upgrades on load) vs a ~0.3 m box for the finder. The camera is added to
  the scene graph so its child viewmodel renders. Only the FIRE event is broadcast — which
  tool a hunter holds is deliberately not synced (finder is a no-op → netcode for no payoff).
- **Assault rifle (host-authoritative).** `C2S.SHOOT {dx,dy,dz}` = the camera-forward from
  `scene.aimDirection()` — the SAME screen-centre ray as the disguise pick (reused).
  `referee.applyShot` re-casts from the shooter's authoritative eye in its own Rapier world
  (`physics.raycastShot`→`castRay`, own capsule excluded); `physics.describeCollider` maps the
  hit collider to player / prop / static-fixture-by-type / world via handle maps built at
  construction. Broadcasts `EVENT kind:'shot'` → `scene.spawnTracer` (muzzle flash + tracer
  rifle-tip→impact) for EVERYONE, faded by `scene.updateEffects`. No physics → no-damage tracer.
- **Prop finder.** Tool 2: hides the rifle viewmodel, shows a ~1 ft box, does nothing —
  proves tool/weapon switching end to end (later: directional taunt audio).
- **Health/damage (all host-side).** Start 100 % (`rules.startHealth`), on the HUD
  (`#hudHealth`) + every snapshot player entry. `shared/damage.js` (PURE, shared by referee +
  guard) lerps a SIZE multiplier from `rules.damage` anchors over `entrySize` = the SAME
  footprint physics bakes colliders from (`halfExtentsFor`, auto-upgrades to measured bounds):
  base 10; burger (0.72 m) ×5 → ~2 hits; table (2.25 m) ×0.34 → ~30 hits (≈3× the default
  player's 10); undisguised → ×1. Rules: player hit → base×disguise-size; a disguisable decoy
  (prop or non-arch fixture) → the HUNTER takes it instead; architecture/world → free miss;
  a prop KILL refills the hunter to full.
- **Death + new win condition (DECISIONS.md #1).** Hunters do NOT respawn; a dead player
  spectates (`#spectate`, first-person look-around). `checkRoundOver` now also ends the round
  PROPS-WIN when a round's hunters are ALL dead (alongside all-props-caught → hunters win and
  timer-expiry → props win).
- **Verification.** NEW `tools/check-combat.mjs` (build-gating) drives the real referee
  paths: size→mult lerp, player-damage scaling, kill-refill, wrong-prop self-damage vs
  architecture free-miss, and BOTH win conditions. `check-blindfold.mjs` covers the new
  `scene.*` methods; `check-physics.mjs` still green (handle maps are additive); page boots
  with zero console errors. **All GREEN.**
- **Files:** `shared/config/rules.json` (+startHealth/shootRange/fireCooldownMs/damage),
  `shared/damage.js` (new), `shared/protocol.js` (+C2S.SHOOT, health/event docs),
  `shared/physics.js` (raycastShot/describeCollider + handle maps), `shared/referee.js`
  (health + shot + damage + win), `js/scene.js`, `js/main.js`, `js/ui.js`, `js/input.js`,
  `index.html`, `css/style.css`, `DECISIONS.md` (new), `tools/check-combat.mjs` (new),
  `memory/notes/hunter-tools-combat.md` (new), architecture.
- **OWED — live 2-player pass:** tool bar select (PC+phone) + highlight; viewmodel switch;
  muzzle flash + tracer seen by BOTH; size-scaled prop damage; decoy self-damage; wall
  free-miss; kill-refill; hunter death → spectator; last hunter down → PROPS WIN. Tune
  `rules.damage` + muzzle offset if off (hot-tunable).

## Latest: HUNTER MODEL SIZING FIX (bone-derived, verified) + DISGUISE-ANYTHING (2026-07-11, VRmike, on `main`). The third try at the hunter model — this one has a build-gating check that asserts the OUTPUT, not just that the code exists. Headless checks GREEN; the render/facing + a pillar disguise still owe a live 2-player pass.

- **PART A — hunter model TINY/ORBITING, root-caused + fixed for real.** The GLB stores its
  skinned mesh ~3.6 mm tall and inflates it via a baked **[100,100,100] BONE scale**;
  `Box3.setFromObject` reads that 4 mm phantom (ignores the skeleton), so the old
  `targetH/size.y` + bbox-centring derived a ~450× scale and an off-origin pivot → ~100×-too-
  small model on a lever arm that orbited as the player yawed. **Fix:** measure the SKELETON.
  New pure `shared/hunter-sizing.js` (`sizeHunterRig`/`measureRigBones`/`findBone`, `THREE`
  injected) traverses the bones for true height/feet/centre, scales the WRAPPER GROUP, rests
  feet at y=0, x/z centroid on-axis, keeps `yawOffsetDeg 180`. `js/scene.js _buildHunterModel`
  now delegates to it. Degenerate rig → armature-scale fallback, never the geometry bbox.
  - **2nd bug caught:** GLTFLoader sanitizes `Wrist.R` → `WristR`, so the rifle never attached
    (masked by the sizing bug). `findBone` matches tolerantly. Weapon now sized by
    `weapon.worldLength` (0.8 m) normalised against the wrist bone's world scale — robust to
    the rig-scale change. All hot-tunable.
  - **VERIFICATION THAT BITES:** `tools/check-hunter-model-size.mjs` loads the REAL GLB with
    three+GLTFLoader (dev-only `three@0.161.0`, `npm install`; game still CDN) and asserts the
    OUTPUT of the shipped `sizeHunterRig` — height ±10% of 1.8 m, feet ≤0.1 m off y=0, x/z
    centroid ≤0.1 m off origin. Runtime `?debug=1` tripwire warns if a hunter's live bone
    height is outside 1.2–2.5 m. `check-blindfold.mjs` (a) updated: it used to assert the OLD
    broken bbox path (the check that let this ship twice) — now asserts the bone path. See
    `memory/notes/hunter-model.md`. (Diagnostic screenshot: `assets/attached_0.jpg`.)
- **PART B — DISGUISE-ANYTHING (everything except architecture).** New shared classifiers
  `physics.isArchEntry` / `isDisguisableEntry` ("renderable mesh AND not architecture").
  `fixtures.json` flags the 4 arch entries `"arch": true` (floor_kitchen, kitchen_wall,
  wall_post, wall_header). `referee.startMatch` promotes EVERY non-arch fixture into the prop
  stream `disguisable:true` (dynFixtures flip false→true; static built-ins — counters, oven,
  fridge, cabinets, sinks, shelves, vent, doors, **pillars** — appended). `physics._buildProps`
  skips `isStaticEntry` props (their collider stays in `_buildStatic`, so physics/bounds/
  check-physics are UNCHANGED); `scene.buildWorld` renders static props as **invisible aim
  proxies** (visible mesh from the scenery loop). Capsule cap (0.55 → 1.1 m dia) keeps giant
  disguises door-passable. `tools/check-disguise-eligibility.mjs` asserts vent/counter/oven/
  pillar IN, floor/wall/ceiling OUT + passability. See `memory/notes/disguise-anything.md`.
- **OWED — live 2-player pass:** (1) remote hunter is right-sized, grounded, facing forward,
  and does NOT orbit when the hunter turns; rifle sits in-hand at a sane size; (2) a **pillar
  disguise** actually works (aim, disguise, wear it, fit through a doorway) — and a couple of
  other new targets (counter/fridge/vent) disguise cleanly.

## Prior: HUNTER MODEL FIX + FIRST-PERSON HUNTERS + CENTERED RETICLE/AIM (2026-07-11, VRmike, on `main`). Bundle of 3 fixes from live 2-player testing. Headless checks GREEN; render/camera/aim can't be seen headless → owed a live 2-player pass.

Resumed from an interrupted attempt-2 tree that had already re-anchored the hunter
model to the player body + measured its scale/foot-offset (Part A was in place). This
session finished Part A's facing, then did Parts B + C. Full detail:
`memory/notes/hunter-character-model.md`, `notes/third-person-camera.md`.

- **PART A — hunter model (mostly already in tree; verified + facing fixed).** The remote
  SWAT soldier is anchored to the PLAYER BODY position in `syncPlayers` (mesh at `p.x/p.y/p.z`,
  yaw from the snapshot) — NOT the orbiting third-person camera (the diagnosed root cause of
  the "orbits when the hunter turns, floats a few metres off" symptom was that camera
  attachment; the tree already had the body-anchored path). Scale + foot-offset are MEASURED
  from the loaded GLB bbox in `_buildHunterModel` (`s = targetH / size.y`, feet at `-box2.min.y`)
  — not magic numbers. **FIXED this session:** `character-models.json` `yawOffsetDeg` 0 → **180**
  (soldier faced backwards; native forward +Z vs game −Z). Hot-tunable if live shows it off.
- **PART B — FIRST-PERSON HUNTERS.** `main.js applyRoleView()` sets `scene.setThirdPerson(role !==
  HUNTER)` on the ROLE message and after `buildWorld`: HUNTERS are first-person (camera at the
  eye, `setCamera` first-person branch: y=1.6, YXZ yaw/pitch) and draw NO own body to themselves;
  PROPS stay third-person (see their disguise). Remote players still see the hunter's full animated
  soldier (Part A). Free-cam debug still shows the local body: `scene._wantSelfMesh()` = `thirdPerson
  || _freeCam`, and the free-cam branch of `setCamera` parks the self body at the predicted pose so
  it's visible from the fly-cam.
- **PART C — ONE CENTERED RETICLE + CAMERA-CENTER AIM.** Removed the floating reticle
  (`scene.aimScreenPoint` + `ui.setCrosshair` deleted): `#crosshair` is now fixed dead-centre by
  CSS only. `scene.aimedDisguiseTarget` raycasts from the CAMERA CENTRE through that reticle
  (`setFromCamera(SCREEN_CENTER)`) instead of a player-origin look-ray — the SAME `SCREEN_CENTER`
  (0,0 NDC) `debugPick` uses, so one crosshair/raycast system. Client still only PROPOSES the prop
  id; the host's `applyDisguise` stays authoritative (a courtesy player-range gate keeps the
  highlight honest). The generic "gun-aiming reuses this" half is DEFERRED (a gun would need a
  different target set than disguisable props) — noted in the roadmap, not built.
- **Guards:** extended `tools/check-blindfold.mjs` (same file, per plan) — measured scale/foot-offset
  path present (not hardcoded), hunters first-person, `#crosshair` centered, disguise ray from
  `SCREEN_CENTER`, aimScreenPoint gone. `node tools/check-blindfold.mjs` + `check-hunter-model.mjs`
  + `check-debug-menu.mjs` all GREEN; headless browser boot = zero console errors.
- **Files:** `js/scene.js`, `js/main.js`, `js/ui.js`, `shared/config/character-models.json`,
  `tools/check-blindfold.mjs`, `memory/notes/{hunter-character-model,third-person-camera,roadmap}.md`,
  architecture.
- **OWED — live 2-player pass:** (1) remote hunter is right-sized, grounded, facing forward, and does
  NOT orbit when the hunter turns; (2) local hunter is first-person with no self-body (free-cam still
  reveals the body); (3) reticle is a fixed centre crosshair; (4) aiming at a prop disguises as THAT
  prop. Tune `yawOffsetDeg`/grip if facing still off.

## Latest: IN-GAME DEBUG MENU behind `?debug=1` (2026-07-11, Jie, on `main`). Code + guards done; NOT live-tested (headless can't open a browser).

An in-game developer/debug panel, gated on the SAME `?debug=1` switch as the collider
wireframe view. OFF for normal play (zero debug DOM/listeners/styles without the flag).
Full detail + how-to: `memory/notes/debug-menu.md`.

- **New self-contained module `js/debug.js`** (`DebugMenu`) — plain, phone-usable DOM overlay
  (thumb toggle + collapsible panel, self-injected styles, no framework, no imports). `main.js`
  constructs it ONLY under `?debug=1` (lazy `import()`); `debugMenu` defaults null and every
  hook (`onSnapshot`, per-frame `frame`) is null-guarded.
- **Read-only displays** (can't break anything): smoothed FPS, live coords, velocity, the
  local-player state list (role/phase/disguise/grounded/frozen-blind/alive/capsule r+half/vel),
  the player roster, and per-peer **ping**.
- **Ping** measured in the netcode layer (`js/net.js`): a debug-only `__ping`/`__pong` pair
  intercepted BEFORE the referee, enabled only under the flag (`session.enablePing()`), filling
  a `pings` map the panel reads. Zero ping traffic in normal play; "—" when unmeasurable.
- **Host-authoritative actions** via a gated **`C2S.DEBUG`** family in the referee — change
  team, reset game, force-morph. All route through the referee like normal state changes;
  force-morph reuses `setPlayerCollider` (capsule resizes right), bypassing only the range
  check. The referee **drops every `debug:` message unless the HOST loaded with `?debug=1`**
  (`referee.debugEnabled`, read from the host tab's URL) — a tampered guest can't inject debug
  commands into a normal match. "Exit game" is purely local.
- **Free cam / focus box / click-to-inspect** via NEW `scene.js` seams (`setFreeCam`/
  `updateFreeCam`/`debugPick`/`setFocusBox`) so camera + raycast math stay in scene.js. Free
  cam is rendering-only (main.js freezes the physics player: skips prediction, sends zeroed
  movement). Focus box is a MAGENTA box, its own instance, never in `scene.colliders`. Inspect
  reveals a disguised player (the point of a debug tool); sleep state shows "host-only".
- **Guard rails:** `tools/check-blindfold.mjs` WIDENED to also scan `debug.js`'s `scene.*()`
  calls (the "missing scene method blanks the render loop" guard now covers this module) +
  named the four new seams. NEW `tools/check-debug-menu.mjs` — the headless smoke check:
  `debug.js` parses + exports, ZERO debug DOM/CSS without the flag, main.js gates
  construction/ping behind the flag with null-guarded hooks, the referee host-gate, and the
  protocol/net plumbing. **Not executed here (no shell)** — hand-traced; run both + a live
  browser pass to close.
- **Files:** `js/debug.js` (new), `js/main.js`, `js/net.js`, `js/scene.js`,
  `shared/referee.js`, `shared/protocol.js`, `tools/check-blindfold.mjs`,
  `tools/check-debug-menu.mjs` (new), `memory/notes/debug-menu.md` (new), architecture.
- **OWED — live browser pass:** panel renders + phone-usable; team/reset/morph apply on host
  & guest (debug host); free cam flies while the body stays put; focus box + inspect pick the
  right entity + reveal a disguise; ping shows plausible RTT; and — the acceptance bar —
  loading WITHOUT `?debug=1` shows zero debug UI and a clean console.

## Latest: PHYSICS PASS #4 — bouncy-invisible-wall ROOT CAUSE + `?debug=1` collider view + alignment guard (2026-07-11, Jie, on `main`). Geometry guard hand-traced GREEN; behavioural fix owes a live browser pass.

Attempt #4. Jie: the relaunch made it WORSE — (1) still phases through props, (2) NEW "invisible
bouncy wall" confines the player to a strip along one wall, can't reach the middle. Both attached
screenshots are **circus_lot** (primitives, perfect collider==mesh) → the acute bug is
**map-independent player physics, NOT a collider misalignment** (prime hypothesis refuted by the
screenshots' own map). Full detail: `memory/notes/physics.md` (pass #4) + `notes/collider-debug.md`.

- **ROOT CAUSE (behavioural):** the pass-#2 depenetration failsafe `_isPenetrating` tested the
  capsule against ALL solids (only `EXCLUDE_SENSORS`). With the world now ~130 **knockable**
  props (fix #2) and a **fatter disguised capsule** (pass #3), a player pushing through props
  overlapped one every substep → snapped back to `safePos` = "bounce off empty air, can't reach
  the middle, confined to a strip." The failsafe is only meant to recover from IMMOVABLE
  geometry (wall-top/floor tunnel), never to fight a prop being shoved.
- **FIX (minimal):** `_buildStatic` records the static WORLD collider handles
  (`_staticHandles`); `_isPenetrating` passes Rapier's `filterPredicate` so depenetration
  considers ONLY those — props (dynamic on host, fixed on guest) are excluded on BOTH sims (no
  rubber-band). Wall/floor tunnel recovery preserved; prop collide-and-slide unchanged (still
  blocks + shoves). Cleans up symptom 1 too (the failsafe was degrading prop-collision feel).
- **`?debug=1` collider view (NEW):** wireframe of EVERY collider in-world (ground grey, walls
  red, static fixtures cyan, each prop's collider yellow + tracking the shove). Bugs are now
  SEEN, not guessed. Doc: `notes/collider-debug.md`.
- **`shared/bounds.js` (NEW) — ONE shared bounds source** read by the debug view, the guard,
  and diagnosis, reusing physics.js's own size helpers → the check can't drift from the engine.
- **`tools/check-physics.mjs` (NEW):** asserts every collider AABB overlaps its mesh AABB and
  isn't smaller (misalignment guard), and every spawn + hunter spawn is collider-free with no
  arena-sized fixture (open-middle guard). **Hand-traced GREEN** on all three maps (no shell in
  sandbox; some GLBs UNVERIFIED = not in asset-dims, keep the primitive footprint = the mesh).
- **Config unchanged** (no blind tuning). **Files:** `shared/physics.js`, `shared/bounds.js`
  (new), `js/scene.js`, `js/main.js`, `tools/check-physics.mjs` (new), notes + architecture.
- **OWED — live browser pass (Jie, phone):** disguise as a big crate, walk INTO props toward the
  middle → push through/past instead of bouncing; jump onto the divider/wall top → no tunnel/void;
  props still shove + trampleable. Run `node tools/check-physics.mjs` (+ the other check-*.mjs)
  to gate. Open `?debug=1` to eyeball collider alignment.

## [prev] PHYSICS SOLIDITY PASS #3 — RELAUNCH: floor clamp + runnable check (2026-07-11, Jie/Teravortryx, on `main`). Headless invariants pass (hand-traced); live browser pass still owed.

Relaunch of pass #3 (first attempt's session was lost). Pass #3's code (disguise-sized capsule
+ thin-panel min-thickness) was already in the tree; this session re-traced from data, refuted
the empty-measurements theory, and closed the one concrete remaining defect. Full detail:
`memory/notes/physics.md` (top "RELAUNCH").

- **Diagnosis (data-verified):** colliders MATCH meshes on all shipped maps — the primitive
  footprints were already normalized to `native × modelScale(0.75)` (door 2.1, fridge 1.88,
  counter 0.75, food_crate 1.5×0.72, …), so there is no collider-smaller-than-visuals gap and
  no wall top-face height gap. `asset-dims.json` isn't even read at runtime (its keys are GLB
  paths, not the `{dims:{}}` shape config.js expects) — a genuine red herring. The "fall
  through the ground → purple void" in BOTH screenshots is the host respawn's ~0.5 s throttled
  RECOVERY WINDOW (only fires >2 m below floor), not a permanent fall.
- **Fix (minimal, guaranteed):** a per-substep HARD FLOOR CLAMP in `physics.js _substep` — the
  capsule foot can never pass `y=FLOOR_Y` in any substep, applied in the SHARED substep so host
  + every guest predictor match. Kills the void window; lands a tunnelling capsule ON the floor
  instead. Purely additive (no legit sub-floor space anywhere). `FLOOR_Y` is now an exported
  constant. Throttled referee respawn kept as the higher net.
- **Shared pure helpers** `halfExtentsFor` + `thickenWallHalfExtents` extracted from the inline
  collider math; `_buildStatic` uses them (behaviour-identical) and the check imports the SAME
  ones — engine + guard can't drift on collider sizes / which walls thicken.
- **`tools/check-physics-solidity.mjs` REWRITTEN** to a pure-JS, zero-dep, deterministic guard
  that actually runs on bare `node` (the old Rapier-sim SKIPPED everywhere and guarded nothing).
  Asserts, per real map+catalog: (A) world-prop box colliders ≥ their mesh (no sink-in gap) +
  bounded disguise overhang; (B) static box colliders ≥ mesh HEIGHT (no top-face gap) + thin
  panels thickened past the capsule radius; (C) slab top == FLOOR_Y, covers arena, ≫ one-substep
  fall + the engine floor-clamp. **Hand-traced GREEN on all three maps** (no shell to execute in
  sandbox). Run `node tools/check-physics-solidity.mjs` to gate.
- **Props stay movable/trampleable** — the clamp only touches below-floor Y; nothing frozen.
- **Config unchanged.** Did NOT blind-tune `disguiseColliderMaxRadius` (build #38's mistake);
  the ~0.2 m disguise mesh overhang on the widest disguises is the documented passability
  tradeoff.
- **OWED — live browser pass (Jie/Teravortryx, phone):** jump into the divider top / walk a
  crate-disguise into world props / drop off a ledge — confirm no void screen, no walk-inside,
  props still shove + trampleable; watch the console anti-fall warning stays silent.

## [prev] PHYSICS SOLIDITY PASS #3 — disguise-sized capsule + thin-wall min-thickness (2026-07-11, Jie/Teravortryx, on `main`). Code done; NOT live-tested (no shell / headless).

Third pass at the known-hard collision area. Two players reported (1) a player prop passing
through / hiding fully INSIDE world props and (2) jumping into a wall tunnelling through then
falling through the floor. Passes #1/#2 already refuted the movement theories, so this pass
TRACED the two remaining mechanisms and fixed those (not constant-tuning). Full detail:
`memory/notes/physics.md` (top "SOLIDITY PASS #3").

- **Bug 1 root cause = the accepted caveat, now fixed.** A disguised player's physics body
  was a fixed tiny capsule (r0.4) regardless of disguise size, so a big disguise clipped into
  / slid inside world props. New `PhysicsWorld._capsuleDimsFor` + `setPlayerCollider(id,type)`
  grow the capsule GIRTH to the disguise footprint (clamped `[0.4, rules.disguiseColliderMaxRadius=0.55]`
  for doorway passability), keeping TOTAL height/centre constant so grounding/jump feel is
  unchanged. Wired host (`referee.applyDisguise` + load-race) AND each client's own prediction
  (`main.js onSnapshot`) so authority + prediction match. Residual: 0.55 cap leaves ~0.2 m
  edge-clip on the very widest disguises (was ~0.35) — bounded by door width; documented.
- **Bug 2 root cause = thin wall panels.** Divider/side walls are d0.4 static boxes, thinner
  than the capsule is wide → a fast jump into the face can pop through to the far side then
  drop through the floor. `_buildStatic` now enforces `rules.minWallHalfThickness=0.6` on thin
  wall PANELS only (wide+thin: kitchen_wall/wall_header/door/shelf); narrow posts/pillars and
  bulky appliances untouched. Swept mover / CCD / depenetration / terminal-fall clamp kept.
- **Anti-fall teleport now `console.warn`s** counts+map when it fires (should be ~never after
  this pass → early regression signal). Kept as the last-resort net.
- **NEW `tools/check-physics-solidity.mjs`** (authoring-only, LIVE-sim sibling to the static
  checks): asserts prop-can't-penetrate-prop, player-at-jump-speed-can't-cross-wall, player-
  never-below-floor. Rapier-in-Node caveat: tries dev-only `npm i --no-save
  @dimforge/rapier3d-compat@0.14.0` then the CDN, else SKIP+exit 3. **Not executed here (no
  shell)** — hand-traced; run it + a live phone playtest to close.
- **Config:** `rules.json` +`disguiseColliderMaxRadius:0.55` +`minWallHalfThickness:0.6`.
  **Files:** `shared/physics.js`, `shared/referee.js`, `js/main.js`, `shared/config/rules.json`,
  `tools/check-physics-solidity.mjs` (new), notes.
- **OWED — live playtest (Jie/Teravortryx, bring a phone):** disguised prop rests against world
  props (no walk-through/hide-inside); wall jumps don't tunnel/fall-through; props still push +
  trampleable; disguised movement fits through doors; console anti-fall warning stays silent.

## Latest: HUNTER CHARACTER MODEL v1 — animated SWAT soldier for remote hunters (2026-07-11, VRmike, on `main`). NOT live-tested (headless can't load a GLB / animate).

Remote **hunters** now render as an animated third-person SWAT soldier — what OTHER
players (props) see. The LOCAL hunter is UNTOUCHED (first-person, no own body this pass).
Props untouched (still their disguise). No netcode/protocol/physics/collider changes —
reuses the existing position/yaw snapshot state. Full detail:
`memory/notes/hunter-character-model.md`.

- **Assets fetched** (both CC0, Quaternius via poly.pizza; auto-added to
  `assets/manifest.json` + `CREDITS.md`): SWAT body
  `assets/713f6535-f4f3-4367-a4c6-ced126ae0936.glb` (24 `CharacterArmature|*` clips,
  `Wrist.R` bone) + assault rifle `assets/9a0e478c-de82-4773-9b70-a0219bb0057c.glb`.
- **NEW registry `shared/config/character-models.json`** — separate from
  `props.json`/`fixtures.json` ON PURPOSE (those feed collider-baking; a player character
  must not get a collider). Holds body/weapon GLB paths, capsule-match `heightMeters`,
  the 5 clip suffixes, anim tunables, and the HOT-TUNABLE rifle grip offset + facing
  (`yawOffsetDeg`) — grip/facing fixable without a rebuild. `js/config.js` loads it into
  `cfg.characterModels` (tolerant of absence → capsule fallback).
- **`js/scene.js` subsystem** (view-only): lazy GLTFLoader + `SkeletonUtils`; per-hunter
  **rig-safe `SkeletonUtils.clone`** (a plain `.clone()` breaks skinned rigs — avoided);
  sized to the capsule (feet at origin); rifle parented to `Wrist.R`; `AnimationMixer`
  with a velocity-driven idle/run state machine (`Idle_Gun` / `Run_Shoot` / `Run_Back` /
  `Run_Left` / `Run_Right`), timeScale by speed, ~0.15s crossfades. **Velocity is DERIVED
  from successive snapshots** in `syncPlayers` (snapshot has none). Clips matched by
  SUFFIX (guards the `CharacterArmature|` prefix). Only REMOTE players get the model
  (`meshForPlayer(p,{animated:true})`); self stays a capsule. Model-ready state folded
  into the entry kind (`hunter:cap`→`hunter:swat`) so it rebuilds when the GLB lands;
  failed load stays capsule. `setWeaponVisible(bool)` (default visible) hides the rifle
  for later tool-switching. `js/main.js` passes the registry to `buildWorld` + calls
  `scene.updateAnimations(dt)` each frame.
- **Verification (static only — honest):** `node tools/check-hunter-model.mjs` (new,
  authoring-only) asserts assets present+registered+real glTF, registry self-consistent
  + separate from props/fixtures, clip suffixes are real pack clips, scene methods +
  rig-safe clone + wiring exist. `tools/check-blindfold.mjs`'s "every `scene.X()` is
  defined" guard covers `updateAnimations`. **OWED — live browser pass:** props see the
  animated soldier, idle/run play without console errors, rifle sits in the hand, model
  tracks the capsule, local hunter still sees no own body. Then tune grip/facing.
- **Files:** `shared/config/character-models.json` (new), `js/config.js`, `js/scene.js`,
  `js/main.js`, `tools/check-hunter-model.mjs` (new), notes + architecture.

## Latest: "STUCK BLINDFOLD" bugfix #2 — REAL root cause was a render-loop crash, NOT the blindfold (2026-07-11, VRmike, on `main`)

The prior two sessions kept "re-verifying the blindfold" and finding it correct — because
it **was** correct. The actual bug was elsewhere and the blindfold was a red herring.

- **Symptom (live screenshot):** a PROP in the HUNT phase sees a solid dark blue/purple
  screen; HUD ticks fine; world never draws — for EVERYONE, any role, any phase.
- **Root cause:** `js/main.js` `frame()` calls `scene.aimedDisguiseTarget(...)` and
  `scene.highlightProp(...)` (the crosshair-disguise API) but **neither method existed in
  `js/scene.js`** — a half-landed refactor. The `TypeError` threw every frame BEFORE
  `scene.render()` and the `requestAnimationFrame(frame)` re-arm, so the render loop ran
  once and died. Network snapshots kept updating the DOM HUD. A never-rendered transparent
  WebGL canvas showed the body's dark `radial-gradient` CSS background → the "blue/purple".
- **Fix (this session):** implemented the two missing methods in `js/scene.js`
  (`aimedDisguiseTarget` = raycast look-ray vs disguisable prop primitives → hit prop id;
  `highlightProp` = one reused wireframe outline box). Prop render records now carry
  `disguisable`; primitives tagged `userData.propId`. Client-side selection aid only — the
  host's `applyDisguise` stays authoritative. NO blindfold/referee/netcode/physics change.
- **Blindfold confirmed correct & untouched:** overlay present in `index.html`, gate derived
  fresh (`role===HUNTER && phase===HIDING`) off snapshot + phase event, `.hidden`
  `!important` beats `.blindfold`, referee `blindHunterSnapshot` data-half gated the same.
- **Restaurant = default map:** `maps.json` reordered so `restaurant` is the FIRST key.
  The referee default is `Object.keys(this.maps)[0]` and the picker renders in key order,
  so first-key == default-selected. Data-only reorder; block contents byte-identical.
- **New headless check `tools/check-blindfold.mjs`** (authoring-only, never shipped):
  statically asserts every `scene.<method>()` main.js calls IS defined in scene.js (the
  exact regression that broke this), + blindfold decision a/b/c + referee data-half d.
  Run: `node tools/check-blindfold.mjs`. NOTE: authored + hand-traced against source; the
  sandbox has no shell, so it was not executed here — run it + a live browser pass to close.
- **OWED:** one live browser run (prop + hunter) to confirm the world draws with no console
  error and the blindfold behaves; run the two check tools. Files: `js/scene.js`,
  `shared/config/maps.json`, `tools/check-blindfold.mjs`, notes.
  Detail: `memory/notes/anti-cheat-blindfold.md` (Attempt #2).

## Latest: HUNTER BLINDFOLD fix RE-VERIFIED on-disk on `main` (2026-07-11, VRmike bugfix, follow-up session)

A follow-up session (resuming a cut-off attempt) re-read all six pieces on `main` and
confirmed the fix is fully present and correct — **nothing to build.** Checked the SERVED
root files (not the dead `client/` stubs): root `index.html` `#blindfold` div; `css/style.css`
`.blindfold` (z-index:12, `pointer-events:none`, blur, `.hidden`=display:none default off);
`js/ui.js` `setBlindfold` (plain show/hide, non-latched); `js/main.js` `updateBlindfold`
derives `role===HUNTER && phase===HIDING` and is called from BOTH `onSnapshot` (L348) and the
`phase` event (L413), plus force-cleared on back-to-menu (L316) + return-to-lobby (L199);
`shared/referee.js` L708 data-half gated on the same condition via `blindHunterSnapshot`.
No edits made (touching the already-correct gate would be an out-of-scope regression). Still
OWED: the live per-role browser test + deploy/link (can't be done headless). Detail below +
`memory/notes/anti-cheat-blindfold.md`.

## HUNTER BLINDFOLD visual half restored on `main` (2026-07-11, VRmike bugfix)

Reported as "everyone loads into a solid blue/blindfold screen that never clears — props
too." Root cause was NOT a mis-gated overlay: `js/main.js` already derived the blindfold
correctly (`role === HUNTER && phase === HIDING`, driven off both snapshot and phase event),
`shared/referee.js` already withheld prop positions from a blinded hunter correctly, and
`js/input.js` `lookFrozen` was wired. **The visual half was simply missing** — `ui.setBlindfold`
was called but never defined in `js/ui.js`, and there was no overlay div/CSS. So *every*
client (props included) threw `ui.setBlindfold is not a function` on the first snapshot,
breaking the game for everyone.

Fix (additive, no gate/referee/netcode changes):
- `index.html`: added `#blindfold` overlay div (+ `#blindfoldTimer`) inside `#game`.
- `css/style.css`: added `.blindfold` — dark blackout + `backdrop-filter: blur`, z-index:12,
  `pointer-events:none`.
- `js/ui.js`: registered the two elements and added `setBlindfold(blind, seconds)` — a plain
  show/hide + countdown, driven by main.js's existing derived condition (never latches).

Acceptance verified by reading the flow (no live run available in sandbox): props always
compute `blind=false` → world visible at all times; a hunter sees the blackout through HIDING;
the phase event flips `state.phase=HUNTING` and re-derives `blind=false` → overlay clears the
instant HUNT starts. Edge cases (solo/host-start prop, mid-phase hunter joiner) fall out of the
derived condition. Full detail: `memory/notes/anti-cheat-blindfold.md`.

## Status: PHYSICS SOLIDITY PASS #2 on `main` (2026-07-11, Jie) — three specific bugs. Code/wiring done; all three need a LIVE re-test (headless can't verify runtime physics).

Second solidity pass after Jie's playtest. Scope: player controller + disguise rotation +
fall path only (no map/netcode/editor). Full detail: `memory/notes/physics.md` (top
"SOLIDITY PASS #2"). Honest per-bug summary:

1. **Deep-inside-props (Bug 1).** *Filter-excludes-dynamic theory REFUTED* — the movement
   query passed no filter and Rapier's default never excluded dynamic bodies; they were
   already obstacles the capsule blocks against (impulses are the ADDITIONAL shove). Added
   an explicit `EXCLUDE_SENSORS` filter to make that unambiguous (behaviour-identical here).
   Confirmed the controller offset (0.02) is controller-global → applies to dynamic contacts
   too. Residual "looks embedded" is the player-sized capsule < disguise mesh + empty
   asset-dims footprints + a one-substep shove lag — documented, not a controller bug.
2. **Wall-top fall-through (Bug 2).** *Raw-gravity theory REFUTED* — all vertical motion
   already goes through the swept `computeColliderMovement`; no raw translation exists. The
   controller sweeps, so the real cause is the query STARTING inside geometry (wall-top jump
   leaves the capsule a hair inside a thin edge). Added: **depenetration failsafe** (snap
   back to last collision-free pos if a substep starts penetrating; skin-shrunk test so
   resting/pressing never trips it; `feel.depenetrate`, default ON) + **terminal fall clamp**
   (`rules.maxFallSpeed` 20). Verified the void→respawn failsafe is host-level + global to
   all maps (kept). No redundant step-clamp (sweep already covers a single-frame leap).
3. **Rotation snap (Bug 3).** Right-click no longer snaps `dispYaw` to look-yaw; it now
   eases at a capped `rules.disguiseRotSpeedDeg` (270°/s) with a per-increment footprint
   shape-cast gate (`physics.rotationWouldCollide`) that STOPS the turn if it would rotate
   the prop into a wall. Honest caveat: the physics body is a symmetric capsule (yaw can't
   truly wedge it) — the gate tests the PROP footprint so the disguise won't rotate into
   geometry; the fix is mostly the continuous (non-teleport) turn. Client mirrors the ease
   on the own-model (cosmetic; host authoritative + gates).

**Config:** `rules.json` +`maxFallSpeed:20` +`disguiseRotSpeedDeg:270`; `physics-feel.json`
+`depenetrate:true`. **Files:** `shared/physics.js`, `shared/referee.js`, `js/main.js`,
`shared/config/{rules,physics-feel}.json`. **OWED — live re-test:** solidity feel, wall-top
jumps, rotation wedging; watch depenetration for stutter (flip `depenetrate` off if so).

## Status: PHYSICS FEEL TUNING on `main` (2026-07-11, Jie) — three dials + anti-bob. Config/wiring done; FEEL still owed a live playtest (can't be verified headless).

Small focused feel pass after a live playtest: players push deep INTO props before they
react; standing on objects bobs up/down; everything feels bouncy/jello. No architecture
change — tuning constants + one minimal controller-grounding tweak. Full detail:
`memory/notes/physics.md` (top "FEEL TUNING" section). Exact values set:

- **NEW `shared/config/physics-feel.json`** (physics-owned tunables, NOT `rules.json`).
  `config.js` loads it into `cfg.feel`; that ONE object flows to the host's authoritative
  world (`referee.js`) AND every client's prediction world (`main.js buildPredict`), so
  the two sims can't derive mismatched feel and rubber-band. `physics.js resolveFeel()`
  is the single derivation point (null-safe defaults).
- **Restitution → 0** on ALL colliders (ground, walls, static + floor fixtures, dynamic
  props, static-overflow props), from `feel.restitution`. Player capsule is kinematic →
  restitution is a no-op there, so not pretend-edited. Swept: no stray non-zero values.
- **Solver iterations 4 → 12**, `numAdditionalFrictionIterations → 4`
  (`world.integrationParameters`, Rapier 0.14 TGS-soft API, feature-detected + guarded
  with a pre-TGS fallback). Main fix for sink-into-props + most bobbing.
- **Prop damping:** linear 0.5 → **0.4**, angular 0.7 → **0.4** (from config).
- **Anti-bob (`feel.capGroundedImpulse`, default ON):** a player grounded AND standing
  still stops feeding impulses into the prop underfoot (kills the push-down/spring-back
  bob loop); walking into a prop still shoves it (tell preserved).
- **`tools/check-physics-feel.mjs`** (new, authoring-only, never shipped): asserts
  host==client feel derivation + range-checks the dials. `node tools/check-physics-feel.mjs`.
- Files: `shared/config/physics-feel.json` (new), `js/config.js`, `shared/physics.js`,
  `shared/referee.js`, `js/main.js`, `tools/check-physics-feel.mjs` (new), notes.
- **OWED — live feel-test (Jie):** props stop sinking / feel rigid; standing bob gone;
  shoved props settle without wobble; a real shove still reads as a tell. **Bring a
  phone** — if the host phone drops below 60fps, lower `numSolverIterations` first (12→8).

## Status: POLISH/FIX PASS on `main` — 7-item playtest punch list (2026-07-10, VRmike+Jie). Structural-verified; physics FEEL + button VISUALS still owed a live playtest.

Post-merge fix pass on `main` from a VRmike+Jie playtest. All seven landed; the
headless caveat holds (items about physics feel / button visuals can't be eye-tested
here). Per-item:

1. **Tabletop clutter dynamic / built-ins static — ROOT CAUSE FOUND.** `fixtures.json`
   had **no `static`/`decor` flags at all** on `main` (a merge dropped them), so
   `isStaticEntry()` returned false for EVERYTHING → floors, walls, pillars, doors,
   appliances were all becoming DYNAMIC rigid bodies (biggest-first, so the floor/walls
   won the dynamic-cap budget and the room collapsed; tables sank into the jittering
   floor tiles). Fix: re-added `"static": true` to the genuine built-ins ONLY (floor,
   walls, pillars, door, the new divider wall, oven/stove(s)/fridge/cabinets/extractor
   hood/counters/sinks/shelf). Everything else — **all tables** (dining + prep + bar),
   dishrack, every plate/bowl/pot/pan/lid/dish/food/condiment/canister — is left
   UNFLAGGED = dynamic/knockable. The now-dynamic tables settle on a SOLID static floor
   with their clutter instead of fighting it. Files: `shared/config/fixtures.json`.
2. **Jar/cannister rows split.** `jars.glb` is a merged multi-jar cluster with ONE box
   collider (the float/vibrate tell — mesh wider than its single box, one dynamic body).
   No single-jar GLB exists and a baked GLB can't be decomposed here, so per the plan's
   fallback each `jars` placement was replaced with a ROW of individual `canister`
   bodies (primitive cylinders, r0.16×h0.5), each its own dynamic rigid body + matching
   collider. 3 spots × 3 canisters = 9. `jars` catalog entry removed; `jars.glb` now
   inert on disk. Files: `fixtures.json`, `maps.json`.
3. **Dev Map Editor button on PC.** Added `#editBtn` "🛠 Map Editor (dev use only)"
   (index.html) + `.dev-btn` CSS; `main.js` `updateEditorButton()` shows it on desktop
   host/solo (never touch, guest, or host-with-guests — reuses `canEnterEditor`) and
   refreshes on every transition. Click → `enterEditor(true)` which forces the help
   panel open (new public `editor.showHelp()`); Ctrl+E keeps its first-open-only
   auto-help. Editor is reachable (main.js already lazy-imports `js/editor.js`).
4. **Fall-through failsafe** (host referee, `integrate` physics branch, ~0.5 s throttle):
   any live player whose capsule top < floorTop(0) − 2 → teleported to their stored
   `player.spawn` at y0, velocity zeroed (via `physics.setPlayerPosition`); any dynamic
   prop below y=−2 → `physics.respawnEscaped()` sends it back to its spawn transform,
   velocities zeroed. Host-authoritative only; correction rides the normal snapshot (no
   client teleport). Files: `shared/referee.js`, `shared/physics.js`.
5. **Thick floors + outer walls** (`physics.js` `_buildStatic`): ground slab → 3 m thick
   extended DOWN (top still y=0); boundary walls → 1.5 m thick pushed OUTWARD (inner
   face unchanged) + 5 m tall (base y0, can't be jumped/flown over); floor fixtures
   flagged `"floor": true` get a ≥1 m collider extended DOWNWARD with the visible top
   held flush (top = 2·halfH + y). Render meshes untouched.
6. **CCD** enabled on the player capsule (`body.enableCcd(true)`) and on dynamic prop
   bodies (`setCcdEnabled(true)`), both method-guarded. `physics.js`.
7. **Kitchen divider service-window wall** (`fixtures.json` + `maps.json`): no wall-with-
   window GLB exists (modular_walls is an unusable multi-panel kit), so per the approved
   plan it's built from plain static boxes at true height (~2.8 u): the existing divider
   COUNTERS are the waist-high window sills, new `wall_post` verticals frame the bays,
   `wall_header` lintels (base y2.1) close the tops → open service windows facing +z
   (dining), with the two existing walkway gaps (x≈±7.5) kept clear.

**HEADLESS CAVEAT (unchanged rule):** items 1/2/5/7 are verified STRUCTURALLY (right
flags, right sizes, tops flush, wall geometry in the data) — NOT by eye. Physics FEEL
(tables settling, jars behaving, no residual jitter), the divider wall LOOK, and the dev
button's on-screen placement need the live playtest. A small follow-up nudge on wall
placement or table/jar behaviour is a realistic outcome. Detail in
`memory/notes/{physics,restaurant-map,level-editor}.md`.

## Status: IN-GAME LEVEL EDITOR (debug mode) COMPLETE + COMMITTED (attempt 3, 2026-07-10, vrmike). Desktop-only, not live-tested (headless).

## Status: PHYSICS FIX PASS — controller + knockable world + calm start (2026-07-10, on `physics-net`). NOT feel-tested.

Playtest-driven fix pass on the ALREADY-BUILT physics/netcode. Full detail in
`memory/notes/physics.md` (top section) + `netcode.md`. Honest summary:

- **MERGE NOT DONE (blocked, honest).** Task said FIRST `git merge origin/main`
  (bbox-normalized layout + populated `asset-dims.json`). No shell here by design →
  can't run the merge; main's populated blobs are zlib git objects the file tools
  can't inflate. The measured-bounds CONSUMPTION path is already wired on this branch
  (`shapeFor`→`c.measured`, scene→`c.measured`) with a graceful fallback to authored
  footprints, so colliders bake from measured bounds automatically once the data
  lands. `asset-dims.json` is still `dims:{}` → authored footprints in use.
  **OWED: someone with a shell must merge origin/main into physics-net.**
- **Fix #1 controller** (`shared/physics.js`): diagnosis corrected — the branch code
  was ALREADY compute-before-move (`computeColliderMovement` + apply corrected delta)
  and prediction ALREADY shares the same `PhysicsWorld` as the host, so the
  "translate-first eject" hypothesis didn't match. Real fixes: (a) **jump jitter** —
  snap-to-ground toggled OFF while `vy>0`, ON otherwise; (b) **character mass** 3.0 +
  **prop density** 1.0 so shoving a chair feels natural (needs feel-test); (c)
  **fixed timestep** — `step()` runs whole 1/60 substeps via an accumulator, no
  variable partial tail; (d) offset/autostep/slope/snap tunables in rules.json.
- **Fix #2 flip static→dynamic** (`physics.js` `isStaticEntry` + catalog flags +
  `referee.js`): world now defaults KNOCKABLE. Static only for `"static"`-flagged
  built-ins (floor/walls/pillars/doors/hood/counters/cabinets/oven/fridge/sinks/
  shelves) and `"decor"`-flagged tiny garnish. Tables, cookware, plates, dishes,
  food, condiments → dynamic. Decoupled dynamic-ness from the disguise pool: referee
  builds ONE prop stream = disguise props (disguisable) + non-static fixtures
  (non-disguisable); disguise gates skip non-disguisable. Cap raised 60→130. Disguise
  range now reads LIVE prop positions (`referee.propLive`).
- **Fix #8 mid-join** (deliberate change): late joiners get CURRENT prop transforms
  (centre+quaternion via `PhysicsWorld.allProps()`), not spawn — a kicked chair stays
  kicked. STARTED prop entry gained `disguisable` + optional live quaternion form.
- **Fix #3 calm start**: dynamic bodies spawn `SPAWN_EPS` (0.02) above rest so
  nothing interpenetrates at match start; settle + sleep. Nothing overlaps at spawn
  by construction.
- **Files:** `shared/physics.js`, `shared/referee.js`, `shared/protocol.js` (doc),
  `js/scene.js`, `js/main.js`, `shared/config/fixtures.json` (static/decor flags),
  `shared/config/rules.json` (cap 130 + controller/prop tunables), notes.
- **NEEDS A LIVE FEEL-TEST (can't be done headless):** does jumping feel smooth; does
  shoving a chair/table feel natural (tune characterMass + propDensity); is the
  match-start settle of ~130 bodies calm on all 3 maps; does a phone HOST hold frame
  rate with the bigger dynamic set (lower `maxDynamicProps` if not); mid-join shows
  the knocked-about room correctly; prediction/reconciliation still smooth with the
  fixed-timestep mover.

## Status: MEASURED-BOUNDS COLLIDER SEAM + PROP CAP (2026-07-10, on `physics-net`). NOT playtested.

Context correction first: the "big pass" below (Rapier physics + full prediction/
reconciliation netcode) was **already built and wired** on this branch by the
2026-07-09 session — it is NOT re-done here. This follow-up task assumed two things
that were both FALSE on disk: (a) that physics still needed implementing, and (b)
that a measured `shared/config/asset-dims.*` file from a bounding-box normalization
build already existed. It did **not** — colliders were (and by default still are)
baked from the hand-authored primitive footprints in `props.json`/`fixtures.json`.

I could NOT produce measured GLB bounds here (no shell; `Write` is text-only, can't
decode binary `.glb` to compute a bbox — that measurement IS the "prior build" that
never landed its output). Rather than **guess sizes** (explicitly forbidden) or
silently declare victory, I wired the **drop-in seam** so measured bounds bake
automatically the moment they exist, and shipped the file EMPTY (zero behavior
change today). Asked VRmike which path to take; got no answer, took the
non-destructive recommended one.

- **`shared/config/asset-dims.json`** (NEW, ships empty `dims:{}`): the output slot
  for the bounding-box build — per catalog type, the normalized **world-space**
  `{w,h,d}` box. Documented contract in the file + `memory/notes/asset-dims.md`.
- **`js/config.js`**: `loadConfig` fetches it (tolerant of absence) and attaches
  `entry.measured` onto the matching catalog entry. One mutation reaches all three
  consumers via the shared `cfg` object: host referee's `PhysicsWorld`, each
  client's prediction `PhysicsWorld`, and the renderer.
- **`shared/physics.js` `shapeFor`**: if `c.measured` present → bake a **cuboid from
  the measured bounds** ("cuboid from measured bounds; trimesh only where clearly
  wrong"); else fall back to the primitive footprint. Also added the plan's
  **phone-safety cap** (`rules.maxDynamicProps`, default 60): props past the cap are
  solid STATIC colliders (collidable, not shovable). Restaurant (~56) is under it →
  inert today.
- **`js/scene.js`**: GLB mesh scale now prefers `c.measured` over `modelDims`, so
  mesh and collider stay in lockstep once measurements land (all 3 scale paths).
- **Regression**: with `dims:{}` empty, every `c.measured` is `undefined` → all `||`
  chains fall through to the exact pre-seam path. Byte-for-byte prior behavior;
  verified by inspection (headless can't runtime-test). Files: `shared/config/
  asset-dims.json` (new), `js/config.js`, `shared/physics.js`, `js/scene.js`,
  `shared/config/rules.json`, `memory/notes/asset-dims.md` (new), `physics.md`.
- **STILL OWED**: run the bounding-box normalization build and populate
  `asset-dims.json` so colliders bake from real measurements instead of the
  eyeballed footprint fallback. Until then, collider sizes = the same footprints the
  big pass shipped. Live multiplayer playtest still the only real QA for netcode.

## Status: IN-GAME LEVEL EDITOR (debug mode) BUILT (2026-07-10, vrmike). Desktop-only, not live-tested (headless).

A lightweight edit mode baked into the client so a human can fix placement/rotation/
scale by eye instead of iterating blind builds. **Ctrl+E** (desktop) toggles it. Full
detail: `memory/notes/level-editor.md`.

**Attempt history:** attempt 1 built the core editor in the working tree (fly/select/
move/rotate-R/scale-±/palette/delete/export + the `scene.js` visual-scale support +
`main.js`/`input.js` wiring) but was cancelled before committing; attempt 2 died on a
sandbox wall and committed nothing useful. **Attempt 3 (this session)** found all of
attempt 1's work intact in the working tree, filled the three missing listed
requirements — **help panel (req 9)**, **mouse-wheel rotate (req 4)**, **inspector
scale slider (req 5)** — in `js/editor.js` + `css/style.css`, verified the round-trip
and the client-only/no-shared-touch guarantees, and committed the whole feature.
`js/input.js` was checked for the "stray stub" the brief warned about: none — its only
editor code is the legitimate Ctrl+E→`onToggleEdit` detection. Highlights:

- **Help (req 9):** a **?** footer button + **?** key opens a modal with every control
  and a "how to save" note (Copy map JSON → paste to DevBot in Discord #devbot naming
  the map → bot commits). **Auto-opens the first time** edit mode is entered, then a
  `localStorage` flag stops it nagging.
- **Rotate (req 4):** mouse wheel now rotates the selection ±15° (Shift = fine), the
  same yaw-only path as R (was previously a no-op).
- **Scale (req 5):** inspector gained a 0.1×–5× range slider alongside the +/- keys.

- **Client-local SANDBOX, not a paused match** — the honest reason it's genuinely
  client-only. Ctrl+E steps OUT of the game loop into `Editor` (`js/editor.js`), which
  owns its own THREE scene + free-fly camera and loads the map fresh from config. The
  referee/netcode/match-flow are never touched (they keep ticking; the editor ignores
  them). Gated to solo/local play (`canEnterEditor`): desktop only, blocked as a guest
  or as a host with guests. Frame loop + input loop early-return while `state.editing`.
- **Reuses ONE renderer + scene.js mesh helpers** (`makePropMesh`, `instantiateModel`,
  `targetSizeForEntry` now exported) so edited objects size EXACTLY like the game.
  Own isolated GLTF loader (game renderer untouched). NO pointer lock — free cursor,
  right-drag to look — so it never contends with input.js's desktop lock path.
- **Controls:** WASD+Space/Shift fly; click select (outline + inspector: name/pos/rotY/
  scale/REAL bbox size from asset-dims.json, lazy-fetched); left-drag move (Shift=up/
  down), G snap-to-floor; R rotate 15° (Shift fine, Alt reverse); +/− scale 0.1–5×;
  palette (click / 1–9) spawns at crosshair ground point at normalized scale; Del
  delete + **U undelete** (restore stack); footer map dropdown; Copy/Download full
  `maps.json` (edited map's fixtures/props replaced, others byte-identical).
- **Prerequisite that landed with it — per-object `scale` (VISUAL-ONLY).** The loader
  read y/rot but NOT scale. Added additive, inert-for-existing-maps `scale` support in
  `scene.js` only (fixture + prop visuals), plus a CLIENT-side zip in `main.js` STARTED
  that reattaches authored prop `scale` onto the referee's prop instances by index. Per
  the approved "client-side fix" scope + constraint 9, `shared/physics.js` and
  `shared/referee.js` are UNTOUCHED — so scaled objects render exact but their COLLIDERS
  stay base-size (documented gap; most edits are at scale 1).
- **Touched files:** `js/editor.js` (new), `js/main.js`, `js/input.js` (Ctrl+E →
  `onToggleEdit` only), `js/scene.js`, `css/style.css`. NO change to shared/ (referee/
  protocol/net/physics). **Zero boot fetches** (editor + its dims fetch are lazy).
- **Playtest owed:** Ctrl+E in lobby → fly/select/transform/spawn/delete/undelete →
  export → paste back into maps.json → reload → layout matches incl. rot + scale; and
  confirm Ctrl+E refuses during a real multiplayer match.

## Status: RESTAURANT BOUNDING-BOX NORMALIZATION — measured scales (2026-07-10, vrmike). Not playtested (headless).

Stops guessing per-object scales; every restaurant GLB is sized from its MEASURED
native bounding box. Prereq for the physics build (colliders bake from these bounds).
Full detail: `memory/notes/restaurant-map.md` (top "THIRD PASS"). Highlights:
- **Measurement step** `tools/measure-glbs.mjs` (authoring-only, never shipped/imported):
  parses each GLB's JSON chunk, transforms POSITION accessor min/max by node world
  matrices (FBX2glTF bakes ×100 on the mesh node — must apply it). Output committed to
  `shared/config/asset-dims.json` (build-time reference; NOT fetched at page boot →
  headless load stays green).
- **One measured scale.** The KayKit pack is internally consistent, so a single world
  scale normalises all of it: `restaurant.modelScale = 0.75` (door 2.8→2.1, fridge
  2.5→1.88, chair 1.21→0.9, counters/tables→0.75). scene.js `_instantiateModel` gained a
  `scale` branch (native×scale, base flush at y=0); `map.modelScale`/per-entry
  `modelScale` feed it; disguises worn at the same scale (burger-sized, not player-sized).
- **Fixed the actual bugs:** floor podium (native tile 0.5 thick → modelDims `8×0.06×8`,
  flush); ankle-height counters + dollhouse walls were multi-module KITS
  (`modular_kitchen_parts` = 12 modules across ~15u; `modular_walls` = panel variants)
  fit-to-target into one tiny blob → `counter` now uses `kitchen_cabinet.glb`,
  `kitchen_wall` is a primitive box. Chairs flipped +π to face inward (pass-2 note
  predicted the +z front). Food `y` re-derived from new surface tops.
- **Physics bounds** (primitive w/h/d — what `physics.shapeFor` bakes colliders from) set
  to native×0.75 for measured items. Loader/fallback/referee/protocol untouched;
  circus_lot/toy_workshop untouched (no modelScale key → legacy path).
- **Playtest owed:** pick restaurant → floor at ground level, full-height walls,
  hip-height counters/sinks, player-scale door/fridge, chairs facing tables, food ON
  surfaces. Verify the two kit GLBs no longer appear. circus/toy still load.

## Status: PHYSICS + MULTIPLAYER NETCODE — THE BIG PASS (2026-07-09, on `physics-net`). NOT playtested (can't be, headless).

The single-pass "yolo" build VRmike approved: Rapier physics + host-authoritative
netcode with full client-side prediction + reconciliation, all at once. Full detail
in `memory/notes/physics.md` + `netcode.md`. **Which architecture shipped: the
TARGET** (prediction + rewind/replay reconciliation for the local player), NOT the
interpolation-only fallback. Honest status below.

- **Rapier engine** (`shared/physics.js`, `PhysicsWorld` + `loadRapier`): WASM,
  lazy-loaded at match start (zero boot fetch — headless load check stays green).
  Cuboid/cyl/cone/ball colliders from the catalog primitive footprint (NOT convex
  hulls from the GLBs — deliberate: GLBs load async/can fail; documented).
- **Players** = kinematic capsule character bodies (run, JUMP, real collide-and-
  slide vs walls/fixtures — fixes the old clip-through-everything gap — shove
  dynamic props, never knocked over). **Fixtures/walls/ground** = static colliders.
  **Props** = dynamic rigid bodies that get shoved (the TELL vs kinematic disguises).
- **Host** runs the one authoritative world (`referee.integrate` → physics.step),
  broadcasts player transforms + AWAKE-only prop transforms at 15 Hz with per-player
  `ack` seq. **Guests + host** predict their own player in a local Rapier world and
  reconcile (rewind to authoritative + replay unacked inputs + ease/snap residual).
  Remote players + awake props interpolate.
- **Disguise orientation lock**: disguised prop keeps a fixed facing while moving;
  hold right-click (desktop) / ROTATE (touch) to yaw-rotate — never tips. This is
  the roadmap "locked orientation" + the fake-nudge precursor.
- **Jump**: Space / JUMP button. Input protocol gained `seq, jump, rotUnlock`;
  snapshot gained `y, ack` per player + `props[]`.
- **GRACEFUL DEGRADE**: if Rapier can't load, BOTH sides fall back to the old flat
  2D movement (no collision/jump/props) — playable, never a hard stop.
- **Regression-safe**: circus_lot/toy_workshop (no fixtures) build ground+walls+
  dynamic props only; solo play = host-only physics (no netcode); mid-game join adds
  a physics body; persistent lobby tears the world down on reset. Rules/referee phase
  machine unchanged. 2D fallback preserves exact prior behaviour.
- **UNTESTED — the load-bearing caveat**: the bot check is a headless LOAD test; it
  CANNOT feel-test physics/netcode. Prediction jitter, prop-shove rubber-band, jump
  smoothness, and the reconcile snap threshold all need a LIVE multiplayer playtest
  with real people + real pings. Expect a tuning pass. Files: `shared/physics.js`
  (new), `shared/referee.js`, `shared/protocol.js`, `js/main.js`, `js/scene.js`,
  `js/input.js`, `css/style.css`, `shared/config/rules.json`.

## Status: RESTAURANT MAP — SECOND PASS / LAYOUT FIX (2026-07-09, on `vrmike/dev`). Not yet playtested.

The `restaurant` map got a full layout rework on the SAME footprint (size 36 — density
by ADDING objects, never shrinking bounds). Full detail: `memory/notes/restaurant-map.md`
(top "SECOND PASS" section). Highlights:
- **Floor slab clipping FIXED** via a new non-uniform `modelDims:{w,h,d}` scale path in
  `js/scene.js _instantiateModel` — the floor was scaling uniformly to width 8, which
  inflated its thickness into a ~2-foot checkerboard slab. `floor_kitchen` now forces
  8×0.2×8 (flush, thin) regardless of the GLB's native proportions.
- **Prop `y` offset** added (referee `this.props` build → `STARTED` → scene props loop),
  mirroring the existing `rot` pass-through, so a disguisable food item can sit ON a
  table. Disguise range is x/z-only, so y is purely visual.
- **Kitchen/dining split** by a divider counter line at z=−4.5 (two walkways). Kitchen
  gear along the back + a prep row; dining = 6 round tables (chairs each rotated to face
  their table via `rot=atan2(dx,dz)`) + large/small tables. ~90 fixtures, ~56 props.
- **Food on surfaces** (fixtures with y), most decorative food is fixed (non-disguisable,
  zero bandwidth); only ~6 disguisable food props remain, on tables.
- **All pack assets now referenced** (menu, knife, planks, towels, jars, dinner, extra
  stoves/crates/dishes/raw+cut foods). New catalog entries in fixtures.json + props.json.
- **Pass-2 FINISH (this session):** every remaining catalog GLB that was defined-but-
  never-placed (~27) is now instanced as a decorative FIXTURE — side cook-line
  (stove_plain/stove_single), a modular_walls panel per kitchen side, all leftover
  prepped/raw food + whole produce on kitchen surfaces, and ketchup+mustard PAIRS on
  every dining table. Props-catalog keys (ketchup, mustard, pan, plate, whole veg)
  referenced from fixtures[] render via the merged catalog but never join the disguise
  pool (built from props[] only) — zero bandwidth, non-disguisable. DATA-ONLY append to
  the restaurant map object; no engine change; other two maps untouched. Req 3 (use ALL
  assets) now fully closed. Detail: `memory/notes/restaurant-map.md` (pass-2 finish).
- ONLY three tiny engine changes (`modelDims` non-uniform scale, prop `y` thread, dims
  pass-through); circus_lot/toy_workshop untouched (no `fixtures`/`modelDims`/prop-`y`
  keys → same code paths as before). ⚠️ Playtest note: if chairs face OUTWARD, chair
  GLB native front is +z not −z → add π to every chair `rot`. See restaurant-map.md.

## Status: RESTAURANT REAL GLB MESHES WIRED IN (first pass, 2026-07-09, on `vrmike/dev`). Superseded by the layout fix above.

The `restaurant` map now renders the real CC0 "Restaurant Bits" GLB meshes (Kay
Lousberg) instead of primitive boxes. An earlier bulk fetch had downloaded the GLBs
into `assets/restaurant/` but never hooked them into rendering (and left scratch
junk behind); this session did the wiring + cleanup handoff.

- **Map rebuilt from the real GLBs** (`shared/config/maps.json` → `restaurant`): a
  coherent small restaurant — tiled kitchen (floor_kitchen, fridge/oven/stove/
  extractor/counter/sink/cabinets/shelf along the back, counter islands +
  kitchen_table), a modular_walls + pillars divider with passages, a dining room
  (round/large/small tables), and a door. Static geometry → `fixtures[]`; small
  movable items → `props[]`.
- **Two catalogs now** (requirement 3, defense-in-depth): `props.json` is the
  disguise catalog (movable items ONLY) and the new `shared/config/fixtures.json`
  holds the static building pieces. Kept in separate files so a fixture can never
  enter the disguise pool. Each entry carries a `model:` path to the clean GLB name,
  keeping the primitive shape as fallback + size target. `config.js` loads both;
  `scene.js` merges them (`{...cfg.props, ...cfg.fixtures}`) purely for rendering.
  The referee still builds the pool from `map.props` only — it never reads either
  catalog.
- **Lazy client-side GLTFLoader** in `js/scene.js`: primitives render instantly at
  match start, then the referenced GLBs load (CDN import, deduped) and swap in over
  them; the primitive stays as an invisible camera collider. Missing/failed GLB →
  primitive stays visible (per-item fallback). Disguises wear the real mesh once
  cached. `index.html` importmap gained a `three/addons/` entry (declares only — no
  boot fetch). Referee untouched (still builds the pool from `map.props` only).
  Full detail: `memory/notes/restaurant-map.md`.
- **CLEANUP OWED — needs a shell (this sandbox has none).** The bulk fetch dumped
  junk that is inert but still on `main` and could NOT be deleted here (no shell /
  rm; Write is text-only; there is no file-delete tool). Nothing references any of
  it. Delete from a shell session:
  ```
  git rm -r _meshwork
  git rm bundle.html fetch_meshes.sh assets/restaurant/manifest.json
  # 18 hash-suffixed GLB duplicates (each has a clean twin that is KEPT). Do NOT use
  # a `*_??????????.glb` glob — it would also match the legit shelf_papertowel.glb
  # (`papertowel` is exactly 10 chars). Enumerate them:
  git rm assets/restaurant/tomato_EVTveOjwHG.glb \
         assets/restaurant/round_table_KZXCuGx1WZ.glb \
         assets/restaurant/round_table_oravj1kSy2.glb \
         assets/restaurant/door_MSIuI2jpqb.glb \
         assets/restaurant/pan_O5t9nVpPjd.glb \
         assets/restaurant/kitchen_cabinet_corner_Pieyzl60FA.glb \
         assets/restaurant/kitchen_cabinet_sS6Llv1TG5.glb \
         assets/restaurant/potato_acwBoZQNdm.glb \
         assets/restaurant/stove_cT99QUoCCn.glb \
         assets/restaurant/chair_eGccH9cqom.glb \
         assets/restaurant/kitchen_table_hM1OMnevjc.glb \
         assets/restaurant/kitchen_table_jrwQfpN0LV.glb \
         assets/restaurant/kitchen_table_ocdwmd2IKZ.glb \
         assets/restaurant/dishrack_phJwmk2B4X.glb \
         assets/restaurant/stew_rPa4vEsC9c.glb \
         assets/restaurant/shelf_papertowel_uJ60T0cGEG.glb \
         assets/restaurant/lettuce_yC6B73sG9s.glb \
         assets/restaurant/pot_of_stew_zXG0jZ4QiC.glb
  ```
  `assets/restaurant/manifest.json` and `_meshwork/fetch.log` are the fetch script's
  own artifacts (they list the dupes above) — removed by the lines above. NOTE:
  `kitchentable_sink_la.glb` has a 2-char suffix and is NOT a dup — KEEP it. The map
  references only clean names, so no config reference fix is needed. `fetch.log`
  confirms all 111 downloads succeeded (fail=0), so every clean GLB the map uses is
  a real, non-empty binary.

## Status: EARLIER restaurant map build (primitive stand-ins) — superseded by the GLB wiring above.

A third selectable map (`restaurant`) + the small engine seam for STEP 3's
static/dynamic split. Data-driven, so it's host-selectable through the existing
picker with no new wiring.

- **New `map.fixtures[]` seam** — maps can now carry immovable **fixtures**
  (walls, counters, stove, oven, fridge, cabinets, sinks, large/anchored tables)
  separately from **props** (the movable disguise pool: chairs, stools, crates,
  pots, pans, plates, bowls, cutting boards, food/burgers). Fixtures render +
  join `scene.colliders` client-side but the referee never treats them as
  disguisable (it still builds the pool from `map.props` only). ONE engine change:
  a `for (const f of map.fixtures || [])` loop in `js/scene.js buildWorld` — older
  maps (no `fixtures` key) are untouched. No protocol/referee change (every client
  has maps.json locally). Files: `shared/config/props.json` (restaurant shape
  catalog), `shared/config/maps.json` (`restaurant` map), `js/scene.js` (fixtures
  loop). Full detail: `memory/notes/restaurant-map.md`.
- **Honest mapping of "collision + static/dynamic":** this engine has NO
  rigid-body physics and NO player-vs-object collision (players pass through
  everything — documented gap). Its only collision primitive is the third-person
  camera's `scene.colliders` raycast; "give everything collision" = adding it to
  that set, which both fixtures and props now do. Real player collision would be a
  separate, bigger lockstep change (referee `integrate` + client prediction).
- **[HISTORICAL] GLBs were unfetchable in the two prior sessions** (no shell /
  network / binary-write in that sandbox), so the map shipped on primitive
  stand-ins and reported it honestly. That is now RESOLVED: a later bulk fetch put
  the real GLBs on disk, and the 2026-07-09 wiring session (top of file) hooked them
  into rendering. The prediction held — no client code assumptions changed; only the
  assets had been missing, plus the lazy-loader wiring the notes had pre-scoped.
- **Playtest owed:** pick `restaurant` in lobby → everyone spawns in it; enclosed
  kitchen+dining reads right; disguise into a chair/crate/burger; tag works;
  camera pulls in on fixtures; circus_lot + toy_workshop still load unchanged.

## Status: THIRD-PERSON CAMERA BUILT (earlier session, on `vrmike/dev`). Not yet playtested.

The local player is now **third-person by default** (was first-person). A camera
orbits behind + slightly above them off the existing yaw/pitch; they now see their
OWN model/prop (built via the same disguise/role path other peers are drawn with).
**Camera/view change only** — movement, roles, collision, networking, and the
referee are untouched.

- **Aim decision (the one gotcha):** the referee's tag cone / disguise still
  compute from yaw-forward — NOT touched. Since the third-person eye is off the
  player, the reticle is now driven off that yaw-forward vector
  (`scene.aimScreenPoint` → `ui.setCrosshair`), not screen center, so tag/disguise
  land where the reticle points. First-person recenters the reticle.
- **Collision-aware:** the engine already exposes `THREE.Raycaster` (so pass two
  was cheap). Walls + static props go into `scene.colliders`; a per-frame ray from
  the player pulls the camera in on a hit (min dist 1.2, 0.3 skin). Ground and
  avatars are excluded on purpose. Snap-in / ease-out (0.12) smoothing.
- **Own model:** `syncPlayers` no longer skips self — `_syncSelf` builds the local
  avatar via `meshForPlayer`; positioned each frame from the PREDICTED pos/yaw so
  it tracks the camera without snapshot lag.
- **First-person toggle kept** (it was clean): desktop **V** flips camera +
  own-model + reticle behind one `scene.setThirdPerson()` flag. No touch button.
- Files: `js/scene.js`, `js/main.js`, `js/input.js`, `js/ui.js`. No CSS/HTML/
  referee/protocol/net changes, no new deps. Full detail:
  `memory/notes/third-person-camera.md`. **Playtest owed** (orbit, wall pull-in,
  tag/disguise-under-reticle, V toggle; desktop + phone).

## Status: MULTIPLAYER + MOBILE UPDATE BUILT (earlier session, on `vrmike/dev`). Not yet playtested.

Four things landed together, all against the seams the notes already named:

1. **Solo launch.** `minPlayers` → 1 (`rules.json`). `startMatch` role math now
   keeps ≥1 prop (`hunterCount = min(max(1,round(n*hunterRatio)), n-1)`), so a lone
   host is a **prop** and can walk/disguise while testing a map; a zero-hunter
   round has no instant win and runs on the timer. `checkRoundOver` already only
   ends early when props existed and all died, so no change needed there.
2. **Mid-game join.** `Referee.addPlayer` is the single gate; during HIDING/HUNTING
   it routes to new `admitMidGame(player)`, which slots the newcomer in as a
   **hunter**, spawns them, and sends the SAME filtered catch-up every guest gets
   (`STARTED` + private `ROLE` + current phase/clock + normal snapshots) — never the
   host's full state. `net.js` already called `addPlayer` on every guest connect
   regardless of phase, so no network change was needed. Guest side is pure
   presentation (`STARTED` drops it into the running game).
3. **Persistent lobby.** Already returned ENDING→LOBBY keeping the map; this session
   confirmed nothing else resets (peers stay open, host stays host, list survives)
   and added `lastResult` (rides `S2C.LOBBY`) so the lobby shows the previous
   winner. `main.js` tidies per-round view state on return WITHOUT reconnecting.
4. **Phone / touch controls.** Whole layer in `js/input.js`: nipplejs joystick
   (lazy CDN), hand-rolled drag-to-look, on-screen action button, "Tap to play" +
   iOS audio unlock, portrait/landscape CSS, `touch-action:none`, `100dvh`, DPR cap
   (pre-existing), wake lock (+ phone-host warning), `webglcontextlost` guard. Only
   wired on touch devices — desktop WASD + mouse-look is UNCHANGED. Full detail:
   `memory/notes/touch-controls.md`.

Files touched: `shared/config/rules.json`, `shared/referee.js`, `shared/protocol.js`
(doc), `js/main.js`, `js/input.js`, `js/ui.js`, `js/scene.js`, `index.html`,
`css/style.css`. See `memory/notes/{game-loop,touch-controls,input-mouselook}.md`.

## Status: LOBBY MAP SELECTION BUILT (earlier session, on `vrmike/dev`).

The host can now pick the round's map from the lobby (two maps: `circus_lot` +
`toy_workshop`). One validation gate (`Referee.setMapId`), one new lobby message
(`C2S.PICK_MAP`), a data-driven picker UI, and the pick survives reset-to-lobby.
Full detail: `memory/notes/map-selection.md`. **Not yet playtested** (see the
map-selection checklist under Open threads).

**Why this was a "finish the broken build":** an earlier map-selection attempt
lived on branch **`jie/dev`** (commits "The lobby host should be able to see a list
of available maps to play" + "BUILD IT"). The active branch became `vrmike/dev`,
cut from a point *before* that work, so the partial build was stranded on `jie/dev`
and the working tree looked untouched ("someone broke it by renaming the channel"
= the branch switch). I could not reach `jie/dev`'s file contents (no shell; git
objects are compressed), so I reimplemented cleanly on `vrmike/dev` against the
seam the notes already named, per VRmike's approved plan. **If `jie/dev` is ever
pulled back, diff — do NOT blind-merge; this `vrmike/dev` version is intended.**

## Status: FIRST REAL P2P JOIN CONFIRMED. Earlier session: CDN deps made lazy so the headless load check is clean (no boot-time external fetches).

**2026-07 playtest update (VRmike):** the game launches and **two players joined a
lobby together** — first confirmation the PeerJS/WebRTC join path actually works
across the wire (partly closes gap [9]; a full round still unverified). One bug
found and fixed this session: the "Click to play" overlay never dismissed, so
mouse-look was dead (WASD still worked). See [I] below.

## Status: static-Pages deploy fix + PeerJS signaling done in code.

This session fixed the **broken Cloudflare Pages deploy**. Root cause: the P2P
rebuild left a Node matchmaker in `server/` and the game nested under `client/`.
Pages serves static files only (can't run the matchmaker) and serves from where
`index.html` sits, so the nested layout 404'd. Fix = flatten to the repo root +
retire the matchmaker in favour of PeerJS's public broker. Game rules/referee are
unchanged. **Not yet verified across real networks** — see the playtest gap [9].

### Done this session
- [A] **Flattened to the repo root.** `index.html`, `js/`, `css/` now sit at the
      root alongside `shared/` and `assets/`. All refs are root-absolute, so they
      survived the move. Pages: output dir = repo root, no build.
- [B] **Retired the Node matchmaker.** Signaling is now **PeerJS's free public
      broker**. No server of ours anywhere.
- [C] **Rewrote `js/net.js` onto PeerJS.** Host = `Peer('prophunt-<code>')`;
      guest = anonymous `Peer` + `peer.connect(..., {reliable:true,
      metadata:{name}})`. Reliable+ordered kept via `{reliable:true}`. ICE
      servers injected via the `Peer` `config` option (STUN + TURN preserved).
      Host bridges each guest `DataConnection` into the referee. Referee itself is
      transport-agnostic and was NOT touched.
- [D] **Join/leave now = PeerJS events** (`conn.on('close')`), replacing the old
      SIG host-left/peer-left messages. Deleted the `SIG` protocol and the dead
      `C2S.CREATE/JOIN` from `shared/protocol.js`.
- [E] **Direct/relayed lobby badge preserved** — detection now reads
      `conn.peerConnection.getStats()` (PeerJS exposes the RTCPeerConnection).
- [F] **Join-by-link**: `#CODE` in the URL auto-joins on boot; lobby has a
      "Copy invite link" button. See `main.js` `tryJoinFromHash` / `wireMenu`.
- [G] `package.json` trimmed to a static project (dropped `ws` + node scripts).
      README + all memory notes updated.

### Follow-up session (check-repair)
- [H] **CDN imports moved to jsDelivr** to clear two `net::ERR_FAILED` from the
      automated headless-load check. three.js (`index.html` importmap) and PeerJS
      (`js/net.js`) were the only two boot-time external fetches; esm.sh's runtime
      transpile in particular can cold-start/redirect slowly enough to fail a
      headless load. Now `https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js`
      and `.../peerjs@1.5.4/+esm` — prebuilt ESM, no build step. Broker/TURN
      services unchanged (this was the *library* download only).

### Follow-up session (check-repair — lazy CDN loading)
- [J] **Killed two boot-time `net::ERR_FAILED`s for good by lazy-loading the CDN
      deps.** The headless load check kept flagging the same two external fetches
      (three.js + PeerJS) even after [H] swapped esm.sh → jsDelivr. Root cause: the
      check runs with **no outbound network**, so *any* fetch during page-load
      fails — the CDN *provider* was never the problem, doing the fetch at boot
      was. Fix (small, in-lane):
      - `js/net.js`: removed the top-level `import { Peer }`. New `loadPeer()`
        dynamic-imports PeerJS once on the first `create()`/`join()`; `_startHost`/
        `_startGuest` are now `async` and `await` it (graceful onStatus error if the
        CDN is down).
      - `js/main.js`: removed the top-level `import { Scene3D }`. `scene` starts
        `null`; `ensureScene()` dynamic-imports `scene.js` (which pulls Three.js)
        on the first `STARTED`. All `scene.*` calls are guarded (`if (scene)`), and
        `setSelf` is re-applied when the scene finally builds.
      Result: a bare landing page makes **zero** external requests → the headless
      load is clean. Gameplay still pulls both libs from jsDelivr on demand (CDN
      import, no build step — constraint intact). `index.html` importmap unchanged
      (it declares, doesn't fetch). Details in `memory/notes/netcode.md`.

### Earlier session (mouse-capture fix)
- [I] **Fixed the stuck "Click to play" overlay** (pointer-lock never engaged).
      Root cause: `#clickToPlay` (`.overlay`, `position:absolute; inset:0`, no
      `pointer-events:none`) is painted **over** the canvas and swallowed the
      click, so `canvas`'s `click`→`requestPointerLock()` never fired; the overlay
      then stayed up forever (per-frame poll `!input.locked`). WASD worked because
      keys listen on `window`. Fix, keeping modules in lane:
      - `js/input.js` now takes a second arg `lockTrigger` (the overlay element)
        and requests capture on **its** click, not just the canvas's. It also
        listens for `pointerlockchange`/`pointerlockerror` and broadcasts
        `onLockChange(locked)` / `onLockError(reason)`.
      - `js/main.js` passes `ui.el.clickToPlay` as the trigger, wires the two
        callbacks to `ui.setClickToPlay(...)`, shows the overlay on match start,
        and **removed the per-frame poll**. Overlay now hides only when the browser
        *confirms* lock and reappears on release (Esc/alt-tab) — re-clickable.
      - `js/ui.js` `setClickToPlay(visible, msg?)` can show a refusal message; a
        `pointerlockerror` surfaces "browser blocked mouse capture…" instead of
        silence.
      - CSS: `.overlay` got `text-align/padding/line-height` so a long refusal
        message wraps cleanly.
      Details in `memory/notes/input-mouselook.md`. **Still needs a real 2-player
      re-test**: click through overlay → mouse-look works → Esc → overlay returns →
      re-click re-captures, as both host and guest.

## Open threads / not done — READ BEFORE BUILDING ON THIS

- [TOMBSTONES — physically delete when a shell is available.] I could **not**
      run mutating git/shell commands this session (the Monitor shell tool's
      permission stream failed on every write; read-only commands worked). So the
      flatten was done by **writing the canonical files at the root** and reducing
      the old `client/` and `server/` files to one-line **tombstone stubs**. They
      are dead (nothing loads them — the app is served from the root), but they
      should be removed for real:
      ```
      git rm -r client server
      ```
      Do this first thing next session if you have a shell. Everything canonical
      is at the root; `client/` and `server/` contain only stubs.
- [9] **NEVER PLAYTESTED — still the load-bearing gap, now bigger.** Two things
      are unverified across real networks: (a) the original P2P assumption that
      connections form across home NATs, and (b) the NEW PeerJS wiring. **Do this
      next:** deploy to Pages, open on two computers on *different* networks,
      create a room, **join via the invite link**, play a full round (hide →
      hunt → win screen → back to lobby), and check the direct/relayed badge.
      Include a strict-NAT setup if possible — with TURN configured that player
      should succeed via relay (badge reads `relayed`). Two tabs on one machine is
      NOT a valid test (loopback).
- [PeerJS/TURN are shared free services.] The broker (PeerJS cloud) and TURN
      (OpenRelay) are community services with modest quotas. Fine for 2–8 friends;
      if joining hiccups, suspect a service before the code. For a dedicated TURN
      quota, swap the three `turn:` entries in `js/net.js` for your own
      Metered/OpenRelay creds. The relay password ships in client code
      (unavoidable, backend-less) — only risk is quota drain.
- **Phones now IN scope (this session).** Full touch controls added (joystick +
      drag-to-look + tap buttons + "Tap to play", portrait & landscape). Desktop
      WASD + mouse-look untouched. **Playtest owed** (see the mobile checklist in
      the new-work status above and open thread below). Details in
      `memory/notes/touch-controls.md`.
- **PLAYTEST OWED for this session's work.** Do a desktop + phone pass: (a) start
      SOLO on desktop, walk/disguise alone; (b) phone joins MID-ROUND via the invite
      link → confirm it drops into the running game as a hunter and sees only what
      other guests see (never undisguised props); (c) play with touch in BOTH
      portrait and landscape (joystick moves, drag looks, action button
      tags/disguises, "Tap to play" dismisses, no pinch-zoom); (d) finish the round
      and start ANOTHER from the persistent lobby with nobody reconnecting (host
      stays host, map stays picked, last winner shown). Two tabs on one machine is
      still not a valid P2P test.
- **Anti-cheat given up.** The host holds full unfiltered state (can see
      undisguised props / tamper). Accepted cost of host authority; no neutral
      referee. See architecture.md.
- **Undisguised props are visible** (render as neutral capsules and move). Fine
      for skeleton; future: auto-disguise at hunt start, or hide undisguised props.
- ~~No client-side prediction of collisions; players can overlap props/walls.~~
  RESOLVED by the physics pass (`physics-net`): players now collide-and-slide vs
  walls/fixtures/props via a local Rapier prediction world, reconciled to the host.
  (Prediction of DYNAMIC prop motion is host-authoritative only — guests treat props
  as fixed obstacles and reconcile; a guest shoving a prop can rubber-band slightly.)
- `ready` flag exists in lobby but host can start regardless — intentional.
- **Map selection: BUILT this session** (host picks from the lobby; `circus_lot`
  + `toy_workshop`). Adding more maps stays data-only. **Playtest still owed:**
  host picks a non-default map → everyone spawns in it; a late lobby joiner sees
  the current selection; a non-host's pick attempt is ignored; disguise + tag work
  on the second map; after a reset-to-lobby the pick survives. See
  `memory/notes/map-selection.md`.
- **Reconnection/host migration**: none. If the host drops, the match is over.

## Key decisions

- **Static site + PeerJS public broker** (this session) — the way to keep P2P
      WebRTC with no server of ours, deployable to Cloudflare Pages. Trade-off:
      depends on shared free services (broker + TURN). See architecture.md.
- **P2P WebRTC, host-authoritative** — REVERSED the earlier server-authoritative
      / "do not move authority to clients" directive, on Manny's instruction. Full
      rationale + trade-offs in architecture.md. A future session may revisit.
- Movement math is duplicated (referee + client prediction) **on purpose** and
      must stay identical — see architecture.md.
- Roles hidden via snapshot shape (`hunter`/`disguise` only) — but the host tab
      still holds everything (see anti-cheat note).
- Theme: colorful circus (art in `assets/`, used on the menu screen).

## Where things live

Entry/served root: `index.html` + `js/` + `css/` (flattened). Referee (host
browser): `shared/referee.js`. Protocol: `shared/protocol.js` (C2S/S2C only now).
Network layer (PeerJS): `js/net.js`. Client entry: `js/main.js`. Input (all
schemes, incl. touch): `js/input.js`. Rendering + **third-person camera**:
`js/scene.js`. **Level editor (desktop debug tool)**: `js/editor.js` (toggled by
Ctrl+E; a client-local sandbox that never touches the referee/netcode). Tunables:
`shared/config/rules.json`. Notes: `memory/notes/` (netcode, game-loop,
input-mouselook, map-selection, touch-controls, third-person-camera, level-editor). Dead code awaiting `git rm`: `client/`, `server/`.

- The agent loop went live 2026-07-07 (per VRmike). (noted 2026-07-07 by VRmike)

- prop-hunt physics WIP — LATER/suggestion (not v1): "fake nudge" for disguised players. When a hunter shoves a disguised player, play a scripted cosmetic reaction so it mimics a real dynamic prop and preserves the disguise (instead of a hard 100% tell). CONSTRAINT (VRmike): the fake nudge may ONLY translate and rotate on the vertical (yaw) axis — it must NEVER tip over (no pitch/roll). Players stay kinematic and un-knockable; this is purely a visual mimic. The genuine tell then becomes subtle (real dynamic props tumble/settle differently) rather than binary. To be written into the game repo's WIP notes when the physics build runs. (noted 2026-07-09 by VRmike)

- prop-hunt PHYSICS + MULTIPLAYER architecture — DECIDED with VRmike, for the big single-pass "yolo" build (do it all at once; roll back if it fails):
- ENGINE: Rapier (rapier3d, WASM). Lazy-load at match start like three.js/PeerJS — ZERO boot-time network fetch (headless load check must stay clean).
- COLLIDERS: static fixtures (walls/floor/counters/stove/oven/fridge/cabinets/sinks/large tables) = fixed colliders (box/trimesh). Dynamic props (chairs/stools/crates/pots/pans/plates/bowls/cutting boards/food) = dynamic rigid bodies with per-mesh CONVEX HULL colliders (convex decomposition only if a hull isn't enough). Reuse the existing map.fixtures[] vs map.props[] split already in the engine.
- PLAYERS: KINEMATIC character bodies via Rapier KinematicCharacterController. Have colliders; run + jump (manual gravity/vertical velocity); collide-and-slide vs walls/fixtures (FIXES the current pass-through-everything gap); shove dynamic props (applyImpulsesToDynamicBodies); but CANNOT be knocked/tipped over.
- NETWORKING: host-authoritative. TARGET for the yolo build = full client-side PREDICTION + server RECONCILIATION — every client runs a local Rapier sim for instant response; host streams authoritative transforms; clients blend/reconcile toward host (smooth, no hard pops). FALLBACK if that's too much in one pass: host-only sim + guest interpolation (guests don't sim, just interpolate received transforms).
- BANDWIDTH: only sync AWAKE bodies (Rapier sleeping = ~0 traffic when still); quantize transforms (~16 bytes); traffic is bursty. Rapier is NOT a networked engine — all netcode is hand-written.
- DETERMINISM: Rapier deterministic only given identical inputs/order/build; cross-browser drift is expected → reconciliation corrects it. Don't rely on determinism alone to stay synced.
- TELL MECHANIC: real props are physics-driven (get shoved), disguised players are kinematic (don't) = the tell. Fake-nudge softener already noted (later; yaw+translate only, never tip).
- CONSTRAINTS: static site, no build step, P2P WebRTC via PeerJS broker, referee stays authoritative & transport-agnostic, flat repo-root layout, lazy CDN. Build on vrmike/dev.
- VERIFICATION CAVEAT: bot auto-check is a headless LOAD test only — it CANNOT feel-test physics/netcode. This build needs a live multiplayer playtest as real QA. (noted 2026-07-09 by VRmike)

- prop-hunt FEATURE ROADMAP (VRmike's high-level todo list) lives in the prop-hunt repo at memory/notes/roadmap.md — NOT kept in main context. LOAD it (read the repo / read_project_state) whenever discussing prop-hunt plans, and be ready to post it on request and edit it. Written 2026-07-09. (noted 2026-07-09 by VRmike)
