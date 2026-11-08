/**
 * The `figure` archetype: a parametric, posable human for games and videos
 * that need a character the fixed archetypes don't have. Nothing is stored
 * between frames: every joint angle, outfit choice and held prop comes from
 * `entity.params` on each build, so a frame depends only on its params.
 *
 * Local frame as every archetype: +x forward (the heading), +y right, z DOWN,
 * soles at +0.5 when standing straight. About one cell tall.
 *
 * Pose (radians, all optional, default 0 = standing, arms down):
 *   lean, turn            spine pitch forward and yaw of the upper body
 *   crouch                0..1, lowers the pelvis and bends the knees
 *   headPitch, headTurn
 *   armL, armR            { raise, spread, elbow }: raise swings the arm
 *                         forward and up (PI/2 points forward, PI up),
 *                         spread swings it out to the side, elbow bends the
 *                         forearm (0 straight)
 *   legL, legR            { lift, knee, spread }: lift swings the thigh
 *                         forward, knee bends the shin back
 * Outfit (all optional):
 *   hair   'short' | 'choppy' | 'slick' | 'swept' | 'long' | 'none'
 *   top    'suit' (jacket, white shirt, tie) | 'jacket' | 'bodysuit'
 *   coat   0..1 length of an open long coat over everything (0 none);
 *          coatFlare 0..1 swings its hem out behind
 *   gloves 'none' | 'short' | 'opera'; boots 'shoe' | 'thigh'
 *   moustache, choker, earrings, shoulderPads (booleans)
 *   devil  true: a dark face, shark teeth, glowing eyes
 * Props: an array of { at, kind, length?, angle?, spin? } held or mounted:
 *   at     'handL' | 'handR' | 'forearmL' | 'forearmR' | 'head'
 *   kind   'chainsaw' | 'sword' | 'pistol'
 *   angle  radians the prop turns off the forearm toward the elbow's bend
 *          (a held sword ~1.4, a forearm saw 0)
 *   spin   0..1 chain phase: advance it to run the chain
 *
 * Palette hints: j jacket/coat, J coat lining, w shirt, t tie, k bodysuit and
 * dark details, p trousers, b boots, g gloves, s skin, h hair, e eyes and
 * brows, l lips, m metal, M bright metal (blade edges, saw teeth), r red glow
 * (devil eyes). Authored lit (emission 0.08-0.2) except M and r.
 */
import { ENTITY_LOD, createMeshBuffer, createBasis, addLocalEllipsoid, addLocalSegment, finishMesh, resolveMaterial } from './EntityGeometry.js';

const num = (v, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : fallback));
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Resolved params with defaults and clamps; exported for tests. */
export function resolveFigureParams(params) {
  const p = params && typeof params === 'object' ? params : {};
  const arm = (a) => ({ raise: num(a?.raise, 0, -1, 3.3), spread: num(a?.spread, 0.08, -0.5, 2), elbow: num(a?.elbow, 0.15, 0, 2.6) });
  const leg = (a) => ({ lift: num(a?.lift, 0, -1, 2.2), knee: num(a?.knee, 0, 0, 2.6), spread: num(a?.spread, 0.04, -0.3, 0.8) });
  const props = Array.isArray(p.props) ? p.props.filter((q) => q && ['chainsaw', 'sword', 'pistol'].includes(q.kind) && ['handL', 'handR', 'forearmL', 'forearmR', 'head'].includes(q.at)) : [];
  return {
    lean: num(p.lean, 0, -1, 1.4), turn: num(p.turn, 0, -1.6, 1.6), crouch: num(p.crouch, 0, 0, 1),
    headPitch: num(p.headPitch, 0, -0.8, 0.8), headTurn: num(p.headTurn, 0, -1.2, 1.2),
    armL: arm(p.armL), armR: arm(p.armR), legL: leg(p.legL), legR: leg(p.legR),
    hair: ['short', 'choppy', 'slick', 'swept', 'long', 'none'].includes(p.hair) ? p.hair : 'short',
    top: ['suit', 'jacket', 'bodysuit'].includes(p.top) ? p.top : 'jacket',
    coat: num(p.coat, 0, 0, 1), coatFlare: num(p.coatFlare, 0, 0, 1),
    gloves: ['none', 'short', 'opera'].includes(p.gloves) ? p.gloves : 'none',
    boots: p.boots === 'thigh' ? 'thigh' : 'shoe',
    moustache: p.moustache === true, choker: p.choker === true, earrings: p.earrings === true,
    shoulderPads: p.shoulderPads === true, devil: p.devil === true,
    props: props.map((q) => ({ at: q.at, kind: q.kind, length: num(q.length, q.kind === 'pistol' ? 0.12 : q.kind === 'sword' ? 0.62 : 0.42, 0.05, 2), angle: num(q.angle, q.kind === 'sword' ? 1.4 : q.kind === 'pistol' ? 1.45 : 0, -3.2, 3.2), spin: num(q.spin, 0, 0, 1) })),
  };
}

export function buildFigureMesh(entity, time = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return finishMesh([], ENTITY_LOD.BILLBOARD);
  }
  const P = resolveFigureParams(entity.params);
  const vertices = createMeshBuffer();
  const basis = createBasis(entity);
  const full = lod === ENTITY_LOD.FULL;
  const segs = full ? 9 : 5;
  const rings = full ? 7 : 4;
  const mat = (char, color, emission = 0.12, lightResponse = 0.85) => resolveMaterial(entity, { color, roughness: 0.75, emission, lightResponse }, options, 0.5, 0.5, char);
  const M = {
    j: mat('j', [0.10, 0.10, 0.12]), J: mat('J', [0.55, 0.06, 0.09], 0.2), w: mat('w', [0.86, 0.87, 0.88], 0.18), t: mat('t', [0.06, 0.06, 0.07]),
    k: mat('k', [0.06, 0.06, 0.07], 0.08), p: mat('p', [0.08, 0.08, 0.09]), b: mat('b', [0.05, 0.05, 0.06], 0.08), g: mat('g', [0.06, 0.06, 0.07], 0.08),
    s: mat('s', [0.88, 0.80, 0.76], 0.2), h: mat('h', [0.08, 0.08, 0.10], 0.08), e: mat('e', [0.02, 0.02, 0.02], 0.02), l: mat('l', [0.25, 0.05, 0.08], 0.1),
    m: mat('m', [0.55, 0.57, 0.62], 0.25), M: mat('M', [0.95, 0.96, 0.98], 1, 0.4), r: mat('r', [1, 0.1, 0.15], 1, 0.3),
  };
  const ell = (c, r, m) => addLocalEllipsoid(vertices, basis, c, r, m, segs, rings);
  const seg = (a, b, r1, r2, m, n = segs) => addLocalSegment(vertices, basis, a, b, r1, r2, m, n);

  // ---------------------------------------------------------------- legs
  const crouchDrop = P.crouch * 0.16;
  const pelvis = [0, 0, 0.045 + crouchDrop];
  const legPoints = (side, L) => {
    const lift = L.lift + P.crouch * 0.9;
    const knee = L.knee + P.crouch * 1.8;
    const hip = [0, side * 0.085, pelvis[2]];
    const kneeP = add(hip, [Math.sin(lift) * 0.21, side * Math.sin(L.spread) * 0.21, Math.cos(lift) * 0.21]);
    const a = lift - knee;
    const ankle = add(kneeP, [Math.sin(a) * 0.2, side * Math.sin(L.spread) * 0.1, Math.cos(a) * 0.2]);
    return { hip, knee: kneeP, ankle };
  };
  for (const [side, L] of [[-1, P.legL], [1, P.legR]]) {
    const { hip, knee, ankle } = legPoints(side, L);
    const thigh = P.boots === 'thigh' ? M.s : M.p;
    seg(hip, knee, 0.062, 0.047, thigh);
    if (P.boots === 'thigh') seg(add(hip, scale([knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]], 0.45)), knee, 0.052, 0.049, M.b);
    seg(knee, ankle, 0.049, 0.038, P.boots === 'thigh' ? M.b : M.p);
    seg(ankle, add(ankle, [0.075, 0, 0.012]), 0.04, 0.034, M.b, 6);
  }

  // ---------------------------------------------------------------- torso frame
  // The upper body pitches forward by lean and turns by turn about the pelvis.
  const cl = Math.cos(P.lean), sl = Math.sin(P.lean), ct = Math.cos(P.turn), st = Math.sin(P.turn);
  const T = (p) => {
    // p is in the torso frame (z down from the pelvis); turn, then lean.
    const x1 = p[0] * ct - p[1] * st;
    const y1 = p[0] * st + p[1] * ct;
    const z1 = p[2];
    return [pelvis[0] + x1 * cl - z1 * sl, pelvis[1] + y1, pelvis[2] + x1 * sl + z1 * cl];
  };
  const TD = (d) => { const o = T([0, 0, 0]); const q = T(d); return [q[0] - o[0], q[1] - o[1], q[2] - o[2]]; };
  const chest = T([0, 0, -0.2]);
  const neck = T([0, 0, -0.33]);
  const torsoM = P.top === 'bodysuit' ? M.k : M.j;
  ell(T([0, 0, -0.04]), [0.09, 0.125, 0.09], P.top === 'bodysuit' ? M.k : M.p);
  ell(T([0, 0, -0.17]), [0.095, 0.145, 0.16], torsoM);
  if (P.top === 'suit') {
    seg(T([0.085, 0, -0.29]), T([0.09, 0, -0.12]), 0.035, 0.012, M.w, 6);
    seg(T([0.098, 0, -0.27]), T([0.1, 0, -0.1]), 0.012, 0.016, M.t, 5);
  }
  if (P.top === 'bodysuit') ell(T([0.03, 0, -0.08]), [0.07, 0.07, 0.035], M.s); // the cut-out at the waist
  if (P.shoulderPads) for (const side of [-1, 1]) ell(T([0, side * 0.16, -0.29]), [0.07, 0.08, 0.035], M.k);
  seg(T([0, 0, -0.3]), neck, 0.045, 0.04, M.s, 6);
  if (P.choker) seg(T([0, 0, -0.335]), T([0, 0, -0.355]), 0.047, 0.047, M.k, 8);

  // ---------------------------------------------------------------- coat
  // An open long coat: strips round the back and sides, none across the front.
  if (P.coat > 0) {
    const hemZ = 0.05 + 0.4 * P.coat;
    const strips = full ? 11 : 7;
    for (let i = 0; i < strips; i += 1) {
      const a = (-0.78 + (1.56 * i) / (strips - 1)) * Math.PI; // around the back
      const r0 = 0.15;
      const top = T([Math.cos(a) * 0.09, Math.sin(a) * r0, -0.27]);
      const flare = 0.06 + P.coatFlare * 0.22 * (0.5 - Math.cos(a) * 0.5);
      const hem = add(T([Math.cos(a) * (0.09 + flare * 0.4) - P.coatFlare * 0.2, Math.sin(a) * (r0 + flare), 0]), [0, 0, hemZ - pelvis[2] + pelvis[2]]);
      hem[2] = Math.min(0.49, hemZ + pelvis[2] - 0.07);
      seg(top, hem, 0.035, 0.042, Math.abs(a) > 2.6 ? M.J : M.j, 5);
    }
    for (const side of [-1, 1]) seg(T([0.06, side * 0.05, -0.31]), T([0.1, side * 0.12, -0.18]), 0.025, 0.02, M.J, 5); // lapels
  }

  // ---------------------------------------------------------------- arms
  const handOf = {};
  for (const [side, A, key] of [[-1, P.armL, 'L'], [1, P.armR, 'R']]) {
    const shoulder = T([0, side * 0.165, -0.28]);
    // Upper arm: down, swung out by spread, then forward and up by raise.
    let d = [0, side * Math.sin(A.spread), Math.cos(A.spread)];
    d = [d[2] * -Math.sin(A.raise) + d[0] * Math.cos(A.raise), d[1], d[2] * Math.cos(A.raise) + d[0] * Math.sin(A.raise)];
    d = norm(TD(d));
    const elbow = add(shoulder, scale(d, 0.17));
    // The elbow bends the forearm toward the front of the body.
    let bendAxis = TD([1, 0, -0.35]);
    bendAxis = norm(add(bendAxis, scale(d, -dot(bendAxis, d))));
    if (!Number.isFinite(bendAxis[0]) || Math.hypot(...bendAxis) < 0.5) bendAxis = norm(TD([0, 0, -1]));
    const f = norm(add(scale(d, Math.cos(A.elbow)), scale(bendAxis, Math.sin(A.elbow))));
    const hand = add(elbow, scale(f, 0.16));
    const sleeve = P.top === 'bodysuit' ? M.s : M.j;
    seg(shoulder, elbow, 0.05, 0.042, P.gloves === 'opera' ? M.g : sleeve);
    if (P.gloves === 'opera') seg(shoulder, add(shoulder, scale(d, 0.07)), 0.051, 0.048, sleeve);
    seg(elbow, hand, 0.042, 0.032, P.gloves !== 'none' ? M.g : sleeve);
    ell(add(hand, scale(f, 0.035)), [0.034, 0.03, 0.034], P.gloves !== 'none' ? M.g : M.s);
    handOf[key] = { hand: add(hand, scale(f, 0.035)), elbow, f, bendAxis };
  }

  // ---------------------------------------------------------------- head
  const headC = T([0, 0, -0.43]);
  const hp = P.headPitch, ht = P.headTurn + P.turn;
  const H = (p) => {
    // A point on the head, turned and pitched about the head's centre.
    const x1 = p[0] * Math.cos(ht) - p[1] * Math.sin(ht);
    const y1 = p[0] * Math.sin(ht) + p[1] * Math.cos(ht);
    const x2 = x1 * Math.cos(hp + P.lean) - p[2] * Math.sin(hp + P.lean);
    const z2 = x1 * Math.sin(hp + P.lean) + p[2] * Math.cos(hp + P.lean);
    return [headC[0] + x2, headC[1] + y1, headC[2] + z2];
  };
  ell(headC, [0.082, 0.072, 0.1], P.devil ? M.k : M.s);
  if (P.devil) {
    for (let i = -3; i <= 3; i += 1) seg(H([0.075, i * 0.013, 0.01]), H([0.08, i * 0.013, 0.04]), 0.007, 0.001, M.M, 4);
    for (let i = -3; i <= 3; i += 1) seg(H([0.075, i * 0.013 + 0.006, 0.07]), H([0.08, i * 0.013 + 0.006, 0.042]), 0.007, 0.001, M.M, 4);
    for (const side of [-1, 1]) ell(H([0.072, side * 0.03, -0.03]), [0.012, 0.016, 0.011], M.r);
  } else {
    for (const side of [-1, 1]) {
      ell(H([0.074, side * 0.029, -0.012]), [0.01, 0.017, 0.009], M.e);
      seg(H([0.076, side * 0.012, -0.036]), H([0.072, side * 0.045, -0.04]), 0.005, 0.004, M.e, 4);
    }
    ell(H([0.088, 0, 0.012]), [0.012, 0.01, 0.018], M.s);
    ell(H([0.078, 0, 0.05]), [0.008, 0.024, 0.008], P.top === 'bodysuit' ? M.l : M.e);
    if (P.moustache) ell(H([0.083, 0, 0.033]), [0.008, 0.03, 0.008], M.h);
  }
  // Hair.
  if (P.hair !== 'none') {
    const cap = P.hair === 'slick' ? [0.08, 0.075, 0.07] : [0.088, 0.08, 0.078];
    ell(H([-0.012, 0, -0.04]), cap, M.h);
    if (P.hair === 'choppy' || P.hair === 'swept') {
      const n = full ? 9 : 5;
      for (let i = 0; i < n; i += 1) {
        const a = (i / (n - 1) - 0.5) * 2.6;
        const from = H([Math.cos(a) * 0.04, Math.sin(a) * 0.06, -0.085]);
        const to = H([Math.cos(a) * 0.065 + (P.hair === 'swept' ? 0.02 : 0), Math.sin(a) * 0.09, -0.13 - ((i * 7) % 3) * 0.012]);
        seg(from, to, 0.022, 0.004, M.h, 5);
      }
      for (const side of [-1, 1]) seg(H([-0.03, side * 0.07, -0.02]), H([-0.06, side * 0.065, 0.07]), 0.02, 0.006, M.h, 5); // nape strands
      if (P.hair === 'choppy') for (let i = -1; i <= 1; i += 1) seg(H([0.06, i * 0.03, -0.07]), H([0.085, i * 0.032, -0.03]), 0.012, 0.003, M.h, 4); // fringe
    }
    if (P.hair === 'long') for (let i = -2; i <= 2; i += 1) seg(H([-0.04, i * 0.03, -0.04]), add(H([-0.06, i * 0.035, 0.05]), [0, 0, 0.24]), 0.03, 0.012, M.h, 5);
  }
  if (P.earrings) for (const side of [-1, 1]) seg(H([0, side * 0.075, 0.01]), H([0, side * 0.077, 0.07]), 0.005, 0.005, M.m, 4);

  // ---------------------------------------------------------------- props
  for (const q of P.props) {
    let base;
    let dir;
    let side;
    if (q.at === 'head') {
      base = H([0.01, 0, -0.1]);
      dir = norm([H([0.02, 0, -1])[0] - headC[0], H([0.02, 0, -1])[1] - headC[1], H([0.02, 0, -1])[2] - headC[2]]);
      side = norm(TD([1, 0, 0]));
    } else {
      const k = q.at.endsWith('L') ? 'L' : 'R';
      const A = handOf[k];
      base = q.at.startsWith('forearm') ? add(A.hand, scale(A.f, -0.02)) : A.hand;
      dir = norm(add(scale(A.f, Math.cos(q.angle)), scale(A.bendAxis, Math.sin(q.angle))));
      side = A.bendAxis;
    }
    const tip = add(base, scale(dir, q.length));
    if (q.kind === 'sword') {
      seg(add(base, scale(dir, -0.06)), base, 0.014, 0.014, M.k, 5);
      seg(add(base, scale(side, 0.04)), add(base, scale(side, -0.04)), 0.008, 0.008, M.m, 4);
      seg(base, tip, 0.014, 0.003, M.M, 4);
    } else if (q.kind === 'pistol') {
      seg(base, add(base, scale(dir, 0.05)), 0.016, 0.016, M.k, 5);
      const out = norm(cross(dir, side));
      seg(add(base, scale(dir, 0.04)), add(add(base, scale(dir, 0.04)), scale(out, -q.length)), 0.013, 0.012, M.m, 5);
    } else {
      // Chainsaw: a motor at the base, a flat bar, a running chain of teeth.
      const flat = norm(cross(dir, side));
      ell(base, [0.045, 0.045, 0.045], M.m);
      seg(base, tip, 0.026, 0.022, M.m, 6);
      const n = Math.max(4, Math.round(q.length / 0.035));
      for (let i = 0; i < n; i += 1) {
        const u = ((i + q.spin * 2) % n) / n;
        const at = add(base, scale(dir, 0.05 + u * (q.length - 0.05)));
        for (const s of [-1, 1]) {
          const root = add(at, scale(side, s * 0.022));
          seg(root, add(add(root, scale(side, s * 0.03)), scale(dir, 0.012)), 0.01, 0.001, M.M, 3);
        }
      }
      seg(tip, add(tip, scale(dir, 0.025)), 0.022, 0.004, M.M, 5);
      void flat;
    }
  }

  return finishMesh(vertices, lod, { pose: 'default' });
}
