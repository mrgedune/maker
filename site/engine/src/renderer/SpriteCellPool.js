/**
 * Opt-in allocator for the sprite half of the atlas that takes cells back.
 *
 * The default allocator in `updateSpriteGeometry` gives every distinct static
 * sprite image one cell for the life of the renderer and never frees it. Once
 * the sprite half is full (224 cells with the default 32 static slots), every
 * image it has not seen before is silently skipped. A scene with a large
 * animated roster - eight facings times every animation frame - runs out in
 * under a minute.
 *
 * This pool keeps that layout and that order while there is room, and when the
 * atlas is full it hands the least recently used image's cell to the new one.
 * The only sprites it ever has to skip are the ones past the number of
 * different images that can be on screen in ONE frame, because a cell can hold
 * one image at a time.
 *
 * Same cells as the default while nothing has been evicted: static images take
 * the highest free cell, animated instances the lowest, exactly as the default
 * allocator does. A scene that never fills the atlas gets the same cell
 * indices, so the same frame, with the pool on or off.
 *
 * Free of DOM and WebGL so it can be tested on its own.
 */
export class SpriteCellPool {
  /**
   * @param {object} options
   * @param {number} options.firstCell First sprite cell (the static material
   *   slots sit below it).
   * @param {number} options.totalCells Cells in the whole atlas.
   * @param {Map} options.assignments The renderer's template -> cell map. The
   *   pool keeps it in least-recently-used order (oldest first) and edits it in
   *   place, so `registerSprite` still finds a template's cell there.
   */
  constructor({ firstCell, totalCells, assignments }) {
    this.firstCell = firstCell;
    this.totalCells = totalCells;
    this.assignments = assignments;
    this.owners = new Array(totalCells).fill(undefined);
    for (const [type, cell] of assignments) this.owners[cell] = type;
    // The frame each cell was last claimed in. A claimed cell is never handed
    // to anything else in the same frame.
    this.claimedIn = new Int32Array(totalCells).fill(-1);
    this.frame = 0;
    this.topCursor = totalCells - 1;
    this.bottomCursor = firstCell;
    // Lifetime count of cells handed from one image to another.
    this.recycledCells = 0;
    // Per frame: cells in use, and sprites skipped because every cell was.
    this.cellsInUse = 0;
    this.skippedSprites = 0;
  }

  beginFrame() {
    this.frame++;
    this.topCursor = this.totalCells - 1;
    this.bottomCursor = this.firstCell;
    this.cellsInUse = 0;
    this.skippedSprites = 0;
  }

  /** The cell a static image draws from this frame, or -1 if none is free. */
  claimStatic(type) {
    const held = this.assignments.get(type);
    if (held !== undefined) {
      if (this.claimedIn[held] !== this.frame) {
        this.claimedIn[held] = this.frame;
        this.cellsInUse++;
        // Most recently used moves to the back of the map.
        this.assignments.delete(type);
        this.assignments.set(type, held);
      }
      return held;
    }
    let cell = this.freeFromTop();
    if (cell < 0) cell = this.evictLeastRecent();
    if (cell < 0) return this.skip();
    this.owners[cell] = type;
    this.assignments.set(type, cell);
    return this.claim(cell);
  }

  /** A cell for one animated sprite instance this frame, or -1. */
  claimInstance() {
    let cell = this.freeFromBottom();
    if (cell < 0) cell = this.evictLeastRecent();
    if (cell < 0) return this.skip();
    return this.claim(cell);
  }

  claim(cell) {
    this.claimedIn[cell] = this.frame;
    this.cellsInUse++;
    return cell;
  }

  skip() {
    this.skippedSprites++;
    return -1;
  }

  // Within a frame the set of free cells only shrinks (an eviction hands its
  // cell straight to the claimant), so both scans resume where they stopped.
  freeFromTop() {
    while (this.topCursor >= this.firstCell) {
      const cell = this.topCursor--;
      if (this.owners[cell] === undefined && this.claimedIn[cell] !== this.frame) return cell;
    }
    return -1;
  }

  freeFromBottom() {
    while (this.bottomCursor < this.totalCells) {
      const cell = this.bottomCursor++;
      if (this.owners[cell] === undefined && this.claimedIn[cell] !== this.frame) return cell;
    }
    return -1;
  }

  // Images used this frame sit at the back of the map, so if the front one was
  // used this frame, all of them were and nothing can be evicted.
  evictLeastRecent() {
    const oldest = this.assignments.entries().next();
    if (oldest.done) return -1;
    const [type, cell] = oldest.value;
    if (this.claimedIn[cell] === this.frame) return -1;
    this.assignments.delete(type);
    this.owners[cell] = undefined;
    this.recycledCells++;
    return cell;
  }
}
