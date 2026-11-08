import { glyphIndexForChar } from './GlyphPipeline.js';
import { TITLE_FONT, titleGlyphRows } from './GlyphTitleFont.js';

const REZ_GLYPHS = '#%&*+=/\\|:;!?<>';

// Bit 7 of a cell's glyph byte marks a backing plate under the cell. The font
// atlas holds at most 128 glyphs (indices 0-127), so the bit never collides
// with a glyph index.
export const HUD_PLATE_BIT = 0x80;

// Deterministic per-cell threshold in [0, 1): where along the progress a cell
// appears. A pure function of position and seed, so a reveal never flickers
// between frames at the same progress.
function rezRank(col, row, seed) {
  let h = (Math.imul(col + 1, 0x9E3779B1) ^ Math.imul(row + 7, 0x85EBCA77) ^ Math.imul(seed + 13, 0xC2B2AE3D)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * What a cell shows at a rez progress. Below its threshold it is empty; for a
 * short band above it shows a scramble glyph that changes in steps of the
 * progress; after that the real glyph. Returns null for empty.
 */
function rezGlyph(char, col, row, progress, options) {
  if (!Number.isFinite(progress) || progress >= 1) return char;
  if (progress <= 0) return null;
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
  const band = Number.isFinite(options.scramble) ? Math.max(0, Math.min(1, options.scramble)) : 0.15;
  // Thresholds span [0, 1 - band] so every cell has settled at progress 1.
  const threshold = rezRank(col, row, seed) * (1 - band);
  if (progress < threshold) return null;
  if (progress >= threshold + band) return char;
  const glyphs = typeof options.glyphs === 'string' && options.glyphs.length ? [...options.glyphs] : [...REZ_GLYPHS];
  const step = Math.floor(progress * 40);
  return glyphs[Math.floor(rezRank(col + step, row, seed + 101) * glyphs.length)];
}

/**
 * A CPU-side glyph canvas for the engine-rendered HUD.
 *
 * The layer owns a coarse grid of HUD cells (one glyph each, sized in screen
 * pixels independently of the scene's glyph cells) and the RGBA buffer the
 * renderer uploads: rgb = color, a = glyph index, 0 = empty, with bit 7 set
 * where a backing plate darkens the frame (see plate()). Row 0 is the top
 * row. Pure data - no GL - so games can unit-test their HUD drawing.
 */
export class HudGlyphLayer {
  constructor({ cellWidth = 9, cellHeight = 16 } = {}) {
    this.cellWidth = Math.max(4, Math.round(cellWidth));
    this.cellHeight = Math.max(6, Math.round(cellHeight));
    this.columns = 0;
    this.rows = 0;
    this.cells = new Uint8Array(0);
    this.dirty = false;
  }

  /** Fit the grid to a canvas; keeps content only if dimensions are equal. */
  resize(canvasWidth, canvasHeight) {
    const columns = Math.max(1, Math.floor(canvasWidth / this.cellWidth));
    const rows = Math.max(1, Math.floor(canvasHeight / this.cellHeight));
    if (columns === this.columns && rows === this.rows) return this;
    this.columns = columns;
    this.rows = rows;
    this.cells = new Uint8Array(columns * rows * 4);
    this.dirty = true;
    return this;
  }

  clear() {
    this.cells.fill(0);
    this.dirty = true;
    return this;
  }

  /** Write one glyph. Color: '#rrggbb' or [r,g,b] 0-255. */
  set(col, row, char, color) {
    if (col < 0 || row < 0 || col >= this.columns || row >= this.rows) return this;
    const [r, g, b] = parseColor(color);
    const index = (row * this.columns + col) * 4;
    this.cells[index] = r;
    this.cells[index + 1] = g;
    this.cells[index + 2] = b;
    this.cells[index + 3] = (this.cells[index + 3] & HUD_PLATE_BIT) | glyphIndexForChar(char);
    this.dirty = true;
    return this;
  }

  /**
   * A dark backing plate under a block of cells, so text over a bright scene
   * stays readable. The plate darkens the frame under each whole cell, with or
   * without a glyph in it; glyphs written before or after keep it until
   * clear(). Clips at the edges.
   */
  plate(col, row, width = 1, height = 1) {
    const c0 = Math.max(0, Math.floor(col)), c1 = Math.min(this.columns, Math.floor(col + width));
    const r0 = Math.max(0, Math.floor(row)), r1 = Math.min(this.rows, Math.floor(row + height));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) this.cells[(r * this.columns + c) * 4 + 3] |= HUD_PLATE_BIT;
    }
    if (c1 > c0 && r1 > r0) this.dirty = true;
    return this;
  }

  /** Write a string left-to-right; clips at the right edge. */
  text(col, row, string, color) {
    for (let i = 0; i < string.length; i++) {
      this.set(col + i, row, string[i], color);
    }
    return this;
  }

  /**
   * Change the HUD cell size, the size every HUD glyph draws at. The grid is
   * refitted to the canvas and cleared.
   */
  setCellSize(cellWidth, cellHeight, canvasWidth = this.columns * this.cellWidth, canvasHeight = this.rows * this.cellHeight) {
    this.cellWidth = Math.max(4, Math.round(cellWidth));
    this.cellHeight = Math.max(6, Math.round(cellHeight));
    this.columns = 0;
    this.rows = 0;
    return this.resize(canvasWidth, canvasHeight);
  }

  /**
   * Text that rezzes in and out with progress (0 hidden, 1 shown; play it
   * backwards to rez out). Each cell appears at its own deterministic point,
   * flickering through scramble glyphs for a short band first.
   *   options.glyphs   the scramble set (default '#%&*+=/\\|:;!?<>')
   *   options.scramble width of the scramble band in progress (default 0.15)
   *   options.seed     changes the order cells appear in
   */
  rezText(col, row, string, color, progress = 1, options = {}) {
    const chars = [...String(string)];
    for (let i = 0; i < chars.length; i++) {
      const shown = rezGlyph(chars[i], col + i, row, progress, options);
      if (shown !== null) this.set(col + i, row, shown, color);
    }
    return this;
  }

  /**
   * Large title text: each character drawn from a 5x7 bitmap font with one HUD
   * cell per lit pixel (times `scale`), so a title is spelled in engine
   * glyphs. Lowercase draws as uppercase; characters without a bitmap leave a
   * gap. Position is the top-left HUD cell, or centred on the layer when col
   * or row is 'center'.
   *   options.fill     the glyph for lit pixels (default '█'), or a string
   *                    cycled across the pixels ('#@%')
   *   options.scale    HUD cells per font pixel, integer >= 1 (default 1)
   *   options.progress rez progress as in rezText (default 1)
   *   options.glyphs, options.scramble, options.seed   as in rezText
   * Returns { col, row, columns, rows }: where the title landed, in HUD cells.
   */
  title(string, options = {}) {
    const chars = [...String(string)];
    const scale = Math.max(1, Math.floor(Number.isFinite(options.scale) ? options.scale : 1));
    const advance = (TITLE_FONT.width + TITLE_FONT.spacing) * scale;
    const columns = Math.max(0, chars.length * advance - TITLE_FONT.spacing * scale);
    const rows = TITLE_FONT.height * scale;
    const col = options.col === 'center' || options.col === undefined
      ? Math.floor((this.columns - columns) / 2) : Math.round(options.col);
    const row = options.row === 'center' || options.row === undefined
      ? Math.floor((this.rows - rows) / 2) : Math.round(options.row);
    const fill = typeof options.fill === 'string' && options.fill.length ? [...options.fill] : ['█'];
    const progress = Number.isFinite(options.progress) ? options.progress : 1;
    const color = options.color ?? [255, 255, 255];
    let lit = 0;
    chars.forEach((char, index) => {
      const bitmap = titleGlyphRows(char);
      if (!bitmap) return;
      for (let y = 0; y < TITLE_FONT.height; y++) {
        for (let x = 0; x < TITLE_FONT.width; x++) {
          if (bitmap[y][x] !== '#') continue;
          const glyph = fill[lit++ % fill.length];
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const c = col + index * advance + x * scale + sx;
              const r = row + y * scale + sy;
              const shown = rezGlyph(glyph, c, r, progress, options);
              if (shown !== null) this.set(c, r, shown, color);
            }
          }
        }
      }
    });
    return { col, row, columns, rows };
  }

  /** A horizontal meter: `t` in 0..1 fills `width` cells. */
  bar(col, row, width, t, options = {}) {
    const {
      fillChar = '█', emptyChar = '░',
      fillColor = [255, 255, 255], emptyColor = [90, 95, 110],
    } = options;
    const filled = Math.round(Math.max(0, Math.min(1, t)) * width);
    for (let i = 0; i < width; i++) {
      this.set(col + i, row, i < filled ? fillChar : emptyChar, i < filled ? fillColor : emptyColor);
    }
    return this;
  }

  /** The renderer-facing view of this layer. */
  snapshot() {
    return {
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      cells: this.cells,
    };
  }
}

function parseColor(color) {
  if (Array.isArray(color) && color.length >= 3) {
    return [clampByte(color[0]), clampByte(color[1]), clampByte(color[2])];
  }
  if (typeof color === 'string') {
    const hex = color.replace('#', '');
    const full = hex.length === 3 ? [...hex].map(part => part + part).join('') : hex;
    if (/^[0-9a-fA-F]{6}$/.test(full)) {
      return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ];
    }
  }
  return [255, 255, 255];
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)));
}
