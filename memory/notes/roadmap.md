# Prop Hunt — Feature Roadmap

High-level TODO from VRmike (2026-07-09). **Order ≠ priority.**
Loaded when scoping any prop-hunt build. Edit freely on request ("add X", "show the roadmap").
Finished items move to the bottom, struck through.

## Lobby / teams
- **Team selection** on the lobby screen (Hunters vs Props), **replacing the redundant ready button**. Player names fall under their team's header. _(Partial: HUNTER/PROP roles exist, but the ready button is still in the code — not yet replaced by a team-select screen.)_
- **Editable names in the lobby** (VRmike 2026-07-11): players who arrive via a join link never get a chance to set their name. Let anyone edit their name at ANY time before the match launches — i.e. while still in the lobby — not just at first entry. Name changes propagate to the host/roster.

## Player movement
- **Sprint / crouch.** _(jump is done — see Finished)_

## Prop mechanics
- **Prop finder?** — open question (mechanic not settled).
- **Crosshair-based disguise:** selecting a prop to disguise as uses the crosshair (what you're aiming at), not whichever prop is nearest.
- **Locked orientation:** while moving as a prop, orientation stays fixed — **unless right-click is held**, which unlocks vertical-axis (yaw) rotation. _(In progress — continuous collision-checked rotation being built.)_
- **Size vs damage:** players disguised as *small* props take damage much more easily than *big* props (offsets big props being far easier to shoot).

## Hunter starter kit
- **Assault rifle.**
- **Grenade** that explodes on contact with stuff.
- **Prop finder tool.**
(AR + contact grenade + prop finder = enough to start.)
- **SWAT/tactical character models** for hunters (ideally rigged + running animation — engine supports glTF skeletal animation).

## Audio
- **Directional audio** to locate players.
- **Taunts?** — open question.

## Match flow
- **Hunter blindfold:** hunter is blindfolded while props hide during the start-of-map countdown (anti-cheat).
- **Spectate on death:** dead players spectate — click to cycle between player views, plus an additional **freecam** fly option.

## Maps
- **Randomization:** don't spawn ~20% of items at random, leaving gaps for players to hide.

## UI / help
- **Help & Objective button (PC + mobile):** on-screen help on both formats. Shows (1) controls for the current platform, and (2) the player's current objective by role — **Prop:** *"Stand near a prop, press Action to disguise as it, then hide in the scene so Hunters can't find you!"* · **Hunter:** *"Find and kill the players disguised as props, before time runs out!"*
- **Dev "Map Editor" button:** on-screen button (PC) to enter the in-game level editor, labeled dev-use-only; opens with controls/instructions. (Debug tool for us, not players.)

---
## Related design already locked (from physics/netcode discussion)
- **Fake-nudge softener** (later, optional): when a disguised player is struck, give a scripted reaction so "can't be knocked" isn't a 100% dead giveaway — **but the prop may only translate + yaw (vertical-axis rotation); it must never tip over.**

---
## ✅ Finished
- ~~**Jump**~~ (2026-07-11)
- ~~**Time limits**~~ — round countdown timer in the HUD (2026-07-11)

_Also shipped, though never line-items on this list: real CC0 restaurant meshes + bbox-normalized layout, Rapier physics (knockable world, solid-ish controller), host-authoritative multiplayer (prediction/reconciliation), in-game level editor, void/fall-through failsafe._
