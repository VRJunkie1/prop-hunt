// AUDIO TAUNT library (client-side lazy loader + cache).
//
// The taunt library is DATA-DRIVEN from assets/taunts/manifest.json (id/label/file per clip,
// loaded once at boot by config.js → cfg.taunts.taunts). Clips themselves are NEVER downloaded
// at join: a clip is fetched + decoded the FIRST time anyone plays it, then cached; opening the
// taunt menu kicks off a background prefetch of the whole library so most picks feel instant.
// Adding the ~50 real clips later is a data-only change (drop files + manifest lines, ZERO code).
//
// Decoding to an AudioBuffer needs a Web Audio context; we borrow the SAME shared context the 3D
// positional audio plays through (scene.loadAudioBuffer, which uses THREE.AudioLoader — handling
// Safari's callback-style decode and the iOS unlock for us). This module holds no THREE reference
// itself: it's handed a `loadBuffer(url) -> Promise<AudioBuffer|null>` so it stays testable and
// never touches the render layer directly.
export class TauntLibrary {
  // taunts: [{ id, label, file }] (the normalized manifest list; may be empty).
  // loadBuffer: (url) => Promise<AudioBuffer|null> — fetch + decode a clip URL.
  constructor(taunts, loadBuffer) {
    this.taunts = Array.isArray(taunts) ? taunts : [];
    this._loadBuffer = loadBuffer;
    this._byId = new Map(this.taunts.map((t) => [t && t.id, t]).filter(([id]) => id));
    this._cache = new Map(); // id -> Promise<AudioBuffer|null> (the promise is cached, so
    //                          concurrent + repeat loads share one fetch/decode).
  }

  has(id) {
    return this._byId.has(id);
  }

  // Resolve a manifest `file` to a servable URL under /assets/. The manifest stores paths
  // relative to assets/ (e.g. "taunts/beep_high.wav"); tolerate an already-absolute or
  // assets-prefixed path so a future manifest can't trip on a leading slash.
  _url(file) {
    const f = String(file || '');
    if (f.startsWith('/')) return f;
    if (f.startsWith('assets/')) return '/' + f;
    return '/assets/' + f;
  }

  // Fetch + decode clip `id` to an AudioBuffer, caching the PROMISE so the first play and the
  // background prefetch never double-fetch. Resolves to null (never throws) on any failure —
  // a bad/missing clip must degrade to silence, never break the game or the menu.
  load(id) {
    if (this._cache.has(id)) return this._cache.get(id);
    const entry = this._byId.get(id);
    let p;
    if (!entry || !entry.file || typeof this._loadBuffer !== 'function') {
      p = Promise.resolve(null);
    } else {
      p = Promise.resolve()
        .then(() => this._loadBuffer(this._url(entry.file)))
        .catch(() => null);
    }
    this._cache.set(id, p);
    return p;
  }

  // Background-prefetch the WHOLE library. Called when the taunt menu opens so most picks are
  // already decoded by the time they're clicked. Fire-and-forget; per-clip errors are swallowed
  // (a failed prefetch just means that one pick loads on demand). Never preloaded at join.
  prefetch() {
    for (const t of this.taunts) {
      if (t && t.id) this.load(t.id).catch(() => {});
    }
  }
}
