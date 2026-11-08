export const LIGHT_SHAPES = Object.freeze({
  POINT: 0,
  SPOT: 1
});

export const DEFAULT_SPOT_CONE = Object.freeze({
  innerDegrees: 24,
  outerDegrees: 44
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize3(vector, fallback = [0, 0, 1]) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 0.0001) return [...fallback];
  return vector.map(component => component / length);
}

function resolvePosition(light) {
  return [
    Number.isFinite(light?.x) ? light.x : 0,
    Number.isFinite(light?.y) ? light.y : 0,
    Number.isFinite(light?.z) ? light.z : 0
  ];
}

function resolveDirection(light, position) {
  if (Array.isArray(light?.direction) && light.direction.length >= 3) {
    return normalize3(light.direction);
  }
  if (Number.isFinite(light?.directionX) && Number.isFinite(light?.directionY) && Number.isFinite(light?.directionZ)) {
    return normalize3([light.directionX, light.directionY, light.directionZ]);
  }
  if (Number.isFinite(light?.targetX) && Number.isFinite(light?.targetY)) {
    const targetZ = Number.isFinite(light.targetZ) ? light.targetZ : 0;
    return normalize3([light.targetX - position[0], light.targetY - position[1], targetZ - position[2]]);
  }
  return [0, 0, 1];
}

export function resolveProjectedLight(light = {}) {
  const position = resolvePosition(light);
  const projectionOrigin = Array.isArray(light.projectionOrigin) && light.projectionOrigin.length === 3
    && light.projectionOrigin.every(Number.isFinite) ? [...light.projectionOrigin] : position;
  const isSpot = light.shape === 'spot' || light.projected === true || light.type === 'museum_spotlight';
  const innerDegrees = clamp(
    Number.isFinite(light.innerConeDegrees) ? light.innerConeDegrees : DEFAULT_SPOT_CONE.innerDegrees,
    1,
    87
  );
  const outerDegrees = clamp(
    Math.max(innerDegrees + 0.5, Number.isFinite(light.outerConeDegrees) ? light.outerConeDegrees : DEFAULT_SPOT_CONE.outerDegrees),
    innerDegrees + 0.5,
    89
  );

  return Object.freeze({
    shape: isSpot ? LIGHT_SHAPES.SPOT : LIGHT_SHAPES.POINT,
    spotBlend: isSpot ? 1 : 0,
    position,
    // A finite projector may have a virtual cone apex behind its physical
    // emitter. Attenuation, shadows and scattering positions stay physical.
    projectionOrigin,
    projectionDepth: projectionOrigin === position ? 0 : Math.hypot(
      projectionOrigin[0] - position[0], projectionOrigin[1] - position[1], projectionOrigin[2] - position[2]),
    direction: resolveDirection(light, projectionOrigin),
    innerDegrees,
    outerDegrees,
    innerCos: Math.cos(innerDegrees * Math.PI / 180),
    outerCos: Math.cos(outerDegrees * Math.PI / 180),
    floorInfluence: clamp(Number.isFinite(light.floorInfluence) ? light.floorInfluence : 1, 0, 1),
    // How much airlight this fixture contributes. A light positioned inside the
    // thing it lights paints a scattering sphere centred on that object, and no
    // depth weighting fixes it: the ray that hits the object traverses only the
    // near half of the sphere while the ray that misses traverses all of it, so
    // the step traces the silhouette. Same reasoning as floorInfluence.
    volumetricInfluence: clamp(
      Number.isFinite(light.volumetricInfluence) ? light.volumetricInfluence : 1,
      0,
      1
    )
  });
}

export function projectedLightWeight(light, worldPosition) {
  const resolved = resolveProjectedLight(light);
  if (resolved.shape === LIGHT_SHAPES.POINT) return 1;
  const front = worldPosition.reduce((sum, value, i) =>
    sum + (value - resolved.position[i]) * resolved.direction[i], 0);
  if (front < 0) return 0;
  const vector = [worldPosition[0] - resolved.projectionOrigin[0],
    worldPosition[1] - resolved.projectionOrigin[1], worldPosition[2] - resolved.projectionOrigin[2]];
  const near = resolved.projectionDepth > 0 ? clamp(front / resolved.projectionDepth, 0, 1) : 1;
  const nearWeight = near * near * (3 - 2 * near);
  if (Math.hypot(...vector) < .001) return nearWeight;
  const toSurface = normalize3(vector);
  const alignment = resolved.direction[0] * toSurface[0]
    + resolved.direction[1] * toSurface[1]
    + resolved.direction[2] * toSurface[2];
  const t = clamp((alignment - resolved.outerCos) / Math.max(resolved.innerCos - resolved.outerCos, 0.0001), 0, 1);
  return t * t * (3 - 2 * t) * nearWeight;
}

export function resolveFlashlightProjection(player, renderHeight = 100, viewmodelMotion = null) {
  const fov = Number.isFinite(player?.fov) ? player.fov : Math.PI / 3;
  const yawLag = clamp(viewmodelMotion?.flashlightYawLag || 0, -0.045, 0.045);
  const pitchLag = clamp(viewmodelMotion?.flashlightPitchLag || 0, -0.032, 0.032);
  const projectedAngle = (player?.angle || 0) + yawLag * 1.6;
  const pitchAngle = (player?.pitch ? (player.pitch / Math.max(1, renderHeight)) * fov : 0) + pitchLag * 1.6;
  const direction = normalize3([
    Math.cos(projectedAngle) * Math.cos(pitchAngle),
    Math.sin(projectedAngle) * Math.cos(pitchAngle),
    Math.sin(pitchAngle)
  ]);
  const right = normalize3([-direction[1], direction[0], 0], [0, 1, 0]);
  const up = normalize3([
    right[1] * direction[2] - right[2] * direction[1],
    right[2] * direction[0] - right[0] * direction[2],
    right[0] * direction[1] - right[1] * direction[0]
  ], [0, 0, -1]);
  const down = up.map(component => -component);
  // Eye-height tracking is OPT-IN via flashlightTracksEye (the facade sets
  // it on every camera). Gating on cameraZ presence is not enough: direct
  // renderer consumers (Liminal's choreography rigs) write cameraZ onto the
  // same player object and their flashlight was hand-tuned against the
  // historical z=0 plane — they must stay bit-identical.
  const trackEye = player?.flashlightTracksEye === true && Number.isFinite(player?.cameraZ);
  const eye = [player?.x || 0, player?.y || 0, trackEye ? player.cameraZ : 0];
  // Eye-mounted lamps must remain inside the camera body at wall contact.
  // Keep the established handheld offset for consumers that do not opt in.
  const origin = player?.flashlightAtEye === true ? eye : eye.map((component, index) => component
    + direction[index] * 0.24
    + right[index] * (0.085 + yawLag)
    + down[index] * (0.07 + pitchLag));

  return Object.freeze({
    origin,
    direction,
    horizontalInnerTan: 0.435,
    horizontalOuterTan: 0.825,
    verticalInnerTan: 0.315,
    verticalOuterTan: 0.6,
    range: 20
  });
}

/**
 * Which lights fill the deferred pass's volumetric scattering slots.
 *
 * The shader's airlight loop carries MAX_VOLUMETRIC_LIGHTS slots (its
 * historical form hard-capped to the FIRST eight lights in array order, so a
 * dynamic light — appended after every shadow-casting light by design — could
 * never contribute airlight no matter how bright or how close). This selects
 * WHICH lights get the slots; the shader math per selected light is
 * untouched.
 *
 * THE LIMINAL GUARANTEE, stated exactly: candidates are the lights the
 * shader's own guard would keep (volumetricInfluence resolving > 0.001 —
 * absent defaults to 1, exactly as resolveProjectedLight resolves it). When
 * there are `maxSlots` or fewer candidates, ALL of them are returned in
 * ascending array order — the same lights contributing in the same summation
 * order as the historical loop for every scene whose volumetric lights sit in
 * the first eight slots, which keeps floating-point output bit-identical.
 *
 * Only past `maxSlots` candidates does merit decide: volumetricInfluence x
 * the shader's own intensity clamp (min(1.2 x currentIntensity, 1.5)) x a
 * proximity-to-camera falloff 1/(1 + distance), with lights inside the
 * shader's 0.75 near-camera skip radius scored 0 (they cannot contribute).
 * The sort is stable with an explicit original-index tie-break, and the
 * chosen set is re-sorted ascending by original index before upload so the
 * shader's additions always run in array order.
 *
 * `lights` is the assembled active-light array exactly as uploaded (x, y,
 * z?, currentIntensity?, volumetricInfluence?); `camera` is the eye the
 * u_cameraPos uniform carries. Returns an array of indices into `lights`.
 */
export const MAX_VOLUMETRIC_LIGHT_SLOTS = 8;
const VOLUMETRIC_NEAR_CAMERA_SKIP = 0.75;

export function selectVolumetricLightIndices(lights, camera = {}, maxSlots = MAX_VOLUMETRIC_LIGHT_SLOTS) {
  if (!Array.isArray(lights) || lights.length === 0 || maxSlots <= 0) return [];
  const candidates = [];
  for (let index = 0; index < lights.length; index++) {
    const light = lights[index];
    if (!light) continue;
    const influence = clamp(
      Number.isFinite(light.volumetricInfluence) ? light.volumetricInfluence : 1,
      0,
      1
    );
    if (influence <= 0.001) continue;
    candidates.push({ index, influence, light });
  }
  if (candidates.length <= maxSlots) {
    // Array order, untouched: the bit-identical path.
    return candidates.map(candidate => candidate.index);
  }

  const cameraX = Number.isFinite(camera.x) ? camera.x : 0;
  const cameraY = Number.isFinite(camera.y) ? camera.y : 0;
  const cameraZ = Number.isFinite(camera.z) ? camera.z : 0;
  for (const candidate of candidates) {
    const light = candidate.light;
    const lightZ = Number.isFinite(light.z) ? light.z : 0;
    const distance = Math.hypot(
      (Number.isFinite(light.x) ? light.x : 0) - cameraX,
      (Number.isFinite(light.y) ? light.y : 0) - cameraY,
      lightZ - cameraZ
    );
    if (distance < VOLUMETRIC_NEAR_CAMERA_SKIP) {
      candidate.merit = 0;
      continue;
    }
    const intensity = 1.2 * (Number.isFinite(light.currentIntensity) ? light.currentIntensity : 1);
    candidate.merit = candidate.influence * Math.min(Math.max(intensity, 0), 1.5) / (1 + distance);
  }
  candidates.sort((a, b) => (b.merit - a.merit) || (a.index - b.index));
  const chosen = candidates.slice(0, maxSlots).map(candidate => candidate.index);
  chosen.sort((a, b) => a - b);
  return chosen;
}
