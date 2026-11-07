// Copied from Critical Response (game/sim/dmath.js), not shared: the maker keeps its own copy.
// The simulation's trigonometry, the same to the last bit in every browser.
// Math.sin, Math.cos, Math.pow and Math.atan2 are left to each JavaScript
// engine, and they differ in the low bits: Node 22, Chromium 141 and Chrome
// 156 gave three different answers, so seed 4's run, identical at 60 s, had
// drifted apart by 120 s (2026-10-22). Everything here is built from + - * /
// and Math.sqrt, Math.round and Math.abs, which IEEE 754 fixes exactly, so a
// seed and its input replay the same run in any of them (plan decision 3).
//
// sin, cos and atan are fdlibm's (FreeBSD msun: k_sin.c, k_cos.c,
// e_rem_pio2.c, s_atan.c, e_atan2.c), within a unit in the last place of the
// true value. The simulation imports these instead of Math's (a test keeps it
// to that); the picture keeps Math's, since nothing it draws feeds back.

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

// sin of x on [-pi/4, pi/4], or of x + y with y the tail of a reduced x.
function kernelSin0(x) {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  return x + z * x * (S1 + z * r);
}

function kernelSin(x, y) {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

// cos of x + y on [-pi/4, pi/4].
function kernelCos(x, y) {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const one = 1 - hz;
  return one + (1 - one - hz + (z * r - x * y));
}

const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417; // the first 33 bits of pi/2
const PIO2_2 = 6.0771005063039659766e-11; // the next 33
const PIO2_2T = 2.02226624879595063154e-21; // pi/2 - (PIO2_1 + PIO2_2)
const PIO4 = 0.7853981633974483;

// x less the nearest multiple n of pi/2, as a head and a tail, and n.
// Exact to about 118 bits while |n| is under 2^20 (|x| under 1.6 million).
const reduced = [0, 0, 0];
function reduce(x) {
  const n = Math.round(x * INV_PIO2);
  const t = x - n * PIO2_1;
  let w = n * PIO2_2;
  const r = t - w;
  w = n * PIO2_2T - (t - r - w);
  const head = r - w;
  reduced[0] = head;
  reduced[1] = r - head - w;
  reduced[2] = n;
  return reduced;
}

export function sin(x) {
  // Under 2^-26 sin(x) rounds to x itself, -0 included.
  if (Math.abs(x) < 1.4901161193847656e-8) return x;
  if (Math.abs(x) <= PIO4) return kernelSin0(x);
  const [a, b, n] = reduce(x);
  switch (n & 3) {
    case 0:
      return kernelSin(a, b);
    case 1:
      return kernelCos(a, b);
    case 2:
      return -kernelSin(a, b);
    default:
      return -kernelCos(a, b);
  }
}

export function cos(x) {
  if (Math.abs(x) <= PIO4) return kernelCos(x, 0);
  const [a, b, n] = reduce(x);
  switch (n & 3) {
    case 0:
      return kernelCos(a, b);
    case 1:
      return -kernelSin(a, b);
    case 2:
      return -kernelCos(a, b);
    default:
      return kernelSin(a, b);
  }
}

export function tan(x) {
  return sin(x) / cos(x);
}

const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1,
  -1.1111110405462355788e-1, 9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2,
  -3.6531572744216915527e-2, 1.62858201153657823623e-2,
];

export function atan(x) {
  if (x !== x) return x;
  const negative = x < 0;
  let a = Math.abs(x);
  if (a >= 7.378697629483821e19) return negative ? -1.5707963267948966 : 1.5707963267948966;
  let id = -1;
  if (a >= 0.4375) {
    if (a < 1.1875) {
      if (a < 0.6875) {
        id = 0;
        a = (2 * a - 1) / (2 + a);
      } else {
        id = 1;
        a = (a - 1) / (a + 1);
      }
    } else if (a < 2.4375) {
      id = 2;
      a = (a - 1.5) / (1 + 1.5 * a);
    } else {
      id = 3;
      a = -1 / a;
    }
  } else if (a < 7.450580596923828e-9) return x;
  const z = a * a;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) {
    const r = a - a * (s1 + s2);
    return negative ? -r : r;
  }
  const r = ATAN_HI[id] - (a * (s1 + s2) - ATAN_LO[id] - a);
  return negative ? -r : r;
}

const PI = Math.PI; // a constant: the same double everywhere
const PI_LO = 1.2246467991473532e-16; // pi less PI
const PIO2 = PI / 2;
const negative = (v) => v < 0 || Object.is(v, -0);

export function atan2(y, x) {
  if (x !== x || y !== y) return NaN;
  if (x === 1) return atan(y);
  // Which side of each axis: bit 0 for y, bit 1 for x (a -0 counts as below).
  const m = (negative(y) ? 1 : 0) | (negative(x) ? 2 : 0);
  if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI;
  if (x === 0) return m & 1 ? -PIO2 : PIO2;
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) return [PIO4, -PIO4, 3 * PIO4, -3 * PIO4][m];
    return [0, -0, PI, -PI][m];
  }
  if (!Number.isFinite(y)) return m & 1 ? -PIO2 : PIO2;
  // fdlibm compares the exponents here; the ratio itself is as fixed a test.
  const ratio = Math.abs(y / x);
  if (ratio > 1.152921504606847e18) {
    const z = PIO2 + 0.5 * PI_LO;
    return m & 1 ? -z : z;
  }
  const z = m & 2 && ratio < 8.673617379884035e-19 ? 0 : atan(ratio);
  switch (m) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI - (z - PI_LO);
    default:
      return z - PI_LO - PI;
  }
}

export function asin(x) {
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

// The length of (x, y) or (x, y, z). Math.hypot's rounding is the engine's own.
export function hypot(x, y, z = 0) {
  return Math.sqrt(x * x + y * y + z * z);
}

// x to a whole power n, by squaring.
export function powi(x, n) {
  let result = 1;
  let base = n < 0 ? 1 / x : x;
  for (let k = Math.abs(n); k > 0; k = Math.floor(k / 2)) {
    if (k % 2) result *= base;
    base *= base;
  }
  return result;
}
