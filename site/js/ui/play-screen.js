// Play: the world being made, played alone from the maker.

import { h, fill } from './dom.js';
import { canonical, hashText } from '../kit/format.js';

export function mount(el, { store, switchTo }) {
  const box = h('div', { class: 'center' });
  el.append(box);
  let runner = null;
  let starting = null;

  async function start(level) {
    stop();
    const doc = store.doc;
    const token = {};
    starting = token;
    fill(box, h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Starting…')));
    try {
      const { createRunner } = await import('../play/runner.js');
      if (starting !== token) return;
      runner = await createRunner(box, {
        doc,
        startLevel: level ?? 0,
        title: true,
        onExit: () => switchTo('build'),
        onWin: (game, run) => {
          if (run?.fromStart) store.playedToEnd.add(hashText(canonical(doc)));
        },
      });
      window.maker.runner = runner;
    } catch (err) {
      console.error(err);
      fill(box, h('div', { class: 'page' }, h('p', {}, `The game could not start: ${err.message}`)));
    }
  }
  function stop() {
    starting = null;
    if (runner) {
      runner.stop();
      runner = null;
      if (window.maker) window.maker.runner = null;
    }
  }
  return {
    show(opts) {
      start(opts?.level ?? store.level);
    },
    hide: stop,
  };
}
