// Fetches the same content-as-data config the referee uses, so the client
// renders exactly the world the referee simulates. Loaded once at startup.
// These are plain static JSON files served alongside the app (no backend).
let cache = null;

export async function loadConfig() {
  if (cache) return cache;
  const [maps, props, fixtures, rules] = await Promise.all([
    fetch('/shared/config/maps.json').then((r) => r.json()),
    fetch('/shared/config/props.json').then((r) => r.json()),
    fetch('/shared/config/fixtures.json').then((r) => r.json()),
    fetch('/shared/config/rules.json').then((r) => r.json()),
  ]);
  // props = the disguise catalog (movable items only, per referee's disguise pool);
  // fixtures = the static building-piece catalog. Kept as separate files so a
  // fixture can never leak into the disguise pool; scene.js merges them purely for
  // rendering. The referee is injected the whole cfg but only ever reads maps/rules.
  cache = { maps, props, fixtures, rules };
  return cache;
}
