// The bucket: every part a world can hold, what it is for, and the settings
// the maker shows for it. The maker's screens, the simulation and the
// renderer all read this one list, so a part cannot mean one thing to the
// editor and another to the game.
//
// Sizes are in cells (one cell is one block, about a metre). A part's z is
// the height of its underside when placed; the editor sets it to the top of
// whatever is under it.

export const CATEGORIES = [
  { id: 'blocks', label: 'Blocks', help: 'Paint the ground, walls and platforms.' },
  { id: 'toys', label: 'Physics toys', help: 'Things that fall, roll, stack and get thrown.' },
  { id: 'characters', label: 'Characters', help: 'Where players start, and the creatures they fight.' },
  { id: 'items', label: 'Items', help: 'Things players pick up or reach.' },
  { id: 'senses', label: 'Senses', help: 'Machine parts that send a signal.' },
  { id: 'logic', label: 'Logic', help: 'Machine parts that shape a signal.' },
  { id: 'doers', label: 'Doers', help: 'Machine parts that act when a signal reaches them.' },
  { id: 'lights', label: 'Lights', help: 'Lamps and glows.' },
];

// Kinds: how the simulation treats a part.
//   toy       a dynamic physics body
//   solid     a fixed body that can break or move (breakable wall, door)
//   pad       a fixed pad that launches what stands on it
//   seesaw    a plank on a pivot
//   spawn     where a player starts
//   creature  a creature from the cast
//   item      collected or reached
//   sense / logic / doer   machine parts (wiring)
//   light     a lamp, which wiring can switch

const range = (key, label, min, max, value, help) => ({ key, label, type: 'range', min, max, step: 1, value, help });
const check = (key, label, value, help) => ({ key, label, type: 'check', value, help });
const number = (key, label, min, max, step, value, help) => ({ key, label, type: 'number', min, max, step, value, help });
const select = (key, label, options, value, help) => ({ key, label, type: 'select', options, value, help });
const text = (key, label, value, max, help) => ({ key, label, type: 'text', value, max, help });

const WHO = [
  ['players', 'Players'],
  ['anything', 'Players, creatures or toys'],
  ['creatures', 'Creatures'],
  ['toys', 'Toys'],
];

export const PARTS = [
  // Physics toys
  {
    type: 'crate', label: 'Crate', category: 'toys', kind: 'toy', icon: '[#]', shape: 'box',
    size: [0.9, 0.9, 0.9], color: '#c9a46a',
    help: 'Falls, stacks, gets pushed and knocked over. Stand on it to climb.',
    props: [
      range('weight', 'Weight', 0, 10, 4),
      range('bounce', 'Bounce', 0, 10, 1),
      check('pinned', 'Pinned in place', false),
      check('carry', 'Players can pick it up and throw it', true),
    ],
  },
  {
    type: 'ball', label: 'Ball', category: 'toys', kind: 'toy', icon: '( )', shape: 'ball',
    size: [0.7, 0.7, 0.7], color: '#e05a4f',
    help: 'Rolls and bounces.',
    props: [range('weight', 'Weight', 0, 10, 2), range('bounce', 'Bounce', 0, 10, 6), check('carry', 'Players can pick it up and throw it', true)],
  },
  {
    type: 'barrel', label: 'Barrel, boom', category: 'toys', kind: 'toy', icon: '[!]', shape: 'cylinder',
    size: [0.75, 0.75, 1], color: '#d0402c',
    help: 'Blows up when hit or thrown hard. Breaks walls marked breakable, and hurts anyone close.',
    props: [
      range('weight', 'Weight', 0, 10, 4),
      range('blast', 'Blast size', 1, 10, 5),
      check('explodes', 'Explodes', true),
      check('carry', 'Players can pick it up and throw it', true),
    ],
  },
  {
    type: 'plank', label: 'Plank', category: 'toys', kind: 'toy', icon: '===', shape: 'box',
    size: [3, 0.5, 0.2], color: '#a77b4b',
    help: 'A long board. Bridge a gap or make a ramp.',
    props: [range('weight', 'Weight', 0, 10, 3), check('pinned', 'Pinned in place', false), check('carry', 'Players can pick it up and throw it', false)],
  },
  {
    type: 'seesaw', label: 'Seesaw', category: 'toys', kind: 'seesaw', icon: '-^-', shape: 'box',
    size: [4, 0.8, 0.2], color: '#8fb3c9',
    help: 'A plank on a pivot. Drop something on one end to fling what is on the other.',
    props: [range('weight', 'Plank weight', 0, 10, 3)],
  },
  {
    type: 'spring', label: 'Spring pad', category: 'toys', kind: 'pad', icon: '/\\/', shape: 'box',
    size: [1, 1, 0.2], color: '#4cc38a',
    help: 'Launches anything that lands on it.',
    props: [range('strength', 'Strength', 1, 10, 6)],
  },
  {
    type: 'breakable', label: 'Breakable wall', category: 'toys', kind: 'solid', icon: '|%|', shape: 'box',
    size: [1, 1, 2], color: '#8a7f73',
    help: 'A wall a blast knocks down. Can also take hits.',
    props: [number('hits', 'Hits to break (0: blasts only)', 0, 20, 1, 0)],
  },

  // Characters
  {
    type: 'start', label: 'Player start', category: 'characters', kind: 'spawn', icon: ' @ ', shape: 'box',
    size: [0.8, 0.8, 0.1], color: '#4cc38a',
    help: 'Where players appear. Place up to four for co-op; they fill in order.',
    props: [],
  },
  {
    type: 'creature', label: 'Creature', category: 'characters', kind: 'creature', icon: ' & ', shape: 'figure',
    size: [0.8, 0.8, 1.8], color: '#ff4d4f',
    help: 'A creature from your cast. Make and tune them on the Characters screen.',
    props: [select('character', 'Character', [], '', 'Pick from the cast'), check('waits', 'Waits until a player comes close', false)],
  },

  // Items
  {
    type: 'key', label: 'Key', category: 'items', kind: 'item', icon: 'o-,', shape: 'box',
    size: [0.4, 0.4, 0.4], color: '#ffcc33',
    help: 'Picked up by touching it. A locked door takes one.',
    props: [],
  },
  {
    type: 'gem', label: 'Gem', category: 'items', kind: 'item', icon: '<>', shape: 'ball',
    size: [0.35, 0.35, 0.35], color: '#7fd4ff',
    help: 'Adds to the score.',
    props: [number('value', 'Points', 1, 1000, 1, 10)],
  },
  {
    type: 'health', label: 'Health pack', category: 'items', kind: 'item', icon: '[+]', shape: 'box',
    size: [0.5, 0.5, 0.35], color: '#f2f2f2',
    help: 'Heals whoever touches it.',
    props: [number('amount', 'Heals', 5, 100, 5, 50)],
  },
  {
    type: 'exit', label: 'Exit', category: 'items', kind: 'item', icon: '>>>', shape: 'box',
    size: [1, 1, 0.1], color: '#4cc38a',
    help: 'Reaching it finishes the level.',
    props: [check('everyone', 'Everyone standing must reach it (co-op)', false)],
  },

  // Senses
  {
    type: 'button', label: 'Button', category: 'senses', kind: 'sense', icon: '(o)', shape: 'box',
    size: [0.35, 0.35, 0.35], color: '#ff4d4f', out: true,
    help: 'Press with E (or Use) nearby. Sends a short signal.',
    props: [number('hold', 'Signal lasts (seconds)', 0.1, 30, 0.1, 0.5)],
  },
  {
    type: 'lever', label: 'Lever', category: 'senses', kind: 'sense', icon: '\\_/', shape: 'box',
    size: [0.3, 0.3, 0.6], color: '#f0b429', out: true,
    help: 'Pull with E (or Use). Stays on until pulled again.',
    props: [check('startsOn', 'Starts on', false)],
  },
  {
    type: 'plate', label: 'Pressure plate', category: 'senses', kind: 'sense', icon: '___', shape: 'box',
    size: [1, 1, 0.08], color: '#9aa7b3', out: true,
    help: 'On while something stands on it.',
    props: [select('who', 'Pressed by', WHO.slice(0, 2), 'anything')],
  },
  {
    type: 'zone', label: 'Zone', category: 'senses', kind: 'sense', icon: '[ ]', shape: 'zone',
    size: [3, 3, 2], color: '#7fd4ff', out: true,
    help: 'An invisible box. On while someone is inside.',
    props: [select('who', 'Counts', WHO, 'players')],
  },
  {
    type: 'target', label: 'Hit by something', category: 'senses', kind: 'sense', icon: '(+)', shape: 'box',
    size: [0.8, 0.2, 0.8], color: '#ffd166', out: true,
    help: 'A target. Sends a signal when it is hit, thrown at or blasted.',
    props: [],
  },
  {
    type: 'down', label: 'Creature down', category: 'senses', kind: 'sense', icon: 'x_x', shape: 'none',
    size: [0.5, 0.5, 0.5], color: '#ff4d4f', out: true,
    help: 'Sends a signal when creatures are beaten. Pick one creature, or all of them in the level.',
    props: [select('which', 'Which', [['all', 'All creatures in the level']], 'all')],
  },
  {
    type: 'timer', label: 'Timer', category: 'senses', kind: 'sense', icon: '(L)', shape: 'none',
    size: [0.5, 0.5, 0.5], color: '#a3a7b0', out: true, in: true,
    help: 'Sends a short signal every so often. With a wire in, it runs only while that wire is on.',
    props: [number('every', 'Every (seconds)', 0.5, 120, 0.5, 3)],
  },

  // Logic
  { type: 'and', label: 'And', category: 'logic', kind: 'logic', icon: '&', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true, help: 'On while every wire coming in is on.', props: [] },
  { type: 'or', label: 'Or', category: 'logic', kind: 'logic', icon: '|', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true, help: 'On while any wire coming in is on.', props: [] },
  { type: 'not', label: 'Not', category: 'logic', kind: 'logic', icon: '!', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true, help: 'On while no wire coming in is on.', props: [] },
  {
    type: 'delay', label: 'Delay', category: 'logic', kind: 'logic', icon: '..', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true,
    help: 'Passes the signal on later.', props: [number('seconds', 'Delay (seconds)', 0.1, 60, 0.1, 1)],
  },
  {
    type: 'counter', label: 'Counter', category: 'logic', kind: 'logic', icon: '#3', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true,
    help: 'Counts signals coming in. Turns on and stays on once it reaches the number.', props: [number('target', 'Count to', 1, 99, 1, 3)],
  },
  {
    type: 'random', label: 'Random', category: 'logic', kind: 'logic', icon: '?', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true,
    help: 'Each signal in has a chance to pass on.', props: [range('chance', 'Chance (out of 10)', 1, 9, 5)],
  },
  {
    type: 'toggle', label: 'Switch on/off', category: 'logic', kind: 'logic', icon: '<>', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true, out: true,
    help: 'Each signal in flips it on or off.', props: [check('startsOn', 'Starts on', false)],
  },

  // Doers
  {
    type: 'door', label: 'Door or gate', category: 'doers', kind: 'solid', icon: '|D|', shape: 'box',
    size: [1, 0.3, 2], color: '#5d6b7a', in: true,
    help: 'Opens while its signal is on, or once and for good. A locked door opens for a key.',
    props: [check('stayOpen', 'Stays open once opened', false), check('locked', 'Locked: needs a key', false), check('startsOpen', 'Starts open', false)],
  },
  {
    type: 'spawner', label: 'Spawner', category: 'doers', kind: 'doer', icon: '>&<', shape: 'zone', size: [1, 1, 0.2], color: '#ff4d4f', in: true,
    help: 'Brings in a creature from your cast each time a signal arrives.',
    props: [select('character', 'Creature', [], ''), number('most', 'Most at once', 1, 20, 1, 3)],
  },
  {
    type: 'launcher', label: 'Push or launch', category: 'doers', kind: 'doer', icon: '^^^', shape: 'zone', size: [2, 2, 1], color: '#4cc38a', in: true,
    help: 'Throws everything inside it, the way it faces and up, when a signal arrives.',
    props: [range('strength', 'Strength', 1, 10, 5), range('lift', 'Upward', 0, 10, 6)],
  },
  {
    type: 'sound', label: 'Sound', category: 'doers', kind: 'doer', icon: '<))', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true,
    help: 'Plays a sound when a signal arrives.',
    props: [select('sound', 'Sound', [['chime', 'Chime'], ['alarm', 'Alarm'], ['blast', 'Blast'], ['clank', 'Clank'], ['fanfare', 'Fanfare'], ['boom', 'Low boom']], 'chime')],
  },
  {
    type: 'effect', label: 'Effect', category: 'doers', kind: 'doer', icon: '*', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true,
    help: 'A flash, a shake or sparks when a signal arrives.',
    props: [select('effect', 'Effect', [['flash', 'Flash'], ['shake', 'Shake'], ['sparks', 'Sparks']], 'flash')],
  },
  {
    type: 'score', label: 'Score', category: 'doers', kind: 'doer', icon: '+10', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true,
    help: 'Adds to the score when a signal arrives.', props: [number('amount', 'Points', -1000, 1000, 1, 10)],
  },
  {
    type: 'message', label: 'Message', category: 'doers', kind: 'doer', icon: '"a"', shape: 'none', size: [0.5, 0.5, 0.5], color: '#a3a7b0', in: true,
    help: 'Shows words on screen when a signal arrives.',
    props: [text('text', 'Words', 'The vault is open.', 80), number('seconds', 'Shown for (seconds)', 1, 20, 1, 4)],
  },
  { type: 'win', label: 'Win', category: 'doers', kind: 'doer', icon: '\\o/', shape: 'none', size: [0.5, 0.5, 0.5], color: '#4cc38a', in: true, help: 'Finishes the level when a signal arrives.', props: [] },
  { type: 'lose', label: 'Lose', category: 'doers', kind: 'doer', icon: 'x', shape: 'none', size: [0.5, 0.5, 0.5], color: '#ff4d4f', in: true, help: 'Game over when a signal arrives.', props: [] },

  // Lights
  {
    type: 'lamp', label: 'Lamp', category: 'lights', kind: 'light', icon: '-*-', shape: 'ball', size: [0.3, 0.3, 0.3], color: '#ffd9a0', in: true,
    help: 'A light. With a wire in, it is on only while the signal is.',
    props: [range('brightness', 'Brightness', 1, 10, 6), range('reach', 'Reach', 1, 10, 5)],
  },
];

export const PART = Object.freeze(Object.fromEntries(PARTS.map((p) => [p.type, Object.freeze(p)])));

// Wiring: which parts send and receive. Senses send; logic does both; doers,
// doors and lamps receive. A creature part can feed "Creature down".
// Names for parts in sentences: "Door 2", "Pressure plate 1".
export function partName(level, part) {
  if (!part) return 'nothing';
  const same = level.parts.filter((p) => p.type === part.type);
  const n = same.indexOf(part) + 1;
  return `${PART[part.type]?.label ?? part.type} ${n}`;
}

export const sends = (type) => Boolean(PART[type]?.out);
export const receives = (type) => Boolean(PART[type]?.in);

// Default settings for a new part of this type.
export function defaultProps(type) {
  const def = PART[type];
  const props = {};
  for (const p of def?.props ?? []) props[p.key] = p.value;
  return props;
}

// The materials a new world starts with: glyph and colour, as the engine
// draws them. The maker lets you add and repaint them.
export const DEFAULT_MATERIALS = [
  { id: 'stone', name: 'Stone', glyph: '█', color: '#8a8f98' },
  { id: 'brick', name: 'Brick', glyph: '▓', color: '#a0543f' },
  { id: 'metal', name: 'Metal', glyph: '▒', color: '#7d8fa1' },
  { id: 'wood', name: 'Wood', glyph: '#', color: '#9c6b3e' },
  { id: 'grass', name: 'Grass', glyph: '"', color: '#4f9a4a' },
  { id: 'sand', name: 'Sand', glyph: '░', color: '#d8c38f' },
  { id: 'glass', name: 'Glass', glyph: '░', color: '#7fb6c9' },
  { id: 'dark', name: 'Dark', glyph: '█', color: '#2b2f38' },
  { id: 'glow', name: 'Glow', glyph: '█', color: '#ff4d4f', glow: true },
  { id: 'white', name: 'White', glyph: '█', color: '#e8e6e3' },
];

// Limits that keep co-op in step on an ordinary laptop (spike/physics).
export const LIMITS = Object.freeze({
  size: 64, // cells across a level, each way
  height: 16, // cells high
  levels: 8,
  parts: 600, // per level
  toys: 150, // moving physics toys per level (the co-op budget)
  wires: 400,
  characters: 24,
  materials: 32,
});
