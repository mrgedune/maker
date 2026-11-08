/**
 * Opt-in stroke glyphs (display.strokeGlyphs): line and shade characters drawn
 * per screen pixel instead of sampled from the font atlas.
 *
 * The atlas is 32x64 per glyph, so a 4x6 cell reads it three mip levels down:
 * a thin stroke averages across its column and its neighbours, the coverage
 * threshold inks all of them, and '|' fills the whole cell. Shade glyphs fare
 * worse, since their 2x2 atlas dither averages to a flat 25/50/75% that the
 * threshold turns solid in any cell narrower than the atlas glyph. Drawn here,
 * a stroke is whole pixels snapped to the cell, one pixel thick until the cell
 * is large enough for more, and a shade is an exact screen-pixel dither, so
 * ASCII texture survives at 4x6 and smaller.
 *
 * strokeGlyphCoverage returns exact coverage (0 or 1), or -1 for a glyph with
 * no stroke form, which then samples the atlas as before. With the option off
 * (the default) the raster never calls it.
 */
import { glyphIndexForChar } from './GlyphPipeline.js';

/** Characters with a procedural stroke form. Order is documentation only. */
export const STROKE_GLYPH_CHARS = ".,'\"`:;!|/\\-_=+lIi#xX*()░▒▓";

const G = (char) => glyphIndexForChar(char);

export const STROKE_GLYPH_BLOCK = `
  uniform bool u_strokeGlyphs;

  bool inSpan(int v, int start, int len) { return v >= start && v < start + len; }

  // Column of a diagonal at row y; a rising diagonal is '/'.
  int diagonalColumn(int y, int rowFirst, int rowLast, int width, bool rising) {
    float span = float(max(rowLast - rowFirst, 1));
    float k = clamp(float(y - rowFirst) / span, 0.0, 1.0);
    return int(floor((rising ? 1.0 - k : k) * float(width - 1) + 0.5));
  }

  float strokeGlyphCoverage(int g, vec2 local, vec2 cellSize) {
    int W = max(int(floor(cellSize.x + 0.001)), 1);
    int H = max(int(floor(cellSize.y + 0.001)), 1);
    int x = clamp(int(floor(local.x * cellSize.x)), 0, W - 1);
    int y = clamp(int(floor(local.y * cellSize.y)), 0, H - 1); // row from the top
    int t = max(1, min(W, H / 2) / 5);          // stroke weight
    int cx = (W - t) / 2;                       // centred vertical stroke
    int cy = (H - t) / 2;                       // centred horizontal stroke
    int rTop = H / 8;                           // glyph body, inclusive rows
    int rBot = H - 1 - H / 8;
    int dotRow = rBot - t + 1;                  // a dot sits on the baseline
    int midRow = rTop + (rBot - rTop) / 3;      // the upper dot of ':'
    int side = max(1, W / 6);                   // margin of '-', '=' and '+'
    int tail = max(cx - 1, 0);                  // the hook of ',' and ';'
    bool vStem = inSpan(x, cx, t);
    bool dot = vStem && y >= dotRow && y <= rBot;
    bool hook = x == tail && y == min(rBot + 1, H - 1) && rBot + 1 < H;
    bool ink = false;

    if (g == ${G('░')}) return (x % 2 == 0 && y % 2 == 0) ? 1.0 : 0.0;
    if (g == ${G('▒')}) return ((x + y) % 2 == 0) ? 1.0 : 0.0;
    if (g == ${G('▓')}) return (x % 2 == 1 && y % 2 == 1) ? 0.0 : 1.0;

    if (g == ${G('.')}) ink = dot;
    else if (g == ${G(',')}) ink = dot || hook;
    else if (g == ${G("'")}) ink = vStem && y >= rTop && y < rTop + max(t + 1, H / 4);
    else if (g == ${G('"')}) {
      int gap = max(1, W / 4);
      ink = (inSpan(x, max(cx - gap, 0), t) || inSpan(x, min(cx + gap, W - t), t))
        && y >= rTop && y < rTop + max(t + 1, H / 4);
    }
    else if (g == ${G('`')}) ink = y >= rTop && y < rTop + 2 && x == clamp(cx - 1 + (y - rTop), 0, W - 1);
    else if (g == ${G(':')}) ink = (vStem && inSpan(y, midRow, t)) || dot;
    else if (g == ${G(';')}) ink = (vStem && inSpan(y, midRow, t)) || dot || hook;
    else if (g == ${G('!')}) ink = (vStem && y >= rTop && y < dotRow - 1) || dot;
    else if (g == ${G('|')}) ink = vStem;
    else if (g == ${G('/')} || g == ${G('\\')}) {
      int column = diagonalColumn(y, 0, H - 1, W, g == ${G('/')});
      ink = inSpan(x, column - (t - 1) / 2, t);
    }
    else if (g == ${G('-')}) ink = inSpan(y, cy, t) && x >= side - 1 && x < W - side + 1;
    else if (g == ${G('_')}) ink = y >= H - t;
    else if (g == ${G('=')}) {
      int d = max(1, H / 6);
      ink = (inSpan(y, cy - d, t) || inSpan(y, cy + d, t)) && x >= side - 1 && x < W - side + 1;
    }
    else if (g == ${G('+')}) {
      ink = (inSpan(y, cy, t) && x >= side - 1 && x < W - side + 1) || (vStem && y >= H / 4 && y < H - H / 4);
    }
    else if (g == ${G('l')}) ink = (vStem && y >= rTop && y <= rBot) || (W >= 5 && y > rBot - t && y <= rBot && inSpan(x, cx + t, t));
    else if (g == ${G('I')}) {
      bool serif = (inSpan(y, rTop, t) || (y > rBot - t && y <= rBot)) && x >= max(cx - 1, 0) && x <= min(cx + t, W - 1);
      ink = (vStem && y >= rTop && y <= rBot) || serif;
    }
    else if (g == ${G('i')}) ink = vStem && (inSpan(y, rTop, t) || (y >= rTop + t + 1 && y <= rBot));
    else if (g == ${G('#')}) {
      int x1 = W / 4;
      int x2 = W - 1 - W / 4 - (t - 1);
      int y1 = H / 3;
      int y2 = H - 1 - H / 3 - (t - 1);
      ink = ((inSpan(x, x1, t) || inSpan(x, x2, t)) && y >= rTop && y <= rBot) || inSpan(y, y1, t) || inSpan(y, y2, t);
    }
    else if (g == ${G('x')} || g == ${G('X')}) {
      int first = g == ${G('X')} ? rTop : H / 3;
      if (y >= first && y <= rBot) {
        ink = inSpan(x, diagonalColumn(y, first, rBot, W, true) - (t - 1) / 2, t)
          || inSpan(x, diagonalColumn(y, first, rBot, W, false) - (t - 1) / 2, t);
      }
    }
    else if (g == ${G('*')}) {
      int last = rTop + (rBot - rTop) / 2 + 1;
      if (y >= rTop && y <= last) {
        ink = vStem || inSpan(x, diagonalColumn(y, rTop, last, W, true) - (t - 1) / 2, t)
          || inSpan(x, diagonalColumn(y, rTop, last, W, false) - (t - 1) / 2, t);
      }
    }
    else if (g == ${G('(')} || g == ${G(')')}) {
      bool open = g == ${G('(')};
      int stem = open ? max(cx - side + 1, 0) : min(cx + side - 1, W - t);
      int lip = open ? min(stem + t, W - 1) : max(stem - 1, 0);
      ink = (inSpan(x, stem, t) && y > rTop && y < rBot) || ((y == rTop || y == rBot) && x == lip);
    }
    else return -1.0;
    return ink ? 1.0 : 0.0;
  }
`;
