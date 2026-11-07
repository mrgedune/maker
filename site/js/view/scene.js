// Draws a world with my engine. A level's blocks become the engine's static
// grid (built once per level), and every frame the game's players,
// creatures, toys and machine parts become entities. The same view draws the
// Build screen's 3D look, the Characters screen's preview and Play.

import { AsciiEngine, createSceneSnapshot, createWorldMetrics } from '../../engine/src/index.js';
import { PART } from '../kit/catalog.js';
import { PLAYER } from '../kit/game.js';

const FIGURE_HEIGHT = 1.03; // the engine's figure, in cells, before scaling
export const PLAYER_SCALE = (PLAYER.half * 2 + PLAYER.radius * 2) / FIGURE_HEIGHT;

// Cell sizes in pixels at about 600 pixels tall; bigger screens scale them up.
export const DETAIL = { chunky: [8, 12], medium: [4, 6], fine: [2, 3] };
const MAX_CELLS = 320_000;

const mix = (a, b, t) => a + (b - a) * t;
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
export const shade = (hex, k) => rgbToHex(hexToRgb(hex).map((v) => v * k));
const mixHex = (a, b, t) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => mix(v, y[i], t)));
};
const tint01 = (hex) => hexToRgb(hex).map((v) => v / 255);

// A quaternion turning by deg about the vertical.
function yawQ(deg) {
  const h = (deg * Math.PI) / 360;
  return { qx: 0, qy: 0, qz: Math.sin(h), qw: Math.cos(h) };
}
// Quaternion product a * b.
function qmul(a, b) {
  return {
    qx: a.qw * b.qx + a.qx * b.qw + a.qy * b.qz - a.qz * b.qy,
    qy: a.qw * b.qy - a.qx * b.qz + a.qy * b.qw + a.qz * b.qx,
    qz: a.qw * b.qz + a.qx * b.qy - a.qy * b.qx + a.qz * b.qw,
    qw: a.qw * b.qw - a.qx * b.qx - a.qy * b.qy - a.qz * b.qz,
  };
}
function axisQ(x, y, z, angle) {
  const s = Math.sin(angle / 2);
  return { qx: x * s, qy: y * s, qz: z * s, qw: Math.cos(angle / 2) };
}

export function figurePalette(look) {
  const c = look.colors;
  const e = 0.16;
  return {
    j: { color: c.outfit, emission: e },
    J: { color: shade(c.outfit, 0.55), emission: e },
    k: { color: look.top === 'bodysuit' ? c.outfit : shade(c.outfit, 0.45), emission: e },
    p: { color: c.trousers, emission: e },
    s: { color: c.skin, emission: 0.2 },
    h: { color: c.hair, emission: e },
    b: { color: c.boots, emission: e },
    g: { color: c.gloves, emission: e },
  };
}

// How a figure stands this frame. `a` holds 0..1 channels the caller fills
// from the game: move, phase (walk cycle), tell, strike, block, stagger,
// down, slam, swing (a player's own swing), dead.
export function figureParams(look, a = {}) {
  const move = a.move ?? 0;
  const phase = a.phase ?? 0;
  const swing = Math.sin(phase) * 0.75 * move;
  const p = {
    hair: look.hair,
    top: look.top,
    coat: look.coat,
    coatFlare: move * 0.4,
    gloves: look.gloves,
    boots: look.boots,
    devil: look.devil,
    legL: { lift: swing, knee: Math.max(0, -swing) * 1.1 + 0.05 },
    legR: { lift: -swing, knee: Math.max(0, swing) * 1.1 + 0.05 },
    armL: { raise: -swing * 0.7, spread: 0.12, elbow: 0.25 + move * 0.3 },
    armR: { raise: swing * 0.7, spread: 0.12, elbow: 0.25 + move * 0.3 },
    lean: 0.08 * move,
    props: look.held && look.held !== 'none' ? [{ at: 'handR', kind: look.held }] : [],
  };
  if (a.tell > 0) {
    const t = a.tell;
    if (a.move_ === 'slam') {
      p.armL = { raise: 3 * t, spread: 0.3, elbow: 0.5 };
      p.armR = { raise: 3 * t, spread: 0.3, elbow: 0.5 };
      p.lean = -0.25 * t;
      p.crouch = 0.15 * t;
    } else if (a.move_ === 'throw') {
      p.armR = { raise: 2.7 * t, spread: 0.5, elbow: 1.6 * t };
      p.turn = -0.6 * t;
    } else if (a.move_ === 'charge') {
      p.crouch = 0.45 * t;
      p.lean = 0.6 * t;
      p.armL = { raise: 0.6, spread: 0.5, elbow: 1.2 };
      p.armR = { raise: 0.6, spread: 0.5, elbow: 1.2 };
    } else {
      p.armR = { raise: 2.7 * t, spread: 0.35, elbow: 1.3 * t };
      p.lean = -0.18 * t;
      p.turn = -0.5 * t;
    }
  }
  if (a.strike > 0) {
    if (a.move_ === 'slam') {
      p.armL = { raise: 0.9, spread: 0.2, elbow: 0.1 };
      p.armR = { raise: 0.9, spread: 0.2, elbow: 0.1 };
      p.lean = 0.7;
      p.crouch = 0.5;
    } else if (a.move_ === 'charge') {
      p.lean = 0.5;
      p.armL = { raise: 1.4, spread: 0, elbow: 0.2 };
      p.armR = { raise: 1.4, spread: 0, elbow: 0.2 };
    } else {
      p.armR = { raise: 1.45, spread: -0.1, elbow: 0.05 };
      p.lean = 0.35;
      p.turn = 0.5;
    }
  }
  if (a.swing > 0) {
    const s = a.swing;
    p.armR = { raise: 2.4 - 1.2 * s, spread: 0.2 - 0.3 * s, elbow: 0.9 - 0.8 * s };
    p.turn = -0.4 + 0.9 * s;
    p.lean = 0.2 * s;
  }
  if (a.block) {
    p.armL = { raise: 1.3, spread: -0.3, elbow: 1.7 };
    p.armR = { raise: 1.4, spread: -0.2, elbow: 1.5 };
    p.lean = -0.05;
  }
  if (a.stagger > 0) {
    p.lean = -0.45 * a.stagger;
    p.armL = { raise: 0.4, spread: 1.0, elbow: 0.6 };
    p.armR = { raise: 0.4, spread: 1.0, elbow: 0.6 };
    p.headPitch = -0.4 * a.stagger;
  }
  if (a.down || a.dead) {
    p.crouch = 1;
    p.lean = 1.3;
    p.armL = { raise: 1.2, spread: 0.6, elbow: 0.4 };
    p.armR = { raise: 1.2, spread: 0.6, elbow: 0.4 };
    p.headPitch = 0.6;
  }
  return p;
}

// Static grid of one level: one cell per column, with its spans.
export function levelCells(level) {
  const [w, h] = level.size;
  const cols = new Map();
  for (const [x, y, m, b, t] of level.blocks) {
    const key = y * w + x;
    if (!cols.has(key)) cols.set(key, { m, spans: [] });
    cols.get(key).spans.push([b, t]);
  }
  const cells = [];
  let top = 0;
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const c = cols.get(y * w + x);
      if (!c) {
        row.push(0);
        continue;
      }
      const spans = c.spans.sort((a, b) => a[0] - b[0]);
      for (const [, t] of spans) top = Math.max(top, t);
      if (spans.length === 1 && spans[0][0] === 0) row.push({ material: `w:${c.m}`, height: spans[0][1] });
      else row.push({ material: `w:${c.m}`, spans });
    }
    cells.push(row);
  }
  return { cells, top };
}

export function atmosphereFor(level) {
  const light = level.light / 10;
  const day = Math.max(0, Math.min(1, (light - 0.3) / 0.7));
  return {
    ambient: 0.12 + light * 0.75,
    exposure: 0.9 + light * 0.2,
    fogColor: mixHex('#06070b', '#9fb0c4', day * 0.6),
    fogDensity: 0.012 + (1 - light) * 0.02,
    fogDistance: 'planar',
    skyTop: mixHex('#04060c', '#3f6fb0', day),
    skyHorizon: mixHex('#141a2a', '#c8d4e2', day),
    skyGlow: { color: mixHex('#ff9a5a', '#fff2d8', day), azimuth: 0.7, strength: 0.5 + day * 0.6, sharpness: 3 },
    emissiveIntensity: 1,
  };
}

export function createView(canvas, { detail = 'medium', pipeline = 'balanced' } = {}) {
  const engine = new AsciiEngine({
    canvas,
    gridWidth: 160,
    gridHeight: 90,
    glyphPipeline: pipeline,
    staticAtlasSlots: 48,
    contextAttributes: { antialias: false },
  });
  let worldDoc = null;
  let current = null; // { level, grid, metrics, atmosphere }
  let size = [canvas.clientWidth || 960, canvas.clientHeight || 540];
  const registered = new Set();

  function fit(cssW = size[0], cssH = size[1]) {
    size = [cssW, cssH];
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const W = Math.max(64, Math.round(cssW * dpr));
    const H = Math.max(48, Math.round(cssH * dpr));
    const [cw0, ch0] = DETAIL[detail] ?? DETAIL.medium;
    const boost = Math.max(1, Math.sqrt(H / 600));
    const cw = Math.max(cw0, Math.round(cw0 * boost));
    const ch = Math.max(ch0, Math.round(ch0 * boost));
    let gw = Math.floor(W / cw);
    let gh = Math.floor(H / ch);
    if (gw * gh > MAX_CELLS) {
      const k = Math.sqrt(MAX_CELLS / (gw * gh));
      gw = Math.floor(gw * k);
      gh = Math.floor(gh * k);
    }
    engine.resize({ gridWidth: Math.max(16, gw), gridHeight: Math.max(9, gh), cellWidth: cw, cellHeight: ch });
  }

  function setDetail(d) {
    if (DETAIL[d]) detail = d;
    fit();
  }

  // Materials, figures and shapes for a world. Again whenever its look
  // changes (a new material colour, a character's outfit).
  function setWorld(doc) {
    worldDoc = doc;
    for (const m of doc.materials) {
      engine.registerMaterial(`w:${m.id}`, {
        color: m.color,
        glyph: m.glyph,
        roughness: 0.7,
        lightResponse: m.glow ? 0.2 : 0.85,
        emission: m.glow ? 0.9 : 0.02,
        texture: m.glow ? undefined : { style: 'noise', amount: 0.32, seed: m.id.length * 7 + m.id.charCodeAt(0) },
      });
    }
    if (!registered.has('base')) {
      engine.registerMaterial('maker.ceiling', { color: '#20242c', glyph: '█', roughness: 0.9, lightResponse: 0.7 });
      engine.registerMaterial('maker.edge', { color: '#3a3f47', glyph: '▒', roughness: 0.9, lightResponse: 0.7 });
      engine.registerMeshArchetype('toy', { archetype: 'shape' });
      engine.registerMeshArchetype('glow', {
        archetype: 'shape',
        palette: { '█': { color: '#ffffff', emission: 1 }, '#': { color: '#ffffff', emission: 1 } },
      });
      engine.registerMeshArchetype('ghost', {
        archetype: 'shape',
        palette: { '█': { color: '#ffffff', emission: 0.6, lightResponse: 0.2 }, '#': { color: '#ffffff', emission: 0.9 } },
      });
      registered.add('base');
    }
    for (const c of doc.characters) engine.registerMeshArchetype(`fig:${c.id}`, { archetype: 'figure', palette: figurePalette(c.look) });
    if (current) setLevel(current.level);
  }

  function setLevel(level) {
    const { cells, top } = levelCells(level);
    const ceiling = level.sky ? Math.max(6, top + 2) : Math.max(3, top);
    const metrics = createWorldMetrics({ cellSize: 1, floorHeight: 0, ceilingHeight: ceiling });
    const floorMat = `w:${level.floor ?? worldDoc.materials[0].id}`;
    const { grid } = createSceneSnapshot({ grid: { cells }, metrics });
    // A sun: one light high over the level that shades walls by the way they
    // face, so a lit room is not one flat colour.
    const [w, h] = level.size;
    const light = level.light / 10;
    const sun = { id: 'sun', x: w * 0.3, y: h * 0.2, z: level.sky ? 40 : ceiling - 0.2, color: level.sky ? '#fff4e0' : '#ffe6c8', range: Math.hypot(w, h) * 1.6 + 40, intensity: 0.25 + light * 0.55, active: light > 0.05, volumetricInfluence: 0 };
    current = { level, grid, metrics, floorMat, sun, atmosphere: atmosphereFor(level) };
  }

  // Swap one level's blocks for an edited copy (the Build screen) without
  // throwing away the rest.
  const refreshLevel = (level) => setLevel(level);

  function render({ camera, entities = [], lights = [], time = 0, flash = null, drawDistance = 48, atmosphere = null }) {
    if (!current) return;
    const scene = createSceneSnapshot({
      grid: current.grid,
      metrics: current.metrics,
      entities,
      lights: current.sun.active ? [current.sun, ...lights] : lights,
      atmosphere: atmosphere ?? current.atmosphere,
      features: { sky: current.level.sky },
      materials: { floorMaterial: current.floorMat, ceilingMaterial: 'maker.ceiling', corrodedMaterial: current.floorMat },
    });
    const effects = { bloom: 0.25 };
    if (flash && flash.opacity > 0) {
      const [r, g, b] = flash.color ?? [1, 1, 1];
      effects.screenFlash = { opacity: flash.opacity, middleStop: 0.55, inner: [r, g, b, 0.25], middle: [r, g, b, 0.15], outer: [r, g, b, 0.6] };
    }
    engine.render({ scene, camera: { fov: Math.PI / 2.6, ...camera }, display: { drawDistance, roundedCorners: false }, effects, time });
  }

  fit();
  return {
    engine,
    canvas,
    fit,
    setDetail,
    setWorld,
    setLevel,
    refreshLevel,
    render,
    get level() {
      return current?.level ?? null;
    },
    dispose() {
      try {
        engine.dispose();
      } catch {
        // already gone
      }
    },
  };
}

// ---------------------------------------------------------------- entities

const SHAPE_OF = (type) => {
  const s = PART[type]?.shape;
  return s === 'ball' || s === 'cylinder' ? s : 'box';
};

function shapeEntity(id, mesh, x, y, z, size, q, color, extra = {}) {
  return {
    id,
    mesh,
    x,
    y,
    z,
    heading: 0,
    tint: tint01(color),
    params: { kind: extra.kind ?? 'box', sx: size[0], sy: size[1], sz: size[2], qx: q.qx, qy: q.qy, qz: q.qz, qw: q.qw, trim: extra.trim ?? true },
    opacity: extra.opacity ?? 1,
  };
}

// Parts as they stand in the editor (no game running): everything at its
// placed spot, with the invisible machine parts drawn as small markers.
export function editEntities(doc, level, { time = 0, selected = null, showMachines = true } = {}) {
  const out = [];
  const lights = [];
  const chars = new Map(doc.characters.map((c) => [c.id, c]));
  const player = doc.characters.find((c) => c.role === 'player');
  for (const part of level.parts) {
    const def = PART[part.type];
    const [sx, sy, sz] = part.size;
    const q = yawQ(part.turn);
    const sel = part.id === selected;
    const color = sel ? mixHex(part.color, '#ffffff', 0.45 + 0.25 * Math.sin(time * 6)) : part.color;
    if (part.type === 'start') {
      if (player) out.push(figureEntity(`e:${part.id}`, player, part.x, part.y, part.z, (part.turn * Math.PI) / 180, PLAYER_SCALE, {}, 0.65));
      out.push(shapeEntity(`e:${part.id}:pad`, 'glow', part.x, part.y, part.z + 0.03, [sx, sy, 0.06], q, color, { trim: false }));
      continue;
    }
    if (part.type === 'creature') {
      const ch = chars.get(part.props.character) ?? doc.characters.find((c) => c.role !== 'player');
      if (ch) out.push(figureEntity(`e:${part.id}`, ch, part.x, part.y, part.z, (part.turn * Math.PI) / 180, PLAYER_SCALE * sizeScale(ch), {}, 1));
      if (sel) out.push(shapeEntity(`e:${part.id}:sel`, 'glow', part.x, part.y, part.z + 0.02, [1, 1, 0.04], q, color, { trim: false }));
      continue;
    }
    if (part.type === 'seesaw') {
      out.push(shapeEntity(`e:${part.id}:pivot`, 'toy', part.x, part.y, part.z + 0.225, [0.24, sy, 0.45], q, shade(part.color, 0.6)));
      out.push(shapeEntity(`e:${part.id}`, 'toy', part.x, part.y, part.z + 0.45 + sz / 2, [sx, sy, sz], q, color));
      continue;
    }
    if (part.type === 'zone' || part.type === 'launcher' || part.type === 'spawner') {
      if (!showMachines && part.type === 'zone') continue;
      out.push(shapeEntity(`e:${part.id}`, 'ghost', part.x, part.y, part.z + 0.03, [sx, sy, 0.06], q, color, { trim: true, opacity: 0.8 }));
      if (part.type === 'spawner') {
        const ch = chars.get(part.props.character) ?? doc.characters.find((c) => c.role !== 'player');
        if (ch) out.push(figureEntity(`e:${part.id}:fig`, ch, part.x, part.y, part.z, (part.turn * Math.PI) / 180, PLAYER_SCALE * sizeScale(ch), {}, 0.35));
      }
      if (part.type === 'zone') out.push(shapeEntity(`e:${part.id}:top`, 'ghost', part.x, part.y, part.z + sz, [sx, sy, 0.04], q, color, { trim: true, opacity: 0.5 }));
      continue;
    }
    if (def.shape === 'none') {
      if (!showMachines) continue;
      out.push(shapeEntity(`e:${part.id}`, 'glow', part.x, part.y, part.z + 0.25 + 0.05 * Math.sin(time * 2 + part.x), [0.3, 0.3, 0.3], yawQ(time * 40), color, { trim: true }));
      continue;
    }
    if (part.type === 'lamp') {
      out.push(shapeEntity(`e:${part.id}`, 'glow', part.x, part.y, part.z + sz / 2, [sx, sy, sz], q, color, { kind: 'ball', trim: false }));
      lights.push(lampLight(part, true));
      continue;
    }
    const glow = part.type === 'exit' || part.type === 'gem' || part.type === 'key' || part.type === 'button';
    out.push(shapeEntity(`e:${part.id}`, glow ? 'glow' : 'toy', part.x, part.y, part.z + sz / 2, [sx, sy, sz], q, color, { kind: SHAPE_OF(part.type) }));
  }
  return { entities: out, lights };
}

export function lampLight(part, on) {
  return {
    id: `lamp:${part.id}`,
    x: part.x,
    y: part.y,
    z: part.z + part.size[2] / 2,
    color: part.color,
    range: 2.5 + part.props.reach * 1.5,
    intensity: on ? 0.35 + part.props.brightness * 0.14 : 0,
    active: on,
    volumetricInfluence: 0.15,
  };
}

export const sizeScale = (ch) => (0.55 + ch.size * 0.17) / 1.4;

export function figureEntity(id, ch, x, y, z, heading, scale, anim = {}, opacity = 1) {
  return {
    id,
    mesh: `fig:${ch.id}`,
    x,
    y,
    z,
    heading,
    scale: Math.max(0.05, Math.min(8, scale)),
    params: figureParams(ch.look, anim),
    opacity,
  };
}

// Everything the game has this frame. `me` is the slot whose eyes the camera
// is (skipped, so the camera is not inside a body); null draws every player.
export function playEntities(game, { me = null, time = 0, prev = null, alpha = 1 } = {}) {
  const s = game.state;
  const doc = game.doc;
  const level = game.level;
  const out = [];
  const lights = [];
  const chars = game.characters;
  const player = doc.characters.find((c) => c.role === 'player');
  const lerp = (a, b) => (prev ? a + (b - a) * alpha : b);
  for (const p of s.players) {
    if (p.out || p.waiting || p.slot === me || !player) continue;
    const q = prev?.players?.[p.slot];
    const x = q ? lerp(q.x, p.x) : p.x;
    const y = q ? lerp(q.y, p.y) : p.y;
    const z = q ? lerp(q.z, p.z) : p.z;
    const swing = p.attackT >= 0 ? Math.min(1, p.attackT / 6) : 0;
    out.push(
      figureEntity(`pl:${p.slot}`, player, x, y, z, p.yaw, PLAYER_SCALE, {
        move: p.moving,
        phase: time * 9 + p.slot,
        swing,
        block: p.blocking || p.parryT > 0,
        down: p.down,
      }, p.invuln > 0 && !p.down && Math.floor(time * 12) % 2 ? 0.55 : 1),
    );
  }
  for (const c of s.creatures) {
    const ch = chars.get(c.char);
    if (!ch || c.body < 0) continue;
    const q = prev?.creatures?.[c.id];
    const x = q ? lerp(q.x, c.x) : c.x;
    const y = q ? lerp(q.y, c.y) : c.y;
    const z = q ? lerp(q.z, c.z) : c.z;
    const anim = { move: c.moving ? 1 : 0, phase: time * 8 + c.n, move_: c.move };
    if (c.state === 'tell') anim.tell = 1 - Math.max(0, c.t) / Math.max(1, c.tellMax ?? 30);
    if (c.state === 'tell') anim.tell = Math.max(0.35, anim.tell);
    if (c.state === 'strike') anim.strike = 1;
    if (c.state === 'stagger') anim.stagger = 1;
    if (c.state === 'dead') anim.dead = true;
    const hurt = time * 60 - c.hitT;
    const fade = c.state === 'dead' ? Math.max(0, 1 - Math.max(0, c.t - 30) / 60) : 1;
    const e = figureEntity(`cr:${c.id}`, ch, x, y, z, c.yaw, PLAYER_SCALE * c.scale, anim, fade);
    if (s.tick - c.hitT < 6) e.tint = [1.6, 1.6, 1.6];
    void hurt;
    out.push(e);
  }
  for (const part of level.parts) {
    const rt = s.parts[part.id];
    const def = PART[part.type];
    if (!rt) continue;
    const [sx, sy, sz] = part.size;
    const turn = yawQ(part.turn);
    if (def.kind === 'toy' || part.type === 'seesaw' || part.type === 'door') {
      if (rt.gone) continue;
      const pose = game.pose(rt.body);
      if (!pose) continue;
      const kind = part.type === 'seesaw' || part.type === 'door' ? 'box' : SHAPE_OF(part.type);
      let color = part.color;
      if (part.type === 'barrel' && rt.fuse !== undefined) color = Math.floor(time * 20) % 2 ? '#ffffff' : '#ffcc33';
      if (part.type === 'door' && part.props.locked && !rt.unlocked) color = mixHex(part.color, '#ffcc33', 0.35);
      out.push(shapeEntity(`pt:${part.id}`, 'toy', pose.x, pose.y, pose.z, [sx, sy, sz], pose, color, { kind }));
      if (part.type === 'seesaw') out.push(shapeEntity(`pt:${part.id}:pivot`, 'toy', part.x, part.y, part.z + 0.225, [0.24, sy, 0.45], turn, shade(part.color, 0.6)));
      continue;
    }
    switch (part.type) {
      case 'spring': {
        const squash = s.tick - rt.fired < 8 ? 0.4 : 1;
        out.push(shapeEntity(`pt:${part.id}`, 'toy', part.x, part.y, part.z + (sz * squash) / 2, [sx, sy, sz * squash], turn, part.color));
        break;
      }
      case 'breakable':
        if (!rt.gone) out.push(shapeEntity(`pt:${part.id}`, 'toy', part.x, part.y, part.z + sz / 2, [sx, sy, sz], turn, part.color));
        break;
      case 'target': {
        const lit = s.tick - rt.hitT < 30;
        out.push(shapeEntity(`pt:${part.id}`, lit ? 'glow' : 'toy', part.x, part.y, part.z + sz / 2, [sx, sy, sz], turn, lit ? '#ffffff' : part.color));
        break;
      }
      case 'key':
      case 'gem':
      case 'health':
        if (!rt.taken) {
          const bob = 0.08 * Math.sin(time * 3 + part.x);
          const spin = yawQ(part.turn + time * 90);
          out.push(shapeEntity(`pt:${part.id}`, part.type === 'health' ? 'toy' : 'glow', part.x, part.y, part.z + sz / 2 + 0.25 + bob, [sx, sy, sz], spin, part.color, { kind: SHAPE_OF(part.type) }));
        }
        break;
      case 'exit':
        out.push(shapeEntity(`pt:${part.id}`, 'glow', part.x, part.y, part.z + sz / 2, [sx, sy, sz], turn, part.color, { trim: false }));
        lights.push({ id: `exit:${part.id}`, x: part.x, y: part.y, z: part.z + 0.6, color: part.color, range: 3, intensity: 0.5, active: true, volumetricInfluence: 0 });
        break;
      case 'button': {
        const down = rt.until > s.tick;
        out.push(shapeEntity(`pt:${part.id}`, 'glow', part.x, part.y, part.z + (down ? sz * 0.3 : sz / 2), [sx, sy, down ? sz * 0.6 : sz], turn, down ? '#ffffff' : part.color));
        break;
      }
      case 'lever': {
        const tilt = qmul(turn, axisQ(0, 1, 0, rt.on ? 0.6 : -0.6));
        out.push(shapeEntity(`pt:${part.id}:base`, 'toy', part.x, part.y, part.z + 0.06, [0.4, 0.3, 0.12], turn, shade(part.color, 0.5)));
        out.push(shapeEntity(`pt:${part.id}`, 'glow', part.x, part.y, part.z + sz / 2, [0.08, 0.08, sz], tilt, rt.on ? '#4cc38a' : part.color, { trim: false }));
        break;
      }
      case 'plate': {
        const on = Boolean(rt.pressed);
        out.push(shapeEntity(`pt:${part.id}`, on ? 'glow' : 'toy', part.x, part.y, part.z + (on ? sz * 0.25 : sz / 2), [sx, sy, on ? sz * 0.5 : sz], turn, on ? '#4cc38a' : part.color));
        break;
      }
      case 'lamp':
        out.push(shapeEntity(`pt:${part.id}`, rt.on ? 'glow' : 'toy', part.x, part.y, part.z + sz / 2, [sx, sy, sz], turn, rt.on ? part.color : shade(part.color, 0.3), { kind: 'ball', trim: false }));
        lights.push(lampLight(part, rt.on));
        break;
      default:
        break;
    }
  }
  for (const pr of s.projectiles) {
    out.push(shapeEntity(`pr:${pr.id}`, 'glow', pr.x, pr.y, pr.z, [0.28, 0.28, 0.28], { qx: 0, qy: 0, qz: 0, qw: 1 }, '#ff4d4f', { kind: 'ball', trim: false }));
  }
  return { entities: out, lights };
}
