// Ship: check the world is ready, set its title and end screens, and send it
// out: the world file (opens again in the maker) or a web game (.zip) to put
// online.

import { h, fill, toast, downloadBlob, downloadText, safeName } from './dom.js';
import { canonical, worldHash } from '../kit/format.js';
import { checkWorld } from '../ship/checks.js';

const MARK = { ok: '✓', no: '✗', maybe: '!' };

export function mount(el, { store, switchTo }) {
  const page = h('div', { class: 'page' });
  el.append(page);
  let shown = false;
  let busy = '';

  function render() {
    const doc = store.doc;
    const checks = checkWorld(doc, { playedToEnd: store.playedToEnd.has(worldHash(doc)) });
    const blocking = checks.filter((c) => c.status === 'no').length;
    const text = (key, label, max) => h('label', { class: 'field' }, h('span', {}, label),
      h('input', { 'data-screen-text': key, maxlength: max, value: doc.screens[key], onchange: (e) => store.change((d) => {
        d.screens[key] = e.target.value;
      }) }));
    fill(page, h('div', { class: 'cols' },
      h('div', { class: 'panel' },
        h('h2', {}, 'Before you share it'),
        h('ul', { class: 'checklist', 'data-checks': blocking ? 'blocked' : 'ready' },
          checks.map((c) => h('li', { 'data-status': c.status }, h('span', { class: c.status, 'aria-label': c.status }, MARK[c.status]), h('span', {}, c.text)))),
        h('div', { class: 'buttons' },
          h('button', { onclick: () => switchTo('play', { level: 0 }) }, 'Play from the start')),
      ),
      h('div', { class: 'panel' },
        h('h2', {}, 'Title and end screens'),
        text('title', 'Title', 40),
        text('subtitle', 'Under the title', 80),
        text('win', 'When the last level is finished', 80),
        text('lose', 'When everyone is down', 80),
      ),
      h('div', { class: 'panel' },
        h('h2', {}, 'Share it'),
        h('h3', {}, 'World file'),
        h('p', { class: 'muted' }, 'Opens again in the maker, on any computer (World menu, Open world file).'),
        h('div', { class: 'buttons' }, h('button', { 'data-action': 'save-world', onclick: saveWorld }, 'Save world file')),
        h('h3', {}, 'Web game'),
        h('p', { class: 'muted' }, 'A folder that plays your world in a browser, alone. Put it on any web host; for itch.io, upload the .zip as an HTML game. It needs to be served from the web: opening index.html from your disk shows a blank page.'),
        blocking ? h('p', {}, 'Fix the items marked ✗ first: as it is, the game cannot be finished.') : null,
        h('div', { class: 'buttons' },
          h('button', { class: 'primary', 'data-action': 'export', disabled: Boolean(busy), onclick: exportZip }, busy || 'Download web game (.zip)'),
          h('button', { 'data-action': 'preview', onclick: preview }, 'Try the web game')),
        h('h3', {}, 'Play together'),
        h('p', { class: 'muted' }, 'To play with friends, open a room from Play together. They join with its code; the world is sent to them.'),
        h('div', { class: 'buttons' }, h('button', { onclick: () => switchTo('together') }, 'Play together')),
      ),
    ));
  }

  function saveWorld() {
    downloadText(`${safeName(store.doc.name)}.world.json`, canonical(store.doc), 'application/json');
    toast('World file saved to your downloads.');
  }

  // The web game as it will run, in a new tab, with the world as it is now.
  function preview() {
    try {
      localStorage.setItem('maker.preview', canonical(store.doc));
    } catch {
      toast('This browser would not hold the world for the preview.');
      return;
    }
    window.open('player.html?preview', '_blank', 'noopener');
  }

  async function exportZip() {
    if (busy) return;
    busy = 'Packing…';
    render();
    try {
      const { exportGame } = await import('../ship/export.js');
      const blob = await exportGame(store.doc, {
        onProgress: (t) => {
          busy = t;
          render();
        },
      });
      downloadBlob(`${safeName(store.doc.name)}-web-game.zip`, blob);
      toast(`Saved ${(blob.size / 1048576).toFixed(1)} MB.`);
    } catch (err) {
      console.error(err);
      toast(`The game could not be packed: ${err.message}`);
    }
    busy = '';
    render();
  }

  store.on((what) => {
    if (shown && (what === 'doc' || what === 'world')) render();
  });

  return {
    show() {
      shown = true;
      render();
    },
    hide() {
      shown = false;
    },
  };
}
