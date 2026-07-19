// js/lighting.js — the THREE side of the LIGHTING OVERHAUL (VRmike, 2026-07-19).
//
// LightingRig owns the actual renderer state for the quality tiers: the SH ambient probe, the
// contact-shadow directional light, the angled fill light, the SSAO/bloom post pipeline, and the
// tonemap A/B. The PURE tier/tonemap/SH math (what each tier turns on, exposure folding, SH
// override parsing) lives in js/lighting-tiers.js and is headless-guarded — this file only maps
// that config onto THREE objects, so it can't be unit-tested headlessly and instead rides the
// B4-style boot-clean browser_check on desktop + phone.
//
// Design notes that matter:
//  - EVERY effect is an independent switch (applyTierConfig reads the resolved config's booleans);
//    tiers are just preset bundles. Turning an effect off disposes its GPU resources.
//  - Post passes (EffectComposer/SSAO/bloom) + LightProbeGenerator are LAZY-imported the first time
//    a tier needs them (like scene.js's GLTFLoader) so the cheap tiers + the headless boot allocate
//    nothing. While an async import is in flight, render() falls back to a direct render — never a
//    black screen.
//  - Per-frame work (render()) is allocation-free: reused temp vectors, no per-frame objects.
//  - Tonemap is done on the renderer (LinearToneMapping for the flat 1.25× multiply, ACES for
//    filmic), so it works on ALL tiers including T0 with no composer. OutputPass applies the same
//    renderer.toneMapping at the end of the composer chain (three only tonemaps materials when
//    rendering to screen, so there's no double-apply — verified against r161 WebGLRenderer).
//
// See memory/notes/lighting.md.

import * as THREE from 'three';
// Relative (not root-absolute) so a node harness can load this module for the headless rig check
// (tools/check-lighting.mjs §6) — the browser resolves it identically. The sibling is pure.
import {
  resolveTierConfig, resolveTonemap, resolveAmbientIntensity, AMBIENT_INTENSITY_DEFAULT,
  ssaoDistanceRange, AO_KERNEL_RADIUS_METERS,
} from './lighting-tiers.js';

// Map the pure tonemap descriptor's string to the real THREE tone-mapping constant.
function threeToneMapping(name) {
  return name === 'aces' ? THREE.ACESFilmicToneMapping : THREE.LinearToneMapping;
}

export class LightingRig {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._cfg = resolveTierConfig(0); // start at T0 (today's look) until told otherwise
    this._map = null;                 // last map (for bake center/bounds + shadow frustum)

    // Effect objects (null until their switch turns on).
    this._probe = null;               // THREE.LightProbe — SH ambient fill
    this._contactLight = null;        // straight-down shadow-casting directional light
    this._angledLight = null;         // angled non-shadow fill
    this._composer = null;            // EffectComposer for SSAO/bloom (lazy)
    this._renderPass = null;
    this._ssaoPass = null;
    this._bloomPass = null;
    this._outputPass = null;

    this._postMod = null;             // cached { EffectComposer, RenderPass, SSAOPass, UnrealBloomPass, OutputPass }
    this._postLoading = false;
    this._probeMod = null;            // cached LightProbeGenerator module
    this._baking = false;
    this._bakeToken = 0;              // bumped on reattach so a stale async bake no-ops

    this._size = { w: 1, h: 1 };
    this._ambient = AMBIENT_INTENSITY_DEFAULT; // SH probe intensity; recomputed per-map in reattach()
    this._tmpV = new THREE.Vector3(); // reused; keeps render()/reattach() allocation-free

    // Tonemap applied to the renderer immediately (works before any world is built).
    this.setTonemap('multiply', 1.0);

    // Sensible shadow defaults on the renderer; toggled per tier in _applyShadows().
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.enabled = false;
  }

  get usesComposer() { return !!this._cfg.usesComposer; }
  get shadowsOn() { return this._cfg.shadowMapSize > 0 && this._cfg.contactShadow; }

  // ---- tonemap A/B ---------------------------------------------------------
  setTonemap(mode, exposure) {
    const t = resolveTonemap(mode, exposure);
    this._tonemap = t;
    this.renderer.toneMapping = threeToneMapping(t.toneMapping);
    this.renderer.toneMappingExposure = t.toneMappingExposure;
    // OutputPass caches renderer.toneMapping/exposure and rebuilds its defines on change, so the
    // composer path picks this up automatically next frame — nothing else to do here.
  }

  // ---- tier switchboard ----------------------------------------------------
  // Store the resolved tier config. The actual scene/renderer mutation happens in reattach()
  // (which the scene calls after buildWorld and on every tier change), so lights survive the
  // scene.clear() that buildWorld does.
  setTierConfig(cfg) {
    this._cfg = cfg || resolveTierConfig(0);
  }

  // Re-apply every effect switch to the live scene. Called after buildWorld (scene.clear() drops
  // our lights/probe) and whenever the tier changes at runtime (manual pick / auto-tier). `map`
  // gives the room center + size for the bake and the shadow frustum. Idempotent.
  reattach(map) {
    if (map) this._map = map;
    const cfg = this._cfg;

    // AMBIENT WASHOUT FIX (2026-07-19): resolve the per-map ambient level (LOW default, JSON
    // overridable) once per reattach and use it as the SH probe's intensity below, so the probe
    // fill can never flood the floor / wash out the contact shadows. The base HemisphereLight is
    // driven off the SAME scalar in scene.buildWorld().
    this._ambient = resolveAmbientIntensity(this._map);

    this._applyProbe(cfg);
    this._applyContactLight(cfg);
    this._applyAngledLight(cfg);
    this._applyShadows(cfg);
    this._applyPost(cfg);
  }

  // SH ambient probe. Manual override (map.sh / map.shCoefficients) wins; else bake a small cube
  // from the room center once. Both go through the SAME LightProbe object added to the scene.
  _applyProbe(cfg) {
    if (!cfg.shProbe) {
      if (this._probe) { this.scene.remove(this._probe); this._probe = null; }
      return;
    }
    if (!this._probe) this._probe = new THREE.LightProbe();
    // scene.clear() may have detached it — ensure it's in the scene.
    if (this._probe.parent !== this.scene) this.scene.add(this._probe);

    const override = this._map && (this._map.__shOverride || null);
    if (override) {
      this._setProbeFromCoefficients(override);
    } else {
      this._bakeProbe(); // async; probe stays neutral until it lands
    }
  }

  _setProbeFromCoefficients(triples) {
    if (!this._probe || !Array.isArray(triples) || triples.length !== 9) return;
    const coeffs = this._probe.sh.coefficients;
    for (let i = 0; i < 9; i++) coeffs[i].set(triples[i][0], triples[i][1], triples[i][2]);
    this._probe.intensity = this._ambient; // LOW ambient fill (per-map tunable) — not a flat 1.0
  }

  // Bake a ~64px cubemap from the room center and convert to a LightProbe (9 SH coefficients).
  // Runs once per reattach; cheap enough for all tiers. Fully guarded / fail-silent.
  async _bakeProbe() {
    if (this._baking) return;
    this._baking = true;
    const token = ++this._bakeToken;
    try {
      if (!this._probeMod) this._probeMod = await import('three/addons/lights/LightProbeGenerator.js');
      if (token !== this._bakeToken || !this._probe) return; // superseded / probe gone
      const gen = this._probeMod.LightProbeGenerator;
      const rt = new THREE.WebGLCubeRenderTarget(64);
      const cubeCam = new THREE.CubeCamera(0.5, 1000, rt);
      // Position at the room center, roughly eye height.
      const size = (this._map && this._map.size) || 36;
      cubeCam.position.set(0, Math.min(2.2, size * 0.1), 0);
      this.scene.add(cubeCam);
      // Hide the probe's own contribution during the bake so we sample the lit surfaces, not a
      // feedback loop (a fresh probe is neutral, but be safe on a re-bake).
      this._probe.intensity = 0;
      cubeCam.update(this.renderer, this.scene);
      const baked = gen.fromCubeRenderTarget(this.renderer, rt);
      this.scene.remove(cubeCam);
      rt.dispose();
      if (token !== this._bakeToken || !this._probe) return; // superseded mid-bake
      const coeffs = this._probe.sh.coefficients;
      for (let i = 0; i < 9; i++) coeffs[i].copy(baked.sh.coefficients[i]);
      this._probe.intensity = this._ambient; // LOW ambient fill (per-map tunable) — not a flat 1.0
    } catch (e) {
      // Baking must never break the game — leave the probe neutral.
      if (!LightingRig._loggedBake) { console.warn('[lighting] SH probe bake failed (continuing):', e); LightingRig._loggedBake = true; }
    } finally {
      this._baking = false;
    }
  }

  // ONE straight-down shadow-casting directional light — contact shadows under props/players so
  // jumps read against the ground. Tight orthographic frustum around the play area.
  _applyContactLight(cfg) {
    if (!cfg.contactShadow) {
      if (this._contactLight) { this.scene.remove(this._contactLight); this.scene.remove(this._contactLight.target); this._contactLight = null; }
      return;
    }
    if (!this._contactLight) {
      // 1.0 (was 0.5): this is the ONLY shadow-casting light, and a prop's down-shadow only darkens
      // by however much of the total light THIS light contributes. With ambient now LOW, a strong
      // contact light makes the down-shadow read CLEARLY (the jump-accuracy cue VRmike asked for)
      // instead of the soft wash the old 0.5 gave once the fill lights were counted.
      const l = new THREE.DirectionalLight(0xffffff, 1.0);
      l.castShadow = true;
      this._contactLight = l;
    }
    const l = this._contactLight;
    if (l.parent !== this.scene) this.scene.add(l);
    if (l.target.parent !== this.scene) this.scene.add(l.target);
    const size = (this._map && this._map.size) || 36;
    const half = size / 2;
    // Straight down over the room center.
    l.position.set(0, Math.max(20, size), 0.001); // tiny z so "straight down" still yields a shadow dir
    l.target.position.set(0, 0, 0);
    // Tight frustum: cover the arena, no wasted resolution.
    const cam = l.shadow.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 1; cam.far = Math.max(40, size * 2);
    cam.updateProjectionMatrix();
    l.shadow.bias = -0.0006;
    l.shadow.normalBias = 0.02;
    // Resize the shadow map if the tier changed it (dispose the old GPU texture so it regenerates).
    if (l.shadow.mapSize.x !== cfg.shadowMapSize) {
      l.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
      if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
    }
  }

  // Angled non-shadow directional fill — adds form/shape at T2+. No shadow (cost stays on the one
  // contact light).
  _applyAngledLight(cfg) {
    if (!cfg.angledFill) {
      if (this._angledLight) { this.scene.remove(this._angledLight); this._angledLight = null; }
      return;
    }
    if (!this._angledLight) this._angledLight = new THREE.DirectionalLight(0xfff4e0, 0.35);
    if (this._angledLight.parent !== this.scene) this.scene.add(this._angledLight);
    const size = (this._map && this._map.size) || 36;
    this._angledLight.position.set(-size * 0.4, size * 0.6, size * 0.35);
  }

  _applyShadows(cfg) {
    this.renderer.shadowMap.enabled = this.shadowsOn;
    // Force a shadow-map refresh so newly-enabled shadows render this frame.
    if (this.shadowsOn) this.renderer.shadowMap.needsUpdate = true;
  }

  // Build/tear down the post pipeline (SSAO + optional bloom). Lazy-import on first need.
  _applyPost(cfg) {
    if (!cfg.usesComposer) {
      // Drop the composer entirely on the cheap tiers so nothing keeps GPU targets alive.
      this._disposeComposer();
      return;
    }
    if (!this._postMod) {
      if (!this._postLoading) {
        this._postLoading = true;
        Promise.all([
          import('three/addons/postprocessing/EffectComposer.js'),
          import('three/addons/postprocessing/RenderPass.js'),
          import('three/addons/postprocessing/SSAOPass.js'),
          import('three/addons/postprocessing/UnrealBloomPass.js'),
          import('three/addons/postprocessing/OutputPass.js'),
        ]).then(([ec, rp, ssao, bloom, out]) => {
          this._postMod = {
            EffectComposer: ec.EffectComposer,
            RenderPass: rp.RenderPass,
            SSAOPass: ssao.SSAOPass,
            UnrealBloomPass: bloom.UnrealBloomPass,
            OutputPass: out.OutputPass,
          };
          this._postLoading = false;
          // Rebuild against whatever the tier is NOW (it may have changed while loading).
          if (this._cfg.usesComposer) this._buildComposer(this._cfg);
        }).catch((e) => {
          this._postLoading = false;
          if (!LightingRig._loggedPost) { console.warn('[lighting] post pipeline import failed (falling back to direct render):', e); LightingRig._loggedPost = true; }
        });
      }
      return; // render() falls back to direct until this resolves
    }
    this._buildComposer(cfg);
  }

  _buildComposer(cfg) {
    const M = this._postMod;
    if (!M) return;
    this._disposeComposer();
    const { w, h } = this._size;
    const composer = new M.EffectComposer(this.renderer);
    composer.setSize(w, h);
    // BLACK-SCREEN FIX (2026-07-19): a RenderPass MUST come first — it renders the scene BEAUTY
    // (colour) into the composer buffer. In three r161 SSAOPass.OUTPUT.Default does NOT render the
    // scene itself; it reads the incoming colour from `readBuffer.texture` and composites the AO
    // over it (verified against the r161 SSAOPass source + the official webgl_postprocessing_ssao
    // example, which is RenderPass → SSAOPass → OutputPass). The old code used SSAOPass AS the first
    // pass with nothing feeding readBuffer, so the beauty was an empty (black) buffer → the whole
    // 3D view went SOLID BLACK the instant the lazy post-import resolved (~1s after entering T2/T3,
    // while the direct-render fallback covered the load). Always render the scene first, then layer
    // SSAO / bloom / output on top.
    const renderPass = new M.RenderPass(this.scene, this.camera);
    this._renderPass = renderPass;
    composer.addPass(renderPass);
    if (cfg.ssao) {
      const p = new M.SSAOPass(this.scene, this.camera, w, h);
      p.kernelRadius = AO_KERNEL_RADIUS_METERS;
      // SSAO DISTANCE FALLOFF (round 2, 2026-07-19): min/maxDistance are NORMALIZED depth deltas
      // over the camera near..far span, not meters — with far=500 the old maxDistance=0.1 let AO
      // bleed across ~50 m. Derive them from a world-space meter range (AO_*_DISTANCE_METERS) and
      // THIS camera's near/far so AO only darkens near-range crevices (~1.5 m), never distant geometry.
      const range = ssaoDistanceRange(this.camera.near, this.camera.far);
      p.minDistance = range.minDistance;
      p.maxDistance = range.maxDistance;
      p.output = M.SSAOPass.OUTPUT.Default; // composite AO over the RenderPass beauty (never SSAO-only)
      this._ssaoPass = p;
      composer.addPass(p);
    }
    if (cfg.bloom) {
      const b = new M.UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.4, 0.85);
      this._bloomPass = b;
      composer.addPass(b);
    }
    // OutputPass applies renderer.toneMapping + sRGB once at the end of the chain (the intermediate
    // targets stay linear; three skips tonemap when rendering to a render target, so no double-apply).
    const outp = new M.OutputPass();
    this._outputPass = outp;
    composer.addPass(outp);
    this._composer = composer;
    composer.setSize(w, h);
  }

  _disposeComposer() {
    if (this._ssaoPass && this._ssaoPass.dispose) this._ssaoPass.dispose();
    if (this._bloomPass && this._bloomPass.dispose) this._bloomPass.dispose();
    if (this._outputPass && this._outputPass.dispose) this._outputPass.dispose();
    if (this._composer && this._composer.dispose) this._composer.dispose();
    this._composer = null;
    this._renderPass = null;
    this._ssaoPass = null;
    this._bloomPass = null;
    this._outputPass = null;
  }

  // ---- per-frame render (allocation-free) ----------------------------------
  render() {
    if (this._composer && this.usesComposer) {
      this._composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  onResize(w, h) {
    this._size.w = w; this._size.h = h;
    if (this._composer) {
      // Keep the composer's internal targets in step with the renderer's pixel ratio — the
      // auto-tier render-scale probe changes it, and EffectComposer.setSize alone won't re-read it.
      if (this._composer.setPixelRatio) this._composer.setPixelRatio(this.renderer.getPixelRatio());
      this._composer.setSize(w, h);
    }
    if (this._bloomPass && this._bloomPass.setSize) this._bloomPass.setSize(w, h);
    if (this._ssaoPass && this._ssaoPass.setSize) this._ssaoPass.setSize(w, h);
  }

  // Mobile GPUs drop the WebGL context under pressure. On restore, the composer's render targets +
  // the shadow map are gone — rebuild them and re-bake the probe. The scene itself is rebuilt by
  // buildWorld; the caller drives reattach() right after this.
  onContextRestored() {
    this._disposeComposer();
    this._postMod = this._postMod; // keep the cached imports; just rebuild GPU resources
    if (this._contactLight && this._contactLight.shadow && this._contactLight.shadow.map) {
      this._contactLight.shadow.map.dispose();
      this._contactLight.shadow.map = null;
    }
    this.renderer.shadowMap.needsUpdate = true;
  }
}
