# lobby name changes

## 2026-07-13 — players can rename themselves in the lobby (VRmike)

Let ANY player change their display name from the lobby at any time — the host and an
invite-link guest alike, not just the room creator. Host-authoritative, riding the roster
rebroadcast that already fires on join. No new transport, no netcode risk.

### Flow (one new message down an existing pipe)
1. **UI (`js/ui.js renderLobby` + `_buildSelfNameField`).** Your OWN lobby row is an
   editable `<input class="name-edit">` (tap to edit — works on phones); every other row
   stays a read-only `<span>` (you can only rename yourself). Commit on **blur** or **Enter**;
   **Escape** cancels. On commit → `ui.onRename(newName)`.
   - **Mid-edit re-render guard:** `renderLobby` wipes `playerList.innerHTML` on every
     `S2C.LOBBY`. That tears down the focused input (firing its blur). `_rerendering` (set
     around the `innerHTML=''`) makes that blur a no-op — it neither commits nor drops the
     editing state. `_editingName`/`_nameDraft` keep the in-progress text; after the rebuild
     the self input is recreated from the draft and **focus + caret are restored**. So an
     unrelated lobby update (someone joins / readies / picks a map) never interrupts typing.
2. **Relay (`js/main.js` `ui.onRename`).** `saveName(name)` (localStorage, requirement 7)
   then `session.rename(name)`.
3. **Transport (`js/net.js Session.rename`).** Updates the cached `this.name` and
   `send({ t: C2S.RENAME, name })` — host loopback or the guest DataConnection, the same
   pipe everything else uses.
4. **Authority (`shared/referee.js applyRename`).** LOBBY-only. Trim + cap 16 + **reject
   empty** (keep old name) + **de-dupe** (`_uniqueName` appends the smallest free integer
   suffix, case-insensitive; "Host" → "Host2"). Then `broadcastLobby()` — the exact
   rebroadcast a join fires, so every lobby list (late joiners included) updates live.
   A player can only rename ITSELF: `handleMessage` resolves the sender by connection id;
   the payload carries no target id/name.

### Carries into the game — automatically
Snapshots (`broadcastSnapshot`) and `STARTED` already send `p.name` live, and the scoreboard
(`ui.updatePauseScores`) + kill feed read it per-message. There are **no nameplates in
`scene.js`** (remote players draw no name label), so nothing caches the old name — the final
lobby name is what shows in-game. No scene change needed.

### ~~Lobby-only~~ → now ALSO mid-game (2026-07-20, VRmike — QoL pack, build/218)
The old LOBBY-only phase gate was REMOVED so latecomers who joined with a default name can fix it
mid-match from the pause scoreboard (`ui._beginNameEdit` → same `ui.onRename` → `C2S.RENAME`). Host
still validates identically (trim/cap/reject-empty/de-dupe). **Propagation differs by phase:** in the
LOBBY `applyRename` calls `broadcastLobby()`; **mid-match it does NOT** — the new name just rides the next
`broadcastSnapshot` (which every field already does). Critically, the hunter snapshot variant
(`hunterSafeSnapshot`) BLANKS a disguised prop's name, so a mid-game rename can't leak a hiding prop's
identity to hunters — and we deliberately emit no `broadcastLog` (that would bypass the blank). The pause
scoreboard's inline editor survives the ~15 Hz reused-row refresh; see `notes/pause-menu.md`.

### Name cleaning lives in TWO places (kept in sync)
- `js/net.js cleanName()` — the join-time cleaner (`.slice(0,16).trim() || 'Player'`).
- `shared/referee.js applyRename` + `NAME_MAX` (16) — the rename-time cleaner, host-side and
  authoritative (rejects empty rather than falling back to 'Player'; also de-dupes).
If you change the cap, change both.

### Verify — `tools/check-lobby-rename.mjs` (build-gating)
Drives the REAL referee: a NON-HOST peer rename updates the roster AND the rebroadcast
`S2C.LOBBY` carries the new name to every peer (the requested assertion); length cap; empty
rejection; de-dupe (incl. case-insensitive); host renames itself; **mid-game rename is applied,
rides the snapshot (never a new `S2C.LOBBY`), stays host-validated, and a HUNTER never receives a
disguised prop's new name (anti-cheat blank intact, render shape preserved)** — section D; unknown
sender is a no-op. All green + page boots clean. The pause-menu edit-survives-refresh + banner
placement are guarded in `tools/check-votekick.mjs` (sections M/N).
