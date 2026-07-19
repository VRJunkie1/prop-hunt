# Node tooling: clean exit for Rapier-using checks (Windows crash)

## Symptom
On the **Windows** automated-check machine, `tools/check-lifecycle.mjs` aborted with
`exit 3221226505` (0xC0000409) and:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

All assertions had already passed — it crashed during **process teardown**, so the harness
read the abort code as a failure. It does NOT reproduce on the (Linux) sandbox: `run_node`
reports exit 0.

## Cause
A synchronous `process.exit(code)` at the end of the script fires while the Rapier WASM /
libuv async handles are still closing. On Windows that races `uv_async_send` against a handle
already flagged `UV_HANDLE_CLOSING` → the libuv assertion → abort.

## Fix (the house pattern for these checks)
Don't force-exit. Set `process.exitCode` and let Node drain the event loop and close its handles
on its own:

```js
process.exitCode = fails ? 1 : 0;   // NOT process.exit(...)
```

This is safe here because by the end of the script nothing keeps the loop alive:
- every `Referee` created by the harness has `ref.destroy()` called → its `setInterval` tick is
  cleared (see shared/referee.js constructor line ~125 + destroy());
- every `PhysicsWorld` has `w.destroy()` called → `this.world.free()` releases the Rapier world.

So the process exits promptly with the right code and never trips the teardown race. Verified:
`run_node tools/check-lifecycle.mjs` exits 0 without hanging.

## If you touch other Rapier checks
`check-solid-players`, `check-physics-live`, `check-object-sync`, `check-settle`,
`check-true-colliders`, `check-combat` still call `process.exit()`. They weren't flagged, so
they were left alone (minimal-change rule), but if any of them starts throwing the same
`async.c:76` abort on Windows, apply the identical `process.exitCode` swap — just make sure
every world/interval they create is freed/cleared first, else the process will hang instead.
