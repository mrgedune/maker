const TAU = Math.PI * 2;

export const THIRD_PERSON_SHOULDERS = Object.freeze(['left', 'right', 'center']);

export const THIRD_PERSON_DEFAULTS = Object.freeze({
  distance: 1.55,
  minimumDistance: 0.55,
  maximumDistance: 2.2,
  shoulder: 'right',
  shoulderOffset: 0.3,
  collisionRadius: 0.22,
  collisionPadding: 0.14,
  orbitStep: Math.PI / 12,
  zoomStep: 0.2,
  cameraZ: -0.32,
  // Z runs toward the floor (the renderer's camera up vector is [0, 0, -1]), so
  // the negative bound is how far the camera may rise. These two were literals
  // inside the resolver until the tactical preset needed to sit metres above the
  // grid; the values are unchanged, they are just authored where the rest of the
  // tuning lives now.
  minimumCameraZ: -0.46,
  maximumCameraZ: 0.2,
  pitchOffset: 28,
  pitchInputScale: 0.25,
  minimumPitch: 20,
  maximumPitch: 36,
  positionFrequency: 8.5,
  rotationFrequency: 9.5,
  collisionRetractionFrequency: 22,
  collisionRecoveryFrequency: 5.5,
  fov: Math.PI / 3,
  sprintFov: 68 * Math.PI / 180,
  aimFov: 52 * Math.PI / 180,
  interactionFov: 56 * Math.PI / 180,
  mapFov: 58 * Math.PI / 180,
  avatarScale: 0.32,
  minimumAvatarScale: 0.045,
  bodyFadeStart: 0.85,
  bodyFadeEnd: 0.42,
  bodyHideDistance: 0.28,
  bodyShowDistance: 0.52
});

const TACTICAL_FOV = 55 * Math.PI / 180;

/**
 * Top-down tactical framing: a camera hung above a grid, looking down at a
 * focus point it orbits and zooms around.
 *
 * Almost all of this is the third-person rig with different numbers - the orbit,
 * the zoom clamp and the pitch limits are the same fields. Three things are not
 * expressible as tuning alone, and they are why `resolveTacticalCamera` exists
 * rather than a bare preset object:
 *
 * 1. `pitch` is carried in grid ROWS, not radians. The renderer turns it into an
 *    angle with `(pitch / gridHeight) * fov`, so "look down 65 degrees" is not a
 *    constant - it depends on the live grid height and field of view. Authored
 *    here as `elevation` in radians and converted at resolve time.
 * 2. The third-person rig treats horizontal distance, camera height and look
 *    angle as three independent knobs. Behind a walking operative that is fine,
 *    because the shipped numbers happen to frame them. A tactical camera has to
 *    stay pointed at its focus while it zooms, so height and pitch are derived
 *    from one `range`/`elevation` pair instead of authored separately.
 * 3. Nothing behind a character ever needed to be more than half a metre off the
 *    floor, so the camera-height clamp was written as a literal pair. Tactical
 *    sits metres up; the bounds are options now.
 */
export const TACTICAL_DEFAULTS = Object.freeze({
  // Straight-line distance from the focus point to the camera. Zoom moves this,
  // and elevation holds, so the view keeps its angle as it pulls back.
  range: 11,
  minimumRange: 5,
  maximumRange: 22,
  // Angle above the grid plane. 65 degrees reads as a tactical board while
  // still showing the faces of walls, which a true 90-degree overhead does not.
  elevation: 65 * Math.PI / 180,
  minimumElevation: 30 * Math.PI / 180,
  maximumElevation: 85 * Math.PI / 180,
  orbitStep: Math.PI / 8,
  zoomStep: 1,
  // Rows in the renderer's character grid. Pass the live value; this default is
  // 1080p in the shipping `max` resolution mode (1080 / charHeight 3).
  gridHeight: 360,
  fov: TACTICAL_FOV,
  // A tactical camera does not reframe on sprint, aim, interact or map: the grid
  // must not resize under a squad that is only walking. Pinning the situational
  // fields to the base fov makes the third-person framing pass a no-op here.
  sprintFov: TACTICAL_FOV,
  aimFov: TACTICAL_FOV,
  interactionFov: TACTICAL_FOV,
  mapFov: TACTICAL_FOV,
  // The horizontal leg of range/elevation, so the third-person distance clamp
  // can never bite before the range clamp has.
  minimumDistance: 0,
  maximumDistance: 22,
  // Deep enough for maximumRange at maximumElevation; the camera never drops
  // below the plane it is looking down at.
  minimumCameraZ: -24,
  maximumCameraZ: 0
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function shortestAngleDelta(from, to) {
  let delta = to - from;
  while (delta < -Math.PI) delta += TAU;
  while (delta > Math.PI) delta -= TAU;
  return delta;
}

function normalizeAngle(angle) {
  return (angle % TAU + TAU) % TAU;
}

export function normalizeThirdPersonShoulder(value) {
  return THIRD_PERSON_SHOULDERS.includes(value) ? value : THIRD_PERSON_DEFAULTS.shoulder;
}

function shoulderSign(shoulder) {
  if (shoulder === 'left') return -1;
  if (shoulder === 'center') return 0;
  return 1;
}

function isCameraOpen(map, x, y, radius, isPositionBlocked) {
  if (typeof isPositionBlocked === 'function' && isPositionBlocked(x, y, radius)) return false;
  if (!Array.isArray(map) || map.length === 0) return true;
  const diagonal = radius * Math.SQRT1_2;
  const samples = [
    [0, 0],
    [radius, 0], [-radius, 0], [0, radius], [0, -radius],
    [diagonal, diagonal], [diagonal, -diagonal],
    [-diagonal, diagonal], [-diagonal, -diagonal]
  ];
  return samples.every(([offsetX, offsetY]) => {
    const row = Math.floor(y + offsetY);
    const column = Math.floor(x + offsetX);
    return row >= 0
      && column >= 0
      && row < map.length
      && column < (map[row]?.length || 0)
      && map[row][column] === 0;
  });
}

function traceCameraPose(map, player, desiredX, desiredY, options) {
  if (!Array.isArray(map) || map.length === 0) {
    return { x: desiredX, y: desiredY, ratio: 1, collisionLimited: false };
  }
  const originX = Number.isFinite(player?.x) ? player.x : 0;
  const originY = Number.isFinite(player?.y) ? player.y : 0;
  const vectorX = desiredX - originX;
  const vectorY = desiredY - originY;
  const pathLength = Math.hypot(vectorX, vectorY);
  if (pathLength <= 0.0001) {
    return { x: originX, y: originY, ratio: 0, collisionLimited: true };
  }

  const stepLength = Math.max(0.035, options.collisionRadius * 0.42);
  const steps = Math.max(1, Math.ceil(pathLength / stepLength));
  let safeRatio = 0;
  for (let step = 1; step <= steps; step++) {
    const ratio = step / steps;
    const x = originX + vectorX * ratio;
    const y = originY + vectorY * ratio;
    if (!isCameraOpen(map, x, y, options.collisionRadius, options.isPositionBlocked)) break;
    safeRatio = ratio;
  }

  if (safeRatio < 1) {
    const paddedLength = Math.max(0, safeRatio * pathLength - options.collisionPadding);
    safeRatio = paddedLength / pathLength;
  }
  return {
    x: originX + vectorX * safeRatio,
    y: originY + vectorY * safeRatio,
    ratio: safeRatio,
    collisionLimited: safeRatio < 0.999
  };
}

function resolveFraming(settings, options) {
  let mode = settings.moving ? 'movement' : 'exploration';
  let authoredFov = options.fov;
  if (settings.aiming) {
    mode = 'aim';
    authoredFov = options.aimFov;
  } else if (settings.interacting || settings.calibrating) {
    mode = 'interaction';
    authoredFov = options.interactionFov;
  } else if (settings.mapActive) {
    mode = 'map';
    authoredFov = options.mapFov;
  } else if (settings.sprinting) {
    mode = 'sprint';
    authoredFov = options.sprintFov;
  }
  const motionScale = clamp(Number.isFinite(settings.motionScale) ? settings.motionScale : 1, 0, 1);
  return { mode, fov: options.fov + (authoredFov - options.fov) * motionScale };
}

function resolveAvatarPresentation(actualDistance, desiredDistance, options) {
  const baseScale = clamp(options.avatarScale, 0.12, 1);
  const minimumScale = clamp(options.minimumAvatarScale, 0.03, baseScale);
  const distanceRatio = desiredDistance > 0.0001
    ? clamp(actualDistance / desiredDistance, 0, 1)
    : 0;
  return {
    avatarScale: Math.max(minimumScale, baseScale * distanceRatio),
    bodyVisible: actualDistance >= options.bodyHideDistance
  };
}

export function resolveThirdPersonCamera(player, map, settings = {}) {
  const options = {
    ...THIRD_PERSON_DEFAULTS,
    ...settings
  };
  const shoulder = normalizeThirdPersonShoulder(settings.shoulder);
  const orbit = Number.isFinite(settings.orbit) ? settings.orbit : 0;
  const lookAngle = (Number.isFinite(player?.angle) ? player.angle : 0) + orbit;
  const desiredDistance = clamp(
    Number.isFinite(settings.distance) ? settings.distance : options.distance,
    options.minimumDistance,
    options.maximumDistance
  );
  const desiredShoulderOffset = clamp(
    Number.isFinite(settings.shoulderOffset) ? settings.shoulderOffset : options.shoulderOffset,
    0,
    0.75
  ) * shoulderSign(shoulder);
  const forwardX = Math.cos(lookAngle);
  const forwardY = Math.sin(lookAngle);
  const rightX = -forwardY;
  const rightY = forwardX;
  const originX = Number.isFinite(player?.x) ? player.x : 0;
  const originY = Number.isFinite(player?.y) ? player.y : 0;
  const desiredX = originX - forwardX * desiredDistance + rightX * desiredShoulderOffset;
  const desiredY = originY - forwardY * desiredDistance + rightY * desiredShoulderOffset;
  const traced = traceCameraPose(map, player, desiredX, desiredY, options);
  const actualDistance = desiredDistance * traced.ratio;
  const actualShoulderOffset = desiredShoulderOffset * traced.ratio;
  const presentationDistance = Math.hypot(actualDistance, actualShoulderOffset);
  const desiredPresentationDistance = Math.hypot(desiredDistance, desiredShoulderOffset);
  const framing = resolveFraming(settings, options);
  const bodyFade = smoothstep(options.bodyFadeEnd, options.bodyFadeStart, presentationDistance);
  const avatarPresentation = resolveAvatarPresentation(
    presentationDistance,
    desiredPresentationDistance,
    options
  );

  return Object.freeze({
    x: traced.x,
    y: traced.y,
    angle: normalizeAngle(lookAngle),
    // The renderer's positive pitch axis looks toward the floor. Combine the
    // player's look input with an elevated, downward chase-camera composition.
    pitch: clamp(
      options.pitchOffset + (Number.isFinite(player?.pitch) ? player.pitch : 0) * options.pitchInputScale,
      options.minimumPitch,
      options.maximumPitch
    ),
    cameraZ: clamp(
      Number.isFinite(settings.cameraZ) ? settings.cameraZ : options.cameraZ,
      options.minimumCameraZ,
      options.maximumCameraZ
    ),
    orbit,
    shoulder,
    desiredDistance,
    actualDistance,
    desiredShoulderOffset,
    actualShoulderOffset,
    collisionRatio: traced.ratio,
    collisionLimited: traced.collisionLimited,
    bodyFade,
    ...avatarPresentation,
    fov: framing.fov,
    framing: framing.mode
  });
}

function springScalar(current, velocity, target, frequency, deltaTime) {
  const dt = clamp(Number.isFinite(deltaTime) ? deltaTime : 0, 0, 0.1);
  if (dt <= 0 || frequency <= 0) return { value: target, velocity: 0 };
  const omega = Math.PI * 2 * frequency;
  const damping = 1 + 2 * dt * omega;
  const omegaSquared = omega * omega;
  const timeOmegaSquared = dt * omegaSquared;
  const timeSquaredOmegaSquared = dt * timeOmegaSquared;
  const inverse = 1 / (damping + timeSquaredOmegaSquared);
  return {
    value: (damping * current + dt * velocity + timeSquaredOmegaSquared * target) * inverse,
    velocity: (velocity + timeOmegaSquared * (target - current)) * inverse
  };
}

function springAngle(current, velocity, target, frequency, deltaTime) {
  const unwrappedTarget = current + shortestAngleDelta(current, target);
  const result = springScalar(current, velocity, unwrappedTarget, frequency, deltaTime);
  result.value = normalizeAngle(result.value);
  return result;
}

export function createThirdPersonCameraState(player, map, settings = {}) {
  const frame = resolveThirdPersonCamera(player, map, settings);
  return {
    initialized: true,
    x: frame.x,
    y: frame.y,
    angle: frame.angle,
    pitch: frame.pitch,
    cameraZ: frame.cameraZ,
    actualDistance: frame.actualDistance,
    actualShoulderOffset: frame.actualShoulderOffset,
    fov: frame.fov,
    bodyVisible: frame.bodyVisible,
    velocities: { x: 0, y: 0, angle: 0, pitch: 0, cameraZ: 0, distance: 0, shoulder: 0, fov: 0 }
  };
}

export function updateThirdPersonCamera(state, player, map, settings = {}, deltaTime = 1 / 60) {
  if (!state || !state.initialized || !state.velocities) {
    state = createThirdPersonCameraState(player, map, settings);
  }
  const target = resolveThirdPersonCamera(player, map, settings);
  const options = { ...THIRD_PERSON_DEFAULTS, ...settings };
  const motionScale = clamp(Number.isFinite(settings.motionScale) ? settings.motionScale : 1, 0, 1);
  const immediate = motionScale <= 0.01;
  const positionFrequency = immediate ? 0 : options.positionFrequency / Math.max(0.35, motionScale);
  const rotationFrequency = immediate ? 0 : options.rotationFrequency / Math.max(0.35, motionScale);
  const distanceFrequency = immediate
    ? 0
    : (target.actualDistance < state.actualDistance
      ? options.collisionRetractionFrequency
      : options.collisionRecoveryFrequency) / Math.max(0.35, motionScale);

  const angle = springAngle(state.angle, state.velocities.angle, target.angle, rotationFrequency, deltaTime);
  const pitch = springScalar(state.pitch, state.velocities.pitch, target.pitch, rotationFrequency, deltaTime);
  const cameraZ = springScalar(state.cameraZ, state.velocities.cameraZ, target.cameraZ, positionFrequency, deltaTime);
  const distance = springScalar(state.actualDistance, state.velocities.distance, target.actualDistance, distanceFrequency, deltaTime);
  const shoulder = springScalar(state.actualShoulderOffset, state.velocities.shoulder, target.actualShoulderOffset, positionFrequency, deltaTime);
  const fov = springScalar(state.fov, state.velocities.fov, target.fov, positionFrequency, deltaTime);

  state.angle = angle.value;
  state.pitch = pitch.value;
  state.cameraZ = cameraZ.value;
  state.actualDistance = target.collisionLimited
    ? Math.min(distance.value, target.actualDistance)
    : distance.value;
  state.actualShoulderOffset = target.collisionLimited
    ? Math.sign(shoulder.value) * Math.min(Math.abs(shoulder.value), Math.abs(target.actualShoulderOffset))
    : shoulder.value;
  state.fov = fov.value;
  Object.assign(state.velocities, {
    x: 0,
    y: 0,
    angle: angle.velocity,
    pitch: pitch.velocity,
    cameraZ: cameraZ.velocity,
    distance: distance.velocity,
    shoulder: shoulder.velocity,
    fov: fov.velocity
  });

  // Reconstruct the camera from one coherent polar state. Independent X/Y
  // springs let translation lag behind the player while distance and scale
  // reported a different pose, causing the operative to jump around and
  // resize. A radial pose keeps framing stable, then receives one final safety
  // trace for the interpolated angle.
  const originX = Number.isFinite(player?.x) ? player.x : 0;
  const originY = Number.isFinite(player?.y) ? player.y : 0;
  const forwardX = Math.cos(state.angle);
  const forwardY = Math.sin(state.angle);
  const rightX = -forwardY;
  const rightY = forwardX;
  const radialX = originX - forwardX * state.actualDistance + rightX * state.actualShoulderOffset;
  const radialY = originY - forwardY * state.actualDistance + rightY * state.actualShoulderOffset;
  const safePose = traceCameraPose(map, player, radialX, radialY, options);
  state.x = safePose.x;
  state.y = safePose.y;
  if (safePose.ratio < 0.999) {
    state.actualDistance *= safePose.ratio;
    state.actualShoulderOffset *= safePose.ratio;
    state.velocities.distance = Math.min(0, state.velocities.distance);
  }

  const presentationDistance = Math.hypot(state.x - originX, state.y - originY);
  const bodyFade = smoothstep(options.bodyFadeEnd, options.bodyFadeStart, presentationDistance);
  const avatarPresentation = resolveAvatarPresentation(
    presentationDistance,
    Math.hypot(target.desiredDistance, target.desiredShoulderOffset),
    options
  );
  if (state.bodyVisible === false) {
    if (presentationDistance >= options.bodyShowDistance) state.bodyVisible = true;
  } else if (presentationDistance <= options.bodyHideDistance) {
    state.bodyVisible = false;
  }
  avatarPresentation.bodyVisible = state.bodyVisible !== false;
  return Object.freeze({
    ...target,
    x: state.x,
    y: state.y,
    angle: state.angle,
    pitch: state.pitch,
    cameraZ: state.cameraZ,
    actualDistance: state.actualDistance,
    actualShoulderOffset: state.actualShoulderOffset,
    bodyFade,
    ...avatarPresentation,
    fov: state.fov
  });
}

export function recenterThirdPersonOrbit(orbit, deltaTime, sharpness = 8) {
  const current = Number.isFinite(orbit) ? orbit : 0;
  const dt = clamp(Number.isFinite(deltaTime) ? deltaTime : 0, 0, 0.1);
  const amount = 1 - Math.exp(-Math.max(0, sharpness) * dt);
  const next = current + shortestAngleDelta(current, 0) * amount;
  return Math.abs(next) < 0.0001 ? 0 : next;
}

/**
 * Convert a look angle in radians into the grid rows the renderer carries pitch
 * in.
 *
 * Pitch is not an angle anywhere in this engine. The renderer stores rows and
 * reconstructs the angle as `(pitch / gridHeight) * fov`, so one row count means
 * a different angle at every resolution and field of view - the same trap that
 * gave the first-person look clamp a 33-degree range at 720p and 21 at 1440p.
 * Anything that wants a specific angle has to come through here.
 *
 * Positive is downward: the renderer's camera up vector is [0, 0, -1].
 *
 * FLAG: `finisherPitchToRows` in FinisherCamera.js is the same conversion taking
 * degrees. Two spellings of one piece of arithmetic, and they should converge on
 * this one - a shot authored in degrees can convert once at the authoring
 * boundary, and the runtime then has a single rows-from-angle function. Not done
 * here: the finisher studio serialises authored pitch in degrees, so collapsing
 * them is a change to a saved document format and belongs in its own task.
 */
export function pitchRowsForLookAngle(angle, fov, gridHeight) {
  const safeFov = Number.isFinite(fov) && fov > 0.01 ? fov : Math.PI / 3;
  const rows = Math.max(1, Number.isFinite(gridHeight) ? gridHeight : 1);
  return ((Number.isFinite(angle) ? angle : 0) / safeFov) * rows;
}

/**
 * Resolve a top-down tactical frame around a focus point.
 *
 * `focus` is anything carrying `x`, `y` and an optional `angle` - a squad
 * member, a cursor, a room centre. The azimuth is `focus.angle + orbit`, the
 * same composition the third-person rig uses, so a caller can drive it from the
 * squad's facing, from an operator's orbit input, or from both.
 *
 * Stateless, like `resolveThirdPersonCamera`. The eventual blend from this view
 * down into a helmet needs two frames it can interpolate between on demand, and
 * a rig that owns a spring can only tell you where it currently is.
 */
export function resolveTacticalCamera(focus, settings = {}) {
  const options = { ...TACTICAL_DEFAULTS, ...settings };
  const elevation = clamp(
    Number.isFinite(settings.elevation) ? settings.elevation : options.elevation,
    options.minimumElevation,
    options.maximumElevation
  );
  const range = clamp(
    Number.isFinite(settings.range) ? settings.range : options.range,
    options.minimumRange,
    options.maximumRange
  );
  // One range/elevation pair drives all three of the rig's independent knobs, so
  // the camera stays pointed at the focus while it zooms instead of sliding off
  // it. Z is negative upward.
  const groundDistance = range * Math.cos(elevation);
  const height = range * Math.sin(elevation);

  // The map is deliberately not passed. Collision retraction walks the XY line
  // between focus and camera, and for a camera hanging above the ceiling that
  // would haul it back down the moment a wall happened to lie underneath it.
  const frame = resolveThirdPersonCamera(focus, null, {
    ...options,
    shoulder: 'center',
    shoulderOffset: 0,
    distance: groundDistance,
    cameraZ: -height,
    pitchOffset: pitchRowsForLookAngle(elevation, options.fov, options.gridHeight),
    // The focus's own look input must not tilt the board.
    pitchInputScale: 0,
    minimumPitch: pitchRowsForLookAngle(options.minimumElevation, options.fov, options.gridHeight),
    maximumPitch: pitchRowsForLookAngle(options.maximumElevation, options.fov, options.gridHeight),
    isPositionBlocked: null
  });

  // Reported without the shoulder and avatar-fade fields. Those describe a
  // camera tucked behind somebody's head; there is no head here, and a consumer
  // reading `bodyFade` off a tactical frame would be reading a number that
  // does not mean anything.
  return Object.freeze({
    x: frame.x,
    y: frame.y,
    angle: frame.angle,
    pitch: frame.pitch,
    cameraZ: frame.cameraZ,
    fov: frame.fov,
    orbit: frame.orbit,
    range,
    elevation,
    groundDistance,
    height
  });
}

/**
 * Apply a resolved tactical frame to whatever the renderer is handed as its
 * camera.
 *
 * These six fields are the entire camera as far as `AsciiRendererWebGL#compile`
 * is concerned: it builds the eye from `x`, `y` and `cameraZ`, the look
 * direction from `angle` and `pitch`, and the projection from `fov`. Nothing
 * else on the object is read as camera state, which is why this writes exactly
 * those six and leaves the rest of the target alone - the same contract
 * `applySceneStudioCamera` has held to since Upgrade 82.
 */
export function applyTacticalCamera(target, frame) {
  target.x = frame.x;
  target.y = frame.y;
  target.angle = frame.angle;
  target.pitch = frame.pitch;
  target.cameraZ = frame.cameraZ;
  target.fov = frame.fov;
  return target;
}
