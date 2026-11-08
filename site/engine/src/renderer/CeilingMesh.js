/**
 * CeilingMesh.js — pure geometry derivation for per-cell ceilings.
 *
 * The renderer's static mesh needs two things from a ceiling field: the
 * actual ceiling z over every open cell, and the clerestory bands — the
 * wall strips that close the gap where two open cells of different heights
 * meet, so a doorway under a tall hall shows a lit upper wall instead of a
 * hole into the void. Both are pure functions of (map, field), kept here so
 * a test can walk every open-open edge and assert a band wherever heights
 * differ without touching WebGL.
 *
 * The field is optional everywhere: absent (or sized for a different map,
 * which is what the Black Annex's own swapped-in grid looks like), every
 * cell gets the uniform WORLD_CEILING_Z and no bands exist — bit-identical
 * to the world before zone ceilings.
 */

import { WORLD_CEILING_Z, WORLD_FLOOR_Z } from './WorldZ.js';

const EPSILON = 1e-4;

/** Per-cell ceiling z as a Float32Array over the whole grid. */
export function resolveCeilingZGrid(map, field, {floorZ = WORLD_FLOOR_Z, ceilingZ = WORLD_CEILING_Z} = {}) {
  const height = map.length;
  const width = map[0].length;
  const ceilZ = new Float32Array(width * height).fill(ceilingZ);
  if (!field || !field.classes || field.width !== width || field.height !== height) {
    return ceilZ;
  }
  for (let index = 0; index < ceilZ.length; index++) {
    const classHeight = field.heights ? field.heights[field.classes[index]] : undefined;
    if (Number.isFinite(classHeight) && classHeight > 0) ceilZ[index] = floorZ - classHeight;
  }
  return ceilZ;
}

/**
 * Every boundary between two OPEN cells whose ceilings differ, exactly once.
 *
 * Each band record is a vertical strip on the shared cell edge, spanning
 * from the lower ceiling up to the higher one, with its normal facing the
 * lower cell — the side from which it reads as the wall over an opening.
 * `a` and `b` are the strip's floor-line endpoints in the winding the
 * renderer's wall courses expect.
 */
export function collectClerestoryBands(map, ceilZ) {
  const bands = [];
  const height = map.length;
  const width = map[0].length;
  const isOpen = (x, y) => map[y][x] === 0 || map[y][x] === 9;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isOpen(x, y)) continue;
      const here = ceilZ[y * width + x];

      // Eastern neighbour: band on the x+1 plane.
      if (x + 1 < width && isOpen(x + 1, y)) {
        const there = ceilZ[y * width + x + 1];
        if (Math.abs(here - there) > EPSILON) {
          // z runs downward: the LOWER ceiling is the larger z.
          const lowerIsHere = here > there;
          bands.push({
            a: lowerIsHere ? [x + 1, y + 1] : [x + 1, y],
            b: lowerIsHere ? [x + 1, y] : [x + 1, y + 1],
            normal: lowerIsHere ? [-1, 0, 0] : [1, 0, 0],
            zBottom: Math.max(here, there),
            zTop: Math.min(here, there)
          });
        }
      }

      // Southern neighbour: band on the y+1 plane.
      if (y + 1 < height && isOpen(x, y + 1)) {
        const there = ceilZ[(y + 1) * width + x];
        if (Math.abs(here - there) > EPSILON) {
          const lowerIsHere = here > there;
          bands.push({
            a: lowerIsHere ? [x, y + 1] : [x + 1, y + 1],
            b: lowerIsHere ? [x + 1, y + 1] : [x, y + 1],
            normal: lowerIsHere ? [0, -1, 0] : [0, 1, 0],
            zBottom: Math.max(here, there),
            zTop: Math.min(here, there)
          });
        }
      }
    }
  }
  return bands;
}
