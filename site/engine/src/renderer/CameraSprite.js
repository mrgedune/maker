/** Renderer-space quad aligned to the complete camera plane, including pitch.
 * Opt-in instrument art; ordinary upright/billboard sprites are unaffected.
 * roll (free cameras only) turns the quad with the view; 0 is the historical quad. */
export function cameraSpriteQuad(center, halfWidth, halfHeight, yaw, pitch, roll = 0) {
  const c=Math.cos(yaw),s=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  let right=[-s,c,0],up=[c*sp,s*sp,-cp];
  const normal=[-c*cp,-s*cp,-sp];
  if (roll) ({right, up} = rollBasis(right, up, roll));
  const corner=(x,y)=>center.map((v,i)=>v+right[i]*halfWidth*x+up[i]*halfHeight*y);
  return {p1:corner(-1,1),p2:corner(1,1),p3:corner(1,-1),p4:corner(-1,-1),n:normal};
}

/**
 * The camera's axes in renderer space (z points DOWN), from yaw, pitch and roll
 * in radians. Positive pitch looks toward the floor, as everywhere in the
 * renderer. Positive roll turns the camera clockwise about its forward axis, so
 * the picture turns counterclockwise.
 *
 * Unlike a lookAt against a fixed world up, this basis stays defined at every
 * pitch: straight down, straight up and past vertical, where the view keeps
 * turning instead of flipping. Free cameras build their view from it.
 */
export function cameraBasis(yaw, pitch, roll = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const forward = [c * cp, s * cp, sp];
  const basis = rollBasis([-s, c, 0], [c * sp, s * sp, -cp], roll);
  return { forward, right: basis.right, up: basis.up };
}

function rollBasis(right, up, roll) {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  return {
    right: right.map((v, i) => v * cr - up[i] * sr),
    up: up.map((v, i) => v * cr + right[i] * sr)
  };
}
