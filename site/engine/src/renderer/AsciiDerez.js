/** Deterministic, depth-tested ASCII fragments from an authored mesh surface. */
const STRIDE = 12, TRIANGLE = STRIDE * 3;
const GLYPHS = [
  ['111','101','101','101','111'], // 0
  ['010','110','010','010','111'], // 1
  ['101','111','101','111','101'], // #
  ['000','010','111','010','000'], // +
  ['000','010','000','010','000'], // :
  ['101','010','111','010','101']  // *
];
const clamp = n => Math.max(0, Math.min(1, n));
function rank(index) {
  let n = (index + 1) >>> 0, result = 0, place = .5;
  while (n) { result += (n & 1) * place; place *= .5; n >>>= 1; }
  return result;
}

/** Returns a new mesh for active progress; never changes cached source geometry.
 * At 0 it is byte-identical; at 1 empty. Z-up by default, upSign:-1 for Z-down.
 * At most 192 surface samples become upright, camera-facing 3x5 glyphs.
 * Whole source triangles drop in a fixed order; no random per-frame flicker.
 */
export function applyAsciiDerez(mesh, progress, camera = {}, options = {}) {
  if (!Number.isFinite(progress) || progress <= 0 || !mesh?.vertices?.length) return mesh;
  if (!(mesh.vertices instanceof Float32Array) || mesh.vertices.length % TRIANGLE !== 0
      || !mesh.vertices.every(Number.isFinite)) return mesh;
  options = options || {};
  camera = camera || {};
  const upSign = options.upSign === -1 ? -1 : 1;
  const fragmentCount = Number.isFinite(options.fragmentCount)
    ? Math.max(0, Math.min(192, Math.floor(options.fragmentCount))) : 192;
  const palette = Array.isArray(options.palette) && options.palette.length > 0
    && options.palette.every(color => Array.isArray(color) && color.length === 3 && color.every(Number.isFinite))
    ? options.palette.map(color => color.map(clamp)) : [[1, 1, 1]];
  const p = clamp(progress), source = mesh.vertices;
  if (p >= 1) return { ...mesh, vertices: new Float32Array(0), vertexCount: 0 };
  const triangles = Math.floor(source.length / TRIANGLE), out = [];
  const removed = clamp(p / .62);
  const areas = new Float64Array(triangles);
  let area = 0;
  for (let t = 0; t < triangles; t++) {
    const k = t * TRIANGLE;
    if (rank(t) > removed) {
      for (let j = 0; j < TRIANGLE; j++) out.push(source[k + j]);
    }
    const ax = source[k+12]-source[k], ay = source[k+13]-source[k+1], az = source[k+14]-source[k+2];
    const bx = source[k+24]-source[k], by = source[k+25]-source[k+1], bz = source[k+26]-source[k+2];
    area += Math.hypot(ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx);
    areas[t] = area;
  }
  // Area sampling gives the chest, limbs and helmet equal coverage per m2,
  // rather than giving highly tessellated visor details all the fragments.
  let triangle = 0;
  for (let i = 0; i < fragmentCount && area > 0; i++) {
    const sample = area * (i + .5) / fragmentCount;
    while (triangle < triangles - 1 && areas[triangle] < sample) triangle++;
    const age = (p - rank(i) * .48) / .52;
    if (age < 0 || age >= 1) continue;
    const k = triangle * TRIANGLE;
    const u = Math.sqrt(rank(i + 37)), v = rank(i + 113);
    const a = 1-u, b = u*(1-v), c = u*v;
    const theta = rank(i + 19) * Math.PI * 2;
    const drift = age * (.10 + .30 * rank(i + 67));
    const x = a*source[k]+b*source[k+12]+c*source[k+24] + Math.cos(theta)*drift;
    const y = a*source[k+1]+b*source[k+13]+c*source[k+25] + Math.sin(theta)*drift;
    const z = a*source[k+2]+b*source[k+14]+c*source[k+26] + upSign*age*(.18+.28*rank(i+91));
    const dx = (Number.isFinite(camera.x) ? camera.x : 0)-x, dy = (Number.isFinite(camera.y) ? camera.y : 0)-y;
    const distance = Math.hypot(dx,dy);
    const nx = distance > .0001 ? dx/distance : 1, ny = distance > .0001 ? dy/distance : 0;
    const rx = upSign*ny, ry = -upSign*nx;
    const size = (.045 + .024*rank(i+53)) * (1-.55*Math.max(0,(age-.65)/.35));
    const pixel = size/5, glyph = GLYPHS[i % GLYPHS.length];
    // The consumer owns the palette; fragments dim to nothing.
    const color = palette[i % palette.length];
    const light = clamp((1-age)/.27);
    const vertex = (col,row)=> {
      const right = (col-1.5)*pixel, down = (row-2.5)*pixel;
      out.push(x+rx*right,y+ry*right,z-upSign*down,nx,ny,0,
        color[0]*light,color[1]*light,color[2]*light,.7,1.2*light,0);
    };
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] !== '1') continue;
        const start = col;
        while (col+1 < 3 && glyph[row][col+1] === '1') col++;
        const end = col + .87;
        vertex(start,row);vertex(end,row);vertex(end,row+.87);
        vertex(start,row);vertex(end,row+.87);vertex(start,row+.87);
      }
    }
  }
  return { ...mesh, vertices: new Float32Array(out), vertexCount: out.length / STRIDE };
}
