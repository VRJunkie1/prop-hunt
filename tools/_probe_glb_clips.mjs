// SUPERSEDED — this was a one-off probe used to list a .glb's animation clip names while
// diagnosing the remote-rifle-animation bug (2026-07-12). That GLB-JSON-chunk parse now lives
// permanently in tools/check-hunter-model.mjs (glbClipNames), which asserts the configured
// hunter clips exist in the asset AND are rifle/aim clips. Kept as an inert stub only because
// the sandbox has no shell to delete it; safe to remove. Run `node tools/check-hunter-model.mjs`.
console.log('superseded by tools/check-hunter-model.mjs (glbClipNames)');
