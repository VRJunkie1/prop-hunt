// js/lighting-selftest.js — DEV-ONLY in-browser render check for the LIGHTING HOTFIX (VRmike,
// 2026-07-19). Gated behind `?lightingtest=…` in main.js and lazy-imported, so it is NEVER fetched
// or run in normal play. It exists because the black-screen bug and the ambient washout are BOTH
// purely visual — a headless syntax/config check (tools/check-lighting.mjs) can't see either. This
// harness boots the REAL render path (Scene3D.buildWorld → LightingRig → the SSAO/bloom composer),
// forces each Lighting Quality tier for longer than the bug window (the composer switches in ~1s
// after its lazy CDN import resolves), then READS BACK the actual canvas pixels and asserts:
//   • not-black  — the 3D view isn't a solid black frame (the T2/T3 composer bug fingerprint), and
//   • shadows-read — on the shadow tiers (T1+) the lit floor is meaningfully brighter than the
//     darkest floor/shadow regions, so the ambient fix can't silently regress back to a washout.
// Failures are console.error'd so browser_check surfaces them; the last tier keeps rendering so the
// screenshot shows a real frame. Usage (via browser_check query):
//   ?lightingtest=all   → cycle T0,T1,T2,T3, assert each (needs ~14s)
//   ?lightingtest=2     → hold + assert a single tier (good for a per-tier screenshot)
//
// This ships to the static site like every other ?debug feature, but does nothing without the param.

import * as THREE from 'three';
import { resolveTierConfig } from './lighting-tiers.js';

const HOLD_MS = 3000;      // per-tier render window — must exceed the lazy post-import (~1s) + a bake
const SAMPLE_AT_MS = 2600; // read pixels near the end of each window (composer definitely live by now)

// Luma (0..255) from 8-bit RGB (Rec.709). Cheap; called per sampled pixel.
function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[i];
}

// Project a world point to buffer pixel coords (GL readPixels origin is bottom-left, which matches
// the NDC→pixel mapping used here). Reuses a scratch vector to stay allocation-light.
const _proj = new THREE.Vector3();
function projectToPx(x, y, z, camera, W, H) {
  _proj.set(x, y, z).project(camera);
  return { px: (_proj.x * 0.5 + 0.5) * W, py: (_proj.y * 0.5 + 0.5) * H };
}

// Compute the on-screen bounding rectangle of the prop-ring floor region (radius ~ringR), so the
// shadow test samples ONLY where props + their cast shadows actually are — never the empty outer
// floor or sky that swamp a portrait phone frame. Padded a touch and clamped to the buffer.
function ringRoi(camera, W, H, ringR) {
  let xmin = W, xmax = 0, ymin = H, ymax = 0;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    for (const yy of [0, 1.6]) { // floor level + crate height
      const { px, py } = projectToPx(Math.cos(a) * ringR, yy, Math.sin(a) * ringR, camera, W, H);
      xmin = Math.min(xmin, px); xmax = Math.max(xmax, px);
      ymin = Math.min(ymin, py); ymax = Math.max(ymax, py);
    }
  }
  const padX = W * 0.02, padY = H * 0.02;
  return {
    x0: Math.max(0, Math.floor(xmin - padX)), x1: Math.min(W, Math.ceil(xmax + padX)),
    y0: Math.max(0, Math.floor(ymin - padY)), y1: Math.min(H, Math.ceil(ymax + padY)),
  };
}

// Greyish = low chroma → the floor (and its shadows), NOT the brown crates. Lets the shadow test
// compare lit floor vs shadowed floor without the crate faces polluting either percentile.
function isGrey(r, g, b) { return Math.abs(r - g) < 22 && Math.abs(g - b) < 28 && Math.abs(r - b) < 28; }

// Read the whole drawing buffer once. `all` (whole frame) drives the not-black test; `floor` (grey
// pixels inside the projected prop-ring ROI) drives the shadows-read test. Framing-independent.
function readStats(renderer, camera) {
  const gl = renderer.getContext();
  const W = renderer.domElement.width;
  const H = renderer.domElement.height;
  if (!W || !H) return null;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const roi = ringRoi(camera, W, H, 4.8); // tight to the prop ring (radius 4) so shadows aren't diluted
  const all = [];
  const floor = [];
  const step = 3; // subsample — plenty of samples, cheap
  let blackCount = 0, total = 0;
  for (let y = 0; y < H; y += step) {
    const inRoiY = y >= roi.y0 && y < roi.y1;
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const L = luma(r, g, b);
      all.push(L);
      total++;
      if (L < 4) blackCount++;
      if (inRoiY && x >= roi.x0 && x < roi.x1 && isGrey(r, g, b)) floor.push(L);
    }
  }
  all.sort((a, b) => a - b);
  floor.sort((a, b) => a - b);
  const mean = all.reduce((s, v) => s + v, 0) / (all.length || 1);
  return {
    mean,
    fracBlack: total ? blackCount / total : 1,
    p05: percentile(all, 5),
    p95: percentile(all, 95),
    floorSamples: floor.length,
    floorP10: percentile(floor, 8), // darkest floor (shadow cast by a floating/jumping prop)
    floorP85: percentile(floor, 80), // lit floor
  };
}

// A tiny hand-built map + a ring of AIRBORNE prop boxes. The contact light is straight down, so a
// prop RESTING on the floor casts its shadow directly beneath itself (hidden under the prop) — which
// is correct: the down-shadow is the JUMP cue, visible when a prop is off the ground and its shadow
// separates onto the open floor below. So we float the crates (p.y offset) so their down-shadows
// land on visible floor — exactly the "judge your jump by the shadow" case the down light exists for.
// Empty catalog models / no character models → buildWorld kicks off no external fetches beyond THREE
// + (on T2/T3) the postprocessing addons, which is exactly the path under test.
function buildTestWorld(scene) {
  const map = { size: 24, sky: '#87ceeb', ground: '#9a9a9a', fixtures: [], props: [], modelScale: null };
  const catalog = { crate: { shape: 'box', w: 1.6, h: 1.6, d: 1.6, color: '#c08a4a' } };
  const props = [];
  const R = 4;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    // p.y is an extra vertical offset on top of the resting baseY → float each crate ~2.6 up so its
    // straight-down shadow falls on the open floor beneath it (the airborne / mid-jump case).
    props.push({ id: 'p' + i, type: 'crate', x: Math.cos(a) * R, z: Math.sin(a) * R, y: 2.6, rot: a, disguisable: true });
  }
  scene.buildWorld(map, props, catalog, null, null);
}

// Look DOWN at the prop ring from above/behind so the frame is dominated by floor + props + their
// cast shadows (little sky), which is what makes the shadows-read test meaningful.
function aimCamera(scene) {
  const cam = scene.camera;
  cam.position.set(0, 11, 12);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

function parseTiers() {
  const raw = new URLSearchParams(location.search).get('lightingtest');
  if (raw === '0' || raw === '1' || raw === '2' || raw === '3') return [Number(raw)];
  return [0, 1, 2, 3]; // 'all', empty, or anything else → the full sweep
}

export async function runLightingSelfTest(canvas) {
  // Make the game canvas the visible screen so the browser_check screenshot shows the real frame.
  try {
    document.getElementById('menu')?.classList.add('hidden');
    document.getElementById('game')?.classList.remove('hidden');
    document.getElementById('hud')?.classList.add('hidden');
  } catch { /* non-DOM env — ignore */ }

  const { Scene3D } = await import('./scene.js');
  const scene = new Scene3D(canvas);
  buildTestWorld(scene);

  const tiers = parseTiers();
  const results = [];
  let idx = 0;
  let phaseStart = performance.now();
  let sampledThisPhase = false;

  const applyTier = (t) => {
    scene.setLightingTier(resolveTierConfig(t));
    aimCamera(scene); // buildWorld/reattach don't move the camera; keep our test framing
  };
  applyTier(tiers[0]);

  const evaluate = (t) => {
    const s = readStats(scene.renderer, scene.camera);
    const cfg = resolveTierConfig(t);
    if (!s) { results.push({ tier: t, ok: false, why: 'zero-size canvas / no readback' }); return; }
    const notBlack = s.mean > 20 && s.fracBlack < 0.9;
    // Shadow tiers (T1+ have the straight-down contact light): within the prop-ring region the lit
    // floor must be clearly brighter than the darkest (shadowed) floor, proving shadows read AND
    // ambient stayed LOW. Need enough grey-floor samples for the percentiles to be meaningful.
    const shadowContrast = s.floorP85 - s.floorP10;
    const shadowsRead = !cfg.contactShadow || (s.floorSamples > 200 && shadowContrast > 16);
    const ok = notBlack && shadowsRead;
    const line = `T${t} mean=${s.mean.toFixed(1)} fracBlack=${(s.fracBlack * 100).toFixed(1)}% `
      + `floorLit=${s.floorP85.toFixed(1)} floorDark=${s.floorP10.toFixed(1)} contrast=${shadowContrast.toFixed(1)} `
      + `nFloor=${s.floorSamples} usesComposer=${cfg.usesComposer}`;
    results.push({ tier: t, ok, notBlack, shadowsRead, line });
    if (ok) console.log('[lightingtest] PASS ' + line);
    else console.error('[lightingtest] FAIL ' + line
      + (notBlack ? '' : ' — BLACK SCREEN') + (shadowsRead ? '' : ' — shadows/ambient washed out'));
  };

  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const t = tiers[idx];
    const el = now - phaseStart;
    scene.render(); // the real render path — direct on T0/T1, SSAO/bloom composer on T2/T3
    // Read pixels IMMEDIATELY after render in the SAME tick: the WebGL context is
    // preserveDrawingBuffer:false, so the back buffer is only valid until control returns to the
    // compositor. Sampling before render (or a frame later) reads an already-cleared black buffer.
    if (!sampledThisPhase && el >= SAMPLE_AT_MS) { evaluate(t); sampledThisPhase = true; }
    if (el >= HOLD_MS && idx < tiers.length - 1) {
      idx++; phaseStart = now; sampledThisPhase = false;
      applyTier(tiers[idx]);
    } else if (el >= HOLD_MS && idx === tiers.length - 1 && sampledThisPhase && !loop._done) {
      loop._done = true;
      const pass = results.filter((r) => r.ok).length;
      const summary = `[lightingtest] DONE ${pass}/${results.length} tiers OK: `
        + results.map((r) => `T${r.tier}=${r.ok ? 'ok' : 'FAIL'}`).join(' ');
      if (pass === results.length) console.log(summary);
      else console.error(summary); // surfaced by browser_check
    }
  }
  requestAnimationFrame(loop);
}
