# Solid disguised prop players (2026-07-18, Jie)

**Goal (Jie, scope narrowed by Jie):** a hunter who runs into a REAL prop hits a solid
body; running into a DISGUISED PLAYER used to feel wrong — instantly outing them as fake.
Make a disguised player collide **the way the real prop of their disguise does**. NOT full
realism — no tipping, no ragdoll ("a bit closer" is the target). REAL/decoy prop physics are
already fine and were **not touched**; hunter-vs-hunter / general player-vs-player is left
exactly as it was; this is **MOVEMENT collision only** (weapons, taunts, finder, object-sync
and the grenade/rifle raycast classification are untouched).

## What was already true before this build (audit first)

Contrary to the ticket's framing ("disguised players pass through"), the physics already did
most of part A. The disguised player's **movement collider is the disguise's real prop shape**
(`_buildMoveColliderDesc` → `shapeFor`, the SAME cuboid/cylinder/cone/ball the world prop of
that type uses, **uncapped** — the earlier `disguiseColliderMaxRadius` cap only ever shrank the
retired `_capsuleDimsFor` FALLBACK capsule, not this path). Empirically (see the probes) a base
hunter walking into a **big-table** disguise already stops a table-half + capsule-radius (≈1.6 m)
out — solid at the disguise's true footprint. So there is **no separate "outward shell"** and I
did NOT add one: the movement collider already IS the full-size solid shell every other player
collides against, and the disguise-change hook (`setPlayerCollider`, called by the referee on
disguise / undisguise / morph / team / join / round-start) already swaps its size. Building a
second parallel blocker would have been the "ghost blocker" the plan critique warned against.

**Note vs the approved plan:** the plan assumed an *inward-capped / outward-full* asymmetry
(cap the disguised player's OWN movement for doorway fit, add a full-size shell outward). The
shipped code has NO inward cap — a big disguise is genuinely big both ways (a deliberate earlier
ruling: "a big disguise is now genuinely big, harder through doorways — the intended realistic
side effect"). So inward and outward are the SAME full prop size; the asymmetry is moot and no
cap/shell machinery was added. This is simpler and truer to one-source-of-truth.

## The real gap = the tell: immovable wall vs shovable prop

A disguised player's body is a **kinematic** character body (house rule: character controllers
stay kinematic). Infinite mass → a shove that slides a REAL dynamic prop across the room just
**stops dead** against the disguised one. So the actual tell is the inverse of "pass through":
you can bulldoze a real table but the disguised table is an unmovable wall. Two gaps remained:

- **(B) heavy-object nudge** — a sustained push should slide the disguised player *slowly*.
- **(D3) spawn/teleport overlap** — several players sharing one spawn (every hunter shares
  `map.hunterSpawn`) materialise fused inside each other; two kinematic bodies don't self-resolve.

## What this build adds (all in `shared/physics.js`, host-only)

### B) Heavy-object nudge — `_applyHeavyNudges(dt)`
Runs at the end of each `_substep`, **only** when `dynamicProps` (host world) and ≥2 players.
Two passes:
1. **Detect** — for every player whose move input is non-zero (a real, sustained press), shape-cast
   its own (skin-inflated, `heavyNudgeContactSkin`=0.12 m) capsule via `intersectionWithShape`
   filtered to OTHER players' movement colliders. If the pressed player is **disguised**
   (`disguiseType != null`), accumulate a push direction (pusher→target, horizontal).
2. **Apply** — once the push has persisted `heavyNudgeWarmupFrames` (3) substeps (so a glancing
   tap barely registers — the "sustained" feel), crawl the target `heavyNudgeSpeed·dt` along the
   push **through the target's own character controller** (`computeColliderMovement`), so it
   collide-and-slides vs walls/props like normal movement and can never be shoved into geometry.
   Horizontal only (y untouched) → **no lift, no tip** (kinematic → never rotates on its own).

`heavyNudgeSpeed` = **0.8 m/s** (walk speed is 6) → a disguised table now crawls ~0.7 m/s when
shoved (measured 2.08 m over 3 s) instead of standing rock-still. Host-authoritative + capped +
warm-up ⇒ can't be abused to teleport (a client only feels it via the normal player-sync
reconciliation — no new netcode). Gated to disguised targets ⇒ hunter-vs-hunter / general
player-vs-player is byte-identical (proven: base↔base is identical with the nudge on vs off).

Test seam: `opts.heavyNudge === false` makes the pass a no-op (the check uses it to prove the
slide is ours and that undisguised/prop paths are unaffected).

### D3) Spawn/teleport overlap — `resolveSpawnOverlap(id)`
Called by the referee right after a spawn/teleport, for the **newcomer only** (incumbents stay
put — deterministic + minimal): iteratively slide `id` horizontally out of any player it overlaps,
away from that player's centre (golden-angle scatter when exactly stacked), capped total travel
`spawnOverlapPushMax` (3 m) and **clamped inside the boundary walls** (so separating two players
never fires one through a wall). Wired at the three spawn choke points:
`_spawnOnTeam` (team switch + mid-join), `_buildPhysics`'s add-all-players loop (round start —
resolving per-player as we add fans the shared-hunter-spawn stack apart), and the `integrate()`
join-race `addPlayer`.

**Gotcha (cost me a debug loop):** a spawn/teleport can happen BEFORE the world's first
`world.step()` (round start builds the world and adds everyone up front), and Rapier's shape
queries read a **stale broad-phase** until the scene queries are refreshed — `intersectionWithShape`
returned `null` for a genuine overlap. Fix: `resolveSpawnOverlap` calls `world.updateSceneQueries()`
each iteration (guarded). `_applyHeavyNudges` runs *after* `world.step()` so its queries are already
fresh — no update needed there.

## Seams D1 / D2 (verified, already worked)
- **D1 collider swaps on disguise change:** already via `setPlayerCollider` (the referee's existing
  hook). The check asserts base→table→burger→null resize the movement collider and revert.
- **D2 standing on top:** the movement collider is the full prop cuboid incl. its top face, so a
  player dropped onto a disguised table rests ON it (measured foot y ≈ 1.02 on a 1.0 m table,
  grounded). No change needed; the check guards it.

## Config knobs (`shared/config/rules.json`, all HOT-TUNABLE)
`heavyNudgeSpeed` 0.8 · `heavyNudgeContactSkin` 0.12 · `heavyNudgeWarmupFrames` 3 ·
`spawnOverlapPushMax` 3.0. Lower `heavyNudgeSpeed` toward 0 to make disguised players heavier /
more wall-like; raise it (still ≪ 6) to make them shove more like light furniture.

## Guard
`tools/check-solid-players.mjs` (live Rapier PhysicsWorld, `npm i --no-save
@dimforge/rapier3d-compat@0.14.0` first, else SKIP/exit 3). 16 ✓: blocked-at-disguise-size,
base↔base-not-a-wall, sustained-slow-slide, no-tip, immovable-with-nudge-off, collider-swap,
undisguise-revert, stand-on-top, 3-way + disguised spawn-overlap resolve, and the UNTOUCHED
set (base↔base identical on/off, real-prop settle identical on/off, shot ray → disguised
player = `player` / real prop = `prop`).

## Not verifiable headless — OWED live pass
Movement-collision FEEL needs real people + real pings (per architecture.md's standing caveat).
Live checks: run a hunter into a disguised table (blocked at table size, not passing/bouncing);
hold into it → it crawls slowly like heavy furniture (not an immovable wall, not flung); stand
on a disguised table; team-switch / mid-join / round-start with several hunters → nobody spawns
fused. The guest-side experience is prediction→reconcile (a guest's local world holds only its
own body, so it briefly predicts through another player then the host's block snaps it back —
the intended, unchanged netcode model).
