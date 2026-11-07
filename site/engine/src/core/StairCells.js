// Optional sub-cell stairs. Heights/rise use world units; x/y are cell-local
// fractions. Ordinary cells retain their original full-cell solid envelope.
export function stairProfile(cell) {
  const count = cell?.stairSteps, rise = cell?.stairRise;
  const direction = cell?.stairDirection ?? 'east';
  const top = cell?.height, base = cell?.base ?? 0;
  if (!Number.isInteger(count) || count < 2 || count > 16
    || !Number.isFinite(top) || !Number.isFinite(base) || !Number.isFinite(rise)
    || rise <= 0 || rise > top - base
    || !['east', 'west', 'south', 'north'].includes(direction)) return null;
  return { count, rise, direction, top, base };
}

export function stairSurfaceAt(cell, localX, localY) {
  const stair = stairProfile(cell);
  if (!stair) return cell?.height;
  let along = stair.direction === 'east' || stair.direction === 'west' ? localX : localY;
  if (!Number.isFinite(along)) return stair.top;
  if (stair.direction === 'west' || stair.direction === 'north') along = 1 - along;
  const step = Math.min(stair.count - 1, Math.max(0, Math.floor(along * stair.count)));
  return stair.top - stair.rise + stair.rise * (step + 1) / stair.count;
}

export function stairCellBoxes(cell) {
  const stair = stairProfile(cell);
  if (!stair) return null;
  const horizontal = stair.direction === 'east' || stair.direction === 'west';
  const reverse = stair.direction === 'west' || stair.direction === 'north';
  return Array.from({ length: stair.count }, (_, step) => {
    const center = (step + .5) / stair.count, along = reverse ? 1 - center : center;
    return { x: horizontal ? along : .5, y: horizontal ? .5 : along,
      sizeX: horizontal ? 1 / stair.count : 1, sizeY: horizontal ? 1 : 1 / stair.count,
      height: stair.top - stair.rise + stair.rise * (step + 1) / stair.count,
      base: stair.base };
  });
}
