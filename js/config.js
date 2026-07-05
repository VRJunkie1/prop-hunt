// Fetches the same content-as-data config the referee uses, so the client
// renders exactly the world the referee simulates. Loaded once at startup.
// These are plain static JSON files served alongside the app (no backend).
let cache = null;

export async function loadConfig() {
  if (cache) return cache;
  const [maps, props, rules] = await Promise.all([
    fetch('/shared/config/maps.json').then((r) => r.json()),
    fetch('/shared/config/props.json').then((r) => r.json()),
    fetch('/shared/config/rules.json').then((r) => r.json()),
  ]);
  cache = { maps, props, rules };
  return cache;
}
