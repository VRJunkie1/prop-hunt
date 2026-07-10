# Prop Hunt — Feature Roadmap

High-level TODO from VRmike (2026-07-09). Not built yet. **Order ≠ priority.**
Loaded when scoping any prop-hunt build. Edit freely on request ("add X", "show the roadmap").

## Lobby / teams
- **Team selection** on the lobby screen (Hunters vs Props), **replacing the redundant ready button**. Player names fall under their team's header.

## Player movement
- **Jump / sprint / crouch.**

## Prop mechanics
- **Prop finder?** — open question (mechanic not settled).
- **Crosshair-based disguise:** selecting a prop to disguise as uses the crosshair (what you're aiming at), not whichever prop is nearest.
- **Locked orientation:** while moving as a prop, orientation stays fixed — **unless right-click is held**, which unlocks vertical-axis (yaw) rotation.
- **Size vs damage:** players disguised as *small* props take damage much more easily than *big* props (offsets big props being far easier to shoot).

## Hunter starter kit
- **Assault rifle.**
- **Grenade** that explodes on contact with stuff.
- **Prop finder tool.**
(AR + contact grenade + prop finder = enough to start.)

## Audio
- **Directional audio** to locate players.
- **Taunts?** — open question.

## Match flow
- **Time limits.**
- **Hunter blindfold:** hunter is blindfolded while props hide at the start of a map.
- **Spectate on death:** dead players spectate — click to cycle between player views, plus an additional **freecam** fly option.

## Maps
- **Randomization:** don't spawn ~20% of items at random, leaving gaps for players to hide.

---
## Related design already locked (from physics/netcode discussion)
- **Fake-nudge softener** (later, optional): when a disguised player is struck, give a scripted reaction so "can't be knocked" isn't a 100% dead giveaway — **but the prop may only translate + yaw (vertical-axis rotation); it must never tip over.**
