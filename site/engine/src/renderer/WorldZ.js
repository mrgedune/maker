/**
 * WorldZ.js — the vertical convention, stated once.
 *
 * The world's z-axis points DOWN: the floor plane is at +0.5 and everything
 * above it is more negative. A cell has always been exactly one unit tall,
 * which made the ceiling -0.5 — and that number was written independently in
 * the static mesh builder, the scene builder's defaults, and half a dozen
 * fixture offsets, so raising the ceiling meant finding all of them. This
 * module is the one place the wall height lives; everything else derives.
 *
 * Two planes here are ARCHITECTURE and one is a PERSON, and they scale
 * differently — this is the gauge that makes a taller world legible at all:
 *
 *   - WORLD_FLOOR_Z stays put. Feet, sprites, props, particles, and the
 *     camera are floor-anchored; moving the floor moves the whole game.
 *   - The EYE stays put (player.cameraZ = 0, half a unit over the floor —
 *     see SceneOcclusion.SCENE_EYE_Z for the occlusion plane). A raised
 *     ceiling read from the same eye height is a genuinely taller room; an
 *     eye that scaled with the room would cancel the change exactly.
 *   - Only the CEILING moves: ceilingZFor(height) = floor minus height.
 *
 * So do not "tidy up" by scaling the player's radius (0.25), speed (3.5), or
 * eye height alongside a wall-height or grid-scale change: uniform scale is
 * only perceptible through those ratios, and scaling them cancels the
 * feature. docs/upgrade88_world_scale_plan.md is the contract.
 */

/** The floor plane. Fixed — see the gauge note above. */
export const WORLD_FLOOR_Z = 0.5;

/**
 * Floor-to-ceiling height of standard architecture, in world units.
 *
 * 1.0 is the game as it was for its whole life; 1.25 is upgrade 88's first
 * lift — enough that a full-cell sprite no longer touches the ceiling line,
 * before zone-dependent heights arrive. Wall faces taller than one unit
 * tile their texture in unit courses rather than stretching it.
 */
export const WORLD_WALL_HEIGHT = 1.25;

/** The ceiling plane for a space of the given height. */
export function ceilingZFor(height = WORLD_WALL_HEIGHT) {
  return WORLD_FLOOR_Z - (Number.isFinite(height) && height > 0 ? height : WORLD_WALL_HEIGHT);
}

/** The standard ceiling plane — historically the literal -0.5. */
export const WORLD_CEILING_Z = ceilingZFor();

/**
 * A z hung a fixed drop BELOW the ceiling, for the things that live up there:
 * tubes, sparks, beacons. Written this way so a fixture keeps its distance
 * from the ceiling when the ceiling moves, instead of staying at the old
 * ceiling's height and floating mid-air in a taller room.
 */
export function ceilingDrop(drop, height = WORLD_WALL_HEIGHT) {
  return ceilingZFor(height) + (Number.isFinite(drop) ? drop : 0);
}

/** The vertical middle of a wall panel — where a centered thing hovers. */
export function wallMidZ(height = WORLD_WALL_HEIGHT) {
  return (WORLD_FLOOR_Z + ceilingZFor(height)) / 2;
}

/**
 * The margin a body is taken PAST a plane it is meant to have left through.
 *
 * A mesh does not stop exactly on the plane it stands on: the operative's boot
 * soles reach 0.0045 below the floor plane, so a lift of exactly the room's
 * height leaves the last four thousandths of a body under the ceiling. This is
 * an order of magnitude over that, which is small enough to be invisible and
 * large enough that the closing frame is unambiguously empty rather than
 * tangent — two coincident surfaces in a depth buffer are a coin toss, and the
 * toss here is "is there a boot in the victory shot".
 *
 * Taste, in the sense that 0.04 or 0.08 would do the same job. What is NOT
 * taste is that it is a margin on top of a derived height rather than a height.
 */
export const WORLD_CLEARANCE = 0.05;

/**
 * The lift that takes a body standing on the deck entirely past the ceiling.
 *
 * The escape ascent is the one sequence that needs it, and it is here rather
 * than in the choreography because it is a fact about the ROOM. Written as the
 * distance between the two planes rather than as `height + clearance` so it
 * still means what it says if the floor ever moves: what a climbing body has to
 * cover is floor-to-ceiling, whatever those two numbers are.
 *
 * This is also the bound on `renderLift` in the entity assembly. That clamp used
 * to be a literal 1 with the reasoning "a body's own height plus 0.007, so it is
 * almost exactly far enough to leave the room and no further" — reasoning about
 * the room, expressed in a number that only equalled the room's height while the
 * room was one unit tall. Upgrade 88 made it 1.25 and the clamp went on cutting
 * the climb off a quarter of a body short, which is a pair of boots hanging out
 * of the ceiling under the victory receipt.
 */
export function ceilingClearingLift(height = WORLD_WALL_HEIGHT) {
  return (WORLD_FLOOR_Z - ceilingZFor(height)) + WORLD_CLEARANCE;
}

/** The standard ceiling-clearing lift, for architecture of the standard height. */
export const WORLD_CEILING_CLEARING_LIFT = ceilingClearingLift();
