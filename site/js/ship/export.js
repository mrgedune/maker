// A world as a web game anyone can put online: the player page, the code it
// runs (found by following its imports from js/player.js), the physics, the
// licences, and the world itself, in one .zip.

import { canonical, normalize } from '../kit/format.js';
import { makeZip } from './zip.js';

const ROOT = new URL('../../', import.meta.url); // the site's own folder

// What a module asks for: its imports and exports from, dynamic imports of
// a fixed path, and files it finds next to itself (new URL(..., import.meta.url)).
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

export function specifiers(text) {
  const found = new Set();
  for (const re of SPECIFIERS) for (const m of text.matchAll(re)) if (m[1].startsWith('.')) found.add(m[1]);
  return [...found];
}

// Every file the player needs, by its path in the site: { path: Uint8Array }.
// `read(path)` gives a file's bytes (fetch in the browser; the disk in tests).
export async function playerFiles(read, entry = 'js/player.js') {
  const files = new Map();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (files.has(path)) continue;
    const bytes = await read(path);
    files.set(path, bytes);
    if (!/\.(m?js)$/.test(path)) continue;
    // A bundle (Rapier) is one file that asks for nothing.
    if (path.startsWith('vendor/')) continue;
    const text = new TextDecoder().decode(bytes);
    const base = new URL(path, 'https://site/');
    for (const spec of specifiers(text)) {
      const url = new URL(spec, base);
      if (url.origin !== 'https://site') continue;
      queue.push(url.pathname.slice(1));
    }
  }
  return files;
}

export const EXTRA = ['player.html', 'css/maker.css', 'engine/LICENSE.md', 'vendor/rapier/LICENSE'];

const README = (doc) => `${doc.name}
${'='.repeat(Math.max(3, doc.name.length))}

A game made with the Rabbit House maker.

To play it, put this folder on a web host and open index.html there. For
itch.io: make a new project, choose HTML as the kind of project, upload this
.zip, and tick "This file will be played in the browser".

Browsers do not run it straight from your disk (opening index.html by
double-clicking shows a blank page): it needs to be served. To try it on your
own computer, run a small web server in this folder, for example
"python -m http.server", and open http://localhost:8000.

Controls: W A S D move, the mouse looks, Space jumps, Shift runs, left click
attacks, right click parries, E uses.

The engine is under the licence in engine/LICENSE.md; the physics (Rapier)
under vendor/rapier/LICENSE.
`;

async function fetchBytes(path) {
  const res = await fetch(new URL(path, ROOT));
  if (!res.ok) throw new Error(`Could not read ${path} (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

// The .zip for a world, as a Blob. `onProgress(text)` hears how it goes.
export async function exportGame(doc, { onProgress = () => {}, read = fetchBytes } = {}) {
  const world = normalize(doc);
  onProgress('Collecting the game’s files…');
  const files = await playerFiles(read);
  for (const path of EXTRA) if (!files.has(path)) files.set(path, await read(path));
  const list = [];
  for (const [path, data] of files) list.push({ name: path === 'player.html' ? 'index.html' : path, data });
  list.push({ name: 'world.json', data: canonical(world) });
  list.push({ name: 'README.txt', data: README(world) });
  onProgress('Packing the .zip…');
  return makeZip(list);
}
