/**
 * The engine's built-in volumetric entity archetypes: the ten creature and
 * prop mesh builders ported from Liminal, plus the sixteen city archetypes
 * added for Beyond Dawn — the vehicle/prop set (pod_car, tram_car, skimmer,
 * cache, crate, repair_kit, street_lamp), the street-furniture set (bench,
 * planter, tree_canopy, antenna_mast, lantern), the vent's steam_plume, the
 * player's arc_bolt, the campus's corp_guard and the winch's tether (the
 * first PARAMETRIC archetype: its shape comes from `entity.params`, not a
 * pose), each behind its own block comment below — with the registry the
 * facade validates against.
 *
 * `corp_guard` is the one archetype that spans the two halves: it is Beyond
 * Dawn content built on the ported `hider` body, through the shared arm and
 * leg chains documented under THE SHARED OPERATIVE LIMBS. The provenance note
 * below still holds — nothing in the guard came from anywhere but here.
 *
 * OPT-IN CONTENT, NOT RENDERER BEHAVIOR. The renderer still installs no
 * entity content on its own — an engine that has been handed no world draws no
 * volumetric entities, exactly as before. This module only takes effect when a
 * game registers an archetype through `AsciiEngine.registerMeshArchetype`,
 * which installs a content pack over `renderer.setEntityContent` exactly the
 * way a game's own world module would.
 *
 * PROVENANCE. The builders are ported verbatim from Liminal Protocol's
 * `renderer/world/WorldEntityMeshes.js` (the author's own game — LICENSE.md
 * records full proprietary rights; no third-party code). They are the second
 * half of what `EntityGeometry.js` kept the first half of: the primitives
 * stayed in the engine, the roster went to the game, and this file brings the
 * creature subset back as a reusable library. Only the builders whose
 * archetype has an animation profile in `EntityAnimation.js` were ported;
 * Liminal's facility props (terminals, hatches, capsules) stay game content.
 *
 * COORDINATE SPACE — renderer entity space, not the facade's. Everything in
 * this file is authored in renderer cells with Z DOWN: the floor plane is
 * +0.5 (feet stand at ~+0.49), up is negative, and a standing creature spans
 * roughly z +0.49 .. -0.5. `createBasis` makes heading 0 face +x, with
 * positive heading turning toward +y. The facade converts snapshot fields
 * into this space before the builders ever see an entity.
 *
 * ANIMATION STATE. Builders resolve their motion through
 * `resolveEntityAnimation`, whose per-entity track is keyed by OBJECT
 * IDENTITY in a WeakMap. Whoever feeds entities to this path must keep one
 * persistent object per entity id across frames — rebuilding fresh entity
 * objects every frame resets gait, transitions and the 650 ms spawn ramp.
 * The facade's mesh-entity pool exists for exactly this reason.
 */

import {
  ENTITY_LOD,
  ENTITY_VERTEX_STRIDE,
  addJointedLimb,
  addLocalBox,
  addLocalEllipsoid,
  addLocalRing,
  addLocalSegment,
  createBasis,
  createMeshBuffer,
  finishMesh,
  resolveMaterial
} from './EntityGeometry.js';
import { buildArchitecturalFrame } from './ArchitecturalFrame.js';
import { buildSheetMesh } from './SheetArchetype.js';
import { buildFigureMesh } from './FigureArchetype.js';
import { buildShapeMesh } from './ShapeArchetype.js';
import { buildNightScavengerMesh } from './NightScavenger.js';
import { buildShelterContactMesh } from './ShelterContact.js';
import { buildShamblerMesh, buildCrowbarMesh } from './SurvivorMeshes.js';
import { ENTITY_ANIMATION_PROFILES, resolveEntityAnimation } from './EntityAnimation.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// The original node mast ran 0.57 world units from its base to the head.
// Upgrade 62 keeps one quarter of that support height and lowers the complete
// animated head assembly by the removed 75%, so its silhouette stays coherent.
export const NODE_ASSEMBLY_LOWERING = 0.4275;

const SEEKER_MATERIALS = Object.freeze({
  body: Object.freeze({ color: [1, 0.16, 0.025], roughness: 0.72, emission: 1, lightResponse: 0.15 }),
  head: Object.freeze({ color: [1, 0.06, 0.025], roughness: 0.48, emission: 1, lightResponse: 0.08 }),
  limb: Object.freeze({ color: [1, 0.3, 0.02], roughness: 0.68, emission: 1, lightResponse: 0.12 }),
  core: Object.freeze({ color: [1, 0.9, 0.42], roughness: 0.2, emission: 1, lightResponse: 0 })
});

export const MATERIALS = Object.freeze({
  pale: Object.freeze({ color: [0.84, 0.88, 0.92], roughness: 0.7, emission: 1, lightResponse: 0.18 }),
  warning: Object.freeze({ color: [1, 0.08, 0.03], roughness: 0.46, emission: 1, lightResponse: 0.06 }),
  corrosion: Object.freeze({ color: [0.8, 0.09, 0.02], roughness: 0.92, emission: 1, lightResponse: 0.12 }),
  echo: Object.freeze({ color: [0.02, 0.75, 0.9], roughness: 0.22, emission: 1, lightResponse: 0 }),
  spectral: Object.freeze({ color: [0.7, 0.12, 1], roughness: 0.18, emission: 1, lightResponse: 0 }),
  banshee: Object.freeze({ color: [0.62, 0.9, 1], roughness: 0.24, emission: 1, lightResponse: 0.02 }),
  steel: Object.freeze({ color: [0.12, 0.72, 0.58], roughness: 0.58, emission: 1, lightResponse: 0.15 }),
  darkSteel: Object.freeze({ color: [0.08, 0.16, 0.17], roughness: 0.82, emission: 1, lightResponse: 0.2 }),
  amber: Object.freeze({ color: [1, 0.48, 0.02], roughness: 0.32, emission: 1, lightResponse: 0.02 }),
  cyan: Object.freeze({ color: [0.03, 0.82, 1], roughness: 0.24, emission: 1, lightResponse: 0 }),
  green: Object.freeze({ color: [0.02, 1, 0.35], roughness: 0.28, emission: 1, lightResponse: 0 }),
  magenta: Object.freeze({ color: [1, 0.02, 0.42], roughness: 0.28, emission: 1, lightResponse: 0 }),
  violet: Object.freeze({ color: [0.9, 0.02, 0.95], roughness: 0.24, emission: 1, lightResponse: 0 }),
  white: Object.freeze({ color: [1, 0.94, 0.62], roughness: 0.18, emission: 1, lightResponse: 0 }),
  suit: Object.freeze({ color: [0.84, 0.31, 0.04], roughness: 0.64, emission: 1, lightResponse: 0.12 }),
  suitDark: Object.freeze({ color: [0.16, 0.18, 0.2], roughness: 0.88, emission: 1, lightResponse: 0.18 })
});

function mix3(from, to, amount) {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount
  ];
}

function seededPhase(entity) {
  const source = String(entity.id || `${entity.x}:${entity.y}`);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967295) * Math.PI * 2;
}

export function buildSeekerMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return { vertices: new Float32Array(0), vertexCount: 0, lod: ENTITY_LOD.BILLBOARD };
  }

  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const motion = resolveEntityAnimation(entity, 'seeker', currentTime, { lod });
  const stride = motion.stride;
  const bob = motion.bob + motion.breath;
  const sway = motion.sway;
  const lean = motion.lean;
  const full = lod === ENTITY_LOD.FULL;
  const radialSegments = full ? 7 : 5;
  const longitudeSegments = full ? 10 : 7;
  const latitudeSegments = full ? 6 : 4;
  const bodyMaterial = resolveMaterial(entity, SEEKER_MATERIALS.body, options, 0.55);
  const headMaterial = resolveMaterial(entity, SEEKER_MATERIALS.head, options, 0.15);
  const limbMaterial = resolveMaterial(entity, SEEKER_MATERIALS.limb, options, 0.75);
  const coreMaterial = resolveMaterial(entity, SEEKER_MATERIALS.core, options, 0.12, 0.5, '☼');
  const innerMaterial = { color: [0.045, 0.012, 0.008], roughness: 0.9, emission: 0.58, lightResponse: 0.24 };
  const stage = motion.finisherStage || 0;
  const lock = clamp(motion.pose.lock || 0, 0, 1);
  const aperture = clamp(motion.pose.aperture || 0.38, 0.08, 1);
  const tendrilSpread = clamp(motion.pose.tendrilSpread || 0.5, 0.1, 1);
  // The luminous aperture is the organ the lore names as its recognition
  // feature. At gameplay amplitude it blooms by 0.047 units; under a finisher it
  // opens wide enough to be the thing the shot is about.
  const apertureBloom = aperture * (1 + stage * 3.2);
  const limbSpread = 1 - lock * 0.52;
  const gait = motion.gait;

  // ANOMALY-01 is an observation-reactive organism: a layered carapace locks
  // into a shrine-like sentinel while watched and unfolds into a low predatory
  // configuration when the player's gaze leaves it.
  addLocalEllipsoid(vertices, basis, [-0.055 + lean * 0.2, sway * 0.4, 0.13 + bob], [0.12, 0.17, 0.14], innerMaterial, longitudeSegments, latitudeSegments);
  addLocalEllipsoid(vertices, basis, [lean * 0.7, sway, -0.075 + bob], [0.115, 0.18, 0.215], innerMaterial, longitudeSegments, latitudeSegments);
  for (const [plateZ, plateWidth, plateTilt] of [[-0.19, 0.19, 0.01], [-0.08, 0.175, -0.005], [0.035, 0.15, 0.012]]) {
    addLocalEllipsoid(vertices, basis, [0.095 + lean * 0.78 + plateTilt, sway, plateZ + bob], [0.035, plateWidth, 0.058], bodyMaterial, full ? 9 : 7, full ? 5 : 4);
  }
  addLocalEllipsoid(vertices, basis, [-0.07 + lean * 0.35, sway * 0.7, -0.13 + bob], [0.085, 0.23, 0.13], headMaterial, longitudeSegments, latitudeSegments);
  addLocalEllipsoid(vertices, basis, [0.02 + lean, sway * 1.15, -0.315 + bob], [0.135, 0.17, 0.135], headMaterial, longitudeSegments, latitudeSegments);

  // Split facial aperture and bright observation organ.
  addLocalRing(vertices, basis, [0.142 + lean, sway * 1.15, -0.315 + bob], 0.11 + apertureBloom * 0.012, 0.014, coreMaterial, full ? 16 : 10, 'x');
  addLocalRing(vertices, basis, [0.149 + lean, sway * 1.15, -0.315 + bob], 0.078 + apertureBloom * 0.01, 0.016, innerMaterial, full ? 14 : 9, 'x');
  addLocalEllipsoid(vertices, basis, [0.169 + lean, sway * 1.15, -0.315 + bob], [0.032, 0.045 + apertureBloom * 0.047, 0.03 + apertureBloom * 0.035], coreMaterial, 9, 5);
  for (const side of [-1, 1]) {
    addLocalSegment(vertices, basis,
      [0.1 + lean, side * 0.04 + sway, -0.39 + bob],
      [0.155 + lean, side * (0.055 + apertureBloom * 0.065) + sway, -0.315 + bob],
      0.032, 0.012, headMaterial, radialSegments);
    addJointedLimb(vertices, basis, [
      [-0.055 + lean * 0.35, side * 0.08, -0.405 + bob],
      [-0.11 + lean * 0.2, side * 0.115, -0.452 + motion.secondary * side * 0.006],
      [-0.17 + lean * 0.12, side * 0.145, -0.472]
    ], [0.026, 0.014, 0.005], headMaterial, radialSegments);
  }
  addLocalSegment(vertices, basis,
    [-0.06 + lean * 0.3, 0, -0.42 + bob],
    [-0.19 + lean * 0.12, 0.012, -0.478],
    0.024, 0.004, headMaterial, radialSegments);

  if (full) {
    for (let plate = 0; plate < 4; plate++) {
      addLocalEllipsoid(vertices, basis, [-0.135 - plate * 0.012, sway * 0.45, -0.19 + plate * 0.105 + bob], [0.025, 0.16 - plate * 0.012, 0.035], headMaterial, 7, 4);
    }
  }

  const armSwing = Math.sin(gait + Math.PI) * (motion.pose.armSwing || 0);
  for (const side of [-1, 1]) {
    const signedStride = side < 0 ? stride : -stride;
    const lift = Math.max(0, signedStride) * 0.42;
    const hindFoot = [signedStride * 1.25 - 0.08, side * (0.29 * limbSpread), 0.475];
    addJointedLimb(vertices, basis, [
      [-0.045 + lean * 0.2, side * 0.12, 0.1 + bob],
      [signedStride + 0.06, side * (0.25 * limbSpread), 0.3 - lift],
      hindFoot
    ], [0.062, 0.04, 0.018], limbMaterial, radialSegments);
    addLocalEllipsoid(vertices, basis, [hindFoot[0] + 0.035, hindFoot[1], hindFoot[2]], [0.055, 0.027, 0.012], limbMaterial, 7, 4);

    const foreFoot = [lean + armSwing * side + 0.11, side * (0.39 * limbSpread), 0.455 - Math.max(0, lean) * 0.28];
    addJointedLimb(vertices, basis, [
      [lean * 0.65, side * 0.19, -0.1 + bob],
      [lean + armSwing * side, side * (0.31 * limbSpread), 0.12],
      foreFoot
    ], [0.052, 0.032, 0.012], limbMaterial, radialSegments);
    addLocalEllipsoid(vertices, basis, [foreFoot[0] + 0.045, foreFoot[1], foreFoot[2]], [0.06, 0.025, 0.01], coreMaterial, 7, 4);

    if (full) {
      const tendrilMotion = motion.secondary * 0.055 * side;
      // ANOM-01's defining behaviour is that it UNFOLDS when unobserved. In play
      // that unfold is a 0.19-unit flare, because the player is meant to catch it
      // at the edge of vision. A finisher is the unfold seen in full, so the
      // carapace gets the travel the silhouette implies.
      const unfold = 1 + stage * 2.6;
      addJointedLimb(vertices, basis, [
        [-0.1, side * 0.11, 0.02 + bob],
        [-0.2, side * (0.2 + tendrilSpread * 0.1 * unfold), 0.15],
        [-0.26 + tendrilMotion, side * (0.25 + tendrilSpread * 0.16 * unfold), 0.31],
        [-0.2 + tendrilMotion, side * (0.3 + tendrilSpread * 0.19 * unfold), 0.455]
      ], [0.024, 0.017, 0.01, 0.004], innerMaterial, 6);
    }
  }

  return finishMesh(vertices, lod, {
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: clamp(stride, -1, 1),
    bob,
    lean,
    turn: motion.turn,
    observed: motion.state === 'observed',
    lock,
    aperture,
    tendrilSpread,
    anatomy: 'observation-reactive-carapace'
  });
}

export function buildMournerMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const radial = full ? 7 : 5;
  const sphereLong = full ? 10 : 7;
  const sphereLat = full ? 6 : 4;
  const motion = resolveEntityAnimation(entity, 'mourner', currentTime, { lod });
  const pose = motion.pose;
  const faceCover = clamp(pose.faceCover || 0, 0, 1);
  const jawOpen = clamp(pose.jawOpen || 0, 0, 1);
  const crouch = pose.crouch || 0;
  const tremor = Math.sin(motion.timeSeconds * 24 + motion.phase) * (pose.tremor || 0);
  const stride = motion.stride;
  const lean = motion.lean;
  const bob = motion.bob + motion.breath;
  const body = resolveMaterial(entity, MATERIALS.pale, options, 0.5);
  const bone = resolveMaterial(entity, MATERIALS.pale, options, 0.18);
  const eyes = { ...MATERIALS.white, color: [0.86, 0.9, 0.94], emission: 1 };
  const mouth = { ...MATERIALS.darkSteel, color: [0.012, 0.016, 0.018], lightResponse: 0.02 };

  const ceilingLimit = -0.482;
  const floorLimit = 0.482;
  const rawHeadZ = -0.52 + crouch * 0.72 + bob + tremor * 0.25;
  // The Mourner is canonically too tall for an ordinary corridor. Preserve that
  // impression by folding the upper spine beneath the ceiling instead of
  // uniformly scaling the mesh whenever an animation straightens the body.
  const ceilingDrop = Math.max(0, ceilingLimit - (rawHeadZ - 0.16));
  const torsoCenter = [lean * 0.45, tremor * 0.25, -0.08 + crouch * 0.45 + bob + ceilingDrop * 0.22];
  const pelvisCenter = [lean * 0.18, tremor * 0.15, 0.16 + crouch * 0.2 + bob];
  const headX = lean + 0.035;
  const headZ = rawHeadZ + ceilingDrop;

  // Canonical 2.38 m emaciated silhouette: narrow torso, visible shoulder
  // structure, small pelvis, elongated head, and extremely long limbs.
  addLocalEllipsoid(vertices, basis, torsoCenter, [0.072, 0.11, 0.275], body, sphereLong, sphereLat);
  addLocalEllipsoid(vertices, basis, pelvisCenter, [0.075, 0.09, 0.1], body, sphereLong, sphereLat);
  addLocalSegment(vertices, basis, [lean * 0.35, -0.145, -0.27 + crouch * 0.5 + bob], [lean * 0.35, 0.145, -0.27 + crouch * 0.5 + bob], 0.028, 0.022, bone, radial);
  if (full) {
    for (let rib = 0; rib < 3; rib++) {
      const z = -0.2 + rib * 0.085 + crouch * 0.45 + bob;
      const halfWidth = 0.135 - rib * 0.012;
      addLocalSegment(vertices, basis, [lean * 0.42 + 0.07, -halfWidth, z], [lean * 0.42 + 0.07, halfWidth, z], 0.012, 0.009, bone, 5);
    }
  }

  addLocalEllipsoid(vertices, basis, [headX, tremor * 0.35, headZ], [0.105, 0.115, 0.16], bone, sphereLong, sphereLat);
  const mouthCenterZ = headZ + 0.04 + jawOpen * 0.035;
  addLocalEllipsoid(vertices, basis, [headX + 0.102, tremor * 0.35, mouthCenterZ], [0.016, 0.038, 0.014 + jawOpen * 0.045], mouth, 8, 5);
  addLocalEllipsoid(vertices, basis, [headX + 0.072, tremor * 0.35, headZ + 0.09 + jawOpen * 0.075], [0.043, 0.055, 0.025], bone, 8, 5);
  for (const side of [-1, 1]) {
    const eyeCenter = [headX + 0.112, side * 0.056 + tremor * 0.35, headZ - 0.04];
    addLocalEllipsoid(vertices, basis, eyeCenter, [0.014, 0.024, 0.021], mouth, 6, 4);
    addLocalEllipsoid(vertices, basis, [eyeCenter[0] + 0.012, eyeCenter[1], eyeCenter[2]], [0.009, 0.012, 0.01], eyes, 6, 4);
  }

  const shoulderZ = -0.25 + crouch * 0.5 + bob + ceilingDrop * 0.48;
  const armSwing = Math.sin(motion.gait + Math.PI) * (pose.armSwing || 0);
  for (const side of [-1, 1]) {
    const shoulder = [lean * 0.4, side * 0.16, shoulderZ];
    const runningElbow = [lean + armSwing, side * 0.235, 0.045 + bob];
    const runningHand = [lean + armSwing * 1.35 + 0.07, side * 0.205, 0.42];
    const coveringElbow = [headX - 0.015, side * 0.275, headZ + 0.18];
    const coveringHand = [headX + 0.125, side * 0.038, headZ + 0.015];
    const elbow = mix3(runningElbow, coveringElbow, faceCover);
    const hand = mix3(runningHand, coveringHand, faceCover);
    elbow[1] += side * tremor;
    hand[1] += side * tremor * 0.7;
    addJointedLimb(vertices, basis, [shoulder, elbow, hand], [0.033, 0.022, 0.01], body, radial);
    addLocalEllipsoid(vertices, basis, hand, [0.027, 0.038, 0.052], bone, 7, 4);
    if (full) {
      for (let finger = -1; finger <= 1; finger++) {
        const fingerSpread = side * finger * 0.018;
        const fingerEnd = faceCover > 0.5
          ? [hand[0] + 0.025, hand[1] + fingerSpread, hand[2] - 0.09]
          : [hand[0] + 0.045, hand[1] + fingerSpread, Math.min(floorLimit, hand[2] + 0.06)];
        addLocalSegment(vertices, basis, hand, fingerEnd, 0.008, 0.004, bone, 5);
      }
    }
  }

  const leftLift = Math.max(0, stride) * 0.42;
  const rightLift = Math.max(0, -stride) * 0.42;
  for (const side of [-1, 1]) {
    const legStride = side < 0 ? stride : -stride;
    const lift = side < 0 ? leftLift : rightLift;
    const hip = [lean * 0.12, side * 0.085, 0.16 + crouch * 0.2 + bob];
    // Bent knees carry the excess leg length forward through low ceilings.
    const knee = [legStride + 0.1, side * 0.105, 0.31 - lift];
    const foot = [legStride * 1.38 - 0.045, side * 0.11, 0.46];
    addJointedLimb(vertices, basis, [hip, knee, foot], [0.05, 0.034, 0.018], body, radial);
    addLocalEllipsoid(vertices, basis, [foot[0] + 0.045, foot[1], foot[2]], [0.075, 0.035, 0.022], bone, 7, 4);
  }

  return finishMesh(vertices, lod, {
    archetype: 'mourner',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: motion.gait,
    lean,
    turn: motion.turn,
    faceCover,
    jawOpen,
    crouch,
    ceilingDrop,
    ceilingLimit,
    floorLimit,
    postureFit: 'corridor-hunch',
    canonicalHeightRatio: 1.36
  });
}

export function buildWardenMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, _options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const radial = full ? 7 : 5;
  const sphereLong = full ? 10 : 7;
  const sphereLat = full ? 6 : 4;
  const motion = resolveEntityAnimation(entity, 'warden', currentTime, { lod });
  const pose = motion.pose;
  const reveal = Number.isFinite(entity.phaseProgress)
    ? clamp(entity.phaseProgress, 0.04, 1)
    : clamp(pose.phaseReveal || 1, 0.04, 1);
  const floorZ = 0.49;
  const horizontalReveal = 0.78 + reveal * 0.22;
  const phasePoint = point => [
    point[0] * horizontalReveal,
    point[1] * horizontalReveal,
    floorZ + (point[2] - floorZ) * reveal
  ];
  const phaseRadii = radii => [radii[0] * horizontalReveal, radii[1] * horizontalReveal, radii[2] * reveal];
  // The Warden is an elderly decomposing man first and a corrosion source second.
  // Keep his anatomy readable in neutral gray-brown flesh while reserving black
  // mucus and rust for wounds, drips, and contact patches.
  const agedFlesh = { color: [0.32, 0.3, 0.26], roughness: 0.96, emission: 0.72, lightResponse: 0.3 };
  const mottledFlesh = { color: [0.245, 0.215, 0.175], roughness: 0.91, emission: 0.64, lightResponse: 0.3 };
  const necroticFlesh = { color: [0.15, 0.12, 0.085], roughness: 0.9, emission: 0.64, lightResponse: 0.24 };
  const exposedTissue = { color: [0.3, 0.07, 0.035], roughness: 0.82, emission: 0.68, lightResponse: 0.18 };
  const mucus = { color: [0.018, 0.024, 0.02], roughness: 0.2, emission: 0.56, lightResponse: 0.4 };
  const corrosion = { color: [0.34, 0.12, 0.035], roughness: 0.94, emission: 0.68, lightResponse: 0.2 };
  const cavity = { color: [0.004, 0.005, 0.004], roughness: 0.98, emission: 0.4, lightResponse: 0.08 };
  const lean = motion.lean;
  const bob = motion.bob + motion.breath;
  const asymmetry = Math.sin(motion.timeSeconds * 0.45 + motion.phase) * 0.012;
  const reach = pose.reach || 0;
  const stride = motion.stride;

  // Recognizably human elderly anatomy: narrow pelvis, rounded stooped back,
  // dropped shoulders, forward neck, bald cranium, cheek masses, and jaw.
  addLocalEllipsoid(vertices, basis, phasePoint([-0.035, 0.012, 0.09 + bob]), phaseRadii([0.105, 0.135, 0.12]), necroticFlesh, sphereLong, sphereLat);
  addLocalEllipsoid(vertices, basis, phasePoint([lean * 0.42, 0, -0.105 + bob]), phaseRadii([0.105, 0.155, 0.245]), mottledFlesh, sphereLong, sphereLat);
  addLocalEllipsoid(vertices, basis, phasePoint([lean * 0.68 - 0.055, 0.01, -0.245 + bob]), phaseRadii([0.105, 0.19, 0.12]), necroticFlesh, sphereLong, sphereLat);
  addLocalSegment(vertices, basis,
    phasePoint([lean * 0.62, 0, -0.25 + bob]),
    phasePoint([lean * 0.86, -0.012 + asymmetry, -0.36 + bob]),
    0.07 * reveal, 0.058 * reveal, necroticFlesh, radial);
  addLocalEllipsoid(vertices, basis, phasePoint([lean + 0.035, -0.012 + asymmetry, -0.42 + bob]), phaseRadii([0.108, 0.116, 0.13]), agedFlesh, sphereLong, sphereLat);
  addLocalEllipsoid(vertices, basis, phasePoint([lean + 0.105, -0.012 + asymmetry, -0.345 + bob]), phaseRadii([0.07, 0.098, 0.075]), agedFlesh, 8, 5);
  addLocalEllipsoid(vertices, basis, phasePoint([lean + 0.095, -0.07 + asymmetry, -0.405 + bob]), phaseRadii([0.04, 0.038, 0.052]), agedFlesh, 7, 4);
  addLocalEllipsoid(vertices, basis, phasePoint([lean + 0.095, 0.05 + asymmetry, -0.4 + bob]), phaseRadii([0.04, 0.038, 0.052]), necroticFlesh, 7, 4);

  // Deep sockets, collapsed nose, uneven mouth, and a few heavy facial folds
  // read as an elderly human face even at ASCII resolution.
  for (const side of [-1, 1]) {
    addLocalEllipsoid(vertices, basis, phasePoint([lean + 0.142, side * 0.047 - 0.012 + asymmetry, -0.435 + bob]), phaseRadii([0.015, 0.025, 0.02]), cavity, 6, 4);
  }
  addLocalSegment(vertices, basis,
    phasePoint([lean + 0.137, -0.012 + asymmetry, -0.42 + bob]),
    phasePoint([lean + 0.158, -0.012 + asymmetry, -0.375 + bob]),
    0.014 * reveal, 0.009 * reveal, necroticFlesh, 6);
  addLocalSegment(vertices, basis,
    phasePoint([lean + 0.15, -0.068 + asymmetry, -0.335 + bob]),
    phasePoint([lean + 0.155, 0.052 + asymmetry, -0.35 + bob]),
    0.014 * reveal, 0.008 * reveal, cavity, 6);
  if (full) {
    for (const foldZ of [-0.39, -0.365]) {
      addLocalSegment(vertices, basis,
        phasePoint([lean + 0.13, -0.075 + asymmetry, foldZ + bob]),
        phasePoint([lean + 0.137, 0.06 + asymmetry, foldZ + 0.008 + bob]),
        0.006 * reveal, 0.003 * reveal, necroticFlesh, 5);
    }
  }

  if (full) {
    const lesions = [
      [lean * 0.55 + 0.115, -0.115, -0.2, 0.04],
      [lean * 0.42 + 0.12, 0.105, -0.055, 0.052],
      [0.075, -0.085, 0.1, 0.042],
      [lean + 0.125, 0.06, -0.38, 0.026]
    ];
    for (const lesion of lesions) {
      addLocalEllipsoid(vertices, basis, phasePoint([lesion[0], lesion[1], lesion[2] + bob]), phaseRadii([0.01, lesion[3] * 0.7, lesion[3] * 0.86]), cavity, 6, 4);
      addLocalEllipsoid(vertices, basis, phasePoint([lesion[0] + 0.007, lesion[1], lesion[2] + bob]), phaseRadii([0.006, lesion[3] * 0.38, lesion[3] * 0.48]), exposedTissue, 6, 4);
    }

    // Broken patches of the glossy black coating sit on top of, rather than
    // replacing, the decomposed human surface.
    const mucusPatches = [
      [lean * 0.48 + 0.105, -0.105, -0.12, 0.009, 0.045, 0.075],
      [lean * 0.55 + 0.105, 0.12, -0.235, 0.008, 0.038, 0.055],
      [lean + 0.13, -0.07, -0.38, 0.007, 0.028, 0.04]
    ];
    for (const patch of mucusPatches) {
      addLocalEllipsoid(vertices, basis, phasePoint([patch[0], patch[1], patch[2] + bob]), phaseRadii(patch.slice(3).map(value => value * 0.65)), mucus, 7, 4);
    }
  }

  const armSwing = Math.sin(motion.gait + Math.PI) * (pose.armSwing || 0);
  const leftShoulder = phasePoint([lean * 0.5, -0.175, -0.22 + bob]);
  const rightShoulder = phasePoint([lean * 0.48, 0.17, -0.2 + bob]);
  const leftElbow = phasePoint([lean + armSwing, -0.235, 0.015]);
  const rightElbow = phasePoint([lean - armSwing * 0.75, 0.225, 0.04]);
  const leftHand = phasePoint([lean + 0.07 + reach * 0.15 + armSwing, -0.245, 0.285]);
  const rightHand = phasePoint([lean + 0.04 + reach * 0.2 - armSwing * 0.8, 0.235, 0.26]);
  addJointedLimb(vertices, basis, [leftShoulder, leftElbow, leftHand], [0.048 * reveal, 0.032 * reveal, 0.018 * reveal], agedFlesh, radial);
  addJointedLimb(vertices, basis, [rightShoulder, rightElbow, rightHand], [0.047 * reveal, 0.03 * reveal, 0.016 * reveal], mottledFlesh, radial);
  addLocalEllipsoid(vertices, basis, leftHand, phaseRadii([0.038, 0.043, 0.052]), necroticFlesh, 7, 4);
  addLocalEllipsoid(vertices, basis, rightHand, phaseRadii([0.036, 0.042, 0.05]), mottledFlesh, 7, 4);
  if (full) {
    for (const [hand, side] of [[leftHand, -1], [rightHand, 1]]) {
      for (let finger = -1; finger <= 1; finger++) {
        addLocalSegment(vertices, basis, hand, [
          hand[0] + 0.055 * horizontalReveal,
          hand[1] + side * finger * 0.015,
          hand[2] + 0.075 * reveal
        ], 0.008 * reveal, 0.003 * reveal, necroticFlesh, 5);
      }
    }
  }

  const leftLift = Math.max(0, stride) * 0.28;
  const rightLift = Math.max(0, -stride) * 0.2;
  const leftHip = phasePoint([-0.025, -0.085, 0.15 + bob]);
  const rightHip = phasePoint([-0.055, 0.075, 0.175 + bob]);
  const leftFoot = phasePoint([stride * 1.15 - 0.04, -0.105, floorZ]);
  const rightFoot = phasePoint([-stride * 0.9 - 0.09, 0.11, floorZ]);
  addJointedLimb(vertices, basis, [leftHip, phasePoint([stride, -0.11, 0.34 - leftLift]), leftFoot], [0.058 * reveal, 0.04 * reveal, 0.022 * reveal], necroticFlesh, radial);
  addJointedLimb(vertices, basis, [rightHip, phasePoint([-stride * 0.75, 0.1, 0.37 - rightLift]), rightFoot], [0.056 * reveal, 0.038 * reveal, 0.019 * reveal], mottledFlesh, radial);

  if (full) {
    const drip = motion.secondary * 0.035;
    const dripOrigins = [
      phasePoint([0.02, -0.13, 0.02 + bob]),
      phasePoint([lean * 0.5, 0.12, -0.15 + bob]),
      leftHand,
      rightHand
    ];
    dripOrigins.forEach((origin, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      addJointedLimb(vertices, basis, [
        origin,
        [origin[0] - 0.055, origin[1] + side * 0.04, Math.min(floorZ, origin[2] + 0.16)],
        [origin[0] - 0.08 + drip * side, origin[1] + side * 0.065, floorZ]
      ], [0.012 * reveal, 0.007 * reveal, 0.002], mucus, 5);
    });
    addLocalRing(vertices, basis, [0, 0, floorZ - 0.008], 0.2 + reveal * 0.055, 0.012, corrosion, 14, 'z');
    addLocalRing(vertices, basis, [-0.04, 0.02, floorZ - 0.006], 0.13 + Math.abs(motion.secondary) * 0.02, 0.007, mucus, 11, 'z');
  }

  return finishMesh(vertices, lod, {
    archetype: 'warden',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: motion.gait,
    lean,
    turn: motion.turn,
    reveal,
    reach,
    asymmetry,
    anatomy: 'elderly-decomposed-humanoid',
    surfaceLayers: Object.freeze(['aged-flesh', 'necrosis', 'black-mucus', 'contact-corrosion'])
  });
}

export function buildEchoMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return { vertices: new Float32Array(0), vertexCount: 0, lod: ENTITY_LOD.BILLBOARD };
  }

  const explicitStates = new Set(['residual', 'manifesting', 'interference', 'destabilized']);
  const viewerDistance = Number.isFinite(options.viewerDistance) ? options.viewerDistance : Infinity;
  const presentationState = explicitStates.has(entity.state)
    ? entity.state
    : viewerDistance <= 2.5
      ? 'interference'
      : viewerDistance <= 6
        ? 'manifesting'
        : 'residual';
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const radial = full ? 7 : 5;
  const motion = resolveEntityAnimation(entity, 'echo', currentTime, { lod, stateOverride: presentationState });
  const pose = motion.pose;
  const cohesion = clamp(pose.cohesion || 0.58, 0.08, 1);
  const phaseOffset = pose.phaseOffset || 0.07;
  const duplicateSpread = pose.duplicateSpread || 0.06;
  const fracture = pose.fracture || 0.12;
  const trailSpread = pose.trailSpread || 0.34;
  const stride = motion.stride;
  const lean = motion.lean;
  const floatOffset = -0.018 + Math.sin(motion.timeSeconds * 1.7 + motion.phase) * 0.018 + motion.bob;
  const fractureWave = Math.sin(motion.timeSeconds * 17 + motion.phase) * 0.018 * fracture;
  const split = (1 - cohesion) * 0.08 + fracture * 0.018;

  const shellBase = resolveMaterial(entity, MATERIALS.echo, options, 0.5, 0.5, '#');
  const signalBase = resolveMaterial(entity, MATERIALS.cyan, options, 0.22, 0.5, '=');
  const shell = { ...shellBase, emission: 0.74, lightResponse: 0.02, roughness: 0.3 };
  const signal = {
    ...signalBase,
    color: mix3(signalBase.color, [0.86, 0.96, 1], 0.28),
    emission: 0.82 + (pose.coreIntensity || 0.4) * 0.18,
    lightResponse: 0
  };
  const warning = {
    ...MATERIALS.magenta,
    color: mix3(MATERIALS.magenta.color, [0.35, 0.02, 1], 0.38),
    emission: 1,
    lightResponse: 0
  };
  const voidMaterial = { ...MATERIALS.darkSteel, color: [0.006, 0.012, 0.018], emission: 0.34, lightResponse: 0.04 };
  const afterimage = {
    ...shell,
    color: mix3(shell.color, [0.1, 0.03, 0.24], 0.62),
    emission: 0.5,
    lightResponse: 0
  };
  const dangerMaterial = presentationState === 'interference' || presentationState === 'destabilized' ? warning : signal;
  const point = (x, y, z, side = 0) => [
    x + lean + fractureWave * side,
    y + motion.sway * 0.35 + split * side,
    z + floatOffset
  ];

  const head = point(0.025, 0, -0.305, 1);
  const chest = point(0, 0, -0.065, -1);
  const pelvis = point(-0.025, 0, 0.14, 1);

  // The Echo is a failed neural reconstruction: recognizable operator armor
  // landmarks orbit an empty signal cavity instead of forming a solid body.
  addLocalEllipsoid(vertices, basis, head, [0.095, 0.105, 0.115], voidMaterial, full ? 9 : 7, full ? 6 : 4);
  addLocalRing(vertices, basis, head, 0.13 + split * 0.25, 0.009, shell, full ? 15 : 10, 'x');
  addLocalBox(vertices, basis, [head[0] + 0.105, head[1] + split * 0.5, head[2] - 0.015], [0.018, 0.082, 0.032], dangerMaterial);
  addLocalBox(vertices, basis, [head[0] - 0.025, head[1] - 0.1 - split, head[2] - 0.075], [0.045, 0.025, 0.04], shell);

  addLocalEllipsoid(vertices, basis, chest, [0.065, 0.075, 0.09], voidMaterial, 8, 5);
  addLocalRing(vertices, basis, chest, 0.085 + fracture * 0.012, 0.008, dangerMaterial, full ? 13 : 9, 'x');
  addLocalEllipsoid(vertices, basis, [chest[0] + 0.075, chest[1], chest[2]], [0.018, 0.027, 0.032], signal, 7, 4);
  addLocalBox(vertices, basis, point(0.055, -0.105 - split, -0.135, -1), [0.035, 0.065, 0.06], shell);
  addLocalBox(vertices, basis, point(0.02, 0.115 + split, -0.09, 1), [0.04, 0.06, 0.085], shell);
  addLocalBox(vertices, basis, point(-0.025, -0.085, 0.055, 1), [0.045, 0.055, 0.045], afterimage);
  addLocalEllipsoid(vertices, basis, pelvis, [0.08, 0.11, 0.075], shell, full ? 9 : 7, full ? 5 : 4);

  const armSwing = Math.sin(motion.gait + Math.PI) * (pose.armSwing || 0);
  for (const side of [-1, 1]) {
    const shoulder = point(0, side * (0.17 + split), -0.16, side);
    const elbow = point(armSwing * side + 0.015, side * (0.255 + split * 1.4), 0.055, -side);
    const hand = point(armSwing * side * 1.25 + 0.055, side * (0.285 + split * 1.7), 0.285, side);
    const gap = 0.018 + fracture * 0.008;
    const upperEnd = mix3(shoulder, elbow, 0.86);
    const lowerStart = mix3(shoulder, elbow, Math.min(0.98, 0.86 + gap));
    addLocalSegment(vertices, basis, shoulder, upperEnd, 0.045, 0.028, shell, radial);
    addLocalSegment(vertices, basis, lowerStart, hand, 0.025, 0.012, side < 0 ? shell : dangerMaterial, radial);
    addLocalEllipsoid(vertices, basis, hand, [0.026, 0.035, 0.042], signal, 7, 4);
  }

  for (const side of [-1, 1]) {
    const legStride = side < 0 ? stride : -stride;
    const hip = point(-0.02, side * 0.085, 0.15, side);
    const knee = point(legStride * 0.78, side * (0.12 + split * 0.5), 0.335 - Math.max(0, legStride) * 0.25, -side);
    const foot = point(legStride * 1.15 - 0.04, side * (0.13 + split), 0.455, side);
    addLocalSegment(vertices, basis, hip, mix3(hip, knee, 0.84), 0.055, 0.034, shell, radial);
    addLocalSegment(vertices, basis, mix3(hip, knee, 0.94), foot, 0.03, 0.013, afterimage, radial);
    addLocalEllipsoid(vertices, basis, [foot[0] + 0.045, foot[1], foot[2]], [0.065, 0.035, 0.018], signal, 7, 4);
  }

  if (full) {
    // Delayed anatomy trails behind the current pose like a corrupted network
    // frame; sparse landmarks keep it readable instead of becoming a clone.
    const delay = [-phaseOffset, duplicateSpread + motion.secondary * 0.015, 0.018];
    const delayed = source => [source[0] + delay[0], source[1] + delay[1], source[2] + delay[2]];
    addLocalRing(vertices, basis, delayed(head), 0.118, 0.005, afterimage, 12, 'x');
    addLocalRing(vertices, basis, delayed(chest), 0.075, 0.005, afterimage, 10, 'x');
    addLocalSegment(vertices, basis, delayed(point(0, -0.17, -0.16)), delayed(point(-0.03, -0.26, 0.24)), 0.018, 0.005, afterimage, 5);
    addLocalSegment(vertices, basis, delayed(point(-0.02, 0.08, 0.15)), delayed(point(-0.12, 0.15, 0.45)), 0.02, 0.004, afterimage, 5);

    for (const side of [-1, 1]) {
      const ribbonMotion = motion.secondary * 0.035 * side;
      addJointedLimb(vertices, basis, [
        point(-0.08, side * 0.08, 0.02),
        point(-0.2, side * (0.12 + trailSpread * 0.08), 0.18),
        point(-0.32 + ribbonMotion, side * (0.16 + trailSpread * 0.16), 0.36),
        point(-0.38 - ribbonMotion, side * (0.2 + trailSpread * 0.2), 0.47)
      ], [0.018, 0.012, 0.006, 0.002], afterimage, 5);
    }
    if (fracture > 0.3) {
      const burstRadius = 0.18 + Math.abs(motion.secondary) * 0.035;
      addLocalRing(vertices, basis, chest, burstRadius, 0.005, dangerMaterial, 14, 'z');
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'lost-operator-echo',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: motion.gait,
    lean,
    turn: motion.turn,
    cohesion,
    phaseOffset,
    duplicateSpread,
    fracture,
    trailSpread,
    harmfulRadius: 2.5,
    anatomy: 'delayed-phase-operative-imprint'
  });
}

/* ---------------------------------------------------------------------------
 * THE SHARED OPERATIVE LIMBS
 *
 * `hider` and `corp_guard` are the same body wearing different work. Rather
 * than let two copies of a humanoid drift, the two parts that are genuinely
 * identical — the arm chain and the leg chain — live here and both builders
 * call them. What each archetype authors for itself is the part that says who
 * it is: hider's soft helmet, wraparound visor, coherence pack and antenna;
 * the guard's hard helmet, insignia, holster and lamp.
 *
 * WHY THE ARMS GOT THICKER, which is the whole reason this block exists.
 * Below the waist this rig was always jointed and plated. Above it, an arm was
 * a tube that tapered from 0.058 to a 0.024-cell WRIST and ended in a bead —
 * and 0.024 is not thin, it is absent. The default `legacy` glyph pipeline
 * takes ONE scene tap per cell, so a member narrower than the tap spacing does
 * not dim, it strobes in and out as the cell centre wanders across it. The bar
 * the tall fixtures are held to is 0.15 cells of cross-section (the derivation
 * is in docs/API.md and the test that enforces it names both fixtures that
 * failed it before anyone measured). A 0.024-cell wrist presents 0.046 cells
 * to the worst bearing at full LOD and 0.043 at simplified: it was never
 * drawing at range, and nobody noticed because nothing depended on it.
 *
 * Something depends on it now. A guard has to HOLD A LAMP, and a lamp held in
 * an arm that is not there is a light floating beside a torso.
 *
 * THE HONEST NUMBERS, because this is the one place the bar cannot simply be
 * met. These archetypes are authored at ~1 renderer cell for a ~1.8 m body, so
 * 0.15 cells is a 27 cm limb — an arm that clears the bar on tube radius alone
 * is a log, and a log is a worse lie than a thin arm. So the arm buys its
 * legibility the way the arc bolt buys its thinness: from the part that CAN be
 * honest about its size. The tubes go to 0.05 at the wrist (0.093 presented,
 * double what they were), and the VAMBRACE — a box, so its width is its width
 * with no polygon inscription loss — is authored at 0.156 x 0.16 cells and
 * clears the bar outright on both horizontal axes. At range the arm is the
 * vambrace; the tube is what joins it to the shoulder.
 *
 * The pauldron and the new elbow cop are the silhouette half of the same
 * argument. An ASCII figure at 20 cells is an outline, and an outline with a
 * shoulder, a bend and a cuff in it reads as an arm where a smooth taper reads
 * as a stick. Both are ellipsoids at a fixed 7x4 rather than at the LOD's
 * tessellation, deliberately: they are small, and subdividing a 0.09-cell
 * lump buys nothing but vertices.
 * ------------------------------------------------------------------------- */
const OPERATIVE_ARM = Object.freeze({
  upperRadius: 0.068,
  elbowRadius: 0.058,
  wristRadius: 0.05,
  pauldron: Object.freeze([0.088, 0.084, 0.072]),
  elbowCop: Object.freeze([0.062, 0.06, 0.056]),
  /** The member that actually clears the sampler bar: 0.156 x 0.16 cells. */
  vambrace: Object.freeze([0.078, 0.08, 0.086]),
  /** How far along elbow -> hand the vambrace sits. Just past halfway, so it
   *  covers the forearm rather than the wrist and never eats the hand. */
  vambraceAlong: 0.46,
  hand: Object.freeze([0.058, 0.054, 0.062])
});

function addOperativeArm(vertices, basis, shoulder, elbow, hand, limb, plate, radial) {
  addJointedLimb(vertices, basis, [shoulder, elbow, hand],
    [OPERATIVE_ARM.upperRadius, OPERATIVE_ARM.elbowRadius, OPERATIVE_ARM.wristRadius], limb, radial);
  addLocalEllipsoid(vertices, basis, shoulder, OPERATIVE_ARM.pauldron, plate, 7, 4);
  addLocalEllipsoid(vertices, basis, elbow, OPERATIVE_ARM.elbowCop, plate, 7, 4);
  addLocalBox(vertices, basis, mix3(elbow, hand, OPERATIVE_ARM.vambraceAlong), OPERATIVE_ARM.vambrace, plate);
  addLocalEllipsoid(vertices, basis, hand, OPERATIVE_ARM.hand, limb, 7, 4);
}

/**
 * The leg chain. Barely changed from what it always was — it was already the
 * good half of this body — except that the ANKLE went 0.033 -> 0.04. That was
 * the second-thinnest member on the rig after the wrist, and the same
 * arithmetic applies: 0.033 presents 0.060 cells, 0.04 presents 0.072. Still
 * under the bar, and deliberately so; the boot in front of it is 0.176 cells
 * fore-aft and IS over, which is the axis a walking figure is seen along.
 */
const OPERATIVE_LEG = Object.freeze({
  hipRadius: 0.072,
  kneeRadius: 0.058,
  ankleRadius: 0.04,
  kneePlate: Object.freeze([0.058, 0.066, 0.058]),
  boot: Object.freeze([0.088, 0.068, 0.028]),
  bootLead: 0.045,
  bootDrop: -0.012
});

function addOperativeLeg(vertices, basis, hip, knee, foot, limb, plate, sole, radial) {
  addJointedLimb(vertices, basis, [hip, knee, foot],
    [OPERATIVE_LEG.hipRadius, OPERATIVE_LEG.kneeRadius, OPERATIVE_LEG.ankleRadius], limb, radial);
  addLocalBox(vertices, basis, knee, OPERATIVE_LEG.kneePlate, plate);
  addLocalBox(vertices, basis,
    [foot[0] + OPERATIVE_LEG.bootLead, foot[1], foot[2] + OPERATIVE_LEG.bootDrop],
    OPERATIVE_LEG.boot, sole);
}

export function buildHiderMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return { vertices: new Float32Array(0), vertexCount: 0, lod: ENTITY_LOD.BILLBOARD };
  }

  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const radial = full ? 7 : 5;
  const sphereLong = full ? 10 : 7;
  const sphereLat = full ? 6 : 4;
  const motion = resolveEntityAnimation(entity, 'hider', currentTime, { lod });
  const pose = motion.pose;
  const inspection = entity.localInspection ? entity.inspectionMotion : null;
  const studioMotion = entity.localInspection ? entity.studioMotion : null;
  const mapPresentation = clamp(inspection?.map ?? (entity.mapActive ? 1 : 0), 0, 1);
  const revivePose = clamp(studioMotion?.actions?.revive || 0, 0, 1);
  const extractionPose = clamp(studioMotion?.actions?.extract || 0, 0, 1);
  const crouch = Math.max(clamp(pose.crouch || 0, 0, 1), revivePose * 0.52);
  const guard = Math.max(
    clamp(pose.guard || 0, 0, 1),
    clamp(inspection?.impact || 0, 0, 1),
    clamp(inspection?.aim || 0, 0, 1) * 0.32,
    extractionPose * 0.28
  );
  const collapse = clamp(pose.collapse || 0, 0, 1);
  const shieldFlare = Math.max(clamp(pose.shieldFlare || 0, 0, 1), clamp(inspection?.impact || 0, 0, 1));
  const signalJitter = clamp(pose.signalJitter || 0, 0, 1);
  const stride = studioMotion
    ? studioMotion.gaitWave * 0.115 * studioMotion.locomotion
    : motion.stride;
  const bob = studioMotion
    ? studioMotion.bob + motion.breath * 0.55
    : motion.bob + motion.breath;
  const lean = (studioMotion ? 0 : motion.lean)
    + (studioMotion?.accelerationLean || 0) * 0.055
    + extractionPose * 0.045
    - revivePose * 0.025;
  const jitter = Math.sin(motion.timeSeconds * 31 + motion.phase) * 0.012 * signalJitter;

  const armor = resolveMaterial(entity, MATERIALS.suit, options, 0.48, 0.5, 'O');
  const underSuit = resolveMaterial(entity, MATERIALS.suitDark, options, 0.62, 0.5, '#');
  const visorBase = resolveMaterial(entity, MATERIALS.cyan, options, 0.22, 0.5, '=');
  const warning = resolveMaterial(entity, MATERIALS.magenta, options, 0.14, 0.5, '!');
  const hardware = {
    ...underSuit,
    color: mix3(underSuit.color, [0.05, 0.28, 0.31], 0.34),
    roughness: 0.7
  };
  const visor = {
    ...visorBase,
    color: mix3(visorBase.color, [1, 0.04, 0.18], signalJitter * 0.62),
    emission: 0.72 + (pose.visor || 0) * 0.28
  };
  const stateAccent = signalJitter > 0.05 ? warning : visor;
  const localRim = {
    ...visor,
    color: mix3(visor.color, [0.72, 0.94, 1], 0.35),
    emission: 0.42
  };
  const crouchDrop = crouch * 0.13;
  const standing = point => [
    point[0] + lean + jitter,
    point[1] + (studioMotion?.sway ?? motion.sway * 0.3),
    point[2] + crouchDrop + bob
  ];
  const posed = (point, fallen) => mix3(standing(point), [fallen[0], fallen[1], fallen[2] - 0.006], collapse);
  const yawAround = (point, pivot, yaw = 0) => {
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const x = point[0] - pivot[0];
    const y = point[1] - pivot[1];
    return [
      pivot[0] + x * cosine - y * sine,
      pivot[1] + x * sine + y * cosine,
      point[2]
    ];
  };
  const pelvisAnchor = [-0.03, 0, 0.12];
  const chestAnchor = [-0.025, 0, -0.08];
  const pelvisYaw = studioMotion?.pelvisYaw || 0;
  const spineYaw = studioMotion?.spineYaw || 0;
  const lowerPoint = point => yawAround(point, pelvisAnchor, pelvisYaw);
  const upperPoint = point => lowerPoint(yawAround(point, chestAnchor, spineYaw));
  const lowerPosed = (point, fallen) => posed(lowerPoint(point), fallen);
  const upperPosed = (point, fallen) => posed(upperPoint(point), fallen);

  const pelvis = lowerPosed(pelvisAnchor, [-0.08, 0, 0.37]);
  const chest = upperPosed(chestAnchor, [0.08, 0, 0.27]);
  const head = upperPosed([0.015, 0, -0.35], [0.31, -0.035, 0.34]);

  // Articulated graphite pressure suit under segmented SEC-7 field armor.
  addLocalEllipsoid(vertices, basis, pelvis, [0.085, 0.135, 0.115], underSuit, sphereLong, sphereLat);
  addLocalEllipsoid(vertices, basis, chest, [0.11, 0.19, 0.22], underSuit, sphereLong, sphereLat);
  // A recessed abdominal carrier closes the side-profile gaps beneath the
  // three raised plates without sacrificing their segmented read from front.
  addLocalBox(vertices, basis, upperPosed([0.055, 0, 0.01], [0.08, 0, 0.34]), [0.04, 0.128, 0.14], hardware);
  addLocalBox(vertices, basis, upperPosed([0.105, 0, -0.105], [0.08, 0, 0.34]), [0.052, 0.145, 0.075], armor);
  addLocalBox(vertices, basis, upperPosed([0.105, 0, 0.005], [0.12, 0, 0.4]), [0.05, 0.13, 0.045], armor);
  addLocalBox(vertices, basis, upperPosed([0.07, 0, 0.105], [-0.04, 0, 0.37]), [0.055, 0.12, 0.04], armor);

  // Helmet, wraparound visor, crown armor, and the visible T-Link chest node.
  addLocalEllipsoid(vertices, basis, head, [0.135, 0.14, 0.145], underSuit, sphereLong, sphereLat);
  addLocalBox(vertices, basis, upperPosed([0.035, 0, -0.405], [0.31, -0.035, 0.35]), [0.115, 0.125, 0.035], armor);
  addLocalBox(vertices, basis, upperPosed([0.137, 0, -0.355], [0.35, -0.035, 0.405]), [0.025, 0.112, 0.055], visor);
  addLocalBox(vertices, basis, upperPosed([0.148, 0, -0.255], [0.34, -0.035, 0.44]), [0.018, 0.075, 0.026], hardware);
  addLocalEllipsoid(vertices, basis, upperPosed([0.148, 0, -0.075], [0.13, 0, 0.33]), [0.025, 0.038, 0.032], stateAccent, 7, 4);

  // Backpack power spine and paired coherence cells make the silhouette unique.
  // Deepened 0.055 -> 0.064 for the same reason the pauldrons grew: from the
  // side, the whole difference between this body and any other humanoid is the
  // hump behind the shoulders, and it was clearing the chest by 0.065 cells —
  // about one glyph at conversational range and nothing at all past that.
  addLocalBox(vertices, basis, upperPosed([-0.152, 0, -0.07], [0, 0.02, 0.3]), [0.064, 0.145, 0.178], hardware);
  for (const side of [-1, 1]) {
    addLocalSegment(vertices, basis,
      upperPosed([-0.19, side * 0.095, -0.19], [-0.05, side * 0.11, 0.32]),
      upperPosed([-0.19, side * 0.095, 0.105], [0.14, side * 0.16, 0.4]),
      0.038, 0.038, underSuit, radial);
  }

  const armSwing = Math.sin(studioMotion?.gait ?? motion.gait) * (pose.armSwing || 0);
  for (const side of [-1, 1]) {
    const shoulder = upperPosed([0, side * 0.205, -0.145], [0.03, side * 0.18, 0.36]);
    // THE ELBOW FLEXES. It used to only translate fore and aft, which dragged
    // a rigid forearm behind the hand and made a walk read as a pendulum. Half
    // rectified on purpose: an arm swinging BACK straightens and an arm
    // swinging FORWARD bends, and that asymmetry is most of what tells a gait
    // from an oscillation.
    const flex = Math.max(0, armSwing * side) * 0.55;
    // And a mirror-perfect idle is the mannequin tell — two arms hanging in
    // exact reflection is the one thing a body never does. The breath already
    // carries a per-entity phase, so spending a fraction of it asymmetrically
    // on the hands costs nothing and kills the symmetry. Scaled up past the
    // 0.01-cell band where sub-glyph drift reads as boundary flicker rather
    // than as motion (see the street-furniture profiles for the other side of
    // that rule) — at idle this is ~4 cm of hand travel at breathing rate.
    const settle = motion.breath * (side > 0 ? 2.2 : -1.35);
    const relaxedElbow = [armSwing * side, side * 0.255, 0.07 + crouchDrop + settle * 0.6];
    const relaxedHand = [armSwing * 1.2 * side + 0.035 + flex * 0.05, side * 0.245, 0.29 + crouchDrop - flex * 0.045 + settle];
    const guardedElbow = [0.17, side * 0.19, -0.015 + crouchDrop];
    const guardedHand = [0.25, side * 0.075, -0.11 + crouchDrop];
    let actionElbow = mix3(relaxedElbow, guardedElbow, guard);
    let actionHand = mix3(relaxedHand, guardedHand, guard);
    if (inspection) {
      actionElbow = mix3(actionElbow, [0.16, side * 0.17, -0.02], inspection.calibrate || 0);
      actionHand = mix3(actionHand, [0.31, side * 0.065, -0.11], inspection.calibrate || 0);
      if (side > 0) {
        actionElbow = mix3(actionElbow, [0.2, 0.15, -0.04], inspection.interactionReach || 0);
        actionHand = mix3(actionHand, [0.39, 0.08, -0.15], inspection.interactionReach || 0);
        actionHand[1] += (inspection.calibrationSweep || 0) * 0.045 * (inspection.calibrate || 0);
      }
    }
    if (revivePose > 0) {
      actionElbow = mix3(actionElbow, [0.12, side * 0.22, 0.11], revivePose);
      actionHand = mix3(actionHand, [0.27, side * 0.12, 0.27], revivePose);
    }
    if (extractionPose > 0) {
      const extractionElbow = side > 0 ? [0.2, 0.16, -0.12] : [0.12, -0.2, -0.04];
      const extractionHand = side > 0 ? [0.38, 0.08, -0.27] : [0.28, -0.11, -0.13];
      actionElbow = mix3(actionElbow, extractionElbow, extractionPose);
      actionHand = mix3(actionHand, extractionHand, extractionPose);
    }
    if (side < 0 && mapPresentation > 0) {
      actionElbow = mix3(actionElbow, [0.13, -0.18, -0.08], mapPresentation);
      actionHand = mix3(actionHand, [0.25, -0.07, -0.2], mapPresentation);
    }
    const elbow = upperPosed(actionElbow, [0.1, side * 0.31, 0.4]);
    const hand = upperPosed(actionHand, [0.29, side * 0.36, 0.43]);
    addOperativeArm(vertices, basis, shoulder, elbow, hand, underSuit, armor, radial);
    if (entity.localInspection && side > 0 && (inspection?.map || 0) < 0.55) {
      const flashlightTip = [hand[0] + 0.16, hand[1], hand[2] - 0.005];
      addLocalSegment(vertices, basis, hand, flashlightTip, 0.026, 0.035, hardware, radial);
      addLocalEllipsoid(vertices, basis, flashlightTip, [0.02, 0.04, 0.04], entity.flashlightOn ? visor : hardware, 7, 4);
    }
  }

  if (full && mapPresentation > 0.05) {
    const mapCenter = upperPosed([0.275, -0.035, -0.17], [0.18, -0.04, 0.34]);
    const mapGlow = { ...visor, emission: 0.9 + mapPresentation * 0.1 };
    const mapPulse = { ...stateAccent, emission: 0.88 + Math.sin(currentTime * 0.0042) * 0.12 };
    addLocalBox(vertices, basis, mapCenter, [0.018, 0.13, 0.078], hardware);
    addLocalBox(vertices, basis, [mapCenter[0] + 0.02, mapCenter[1], mapCenter[2]], [0.006, 0.112, 0.061], mapGlow);
    addLocalRing(vertices, basis, [mapCenter[0] + 0.03, mapCenter[1], mapCenter[2]], 0.052, 0.006, mapPulse, 14, 'x');
    const orbit = currentTime * 0.0021;
    const marker = [mapCenter[0] + 0.038, mapCenter[1] + Math.cos(orbit) * 0.052, mapCenter[2] + Math.sin(orbit) * 0.052];
    addLocalSegment(vertices, basis, [mapCenter[0] + 0.034, mapCenter[1], mapCenter[2]], marker, 0.004, 0.004, mapGlow, 6);
    addLocalEllipsoid(vertices, basis, marker, [0.009, 0.009, 0.009], mapPulse, 7, 4);
  }

  for (const side of [-1, 1]) {
    const sideStride = side < 0 ? stride : -stride;
    const lateralStride = (studioMotion?.strafe || 0) * sideStride * 0.42;
    const pivotStep = (studioMotion?.turnInPlace || 0) * side * 0.055;
    const plant = side < 0 ? studioMotion?.leftPlant : studioMotion?.rightPlant;
    const plantedLift = studioMotion ? (1 - (plant || 0)) * 0.018 : 0;
    // A WIDER PLANT. The feet used to close to +/-0.12 at rest, which at glyph
    // scale is a column with a head on it — the pose a bollard holds, not the
    // one a person holds. Opening the track to +/-0.132 costs nothing, changes
    // no gait timing, and gives the standing silhouette the shallow A that
    // reads as "someone standing there" from across a forecourt.
    const hip = lowerPosed([-0.015, side * 0.096 + lateralStride * 0.2, 0.15], [-0.06, side * 0.1, 0.39]);
    const knee = lowerPosed([
      sideStride * 0.72 + pivotStep,
      side * 0.113 + lateralStride * 0.7,
      0.34 - Math.max(0, sideStride) * 0.2 - plantedLift
    ], [0.06, side * 0.22, 0.42]);
    const foot = lowerPosed([
      sideStride * 1.2 - 0.035 + pivotStep,
      side * 0.132 + lateralStride,
      0.485 - plantedLift
    ], [0.3, side * 0.27, 0.47]);
    addOperativeLeg(vertices, basis, hip, knee, foot, underSuit, armor, hardware, radial);
  }

  // THE ANTENNA IS A SILHOUETTE FEATURE, SO IT SURVIVES THE RANGE BAND.
  // It used to be gated behind `full` alongside the map screen and the chest
  // ring, which are close-up details — but a mast breaking the shoulder line
  // is the single most identifying thing in this outline, and the outline is
  // all there is past twelve cells. Moved out of the `full` block and
  // thickened 0.012/0.004 -> 0.03/0.016.
  //
  // BE HONEST ABOUT WHAT THAT BUYS. 0.016 presents 0.028 cells to the worst
  // bearing: still an order of magnitude under the 0.15-cell sampler bar, and
  // no antenna that clears that bar is an antenna — it is a flagpole. This is
  // the arc bolt's bargain rather than the street lamp's: the mast is on the
  // state accent, at the pure-emissive ceiling, so on the cells it does hit it
  // hits them at full brightness. It is authored to be intermittent-but-bright
  // at range, and quoted here so nobody re-measures it and files a bug.
  const antennaBase = upperPosed([-0.145, 0.105, -0.24], [0.08, 0.1, 0.31]);
  const antennaTip = upperPosed([-0.15, 0.13, -0.47], [0.23, 0.16, 0.34]);
  addLocalSegment(vertices, basis, antennaBase, antennaTip, 0.03, 0.016, stateAccent, 6);

  if (full) {
    addLocalRing(vertices, basis, upperPosed([0.115, 0, -0.075], [0.13, 0, 0.33]), 0.065, 0.007, stateAccent, 12, 'x');

    if (shieldFlare > 0.05) {
      const flarePulse = 0.23 + Math.abs(Math.sin(motion.timeSeconds * 8 + motion.phase)) * 0.055;
      addLocalRing(vertices, basis, chest, flarePulse, 0.009, visor, 16, 'x');
      addLocalRing(vertices, basis, chest, flarePulse + 0.07, 0.006, warning, 16, 'x');
    }
    if (motion.spawnProgress < 0.98) {
      const scanZ = 0.48 - motion.spawnProgress * 0.96;
      addLocalRing(vertices, basis, [0, 0, scanZ], 0.25, 0.007, visor, 14, 'z');
    }
    if (entity.localInspection) {
      // A thin grounded contact ellipse and restrained suit-edge rails keep the
      // local operative readable against bright ASCII floors without turning
      // the entire armor shell into an emissive silhouette.
      const contactShadow = { ...underSuit, color: [0.003, 0.008, 0.012], emission: 0, roughness: 1 };
      addLocalEllipsoid(vertices, basis, [0, 0, 0.493], [0.21, 0.16, 0.007], contactShadow, 12, 3);
      addLocalSegment(vertices, basis, [-0.08, -0.19, -0.16], [-0.12, -0.13, 0.12], 0.009, 0.006, localRim, 5);
      addLocalSegment(vertices, basis, [-0.08, 0.19, -0.16], [-0.12, 0.13, 0.12], 0.009, 0.006, localRim, 5);
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'neural-operative',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: motion.gait,
    motionSpeed: motion.motionSpeed,
    studioPoseState: studioMotion?.state || null,
    forwardMotion: studioMotion?.forward || 0,
    strafeMotion: studioMotion?.strafe || 0,
    leftFootPlant: studioMotion?.leftPlant || 0,
    rightFootPlant: studioMotion?.rightPlant || 0,
    lean,
    turn: motion.turn,
    crouch,
    guard,
    collapse,
    visorIntensity: pose.visor || 0,
    shieldFlare,
    mapPresented: mapPresentation,
    contactShadow: !!entity.localInspection,
    rimEmphasis: entity.localInspection ? 'restrained-suit-rails' : 'none',
    cameraBodyFade: clamp(entity.cameraBodyFade ?? 1, 0, 1),
    rigTransform: entity.localInspection ? 'parented-pelvis-spine' : 'shared-operative',
    revivePose,
    extractionPose,
    spawnProgress: motion.spawnProgress,
    equipment: Object.freeze(['segmented-armor', 't-link-visor', 'coherence-pack', 'shield-projector'])
  });
}

/* ---------------------------------------------------------------------------
 * corp_guard — the operative in corporate service.
 *
 * The same body as `hider`, doing a job instead of a mission: it borrows the
 * shared arm and leg above and authors everything that says WHO IT IS. Three
 * things carry it at a glance, in this order, and the order is not taste — it
 * is what survives as the figure shrinks:
 *
 *   1. THE LAMP HE CARRIES. A hand floodlight, and the strongest cue by a wide
 *      margin: at any range where a body is four glyphs tall, a lit lens is
 *      still a lit lens. It is also the archetype's FAIRNESS CONTRACT. A guard
 *      whose detection reach exceeds what a player can perceive makes stealth
 *      impossible by construction, and this project has shipped that bug
 *      before — drones that detected at 9 units while their light reached 4.2.
 *      The beam crossing the paving is meant to arrive BEFORE the man does.
 *      Which is why the lamp is authored to the sampler bar (0.156 x 0.164
 *      cells of housing, a 0.156-cell lens) rather than to human proportion:
 *      a fairness tell that strobes out at range is not a tell.
 *   2. A HARD HELMET. Six boxes where hider has a soft ellipsoid — a squared
 *      skull, a comb, a brow peak over the visor band, a jaw block and a
 *      flared nape guard. Corners in the outline are the cheapest way to tell
 *      two humanoids apart in a renderer that only ever hands you an outline.
 *   3. A CORP INSIGNIA PANEL, centred on the chest carrier and lit — a bright
 *      rectangle where a person's badge would be. Centred rather than on a
 *      breast on purpose: a symmetric mark reads as a MARK at range, an
 *      off-centre one reads as noise on the plate.
 *
 * THE SIDEARM IS A BLOCK AND A POSTURE, NOT A GUN, and that is a decision
 * rather than a shortcut. A modelled pistol on a body authored at ~1 renderer
 * cell is about 0.06 cells across — a third of what the sampler can hold on
 * to, so it would be present in the vertex buffer and absent from the screen,
 * which is the worst of both. What survives is the HOLSTER as a bulge on the
 * thigh and the free hand resting on it at post; the hand coming OFF it is a
 * pose change a player can read at twenty cells, and a drawn gun is not.
 *
 * IT IS LIT, NOT EMISSIVE. This is the one place the guard deliberately
 * breaks with the rig it borrows. Every Liminal creature in this file — hider
 * included — authors emission 1 and takes the deferred shader's pure-emissive
 * branch, because Liminal's monsters glow. A guard must not: the whole image
 * the game is buying is a dark city with one moving light in it, and a body
 * that glows on its own has already given that away. So the shell, undersuit
 * and fittings are authored at city-archetype emission (~0.2) and high
 * lightResponse, exactly like street_lamp's mast, and ONLY the lens, the
 * visor, the insignia and the alert strobe carry real glow.
 * ------------------------------------------------------------------------- */

/**
 * WHERE THE GAME HANGS THE LAMP'S LIGHT, in entity-local renderer cells.
 *
 * The mesh draws the lamp; the SCENE LIGHT is the game's, because only the
 * game knows its own light budget. This is the emitter point: the centre of
 * the lens face at the `post` pose, given as `forward` (along the entity's
 * heading), `right` (positive is the lamp hand's side) and `up` (height above
 * the entity's ground contact, the same z convention every archetype here
 * uses). Multiply all three by the registration scale, then:
 *
 *   lightX = guard.x + cos(heading) * forward - sin(heading) * right
 *   lightY = guard.y + sin(heading) * forward + cos(heading) * right
 *   lightZ = guard.z + up
 *
 * ONE OFFSET, NOT THREE, and the poses were authored to make that true rather
 * than the other way round. A lamp whose light jumped when the guard changed
 * state would make the beam ambiguous exactly when it matters most, so
 * `challenge` thrusts the lamp forward and up by a hand's width and no more.
 * `CORP_GUARD_LAMP_DRIFT` is the measured bound on how far the real lens
 * centre ever gets from this point, over every pose, both LODs and a full
 * animation sweep — a test fails if the geometry drifts past it.
 */
export const CORP_GUARD_LAMP_OFFSET = Object.freeze({ forward: 0.448, right: 0.157, up: 0.512 });
/** Cells. See above: the pose-to-pose wander of the real lens centre. */
export const CORP_GUARD_LAMP_DRIFT = 0.13;

export function buildCorpGuardMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return { vertices: new Float32Array(0), vertexCount: 0, lod: ENTITY_LOD.BILLBOARD };
  }

  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const radial = full ? 7 : 5;
  const sphereLong = full ? 10 : 7;
  const sphereLat = full ? 6 : 4;
  const motion = resolveEntityAnimation(entity, 'corp_guard', currentTime, { lod });
  const pose = motion.pose;
  const lampRaise = clamp(pose.lampRaise || 0, 0, 1);
  const lampSweep = clamp(pose.lampSweep || 0, 0, 1);
  const sidearmRest = clamp(pose.sidearmRest || 0, 0, 1);
  const hail = clamp(pose.hail || 0, 0, 1);
  const alertGlow = clamp(pose.alertGlow || 0, 0, 1);
  const stance = clamp(pose.stance ?? 1, 0, 1);

  const shell = resolveMaterial(entity,
    { color: [0.72, 0.74, 0.77], roughness: 0.52, emission: 0.26, lightResponse: 0.62 },
    options, 0.4, 0.5, 'O');
  const underSuit = resolveMaterial(entity,
    { color: [0.16, 0.17, 0.2], roughness: 0.85, emission: 0.18, lightResponse: 0.5 },
    options, 0.6, 0.5, '#');
  const fittings = resolveMaterial(entity,
    { color: [0.24, 0.26, 0.3], roughness: 0.7, emission: 0.2, lightResponse: 0.45 },
    options, 0.5, 0.5, '-');
  // Visor and insignia sit UNDER the accent floor (0.9) on purpose: they are
  // livery, and livery belongs to a registration palette, not to a per-entity
  // blink knob. Same treatment pod_car's cabin glass and the tram's window
  // band get, and for the same reason.
  const visor = resolveMaterial(entity,
    { color: [0.35, 0.72, 0.82], roughness: 0.18, emission: 0.62, lightResponse: 0.12 },
    options, 0.14, 0.5, '=');
  const insignia = resolveMaterial(entity,
    { color: [0.24, 0.62, 0.86], roughness: 0.2, emission: 0.72, lightResponse: 0.1 },
    options, 0.35, 0.5, '+');
  // The lamp's shell gets its OWN hint rather than sharing the fittings', and
  // '^' is the right one to borrow: it already means "hood over a light" on
  // street_lamp. Two reasons it earns a char. A district repainting corp
  // webbing black should not also repaint the floodlight; and a test can then
  // isolate the lamp assembly by material alone, which is how the bar below is
  // actually measured rather than asserted.
  const lampShell = resolveMaterial(entity,
    { color: [0.58, 0.6, 0.63], roughness: 0.45, emission: 0.24, lightResponse: 0.55 },
    options, 0.32, 0.5, '^');
  // The two that ARE at the emissive ceiling, so per-entity `accent` reaches
  // both. A game wanting them tinted independently uses a registration palette
  // (or dims one below the 0.9 floor there, which opts it out of accent).
  const lens = dimGlow(resolveMaterial(entity,
    { color: [1, 0.95, 0.82], roughness: 0.12, emission: 1, lightResponse: 0 },
    options, 0.3, 0.5, '☼'), clamp(pose.lampGlow ?? 1, 0, 1));
  const alert = dimGlow(resolveMaterial(entity,
    { color: [1, 0.24, 0.14], roughness: 0.3, emission: 1, lightResponse: 0 },
    options, 0.2, 0.5, '!'), 0.16 + alertGlow * 0.84);

  const bob = motion.bob + motion.breath;
  const lean = motion.lean;
  const sway = motion.sway * 0.3;
  // No collapse, no crouch, no studio rig: a guard stands, walks and squares
  // up, and nothing else. One placement closure instead of hider's four.
  const place = point => [point[0] + lean, point[1] + sway, point[2] + bob];

  const chest = place([-0.02, 0, -0.08]);
  const pelvis = place([-0.03, 0, 0.12]);

  // Body under the kit: graphite undersuit, then the plate that squares it.
  addLocalEllipsoid(vertices, basis, pelvis, [0.088, 0.132, 0.112], underSuit, sphereLong, sphereLat);
  addLocalEllipsoid(vertices, basis, chest, [0.105, 0.175, 0.2], underSuit, sphereLong, sphereLat);
  // THE CARRIER IS THE SILHOUETTE. A rounded torso reads as "humanoid"; a
  // squared one reads as "wearing a vest", and that is the whole difference
  // between this figure and the player's at the range where both are outlines.
  addLocalBox(vertices, basis, place([0.015, 0, -0.075]), [0.088, 0.168, 0.155], shell);
  addLocalBox(vertices, basis, place([-0.01, 0, -0.185]), [0.075, 0.2, 0.032], shell);
  addLocalBox(vertices, basis, place([0, 0, 0.1]), [0.082, 0.142, 0.032], fittings);
  addLocalBox(vertices, basis, place([0.112, 0, -0.128]), [0.014, 0.062, 0.052], insignia);
  // Comms block on the upper back, offset off the spine — it is what hider's
  // coherence pack is not, so the two bodies differ from behind as well.
  addLocalBox(vertices, basis, place([-0.128, -0.055, -0.145]), [0.05, 0.06, 0.07], fittings);
  addLocalBox(vertices, basis, place([-0.005, 0, -0.235]), [0.058, 0.072, 0.045], fittings);

  // The hard helmet. Six boxes, and the nape guard at the back is the one
  // doing the most work: a helmet that flares behind the ears is legible from
  // every bearing except dead front, which is the bearing you get last.
  const head = place([0.015, 0, -0.358]);
  addLocalBox(vertices, basis, head, [0.112, 0.118, 0.108], shell);
  addLocalBox(vertices, basis, place([0.005, 0, -0.462]), [0.095, 0.05, 0.028], fittings);
  addLocalBox(vertices, basis, place([0.108, 0, -0.4]), [0.03, 0.108, 0.03], shell);
  addLocalBox(vertices, basis, place([0.118, 0, -0.35]), [0.026, 0.106, 0.045], visor);
  addLocalBox(vertices, basis, place([0.088, 0, -0.276]), [0.055, 0.088, 0.04], fittings);
  addLocalBox(vertices, basis, place([-0.098, 0, -0.308]), [0.05, 0.098, 0.062], shell);

  // Shoulder strobes. Small and deliberately so — they are carried by
  // BRIGHTNESS, not by size, the same bargain the antenna makes on hider.
  // `alertGlow` never reaches 0: a guard's radio pip is on all night, and the
  // difference a player must read is dim-pip to blazing, not off to on.
  for (const side of [-1, 1]) {
    addLocalBox(vertices, basis, place([-0.02, side * 0.185, -0.202]), [0.035, 0.036, 0.02], alert);
  }

  // THE ARMS. Both are computed as blends between named work postures, which
  // is the whole reason the shared rig's arms were rebuilt: everything this
  // archetype means happens between the shoulder and the hand.
  const swing = Math.sin(motion.gait) * (pose.armSwing || 0);
  const sweep = Math.sin(motion.gait * 0.5 + motion.phase) * lampSweep;

  // Lamp hand (+1). Low-ready across the body at post, swinging the beam
  // across the paving on patrol, thrust forward and up when challenging.
  const lampElbow = mix3(
    [0.1 + swing * 0.4, 0.2 + sweep * 0.045, 0.03],
    [0.12, 0.175, -0.03],
    lampRaise);
  const lampHand = mix3(
    [0.245 + swing * 0.5, 0.175 + sweep * 0.06, 0.03],
    [0.26, 0.15, -0.045],
    lampRaise);
  const lampShoulder = place([0, 0.205, -0.145]);
  addOperativeArm(vertices, basis, lampShoulder, place(lampElbow), place(lampHand), underSuit, shell, radial);

  // Free hand (-1). Resting on the holster at post, swinging on patrol, and
  // up palm-out in the hail — the STOP hand, which is what "challenge" means
  // before anybody has said a word.
  const restElbow = [0.045, -0.215, 0.06];
  const restHand = [0.075, -0.16, 0.15];
  const swingElbow = [-swing * 0.9, -0.255, 0.07];
  const swingHand = [-swing * 1.1 + 0.035, -0.245, 0.29];
  let freeElbow = mix3(swingElbow, restElbow, sidearmRest);
  let freeHand = mix3(swingHand, restHand, sidearmRest);
  freeElbow = mix3(freeElbow, [0.16, -0.185, -0.06], hail);
  freeHand = mix3(freeHand, [0.315, -0.115, -0.19], hail);
  addOperativeArm(vertices, basis, place([0, -0.205, -0.145]), place(freeElbow), place(freeHand), underSuit, shell, radial);

  // The holster: a block on the free-hand thigh, present in every pose. It is
  // what the hand rests ON at post, so the posture has something to mean.
  addLocalBox(vertices, basis, place([0.02, -0.145, 0.2]), [0.048, 0.05, 0.085], fittings);
  addLocalBox(vertices, basis, place([0.05, -0.145, 0.128]), [0.03, 0.032, 0.038], shell);

  // THE LAMP — battery block in the hand, housing in front of it, a shroud
  // proud of the housing and the lens bulging out of that. It is the street
  // lamp's own head shrunk to a hand and held to the same sampler bar, and
  // every part of it is authored to the bar rather than to human proportion:
  // 0.152 x 0.156 cells at the battery, 0.156 x 0.164 at the housing, and a
  // shroud kept INSIDE the housing's vertical extent so no horizontal slice
  // through the assembly ever contains the shroud plate alone. That is what a
  // fairness tell has to be. A lamp sized like a real torch would be about
  // 0.07 cells and would strobe out at exactly the range where seeing the
  // beam first is the whole point.
  //
  // There is deliberately NO yoke between hand and housing: the masses
  // overlap, because a 0.06-cell connector is the one part that would vanish
  // and leave a floodlight floating beside a fist.
  const lampCentre = [lampHand[0] + 0.105, lampHand[1] - 0.01, lampHand[2] - 0.045];
  addLocalBox(vertices, basis, place([lampHand[0] + 0.012, lampHand[1], lampHand[2] + 0.03]), [0.076, 0.078, 0.082], lampShell);
  addLocalBox(vertices, basis, place(lampCentre), [0.078, 0.082, 0.085], lampShell);
  addLocalBox(vertices, basis, place([lampCentre[0] + 0.072, lampCentre[1], lampCentre[2]]), [0.032, 0.098, 0.08], lampShell);
  addLocalEllipsoid(vertices, basis,
    place([lampCentre[0] + 0.098, lampCentre[1], lampCentre[2]]),
    [0.04, 0.078, 0.076], lens, sphereLong, sphereLat);

  // Legs. `stance` widens the track: a guard AT POST plants wide and a walking
  // one narrows, which is the difference between a man standing somewhere and
  // a man going somewhere, read entirely off the bottom third of the outline.
  // THE FEET DO NOT BREATHE, and this is the one place the guard's rig fixes
  // something rather than inheriting it. Every bob and breath term on this
  // body is a single vertical offset applied to EVERY joint, which means a
  // standing figure sinks its boots into the pavement once a breath and lifts
  // them out again — invisible at Liminal's interior scale and not invisible
  // on a swept forecourt with a light raking across it. So the offset is bled
  // down the leg: full at the hip, most of it at the knee, a quarter at the
  // sole. What is left reads as weight shifting, which is what it should have
  // been all along, and the boot's underside stays on its own ground-contact
  // plane in every pose (pinned by test).
  const stride = motion.stride;
  const track = 0.118 + stance * 0.036;
  const settleAt = (point, share) => [
    point[0] + lean * (0.35 + share * 0.65),
    point[1] + sway * (0.4 + share * 0.6),
    point[2] + bob * share
  ];
  for (const side of [-1, 1]) {
    const sideStride = side < 0 ? stride : -stride;
    const hip = settleAt([-0.015, side * (track * 0.72), 0.15], 1);
    const knee = settleAt([
      sideStride * 0.72,
      side * (track * 0.85),
      0.335 - Math.max(0, sideStride) * 0.2
    ], 0.6);
    const foot = settleAt([sideStride * 1.2 - 0.035, side * track, 0.478], 0.25);
    addOperativeLeg(vertices, basis, hip, knee, foot, underSuit, shell, fittings, radial);
  }

  return finishMesh(vertices, lod, {
    archetype: 'corp-security-operative',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: motion.gait,
    motionSpeed: motion.motionSpeed,
    lean,
    turn: motion.turn,
    lampRaise,
    lampSweep,
    sidearmRest,
    hail,
    alertGlow,
    stance,
    rigTransform: 'shared-operative',
    spawnProgress: motion.spawnProgress,
    equipment: Object.freeze(['hand-floodlight', 'hard-helmet', 'corp-insignia', 'hip-holster'])
  });
}

export function buildBansheeMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'banshee', currentTime, { lod });
  const pose = motion.pose;
  const membraneSpread = clamp(pose.membraneSpread || 0.12, 0, 1);
  const throatOpen = clamp(pose.throatOpen || 0.04, 0, 1);
  const resonance = clamp(pose.resonance || 0.08, 0, 1);
  const shudder = clamp(pose.shudder || 0.03, 0, 1);
  const radial = full ? 8 : 6;
  const lean = motion.lean;
  const float = -0.035 + Math.sin(motion.timeSeconds * 1.55 + motion.phase) * 0.018 + motion.bob;
  const tremor = Math.sin(motion.timeSeconds * 23 + motion.phase) * 0.018 * shudder;

  const shell = resolveMaterial(entity, MATERIALS.banshee, options, 0.44, 0.5, 'â–ˆ');
  const veil = {
    ...shell,
    color: mix3(shell.color, [0.03, 0.34, 0.46], 0.58),
    roughness: 0.42,
    emission: 0.78,
    lightResponse: 0.04
  };
  const rib = {
    ...shell,
    color: mix3(shell.color, [0.82, 0.98, 1], 0.34),
    emission: 0.94,
    lightResponse: 0.01
  };
  const voidMaterial = { ...MATERIALS.darkSteel, color: [0.005, 0.018, 0.025], roughness: 0.96, emission: 0.08, lightResponse: 0.1 };
  const core = resolveMaterial(entity, MATERIALS.white, options, 0.31, 0.5, 'â—†');
  const warning = { ...MATERIALS.magenta, color: [1, 0.035, 0.28], emission: 1, lightResponse: 0 };

  // The Banshee is a resonant veil wrapped around an empty acoustic chamber,
  // not another humanoid. Its forward-facing hood and throat are the only
  // stable anatomical landmarks.
  addLocalEllipsoid(vertices, basis, [lean * 0.32, tremor, -0.08 + float], [0.17, 0.17, 0.25], veil, full ? 11 : 8, full ? 7 : 5);
  addLocalEllipsoid(vertices, basis, [0.055 + lean * 0.55, tremor, -0.24 + float], [0.14, 0.135, 0.15], shell, full ? 10 : 7, full ? 6 : 4);
  addLocalEllipsoid(vertices, basis, [0.15 + lean * 0.72, tremor, -0.235 + float], [0.056, 0.078, 0.09], voidMaterial, radial, 5);

  const throatLength = 0.065 + throatOpen * 0.09;
  const throatRadius = 0.025 + throatOpen * 0.045;
  const throatCenterX = 0.16 + lean * 0.7;
  const coreRadiusX = 0.018 + throatOpen * 0.022;
  const coreCenterX = throatCenterX + throatLength - coreRadiusX * 0.55;
  const throatAttachmentDepth = throatCenterX + throatLength - (coreCenterX - coreRadiusX);
  addLocalEllipsoid(vertices, basis, [throatCenterX, tremor, -0.045 + float], [throatLength, throatRadius, 0.045 + throatOpen * 0.055], voidMaterial, radial, 5);
  addLocalEllipsoid(vertices, basis, [coreCenterX, tremor, -0.045 + float], [coreRadiusX, throatRadius * 0.72, 0.028 + throatOpen * 0.04], throatOpen > 0.3 ? warning : core, radial, 4);

  // Twin membranes stay folded around the chamber until the flashlight makes
  // the creature unfurl. Closely spaced ribs give the wings readable volume
  // without turning them into conventional feathered anatomy.
  const wingSpan = 0.19 + membraneSpread * 0.36;
  const wingLift = 0.04 + membraneSpread * 0.2;
  const wingBack = 0.12 + membraneSpread * 0.13;
  for (const side of [-1, 1]) {
    const shoulder = [0.005 + lean * 0.28, side * 0.12, -0.16 + float];
    const crownTip = [-wingBack, side * wingSpan, -0.2 - wingLift + float + tremor * side];
    const middleTip = [-wingBack * 0.75, side * (wingSpan + 0.025), -0.02 + float];
    const lowerTip = [-wingBack * 0.5, side * (wingSpan * 0.78), 0.25 - membraneSpread * 0.08 + float];
    addJointedLimb(vertices, basis, [shoulder, crownTip, middleTip, lowerTip], [0.034, 0.024, 0.018, 0.008], rib, radial);

    const ribCount = full ? 6 : 3;
    for (let index = 0; index < ribCount; index++) {
      const amount = (index + 1) / (ribCount + 1);
      const edgeY = side * (wingSpan * (0.78 + amount * 0.22));
      const edgeZ = -0.2 - wingLift + amount * (0.46 + wingLift);
      const rootZ = -0.2 + amount * 0.39;
      const ripple = Math.sin(motion.timeSeconds * (2.1 + resonance * 3.4) + motion.phase + index * 0.9) * 0.018 * resonance;
      addLocalSegment(vertices, basis,
        [0.015 + lean * 0.3, side * (0.105 + amount * 0.025), rootZ + float],
        [-wingBack * (0.9 - amount * 0.25), edgeY + ripple, edgeZ + float],
        0.016, 0.005, index % 2 === 0 ? shell : veil, radial);
    }
  }

  // Long weightless ribbons replace legs and keep the silhouette visibly
  // supernatural even when its membranes are folded.
  const ribbonCount = full ? 7 : 4;
  for (let index = 0; index < ribbonCount; index++) {
    const normalized = ribbonCount === 1 ? 0 : index / (ribbonCount - 1);
    const side = (normalized - 0.5) * 0.3;
    const wave = Math.sin(motion.timeSeconds * 2.2 + motion.phase + index * 0.85) * (0.025 + resonance * 0.025);
    addJointedLimb(vertices, basis, [
      [-0.025, side * 0.62, 0.09 + float],
      [-0.09 + wave, side + motion.secondary * 0.012, 0.28 + float],
      [-0.14 - wave * 0.6, side * 1.22, 0.46]
    ], [0.026, 0.014, 0.003], index % 2 === 0 ? veil : shell, radial);
  }

  // Resonance rings appear as a readable warning tell before pursuit. They are
  // intentionally sparse in the docile state so the dormant core stays subtle.
  const ringCount = full ? Math.ceil(resonance * 4) : Math.ceil(resonance * 2);
  for (let index = 0; index < ringCount; index++) {
    const pulse = 0.5 + 0.5 * Math.sin(motion.timeSeconds * 7.5 + motion.phase + index * 1.7);
    const radius = 0.09 + index * 0.055 + pulse * 0.018 * resonance;
    const ringMaterial = resonance > 0.55 && index === ringCount - 1 ? warning : core;
    addLocalRing(vertices, basis, [-0.04 - index * 0.006 + lean * 0.25, tremor, -0.045 + float], radius, 0.006 + resonance * 0.004, ringMaterial, full ? 14 : 9, 'x');
  }

  return finishMesh(vertices, lod, {
    archetype: 'banshee',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    gait: motion.gait,
    lean,
    turn: motion.turn,
    membraneSpread,
    throatOpen,
    throatAttachmentDepth,
    resonance,
    shudder,
    anatomy: 'resonant-veil-entity'
  });
}

export function buildHunterMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'hunter', currentTime, { lod });
  const pose = motion.pose;
  const suspension = clamp(pose.suspension || 0.35, 0, 1);
  const clampOpen = clamp(pose.clampOpen || 0.12, 0, 1);
  const sensorSweep = clamp(pose.sensorSweep || 0.72, 0, 1);
  // S-DRN-02 contains rather than kills: the clamps close and the suspension
  // frame takes the load. In play those are ambient tics worth ~0.02 units. A
  // containment finisher IS that mechanism, so it gets the full travel.
  const stage = motion.finisherStage || 0;
  const hover = Math.sin(motion.timeSeconds * 3.1 + motion.phase) * 0.012 - 0.035
    - suspension * (0.018 + stage * 0.15);
  const radial = full ? 7 : 5;
  const body = resolveMaterial(entity, MATERIALS.steel, options, 0.55);
  // These three historically bypassed the resolver entirely — which on a
  // registration palette left the piston legs, rear hull and clamps unstyled
  // no matter what chars the palette carried. They resolve paletteOnly: a
  // facade palette reaches them through the '▓'/'▒'/'!' hints below, while
  // the renderer's sprite-template resolver (Liminal's recolor path) still
  // never touches them, and a palette without these chars changes nothing.
  const dark = resolveMaterial(entity, MATERIALS.darkSteel, options, 0.62, 0.5, '▓', true);
  const mechanism = resolveMaterial(entity,
    { ...MATERIALS.darkSteel, color: [0.09, 0.28, 0.27], emission: 0.78, lightResponse: 0.24 },
    options, 0.7, 0.5, '▒', true);
  const eye = resolveMaterial(entity, MATERIALS.amber, options, 0.13, 0.5, '☼');
  const hazard = resolveMaterial(entity,
    { ...MATERIALS.warning, color: [0.85, 0.12, 0.025], emission: 0.86, lightResponse: 0.12 },
    options, 0.14, 0.5, '!', true);
  const lean = motion.lean;
  const scanOffset = Math.sin(motion.timeSeconds * (1.8 + sensorSweep * 2.4) + motion.phase) * 0.1 * sensorSweep;
  const stabilizerSpan = 0.53 - clampOpen * 0.13;

  // S-DRN industrial stalker chassis: armored central hull, recessed machinery,
  // an independently scanning optic, and a capture assembly that opens in chase.
  addLocalEllipsoid(vertices, basis, [lean * 0.35, 0, -0.07 + hover], [0.245, 0.29, 0.145], body, full ? 12 : 8, full ? 6 : 4);
  addLocalBox(vertices, basis, [-0.04, 0, 0.055 + hover], [0.17, 0.19, 0.055], mechanism);
  addLocalEllipsoid(vertices, basis, [-0.17, 0, -0.075 + hover], [0.115, 0.205, 0.105], dark, full ? 9 : 7, full ? 5 : 4);
  addLocalBox(vertices, basis, [0.19 + lean * 0.6, 0, -0.095 + hover], [0.055, 0.205, 0.062], dark);

  // Sensor turret and scanning amber slit.
  addLocalRing(vertices, basis, [0.245 + lean * 0.7, 0, -0.105 + hover], 0.13, 0.016, body, full ? 14 : 9, 'x');
  addLocalBox(vertices, basis, [0.265 + lean * 0.72, scanOffset, -0.105 + hover], [0.022, 0.055, 0.027], eye);
  addLocalSegment(vertices, basis,
    [-0.08, 0, -0.18 + hover],
    [-0.17, scanOffset * 0.35, -0.285 + hover],
    0.027, 0.008, eye, 6);

  for (const side of [-1, 1]) {
    // Lateral stabilizer/antenna assemblies tuck inward during pursuit.
    const stabilizerY = side * stabilizerSpan;
    addJointedLimb(vertices, basis, [
      [-0.015, side * 0.245, -0.085 + hover],
      [-0.02, side * 0.37, -0.14 + motion.secondary * side * 0.015],
      [-0.095, stabilizerY, -0.075 - motion.secondary * side * 0.012]
    ], [0.052, 0.031, 0.013], body, radial);
    addLocalRing(vertices, basis, [-0.09, stabilizerY, -0.065 + hover], 0.085, 0.012, eye, full ? 11 : 7, 'z');

    // Forward capture clamps spread around the target-facing sensor.
    //
    // In gameplay a "closed" clamp still sits 0.12 out from the centreline, so
    // the assembly gestures but never grips. Under a finisher the closed pose
    // converges on the axis and reaches further forward, because closing on the
    // operative is the entire kill.
    const clampClosedMid = 0.2 - stage * 0.13;
    const clampClosedTip = 0.12 - stage * 0.1;
    const clampMid = clampClosedMid + (0.29 - clampClosedMid) * clampOpen;
    const clampTip = clampClosedTip + (0.3 - clampClosedTip) * clampOpen;
    const clampReach = stage * (1 - clampOpen) * 0.13;
    addJointedLimb(vertices, basis, [
      [0.13 + lean * 0.5, side * 0.17, -0.06 + hover],
      [0.23 + lean * 0.7 + clampReach * 0.5, side * clampMid, 0.015 + hover],
      [0.31 + lean + clampReach, side * clampTip, 0.09 + hover]
    ], [0.042, 0.027, 0.009], hazard, radial);

    // Four piston legs keep the machine grounded instead of floating like a ship.
    for (const fore of [-1, 1]) {
      const stride = motion.stride * fore;
      const hipX = fore * 0.12 - 0.035;
      const kneeX = hipX + stride + (fore > 0 ? 0.08 : -0.05);
      const footX = hipX + stride * 1.35 + (fore > 0 ? 0.13 : -0.1);
      const footY = side * (0.24 + suspension * 0.045);
      addJointedLimb(vertices, basis, [
        [hipX, side * 0.17, 0.015 + hover],
        [kneeX, side * (0.235 + suspension * 0.055), 0.24 - Math.abs(stride) * 0.18],
        [footX, footY, 0.472]
      ], [0.038, 0.026, 0.011], mechanism, radial);
      addLocalEllipsoid(vertices, basis, [footX + 0.035, footY, 0.472], [0.055, 0.024, 0.01], body, 7, 4);
    }
  }

  if (full) {
    for (let vent = -1; vent <= 1; vent++) {
      addLocalBox(vertices, basis, [-0.255, vent * 0.07, -0.065 + hover], [0.018, 0.022, 0.035], vent === 0 ? hazard : dark);
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'hunter',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    hover,
    gait: motion.stride,
    lean,
    turn: motion.turn,
    sensorSweep,
    clampOpen,
    suspension,
    chassis: 'industrial-stalker-drone'
  });
}

export function buildSpecterMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'specter', currentTime, { lod });
  const pose = motion.pose;
  const cohesion = clamp(pose.cohesion || 0.58, 0, 1);
  const aperture = clamp(pose.aperture || 0.34, 0, 1);
  const orbitRate = Math.max(0, pose.orbitRate || 0.75);
  const trailSpread = clamp(pose.trailSpread || 0.42, 0, 1);
  const phaseBurst = clamp(pose.phaseBurst || 0.08, 0, 1);
  const radial = full ? 7 : 5;
  const hover = -0.055 + Math.sin(motion.timeSeconds * 2.1 + motion.phase) * (0.018 + phaseBurst * 0.025) + motion.bob;
  const lean = motion.lean;
  const orbit = motion.timeSeconds * orbitRate + motion.phase;
  const scatter = (1 - cohesion) * 0.2 + phaseBurst * 0.16;

  const phase = resolveMaterial(entity, MATERIALS.spectral, options, 0.52);
  const deepPhase = { ...phase, color: mix3(phase.color, [0.025, 0.01, 0.09], 0.56), roughness: 0.36, emission: 0.72, lightResponse: 0.02 };
  const edge = { ...phase, color: mix3(phase.color, [0.68, 0.2, 1], 0.3), roughness: 0.16, emission: 1, lightResponse: 0 };
  const voidMaterial = { ...MATERIALS.darkSteel, color: [0.004, 0.002, 0.014], roughness: 0.98, emission: 0.05, lightResponse: 0.08 };
  const flare = phaseBurst > 0.5 ? MATERIALS.cyan : MATERIALS.white;

  // A hollow phase aperture is the Specter's only stable feature. Everything
  // else is an orbiting shard cage that locks into a spear-form in darkness.
  const chamberZ = -0.12 + hover;
  addLocalEllipsoid(vertices, basis, [lean * 0.35, 0, chamberZ], [0.125, 0.135, 0.155], deepPhase, full ? 10 : 7, full ? 6 : 4);
  addLocalEllipsoid(vertices, basis, [0.09 + lean * 0.58, 0, chamberZ], [0.07, 0.088, 0.105], voidMaterial, radial, 5);
  addLocalEllipsoid(vertices, basis, [0.164 + lean * 0.7, 0, chamberZ], [0.018, 0.025 + aperture * 0.05, 0.018 + aperture * 0.035], flare, radial, 4);

  const shardCount = full ? 10 : 6;
  for (let index = 0; index < shardCount; index++) {
    const angle = orbit * (index % 2 === 0 ? 0.42 : -0.32) + index / shardCount * Math.PI * 2;
    const baseRadius = 0.15 + (index % 3) * 0.012;
    const burstWave = 0.55 + 0.45 * Math.sin(orbit * 1.7 + index * 1.31);
    const radius = baseRadius + scatter * burstWave * 0.32;
    const centerY = Math.cos(angle) * radius;
    const centerZ = chamberZ + Math.sin(angle) * (radius * 0.78);
    const centerX = -0.025 + Math.sin(angle * 2) * 0.04 - phaseBurst * 0.08 * burstWave;
    const tangentY = -Math.sin(angle) * (0.045 + aperture * 0.025);
    const tangentZ = Math.cos(angle) * (0.04 + aperture * 0.025);
    addLocalSegment(vertices, basis,
      [centerX + lean * 0.18 - tangentZ * 0.35, centerY - tangentY, centerZ - tangentZ],
      [centerX + lean * 0.18 + tangentZ * 0.35, centerY + tangentY, centerZ + tangentZ],
      0.018 - phaseBurst * 0.006, 0.004, index % 3 === 0 ? edge : phase, radial);
  }

  // Broken lateral vanes fold close during a stalk and flare outward when the
  // flashlight breaks the local phase lock.
  for (const side of [-1, 1]) {
    const vaneSpan = 0.17 + trailSpread * 0.19;
    const vibration = Math.sin(orbit * 1.4 + side * 1.2) * 0.025 * (0.3 + phaseBurst);
    addJointedLimb(vertices, basis, [
      [-0.035 + lean * 0.25, side * 0.11, chamberZ + 0.035],
      [-0.12 + vibration, side * vaneSpan, chamberZ + 0.12 - cohesion * 0.055],
      [-0.18 - phaseBurst * 0.1, side * (vaneSpan + 0.08 + scatter), 0.14 + hover]
    ], [0.035, 0.018, 0.003], edge, radial);
    addLocalSegment(vertices, basis,
      [-0.02, side * 0.12, chamberZ - 0.055],
      [-0.12 - scatter * 0.35, side * (0.2 + trailSpread * 0.12), -0.35 + hover - phaseBurst * 0.02],
      0.022, 0.004, phase, radial);
  }

  // A segmented spine and three phase wakes replace a torso and legs.
  const spineSegments = full ? 5 : 3;
  for (let index = 0; index < spineSegments; index++) {
    const amount = index / Math.max(1, spineSegments - 1);
    const z = 0.005 + amount * 0.31 + hover;
    const wobble = Math.sin(orbit * 0.8 + index * 1.4) * (0.018 + scatter * 0.12);
    addLocalEllipsoid(vertices, basis,
      [-0.035 - amount * 0.08 + lean * (0.3 + amount * 0.4), wobble, z],
      [0.06 - amount * 0.025, 0.105 - amount * 0.05, 0.07 - amount * 0.025],
      index % 2 === 0 ? deepPhase : phase, radial, 4);
  }
  for (const lane of [-1, 0, 1]) {
    const laneSpread = lane * (0.055 + trailSpread * 0.09 + scatter * 0.25);
    const curl = Math.sin(orbit * 0.65 + lane * 1.8) * (0.025 + trailSpread * 0.04);
    addJointedLimb(vertices, basis, [
      [-0.08, lane * 0.045, 0.22 + hover],
      [-0.14 + curl, laneSpread, 0.34 + hover],
      [-0.2 - scatter * 0.25, laneSpread * 1.35 + curl, 0.47]
    ], [0.022, 0.011, 0.0025], lane === 0 ? edge : phase, radial);
  }

  if (full && (aperture > 0.5 || phaseBurst > 0.4)) {
    const rayCount = phaseBurst > 0.5 ? 8 : 4;
    for (let index = 0; index < rayCount; index++) {
      const angle = orbit * 0.6 + index / rayCount * Math.PI * 2;
      const inner = 0.12 + aperture * 0.04;
      const outer = inner + 0.07 + phaseBurst * 0.06;
      addLocalSegment(vertices, basis,
        [-0.055, Math.cos(angle) * inner, chamberZ + Math.sin(angle) * inner],
        [-0.1 - phaseBurst * 0.08, Math.cos(angle) * outer, chamberZ + Math.sin(angle) * outer],
        0.008, 0.002, flare, 5);
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'specter',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    hover,
    gait: motion.gait,
    lean,
    turn: motion.turn,
    cohesion,
    aperture,
    orbitRate,
    trailSpread,
    phaseBurst,
    anatomy: 'fragmented-phase-lattice'
  });
}

function buildNodeMesh(entity, currentTime, lod, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'node', currentTime, { lod });
  const pulse = motion.pulse;
  const lift = motion.pose.lift || 0;
  const ringRadius = 0.24 + (motion.pose.ringExpansion || 0);
  const signalBase = entity.active ? MATERIALS.green : MATERIALS.amber;
  const signalMaterial = resolveMaterial(entity, signalBase, options, entity.active ? 0.25 : 0.5);
  const signal = { ...signalMaterial, color: signalMaterial.color.map(value => clamp(value * pulse, 0, 1)) };
  const headZ = -0.26 + NODE_ASSEMBLY_LOWERING + lift;
  const ringZ = -0.25 + NODE_ASSEMBLY_LOWERING + lift;
  addLocalEllipsoid(vertices, basis, [0, 0, headZ], [0.16, 0.16, 0.13], signal, full ? 10 : 7, full ? 6 : 4);
  addLocalRing(vertices, basis, [0, 0, ringZ], ringRadius, 0.018, signal, full ? 14 : 8, 'z');
  if (full) {
    addLocalRing(vertices, basis, [0, 0, ringZ], 0.2 + (motion.pose.ringExpansion || 0) * 0.5, 0.012, signal, 12, 'x');
    const orbit = motion.timeSeconds * (motion.pose.orbitRate || 0.5) + motion.phase;
    for (const offset of [0, Math.PI]) {
      const angle = orbit + offset;
      addLocalEllipsoid(vertices, basis, [
        Math.cos(angle) * ringRadius,
        Math.sin(angle) * ringRadius,
        ringZ + Math.sin(angle * 2) * 0.045
      ], [0.025, 0.025, 0.025], signal, 7, 4);
    }
  }
  return finishMesh(vertices, lod, {
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    pulse,
    lift,
    orbitRate: motion.pose.orbitRate || 0
  });
}

function buildCollectibleMesh(entity, currentTime, lod, type, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const phase = seededPhase(entity);
  const coreMotion = type === 'data_core' ? resolveEntityAnimation(entity, 'data_core', currentTime, { lod }) : null;
  const hover = coreMotion
    ? Math.sin(coreMotion.timeSeconds * coreMotion.pose.hoverRate + coreMotion.phase) * coreMotion.pose.hoverDepth + 0.12
    : Math.sin(currentTime * 0.003 + phase) * 0.045 + 0.12;
  const spin = coreMotion
    ? coreMotion.timeSeconds * coreMotion.pose.spinRate + coreMotion.phase
    : currentTime * 0.0014 + phase;
  const originalForward = basis.forward;
  const originalRight = basis.right;
  basis.forward = [Math.cos(spin), Math.sin(spin), 0];
  basis.right = [-Math.sin(spin), Math.cos(spin), 0];
  let glowBase = MATERIALS.cyan;
  if (type === 'classified_record') glowBase = MATERIALS.magenta;
  if (type === 'decoy') glowBase = MATERIALS.white;
  if (type === 'psy_shield_booster') glowBase = MATERIALS.violet;
  const resolvedGlow = resolveMaterial(entity, glowBase, options, 0.45);
  const glow = coreMotion
    ? { ...resolvedGlow, color: resolvedGlow.color.map(channel => clamp(channel * coreMotion.pulse, 0, 1)) }
    : resolvedGlow;
  const frame = MATERIALS.darkSteel;

  if (type === 'classified_record') {
    addLocalBox(vertices, basis, [0, 0, hover], [0.08, 0.18, 0.23], frame);
    addLocalBox(vertices, basis, [0.085, 0, hover], [0.018, 0.13, 0.16], glow);
    addLocalEllipsoid(vertices, basis, [0, 0, hover], [0.1, 0.12, 0.17], glow, full ? 9 : 7, full ? 5 : 4);
    addLocalRing(vertices, basis, [0.11, 0, hover], 0.08, 0.012, glow, full ? 10 : 7, 'x');
    addLocalRing(vertices, basis, [0, 0, hover], 0.27, 0.012, glow, full ? 14 : 8, 'x');
    addLocalRing(vertices, basis, [0, 0, hover], 0.24, 0.01, glow, full ? 12 : 7, 'y');
  } else if (type === 'decoy') {
    addLocalEllipsoid(vertices, basis, [0, 0, hover + 0.03], [0.12, 0.12, 0.14], glow, full ? 10 : 7, full ? 6 : 4);
    for (const side of [-1, 0, 1]) {
      addLocalSegment(vertices, basis, [0, side * 0.06, hover + 0.1], [-0.15, side * 0.22, 0.5], 0.025, 0.012, frame, 5);
    }
    addLocalSegment(vertices, basis, [0, 0, hover - 0.1], [0, 0, hover - 0.32], 0.02, 0.008, glow, 5);
  } else if (type === 'data_core') {
    const counterSpin = -spin * 1.35;
    const counterBasis = {
      ...basis,
      forward: [Math.cos(counterSpin), Math.sin(counterSpin), 0],
      right: [-Math.sin(counterSpin), Math.cos(counterSpin), 0]
    };
    const orbitRadius = coreMotion.pose.orbitRadius || 0.23;
    addLocalEllipsoid(vertices, basis, [0, 0, hover], [0.13, 0.13, 0.16], glow, full ? 10 : 7, full ? 6 : 4);
    addLocalBox(vertices, basis, [0, 0, hover], [0.055, 0.055, 0.1], MATERIALS.darkSteel);
    addLocalRing(vertices, basis, [0, 0, hover], 0.22, 0.015, glow, full ? 14 : 8, 'z');
    addLocalRing(vertices, counterBasis, [0, 0, hover], 0.19, 0.012, glow, full ? 12 : 7, 'y');
    if (full) {
      const orbit = coreMotion.timeSeconds * coreMotion.pose.spinRate * 0.72 + coreMotion.phase;
      for (let index = 0; index < 3; index++) {
        const angle = orbit + (index / 3) * Math.PI * 2;
        addLocalEllipsoid(vertices, counterBasis, [
          Math.cos(angle) * orbitRadius,
          Math.sin(angle) * orbitRadius,
          hover + Math.sin(angle * 2) * 0.08
        ], [0.028, 0.028, 0.028], glow, 7, 4);
      }
    }
  } else {
    addLocalEllipsoid(vertices, basis, [0, 0, hover], [0.13, 0.13, 0.16], glow, full ? 10 : 7, full ? 6 : 4);
    addLocalRing(vertices, basis, [0, 0, hover], 0.22, 0.015, glow, full ? 14 : 8, 'z');
    addLocalRing(vertices, basis, [0, 0, hover], 0.19, 0.012, glow, full ? 12 : 7, 'y');
    if (type === 'psy_shield_booster' && full) addLocalRing(vertices, basis, [0, 0, hover], 0.18, 0.01, glow, 12, 'x');
  }
  basis.forward = originalForward;
  basis.right = originalRight;
  return finishMesh(vertices, lod, {
    hover,
    spin,
    state: coreMotion ? coreMotion.state : entity.state,
    previousState: coreMotion ? coreMotion.previousState : entity.state,
    transition: coreMotion ? coreMotion.transition : 1,
    pulse: coreMotion ? coreMotion.pulse : 1
  });
}

export function buildDataCoreMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  return buildCollectibleMesh(entity, currentTime, lod, 'data_core', options);
}

/**
 * City vehicle/prop archetypes (added for Beyond Dawn; Liminal never
 * registers them, so unlike the ported creatures EVERY material below routes
 * through resolveMaterial with a documented hint char from day one — a
 * registration palette can restyle any part, and the authored defaults are
 * tuned to read unassisted at night. The hint chars reuse the established
 * vocabulary where the meaning matches ('█' body, '=' glass/signal band,
 * '☼' lamp, '!' warning, '#' secondary structure) and add archetype-local
 * chars where it does not ('D' tram doors, '^' tram roof gear, '/' skimmer
 * wings, '+' cache lock).
 *
 * Identity first: each silhouette is meant to be told apart at 1x2px glyph
 * cells from 4-15 cells away — a low raked pod with a bright face, a long
 * boxy tram with a window stripe, a gull-winged cross, a strapped cube with
 * a glowing seam, a dull cube, a small case with a handle.
 */

/** Lamp/glow dimmer: scales the RESOLVED material, so a palette's colors dim
 * the same way the authored ones do. glow 1 returns the material untouched. */
function dimGlow(material, glow) {
  if (glow >= 0.999) return material;
  const level = clamp(glow, 0, 1);
  return {
    ...material,
    color: material.color.map(channel => clamp(channel * (0.25 + 0.75 * level), 0, 1)),
    emission: material.emission * level
  };
}

export function buildPodCarMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'pod_car', currentTime, { lod });
  const pose = motion.pose;
  const settle = pose.settle || 0;
  const lampGlow = Number.isFinite(pose.lampGlow) ? pose.lampGlow : 1;
  const hz = settle + Math.sin(motion.timeSeconds * (pose.hoverRate || 2.4) + motion.phase) * (pose.hoverDepth || 0);
  const lean = motion.lean;

  const hull = resolveMaterial(entity, { color: [0.45, 0.5, 0.58], roughness: 0.5, emission: 0.3, lightResponse: 0.55 }, options, 0.4);
  const glass = resolveMaterial(entity, { color: [0.3, 0.42, 0.56], roughness: 0.16, emission: 0.55, lightResponse: 0.2 }, options, 0.2, 0.5, '=');
  const lampFront = dimGlow(resolveMaterial(entity, { color: [1, 0.96, 0.82], roughness: 0.2, emission: 1, lightResponse: 0 }, options, 0.3, 0.5, '☼'), lampGlow);
  const lampTail = dimGlow(resolveMaterial(entity, { color: [1, 0.14, 0.1], roughness: 0.3, emission: 0.85, lightResponse: 0.05 }, options, 0.3, 0.5, '!'), lampGlow);
  const skirt = resolveMaterial(entity, { color: [0.12, 0.14, 0.18], roughness: 0.82, emission: 0.22, lightResponse: 0.3 }, options, 0.75, 0.5, '#');

  // Hover skirt: a dark slab floating above the ground line (parked settles
  // it), the gap being what says "hover" instead of "wheels".
  addLocalBox(vertices, basis, [0, lean * 0.1, 0.36 + hz + settle * 0.4], [1.0, 0.46, 0.05], skirt);
  // Low rounded body, then the cabin glass mass pushed FORWARD so the
  // windshield rake reads from the side.
  addLocalEllipsoid(vertices, basis, [0, lean * 0.2, 0.1 + hz], [1.05, 0.5, 0.24], hull, full ? 12 : 8, full ? 6 : 4);
  addLocalEllipsoid(vertices, basis, [0.08, lean * 0.25, -0.1 + hz], [0.58, 0.4, 0.18], glass, full ? 10 : 7, full ? 5 : 4);
  // Boxier tail mass: rear reads heavier than the raked nose.
  addLocalBox(vertices, basis, [-0.82, lean * 0.15, 0.02 + hz], [0.2, 0.44, 0.16], hull);
  // FRONT: one wide bright light block high on the nose. REAR: a red bar.
  addLocalBox(vertices, basis, [0.98, lean * 0.25, 0.12 + hz], [0.06, 0.3, 0.045], lampFront);
  addLocalBox(vertices, basis, [-1.02, lean * 0.15, 0.1 + hz], [0.045, 0.36, 0.04], lampTail);
  if (full) {
    // Dark nose intake under the light bar weights the front low.
    addLocalBox(vertices, basis, [1.0, lean * 0.25, 0.28 + hz], [0.05, 0.24, 0.05], skirt);
  }

  return finishMesh(vertices, lod, {
    archetype: 'pod_car',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    hover: hz,
    settle,
    lampGlow,
    lean,
    turn: motion.turn,
    chassis: 'civilian-hover-pod'
  });
}

export function buildTramCarMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'tram_car', currentTime, { lod });
  const hz = Math.sin(motion.timeSeconds * (motion.pose.hoverRate || 1.7) + motion.phase) * (motion.pose.hoverDepth || 0);

  const body = resolveMaterial(entity, { color: [0.55, 0.56, 0.52], roughness: 0.6, emission: 0.3, lightResponse: 0.5 }, options, 0.45);
  const windows = resolveMaterial(entity, { color: [0.95, 0.78, 0.5], roughness: 0.2, emission: 0.88, lightResponse: 0.1 }, options, 0.3, 0.5, '=');
  const doors = resolveMaterial(entity, { color: [0.3, 0.34, 0.36], roughness: 0.55, emission: 0.28, lightResponse: 0.4 }, options, 0.5, 0.5, 'D');
  const roofGear = resolveMaterial(entity, { color: [0.2, 0.23, 0.26], roughness: 0.78, emission: 0.2, lightResponse: 0.35 }, options, 0.1, 0.5, '^');

  // Long boxy carbody on low skids; the continuous window stripe and the two
  // door slots per side are proud of the body so they survive coarse cells.
  addLocalBox(vertices, basis, [0, 0, -0.09 + hz], [1.6, 0.55, 0.57], body);
  addLocalBox(vertices, basis, [0.1, 0, -0.38 + hz], [1.35, 0.57, 0.12], windows);
  for (const side of [-1, 1]) {
    addLocalBox(vertices, basis, [-0.7, side * 0.565, -0.05 + hz], [0.18, 0.015, 0.42], doors);
    addLocalBox(vertices, basis, [0.55, side * 0.565, -0.05 + hz], [0.18, 0.015, 0.42], doors);
  }
  // Roof equipment spine with pods, and coupler stubs at both ends.
  addLocalBox(vertices, basis, [0, 0, -0.72 + hz], [1.1, 0.16, 0.06], roofGear);
  if (full) {
    for (const at of [-0.55, 0.05, 0.6]) {
      addLocalBox(vertices, basis, [at, 0, -0.8 + hz], [0.13, 0.12, 0.05], roofGear);
    }
    for (const end of [-1, 1]) {
      addLocalSegment(vertices, basis, [end * 1.6, 0, 0.28 + hz], [end * 1.78, 0, 0.28 + hz], 0.05, 0.038, roofGear, 5);
    }
  }
  // Low skid blocks keep a shadow line under the carbody.
  addLocalBox(vertices, basis, [-0.9, 0, 0.47 + hz], [0.3, 0.3, 0.025], roofGear);
  addLocalBox(vertices, basis, [0.9, 0, 0.47 + hz], [0.3, 0.3, 0.025], roofGear);

  return finishMesh(vertices, lod, {
    archetype: 'tram_car',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    hover: hz,
    chassis: 'transit-car'
  });
}

export function buildSkimmerMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'skimmer', currentTime, { lod });
  const pose = motion.pose;
  const hz = Math.sin(motion.timeSeconds * (pose.hoverRate || 2.8) + motion.phase) * (pose.hoverDepth || 0);
  const flex = Math.sin(motion.timeSeconds * 1.9 + motion.phase) * (pose.wingFlex || 0);
  // Bank rolls the wing line: one tip drops, the other rises. The turn term
  // banks it into actual heading changes even in cruise.
  const bank = (pose.bank || 0) + motion.turn * 0.2;

  const hull = resolveMaterial(entity, { color: [0.62, 0.66, 0.72], roughness: 0.42, emission: 0.35, lightResponse: 0.4 }, options, 0.4);
  const wing = resolveMaterial(entity, { color: [0.36, 0.42, 0.52], roughness: 0.5, emission: 0.28, lightResponse: 0.35 }, options, 0.5, 0.5, '/');
  const canopy = resolveMaterial(entity, { color: [0.25, 0.5, 0.62], roughness: 0.15, emission: 0.6, lightResponse: 0.1 }, options, 0.2, 0.5, '=');
  const navLamp = resolveMaterial(entity, { color: [1, 0.5, 0.25], roughness: 0.2, emission: 1, lightResponse: 0 }, options, 0.7, 0.5, '☼');

  // Slim fuselage, bubble canopy forward.
  addLocalEllipsoid(vertices, basis, [0.05, 0, 0.08 + hz], [0.5, 0.11, 0.1], hull, full ? 10 : 7, full ? 5 : 4);
  addLocalEllipsoid(vertices, basis, [0.28, 0, -0.02 + hz], [0.18, 0.09, 0.08], canopy, full ? 8 : 6, full ? 5 : 4);
  // High gull wings: up from the root, then out and slightly down to the tip.
  for (const side of [-1, 1]) {
    const roll = bank * side;
    addJointedLimb(vertices, basis, [
      [0, side * 0.1, 0.04 + hz],
      [-0.05, side * 0.5, -0.18 + hz + flex - roll * 0.28],
      [-0.1, side * 0.9, -0.1 + hz + flex * 1.6 - roll * 0.6]
    ], [0.05, 0.035, 0.014], wing, full ? 6 : 5);
  }
  // Tail fin and belly nav lamp.
  addLocalSegment(vertices, basis, [-0.42, 0, 0.06 + hz], [-0.66, 0, -0.14 + hz], 0.035, 0.012, wing, full ? 6 : 5);
  if (full) {
    for (const side of [-1, 1]) {
      addLocalSegment(vertices, basis, [-0.5, 0, 0.06 + hz], [-0.62, side * 0.18, 0.04 + hz], 0.022, 0.009, wing, 5);
    }
  }
  addLocalEllipsoid(vertices, basis, [0.15, 0, 0.2 + hz], [0.045, 0.045, 0.035], navLamp, 7, 4);

  return finishMesh(vertices, lod, {
    archetype: 'skimmer',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    hover: hz,
    bank,
    wingFlex: flex,
    turn: motion.turn,
    chassis: 'courier-flyer'
  });
}

export function buildCacheMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'cache', currentTime, { lod });
  const pose = motion.pose;
  const lidOpen = clamp(pose.lidOpen || 0, 0, 1);
  // The requested tell: the seam glow breathes at ~0.1 emission amplitude.
  const seamPulse = 1 + Math.sin(motion.timeSeconds * (pose.seamRate || 2.2) + motion.phase) * (pose.seamDepth || 0.1);

  const shell = resolveMaterial(entity, { color: [0.5, 0.42, 0.28], roughness: 0.62, emission: 0.28, lightResponse: 0.5 }, options, 0.5);
  const straps = resolveMaterial(entity, { color: [0.2, 0.2, 0.22], roughness: 0.8, emission: 0.18, lightResponse: 0.4 }, options, 0.5, 0.5, '#');
  const seamBase = resolveMaterial(entity, { color: [1, 0.78, 0.28], roughness: 0.2, emission: 1, lightResponse: 0 }, options, 0.4, 0.5, '◆');
  const seam = { ...seamBase, emission: seamBase.emission * seamPulse };
  const lock = resolveMaterial(entity, { color: [0.75, 0.2, 0.12], roughness: 0.4, emission: 0.6, lightResponse: 0.15 }, options, 0.3, 0.5, '+');

  // Strapped crate body on stubby feet, the lid a distinct slab above the
  // glowing seam line.
  addLocalBox(vertices, basis, [0, 0, 0.16], [0.33, 0.3, 0.26], shell);
  addLocalBox(vertices, basis, [-0.15, 0, 0.15], [0.045, 0.312, 0.272], straps);
  addLocalBox(vertices, basis, [0.15, 0, 0.15], [0.045, 0.312, 0.272], straps);
  // The seam glow band between body and lid, slightly proud on every side.
  addLocalBox(vertices, basis, [0, 0, -0.115 + lidOpen * 0.01], [0.345, 0.315, 0.014], seam);
  // Lid: seated when sealed; ajar (raised and slid back) when open, with an
  // inner glow face showing in the opening.
  addLocalBox(vertices, basis,
    [-0.14 * lidOpen, 0, -0.2 - lidOpen * 0.09],
    [0.34, 0.31, 0.065], shell);
  if (lidOpen > 0.05) {
    addLocalBox(vertices, basis, [0.05, 0, -0.145], [0.27, 0.26, 0.012], seam);
  } else {
    // The lock bar only exists while sealed - its absence is the "opened"
    // tell at a distance.
    addLocalBox(vertices, basis, [0, 0, -0.285], [0.075, 0.325, 0.028], lock);
  }
  if (full) {
    for (const cornerX of [-1, 1]) {
      for (const cornerY of [-1, 1]) {
        addLocalBox(vertices, basis, [cornerX * 0.26, cornerY * 0.23, 0.455], [0.05, 0.05, 0.035], straps);
      }
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'cache',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    lidOpen,
    seamPulse,
    chassis: 'salvage-cache'
  });
}

export function buildCrateMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'crate', currentTime, { lod });

  const box = resolveMaterial(entity, { color: [0.42, 0.4, 0.36], roughness: 0.85, emission: 0.2, lightResponse: 0.55 }, options, 0.5);
  const bands = resolveMaterial(entity, { color: [0.28, 0.27, 0.24], roughness: 0.9, emission: 0.16, lightResponse: 0.45 }, options, 0.5, 0.5, '#');

  // Deliberately the dull cousin of 'cache': matte banded box, nothing glows,
  // the only flourish a slightly irregular stacking lip.
  addLocalBox(vertices, basis, [0, 0, 0.1], [0.4, 0.36, 0.4], box);
  addLocalBox(vertices, basis, [0, 0, 0.25], [0.41, 0.37, 0.05], bands);
  addLocalBox(vertices, basis, [0, 0, -0.1], [0.41, 0.37, 0.05], bands);
  if (full) {
    addLocalBox(vertices, basis, [0.025, 0.015, -0.31], [0.36, 0.32, 0.022], bands);
  }

  return finishMesh(vertices, lod, {
    archetype: 'crate',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    chassis: 'freight-crate'
  });
}

export function buildRepairKitMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'repair_kit', currentTime, { lod });
  const pose = motion.pose;
  const stripePulse = 1 + Math.sin(motion.timeSeconds * (pose.stripeRate || 1.8) + motion.phase) * (pose.stripeDepth || 0);

  const kitCase = resolveMaterial(entity, { color: [0.72, 0.3, 0.16], roughness: 0.55, emission: 0.35, lightResponse: 0.4 }, options, 0.5);
  const handle = resolveMaterial(entity, { color: [0.2, 0.21, 0.24], roughness: 0.7, emission: 0.22, lightResponse: 0.4 }, options, 0.2, 0.5, '#');
  const stripeBase = resolveMaterial(entity, { color: [0.3, 1, 0.5], roughness: 0.2, emission: 1, lightResponse: 0 }, options, 0.4, 0.5, '=');
  const stripe = { ...stripeBase, emission: stripeBase.emission * stripePulse };

  // Small field case: a low rectangle, a raised handle bar, one emissive
  // status stripe on the forward face.
  addLocalBox(vertices, basis, [0, 0, 0.34], [0.22, 0.15, 0.13], kitCase);
  addLocalBox(vertices, basis, [0, 0, 0.175], [0.11, 0.028, 0.03], handle);
  if (full) {
    addLocalBox(vertices, basis, [-0.08, 0, 0.2], [0.022, 0.026, 0.03], handle);
    addLocalBox(vertices, basis, [0.08, 0, 0.2], [0.022, 0.026, 0.03], handle);
  }
  addLocalBox(vertices, basis, [0.225, 0, 0.33], [0.008, 0.1, 0.032], stripe);

  return finishMesh(vertices, lod, {
    archetype: 'repair_kit',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    stripePulse,
    chassis: 'field-case'
  });
}

/**
 * ARM_SIDE — the street lamp's one orientation convention.
 *
 * The lamp is rotationally featureless EXCEPT for its arm, so `heading` has
 * exactly one job on this archetype: aim the overhang. The arm is authored
 * along the archetype's own forward axis, which is the axis every archetype
 * faces at heading 0, so:
 *
 *   arm bearing (world radians) === entity.heading + STREET_LAMP_ARM_HEADING_OFFSET
 *
 * With the offset at 0 that reduces to `heading IS the direction the light
 * reaches`. A game placing lamps along a kerb sets each lamp's heading to the
 * bearing from the pole toward the pavement it should light, and the fixture
 * overhangs the footway instead of the roadway. The constant is exported
 * rather than left as prose so the rule can be asserted in a test and imported
 * by the placement code that depends on it.
 */
export const STREET_LAMP_ARM_HEADING_OFFSET = 0;

/**
 * Municipal street lamp (Beyond Dawn). A fixture, not a vehicle, and the
 * tallest thing in this file by a factor of three — ~4.2 renderer cells from
 * the plinth's ground contact to the crown of the hood, against a tram_car's
 * 1.35 and a pod_car's 0.78. That ratio is deliberate and matches the real
 * street: a cobra-head lamp stands about three times a tram's roofline.
 *
 * SILHOUETTE BUDGET. This is seen at 1x2px glyph cells from 5-25 units, almost
 * always from underneath, so the shape is authored coarser than life: the mast
 * is ~0.19 cells thick where a scale-honest one would be ~0.07, the hood is a
 * deep dome over a rectangular rim plate rather than a thin shell, and the
 * lamp face is inset INSIDE that rim so the rim frames the glow from below.
 * From the side the reading is dome / rim line / a sliver of light under it;
 * from below it is a bright rectangle in a dark frame on the end of an arm.
 *
 * THE MAST AND ARM WERE THICKENED after this archetype first landed (8b416f1
 * authored them at 0.124 -> 0.092 and 0.10 -> 0.066 cells). Measured against
 * the sampler rather than the eye, EVERY height of the original fixture sat
 * under the 0.15-cell cross-section bar the `antenna_mast` work established,
 * bottoming out at 0.084 where the arm leaves the mast — which on the default
 * `legacy` glyph pipeline (ONE scene sample a glyph cell, no supersampling)
 * means the pole resolves in only ~a third of the columns it crosses at long
 * range and dashes as the camera moves. Nothing about the fixture's PROPORTIONS
 * changed: the plinth, the arm's sweep, the hood assembly and the lamp face are
 * untouched, so `nativeHeight` 4.2 and `nativeFootprint` 1.53 both still hold
 * and a game's scale factor against them is unaffected. Only the two tubes got
 * fatter. Safe to change because this archetype is Beyond Dawn's alone —
 * Liminal Protocol has never referenced it (verified: it appears in no demo, no
 * legacy build and no byte-identity pin), so there was no shipped output to
 * preserve, only the measured sizes the game scales against.
 *
 * PALETTE. Five parts, five distinct hint chars, every one of them reachable
 * from a registration palette on day one — '█' mast, '#' plinth, '-' arm,
 * '^' hood, '☼' lamp face. Not paletteOnly (unlike the hunter's legs, whose
 * flag protects a shipped game's byte-identity through the renderer's
 * sprite-template resolver): nothing has ever shipped on this archetype, so
 * there is no identity to protect and no reason to make the parts reachable
 * from fewer resolvers than the six vehicle/prop archetypes above.
 *
 * EMISSION. Only the lamp face is authored at 1 — the deferred shader's
 * pure-emissive branch (isSelfLuminous > 0.95), so the light source is albedo
 * and nothing dims it. Every structure part sits at 0.20-0.26, far under the
 * cliff, so the mast/arm/hood/plinth take scene light and read as metal.
 */
export function buildStreetLampMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'street_lamp', currentTime, { lod });
  // A lamp is bolted to the pavement: every locomotion field the animation
  // resolver offers is deliberately ignored. lampGlow is the whole animation.
  const lampGlow = Number.isFinite(motion.pose.lampGlow) ? motion.pose.lampGlow : 1;

  const mast = resolveMaterial(entity,
    { color: [0.26, 0.29, 0.34], roughness: 0.62, emission: 0.24, lightResponse: 0.55 },
    options, 0.5, 0.5, '█');
  const plinth = resolveMaterial(entity,
    { color: [0.17, 0.19, 0.23], roughness: 0.88, emission: 0.2, lightResponse: 0.5 },
    options, 0.95, 0.5, '#');
  const arm = resolveMaterial(entity,
    { color: [0.31, 0.34, 0.39], roughness: 0.58, emission: 0.24, lightResponse: 0.55 },
    options, 0.08, 0.5, '-');
  const hood = resolveMaterial(entity,
    { color: [0.4, 0.43, 0.48], roughness: 0.48, emission: 0.26, lightResponse: 0.5 },
    options, 0.04, 0.5, '^');
  // The lit element. Warm sodium by default, authored at the pure-emissive
  // ceiling so it reads as a source and not as a bright surface.
  const faceLit = resolveMaterial(entity,
    { color: [1, 0.87, 0.6], roughness: 0.12, emission: 1, lightResponse: 0 },
    options, 0.02, 0.5, '☼');
  // `dark` keeps the fixture and kills the light. dimGlow takes the glow out
  // the same way the pod car's parked lamps lose theirs (so a palette's colors
  // die the same way the authored one does); restoring lightResponse on the
  // way down is the lamp-specific part — a dead lens must re-enter the LIT
  // path and catch what light is left in the street, or a blackout district
  // renders a row of black holes on sticks.
  const face = lampGlow >= 0.999
    ? faceLit
    : { ...dimGlow(faceLit, lampGlow), lightResponse: 0.5 * (1 - lampGlow) };

  // GROUND CONTACT. The plinth bottoms out at z +0.5 exactly — the floor
  // plane — so the entity's z is ground contact like every other archetype
  // and the beyond-LOD billboard's feet anchor lands on the same plane.
  addLocalBox(vertices, basis, [0, 0, 0.415], [0.23, 0.23, 0.085], plinth);
  addLocalBox(vertices, basis, [0, 0, 0.255], [0.145, 0.145, 0.075], plinth);

  // Slender tapered mast. Thicker than scale honesty wants (see the budget
  // note above) because a one-cell-wide glyph column is the whole object at
  // 20 units. 0.2 -> 0.18 cells across; the simplified LOD's 5-sided tube
  // inscribes that to 0.181 -> 0.163, still clear of the 0.15 bar.
  addLocalSegment(vertices, basis, [0, 0, 0.22], [0, 0, -3.28], 0.1, 0.09, mast, full ? 8 : 5);

  // The ARM: up off the mast head, out along +forward, then level into the
  // hood. Two joints so the sweep reads as a curve rather than a bracket.
  // Carries the mast's thickness out to the hood rather than tapering away to
  // a wire — the junction at z -3.2 was the thinnest point of the whole
  // fixture and therefore the first thing to dissolve.
  addJointedLimb(vertices, basis, [
    [0, 0, -3.24],
    [0.34, 0, -3.56],
    [0.88, 0, -3.55]
  ], [0.095, 0.088, 0.084], arm, full ? 7 : 4);

  // HOOD: a deep dome elongated along the arm, over a rim plate wider than the
  // dome on every side. The rim is what makes this read as a hood rather than
  // a blob — it is the hard horizontal line under the dome from the side, and
  // the dark frame around the glow from below.
  addLocalEllipsoid(vertices, basis, [0.98, 0, -3.58], [0.3, 0.185, 0.12], hood, full ? 12 : 8, full ? 6 : 4);
  addLocalBox(vertices, basis, [0.98, 0, -3.45], [0.315, 0.205, 0.025], hood);
  // The lit face, inset inside the rim and hanging just below it so a grazing
  // view from the side still catches light under the hood.
  addLocalBox(vertices, basis, [0.98, 0, -3.415], [0.24, 0.145, 0.028], face);

  if (full) {
    // Ridge along the hood's spine: pure side-profile, invisible from below.
    addLocalBox(vertices, basis, [0.98, 0, -3.665], [0.235, 0.035, 0.032], hood);
    // Bracket gusset where the arm leaves the mast, and an access panel on the
    // plinth — the two details that say "municipal fitting" up close.
    addLocalBox(vertices, basis, [0.1, 0, -3.19], [0.08, 0.048, 0.095], arm);
    addLocalBox(vertices, basis, [0.205, 0, 0.4], [0.045, 0.105, 0.07], plinth);
  }

  return finishMesh(vertices, lod, {
    archetype: 'street_lamp',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    lampGlow,
    armHeadingOffset: STREET_LAMP_ARM_HEADING_OFFSET,
    chassis: 'municipal-street-lamp'
  });
}

/**
 * Street furniture (Beyond Dawn). The five solid things a player walks among
 * that were still flat billboards after the city went volumetric: a bench, a
 * planter, a tree crown, a rooftop antenna mast, a hung market lantern.
 *
 * SAME CONTRACT as the vehicle/prop set above — every material routes through
 * `resolveMaterial` with a documented hint char, the authored defaults read
 * unassisted at night, each has a cheaper simplified LOD, and `z` is GROUND
 * CONTACT: every one of them bottoms out at exactly +0.5, the floor plane, so
 * `bd8ed1a`'s billboard feet anchor lands on the same plane the mesh stands on.
 *
 * SEEN AT NIGHT, FROM BELOW, AT 1x2px GLYPH CELLS. That is the whole design
 * brief and it is why these are authored coarser than life: masses are fewer
 * and bigger than a scale-honest model would use, structural members are
 * thicker than their real counterparts, and detail that cannot survive a
 * one-glyph-wide column is either dropped or demoted to the full LOD. Where a
 * shape had to choose between being accurate and being TELLABLE APART from its
 * neighbours in a 3-glyph silhouette, it is tellable apart.
 *
 * FACING. `bench` and `planter` are authored on the engine-wide convention
 * that an archetype FACES +x at heading 0 — for street furniture that means
 * the side a person approaches from, so their long axis runs LATERALLY (the
 * entity's ±y). A game lining a kerb gives every bench and planter on that
 * kerb the same heading — the bearing from the kerb toward the open space —
 * and they all face out together. `STREET_FURNITURE_FACING_HEADING_OFFSET`
 * states it as data the way `STREET_LAMP_ARM_HEADING_OFFSET` does.
 */

/**
 * The offset between an entity's `heading` and the direction a piece of street
 * furniture FACES: for `bench` the way a sitter looks, for `planter` the broad
 * side its length presents. Zero — heading IS the facing — which is the same
 * rule `createBasis` gives every archetype, restated as an importable constant
 * because placement code should assert it rather than re-derive it from a
 * screenshot.
 *
 * The consequence worth stating out loud: because these two FACE their heading,
 * their long axis runs across it. A 1.6-cell bench at heading 0 spans y
 * -0.8..+0.8 and is only ~0.46 cells deep in x.
 */
export const STREET_FURNITURE_FACING_HEADING_OFFSET = 0;

/**
 * A lamp element that can go out, resolved for one glow level.
 *
 * `dimGlow` alone would leave a dead element at emission 0 AND lightResponse 0,
 * which in the deferred shader is a hole: not self-luminous, and not lit by
 * anything either. Every fixture in this file that can be extinguished needs
 * the same second half — hand the dead element back to the LIT path so it
 * catches what light is left in the street — so it is written once here rather
 * than three times inline. (`street_lamp` above keeps its own copy: it shipped
 * first and its output is pinned to the byte.)
 */
function resolveLampElement(material, glow, deadLightResponse = 0.5) {
  if (glow >= 0.999) return material;
  return { ...dimGlow(material, glow), lightResponse: deadLightResponse * (1 - glow) };
}

/**
 * Public street bench: ~1.6 long x 0.46 deep x 0.5 tall, slatted.
 *
 * The read from across a street is three horizontal bands stacked at three
 * depths — seat, lower back, upper back — carried on two dark end frames. That
 * banding is the entire identity: at 1x2px cells a bench is a short wide thing
 * with a GAP between its seat line and its back line, which is what separates
 * it from a crate (solid) and a planter (solid with a bush on top). The gaps
 * are real geometry, not shading, so they survive any palette.
 *
 * The back is raked by stepping the two back slats to different depths rather
 * than tilting one — `addLocalBox` is axis-aligned in the entity's frame, and
 * at this glyph size a two-step rake and a true tilt rasterize to the same
 * thing. The end frames' back posts ARE segments, so the rake is honest where
 * it shows in profile.
 */
export function buildBenchMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'bench', currentTime, { lod });

  const slat = resolveMaterial(entity,
    { color: [0.46, 0.42, 0.35], roughness: 0.88, emission: 0.22, lightResponse: 0.55 },
    options, 0.45);
  const frame = resolveMaterial(entity,
    { color: [0.18, 0.2, 0.23], roughness: 0.85, emission: 0.18, lightResponse: 0.5 },
    options, 0.9, 0.5, '#');
  const back = resolveMaterial(entity,
    { color: [0.38, 0.34, 0.29], roughness: 0.9, emission: 0.2, lightResponse: 0.55 },
    options, 0.2, 0.5, '-');

  // Two end frames: a leg plate standing on the floor plane, and a back post
  // raking up and behind it. GROUND CONTACT is the leg plates' underside.
  for (const side of [-1, 1]) {
    addLocalBox(vertices, basis, [-0.02, side * 0.73, 0.37], [0.185, 0.045, 0.13], frame);
    addLocalSegment(vertices, basis,
      [-0.15, side * 0.73, 0.27], [-0.235, side * 0.73, 0.02],
      0.045, 0.032, frame, full ? 6 : 4);
  }

  // Seat: three slats with real gaps between them, overhanging the frames at
  // both ends so the bench reads longer than its supports.
  for (const at of [0.14, 0.01, -0.12]) {
    addLocalBox(vertices, basis, [at, 0, 0.268], [0.055, 0.8, 0.028], slat);
  }

  // Back: two slats stepped back as they rise.
  addLocalBox(vertices, basis, [-0.18, 0, 0.155], [0.033, 0.76, 0.052], back);
  addLocalBox(vertices, basis, [-0.225, 0, 0.05], [0.033, 0.76, 0.05], back);

  if (full) {
    // Apron under the seat's leading edge: a hard shadow line that says
    // "you could sit on this" from close range.
    addLocalBox(vertices, basis, [0.165, 0, 0.318], [0.028, 0.72, 0.022], frame);
    // Foot pads, bottoming on the floor plane exactly like the leg plates.
    for (const side of [-1, 1]) {
      addLocalBox(vertices, basis, [-0.02, side * 0.73, 0.487], [0.205, 0.062, 0.013], frame);
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'bench',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    facingHeadingOffset: STREET_FURNITURE_FACING_HEADING_OFFSET,
    chassis: 'street-bench'
  });
}

/**
 * Municipal planter: a ~1.15 x 0.65 x 0.45 trough with a proud lip, carrying a
 * foliage mass above it.
 *
 * WITHERING IS A PALETTE, NOT A POSE. The foliage is the only part on '*', so
 * a derelict quarter recolors that one char to bare soil brown and gets a dead
 * planter with no second registration, no pose blend and no geometry change.
 * That is why the leaves are one hint char across all five lobes rather than a
 * light/dark pair: a palette can only wither what it can address as a unit.
 *
 * The lip is proud of the trough on every side by 0.025 cells. That overhang is
 * doing the same job as the street lamp's hood rim — it puts a hard horizontal
 * line between the container and the planting, so the foliage reads as sitting
 * IN something rather than growing out of a kerb.
 */
export function buildPlanterMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'planter', currentTime, { lod });

  const shell = resolveMaterial(entity,
    { color: [0.44, 0.43, 0.4], roughness: 0.92, emission: 0.2, lightResponse: 0.55 },
    options, 0.75);
  const lip = resolveMaterial(entity,
    { color: [0.26, 0.26, 0.25], roughness: 0.9, emission: 0.18, lightResponse: 0.5 },
    options, 0.5, 0.5, '#');
  const leaf = resolveMaterial(entity,
    { color: [0.2, 0.34, 0.19], roughness: 0.94, emission: 0.22, lightResponse: 0.6 },
    options, 0.15, 0.5, '*');

  // Trough, bottoming out on the floor plane, and the lip proud of it.
  addLocalBox(vertices, basis, [0, 0, 0.31], [0.3, 0.55, 0.19], shell);
  addLocalBox(vertices, basis, [0, 0, 0.09], [0.325, 0.575, 0.035], lip);

  // Foliage: one broad mass plus two shoulder lobes, so the planting has a
  // top-lit crown and a silhouette that is not an ellipse.
  addLocalEllipsoid(vertices, basis, [0, 0, -0.09], [0.3, 0.5, 0.29], leaf, full ? 10 : 7, full ? 6 : 4);
  addLocalEllipsoid(vertices, basis, [0.05, -0.3, 0], [0.25, 0.24, 0.22], leaf, full ? 8 : 6, full ? 5 : 4);
  addLocalEllipsoid(vertices, basis, [-0.04, 0.3, -0.01], [0.24, 0.25, 0.21], leaf, full ? 8 : 6, full ? 5 : 4);
  if (full) {
    // Two tufts that break the crown line up close. Deliberately INSIDE the
    // silhouette envelope: the LOD swap must not change the outline height.
    addLocalEllipsoid(vertices, basis, [-0.06, 0.16, -0.235], [0.15, 0.16, 0.13], leaf, 7, 4);
    addLocalEllipsoid(vertices, basis, [0.09, -0.14, -0.25], [0.14, 0.15, 0.12], leaf, 7, 4);
  }

  return finishMesh(vertices, lod, {
    archetype: 'planter',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    facingHeadingOffset: STREET_FURNITURE_FACING_HEADING_OFFSET,
    chassis: 'municipal-planter'
  });
}

/**
 * Street tree crown: a ~1.76-cell lumpy sphere on a short visible trunk stub.
 *
 * THE ONE REQUIREMENT IS THAT IT IS NOT A DISC. The game stamps a solid cell
 * for the trunk mass and puts this on top, so this archetype is only ever seen
 * from underneath and from the side — the two views in which a billboard, or a
 * single ellipsoid, gives itself away. Three things buy the volume:
 *
 *   1. SEVEN OVERLAPPING LOBES at different heights and offsets, not one
 *      ellipsoid. The outline is non-circular from every bearing, so turning
 *      the camera changes the shape, which a disc cannot do.
 *   2. AN UNEVEN UNDERSIDE. The skirt lobes hang to z 0.0 while the core's
 *      underside is at -0.16 and the upper lobes at -0.48. From below, the
 *      canopy line is ragged and the trunk disappears into it at different
 *      depths on different sides — the single strongest volume cue there is.
 *   3. A TWO-TONE CROWN. The upper lobes carry their own hint char and a
 *      lighter authored color, standing in for sky light landing on the top of
 *      the mass. At 1x2px cells that gradient is what separates "ball" from
 *      "circle", and a game can also use it for an autumn or half-dead tree.
 *
 * The trunk stub runs from the floor plane up INTO the core, so there is no
 * seam to catch: 0.5 to 0.66 cells of it are visible depending on the bearing,
 * and the rest is buried. Place the entity's z at the TOP of whatever trunk
 * mass the world stamped and the stub overlaps it instead of floating.
 *
 * HEADING IS COSMETIC and worth using: it rotates the lump distribution, so
 * giving each tree in a row a different heading turns one mesh into a row of
 * different trees for free.
 */
export function buildTreeCanopyMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'tree_canopy', currentTime, { lod });

  const crown = resolveMaterial(entity,
    { color: [0.19, 0.32, 0.18], roughness: 0.94, emission: 0.2, lightResponse: 0.6 },
    options, 0.55, 0.5, '*');
  const upper = resolveMaterial(entity,
    { color: [0.28, 0.42, 0.25], roughness: 0.9, emission: 0.24, lightResponse: 0.6 },
    options, 0.15, 0.5, '^');
  const bark = resolveMaterial(entity,
    { color: [0.24, 0.2, 0.16], roughness: 0.96, emission: 0.16, lightResponse: 0.5 },
    options, 0.95, 0.5, '#');

  // Trunk stub: a flared foot on the floor plane, then up into the crown.
  addLocalSegment(vertices, basis, [0, 0, 0.5], [0, 0, 0.13], 0.165, 0.125, bark, full ? 8 : 5);
  addLocalSegment(vertices, basis, [0, 0, 0.14], [0, 0, -0.35], 0.125, 0.1, bark, full ? 7 : 5);

  // Lower/central mass. The core is deliberately held HIGH — its underside is
  // at -0.24, not down at the trunk — because a big low ball centred on the
  // axis is precisely what flattens a canopy into a plate from below.
  addLocalEllipsoid(vertices, basis, [0, 0, -0.72], [0.64, 0.64, 0.48], crown, full ? 10 : 7, full ? 6 : 4);
  addLocalEllipsoid(vertices, basis, [0.4, 0.2, -0.56], [0.48, 0.5, 0.4], crown, full ? 9 : 6, full ? 5 : 4);
  addLocalEllipsoid(vertices, basis, [-0.38, -0.3, -0.62], [0.5, 0.48, 0.38], crown, full ? 9 : 6, full ? 5 : 4);
  // The skirt lobe: the one that hangs to 0.08, a third of a cell lower than
  // anything else. It is what makes the canopy line ragged against the trunk,
  // and the canopy line varying with bearing is the volume cue.
  addLocalEllipsoid(vertices, basis, [0.24, 0.32, -0.2], [0.36, 0.36, 0.28], crown, full ? 8 : 6, 4);
  // Upper lobes and cap, in the lighter crown tone.
  addLocalEllipsoid(vertices, basis, [0.1, -0.44, -0.9], [0.46, 0.46, 0.38], upper, full ? 9 : 6, full ? 5 : 4);
  addLocalEllipsoid(vertices, basis, [-0.14, 0.42, -0.92], [0.46, 0.44, 0.36], upper, full ? 9 : 6, full ? 5 : 4);
  addLocalEllipsoid(vertices, basis, [0.04, -0.02, -1.06], [0.42, 0.42, 0.3], upper, full ? 9 : 6, full ? 5 : 4);
  if (full) {
    // Two more lobes close up, both inside the silhouette envelope so the LOD
    // swap never changes the outline.
    addLocalEllipsoid(vertices, basis, [-0.3, 0.1, -0.34], [0.32, 0.32, 0.24], crown, 8, 4);
    addLocalEllipsoid(vertices, basis, [0.34, -0.2, -1.04], [0.3, 0.3, 0.24], upper, 8, 4);
  }

  return finishMesh(vertices, lod, {
    archetype: 'tree_canopy',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    chassis: 'street-tree-crown'
  });
}

/**
 * Rooftop antenna mast: ~3.55 cells tall, thin, with a red obstruction beacon
 * on top.
 *
 * SILHOUETTE-ONLY OBJECT. This one is authored against the longest sightline in
 * the set — it stands on tower roofs and is read against the sky at 20+ cells,
 * where the entire mast is a one-glyph-wide column and the crossarms are three
 * or four glyphs of horizontal. Everything follows from that:
 *
 *   - The spine is 0.078 cells thick at the base where scale honesty wants
 *     ~0.03, for the same reason the street lamp's mast is: a column thinner
 *     than a glyph cell rasterizes to nothing at all half the frames.
 *   - The three crossarms ALTERNATE AXES — lower along ±y, mid along ±x, upper
 *     along ±y — so the mast is never seen from a bearing that flattens all of
 *     them into the spine. A stack of parallel arms disappears from one
 *     direction; a rotating stack cannot.
 *   - The arms shorten as they rise (1.24, 0.88, 0.6 cells). The taper is the
 *     silhouette's whole vocabulary; without it a mast at range is a stick.
 *   - The beacon is authored at emission 1, the deferred shader's pure-emissive
 *     branch, so it survives to one bright cell at ranges where the structure
 *     has already dissolved into the sky. It is red — an obstruction light, not
 *     a street light — which also makes it the one part of a night skyline a
 *     player can pick out and navigate by.
 *
 * The lattice rails and the dish pod are FULL LOD ONLY: they are the parts that
 * only exist for someone standing on the same roof.
 */
export function buildAntennaMastMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'antenna_mast', currentTime, { lod });
  // Bolted to a roof: every locomotion field is ignored, exactly as the street
  // lamp ignores them. lampGlow is the whole animation.
  const lampGlow = Number.isFinite(motion.pose.lampGlow) ? motion.pose.lampGlow : 1;

  const spine = resolveMaterial(entity,
    { color: [0.3, 0.32, 0.36], roughness: 0.6, emission: 0.24, lightResponse: 0.55 },
    options, 0.5);
  const base = resolveMaterial(entity,
    { color: [0.17, 0.19, 0.22], roughness: 0.88, emission: 0.2, lightResponse: 0.5 },
    options, 0.95, 0.5, '#');
  const arms = resolveMaterial(entity,
    { color: [0.4, 0.42, 0.46], roughness: 0.55, emission: 0.26, lightResponse: 0.55 },
    options, 0.3, 0.5, '-');
  const beacon = resolveLampElement(resolveMaterial(entity,
    { color: [1, 0.2, 0.12], roughness: 0.2, emission: 1, lightResponse: 0 },
    options, 0.02, 0.5, '!'), lampGlow, 0.45);

  // Bolted base plate, on the floor plane, then a stepped pedestal. The block
  // is 0.16 cells deep rather than a plate's honest 0.05 so it cannot fall
  // BETWEEN two rows of glyph samples and leave the mast standing on nothing.
  addLocalBox(vertices, basis, [0, 0, 0.45], [0.27, 0.27, 0.05], base);
  addLocalBox(vertices, basis, [0, 0, 0.32], [0.175, 0.175, 0.08], base);

  // Tapered spine, 0.26 cells thick at the base and still 0.17 at the top.
  // Both numbers are roughly three times a scale-honest mast's, for the reason
  // in the block comment: the default glyph pipeline is `legacy`, ONE scene
  // sample a cell, so geometry narrower than a cell does not draw dimly — it
  // does not draw at all, in whichever rows the sample happens to miss. A mast
  // that dissolves into a dashed line at 15 cells is the failure this width
  // buys off, and the cost is a spine that is chunky from the same roof.
  addLocalSegment(vertices, basis, [0, 0, 0.3], [0, 0, -2.82], 0.13, 0.1, spine, full ? 8 : 5);

  // Three crossarms on alternating axes, shortening as they rise. BOXES, not
  // tubes: a box projects to a filled rectangle from any bearing, where a thin
  // cylinder's silhouette narrows to nothing at the same width.
  addLocalBox(vertices, basis, [0, 0, -1.05], [0.08, 0.62, 0.085], arms);
  addLocalBox(vertices, basis, [0, 0, -1.85], [0.44, 0.07, 0.075], arms);
  addLocalBox(vertices, basis, [0, 0, -2.42], [0.062, 0.3, 0.068], arms);
  // End pods on the widest arm: they thicken its tips, which is what keeps the
  // lower crossbar from vanishing before the spine does.
  for (const side of [-1, 1]) {
    addLocalBox(vertices, basis, [0, side * 0.6, -1.05], [0.075, 0.06, 0.11], arms);
  }

  // Finial and the obstruction beacon. The beacon is 0.26 across — as wide as
  // the spine's base — because it is the LAST thing still resolving as the
  // structure dissolves, and a navigable skyline light that blinks out of
  // existence at range is worse than no beacon at all.
  addLocalSegment(vertices, basis, [0, 0, -2.82], [0, 0, -2.88], 0.09, 0.06, spine, full ? 6 : 4);
  addLocalEllipsoid(vertices, basis, [0, 0, -2.92], [0.13, 0.13, 0.13], beacon, full ? 8 : 6, full ? 5 : 4);

  if (full) {
    // Lattice rails flanking the lower spine, and the two fittings that say
    // "this carries equipment" to someone standing next to it.
    for (const side of [-1, 1]) {
      addLocalSegment(vertices, basis, [0, side * 0.1, 0.3], [0, side * 0.04, -1.4], 0.024, 0.014, arms, 5);
    }
    addLocalEllipsoid(vertices, basis, [0.11, -0.34, -1.18], [0.075, 0.13, 0.13], arms, 8, 5);
    addLocalBox(vertices, basis, [-0.075, 0, -0.75], [0.028, 0.05, 0.42], base);
  }

  return finishMesh(vertices, lod, {
    archetype: 'antenna_mast',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    lampGlow,
    chassis: 'rooftop-antenna-mast'
  });
}

/**
 * Hung market lantern: ~0.5 cells tall, a glowing element in a small housing
 * under a hanging eyelet.
 *
 * Z IS THE BOTTOM OF THE LANTERN, NOT THE POINT IT HANGS FROM. This is the one
 * archetype in the file whose real-world mounting is above it rather than below,
 * and it still honours the engine's ground-contact contract instead of
 * inverting it — the base plate bottoms out on the floor plane at +0.5 and the
 * eyelet is the crown. So a game hanging one on a wire at height H sets
 * `z = H - nativeHeight * scale` (world units) and the eyelet meets the wire.
 * Fighting the contract instead would have cost the fallback billboard its feet
 * anchor and the LOD handoff its alignment, for nothing.
 *
 * The housing hood is WIDER than the glow element it covers, the same rim trick
 * the street lamp's hood uses: from the side it is a hard dark line above the
 * light, which is what stops a small emissive blob from reading as a floating
 * spark. The eyelet's plane contains the entity's FORWARD axis, so `heading` is
 * the direction the wire runs.
 */
/**
 * A ROOST OF BATS, hanging from rock.
 *
 * Added for Beyond Dawn's shelter, which had them as a billboard sheet in
 * near-black ink (#241f1a, emission 0.01) on a dark cave ceiling - present in
 * every frame and visible in none of them. The report was simply "the bats
 * don't work", and they didn't: about forty per cent of the sprite was empty,
 * the rest was three shades of almost-black, and at glyph scale that is a
 * smudge rather than an animal.
 *
 * SO THE COLOUR IS PART OF THE GEOMETRY'S JOB HERE. Fur is a warm brown that
 * sits clearly above the ceiling behind it rather than a naturalistic
 * blackish-brown that disappears into it, and lightResponse is high so the
 * hearth picks the cluster out when it is burning. A small emission floor
 * keeps them a silhouette rather than nothing when it is not.
 *
 * HANGING, SO IT USES THE SAME z CONTRACT AS EVERY OTHER ARCHETYPE: local
 * third axis runs DOWNWARD from 0 at the top to nativeHeight at the bottom,
 * and the caller places z as the bottom. To hang a roost from a ceiling at
 * height H, set z = H - nativeHeight * scale and the claws meet the rock.
 * That is the lantern's rule, restated because a hanging thing is exactly
 * where somebody will assume the opposite.
 *
 * THREE BATS, NOT ONE AND NOT TEN. One reads as a bird; a dozen is a texture.
 * Three at different heights and sizes is the smallest arrangement that says
 * colony, and the asymmetry is authored rather than random because this room
 * is drawn from a pure function.
 */
// A single horizontal bat for game-authored flight paths. Params drive wing
// strokes so captures and simulation replay use the same animation clock.
export function buildFlyingBatMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const flap = Number.isFinite(entity.params?.flap) ? clamp(entity.params.flap, -1, 1) : Math.sin(currentTime * 0.028);
  const fur = resolveMaterial(entity, { color: [0.48, 0.36, 0.28], emission: 0.16, roughness: 0.9 }, options);
  const membrane = resolveMaterial(entity, { color: [0.6, 0.42, 0.35], emission: 0.14, roughness: 0.85 }, options, 0.5, 0.5, '-');
  addLocalEllipsoid(vertices, basis, [0, 0, 0.35], [0.095, 0.046, 0.045], fur, full ? 6 : 4, full ? 4 : 3);
  addLocalEllipsoid(vertices, basis, [0.10, 0, 0.34], [0.04, 0.04, 0.04], fur, full ? 5 : 4, 3);
  for (const side of [-1, 1]) {
    addLocalSegment(vertices, basis, [0.1, side * 0.023, 0.32], [0.08, side * 0.035, 0.265], 0.018, 0.003, fur, 3);
    const wingZ = 0.35 + flap * 0.115;
    addLocalSegment(vertices, basis, [0.035, side * 0.035, 0.35], [0.03, side * 0.29, wingZ], 0.025, 0.008, membrane, full ? 5 : 3);
    // Overlapping thin lobes form the scalloped membrane behind the leading edge.
    for (let finger = 0; finger < (full ? 3 : 2); finger++) {
      addLocalEllipsoid(vertices, basis, [-0.025 - finger * 0.028, side * (0.12 + finger * 0.065),
        0.35 + flap * (0.045 + finger * 0.026)], [0.10 - finger * 0.019, 0.09, 0.018], membrane,
        full ? 5 : 4, 3);
    }
  }
  return finishMesh(vertices, lod);
}

export function buildBatRoostMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'bat_roost', currentTime, { lod });
  const spread = Number.isFinite(motion.pose.wingSpread) ? motion.pose.wingSpread : 0;

  const fur = resolveMaterial(entity,
    { color: [0.30, 0.23, 0.17], roughness: 0.95, emission: 0.06, lightResponse: 0.95 },
    options, 0.5);
  const membrane = resolveMaterial(entity,
    { color: [0.41, 0.27, 0.24], roughness: 0.82, emission: 0.05, lightResponse: 1 },
    options, 0.3, 0.5, '-');
  const claw = resolveMaterial(entity,
    { color: [0.15, 0.13, 0.12], roughness: 0.9, emission: 0.04, lightResponse: 0.6 },
    options, 0.02, 0.5, '#');

  // [across, sag from the rock, scale] - authored, not rolled.
  /*
   * WHERE THE ARCHETYPE SITS IN ITS OWN BOX, and it is not where a hanging
   * thing wants to be authored.
   *
   * Every archetype in this file spans local z from 0.5 - nativeHeight up to
   * 0.5, because 0.5 is the floor plane and the caller's z means GROUND
   * CONTACT (see the bench: its leg plates are centred 0.37 with a 0.13 half
   * height, so it bottoms at exactly 0.5). Scale and lift both pivot on that
   * plane. A roost authored from the claws down at 0 therefore floats
   * 0.215 * scale above wherever it was placed - which is easy to miss,
   * because a hanging thing placed slightly high still looks hung.
   *
   * So the whole animal is offset to end at the floor plane with its wings
   * spread, and the claws land at the TOP of the box - which is what the
   * caller then has to put on the rock.
   */
  const ROOT = 0.215;
  const ROOST = [[-0.17, 0, 1], [0.02, 0.028, 0.9], [0.185, 0.012, 0.82]];
  for (const [across, sag, scale] of ROOST) {
    const top = ROOT + sag;
    // Startled, the whole animal drops before it flies.
    const drop = spread * 0.045 * scale;
    const shoulder = top + 0.075 * scale + drop;
    const belly = top + 0.108 * scale + drop;
    const chin = top + 0.178 * scale + drop;

    // The grip: two claws into the rock, which is the only part that does not
    // move when the roost is disturbed.
    for (const claws of [-1, 1]) {
      addLocalSegment(vertices, basis,
        [0, across + claws * 0.016 * scale, top],
        [0, across + claws * 0.010 * scale, top + 0.038 * scale],
        0.011 * scale, 0.014 * scale, claw, full ? 4 : 3);
    }

    // Body and head, hanging head-down.
    // 6x4 rather than the 8x6 this started at. THREE ROOSTS HANG IN THAT
    // ROOM, so every vertex here is spent three times, and at 8x6 the bats
    // alone were 6,500 vertices - five benches each. A bat is a fist-sized
    // mass seen from across a hall; the extra bands were paying for curvature
    // nobody can resolve at glyph scale.
    addLocalEllipsoid(vertices, basis, [0, across, belly],
      [0.046 * scale, 0.043 * scale, 0.060 * scale], fur,
      full ? 6 : 4, full ? 4 : 3);
    addLocalEllipsoid(vertices, basis, [0.004 * scale, across, chin],
      [0.032 * scale, 0.030 * scale, 0.034 * scale], fur,
      full ? 5 : 4, full ? 3 : 3);

    // Ears. Small, and they point back along the body - the head is upside
    // down, so "up" for an ear is toward the feet.
    if (full) {
      for (const ear of [-1, 1]) {
        addLocalSegment(vertices, basis,
          [0, across + ear * 0.018 * scale, chin - 0.014 * scale],
          [-0.012 * scale, across + ear * 0.030 * scale, chin - 0.042 * scale],
          0.010 * scale, 0.003 * scale, fur, 4);
      }
    }

    /*
     * THE WINGS, and they are what makes this read as a bat rather than as a
     * hanging fruit. Folded they wrap the body and the whole thing is one
     * closed mass; spread they swing out and down past the head. The membrane
     * is a separate, lighter material because a bat's wing catches light in a
     * way its fur does not, and that difference is most of the silhouette at
     * this size.
     */
    for (const wing of [-1, 1]) {
      const out = (0.052 + spread * 0.115) * scale;
      const fall = (0.170 + spread * 0.055) * scale;
      addLocalSegment(vertices, basis,
        [0, across + wing * 0.030 * scale, shoulder],
        [spread * 0.02 * scale, across + wing * out, top + fall + drop],
        0.030 * scale, 0.016 * scale, membrane, full ? 5 : 4);
      // The forearm's leading edge, only worth its vertices up close.
      if (full) {
        addLocalSegment(vertices, basis,
          [0, across + wing * 0.028 * scale, shoulder + 0.006 * scale],
          [spread * 0.018 * scale, across + wing * out * 0.92, top + fall * 0.86 + drop],
          0.008 * scale, 0.005 * scale, fur, 4);
      }
    }
  }

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * THE SHELTER'S WORKBENCH: 1.2 across, 1.0 tall, and the thing you spend
 * salvage at.
 *
 * Beyond Dawn's shelter was billboards end to end. A bench seen from a metre
 * away with the camera free to circle it is exactly where a flat sheet gives
 * itself away, and this room is small enough that you are always a metre away.
 *
 * THE SILHOUETTE HAS TO SURVIVE GLYPH SCALE, so it is built from the three
 * things that say workbench and nothing else: a heavy top with an overhang, a
 * back board carrying tools, and the GAP under the top between the legs. That
 * gap is the identity - fill it in and this is a crate.
 *
 * Poses lit/dark change only the strip lamp under the back board, never the
 * silhouette, so a bench you cannot afford yet reads as the same object
 * unpowered rather than as a different object.
 */
export function buildWorkbenchMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'workbench', currentTime, { lod });
  const glow = Number.isFinite(motion.pose.lampGlow) ? motion.pose.lampGlow : 1;

  // Local z: 0.5 is the floor, up is negative. Top surface at 0.5 - 0.72.
  const TOP = 0.5 - 0.72;
  const plank = resolveMaterial(entity,
    { color: [0.42, 0.33, 0.24], roughness: 0.92, emission: 0.16, lightResponse: 0.75 },
    options, 0.35);
  const frame = resolveMaterial(entity,
    { color: [0.21, 0.19, 0.17], roughness: 0.88, emission: 0.12, lightResponse: 0.6 },
    options, 0.9, 0.5, '#');
  const tool = resolveMaterial(entity,
    { color: [0.5, 0.5, 0.53], roughness: 0.5, emission: 0.14, lightResponse: 0.9 },
    options, 0.15, 0.5, '-');
  const lamp = resolveMaterial(entity,
    { color: [1, 0.82, 0.55], roughness: 0.3, emission: 0.08 + 1.05 * glow, lightResponse: 0.2 },
    // NOT one of the accent chars ('☼' '=' '◆' '!'): those carry an
    // emission floor of 0.9, which would light this strip on the very pose
    // whose whole job is to leave it dark.
    options, 0.1, 0.5, '▒');

  // The top: one slab, overhanging its legs at both ends.
  addLocalBox(vertices, basis, [0, 0, TOP], [0.3, 0.58, 0.038], plank);
  // Four legs, inset so the overhang reads.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      addLocalBox(vertices, basis,
        [sx * 0.22, sy * 0.46, 0.5 - 0.34], [0.045, 0.045, 0.34], frame);
    }
  }
  // A rail tying the legs, low - it is what stops the gap reading as empty air.
  addLocalBox(vertices, basis, [0, 0, 0.5 - 0.14], [0.032, 0.46, 0.032], frame);

  // The back board, and the tools on it. This is the half that says WORK.
  addLocalBox(vertices, basis, [-0.26, 0, TOP - 0.24], [0.03, 0.54, 0.24], plank);
  if (full) {
    for (const [at, len] of [[-0.3, 0.1], [-0.08, 0.14], [0.16, 0.08], [0.34, 0.12]]) {
      addLocalSegment(vertices, basis,
        [-0.225, at, TOP - 0.4], [-0.225, at, TOP - 0.4 + len],
        0.016, 0.012, tool, 4);
    }
  }
  // The vice, clamped on one end of the top.
  addLocalBox(vertices, basis, [0.02, -0.5, TOP - 0.07], [0.09, 0.07, 0.07], tool);

  // The strip under the back board: the only thing the pose moves.
  addLocalBox(vertices, basis, [-0.2, 0, TOP - 0.045], [0.02, 0.42, 0.018], lamp);

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * THE COSMETIC POST: 1.5 across, 1.0 tall. A salvaged mannequin stand where
 * the operative's livery gets changed.
 *
 * It has to read as a STAND WITH SOMETHING ON IT rather than as another bench,
 * and at this size the only reliable difference is the cross-arm: a horizontal
 * bar high up with nothing under it. That negative space under the arm is the
 * whole silhouette.
 */
export function buildCosmeticPostMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'cosmetic_post', currentTime, { lod });
  const glow = Number.isFinite(motion.pose.lampGlow) ? motion.pose.lampGlow : 1;

  const post = resolveMaterial(entity,
    { color: [0.26, 0.23, 0.2], roughness: 0.9, emission: 0.13, lightResponse: 0.7 },
    options, 0.6, 0.5, '#');
  const cloth = resolveMaterial(entity,
    { color: [0.38, 0.3, 0.26], roughness: 0.95, emission: 0.14, lightResponse: 0.85 },
    options, 0.3);
  const pin = resolveMaterial(entity,
    { color: [0.9, 0.72, 0.42], roughness: 0.35, emission: 0.1 + 0.9 * glow, lightResponse: 0.3 },
    options, 0.1, 0.5, '▒');

  // A weighted foot, so it does not look like it would fall over.
  addLocalBox(vertices, basis, [0, 0, 0.5 - 0.05], [0.2, 0.24, 0.05], post);
  // The mast.
  addLocalSegment(vertices, basis,
    [0, 0, 0.5 - 0.09], [0, 0, 0.5 - 0.78], 0.05, 0.035, post, full ? 7 : 5);
  // THE CROSS-ARM, which is the silhouette. Nothing under it.
  addLocalBox(vertices, basis, [0, 0, 0.5 - 0.8], [0.035, 0.42, 0.028], post);
  // Cloth hung over the arm on both sides - a livery waiting to be worn.
  for (const side of [-1, 1]) {
    addLocalBox(vertices, basis,
      [0, side * 0.28, 0.5 - 0.68], [0.055, 0.11, 0.11], cloth);
  }
  // A shoulder block on top, so the arm terminates in something.
  addLocalEllipsoid(vertices, basis, [0, 0, 0.5 - 0.86],
    [0.07, 0.09, 0.05], cloth, full ? 6 : 4, full ? 4 : 3);
  // The pin light that says this track is unlocked.
  addLocalBox(vertices, basis, [0.05, 0, 0.5 - 0.9], [0.016, 0.02, 0.016], pin);

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * THE SHELTER SCREEN: 1.6 across, 1.15 tall. The terminal that carries the
 * lore, mounted on the wall.
 *
 * Wall-mounted, so unlike the bench and the post this one has NO legs and its
 * mass is all in the top half - the caller places it at the height the old
 * billboard hung at and the bracket does the rest. Built so the face is a
 * shallow box rather than a plane: a screen seen from the side is the one that
 * gives a billboard away fastest, because a real one has a back.
 *
 * Poses unread/read change the face's emission only. A shelter with something
 * new on the terminal should be visible from across the room without the
 * player having to be told, and dimming it once read is how the room stops
 * asking.
 */
export function buildShelterScreenMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'shelter_screen', currentTime, { lod });
  const glow = Number.isFinite(motion.pose.screenGlow) ? motion.pose.screenGlow : 1;

  const shell = resolveMaterial(entity,
    { color: [0.22, 0.22, 0.24], roughness: 0.8, emission: 0.12, lightResponse: 0.6 },
    options, 0.8, 0.5, '#');
  const face = resolveMaterial(entity,
    { color: [0.45, 0.78, 0.82], roughness: 0.25, emission: 0.12 + 0.95 * glow, lightResponse: 0.25 },
    options, 0.35, 0.5, '\u2593');
  const cable = resolveMaterial(entity,
    { color: [0.16, 0.15, 0.14], roughness: 0.9, emission: 0.08, lightResponse: 0.5 },
    options, 0.95, 0.5, '-');

  // The housing: a shallow box, deeper at the bottom where the guts are.
  addLocalBox(vertices, basis, [0, 0, 0.5 - 0.72], [0.075, 0.62, 0.34], shell);
  // The face, proud of the housing so it catches an edge from the side.
  addLocalBox(vertices, basis, [0.085, 0, 0.5 - 0.74], [0.018, 0.54, 0.27], face);
  // A hood over it - this is a wet cave and somebody thought about that.
  addLocalBox(vertices, basis, [0.06, 0, 0.5 - 1.05], [0.06, 0.6, 0.03], shell);
  // The bracket into the wall, and the feed dropping out of the bottom.
  addLocalBox(vertices, basis, [-0.1, 0, 0.5 - 0.72], [0.035, 0.16, 0.1], shell);
  if (full) {
    addLocalSegment(vertices, basis,
      [-0.02, 0.1, 0.5 - 0.38], [0.02, 0.24, 0.5 - 0.02], 0.022, 0.018, cable, 5);
  }

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * THE COT: 1.52 long, 1.05 tall including the bedding heaped on it.
 *
 * A LYING-DOWN OBJECT, which is the hardest kind to sell flat - a billboard of
 * a bed is a rectangle, and a rectangle at this scale is a crate. What makes
 * it a bed is that the mattress line is LOW and the thing is long, with air
 * under it and a heap at one end where the blanket is pushed back. Somebody
 * got up and did not make it.
 */
export function buildCotMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'cot', currentTime, { lod });

  const frame = resolveMaterial(entity,
    { color: [0.24, 0.21, 0.19], roughness: 0.88, emission: 0.12, lightResponse: 0.6 },
    options, 0.9, 0.5, '#');
  const canvas = resolveMaterial(entity,
    { color: [0.45, 0.38, 0.3], roughness: 0.95, emission: 0.16, lightResponse: 0.85 },
    options, 0.4);
  const blanket = resolveMaterial(entity,
    { color: [0.34, 0.26, 0.24], roughness: 0.97, emission: 0.14, lightResponse: 0.8 },
    options, 0.2, 0.5, '-');

  const DECK = 0.5 - 0.34;
  // Four short legs and the rails they carry. Low: a camp cot, not a bed.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      addLocalSegment(vertices, basis,
        [sx * 0.2, sy * 0.62, 0.5], [sx * 0.16, sy * 0.6, DECK],
        0.028, 0.024, frame, full ? 5 : 3);
    }
  }
  for (const sx of [-1, 1]) {
    addLocalBox(vertices, basis, [sx * 0.17, 0, DECK], [0.028, 0.68, 0.026], frame);
  }
  // The mattress: thin, sagging in the middle, which is what says slept-in.
  addLocalBox(vertices, basis, [0, 0, DECK - 0.05], [0.2, 0.66, 0.05], canvas);
  addLocalBox(vertices, basis, [0, 0, DECK - 0.035], [0.17, 0.3, 0.03], canvas);
  // The blanket, heaped at one end and trailing off the side.
  addLocalEllipsoid(vertices, basis, [0.02, 0.4, DECK - 0.13],
    [0.19, 0.22, 0.09], blanket, full ? 7 : 5, full ? 5 : 3);
  if (full) {
    addLocalBox(vertices, basis, [0.06, 0.06, DECK - 0.075], [0.15, 0.28, 0.028], blanket);
    // A corner hanging over the rail, nearly to the floor.
    addLocalBox(vertices, basis, [0.2, -0.3, DECK + 0.12], [0.02, 0.14, 0.14], blanket);
  }
  // The pillow, such as it is.
  addLocalEllipsoid(vertices, basis, [-0.02, -0.52, DECK - 0.1],
    [0.13, 0.13, 0.06], canvas, full ? 6 : 4, full ? 4 : 3);

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * THE BRAZIER: 1.09 across, 0.95 tall. The only fire in the game.
 *
 * A bowl on splayed legs with coals in it. The splay matters more than it
 * sounds: three straight legs read as a table, three RAKED legs read as a
 * stand, and this needs to be the thing you put a fire in rather than the
 * thing you put a cup on.
 *
 * Poses lit/cold drive the coals and nothing else. The bowl, the legs and the
 * silhouette are identical either way - a dead hearth is this hearth, out.
 */
export function buildBrazierMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'brazier', currentTime, { lod });
  const heat = Number.isFinite(motion.pose.coalGlow) ? motion.pose.coalGlow : 1;

  const iron = resolveMaterial(entity,
    { color: [0.2, 0.18, 0.17], roughness: 0.9, emission: 0.1, lightResponse: 0.55 },
    options, 0.8, 0.5, '#');
  const coal = resolveLampElement(resolveMaterial(entity,
    { color: [1, 0.52, 0.2], roughness: 0.6, emission: 1.25, lightResponse: 0.15 },
    options, 0.25, 0.5, '\u2592'), heat, 0.6);
  const ash = resolveMaterial(entity,
    { color: [0.26, 0.24, 0.23], roughness: 0.98, emission: 0.08, lightResponse: 0.6 },
    options, 0.35, 0.5, '-');

  const RIM = 0.5 - 0.62;
  /**
   * A RAKED LEG DOES NOT MEET THE FLOOR WHERE ITS CENTRELINE DOES.
   *
   * addLocalSegment caps the end perpendicular to the segment AXIS, so a leg
   * that leans dips below its own endpoint by radius x sin(rake). These lean
   * 0.19 out over 0.56 of rise - sin 0.3213 - and carry a 0.035 foot, so a
   * centreline planted exactly on the floor plane put 0.0113 of iron through
   * the floor. The archetype floor-plane test caught it at -0.0111.
   *
   * Lifting the centreline by that much lands the LOWEST point of the tilted
   * cap on the floor, which is where a leg actually stands. Kept as arithmetic
   * rather than a tuned constant so that changing the rake or the foot radius
   * does not silently re-bury it.
   */
  const FOOT_RADIUS = 0.035;
  const RAKE_SIN = 0.19 / Math.hypot(0.19, 0.56);
  const FOOT_Z = 0.5 - FOOT_RADIUS * RAKE_SIN;
  // Three raked legs.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    addLocalSegment(vertices, basis,
      [Math.cos(a) * 0.3, Math.sin(a) * 0.3, FOOT_Z],
      [Math.cos(a) * 0.11, Math.sin(a) * 0.11, RIM + 0.06],
      FOOT_RADIUS, 0.026, iron, full ? 5 : 3);
  }
  // The bowl: a ring for the rim and a shallow pan under it.
  addLocalRing(vertices, basis, [0, 0, RIM], 0.29, 0.035, iron, full ? 12 : 7);
  addLocalEllipsoid(vertices, basis, [0, 0, RIM + 0.07],
    [0.27, 0.27, 0.1], iron, full ? 10 : 6, full ? 4 : 3);
  // Ash bed, then a raised coal mound visible above the pan and rim.
  addLocalEllipsoid(vertices, basis, [0, 0, RIM + 0.015],
    [0.22, 0.22, 0.04], ash, full ? 8 : 5, full ? 3 : 2);
  const COALS = [[0.07, 0.03, 0.05], [-0.09, 0.06, 0.045], [0.02, -0.1, 0.05],
    [-0.03, -0.02, 0.055], [0.12, -0.06, 0.038]];
  for (const [cx, cy, r] of (full ? COALS : COALS.slice(0, 3))) {
    addLocalEllipsoid(vertices, basis, [cx, cy, RIM - 0.055],
      [r, r * 0.9, r * 0.7], coal, full ? 5 : 4, 3);
  }

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * THE CHUTE: 1.08 across, 3.4 tall. The way out, and the only exit.
 *
 * It has to read as SOMETHING YOU CLIMB from anywhere in the hall, which the
 * billboard did by being a tall pale stripe. A mesh can do better and has to:
 * this is the object the room's whole guide text points at.
 *
 * So it is a lined shaft with rungs, and the rungs are the point - a ladder is
 * the one shape that says climbable without a word. They are spaced far enough
 * apart to survive glyph scale; closer together they merge into a post.
 */
export function buildChuteMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'chute', currentTime, { lod });

  const lining = resolveMaterial(entity,
    { color: [0.27, 0.25, 0.23], roughness: 0.92, emission: 0.12, lightResponse: 0.65 },
    options, 0.7, 0.5, '#');
  const rung = resolveMaterial(entity,
    { color: [0.44, 0.4, 0.36], roughness: 0.7, emission: 0.2, lightResponse: 0.85 },
    options, 0.3, 0.5, '-');

  // Two uprights running the full height, and a back plate between them.
  for (const side of [-1, 1]) {
    addLocalSegment(vertices, basis,
      [0, side * 0.2, 0.5], [0, side * 0.2, 0.5 - 3.4],
      0.05, 0.045, lining, full ? 6 : 4);
  }
  addLocalBox(vertices, basis, [-0.13, 0, 0.5 - 1.7], [0.05, 0.26, 1.7], lining);
  // THE RUNGS. 0.34 apart: ten of them over 3.4, which at this room's scale is
  // a rung every third of a metre - far enough that they stay separate cells.
  const step = full ? 0.34 : 0.68;
  for (let z = 0.5 - 0.3; z > 0.5 - 3.4; z -= step) {
    addLocalSegment(vertices, basis, [0.02, -0.2, z], [0.02, 0.2, z], 0.028, 0.028, rung, 4);
  }
  // A collar at the mouth, so the top terminates instead of stopping.
  addLocalRing(vertices, basis, [0, 0, 0.5 - 3.4], 0.28, 0.04, lining, full ? 10 : 6);

  return finishMesh(vertices, lod, motion.animation);
}

/**
 * A STAPLED CABLE RUN: 1.8 across, 0.75 of sag.
 *
 * Somebody ran power down here and did it badly. The sag is the whole read -
 * a straight line is conduit, a hanging curve is a cable somebody nailed up in
 * a hurry - so the segments follow a catenary rather than a straight run, and
 * the staples are the fixed points it sags between.
 */
export function buildCableRunMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'cable_run', currentTime, { lod });

  const line = resolveMaterial(entity,
    { color: [0.17, 0.15, 0.13], roughness: 0.95, emission: 0.1, lightResponse: 0.55 },
    options, 0.5);
  const staple = resolveMaterial(entity,
    { color: [0.42, 0.38, 0.33], roughness: 0.7, emission: 0.16, lightResponse: 0.8 },
    options, 0.15, 0.5, '-');

  // A catenary with high endpoints at the staples and a low midpoint.
  const TOP = 0.5 - 0.72;
  const sag = y => TOP + 0.55 * (Math.cos((y / 0.9) * 1.25) - Math.cos(1.25)) / (1 - Math.cos(1.25));
  const steps = full ? 8 : 4;
  for (let i = 0; i < steps; i++) {
    const y0 = -0.9 + (1.8 * i) / steps;
    const y1 = -0.9 + (1.8 * (i + 1)) / steps;
    addLocalSegment(vertices, basis, [0, y0, sag(y0)], [0, y1, sag(y1)],
      0.03, 0.03, line, full ? 5 : 3);
  }
  for (const at of [-0.9, 0.9]) {
    addLocalBox(vertices, basis, [-0.02, at, TOP - 0.02], [0.05, 0.045, 0.045], staple);
  }

  return finishMesh(vertices, lod, motion.animation);
}

export function buildLanternMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'lantern', currentTime, { lod });
  const lampGlow = Number.isFinite(motion.pose.lampGlow) ? motion.pose.lampGlow : 1;

  const housing = resolveMaterial(entity,
    { color: [0.32, 0.29, 0.25], roughness: 0.7, emission: 0.24, lightResponse: 0.5 },
    options, 0.35);
  const collar = resolveMaterial(entity,
    { color: [0.19, 0.18, 0.17], roughness: 0.85, emission: 0.2, lightResponse: 0.45 },
    options, 0.9, 0.5, '#');
  const hanger = resolveMaterial(entity,
    { color: [0.28, 0.27, 0.26], roughness: 0.65, emission: 0.22, lightResponse: 0.5 },
    options, 0.05, 0.5, '-');
  const glow = resolveLampElement(resolveMaterial(entity,
    { color: [1, 0.72, 0.34], roughness: 0.14, emission: 1, lightResponse: 0 },
    options, 0.55, 0.5, '☼'), lampGlow, 0.5);

  // Base plate: the ground-contact face, and the dark underside that keeps the
  // glow from bleeding into the pavement below it.
  addLocalBox(vertices, basis, [0, 0, 0.478], [0.075, 0.075, 0.022], collar);
  // The lit element — the whole point of the object.
  addLocalEllipsoid(vertices, basis, [0, 0, 0.355], [0.088, 0.088, 0.105], glow, full ? 8 : 6, full ? 5 : 4);
  // Hood, WIDER than the glow, and a finial above it.
  addLocalBox(vertices, basis, [0, 0, 0.225], [0.115, 0.115, 0.028], housing);
  addLocalBox(vertices, basis, [0, 0, 0.185], [0.055, 0.055, 0.022], housing);
  // Hanger rod and the eyelet the wire threads. Eight segments at BOTH LODs:
  // the eyelet is the crown of the silhouette, so letting the LOD change its
  // tessellation would change the object's height as the camera walks away.
  addLocalSegment(vertices, basis, [0, 0, 0.19], [0, 0, 0.05], 0.018, 0.014, hanger, full ? 6 : 4);
  addLocalRing(vertices, basis, [0, 0, 0.05], 0.036, 0.013, hanger, 8, 'y');

  if (full) {
    // Corner ribs pinning the element inside the housing, and a collar band.
    for (const cornerX of [-1, 1]) {
      for (const cornerY of [-1, 1]) {
        addLocalSegment(vertices, basis,
          [cornerX * 0.082, cornerY * 0.082, 0.245], [cornerX * 0.062, cornerY * 0.062, 0.462],
          0.013, 0.011, housing, 4);
      }
    }
    addLocalBox(vertices, basis, [0, 0, 0.208], [0.072, 0.072, 0.012], collar);
  }

  return finishMesh(vertices, lod, {
    archetype: 'lantern',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    lampGlow,
    chassis: 'hung-market-lantern'
  });
}

/**
 * Vent steam plume (Beyond Dawn's road hazard). A rising, writhing column of
 * vapour standing on the vent plate: 2.2 cells across at the ground and 2.6
 * cells tall.
 *
 * WHY IT IS A MESH AT ALL. It shipped as a camera-facing sprite card and a
 * playtest caught it in one sentence — "the steam vent animation is 2D".
 * Vapour is the worst possible billboard subject: a wall sign at least has a
 * real facing to be wrong about, but a plume has no facing, so a card that
 * swivels to track the player announces itself as a card the moment anyone
 * walks a circle around a firing vent. Every other dynamic thing in that city
 * is already a volume; this was the last one.
 *
 * THE FOOTPRINT IS THE HAZARD, so the ground roll is welded to the plate.
 * The game's rule is "the burn is exactly the plate you can see" — the vent's
 * hurt radius, the slotted plate decal and this plume are all 2.2 cells across
 * and a test on the game side pins it. So the three ground lobes are anchored
 * with their undersides ON the floor plane and get NO lateral drift at all:
 * they breathe in and out but they never wander off the plate. Everything
 * above them may sway, because nothing above them is a promise about where it
 * is safe to stand.
 *
 * WHY THE WIDEST PART IS AT THE BOTTOM. A textbook plume is narrow at the
 * mouth and spreads as it climbs, and that shape would have been a lie here in
 * two ways: it would put the widest silhouette over the player's head where
 * it cannot be stood next to, and it would make the visible thing WIDER than
 * the burn instead of equal to it. Real vent steam does spread across its own
 * grate before buoyancy takes it, so the honest shape and the readable shape
 * agree: a wide low roll on the plate, a throat, then a tapering column that
 * tears apart at the crown.
 *
 * THE SILHOUETTE HAS TO CHANGE WHEN YOU WALK AROUND IT — the tree canopy's
 * lesson, and a column is a harder case than a crown because a stack of
 * ellipsoids on one axis is a plate seen from every bearing, which would have
 * solved nothing. Three things buy the volume:
 *
 *   1. THE COLUMN SNAKES. Every billow is offset off-axis, and consecutive
 *      offsets point different ways (roughly a slow helix up the column), so
 *      the outline leans one way at knee height and the other at head height.
 *      Walk a quarter circle and those leans swap sides — the single cue a
 *      card can never fake.
 *   2. THE CROWN IS OFF-AXIS. The topmost lobe sits out at 0.38 cells from
 *      the axis, so the highest point of the silhouette moves ACROSS the
 *      column as the bearing changes rather than sitting over its middle.
 *   3. THE GROUND ROLL IS RAGGED. Its three lobes crest at −0.10, −0.22 and
 *      −0.38, so the line where the roll gives way to the column is a
 *      different height in every direction. That line is what a player at
 *      street level actually looks at.
 *
 * VAPOUR SCATTERS LIGHT, IT DOES NOT GLOW — and this is the one place in the
 * file where getting that backwards is expensive. The sprite it replaces had
 * already been through a blow-out: at the full 2.2 footprint the original
 * density and emission whited out the entire frame from four units away and
 * took the street behind it, and the fix was to make the card sparse (emission
 * 0.1 and 0.22) and to drop the vent light 1.3 -> 0.85. A volume is far denser
 * than a sparse card, so it would blow out far more easily, and it has to buy
 * its brightness a different way:
 *
 *   - EMISSION IS THE LOWEST IN THIS FILE (0.04 / 0.06 / 0.12 against a street
 *     bench's 0.22). Sub-cliff emission adds `albedo * emission` straight into
 *     the light buffer with nothing attenuating it, so on a mass this size it
 *     is pure unearned brightness. What little there is exists only so an
 *     unlit plume is a dim shape rather than a hole.
 *   - LIGHT RESPONSE IS THE HIGHEST IN THIS FILE (0.86..0.95 against 0.5).
 *     Read `lightFS`: `diffuseSurface = mix(vec3(1.0), albedo, lightResponse)`,
 *     so lightResponse is how much of its OWN colour a surface imposes on the
 *     light it returns. At 0 a surface hands back the lamp at full strength —
 *     which is exactly the white-out — and at ~0.9 with a mid-grey albedo it
 *     hands back about a third of it, tinted. The vent's own light still
 *     decides the colour, which is what makes the plume read warm during the
 *     telegraph and near-white during the blast without one authored number
 *     changing, and it means the plume genuinely goes dark when nothing is
 *     lighting it. Steam in an unlit street should be a grey mass.
 *   - THE ALBEDO IS MID-GREY, not white. The light is 1 cell inside the plume;
 *     a white albedo there is a white frame.
 *
 * OPACITY IS WORTH USING HERE more than anywhere else in the file. A snapshot
 * entity's `opacity` thins the built mesh by triangle (the deferred path has
 * no alpha), and a half-dissolved cloud is a genuinely better cloud — the game
 * can fade a plume out over the end of the blast instead of deleting it.
 */

/** Longitude segments per billow, FROZEN ACROSS BOTH LODS on purpose.
 *
 *  A polygonal ellipsoid only touches its analytic envelope where a sample
 *  angle lands on a cardinal direction, and 8 is the smallest count divisible
 *  by four — so ±x and ±y are hit exactly and the plume measures its authored
 *  2.2 at both LODs to the float. Let the LOD ladder change this and the
 *  outline shrinks by up to 10% at the swap, which is the pop the ladder
 *  exists to avoid. The ladder spends its budget on latitude bands and on the
 *  interior wisps instead, neither of which touches the outline. */
const PLUME_LONGITUDES = 8;

/** Latitude bands on the three ground lobes, ALSO frozen across both LODs, and
 *  for the same reason one step further: the roll is the footprint. Measured,
 *  the LOD ladder's biggest outline disagreement was at the base of the roll —
 *  a flattened ellipsoid cut a twentieth of a cell above its own south pole is
 *  where four facets and six facets differ most — and that is the one place
 *  the plume is making a promise about where the burn is. Six bands on three
 *  lobes costs 288 vertices at the simplified LOD and takes the disagreement
 *  there from 0.19 cells to nothing. */
const PLUME_ROLL_LATITUDES = 6;

/** Radians of boil phase each billow lags the one below it. The lag is what
 *  makes crests travel UP the column instead of the whole thing pulsing as one
 *  lump — a lobe reaches its peak later the higher it sits. */
const PLUME_CHURN_LAG = 0.62;

/** Radians the lateral sway direction turns per billow. Coprime-ish with the
 *  lag on purpose: sway direction and boil phase must not come back into step
 *  every few lobes, or the column develops a visible period. */
const PLUME_SWAY_TURN = 1.9;

/** The ground roll boils at less than half the column's depth. It is the
 *  hazard marker, and a marker that breathes as hard as the plume above it
 *  spends a third of its cycle looking smaller than the burn it stands for. */
const PLUME_ROLL_CHURN_SHARE = 0.45;

export function buildSteamPlumeMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'steam_plume', currentTime, { lod });
  const pose = motion.pose;
  const rise = clamp(Number.isFinite(pose.plumeRise) ? pose.plumeRise : 1, 0, 1);
  const swell = clamp(Number.isFinite(pose.plumeSwell) ? pose.plumeSwell : 1, 0, 1);
  const billow = Math.max(0, pose.billow || 0);
  const surge = Math.max(0, pose.surge || 0);
  const churnRate = pose.churnRate || 0;
  const churnDepth = clamp(pose.churnDepth || 0, 0, 0.6);
  // Driven by currentTime, NOT by the animation track's accumulated gait
  // cycle. A vent that has just started firing must look the same as one that
  // has been firing all night — a hazard whose telegraph is mid-ramp because
  // its entity is young is a hazard that lies to a player about how long they
  // have. Same reason the 650 ms spawn ramp is left unused here.
  const clock = motion.timeSeconds * churnRate + motion.phase;
  const latitudes = full ? 6 : 4;

  const vapour = resolveMaterial(entity,
    { color: [0.34, 0.37, 0.42], roughness: 0.97, emission: 0.06, lightResponse: 0.92 },
    options, 0.5);
  const crest = resolveMaterial(entity,
    { color: [0.5, 0.55, 0.62], roughness: 0.94, emission: 0.12, lightResponse: 0.86 },
    options, 0.12, 0.5, '^');
  const roll = resolveMaterial(entity,
    { color: [0.26, 0.28, 0.32], roughness: 0.98, emission: 0.04, lightResponse: 0.95 },
    options, 0.92, 0.5, '~');

  /**
   * One billow of the column. `order` is its rank up the plume and does two
   * jobs at once: it lags the boil (so crests climb) and it turns the sway
   * direction (so consecutive billows lean different ways).
   *
   * BOTH MODULATIONS ARE ONE-SIDED. `ebb` is `0.5 + 0.5 * wave`, which is 0..1
   * and never negative, and it only ever SHRINKS a lobe and only ever SINKS
   * it. That is not a stylistic choice — it is what makes the authored numbers
   * a true bounding envelope rather than an average. `nativeHeight` and
   * `nativeFootprint` are what the game sizes its beyond-LOD billboard and its
   * hazard art against, so a plume that could exceed them on some frame would
   * be a plume whose billboard is too small on that frame.
   */
  const addBillow = (order, center, radii, material, bands = latitudes) => {
    const wave = Math.sin(clock - order * PLUME_CHURN_LAG);
    const ebb = 0.5 + 0.5 * wave;
    const size = swell * (1 - churnDepth * ebb);
    const drift = billow * wave;
    const swayAngle = order * PLUME_SWAY_TURN + motion.phase;
    addLocalEllipsoid(vertices, basis, [
      center[0] * swell + Math.cos(swayAngle) * drift,
      center[1] * swell + Math.sin(swayAngle) * drift,
      // Renderer z is DOWN, so `+ surge * ebb` sags the lobe from its authored
      // height and the authored height is its ceiling.
      0.5 - (0.5 - center[2]) * rise + surge * ebb
    ], [radii[0] * size, radii[1] * size, radii[2] * size], material, PLUME_LONGITUDES, bands);
  };

  /**
   * One lobe of the ground roll. Same boil, three differences, all of them the
   * footprint contract: no lateral drift, a shallower depth, and the lobe's
   * UNDERSIDE rather than its centre is placed — welded to the floor plane at
   * every pose, every phase of the cycle and both LODs, so the plume never
   * lifts off the plate it is a warning about.
   */
  const addRollLobe = (order, center, radii, material) => {
    const wave = Math.sin(clock - order * PLUME_CHURN_LAG);
    const ebb = 0.5 + 0.5 * wave;
    const size = swell * (1 - churnDepth * PLUME_ROLL_CHURN_SHARE * ebb);
    const halfDepth = radii[2] * size;
    addLocalEllipsoid(vertices, basis,
      [center[0] * swell, center[1] * swell, 0.5 - halfDepth],
      [radii[0] * size, radii[1] * size, halfDepth], material, PLUME_LONGITUDES, PLUME_ROLL_LATITUDES);
  };

  // GROUND ROLL. The first lobe is centred on the entity and carries the whole
  // 2.2-cell footprint by itself — centred means no heading can rotate it out
  // past the plate, which a lobe on an offset cannot promise. The other two
  // are humps riding on it: they stay well inside its width and exist to break
  // the crest line, which is the part of the roll a standing player sees.
  addRollLobe(0, [0, 0, 0], [1.1, 0.96, 0.3], roll);
  addRollLobe(1, [0.34, -0.3, 0], [0.58, 0.62, 0.44], roll);
  addRollLobe(2, [-0.4, 0.26, 0], [0.56, 0.6, 0.36], roll);

  // THE COLUMN. Measured, its outline runs ~0.9 cells across at the throat
  // just above the roll, ~1.4 through the middle where consecutive billows
  // lean furthest apart, and back to ~0.9 at the crown. That waist-bulge-tear
  // profile is what a column of vapour does, and it is why the lobe RADII
  // barely change while the OFFSETS do all the work: a taper cut by shrinking
  // radii would thin to a stick, and a stick is the one shape that cannot
  // survive a glyph cell. Each offset also points somewhere new — that is the
  // snake, and the snake is the whole volume cue.
  addBillow(3, [0.12, -0.06, -0.3], [0.44, 0.42, 0.34], vapour);
  addBillow(4, [-0.2, 0.14, -0.62], [0.42, 0.46, 0.32], vapour);
  addBillow(5, [0.26, 0.22, -0.95], [0.48, 0.44, 0.34], vapour);
  addBillow(6, [-0.14, -0.32, -1.26], [0.46, 0.5, 0.34], vapour);
  addBillow(7, [0.3, -0.1, -1.55], [0.5, 0.46, 0.32], vapour);

  // THE CROWN, in the lighter tone: the part that has climbed clear of the
  // plate and is tearing into separate masses. Three lobes leaning three ways,
  // the last of them the top of the silhouette at exactly 2.6 cells up and
  // deliberately off-axis, so the plume's high point slides across the column
  // as the camera walks around it instead of sitting over the middle.
  addBillow(8, [-0.28, 0.2, -1.76], [0.52, 0.48, 0.32], crest);
  addBillow(9, [0.24, 0.34, -1.8], [0.46, 0.5, 0.28], crest);
  addBillow(10, [0.3, 0.24, -1.78], [0.42, 0.44, 0.32], crest);

  if (full) {
    // The full LOD's entire job is to CLOSE THE THROATS between billows, not
    // to add outline. Each of these sits at a waist between two column lobes
    // and within 0.25 cells of the axis — comfortably inside the simplified
    // silhouette from every bearing — so the LOD swap changes how solid the
    // column looks up close and never changes its shape. That is the same
    // contract the tree canopy's close-up lobes keep, and it matters more
    // here: the swap happens while the thing is animating.
    //
    // Four latitude bands each even at full LOD, where the column's own lobes
    // take six: nothing that is never on the outline earns the smoother
    // profile, and eleven big lobes is already twice a tree canopy's cost.
    addBillow(3.5, [-0.04, 0.04, -0.46], [0.3, 0.28, 0.22], vapour, 4);
    addBillow(4.5, [0.04, 0.2, -0.79], [0.3, 0.3, 0.22], vapour, 4);
    addBillow(5.5, [0.08, -0.06, -1.1], [0.3, 0.28, 0.22], vapour, 4);
    addBillow(6.5, [0.1, -0.22, -1.41], [0.3, 0.3, 0.22], vapour, 4);
    addBillow(7.5, [0, 0.06, -1.68], [0.28, 0.28, 0.22], vapour, 4);
  }

  return finishMesh(vertices, lod, {
    archetype: 'steam_plume',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    plumeRise: rise,
    plumeSwell: swell,
    chassis: 'vent-steam-plume'
  });
}

/**
 * Arc bolt (Beyond Dawn's discharge tool). A jagged, branching bolt that
 * leaves an emitter at the entity's own x/y and terminates 3.5 cells along its
 * heading: an envelope 3.86 cells long and 1.16 across, with the bolt's axis
 * running through the middle of that cross-section.
 *
 * IT IS A LIGHT SOURCE, NOT A LIT SURFACE. Every material here is authored at
 * emission 1 — the deferred shader's pure-emissive branch (`isSelfLuminous >
 * 0.95`), where albedo IS the light and nothing dims it. That is the opposite
 * end of the file from `steam_plume`, which is authored at the lowest emission
 * in the set precisely so the vent's lamp decides its colour; a bolt that took
 * scene light would be a grey rope in an unlit street, and the player's one
 * offensive tool would be invisible at the moment it fires. The consequence to
 * plan around is the mirror image of the plume's: nothing outside this mesh
 * changes how bright it is, so a game that wants the discharge to LIGHT the
 * street must add a scene light alongside the entity (Beyond Dawn already has
 * one — `arc-flash`).
 *
 * BRIGHTNESS IS THE ONLY KNOB FOR THINNESS, and this is the constraint that
 * shapes the whole archetype. The renderer SAMPLES: the default `legacy` glyph
 * pipeline takes one scene tap per glyph cell, so geometry narrower than the
 * tap spacing does not dim, it strobes in and out between frames. The bar the
 * built-ins are authored to is 0.15 cells of cross-section (see the thin-fixture
 * note in docs/API.md; `street_lamp`'s mast and `antenna_mast`'s spine are both
 * authored roughly three times scale-honest to clear it). A lightning bolt is
 * the thinnest thing anyone would try to build in this engine, so it is the one
 * most likely to vanish — and the answer is NOT to author it thin and hope.
 * Every tube here is at or over the bar. Quoted at the SIMPLIFIED LOD, whose
 * 5-sided tubes inscribe their authored radius tighter than the full LOD's
 * 8-sided ones and are therefore the binding case (1.809r against 1.848r):
 *
 *   spine   0.125 -> 0.100 radius, 0.226 -> 0.181 cells of inscribed width
 *   forks   0.100 -> 0.090 radius, 0.181 -> 0.163 cells
 *   beads   0.105 radius floor,    0.159 cells at the bottom of the flicker
 *
 * The bolt gets its THINNESS from the material instead: the spine is near-white
 * and the forks are a much darker blue, at the same physical width. In the
 * pure-emissive branch albedo is luminance directly, so a darker fork resolves
 * to a fainter glyph in the same column — which is what "thin" means to a cell
 * shader. It also gets thinness from TAPER (a fifth of the spine's width is
 * spent between the emitter and the terminus) and from perspective, which does
 * more work here than on any other archetype: this thing is always viewed from
 * its own root, so the far end is always the far end.
 *
 * The scale-invariance is worth stating, because it is what makes the bar hold
 * at every reach the game will ask for. A bolt shortened to a 1-cell contact is
 * scaled to 0.29, so its tip is 0.052 cells across — but it is also being
 * viewed from 1 cell away instead of 3.5. Apparent width is cross-section over
 * distance, and both terms carry the same `scale`, so the ratio is fixed: the
 * tip subtends 0.181 / 3.5 = 0.052 cells of cross-section per cell of range at
 * EVERY reach the game can ask for. Against the demo grid's glyph column of
 * 0.021 * D that is 2.5 columns, and against its coarser rows (~0.035 * D) 1.5
 * rows. The tip is the worst point on the mesh and it still lands on a tap on
 * `legacy`, which is the rung with no partial coverage to fall back on.
 *
 * That is the FIRST-PERSON case, where the emitter is at the camera. The
 * archetype also has to survive being someone else's discharge seen across a
 * street, and there the general bar is what protects it: nothing on this mesh
 * measures under 0.159 cells at either LOD, so a bolt at the far edge of the
 * mesh band is exactly as solid as `street_lamp`'s mast, which is the widest
 * claim any archetype in this file makes.
 *
 * A PATH IS REPLACED, NEVER MOVED. `restrikeRate` chops time into strikes and
 * every jag angle, fork bearing and bead size is a hash of (strike, node). So
 * the mesh is BYTE-IDENTICAL from frame to frame within one strike and
 * completely re-drawn across a strike boundary. Every other archetype in this
 * file evaluates a continuous function of `currentTime`; this one evaluates a
 * step function of it, and that is not a shortcut — an interpolated bolt reads
 * as a hose being waved. The hash is a pure function of the strike index, the
 * node index and the entity's own seeded phase: no `Math.random`, no state, the
 * same bytes on every machine, and two bolts fired at the same instant do not
 * jag in lockstep because their phases differ.
 *
 * THE TWO THINGS A DISCHARGE CAN DO, and the single field that separates them.
 * `ground` is 0 when the bolt hit nothing and 1 when it is connected to
 * something, and it is the only difference between the poses:
 *
 *   - THE TERMINUS STOPS WANDERING. At ground 1 the last spine node sits
 *     exactly on the reach point. That is not cosmetic: the game shortens this
 *     mesh to wherever line of sight actually stops, so the terminus is a
 *     PROMISE about where the bolt was blocked, and a promise that wobbles a
 *     quarter cell off the drone it is grounding into is not one. At ground 0
 *     there is nothing to promise, so the tip wanders with everything else.
 *   - THE STRANDS CONVERGE OR DIVERGE. The same three fray strands leave the
 *     spine three quarters of the way out and end at a radius of 0.105 cells
 *     when grounded — four strands arriving at one point — or 0.445 when not,
 *     which is the bolt coming apart into threads that go nowhere. One number,
 *     two readings, and no geometry added or dropped between the poses.
 *   - THE TERMINATION BLOOMS. The knot at the end doubles in radius when
 *     grounded and its two sparks pull in tight against it; free, it is a last
 *     small bead with its sparks thrown wide.
 *
 * GEOMETRY IS IDENTICAL ACROSS POSES — same vertex count, same order, same
 * materials — for the reason `street_lamp`'s dark pose is: a pose that adds or
 * drops parts cannot be blended, and this one blends in 60 ms.
 *
 * THE EMITTER END KNOWS NOTHING. The root flare and its sparks are the same in
 * both poses on purpose. A rig cannot know what the far end of its own
 * discharge found, and a muzzle that flared brighter for a hit would be the
 * reticle lying to the player again, one step further upstream.
 *
 * PLACEMENT. `z` is ground contact like every archetype in this file, so the
 * envelope's underside sits on the floor plane and the bolt's axis is
 * `ARC_BOLT_AXIS_HEIGHT` above it — the lantern's convention (its base plate is
 * on the plane and its eyelet is the crown) applied to a thing whose useful
 * anchor is neither its top nor its bottom. A game puts the axis at the height
 * the rig fires from with `z = muzzleHeight - ARC_BOLT_AXIS_HEIGHT * scale`,
 * and aims with `heading`, which IS the direction the bolt travels.
 */

/** The distance from the entity to the bolt's TERMINUS, in renderer cells,
 *  along the entity's forward axis. Exported rather than left as prose because
 *  it is the number a game divides by: `scale = contactDistance / REACH` puts
 *  the termination exactly on whatever the shot stopped against.
 *
 *  It is NOT `nativeFootprint`. That number is the full box span, which
 *  includes the root flare sitting behind the emitter and the termination knot
 *  blooming past the contact point; scaling against it would leave every bolt
 *  short of what it hit. 3.5 was chosen to match Beyond Dawn's own `ARC_RANGE`
 *  so a full-range shot registers at scale 1 exactly, the same way the plume's
 *  2.2 footprint matches twice its vent radius. */
export const ARC_BOLT_REACH = 3.5;

/** Height of the bolt's AXIS above the underside of its envelope, in cells.
 *
 *  The envelope is symmetric about the axis by construction — the jag is a
 *  rotation about the forward axis, so whatever it can reach upward it can
 *  reach downward — which makes this exactly half of `nativeHeight`. It is
 *  exported anyway: a game placing a discharge at chest height should not have
 *  to know that halving the registry's height is the right move, and a test
 *  can hold the two numbers together.
 *
 *  THE UNDERSIDE IS A BOUND, NOT A FOOT, and this is the one place where the
 *  file's ground-contact convention is honoured in spirit rather than to the
 *  float. Every other archetype here has something that literally rests on the
 *  floor plane — a plinth, a base plate, a vent roll — and a test pins it at
 *  +0.5 exactly. A bolt has no such part: the lowest thing it can grow is a
 *  fork or a spark that happens to point straight down, and whether one does
 *  on any given frame is a hash. So `z` still means "the underside of what this
 *  entity can occupy", the beyond-LOD billboard's feet anchor still lands
 *  correctly, and the mesh comes within about a hundredth of a cell of the
 *  plane over a sweep without ever crossing it. Measured, not assumed — see the
 *  archetype's envelope test. */
export const ARC_BOLT_AXIS_HEIGHT = 0.58;

/** Segments in the spine, FROZEN ACROSS BOTH LODS. The node count is the
 *  bolt's shape — a five-node path and a nine-node path through the same two
 *  endpoints are different bolts, not the same bolt at two qualities — so the
 *  LOD ladder is not allowed to touch it. It buys its savings from facets
 *  instead (see the builder), which is the same bargain `steam_plume` struck
 *  with its longitude count and for the same reason. */
const ARC_BOLT_SPINE_SEGMENTS = 8;

/** Spine radius at the emitter and at the terminus. The taper is real (a fifth
 *  of the width) but modest on purpose: perspective already narrows this mesh
 *  hard, because it is the one archetype always seen end-on from its own root,
 *  and a geometric taper compounded on top of that thins the tip past the
 *  sampler bar for no visual gain. */
const ARC_BOLT_CORE_ROOT_RADIUS = 0.125;
const ARC_BOLT_CORE_TIP_RADIUS = 0.1;

/** Fork and fray radii. Barely under the spine's — the forks read thinner
 *  because they are DARKER, not because they are narrower, and 0.09 is the
 *  floor at which a 5-sided tube still measures 0.163 cells across. */
const ARC_BOLT_BRANCH_ROOT_RADIUS = 0.1;
const ARC_BOLT_BRANCH_MID_RADIUS = 0.095;
const ARC_BOLT_BRANCH_TIP_RADIUS = 0.09;

/** The most a spine node may stand off the straight line between the emitter
 *  and the terminus. The two poses author 0.24 and 0.26; this is the ceiling
 *  the builder clamps to, and the number the rest of the envelope was chosen
 *  against — the termination knot's and the sparks' radial bounds are both
 *  written as "this plus what they add". */
const ARC_BOLT_MAX_JAG = 0.26;

/** Which spine nodes carry a fork. Not the first, which is inside the flare,
 *  and not the last, which belongs to the termination — a fork at either end
 *  reads as a defect in the emitter or a second contact that did not happen. */
const ARC_BOLT_FORK_NODES = Object.freeze([2, 3, 5, 6]);

/** How far a fork's knee and tip stand off the bolt's axis, and how far along
 *  the bolt they run to get there. RADIAL DISTANCES FROM THE AXIS, not offsets
 *  from the node they leave, so the outermost point of the whole mesh is a
 *  constant no matter where the jag happened to put that node — which is what
 *  makes the envelope arithmetic exact rather than a guess.
 *
 *  0.49 + the 0.09 tip radius is 0.58, which IS the envelope's half-width: the
 *  forks and the termination sparks are the two things that reach it, and
 *  everything else on the mesh is authored comfortably inside. */
const ARC_BOLT_FORK_KNEE_RADIUS = 0.3;
const ARC_BOLT_FORK_TIP_RADIUS = 0.49;
const ARC_BOLT_FORK_KNEE_RUN = 0.19;
const ARC_BOLT_FORK_TIP_RUN = 0.38;

/** The fray: three strands leaving the spine three quarters of the way out and
 *  ending at the reach plane, at a radius that is the whole tell. Grounded they
 *  land inside the termination knot; free they land a third of a cell out and
 *  the bolt has come apart. They are spaced 120 degrees around a hashed bearing
 *  rather than hashed independently — three strands that can land on top of
 *  each other are sometimes one strand. */
const ARC_BOLT_FRAY_NODE = 6;
const ARC_BOLT_FRAY_STRANDS = 3;
const ARC_BOLT_FRAY_CONTACT_RADIUS = 0.105;
const ARC_BOLT_FRAY_LOOSE_RADIUS = 0.34;

/** The emitter flare, the termination knot and its two sparks. Spheres, not
 *  ellipsoids: `addLocalEllipsoid` rotates a lobe's CENTRE into the entity's
 *  basis but leaves its radii on the world axes, so anything elongated here
 *  would keep its long axis pointing north while the bolt turned. */
const ARC_BOLT_FLARE_RADIUS = 0.15;
const ARC_BOLT_KNOT_FREE_RADIUS = 0.105;
const ARC_BOLT_KNOT_GROUND_RADIUS = 0.1;
const ARC_BOLT_SPARKS = 2;
const ARC_BOLT_SPARK_RADIUS = 0.105;
const ARC_BOLT_SPARK_CLUSTER = 0.06;
// 0.26 of terminus jag + 0.215 of scatter + 0.105 of spark = 0.58, the other
// element that reaches the envelope exactly. Spheres, so unlike the forks it
// reaches it in every direction rather than only across its own axis, which is
// what makes the registry's height a number the mesh actually gets to.
const ARC_BOLT_SPARK_SCATTER = 0.155;

/** How much a bead may shrink at the bottom of a strike's flicker. ONE-SIDED,
 *  exactly like the plume's boil: it only ever takes size away, so every
 *  authored radius above is a ceiling and the envelope in the registry is a
 *  bound the mesh cannot exceed on any frame. The floor it leaves (0.82 of
 *  0.105) is still 0.159 cells across, so the flicker never dims a bead by
 *  making it vanish. */
const ARC_BOLT_FLICKER = 0.18;

/** Longitudes on every bead, FROZEN ACROSS BOTH LODS — `steam_plume`'s lesson
 *  restated on a much smaller sphere. A polygonal sphere only touches its
 *  analytic radius where a sample angle lands on a cardinal direction; 8 is the
 *  smallest count divisible by four, so the termination measures the same at
 *  both LODs and the swap cannot shrink the brightest point of the mesh. */
const ARC_BOLT_BEAD_LONGITUDES = 8;

/** The pose blend, in ms, overriding the file-wide 420. See the profile note in
 *  EntityAnimation.js: 420 ms is longer than a bolt's entire life. */
const ARC_BOLT_POSE_SNAP_MS = 60;

/** Salts, so the four hashed quantities of one node cannot correlate. Distinct
 *  primes rather than 0/1/2/3: consecutive salts through an FNV round leave
 *  neighbouring streams visibly related, and a fork bearing that tracked its
 *  node's jag bearing would put every fork on the outside of every kink, which
 *  is a fishbone rather than a bolt. */
const ARC_NOISE_BEARING = 0x9e3779b1;
const ARC_NOISE_FORK_KNEE = 0x85ebca6b;
const ARC_NOISE_FORK_TIP = 0xc2b2ae35;
const ARC_NOISE_FRAY = 0x27d4eb2f;
const ARC_NOISE_BEAD = 0x165667b1;
const ARC_NOISE_SPARK = 0xd3a2646c;
// A spark's SIZE needs its own salt, not its bearing's. Drawing both from one
// call locks the two together — a spark thrown one way is always the big one
// and a spark thrown the other always the small one — and a flicker that is a
// function of direction is a rotating object, not a flicker.
const ARC_NOISE_SPARK_SIZE = 0xfd7046c5;

/**
 * One hashed unit value in [0, 1) for a (strike, index) pair.
 *
 * The same FNV-1a core `seededPhase` above uses, taking integers instead of a
 * string and finished with an avalanche so that the LOW bits of the strike
 * counter — which is what increments 15 times a second — reach the high bits of
 * the result. Without that last mix, consecutive strikes return nearly
 * consecutive values and the bolt precesses smoothly instead of being replaced,
 * which is the exact failure this archetype is built to avoid.
 */
function boltNoise(strike, index, salt) {
  let hash = Math.imul(2166136261 ^ salt, 16777619);
  hash = Math.imul(hash ^ strike, 16777619);
  hash = Math.imul(hash ^ index, 16777619);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

export function buildArcBoltMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'arc_bolt', currentTime, {
    lod,
    transitionMs: ARC_BOLT_POSE_SNAP_MS
  });
  const pose = motion.pose;
  // Clamped rather than trusted. The registry's envelope is arithmetic — every
  // other radius on this mesh was chosen against 0.26 — so a profile that
  // raised it would silently make `nativeHeight` a lie for whatever placed the
  // entity against it, which is the one number a game cannot re-measure at
  // runtime.
  const jag = clamp(Number.isFinite(pose.jag) ? pose.jag : 0, 0, ARC_BOLT_MAX_JAG);
  const ground = clamp(Number.isFinite(pose.ground) ? pose.ground : 0, 0, 1);
  const fork = clamp(Number.isFinite(pose.fork) ? pose.fork : 1, 0, 1);
  const restrikeRate = Math.max(0, pose.restrikeRate || 0);
  // The axis, in renderer z (DOWN, floor plane at +0.5). Everything below is
  // authored as a radius and a bearing around this line.
  const axisZ = 0.5 - ARC_BOLT_AXIS_HEIGHT;

  // THE STRIKE INDEX — the whole clock of this archetype. Driven by
  // `timeSeconds` rather than the animation track's accumulated gait for the
  // same reason the plume is: a bolt that has just been fired and one fired a
  // minute ago must be indistinguishable, and the 650 ms spawn ramp is longer
  // than a bolt lives. The seeded phase rides in as a fractional offset, so two
  // bolts in the same volley re-strike on different frames.
  const strike = Math.floor(motion.timeSeconds * restrikeRate + motion.phase);
  // Tubes take 8 sides at full LOD and 5 at simplified: 1.848r of inscribed
  // width against 1.809r, a 2% outline change where `steam_plume` set the
  // budget at 10%. Beads keep their longitudes and give up latitude bands,
  // which never touch a silhouette's width. That is the entire ladder — this
  // archetype has almost no interior to surrender, because a bolt is all
  // outline.
  const sides = full ? 8 : 5;
  // EVEN band counts, at both tiers and on purpose. `addEllipsoid` walks
  // latitude from pole to pole in equal steps, so the equator is only SAMPLED
  // when the count is even — at five bands a sphere's widest ring is 18 degrees
  // off the equator and the thing measures 0.951 of its own radius across.
  // That is invisible on a lamp hood and it matters here for two reasons: these
  // beads are the ends of the bounding box the registry publishes, and the
  // shortfall is a different fraction at each tier, which would make the bolt
  // change length at the LOD swap.
  const beadBands = full ? 6 : 4;
  const sparkBands = full ? 4 : 2;

  // The spine is near-white and the forks are a deep blue at nearly the same
  // physical width. In the pure-emissive branch albedo IS luminance, so that
  // gap is what makes a fork read as a thinner strand instead of a second
  // bolt. Roughness is inert on this branch and is authored low anyway, so a
  // palette that drops one of these back under the cliff gets a polished
  // surface rather than a matte one.
  const core = resolveMaterial(entity,
    { color: [0.86, 0.97, 1], roughness: 0.1, emission: 1, lightResponse: 0 },
    options, 0.5, 0.5, '☼');
  const branch = resolveMaterial(entity,
    { color: [0.34, 0.62, 0.95], roughness: 0.16, emission: 1, lightResponse: 0 },
    options, 0.35, 0.5, '/');
  const termination = resolveMaterial(entity,
    { color: [1, 0.99, 0.94], roughness: 0.08, emission: 1, lightResponse: 0 },
    options, 0.5, 0.9, '◆');
  const emitter = resolveMaterial(entity,
    { color: [0.66, 0.88, 1], roughness: 0.12, emission: 1, lightResponse: 0 },
    options, 0.5, 0.1, '!');

  /**
   * One node of the spine, `index` of `ARC_BOLT_SPINE_SEGMENTS`.
   *
   * THE HASH CHOOSES A BEARING AND NEVER A MAGNITUDE. Every node that jags at
   * all jags by the full amplitude its envelope allows, in a hashed direction
   * around the forward axis. Hashing the magnitude too was the obvious first
   * draft and it is wrong: half the nodes come out near zero, the path
   * straightens between kinks, and a bolt with straight runs in it is a cable.
   *
   * THE BOW AND THE FRAY ARE ALTERNATIVES, NOT ADDENDS. `sin(PI * t)` is a
   * bolt anchored at both ends bowing in the middle; `t^3` is a bolt anchored
   * at one end only, free to wander furthest where it is furthest from the
   * emitter. Taking the LARGER of the two rather than their sum is what keeps
   * `jag` a true bound on the envelope instead of a number the tip can exceed.
   */
  const node = (index) => {
    const along = index / ARC_BOLT_SPINE_SEGMENTS;
    const amplitude = jag * Math.max(
      Math.sin(Math.PI * along),
      (1 - ground) * along * along * along);
    const bearing = boltNoise(strike, index, ARC_NOISE_BEARING) * Math.PI * 2;
    return [
      ARC_BOLT_REACH * along,
      Math.cos(bearing) * amplitude,
      axisZ + Math.sin(bearing) * amplitude
    ];
  };

  /** A point at a radius and bearing around the axis, `distance` cells along
   *  the bolt. Radial rather than relative, so the envelope is arithmetic. */
  const offAxis = (distance, radius, bearing) => [
    distance,
    Math.cos(bearing) * radius,
    axisZ + Math.sin(bearing) * radius
  ];

  /** A bead's radii for this strike. Spherical (see the constants note), and
   *  the flicker is one-sided: it only ever shrinks, so every authored radius
   *  is a ceiling and the registry's envelope is a bound. */
  const beadRadii = (authored, index, salt) => {
    const radius = authored * (1 - ARC_BOLT_FLICKER * boltNoise(strike, index, salt));
    return [radius, radius, radius];
  };

  // THE SPINE, emitter to terminus. Emitted first and as one contiguous run of
  // equal tubes, because the cross-section test walks the buffer tube by tube
  // and a bolt's spine is the one member it cannot afford to have measured by
  // proxy.
  let previous = node(0);
  for (let index = 1; index <= ARC_BOLT_SPINE_SEGMENTS; index++) {
    const next = node(index);
    const from = (index - 1) / ARC_BOLT_SPINE_SEGMENTS;
    const to = index / ARC_BOLT_SPINE_SEGMENTS;
    addLocalSegment(vertices, basis, previous, next,
      ARC_BOLT_CORE_ROOT_RADIUS + (ARC_BOLT_CORE_TIP_RADIUS - ARC_BOLT_CORE_ROOT_RADIUS) * from,
      ARC_BOLT_CORE_ROOT_RADIUS + (ARC_BOLT_CORE_TIP_RADIUS - ARC_BOLT_CORE_ROOT_RADIUS) * to,
      core, sides);
    previous = next;
  }

  // THE FORKS. Two tubes each, with the knee's bearing hashed separately from
  // the tip's so a fork is itself bent — a straight spur off a jagged spine
  // reads as an antenna. They run forward as well as outward: a fork that left
  // at a right angle would be a crossbar, and the eye reads a crossbar as
  // structure rather than as discharge.
  for (const index of ARC_BOLT_FORK_NODES) {
    const from = node(index);
    const kneeBearing = boltNoise(strike, index, ARC_NOISE_FORK_KNEE) * Math.PI * 2;
    const tipBearing = boltNoise(strike, index, ARC_NOISE_FORK_TIP) * Math.PI * 2;
    addJointedLimb(vertices, basis, [
      from,
      offAxis(from[0] + ARC_BOLT_FORK_KNEE_RUN, ARC_BOLT_FORK_KNEE_RADIUS * fork, kneeBearing),
      offAxis(from[0] + ARC_BOLT_FORK_TIP_RUN, ARC_BOLT_FORK_TIP_RADIUS * fork, tipBearing)
    ], [ARC_BOLT_BRANCH_ROOT_RADIUS, ARC_BOLT_BRANCH_MID_RADIUS, ARC_BOLT_BRANCH_TIP_RADIUS],
    branch, sides);
  }

  // THE FRAY. All three strands end ON the reach plane, never past it — a
  // spent bolt that spilled beyond its own range would be telling the player
  // the tool reaches further than it does, which is the same lie the reticle
  // used to tell. What changes is how far out they land.
  const frayRoot = node(ARC_BOLT_FRAY_NODE);
  const frayRadius = ARC_BOLT_FRAY_CONTACT_RADIUS + ARC_BOLT_FRAY_LOOSE_RADIUS * (1 - ground);
  const frayBearing = boltNoise(strike, ARC_BOLT_FRAY_NODE, ARC_NOISE_FRAY) * Math.PI * 2;
  for (let strand = 0; strand < ARC_BOLT_FRAY_STRANDS; strand++) {
    addLocalSegment(vertices, basis, frayRoot,
      offAxis(ARC_BOLT_REACH, frayRadius,
        frayBearing + (strand / ARC_BOLT_FRAY_STRANDS) * Math.PI * 2),
      ARC_BOLT_BRANCH_ROOT_RADIUS, ARC_BOLT_BRANCH_TIP_RADIUS, branch, sides);
  }

  // THE EMITTER FLARE, centred on the entity itself. This is the half of the
  // brief the old point light could not do at all: something has to LEAVE the
  // rig, and a bolt that starts a cell in front of the player starts nowhere.
  // Identical in both poses — see the block comment.
  addLocalEllipsoid(vertices, basis, [0, 0, axisZ],
    beadRadii(ARC_BOLT_FLARE_RADIUS, 0, ARC_NOISE_BEAD), emitter,
    ARC_BOLT_BEAD_LONGITUDES, beadBands);

  // THE TERMINATION, on the last spine node — which is the reach point exactly
  // when grounded and somewhere in the air when not. Twice the radius when it
  // has something to ground into: the brightest, widest point of the mesh sits
  // on the thing the shot stopped against, which is the entire reason a bolt
  // teaches the line-of-sight rule that the reticle used to hide.
  const terminus = node(ARC_BOLT_SPINE_SEGMENTS);
  addLocalEllipsoid(vertices, basis, terminus,
    beadRadii(ARC_BOLT_KNOT_FREE_RADIUS + ARC_BOLT_KNOT_GROUND_RADIUS * ground, 1, ARC_NOISE_BEAD),
    termination, ARC_BOLT_BEAD_LONGITUDES, beadBands);

  // Two sparks off the termination: clustered against it when grounded (spatter
  // off a contact), thrown wide when not (a discharge with nowhere to go). Same
  // two beads either way, so the pose blend has something to blend.
  const scatter = ARC_BOLT_SPARK_CLUSTER + ARC_BOLT_SPARK_SCATTER * (1 - ground);
  for (let spark = 0; spark < ARC_BOLT_SPARKS; spark++) {
    const bearing = boltNoise(strike, spark, ARC_NOISE_SPARK) * Math.PI * 2;
    addLocalEllipsoid(vertices, basis, [
      terminus[0],
      terminus[1] + Math.cos(bearing) * scatter,
      terminus[2] + Math.sin(bearing) * scatter
    ], beadRadii(ARC_BOLT_SPARK_RADIUS, spark, ARC_NOISE_SPARK_SIZE), termination,
    ARC_BOLT_BEAD_LONGITUDES, sparkBands);
  }

  return finishMesh(vertices, lod, {
    archetype: 'arc_bolt',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    ground,
    strike,
    chassis: 'arc-discharge-bolt'
  });
}

/**
 * A WINCH TETHER: a taut line from the entity to a point the game names,
 * per frame, anywhere in three dimensions.
 *
 * Added for Beyond Dawn's grappling winch. The player fires a hook, the hook
 * lands somewhere — a ledge, a mast, a drone — and the line has to run from
 * the hand to THAT point while the winch reels the two together. Nothing in
 * this file could say that. Every archetype here is a fixed shape placed by
 * x/y/z, turned by heading and sized by scale, and a line whose far end is
 * six cells out and four up is not a scaled copy of one whose far end is
 * one cell out and level: scaling about the hand moves the near end off the
 * hand, and there is no heading that pitches a mesh. So this is the file's
 * first PARAMETRIC archetype: its geometry is a function of `entity.params`,
 * a plain object the snapshot carries through and the facade hands to the
 * builder on every frame (see `prepareMeshEntities`).
 *
 *   reach — horizontal cells from the entity to the far end, along the
 *           heading. Default 1, clamped at 0.
 *   rise  — cells the far end is ABOVE the near end. Default 0; negative
 *           for a line going down, which a winch fired at the street does.
 *   slack — 0..1, default 0. How far the mid-span sags: a winch line under
 *           load is straight, a line still flying out is not, and a game
 *           drives this from 1 toward 0 as the hook bites.
 *   hook  — 0..1, default 1. The hook knot at the far end, scaled; at 0 the
 *           far end is bare, for a line that has not found anything yet.
 *
 * z IS THE NEAR END'S HEIGHT. The line starts at the entity's own
 * floor-contact point, local [0, 0, 0.5], so a game sets `z` to the hand and
 * the near end lands there — the one anchor a tether has that is not a
 * parameter. The far end is at local [reach, 0, 0.5 - rise], which is
 * `reach` cells along the forward axis and `rise` cells UP (renderer z is
 * down). Consequence, stated because it is the opposite of every other
 * archetype here: the mesh STRADDLES the floor plane rather than standing on
 * it — the line and its beads are centred on the near end's height and
 * extend below it by their own radius, 0.07 at most. The billboard feet
 * anchor is meaningless for a thing whose near end is always at the
 * player's hand and therefore always at full LOD.
 *
 * DO NOT SCALE IT. `nativeHeight` and `nativeFootprint` in the registry are
 * measured at the DEFAULT params — a one-cell level line — and are the box
 * of that line only; for any other params they are wrong and there is no
 * number that would be right. A game reaching something sets `reach` and
 * `rise`, in renderer cells, and leaves `scale` at 1.
 *
 * LIT METAL, NOT A LIGHT AND NOT A ROPE. The board recorded the failure this
 * is authored against: a rope authored dim is invisible at the one moment
 * the player fires, because that moment is an unlit street. But a line at
 * emission 1 is a light source, and a taut cable that glows is a laser. So
 * the line sits at emission 0.3 with lightResponse 0.65 — well over the
 * city furniture's ~0.2 so it reads with no lamp near it, well under the
 * 0.95 cliff so it still takes the scene's light and darkens in shadow like
 * the metal it is. The hook knot and the emitter bead are the two things
 * authored at emission 1, on the '☼' and '!' hints, so a game can accent
 * the hook when it bites and the bead when the winch is live.
 *
 * NO GAIT, NO POSE BLEND, NO SPAWN RAMP. The animation track is resolved
 * because every builder in this file does and the registry derives its pose
 * list from the profile, but nothing geometric is read off it: a line that
 * exists is at full length on the frame it appears, and its motion is the
 * game moving the far end. In particular `spawnProgress` is deliberately not
 * consulted — a winch line that materialised over 650 ms would be a line the
 * player fired before it was there.
 *
 * THE SAMPLER BAR IS NOT MET AND THAT IS THE DESIGN. The line is 0.07 cells
 * across, half the 0.15 bar the fixtures are held to (see the thin-fixture
 * note in docs/API.md), because a cable at scale-honest width in a renderer
 * that samples one tap a cell is going to be a dotted line at range whatever
 * is done, and a cable authored to the bar is a pipe. It takes the antenna's
 * bargain instead: brighter than its surroundings, so it is solid on the
 * cells it does hit — and it is always viewed from its own near end, which
 * is at the camera, so the part of it that matters most is the part that
 * subtends the most.
 *
 * THE DEGENERATE CASE IS HANDLED, NOT ASSUMED AWAY. A game can hand this
 * reach 0 and rise 0 on the frame the hook is still in the hand. The chord
 * then has no direction, so the line's tubes are skipped rather than built
 * along a NaN, and the prongs fall back to the forward axis. Two beads at
 * one point is what a hook in a hand looks like.
 */

/** Line radius at the hand and at the hook. The taper is small and real:
 *  perspective already narrows the far end hard, because this is the one
 *  archetype always seen from its own near end. */
const TETHER_NEAR_RADIUS = 0.035;
const TETHER_FAR_RADIUS = 0.03;

/** Sub-segments in the line, per LOD, and tube sides per LOD. The count is
 *  what lets the sag be a curve at all — one straight tube has no mid-span
 *  to bow. Simplified halves both, and nothing else changes: the beads keep
 *  their longitudes (below), so the far end measures the same at both tiers. */
const TETHER_SEGMENTS_FULL = 6;
const TETHER_SEGMENTS_SIMPLIFIED = 3;
const TETHER_SIDES_FULL = 6;
const TETHER_SIDES_SIMPLIFIED = 4;

/** Mid-span sag at slack 1, as a fraction of the chord length, on a
 *  sin(PI * t) profile — zero at both ends, so the anchors never move. 0.12
 *  is enough that a 6-cell line flying out visibly bellies (0.7 cells) and
 *  little enough that a 12-cell line does not reach the street. */
const TETHER_SAG = 0.12;

/** The two beads. The emitter is small — something visibly LEAVES the hand,
 *  and that is all it is for. The hook is the brightest and widest thing on
 *  the mesh, because where the far end is is the whole information content
 *  of a tether. Longitudes are FROZEN across both LODs (arc_bolt's lesson):
 *  a polygonal sphere only touches its radius where a sample lands on a
 *  cardinal direction, and the hook is the end of the box. Band counts are
 *  EVEN at both tiers so the equator is actually sampled. */
const TETHER_EMITTER_RADIUS = 0.05;
const TETHER_HOOK_RADIUS = 0.07;
const TETHER_BEAD_LONGITUDES = 8;
const TETHER_BEAD_BANDS_FULL = 4;
const TETHER_BEAD_BANDS_SIMPLIFIED = 2;

/** The hook's two prongs: they leave the far end BACK along the line and OUT
 *  to either side, which is a grapnel's flukes biting behind whatever the
 *  hook landed on. Radii are under the line's on purpose — the prongs are
 *  emissive, so they are bright on the cells they hit, and a prong as thick
 *  as the cable reads as a knot rather than a hook. */
const TETHER_PRONG_BACK = 0.1;
const TETHER_PRONG_SPREAD = 0.12;
const TETHER_PRONG_ROOT_RADIUS = 0.03;
const TETHER_PRONG_TIP_RADIUS = 0.018;

/** Below this chord length the line has no direction worth building along. */
const TETHER_MIN_LENGTH = 1e-4;

/** One numeric param, or its default when absent or not a finite number. */
function tetherParam(params, key, fallback) {
  const value = params === null ? undefined : params[key];
  return Number.isFinite(value) ? value : fallback;
}

export function buildTetherMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const motion = resolveEntityAnimation(entity, 'tether', currentTime, { lod });
  const params = entity.params !== null && typeof entity.params === 'object' ? entity.params : null;
  const reach = Math.max(0, tetherParam(params, 'reach', 1));
  const rise = tetherParam(params, 'rise', 0);
  const slack = clamp(tetherParam(params, 'slack', 0), 0, 1);
  const hook = clamp(tetherParam(params, 'hook', 1), 0, 1);
  // THE GAUGE: a multiplier on the line's radius and on the emitter bead's,
  // never on the hook. The tube is authored at 0.035 cells, which is a cable
  // seen from across a street and a plank seen from the hand that holds it -
  // a first-person game's near end sits half a cell from the eye, where 0.07
  // cells across is a fourteenth of the screen. The game states the gauge it
  // wants per frame the way it states the reach; the hook keeps its size
  // because it is the thing the far end has to be READ by.
  const gauge = clamp(tetherParam(params, 'gauge', 1), 0.1, 3);

  const segments = full ? TETHER_SEGMENTS_FULL : TETHER_SEGMENTS_SIMPLIFIED;
  const sides = full ? TETHER_SIDES_FULL : TETHER_SIDES_SIMPLIFIED;
  const beadBands = full ? TETHER_BEAD_BANDS_FULL : TETHER_BEAD_BANDS_SIMPLIFIED;

  // The line is the one thing here that is LIT (see the block comment): a
  // steel cable, bright enough to read unlit, dark enough to still be a
  // surface. The two beads take the pure-emissive branch on the accent hints.
  const line = resolveMaterial(entity,
    { color: [0.62, 0.66, 0.72], roughness: 0.55, emission: 0.3, lightResponse: 0.65 },
    options, 0.5);
  const knot = resolveMaterial(entity,
    { color: [0.59, 0.89, 0.66], roughness: 0.2, emission: 1, lightResponse: 0 },
    options, 0.5, 0.9, '☼');
  const emitter = resolveMaterial(entity,
    { color: [0.59, 0.89, 0.66], roughness: 0.2, emission: 1, lightResponse: 0 },
    options, 0.5, 0.1, '!');

  // Near end at the floor-contact point, far end `reach` along and `rise` up.
  const nearZ = 0.5;
  const farX = reach;
  const farZ = nearZ - rise;
  const length = Math.hypot(farX, farZ - nearZ);
  const hasChord = length > TETHER_MIN_LENGTH;
  // Unit chord direction in local space, for the prongs. Forward when the
  // chord is degenerate — see the block comment.
  const dirX = hasChord ? farX / length : 1;
  const dirZ = hasChord ? (farZ - nearZ) / length : 0;

  /** A point on the line at t in [0, 1]: the chord, plus the sag, which is
   *  DOWN (+z) and vanishes at both ends so the anchors are exact. */
  const node = (t) => [
    farX * t,
    0,
    nearZ + (farZ - nearZ) * t + slack * TETHER_SAG * length * Math.sin(Math.PI * t)
  ];
  const radiusAt = (t) => (TETHER_NEAR_RADIUS + (TETHER_FAR_RADIUS - TETHER_NEAR_RADIUS) * t) * gauge;

  // THE LINE, hand to hook, emitted first as one contiguous run of equal
  // tubes so a test can walk it tube by tube. Skipped outright when the chord
  // has no length: a zero-length tube would normalise a zero axis.
  if (hasChord) {
    let previous = node(0);
    for (let index = 1; index <= segments; index++) {
      const from = (index - 1) / segments;
      const to = index / segments;
      const next = node(to);
      addLocalSegment(vertices, basis, previous, next, radiusAt(from), radiusAt(to), line, sides);
      previous = next;
    }
  }

  // THE EMITTER BEAD, on the entity itself: the line visibly leaves something.
  const emitterRadius = TETHER_EMITTER_RADIUS * gauge;
  addLocalEllipsoid(vertices, basis, [0, 0, nearZ],
    [emitterRadius, emitterRadius, emitterRadius],
    emitter, TETHER_BEAD_LONGITUDES, beadBands);

  // THE HOOK KNOT: bead and two prongs, all scaled by `hook`, and absent at
  // 0 rather than shrunk to a point — a far end that has found nothing has
  // nothing on it, and a zero-radius sphere is a fan of degenerate normals.
  if (hook > 0) {
    const far = [farX, 0, farZ];
    const knotRadius = TETHER_HOOK_RADIUS * hook;
    addLocalEllipsoid(vertices, basis, far, [knotRadius, knotRadius, knotRadius],
      knot, TETHER_BEAD_LONGITUDES, beadBands);
    for (const side of [-1, 1]) {
      addLocalSegment(vertices, basis, far, [
        farX - dirX * TETHER_PRONG_BACK * hook,
        side * TETHER_PRONG_SPREAD * hook,
        farZ - dirZ * TETHER_PRONG_BACK * hook
      ], TETHER_PRONG_ROOT_RADIUS * hook, TETHER_PRONG_TIP_RADIUS * hook, knot, sides);
    }
  }

  return finishMesh(vertices, lod, {
    archetype: 'tether',
    state: motion.state,
    previousState: motion.previousState,
    transition: motion.transition,
    reach,
    rise,
    slack,
    hook,
    gauge,
    chassis: 'winch-tether'
  });
}

/**
 * One archetype's registry entry. Poses are derived from the animation
 * profiles rather than restated, so the selectable states and the tables that
 * animate them cannot drift apart. `applyPose` exists for the archetypes whose
 * state resolution reads entity fields other than `state` (see
 * `resolveStateKey` in EntityAnimation.js — node is the one case).
 *
 * `nativeHeight` / `nativeFootprint` are measured off the authored geometry,
 * in renderer cells (one grid cell = 1.0): height is floor plane to crown,
 * footprint is the widest horizontal extent in a typical state. They exist so
 * a game can pick a registration `scale` against its own world metrics
 * instead of rediscovering each silhouette empirically.
 */
function describeArchetype(archetype, build, info) {
  const poses = Object.freeze(info.poses ? [...info.poses] : Object.keys(ENTITY_ANIMATION_PROFILES[archetype] || { default: {} }));
  return Object.freeze({
    archetype,
    build,
    poses,
    poseSet: new Set(poses),
    applyPose: info.applyPose || null,
    locomotion: info.locomotion,
    nativeHeight: info.nativeHeight,
    nativeFootprint: info.nativeFootprint,
    description: info.description
  });
}

export const ENTITY_MESH_ARCHETYPES = Object.freeze({
  shambler: describeArchetype('shambler', buildShamblerMesh, {
    poses: ['default','idle','investigate','chase','windup','recover','stagger','dead'],
    locomotion: 'creature', nativeHeight: .92, nativeFootprint: .64,
    description: 'Connected street zombie with game-owned motion. params clock (seconds), gait (radians), move/alert (0..1), attack (0..1 windup, 1 impact, 1..2 recovery), attackWeight/recoil/flinch/death (0..1). Continuous joint surfaces, grounded soles, forward raking attack and floor-supported collapse. Palette hints j coat, p trousers, s skin, k dark details, t wounds, r trim, e eye. Explicit params rusher === true (rushPrepare 0..1, rush 0..1), bruiser === true (broad braced strike using attack), or screamer === true (narrow throat-led rig; call 0 inactive, 0..1 breath, 1 call release, 1..2 recovery; callWeight 0..1 defaults 0). Priority rusher > bruiser > screamer; other values do not opt in. Nonfinite call channels use 0 and finite channels clamp. Call overrides melee in proportion to callWeight; recoil, flinch and floor-supported death remain shared. New variants keep the same bone lengths, topology and material hints; native bounds describe the default, not the extended arms or collapse. Heading faces +x; no gameplay or damage logic.'
  }),
  crowbar: describeArchetype('crowbar', buildCrowbarMesh, {
    locomotion: 'fixture', nativeHeight: .71, nativeFootprint: .26,
    description: 'Handheld utility crowbar. The game owns attachment and swing timing.'
  }),
  night_scavenger: describeArchetype('night_scavenger', buildNightScavengerMesh, {
    locomotion: 'grounded', nativeHeight: 1.04, nativeFootprint: .5,
    description: 'Civilian night scavenger: soft hood, narrow amber flip-down eye glass, scarf, cropped utility jacket, climbing harness, roll-top canvas pack, cable loop and work boots. Dedicated connected rig; floor-planted two-bone legs, fixed-length sleeves and counter-swinging arms. idle/walk/sprint inferred from motion, concealed crouches. params.livery 0/1/2 adds repairs/salvaged plates; optional gait/move/crouch stage the same rig. Material hints j jacket, y yoke, p trousers, b boots, g leather, c canvas, s scarf, # webbing, + repair, m metal, = glass, k hood interior. Separate from hider/corp_guard; native height 1.04, resting footprint envelope .5.'
  }),
  shelter_contact: describeArchetype('shelter_contact', buildShelterContactMesh, {
    locomotion: 'fixture', nativeHeight: 0.99, nativeFootprint: 0.54,
    description: 'Unarmed human radio contact, exposed face and hair, headset and boom microphone, jacket, separate articulated limbs and boots. Subtle idle breathing. params.future changes the face/hair silhouette and default clothing/skin colors. Palette hints j coat, + trim, p trousers, b boots, s skin, h hair, k facial details, r radio. Soles at the floor; heading faces +x.'
  }),
  figure: describeArchetype('figure', buildFigureMesh, {
    locomotion: 'fixture', nativeHeight: 1.03, nativeFootprint: 0.38,
    description: 'Parametric posable human (FigureArchetype.js). Everything from entity.params each frame, nothing stored: pose (lean, turn, crouch, headPitch/headTurn, armL/armR { raise, spread, elbow }, legL/legR { lift, knee, spread }), outfit (hair short|choppy|slick|swept|long|none, top suit|jacket|bodysuit, coat 0..1 with coatFlare, gloves none|short|opera, boots shoe|thigh, moustache, choker, earrings, shoulderPads, devil) and props [{ at handL|handR|forearmL|forearmR|head, kind chainsaw|sword|pistol, length, angle, spin }]. Soles at the floor standing straight; heading faces +x. Palette hints j jacket/coat, J coat lining, w shirt, t tie, k bodysuit and dark details, p trousers, b boots, g gloves, s skin, h hair, e eyes, l lips, m metal, M bright metal, r red glow. No gait or pose blend: the game drives every joint.'
  }),
  shape: describeArchetype('shape', buildShapeMesh, {
    locomotion: 'fixture', nativeHeight: 1, nativeFootprint: 1,
    description: 'Parametric box, ball or cylinder with a FULL 3D rotation, for physics toys (ShapeArchetype.js). Everything from entity.params each frame, nothing stored: kind box|ball|cylinder, sx/sy/sz full size in renderer cells along the shape\'s own axes (default 1; a ball uses sx as its diameter, a cylinder is sx by sy round and sz long on its own z), qx/qy/qz/qw the rotation as a unit quaternion in the facade\'s world axes (Z up), as a physics engine reports it (default identity; normalised), trim true|false (default true: a band round a box, hoops round a cylinder, a stripe round a ball, so a turn is visible). Unlike every other archetype, the entity\'s z is the height of the shape\'s CENTRE, not its feet, and heading is ignored. scale multiplies about the centre; colour each toy with tint (the shape is authored light grey). Palette hints \u2588 body, # trim. Native size is the default 1-cell box. Meshes rebuild on the 30 Hz entity tick, so a turning toy updates at 30 Hz.'
  }),
  sheet: describeArchetype('sheet', buildSheetMesh, {
    locomotion: 'fixture', nativeHeight: 2, nativeFootprint: 1,
    description: 'Thin parametric panel for membranes, curtains, fences, glass and banners. Stands on the floor contact, centred, facing +x. params (renderer cells): width (default 1), height (default 2), thickness (default 0.03), holes [[left, bottom, right, top], ...] measured from the left edge seen from the front and from the bottom, sway (bend along the normal, default 0), phase (radians, the game advances it), waves (across the width, default 1), anchor both|top|bottom|none. Faces are tiled at 0.25 cells (0.5 simplified) so sway bends smoothly and derez sheds pieces. Both sides and the outer rim are drawn. Lit (emission 0.05, lightResponse 0.9); palette hint █ for the whole sheet. Native size is the default 1 x 2 sheet.'
  }),
  architectural_frame: describeArchetype('architectural_frame', buildArchitecturalFrame, {
    locomotion: 'fixture', nativeHeight: 2.3, nativeFootprint: 1.6,
    description: 'Hollow wall frame, front-bottom-center origin, facing +x. params width/height are outer dimensions, jamb is the border width, depth extends backward from the front plane. Opening remains width-2*jamb by height-jamb. Optional sill:true closes the lower border; band:true selects a solid two-box horizontal profile. Full/simplified retain the same silhouette. Dimensions in renderer cells; callers own collision and matching parametric billboards.'
  }),
  bat_flying: describeArchetype('bat_flying', buildFlyingBatMesh, {
    locomotion: 'flying', nativeHeight: 0.3, nativeFootprint: 0.7,
    description: 'Single horizontal bat with ears and scalloped membrane wings. Game-owned position and heading control flight; params.flap (-1..1) drives the wing stroke. Bounds include the full stroke.'
  }),
  seeker: describeArchetype('seeker', buildSeekerMesh, {
    locomotion: 'grounded',
    nativeHeight: 0.98,
    nativeFootprint: 0.82,
    description: 'Observation-reactive quadruped: layered carapace, luminous facial aperture, unfolds when unobserved. Auto-locks into a sentinel pose via the observed pose.'
  }),
  mourner: describeArchetype('mourner', buildMournerMesh, {
    locomotion: 'grounded',
    nativeHeight: 0.98,
    nativeFootprint: 0.56,
    description: 'Emaciated over-tall humanoid, folded under the ceiling; covers its face until rage. Long limbs, visible ribs.'
  }),
  warden: describeArchetype('warden', buildWardenMesh, {
    locomotion: 'grounded',
    nativeHeight: 1.06,
    nativeFootprint: 0.61,
    description: 'Elderly decomposing humanoid with a corrosion contact ring at its feet. emerge/vanish poses drive a vertical phase reveal.'
  }),
  echo: describeArchetype('echo', buildEchoMesh, {
    locomotion: 'grounded',
    nativeHeight: 0.93,
    nativeFootprint: 0.75,
    description: 'Fragmented luminous operative imprint: armor landmarks orbiting a signal cavity, trailing afterimages. With no explicit pose it escalates by camera distance (residual > manifesting > interference inside 2.5 cells).'
  }),
  hider: describeArchetype('hider', buildHiderMesh, {
    locomotion: 'grounded',
    nativeHeight: 0.99,
    nativeFootprint: 0.66,
    description: 'Armored humanoid operative: segmented suit, visor, backpack power spine, plated arms with pauldron/elbow cop/vambrace, shoulder antenna. idle/walk/sprint are also inferred from actual movement speed when no pose is set. Footprint 0.66 is the resting stance measured at the vambraces (it was 0.59 before the arms were plated); walk reaches 0.77 and sprint 0.93, which is a gait and not a size. Shares its arm and leg chains with corp_guard.'
  }),
  banshee: describeArchetype('banshee', buildBansheeMesh, {
    locomotion: 'hovering',
    nativeHeight: 0.94,
    nativeFootprint: 0.55,
    description: 'Floating resonant veil with twin folding membranes and floor-length ribbons; footprint is ~0.55 cells folded and ~1.2 cells with membranes unfurled in chase.'
  }),
  hunter: describeArchetype('hunter', buildHunterMesh, {
    locomotion: 'grounded',
    nativeHeight: 0.82,
    nativeFootprint: 1.22,
    description: 'Industrial stalker drone: armored hull on four piston legs, scanning amber optic, forward capture clamps that spread in chase. Wide — lateral stabilizers span ~1.05 cells.'
  }),
  specter: describeArchetype('specter', buildSpecterMesh, {
    locomotion: 'hovering',
    nativeHeight: 0.92,
    nativeFootprint: 0.86,
    description: 'Hovering shard lattice around a hollow phase aperture; orbiting fragments scatter in disperse.'
  }),
  node: describeArchetype('node', buildNodeMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.53,
    nativeFootprint: 0.52,
    description: 'Grounded beacon pylon with an expanding signal ring: amber while offline/calibrating, green while active.',
    // `resolveStateKey` decides a node's state from entity.active/calibration,
    // not entity.state, so the pose selector writes the fields it reads.
    applyPose(target, pose) {
      target.state = pose;
      target.active = pose === 'active';
      target.calibration = pose === 'calibrating' ? 1 : 0;
    }
  }),
  data_core: describeArchetype('data_core', buildDataCoreMesh, {
    locomotion: 'hovering',
    nativeHeight: 0.54,
    nativeFootprint: 0.49,
    description: 'Hovering collectible artifact: glowing core in a spinning gimbal of counter-rotating rings, centered ~0.38 cells above the floor.'
  }),
  // City vehicle/prop set (Beyond Dawn). All materials palette-reachable;
  // hint chars per archetype are documented in docs/API.md.
  pod_car: describeArchetype('pod_car', buildPodCarMesh, {
    locomotion: 'hovering',
    nativeHeight: 0.78,
    nativeFootprint: 2.2,
    description: 'Civilian hover pod ~2.2x1.0x0.8: low rounded body, forward cabin glass, bright front light block vs red tail bar, dark hover skirt with a ground gap. parked settles the skirt and dims the lamps.'
  }),
  tram_car: describeArchetype('tram_car', buildTramCarMesh, {
    locomotion: 'grounded',
    nativeHeight: 1.35,
    nativeFootprint: 3.56,
    description: 'Transit car ~3.2x1.1x1.3: boxy body on low skids, continuous window band, two door slots per side, roof equipment spine, coupler stubs both ends. One pose; lit/derelict liveries are palettes.'
  }),
  skimmer: describeArchetype('skimmer', buildSkimmerMesh, {
    locomotion: 'hovering',
    nativeHeight: 0.76,
    nativeFootprint: 1.8,
    description: 'Flying courier ~1.8 span: slim fuselage, bubble canopy, high gull wings, tail fin, belly nav lamp. bank drops a wingtip; turns bank it in cruise too.'
  }),
  cache: describeArchetype('cache', buildCacheMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.77,
    nativeFootprint: 0.69,
    description: 'Salvage cache ~0.7: strapped crate on stubby feet with a glowing seam between lid and body. sealed carries a lock bar; open raises the lid ajar over an inner glow face.'
  }),
  crate: describeArchetype('crate', buildCrateMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.83,
    nativeFootprint: 0.82,
    description: 'Plain freight box ~0.8: matte banded cube with an irregular stacking lip and no glow anywhere - deliberately the dull cousin of cache.'
  }),
  repair_kit: describeArchetype('repair_kit', buildRepairKitMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.35,
    nativeFootprint: 0.45,
    description: 'Small field case ~0.45: rectangular case with a raised handle bar and one emissive status stripe on the forward face.'
  }),
  street_lamp: describeArchetype('street_lamp', buildStreetLampMesh, {
    locomotion: 'fixture',
    nativeHeight: 4.2,
    nativeFootprint: 1.53,
    description: 'Municipal street lamp, 4.2 cells tall: stepped plinth on the ground, slender tapered mast, and an arm that sweeps out 1.0 cells along the entity\'s FORWARD axis (heading 0 = +x) into a hooded downlight — deep dome over a rim plate with the emissive face inset in it. Poses lit/dark change the lamp face only, never the silhouette. Footprint 1.53 is the arm overhang; the plinth itself occupies only 0.46, so place and collide against the mast, not the light.'
  }),
  // Street furniture set (Beyond Dawn). Same palette contract as the vehicles;
  // hint chars per archetype are documented in docs/API.md.
  bench: describeArchetype('bench', buildBenchMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.5,
    nativeFootprint: 1.6,
    description: 'Public street bench, 1.6 long x 0.46 deep x 0.5 tall: three slats over two dark end frames, and a back raked in two steps. The GAP between the seat line and the back line is the identity at glyph scale — that is what tells it from a crate. FACES its heading (long axis runs across it, so at heading 0 it spans y -0.8..+0.8 and is only 0.46 deep in x); collide against the full 1.6 x 0.46 box.'
  }),
  planter: describeArchetype('planter', buildPlanterMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.88,
    nativeFootprint: 1.15,
    description: 'Municipal planter: a 1.15 x 0.65 x 0.45 trough with a proud lip carrying a 0.43-cell foliage mass, 0.88 overall. Foliage is the only part on the \'*\' hint char, so a derelict quarter withers it to bare soil with a palette entry and no second registration. FACES its heading like the bench — the 1.15 length runs across it.'
  }),
  tree_canopy: describeArchetype('tree_canopy', buildTreeCanopyMesh, {
    locomotion: 'fixture',
    nativeHeight: 1.86,
    nativeFootprint: 1.76,
    description: 'Street tree crown, ~1.76 across and 1.86 tall: seven overlapping lobes on a short trunk stub, with a lighter upper-canopy tone on its own hint char. Authored to read as VOLUME from below — the underside is deliberately ragged (skirt lobes hang to the trunk, upper lobes sit 0.5 cells higher) so it never reads as a disc. Place z at the TOP of the trunk mass the world stamped: the stub bottoms out there and 0.5-0.66 cells of it stay visible. Heading is cosmetic and worth varying per tree — it rotates the lumps.'
  }),
  antenna_mast: describeArchetype('antenna_mast', buildAntennaMastMesh, {
    locomotion: 'fixture',
    nativeHeight: 3.55,
    nativeFootprint: 1.32,
    description: 'Rooftop antenna mast, 3.55 cells tall and thin: bolted base, tapered spine, three crossarms on ALTERNATING axes (lower ±y 1.24 long, mid ±x 0.88, upper ±y 0.6) so no bearing flattens them all, and a red obstruction beacon at the tip on the \'!\' char. Poses lit/dark change the beacon only. Base occupies 0.54; the 1.32 footprint is the lowest crossarm, 1.55 cells up.'
  }),
  // A roost of bats for Beyond Dawn's shelter. Additive: nothing else in the
  // engine or in Liminal Protocol names it.
  bat_roost: describeArchetype('bat_roost', buildBatRoostMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.285,
    nativeFootprint: 0.52,
    description: 'Three bats hanging from rock, 0.285 tall x 0.52 across: claws into the ceiling, bodies head-down, wings folded round them. z is the BOTTOM like every archetype - the geometry ends on the 0.5 floor plane with the wings spread - so the CLAWS are at the top of the box: to hang a roost from rock at height H set z = H - 0.285 * scale. Poses folded/stirred swing the wings out and drop the whole animal ~0.045 - a startled bat falls before it flies. Fur is deliberately lighter than a real bat so the cluster reads against a dark ceiling.'
  }),
  // Beyond Dawn's shelter, made volumetric (2026-09-03). Additive: three new
  // keys, named by nothing else in the engine and by no other consumer.
  workbench: describeArchetype('workbench', buildWorkbenchMesh, {
    locomotion: 'fixture',
    nativeHeight: 1,
    nativeFootprint: 1.2,
    description: 'Shelter workbench, 1.2 across x 0.6 deep x 1.0 tall: a heavy overhanging top at 0.72, four inset legs with a low tie rail, a back board carrying hung tools, and a vice clamped at one end. THE GAP under the top between the legs is the identity at glyph scale - fill it and this reads as a crate. Poses lit/dark drive only the strip lamp under the back board, so an unaffordable bench is the same object unpowered.'
  }),
  cosmetic_post: describeArchetype('cosmetic_post', buildCosmeticPostMesh, {
    locomotion: 'fixture',
    nativeHeight: 1,
    nativeFootprint: 1.5,
    description: 'Salvaged mannequin stand, 1.5 across x 1.0 tall: weighted foot, tapered mast, and a cross-arm at 0.8 with cloth hung either side and a shoulder block on top. The NEGATIVE SPACE under the cross-arm is what tells it from a bench. Poses lit/dark drive one pin light only.'
  }),
  shelter_screen: describeArchetype('shelter_screen', buildShelterScreenMesh, {
    locomotion: 'fixture',
    nativeHeight: 1.15,
    nativeFootprint: 1.6,
    description: 'Wall-mounted terminal, 1.6 across x 1.15 tall, with NO legs - its mass is the top half and the caller places it at hanging height. Housing box, a face proud of it so the screen has an edge from the side, a hood over the top, a wall bracket behind and a feed dropping from the bottom. Poses unread/read change the face emission only.'
  }),
  cot: describeArchetype('cot', buildCotMesh, {
    locomotion: 'fixture',
    nativeHeight: 1.05,
    nativeFootprint: 1.52,
    description: 'Camp cot, 1.52 long x 0.4 wide x 1.05 tall with its bedding: four raked legs, side rails, a thin sagging mattress, a blanket heaped at one end with a corner over the rail, and a pillow. LONG AND LOW WITH AIR UNDER IT is the read - a lying-down object drawn as a solid rectangle is a crate. Long axis is the local y.'
  }),
  brazier: describeArchetype('brazier', buildBrazierMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.95,
    nativeFootprint: 1.09,
    description: 'Fire bowl on three RAKED legs, 1.09 across x 0.95 tall: rim ring, shallow pan, ash bed and coals. The rake is what makes it a stand rather than a table. Poses lit/cold drive the coal emission and nothing else, so a dead hearth is the same object out.'
  }),
  chute: describeArchetype('chute', buildChuteMesh, {
    locomotion: 'fixture',
    nativeHeight: 3.4,
    nativeFootprint: 1.08,
    description: 'Lined climbing shaft, 1.08 across x 3.4 tall: two full-height uprights, a back plate, ten rungs a third of a metre apart, and a collar at the mouth. THE RUNGS ARE THE POINT - a ladder is the one shape that says climbable without a word - and their spacing is chosen so they stay separate cells at glyph scale rather than merging into a post.'
  }),
  cable_run: describeArchetype('cable_run', buildCableRunMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.75,
    nativeFootprint: 1.8,
    description: 'Stapled cable run, 1.8 across with 0.55 of sag: a catenary between two staples. THE SAG IS THE READ - a straight line is conduit, a hanging curve is a cable somebody nailed up in a hurry. Runs along the local y; hang it by placing z at the LOWEST point of the curve.'
  }),
  lantern: describeArchetype('lantern', buildLanternMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.5,
    nativeFootprint: 0.23,
    description: 'Hung market lantern, 0.5 tall x 0.23 wide: an emissive element in a housing whose hood is wider than it, under a hanging eyelet. z is the BOTTOM of the lantern like every archetype, so to hang one from a wire at height H set z = H - 0.5 * scale (world units) and the eyelet meets the wire; the eyelet\'s plane contains the forward axis, so heading is the direction the wire runs. Poses lit/dark change the element only, never the silhouette.'
  }),
  // Volumetric vapour (Beyond Dawn's vent hazard) — the one archetype in the
  // set whose geometry moves every tick. Same palette contract; the '~' hint
  // char is new and means ground-hugging vapour.
  steam_plume: describeArchetype('steam_plume', buildSteamPlumeMesh, {
    locomotion: 'fixture',
    nativeHeight: 2.6,
    nativeFootprint: 2.2,
    description: 'Vent steam plume, 2.2 cells across x 2.6 tall: a ground roll welded to the plate, a throat, and a tapering column of billowing lobes that tears into an off-axis crown. Poses telegraph (a low gather, 0.34 of the height) and active (the full blast); default IS active, because a plume entity only exists while there is a plume. Both numbers are an ENVELOPE, not a snapshot - the boil only ever shrinks and sinks a lobe from its authored size, so the mesh never exceeds 2.2 x 2.6 on any frame and touches it on some. The footprint is the HAZARD footprint: the ground lobes never drift laterally and never leave the floor plane, so the plume is exactly as wide as the burn. Authored to scatter light rather than emit it (the lowest emission and the highest lightResponse in the archetype set) - the vent\'s own light decides its colour and an unlit plume is a grey mass, which is also what keeps a volume this size from whiting out the frame. Heading is cosmetic and worth varying per vent: it rotates the snake. Wants per-entity `opacity`, which thins the mesh by triangle and makes a genuinely see-through cloud.'
  }),
  // Arc discharge (Beyond Dawn's one offensive tool) — the only archetype in
  // the set that is entirely a light source, and the only one whose animation
  // is a step function rather than a continuous one. Same palette contract; the
  // '/' hint is borrowed from the skimmer's wings and here means a fork.
  arc_bolt: describeArchetype('arc_bolt', buildArcBoltMesh, {
    locomotion: 'fixture',
    nativeHeight: 1.16,
    nativeFootprint: 3.86,
    description: 'Arc discharge bolt, 3.86 cells long x 1.16 across: an emitter flare on the entity itself, a jagged 8-node spine running ARC_BOLT_REACH (3.5) cells along the heading, four bent forks and a three-strand fray, ending in a termination knot and two sparks. DO NOT scale against nativeFootprint - it is the full box, which includes the flare behind the emitter and the knot past the contact. Scale against the exported ARC_BOLT_REACH: `scale = contactDistance / 3.5` puts the termination exactly where the shot stopped. z is ground contact as everywhere in this file and the envelope is symmetric about the bolt\'s axis, so put the axis at the height the rig fires from with `z = muzzleHeight - ARC_BOLT_AXIS_HEIGHT * scale` (0.58, exactly half nativeHeight). Both extents are an ENVELOPE, not a snapshot - the flicker only ever shrinks a bead, so the mesh is inside 3.86 x 1.16 on every frame and comes within a hundredth of a cell of each on some; a single-frame measurement reads smaller. Poses spent (open air: the terminus wanders and the strands fray to 0.445 cells) and grounded (connected: the terminus is pinned on the reach point, the strands converge on it and the knot doubles); default IS spent, because guessing wrong the other way hangs a bright contact in empty air. Every material is authored at emission 1, the pure-emissive branch - a bolt is a light source, so nothing in the scene dims it and nothing lights it either. THE PATH IS REPLACED, NOT MOVED: it is byte-identical between frames within one strike and completely re-hashed across a strike boundary, 14-18 times a second. Heading IS the direction the bolt travels; per-entity `opacity` is the right way to end one, and per-entity `accent` reaches the spine, knot and flare but deliberately not the forks, whose darker tone is the archetype\'s only cue for thinness.'
  }),
  // The city's one LIVING archetype, and the only Beyond Dawn entry built on a
  // Liminal body: `corp_guard` shares `hider`'s arm and leg chains (see THE
  // SHARED OPERATIVE LIMBS, above the hider builder) and authors everything
  // that says who it is. Filed here with the city set rather than beside hider
  // because its provenance is this game's, not the port's — and because unlike
  // every other humanoid in this file it is authored LIT, not emissive.
  corp_guard: describeArchetype('corp_guard', buildCorpGuardMesh, {
    locomotion: 'grounded',
    nativeHeight: 1.01,
    nativeFootprint: 0.67,
    description: 'Corporate security guard, 1.0 cells tall and 0.67 across at post (the fore-aft axis, because the lamp is out in front of him; laterally he is 0.57, and a heading that puts him corner-on reaches 0.75): the shared operative body (hider\'s arms and legs) in corp livery, carrying a HAND FLOODLIGHT. Read priority is lamp, then hard helmet, then the lit insignia panel centred on the chest carrier — a squared vest silhouette, a six-box helmet with a comb and a flared nape guard, and a hip holster the free hand rests on. Poses are named for the job: post (standing a gate, feet wide, lamp low-ready across the body, hand on the holster), patrol (walking a beat, lamp sweeping the paving, footprint opens to 0.74) and challenge (squared up, lamp forward, free arm up palm-out, shoulder strobes at full, 0.68 fore-aft). default IS post — the state a game gets without asking is the one that claims least, i.e. he has not seen you. THE ONLY HUMANOID IN THIS FILE AUTHORED LIT rather than pure-emissive: shell, undersuit and fittings sit at city-archetype emission (~0.2) with high lightResponse, so a guard in an unlit street is a dark shape and his own lamp is what finds him. Only the lens (\'☼\'), visor (\'=\'), insignia (\'+\') and shoulder strobes (\'!\') glow, and only the lens and the strobes are over the accent floor. The scene light is the GAME\'S — attach it at the exported CORP_GUARD_LAMP_OFFSET, which is stable across poses to CORP_GUARD_LAMP_DRIFT. No speed inference: unlike hider, a guard\'s state is always the game\'s to say, because a guard walking a beat and a guard walking at you are the same speed.'
  }),
  // The winch tether (Beyond Dawn's grapple) — the file's first PARAMETRIC
  // archetype: its shape comes from `entity.params` on every frame, not from
  // a pose or a scale. Same palette contract; the '☼' and '!' hints are the
  // hook knot and the emitter bead.
  tether: describeArchetype('tether', buildTetherMesh, {
    locomotion: 'fixture',
    nativeHeight: 0.14,
    nativeFootprint: 1.12,
    description: 'Winch tether: a taut line from the entity to a hook point the game names PER FRAME through `entity.params`, anywhere in three dimensions. z is the NEAR END\'s height — the line starts at the entity\'s own floor-contact point, so set z to the hand and the near end lands there — and the far end is `params.reach` cells along the heading and `params.rise` cells UP (negative for a line going down); defaults reach 1, rise 0. `params.slack` (0..1, default 0) bows the mid-span down by slack x 0.12 x length on a sin profile — a winch line under load is straight, a line still flying out sags. `params.hook` (0..1, default 1) scales the hook knot at the far end (a bright bead and two prongs biting back along the line); at 0 the far end is bare. `params.gauge` (0.1..3, default 1) multiplies the radius of the LINE and of the emitter bead, never of the hook: a first-person near end half a cell from the eye wants about 0.5, a line seen from across a street wants 1. A small emitter bead sits on the entity so the line visibly leaves something. nativeHeight and nativeFootprint are measured at the DEFAULT params — a one-cell level line, 0.14 tall x 1.12 long including its beads, which STRADDLES the floor plane by 0.07 rather than standing on it — and are meaningless for any other params; DO NOT scale this archetype to reach something, set reach and rise instead, because a scaled tether moves its near end off the hand. The line is LIT metal (emission 0.3, lightResponse 0.65): bright enough to read in an unlit street at the one moment the player fires, dark enough to still take the scene\'s light. Only the hook knot (\'☼\') and the emitter bead (\'!\') author emission 1, so per-entity accent reaches exactly those two. No gait, no pose blend, no spawn ramp: a line that exists is at full length on the frame it appears, and its motion is the game moving the far end. Meshes rebuild on the 30 Hz entity tick, so params changes land at 30 Hz.'
  })
});

export const ENTITY_MESH_ARCHETYPE_NAMES = Object.freeze(Object.keys(ENTITY_MESH_ARCHETYPES));

/**
 * The char hints the builders reserve for optic/signal materials — the set a
 * facade `accent` may recolor. Derived from the actual resolveMaterial call
 * sites above, not from taste:
 *
 *   '☼' — seeker facial aperture/core (and its glowing forefoot tips),
 *         hunter optic and scanning slit, pod_car front light block,
 *         skimmer belly nav lamp, street_lamp lamp face, lantern element,
 *         arc_bolt spine, corp_guard's hand-floodlight lens, the tether's
 *         hook knot (bead and prongs)
 *   '=' — echo signal node (chest/hands/feet), hider visor, repair_kit
 *         status stripe; also corp_guard's visor band (authored emission 0.62),
 *         pod_car cabin glass (authored emission 0.55),
 *         tram_car window band (0.88) and skimmer canopy (0.6), which sit
 *         under the floor below so accent skips them unless a palette
 *         raises their emission
 *   '◆' — banshee acoustic core, cache seam glow, arc_bolt termination knot
 *         and its two sparks
 *   '!' — hider warning accent, the antenna_mast obstruction beacon and
 *         corp_guard's shoulder strobes (emission 1, so accent DOES reach
 *         them — that is the intended per-entity blink knob; note that on a
 *         guard, accent therefore recolors the strobes AND the lamp lens
 *         together, and a game wanting them apart uses a registration palette,
 *         which is the right granularity for livery); also the hunter's
 *         capture clamps and centre
 *         vent (emission 0.86) and pod_car tail lamp bar (0.85) — under the
 *         floor below, so accent never reaches those unless a palette entry
 *         raises it; and the arc_bolt emitter flare (emission 1, so accent
 *         reaches it — recoloring the flare, the spine and the knot together
 *         is how a game tints one discharge); and the tether's emitter bead
 *         (emission 1 — so on a tether, accent recolors the emitter and the
 *         hook knot together, which is the intended "winch is live" knob).
 *
 * Deliberately NOT here: '█' (the default body hint every un-hinted call gets,
 * plus banshee's shell), '#' (echo shell, hider and corp_guard undersuit),
 * 'O' (hider and corp_guard armor), '+' (cache lock bar, corp_guard insignia
 * panel — the guard's is authored at emission 0.72, under the accent floor, on
 * purpose: an insignia is LIVERY and belongs to a registration palette, not to
 * a per-entity blink), the street-furniture structure hints '-' (bench back
 * slats, antenna_mast crossarms, lantern hanger, corp_guard fittings: helmet
 * comb, jaw block, belt, comms, holster, boots and the whole lamp housing),
 * '^' (tram roof gear, street_lamp
 * hood, tree_canopy upper lobes, steam_plume crown billows), '/' (skimmer
 * wings and tail, arc_bolt forks and fray — the fork tone is the bolt's whole
 * cue for thinness at a fixed cross-section, and accent replaces an albedo
 * outright with no transition, so an accent that reached the forks would flatten
 * the spine/fork contrast that makes a bolt read as a bolt; palette recolors
 * them deliberately, per registration, which is the right granularity for it),
 * '*' (planter foliage, tree_canopy crown) and '~' (steam_plume's ground roll — vapour
 * scatters light rather than emitting it, so it is authored at emission 0.04
 * and an accent on it would be exactly the white-out the plume is tuned
 * against),
 * and the hunter's paletteOnly hints '▓' (dark hull: rear pod, nose block,
 * side vents) and '▒' (recessed machinery and the four piston legs) —
 * those are hull, structure and foliage, and accent exists to recolor an eye
 * per state without touching them. Every authored material in this file carries
 * emission 1, so emission alone cannot tell an optic from a hull; the char
 * hint is the discriminator the builders actually author.
 *
 * The emission floor below still gates the accent: a registration palette
 * that deliberately dims an optic char below it opts that char out of accent
 * recoloring too (see AsciiEngine's mesh color resolver).
 *
 * Known limitation: node and data_core route their glow through the default
 * '█' hint, so accent does not reach them — they are all-glow bodies; recolor
 * them with `tint`.
 */
export const MESH_ACCENT_CHARS = Object.freeze(['☼', '=', '◆', '!']);
export const MESH_ACCENT_EMISSION_FLOOR = 0.9;

/**
 * The facade's per-entity presentation pass, applied to a freshly built mesh
 * on the renderer's entity tick (30 Hz), never per display frame.
 *
 *   meshScale — uniform scale about the entity's floor contact
 *               (entity.x/y, z = +0.5), the same pivot `renderScale` uses.
 *               This is where a registration's scale knob and the per-entity
 *               scale land, multiplied; applying them here rather than through
 *               `renderScale` frees them from that path's [0.25, 2] clamp,
 *               which guards Liminal's presentation contract, not this one.
 *   meshLift  — height above the builder's floor contact, in cells, POSITIVE
 *               IS UP (world -z), applied after scale so it stays an absolute
 *               height. Applied here rather than through `renderLift` because
 *               that field is clamped to one room's height
 *               (WORLD_CEILING_CLEARING_LIFT) and a facade scene may fly an
 *               entity well above it.
 *   meshTint  — [r, g, b] multipliers in 0..1 over the albedo channels. A
 *               multiplier, so it recolors and darkens the authored palette
 *               but never brightens it; null means untouched.
 *
 * One walk over the vertex buffer, in place, no allocation. The identity case
 * returns without touching a float, so an entity that sets none of these is
 * bit-identical to the builder's own output.
 */
export function applyEntityMeshPresentation(mesh, entity) {
  const scale = Number.isFinite(entity.meshScale) && entity.meshScale > 0 ? entity.meshScale : 1;
  const lift = Number.isFinite(entity.meshLift) ? entity.meshLift : 0;
  const tint = Array.isArray(entity.meshTint) && entity.meshTint.length >= 3 ? entity.meshTint : null;
  const hasScale = scale !== 1;
  const hasLift = lift !== 0;
  if (!hasScale && !hasLift && tint === null) return mesh;
  const vertices = mesh.vertices;
  const floorZ = 0.5;
  const entityX = entity.x;
  const entityY = entity.y;
  const tintR = tint === null ? 1 : tint[0];
  const tintG = tint === null ? 1 : tint[1];
  const tintB = tint === null ? 1 : tint[2];
  for (let vertex = 0; vertex < vertices.length; vertex += ENTITY_VERTEX_STRIDE) {
    if (hasScale) {
      vertices[vertex] = entityX + (vertices[vertex] - entityX) * scale;
      vertices[vertex + 1] = entityY + (vertices[vertex + 1] - entityY) * scale;
      vertices[vertex + 2] = floorZ + (vertices[vertex + 2] - floorZ) * scale;
    }
    if (hasLift) vertices[vertex + 2] -= lift;
    if (tint !== null) {
      vertices[vertex + 6] *= tintR;
      vertices[vertex + 7] *= tintG;
      vertices[vertex + 8] *= tintB;
    }
  }
  return mesh;
}
