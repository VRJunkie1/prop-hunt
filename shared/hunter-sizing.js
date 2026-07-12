// shared/hunter-sizing.js — BONE-DERIVED sizing for an animated character rig.
//
// WHY THIS MODULE EXISTS (the twice-shipped bug). The SWAT hunter GLB
// (assets/713f6535-…​.glb, an FBX2glTF export) stores its skinned geometry only
// ~4 mm tall and blows the visible body up to human size with a baked
// `CharacterArmature` node scale of [100,100,100] on the BONES. THREE.Box3
// .setFromObject() measures the RAW skinned geometry and ignores the skeleton, so
// it reads that 4 mm phantom — the old scene.js sizing derived a ~450× scale and a
// centre offset from a garbage bbox, planting a ~100×-too-small model several
// metres off its group origin (the "tiny model orbiting the player" everyone saw).
//
// THE FIX: measure the SKELETON instead. Bones carry the armature's baked scale, so
// their feet-to-head world span is the TRUE rendered height, and their bounds give
// a pivot that actually sits on the player's spot. This is pure given an injected
// THREE + a cloned rig, so js/scene.js (browser) and tools/check-hunter-model-size.mjs
// (Node) run the EXACT same code — no copy-paste, and the build's verification asserts
// on this function's real output. See memory/notes/hunter-model.md.

// World-space bounds of every BONE in `root` after refreshing its matrices. Returns
// null when the rig has no bones (caller falls back to armature-scale math, never to
// the raw-geometry bbox that caused the bug). `count` lets the caller reject a
// degenerate one-bone rig.
export function measureRigBones(THREE, root) {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let count = 0;
  root.traverse((o) => {
    if (!o.isBone) return;
    o.getWorldPosition(v);
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
    count++;
  });
  if (!count) return null;
  return {
    count,
    minX, minY, minZ, maxX, maxY, maxZ,
    height: maxY - minY,
    footY: minY,
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
  };
}

// Find a bone by name, TOLERANT of GLTFLoader's node-name sanitization. GLTFLoader
// strips '.'/spaces/reserved characters from glTF node names, so an authored bone name
// like "Wrist.R" loads as "WristR" — a strict `o.name === "Wrist.R"` never matches and
// the weapon silently fails to attach (a real bug the size check caught, masked while the
// model was mis-sized). Normalising both sides makes the config's readable name work
// whatever form the loader produced. Restricted to actual Bone objects.
function normBoneName(s) {
  return String(s || '').replace(/[\s._:|-]/g, '').toLowerCase();
}
export function findBone(root, name) {
  if (!root || !name) return null;
  const want = normBoneName(name);
  let found = null;
  root.traverse((o) => {
    if (!found && o.isBone && normBoneName(o.name) === want) found = o;
  });
  return found;
}

// Size + centre a cloned hunter rig from its BONES and return the placed wrapper
// Group (feet centroid at the group origin, x/z centred on the vertical axis, facing
// corrected by cfg.yawOffsetDeg). `inner` MUST be a SkeletonUtils.clone of the GLB
// scene (a plain clone breaks the skeleton). `cfg` = the character-model registry
// entry ({ heightMeters, yawOffsetDeg }).
//
// Order matters and is deliberate:
//   1. apply the facing yaw FIRST, so all measurement + centring happen in the final
//      oriented frame (rotation-correct even for an off-centre rig);
//   2. measure the BONES (never Box3.setFromObject — that reads the 4 mm phantom);
//   3. centre `inner` from those SAME bone bounds (feet → y=0, x/z → axis);
//   4. scale the WRAPPER GROUP by targetH / trueHeight, so the bones — and therefore
//      the skinned mesh they drive — actually scale.
// Returns { group, scale, trueHeight, finalHeight, footY, cx, cz, degenerate } so the
// caller (and the headless check) can inspect the real numbers.
export function sizeHunterRig(THREE, inner, cfg) {
  const targetH = cfg && cfg.heightMeters > 0 ? cfg.heightMeters : 1.8;

  // 1) Facing first.
  inner.position.set(0, 0, 0);
  inner.scale.setScalar(1);
  inner.rotation.set(0, 0, 0);
  if (cfg && cfg.yawOffsetDeg) inner.rotation.y = (cfg.yawOffsetDeg * Math.PI) / 180;

  // 2) Measure the skeleton.
  const bones = measureRigBones(THREE, inner);
  const degenerate = !bones || !(bones.height > 1e-3) || bones.count < 2;

  let trueHeight, footY, cx, cz;
  if (!degenerate) {
    trueHeight = bones.height;
    footY = bones.footY;
    cx = bones.cx;
    cz = bones.cz;
  } else {
    // FALLBACK — never the raw-geometry bbox that caused this bug. Derive a sane scale
    // from the armature's own world scale on a nominal 1.8 u human instead of a garbage
    // 4 mm measurement. Centre stays at the origin (best effort for a broken rig).
    inner.updateMatrixWorld(true);
    const s = new THREE.Vector3();
    inner.getWorldScale(s);
    const armScale = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) || 1;
    trueHeight = 1.8 * armScale;
    footY = 0;
    cx = 0;
    cz = 0;
  }

  const scale = trueHeight > 1e-4 ? targetH / trueHeight : 1;

  // 3) Centre from the same bone bounds (offsets live on `inner`, pre-group-scale).
  inner.position.set(-cx, -footY, -cz);

  // 4) Scale the wrapper group so the bones (skinned render) actually scale.
  const group = new THREE.Group();
  group.add(inner);
  group.scale.setScalar(scale);

  return {
    group,
    scale,
    trueHeight,
    finalHeight: trueHeight * scale,
    footY,
    cx,
    cz,
    degenerate,
  };
}
