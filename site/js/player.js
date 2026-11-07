// A world played on its own: the page an exported game opens with
// (index.html, from player.html). It reads world.json next to it; the
// maker's Ship screen opens it with ?preview to play the world being made.

import { createRunner } from './play/runner.js';
import { normalize } from './kit/format.js';
import { h, fill } from './ui/dom.js';

const box = document.getElementById('game');

async function readWorld() {
  if (new URLSearchParams(location.search).has('preview')) {
    const text = localStorage.getItem('maker.preview');
    if (!text) throw new Error('Nothing to preview. Open the preview from the maker’s Ship screen.');
    return JSON.parse(text);
  }
  const res = await fetch('world.json');
  if (!res.ok) throw new Error('The world file (world.json) is missing.');
  return res.json();
}

try {
  const doc = normalize(await readWorld());
  document.title = doc.screens.title || doc.name;
  const runner = await createRunner(box, { doc, title: true });
  window.game = runner;
} catch (err) {
  console.error(err);
  fill(box, h('div', { class: 'page' }, h('p', {}, `The game could not start: ${err.message}`)));
}
