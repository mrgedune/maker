// The tutorial: a small world to build, and a card of steps that tick off as
// they are done. The card follows the world the tutorial made; with another
// world open it steps aside until that one is open again.

import { h, fill } from './dom.js';

const KEY = 'maker.tutorial';

const has = (lv, type) => lv.parts.some((p) => p.type === type);
const wired = (lv, fromType, toType) => {
  const types = new Map(lv.parts.map((p) => [p.id, p.type]));
  return lv.wires.some((w) => types.get(w.from) === fromType && types.get(w.to) === toType);
};

export const STEPS = [
  {
    title: 'Paint a wall',
    how: 'On Build, pick Blocks and a block, then drag across the map to shut off one end. Leave a gap one block wide.',
    done: (lv, t) => lv.blocks.length >= t.blocks + 4,
  },
  { title: 'Put a door in the gap', how: 'Pick Doers, then Door or gate, and click the gap. R turns it to fit.', done: (lv) => has(lv, 'door') },
  { title: 'Put an exit behind the wall', how: 'Pick Items, then Exit. Reaching it finishes the level.', done: (lv) => has(lv, 'exit') },
  { title: 'Put a pressure plate on your side', how: 'Pick Senses, then Pressure plate.', done: (lv) => has(lv, 'plate') },
  { title: 'Put a crate near the plate', how: 'Pick Physics toys, then Crate.', done: (lv) => has(lv, 'crate') },
  {
    title: 'Wire the plate to the door',
    how: 'Open Wiring. Click the plate, then the door. Now the plate opens the door.',
    done: (lv) => wired(lv, 'plate', 'door'),
  },
  {
    title: 'Play it',
    how: 'Press Play. Walk up to the crate and press E to pick it up, E again to put it down on the plate, then go through the door to the exit.',
    done: (lv, t) => t.won,
  },
];

function read() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || 'null');
    return t && typeof t.id === 'string' ? t : null;
  } catch {
    return null;
  }
}
function write(t) {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    // the card still works for this visit
  }
}

export function mountTutorial(parent, { store, openExamples }) {
  let t = read();
  const card = h('aside', { class: 'tutorial', 'aria-label': 'Tutorial', hidden: true });
  parent.append(card);

  function render() {
    const show = t && store.id === t.id && (store.screen === 'build' || store.screen === 'wiring');
    card.hidden = !show;
    if (!show) return;
    const lv = store.doc.levels[0];
    const done = STEPS.map((s) => Boolean(s.done(lv, t)));
    const now = done.indexOf(false);
    const count = done.filter(Boolean).length;
    const head = h('div', { class: 'tutorial-head' },
      h('b', {}, 'Tutorial'),
      h('span', { class: 'muted small' }, now < 0 ? 'All done' : `Step ${now + 1} of ${STEPS.length}`),
      h('span', { class: 'grow' }),
      h('button', { class: 'small', 'aria-expanded': String(!t.hidden), onclick: () => { t.hidden = !t.hidden; write(t); render(); } }, t.hidden ? 'Show steps' : 'Hide'),
      h('button', { class: 'small', title: 'Stop the tutorial. The world stays under My worlds.', 'aria-label': 'Stop the tutorial', onclick: stop }, '×'));
    if (t.hidden) {
      fill(card, head);
      return;
    }
    const list = h('ol', { class: 'tutorial-steps' },
      STEPS.map((s, i) =>
        h('li', { class: done[i] ? 'done' : i === now ? 'now' : '' },
          h('span', { class: 'tick', 'aria-hidden': 'true' }, done[i] ? '✓' : String(i + 1)),
          h('div', {}, h('span', {}, s.title, done[i] ? h('span', { class: 'sr' }, ' (done)') : null), i === now ? h('p', { class: 'help' }, s.how) : null))));
    const end = now < 0
      ? h('div', {},
          h('p', { class: 'help' }, 'That is a game: a sense, a wire and a door. This world stays under My worlds. Save world file in the File menu keeps a copy anywhere else.'),
          h('div', { class: 'buttons' }, h('button', { class: 'primary', onclick: openExamples }, 'See the examples'), h('button', { onclick: stop }, 'Close the tutorial')))
      : null;
    card.setAttribute('aria-label', `Tutorial, ${count} of ${STEPS.length} done`);
    fill(card, head, list, end);
  }

  function stop() {
    t = null;
    write(null);
    render();
  }

  store.on((what) => {
    if (what === 'won' && t && store.id === t.id && !t.won) {
      t.won = true;
      write(t);
    }
    render();
  });
  render();

  return {
    // Follow the world just opened from the start.
    begin() {
      t = { id: store.id, blocks: store.doc.levels[0].blocks.length, won: false, hidden: false };
      write(t);
      render();
    },
  };
}
