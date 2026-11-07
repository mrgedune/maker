// A world as a file: plain JSON, readable, kept in the browser and saved to
// disk. Every machine in a co-op room builds its game from the same file, so
// normalize() is strict: anything it does not understand is dropped or
// clamped, never guessed differently on another machine.
//
// {
//   format: 'rabbit-house-maker', version: 1,
//   name, screens: { title, subtitle, win, lose },
//   coop: { players, dropIn, revive, tougher, friendlyFire },
//   materials: [{ id, name, glyph, color, glow }],
//   characters: [{ id, name, role, look, size, fight }],
//   levels: [{ id, name, size: [w, h], sky, light, floor, blocks, parts, wires }]
// }
//
// blocks: [[x, y, material, bottom, top], ...]; one material per column, any
//         number of spans in it.
// parts:  [{ id, type, x, y, z, turn, size: [sx, sy, sz], color, props }];
//         x, y are the centre, z the underside, turn in degrees.
// wires:  [{ from, to }] by part id.

import { DEFAULT_MATERIALS, LIMITS, PART, defaultProps } from './catalog.js';
import { DEFAULT_PACK } from './fight.js';

export const FORMAT = 'rabbit-house-maker';
export const VERSION = 1;

const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const round = (v, step) => Math.round(v / step) * step;
const str = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const color = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v);

export const HAIR = ['short', 'choppy', 'slick', 'swept', 'long', 'none'];
export const TOPS = ['jacket', 'suit', 'bodysuit'];
export const HELD = ['none', 'sword', 'pistol', 'chainsaw'];
export const GLOVES = ['none', 'short', 'opera'];
export const BOOTS = ['shoe', 'thigh'];
export const PRESETS = ['brawler', 'duel', 'ambusher', 'boss'];
export const MOVES = ['swing', 'slam', 'throw', 'charge'];

export function defaultLook(role = 'creature') {
  return role === 'player'
    ? { hair: 'short', top: 'jacket', coat: 0, gloves: 'short', boots: 'shoe', held: 'sword', devil: false,
        colors: { outfit: '#3d6fa8', trousers: '#2b2f38', skin: '#d9a77c', hair: '#3a2a1e', boots: '#1e2128', gloves: '#2b2f38' } }
    : { hair: 'none', top: 'bodysuit', coat: 0, gloves: 'short', boots: 'shoe', held: 'none', devil: true,
        colors: { outfit: '#5b2a2a', trousers: '#2b1d1d', skin: '#7a5a50', hair: '#1a1a1a', boots: '#1a1414', gloves: '#3a2020' } };
}

export function defaultFight(preset = 'brawler') {
  const moves = { swing: true, slam: preset === 'boss', throw: preset === 'boss', charge: preset === 'boss' || preset === 'ambusher' };
  return { preset, health: 5, tell: 5, parry: 5, speed: 5, damage: 5, moves, tougher: true, pack: DEFAULT_PACK };
}

export function newCharacter(id, name, role = 'creature', preset = 'brawler') {
  return { id, name, role, look: defaultLook(role), size: role === 'player' ? 5 : preset === 'boss' ? 8 : 5, fight: defaultFight(preset) };
}

export function newLevel(id, name = 'Level 1', w = 24, h = 24) {
  return { id, name, size: [w, h], sky: true, light: 6, floor: 'stone', blocks: [], parts: [], wires: [] };
}

export function newWorld(name = 'My world') {
  return {
    format: FORMAT,
    version: VERSION,
    name,
    screens: { title: name, subtitle: 'Press Start', win: 'You win', lose: 'Game over' },
    coop: { players: 4, dropIn: true, revive: true, tougher: true, friendlyFire: false },
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    characters: [newCharacter('player', 'Player look', 'player'), newCharacter('grunt', 'Grunt', 'creature', 'brawler')],
    levels: [newLevel('l1', 'Level 1')],
  };
}

function normalizeLook(look, role) {
  const d = defaultLook(role);
  const l = look && typeof look === 'object' ? look : {};
  const c = l.colors && typeof l.colors === 'object' ? l.colors : {};
  return {
    hair: HAIR.includes(l.hair) ? l.hair : d.hair,
    top: TOPS.includes(l.top) ? l.top : d.top,
    coat: clamp(l.coat, 0, 1, 0),
    gloves: GLOVES.includes(l.gloves) ? l.gloves : d.gloves,
    boots: BOOTS.includes(l.boots) ? l.boots : d.boots,
    held: HELD.includes(l.held) ? l.held : d.held,
    devil: typeof l.devil === 'boolean' ? l.devil : d.devil,
    colors: Object.fromEntries(Object.entries(d.colors).map(([k, v]) => [k, color(c[k], v)])),
  };
}

function normalizeFight(f) {
  const d = defaultFight(PRESETS.includes(f?.preset) ? f.preset : 'brawler');
  const x = f && typeof f === 'object' ? f : {};
  const moves = {};
  for (const m of MOVES) moves[m] = typeof x.moves?.[m] === 'boolean' ? x.moves[m] : d.moves[m];
  if (!MOVES.some((m) => moves[m])) moves.swing = true;
  return {
    preset: d.preset,
    health: clamp(Math.round(x.health), 0, 10, d.health),
    tell: clamp(Math.round(x.tell), 0, 10, d.tell),
    parry: clamp(Math.round(x.parry), 0, 10, d.parry),
    speed: clamp(Math.round(x.speed), 0, 10, d.speed),
    damage: clamp(Math.round(x.damage), 0, 10, d.damage),
    moves,
    tougher: typeof x.tougher === 'boolean' ? x.tougher : d.tougher,
    pack: x.pack === 'rabbit-house' || x.pack === 'plain' ? x.pack : DEFAULT_PACK,
  };
}

function normalizeProps(type, props) {
  const def = PART[type];
  const out = defaultProps(type);
  const p = props && typeof props === 'object' ? props : {};
  for (const spec of def.props) {
    const v = p[spec.key];
    if (spec.type === 'check') out[spec.key] = typeof v === 'boolean' ? v : spec.value;
    else if (spec.type === 'range' || spec.type === 'number')
      out[spec.key] = clamp(spec.step && spec.step < 1 ? round(v, spec.step) : Math.round(v), spec.min, spec.max, spec.value);
    else if (spec.type === 'text') out[spec.key] = str(v, spec.max ?? 80, spec.value);
    else if (spec.type === 'select') out[spec.key] = typeof v === 'string' ? v.slice(0, 24) : spec.value;
  }
  return out;
}

function normalizeLevel(level, index, materialIds) {
  const l = level && typeof level === 'object' ? level : {};
  const w = clamp(Math.round(l.size?.[0]), 4, LIMITS.size, 24);
  const h = clamp(Math.round(l.size?.[1]), 4, LIMITS.size, 24);
  const blocks = [];
  const seen = new Map(); // column -> material
  for (const b of Array.isArray(l.blocks) ? l.blocks : []) {
    if (!Array.isArray(b) || b.length < 5) continue;
    const [x, y, m] = b;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) continue;
    if (!materialIds.has(m)) continue;
    const bottom = clamp(round(b[3], 0.25), 0, LIMITS.height, 0);
    const top = clamp(round(b[4], 0.25), 0, LIMITS.height, 1);
    if (top <= bottom) continue;
    const key = y * w + x;
    if (seen.has(key) && seen.get(key) !== m) continue; // one material per column
    seen.set(key, m);
    blocks.push([x, y, m, bottom, top]);
  }
  const ids = new Set();
  const parts = [];
  for (const p of Array.isArray(l.parts) ? l.parts : []) {
    if (!p || !PART[p.type] || !idOk(p.id) || ids.has(p.id)) continue;
    if (parts.length >= LIMITS.parts) break;
    const def = PART[p.type];
    ids.add(p.id);
    parts.push({
      id: p.id,
      type: p.type,
      x: clamp(round(p.x, 0.125), 0, w, w / 2),
      y: clamp(round(p.y, 0.125), 0, h, h / 2),
      z: clamp(round(p.z, 0.125), 0, LIMITS.height, 0),
      turn: ((Math.round(clamp(p.turn, -720, 720, 0) / 15) * 15) % 360 + 360) % 360,
      size: [0, 1, 2].map((k) => clamp(round(p.size?.[k], 0.05), 0.1, 16, def.size[k])),
      color: color(p.color, def.color),
      props: normalizeProps(p.type, p.props),
    });
  }
  const wires = [];
  const wireKeys = new Set();
  for (const wire of Array.isArray(l.wires) ? l.wires : []) {
    if (!wire || !ids.has(wire.from) || !ids.has(wire.to) || wire.from === wire.to) continue;
    const from = parts.find((p) => p.id === wire.from);
    const to = parts.find((p) => p.id === wire.to);
    if (!(PART[from.type].out || from.type === 'creature') || !PART[to.type].in) continue;
    const key = `${wire.from}>${wire.to}`;
    if (wireKeys.has(key) || wires.length >= LIMITS.wires) continue;
    wireKeys.add(key);
    wires.push({ from: wire.from, to: wire.to });
  }
  return {
    id: idOk(l.id) ? l.id : `l${index + 1}`,
    name: str(l.name, 40, `Level ${index + 1}`) || `Level ${index + 1}`,
    size: [w, h],
    sky: typeof l.sky === 'boolean' ? l.sky : true,
    light: clamp(Math.round(l.light), 0, 10, 6),
    floor: materialIds.has(l.floor) ? l.floor : [...materialIds][0],
    blocks,
    parts,
    wires,
  };
}

// The one shape every machine agrees on. Throws only for something that is
// not a maker world at all.
export function normalize(input) {
  if (!input || typeof input !== 'object' || input.format !== FORMAT)
    throw new Error('This file is not a maker world.');
  if (input.version > VERSION) throw new Error('This world was made by a newer maker. Reload to update.');
  const w = input;
  const materials = [];
  for (const m of Array.isArray(w.materials) ? w.materials : []) {
    if (!m || !idOk(m.id) || materials.some((x) => x.id === m.id) || materials.length >= LIMITS.materials) continue;
    materials.push({ id: m.id, name: str(m.name, 24, m.id) || m.id, glyph: str(m.glyph, 1, '█') || '█', color: color(m.color, '#8a8f98'), glow: m.glow === true });
  }
  if (!materials.length) materials.push(...DEFAULT_MATERIALS.map((m) => ({ ...m })));
  const materialIds = new Set(materials.map((m) => m.id));
  const characters = [];
  for (const c of Array.isArray(w.characters) ? w.characters : []) {
    if (!c || !idOk(c.id) || characters.some((x) => x.id === c.id) || characters.length >= LIMITS.characters) continue;
    const role = c.role === 'player' ? 'player' : 'creature';
    characters.push({ id: c.id, name: str(c.name, 32, c.id) || c.id, role, look: normalizeLook(c.look, role), size: clamp(Math.round(c.size), 0, 10, 5), fight: normalizeFight(c.fight) });
  }
  if (!characters.some((c) => c.role === 'player')) characters.unshift(newCharacter('player', 'Player look', 'player'));
  const levels = (Array.isArray(w.levels) ? w.levels : []).slice(0, LIMITS.levels).map((l, i) => normalizeLevel(l, i, materialIds));
  if (!levels.length) levels.push(newLevel('l1'));
  const levelIds = new Set();
  for (const [i, l] of levels.entries()) {
    if (levelIds.has(l.id)) l.id = `l${i + 1}x`;
    levelIds.add(l.id);
  }
  const s = w.screens && typeof w.screens === 'object' ? w.screens : {};
  const c = w.coop && typeof w.coop === 'object' ? w.coop : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    format: FORMAT,
    version: VERSION,
    name: str(w.name, 40, 'My world') || 'My world',
    screens: {
      title: str(s.title, 40, w.name ?? 'My world'),
      subtitle: str(s.subtitle, 80, 'Press Start'),
      win: str(s.win, 80, 'You win'),
      lose: str(s.lose, 80, 'Game over'),
    },
    coop: {
      players: clamp(Math.round(c.players), 1, 4, 4),
      dropIn: bool(c.dropIn, true),
      revive: bool(c.revive, true),
      tougher: bool(c.tougher, true),
      friendlyFire: bool(c.friendlyFire, false),
    },
    materials,
    characters,
    levels,
  };
}

// Stable text for a world: the same world gives the same text everywhere,
// so a hash of it says whether two machines hold the same world.
export function canonical(world) {
  return JSON.stringify(world);
}

export function hashText(text) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export const worldHash = (world) => hashText(canonical(normalize(world)));

// Counts the maker shows while you build.
export function levelStats(level) {
  let toys = 0;
  for (const p of level.parts) if (PART[p.type].kind === 'toy' || p.type === 'seesaw') toys++;
  return { toys, parts: level.parts.length, wires: level.wires.length, blocks: level.blocks.length };
}
