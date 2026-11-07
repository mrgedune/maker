// The maker's shell: the world being made, undo, saving in this browser and
// to files, and the six screens.

import { normalize, newWorld, canonical, FORMAT } from './kit/format.js';
import { partName } from './kit/catalog.js';
import { $, h, toast, openDialog, closeDialog, downloadText, safeName } from './ui/dom.js';

const KEY_INDEX = 'maker.index';
const KEY_CURRENT = 'maker.current';
const KEY_WORLD = (id) => `maker.world.${id}`;
const UNDO_MAX = 80;

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing to remove
    }
  },
};

const randomId = () => Math.random().toString(36).slice(2, 10);

// A first level that can be played straight away: a floor, a low wall round
// the edge and a place to start.
export function starterWorld(name = 'My world') {
  const w = newWorld(name);
  const l = w.levels[0];
  const [W, H] = l.size;
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) if (x === 0 || y === 0 || x === W - 1 || y === H - 1) l.blocks.push([x, y, 'brick', 0, 2]);
  l.parts.push({ id: 'start1', type: 'start', x: 4.5, y: H / 2, z: 0, turn: 0, props: {} });
  return normalize(w);
}

// ---------------------------------------------------------------- the store

const listeners = new Set();
export const store = {
  id: null,
  doc: null,
  level: 0,
  selected: null, // part id
  undo: [],
  redo: [],
  dirty: false,
  playedToEnd: new Set(), // canonical hashes of worlds played to a win this visit
  pending: null,

  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(what = 'doc') {
    for (const fn of listeners) fn(what);
  },
  get levelDoc() {
    return this.doc.levels[Math.min(this.level, this.doc.levels.length - 1)];
  },
  // Start a change: remember the world as it was, for undo. A drag calls this
  // once at the start, edits the doc directly while it moves, then commit().
  begin() {
    if (this.pending === null) this.pending = canonical(this.doc);
  },
  commit({ quiet = false } = {}) {
    if (this.pending === null) return;
    const before = this.pending;
    this.pending = null;
    const next = normalize(JSON.parse(JSON.stringify(this.doc)));
    const after = canonical(next);
    if (after === before) {
      this.doc = next;
      return;
    }
    this.undo.push(before);
    if (this.undo.length > UNDO_MAX) this.undo.shift();
    this.redo.length = 0;
    this.doc = next;
    if (this.selected && !this.levelDoc.parts.some((p) => p.id === this.selected)) this.selected = null;
    this.save();
    if (!quiet) this.emit('doc');
  },
  // One change in one call.
  change(fn) {
    this.begin();
    fn(this.doc, this.levelDoc);
    this.commit();
  },
  stepUndo(dir) {
    const from = dir < 0 ? this.undo : this.redo;
    const to = dir < 0 ? this.redo : this.undo;
    if (!from.length) return;
    to.push(canonical(this.doc));
    this.doc = normalize(JSON.parse(from.pop()));
    this.level = Math.min(this.level, this.doc.levels.length - 1);
    if (this.selected && !this.levelDoc.parts.some((p) => p.id === this.selected)) this.selected = null;
    this.save();
    this.emit('doc');
  },
  select(id) {
    this.selected = id;
    this.emit('select');
  },
  setLevel(i) {
    this.level = Math.max(0, Math.min(this.doc.levels.length - 1, i));
    this.selected = null;
    this.emit('level');
  },
  // Load a world as the one being made.
  load(doc, id = randomId()) {
    this.doc = normalize(doc);
    this.id = id;
    this.level = 0;
    this.selected = null;
    this.undo = [];
    this.redo = [];
    this.save();
    storage.set(KEY_CURRENT, id);
    this.emit('world');
  },
  save() {
    if (!this.id) return;
    const text = canonical(this.doc);
    if (!storage.set(KEY_WORLD(this.id), text)) {
      toast('This browser would not keep the world. Save it as a file from the World menu.');
      return;
    }
    const index = readIndex().filter((w) => w.id !== this.id);
    index.unshift({ id: this.id, name: this.doc.name, saved: Date.now() });
    storage.set(KEY_INDEX, JSON.stringify(index.slice(0, 50)));
  },
  // A part id not yet used in this level.
  newPartId(type) {
    const used = new Set(this.levelDoc.parts.map((p) => p.id));
    const base = type.replace(/[^a-z]/g, '').slice(0, 10) || 'part';
    for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
  },
};

function readIndex() {
  try {
    const list = JSON.parse(storage.get(KEY_INDEX) || '[]');
    return Array.isArray(list) ? list.filter((w) => w && typeof w.id === 'string') : [];
  } catch {
    return [];
  }
}

function loadSaved(id) {
  const text = storage.get(KEY_WORLD(id));
  if (!text) return false;
  try {
    store.load(JSON.parse(text), id);
    return true;
  } catch {
    return false;
  }
}

// Names for parts in sentences: "Door 2", "Pressure plate 1" (kit/catalog.js).
export { partName };

// ---------------------------------------------------------------- screens

const screens = {};
let active = 'build';

async function mountScreens() {
  const ctx = { store, switchTo };
  const mods = {
    build: () => import('./ui/build.js'),
    wiring: () => import('./ui/wiring.js'),
    characters: () => import('./ui/characters.js'),
    play: () => import('./ui/play-screen.js'),
    together: () => import('./ui/together.js'),
    ship: () => import('./ui/ship.js'),
  };
  for (const [name, load] of Object.entries(mods)) {
    const el = document.getElementById(`screen-${name}`);
    try {
      const mod = await load();
      screens[name] = mod.mount(el, ctx);
    } catch (err) {
      console.error(err);
      el.replaceChildren(h('div', { class: 'page' }, h('p', {}, `This screen did not load: ${err.message}`)));
      screens[name] = { show() {}, hide() {} };
    }
  }
}

export function switchTo(name, options) {
  if (!screens[name]) return;
  if (active !== name) screens[active]?.hide?.();
  active = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.screen === name));
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.dataset.screen !== name;
  screens[name].show?.(options);
  try {
    history.replaceState(null, '', `#${name}`);
  } catch {
    // a file:// page may refuse
  }
}

// ---------------------------------------------------------------- world menu

function openWorldFile() {
  const input = $('#open-file');
  input.value = '';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      if (doc.format !== FORMAT) throw new Error('This file is not a maker world.');
      store.load(doc);
      toast(`Opened ${store.doc.name}.`);
    } catch (err) {
      toast(err.message || 'That file could not be opened.');
    }
  };
  input.click();
}

function saveWorldFile() {
  downloadText(`${safeName(store.doc.name)}.world.json`, JSON.stringify(store.doc, null, 1), 'application/json');
  toast('World file saved to your downloads.');
}

function newWorldDialog() {
  const name = h('input', { value: 'My world', maxlength: 40 });
  openDialog(
    h('h2', {}, 'New world'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), name),
    h('p', { class: 'help' }, 'Starts with one level: a floor, a wall round the edge and a player start. Your current world stays under My worlds.'),
    h('div', { class: 'buttons' },
      h('button', { class: 'primary', onclick: () => { store.load(starterWorld(name.value.trim() || 'My world')); closeDialog(); switchTo('build'); } }, 'Make it'),
      h('button', { onclick: closeDialog }, 'Cancel')),
  );
  name.select();
}

function worldsDialog() {
  const list = readIndex();
  const rows = list.map((w) =>
    h('div', { class: 'wire-row' },
      h('p', {}, h('b', {}, w.name || 'Untitled'), h('br'), h('span', { class: 'muted small' }, new Date(w.saved).toLocaleString())),
      h('div', { class: 'buttons' },
        h('button', { onclick: () => { if (loadSaved(w.id)) { closeDialog(); toast(`Opened ${store.doc.name}.`); } } }, w.id === store.id ? 'Open (now)' : 'Open'),
        h('button', {
          class: 'danger',
          disabled: w.id === store.id,
          onclick: (e) => {
            if (!confirm(`Delete "${w.name}" from this browser? This cannot be undone.`)) return;
            storage.remove(KEY_WORLD(w.id));
            storage.set(KEY_INDEX, JSON.stringify(readIndex().filter((x) => x.id !== w.id)));
            e.target.closest('.wire-row').remove();
          },
        }, 'Delete'))));
  openDialog(
    h('h2', {}, 'My worlds'),
    h('p', { class: 'help' }, 'Worlds kept in this browser. Save a world file to keep it anywhere else.'),
    h('div', { class: 'list' }, rows.length ? rows : h('p', { class: 'muted' }, 'None yet.')),
    h('div', { class: 'buttons' }, h('button', { onclick: closeDialog }, 'Close')),
  );
}

// ---------------------------------------------------------------- boot

async function boot() {
  const current = storage.get(KEY_CURRENT);
  if (!(current && loadSaved(current))) store.load(starterWorld());

  const nameInput = $('#world-name');
  nameInput.value = store.doc.name;
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim() || 'My world';
    store.change((doc) => {
      if (doc.screens.title === doc.name) doc.screens.title = v;
      doc.name = v;
    });
  });
  store.on((what) => {
    if (what === 'doc' || what === 'world') nameInput.value = store.doc.name;
    $('#undo').disabled = !store.undo.length;
    $('#redo').disabled = !store.redo.length;
  });
  $('#undo').onclick = () => store.stepUndo(-1);
  $('#redo').onclick = () => store.stepUndo(1);
  $('#undo').disabled = true;
  $('#redo').disabled = true;

  const fileButton = $('#file-button');
  const fileMenu = $('#file-menu');
  fileButton.onclick = () => {
    fileMenu.hidden = !fileMenu.hidden;
    fileButton.setAttribute('aria-expanded', String(!fileMenu.hidden));
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) {
      fileMenu.hidden = true;
      fileButton.setAttribute('aria-expanded', 'false');
    }
  });
  fileMenu.addEventListener('click', (e) => {
    const what = e.target.closest('button')?.dataset.file;
    fileMenu.hidden = true;
    if (what === 'new') newWorldDialog();
    else if (what === 'open') openWorldFile();
    else if (what === 'save') saveWorldFile();
    else if (what === 'worlds') worldsDialog();
  });

  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => switchTo(b.dataset.screen);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || active === 'play') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      store.stepUndo(e.shiftKey ? 1 : -1);
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.stepUndo(1);
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveWorldFile();
    }
  });

  await mountScreens();
  const start = location.hash.slice(1);
  switchTo(screens[start] && start !== 'play' ? start : 'build');
  // A room link: straight to Play together.
  const room = new URLSearchParams(location.search).get('room');
  if (room) switchTo('together', { join: room });
  window.maker = { store, switchTo }; // for the browser console and the tests
}

boot();
