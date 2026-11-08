// Wiring: connect parts that sense something to parts that do something, and
// read every connection back as a sentence.

import { PART, PARTS, LIMITS } from '../kit/catalog.js';
import { h, toast, fill } from './dom.js';
import { createMap } from './map.js';
import { partName } from '../app.js';

const canSend = (p) => Boolean(PART[p.type]?.out) || p.type === 'creature';
const canReceive = (p) => Boolean(PART[p.type]?.in);

export function senderPhrase(level, doc, p) {
  const n = partName(level, p);
  switch (p.type) {
    case 'button': return `${n} is pressed`;
    case 'lever': return `${n} is pulled on`;
    case 'plate': return p.props.who === 'players' ? `a player stands on ${n}` : `something stands on ${n}`;
    case 'zone': return { players: `a player is in ${n}`, creatures: `a creature is in ${n}`, toys: `a toy is in ${n}`, anything: `anything is in ${n}` }[p.props.who] ?? `something is in ${n}`;
    case 'target': return `${n} is hit`;
    case 'down': {
      if (p.props.which === 'all') return 'every creature in the level is down';
      const c = level.parts.find((q) => q.id === p.props.which);
      return `${c ? partName(level, c) : 'a creature'} is down`;
    }
    case 'timer': return `${n} ticks (every ${p.props.every} s)`;
    case 'creature': return `${n} is beaten`;
    case 'and': return `${n} is on (every wire into it on)`;
    case 'or': return `${n} is on (any wire into it on)`;
    case 'not': return `${n} is on (no wire into it on)`;
    case 'delay': return `${n} passes it on, ${p.props.seconds} s later`;
    case 'counter': return `${n} has counted to ${p.props.target}`;
    case 'random': return `${n} lets it through (${p.props.chance} in 10)`;
    case 'toggle': return `${n} is switched on`;
    default: return `${n} is on`;
  }
}

export function receiverPhrase(level, doc, p) {
  const n = partName(level, p);
  switch (p.type) {
    case 'door': return p.props.stayOpen ? `${n} opens for good` : `${n} opens (and shuts again when the signal stops)`;
    case 'spawner': {
      const ch = doc.characters.find((c) => c.id === p.props.character);
      return `${n} brings in ${ch ? ch.name : 'a creature'}`;
    }
    case 'launcher': return `${n} throws whatever is in it`;
    case 'sound': return `a ${p.props.sound} sound plays`;
    case 'effect': return `a ${p.props.effect} effect plays`;
    case 'score': return `the score goes ${p.props.amount >= 0 ? 'up' : 'down'} by ${Math.abs(p.props.amount)}`;
    case 'message': return `"${p.props.text}" shows on screen`;
    case 'win': return 'the level is won';
    case 'lose': return 'the game is lost';
    case 'lamp': return `${n} lights`;
    case 'timer': return `${n} runs`;
    default: return `it goes into ${n}`;
  }
}

export function mount(el, { store, switchTo }) {
  const left = h('aside', { class: 'side', 'aria-label': 'Machine parts' });
  const toolbar = h('div', { class: 'toolbar' });
  const mapCanvas = h('canvas', { 'aria-label': 'Wiring map', tabindex: 0 });
  const hint = h('div', { class: 'hint' });
  const right = h('aside', { class: 'side right', 'aria-label': 'Wires' });
  el.append(left, h('div', { class: 'center' }, toolbar, h('div', { class: 'stage' }, mapCanvas, hint)), right);
  const map = createMap(mapCanvas, { getDoc: () => store.doc, getLevel: () => store.levelDoc, mode: 'wiring' });
  let visible = false;
  let selectedWire = null;
  let fit = true;
  const level = () => store.levelDoc;

  function setHint() {
    hint.textContent = map.state.wireFrom
      ? 'Now click the part it should switch. Esc or a click on empty floor cancels.'
      : 'Click a part that senses something, then the part it should switch. Click a wire to select it; Delete removes it.';
  }

  function addWire(from, to) {
    const lv = level();
    if (from === to) return;
    const a = lv.parts.find((p) => p.id === from);
    const b = lv.parts.find((p) => p.id === to);
    if (!a || !b) return;
    if (!canSend(a)) return toast(`${PART[a.type].label} does not send a signal.`);
    if (!canReceive(b)) return toast(`${PART[b.type].label} does not take a signal. Pick a door, a doer, a logic part or a lamp.`);
    if (lv.wires.some((w) => w.from === from && w.to === to)) return toast('Those two are already wired.');
    if (lv.wires.length >= LIMITS.wires) return toast(`A level holds ${LIMITS.wires} wires at most.`);
    store.change((doc, l) => l.wires.push({ from, to }));
    selectedWire = { from, to };
    toast(`When ${senderPhrase(lv, store.doc, a)}, ${receiverPhrase(lv, store.doc, b)}.`, 4000);
  }
  function removeWire(w) {
    store.change((doc, l) => {
      l.wires = l.wires.filter((x) => !(x.from === w.from && x.to === w.to));
    });
    selectedWire = null;
  }

  // Click a sender, then a receiver; or drag from one to the other.
  let down = null;
  mapCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mapCanvas.focus();
    const at = map.toWorld(e.clientX, e.clientY);
    const part = map.partAt(at.x, at.y, (p) => (map.state.wireFrom ? canReceive(p) || canSend(p) : canSend(p) || canReceive(p)));
    if (map.state.wireFrom) {
      if (part && part.id !== map.state.wireFrom) {
        if (canReceive(part)) {
          addWire(map.state.wireFrom, part.id);
          map.state.wireFrom = null;
        } else if (canSend(part)) map.state.wireFrom = part.id;
      } else map.state.wireFrom = null;
      store.select(map.state.wireFrom);
      setHint();
      map.draw();
      return;
    }
    if (part && canSend(part)) {
      map.state.wireFrom = part.id;
      down = { id: part.id, x: e.clientX, y: e.clientY };
      store.select(part.id);
      selectedWire = null;
    } else if (part) {
      store.select(part.id);
      selectedWire = null;
    } else {
      const w = map.wireAt(at.x, at.y);
      selectedWire = w ? { from: w.from, to: w.to } : null;
      store.select(null);
    }
    map.state.selectedWire = selectedWire;
    setHint();
    renderRight();
    map.draw();
  });
  mapCanvas.addEventListener('pointermove', (e) => {
    map.state.hover = map.toWorld(e.clientX, e.clientY);
    if (map.state.wireFrom) map.draw();
  });
  mapCanvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved < 6) return; // a click: wait for the second click
    const at = map.toWorld(e.clientX, e.clientY);
    const part = map.partAt(at.x, at.y, canReceive);
    if (part && map.state.wireFrom) addWire(map.state.wireFrom, part.id);
    map.state.wireFrom = null;
    setHint();
    map.draw();
  });
  window.addEventListener('keydown', (e) => {
    if (!visible || e.target.closest('input, textarea, select') || document.getElementById('dialog').open) return;
    if (e.key === 'Escape') {
      map.state.wireFrom = null;
      setHint();
      map.draw();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWire) {
      e.preventDefault();
      removeWire(selectedWire);
    }
  });

  // Machine parts without a body (logic, sounds, messages, Win) can be added
  // here; they sit at the edge of the map.
  function addMachinePart(type) {
    const lv = level();
    const id = store.newPartId(type);
    const taken = lv.parts.filter((p) => PART[p.type].shape === 'none').length;
    const x = 0.5 + (taken % lv.size[0]);
    const y = 0.5 + Math.floor(taken / lv.size[0]);
    store.change((doc, l) => l.parts.push({ id, type, x, y, z: 0, turn: 0, size: [...PART[type].size], color: PART[type].color, props: {} }));
    store.select(id);
    map.state.highlight = new Set([id]);
    toast(`${PART[type].label} added at the top left of the map. Drag it anywhere in Build.`);
  }

  function renderLeft() {
    const lv = level();
    const group = (title, list) =>
      list.length
        ? [h('h3', {}, title), h('div', { class: 'list' }, list.map((p) => h('button', {
            class: `item ${p.id === store.selected ? 'on' : ''}`,
            onclick: () => { store.select(p.id); map.state.highlight = new Set([p.id]); map.draw(); },
          }, h('span', { class: 'tag' }, PART[p.type].icon), partName(lv, p))))]
        : [];
    const senders = lv.parts.filter((p) => canSend(p) && !canReceive(p));
    const logic = lv.parts.filter((p) => canSend(p) && canReceive(p));
    const doers = lv.parts.filter((p) => canReceive(p) && !canSend(p));
    fill(left, 
      h('h2', {}, 'Machine parts'),
      ...group('Sense something', senders),
      ...group('Shape the signal', logic),
      ...group('Do something', doers),
      senders.length + logic.length + doers.length ? null : h('p', { class: 'help' }, 'No machine parts yet. Add buttons, plates, doors and so on in Build, or add the ones below.'),
      h('h3', {}, 'Add'),
      h('div', { class: 'parts' },
        PARTS.filter((p) => p.shape === 'none').map((p) => h('button', { class: 'part-btn', title: p.help, 'data-part': p.type, onclick: () => addMachinePart(p.type) }, h('span', { class: 'icon' }, p.icon), p.label))),
    );
  }

  function renderRight() {
    const lv = level();
    const doc = store.doc;
    const byId = new Map(lv.parts.map((p) => [p.id, p]));
    const rows = lv.wires.map((w) => {
      const a = byId.get(w.from);
      const b = byId.get(w.to);
      const on = selectedWire && selectedWire.from === w.from && selectedWire.to === w.to;
      return h('div', { class: `wire-row ${on ? 'on' : ''}` },
        h('p', { onclick: () => { selectedWire = { ...w }; map.state.selectedWire = selectedWire; renderRight(); map.draw(); } },
          `When ${senderPhrase(lv, doc, a)}, ${receiverPhrase(lv, doc, b)}.`),
        h('button', { title: 'Remove this wire', 'aria-label': 'Remove this wire', onclick: () => removeWire(w) }, '×'));
    });
    const part = byId.get(store.selected);
    fill(right, 
      h('h2', {}, 'Wires'),
      rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'help' }, 'No wires yet.'),
      part ? h('div', {},
        h('h3', {}, partName(lv, part)),
        h('p', { class: 'help' }, PART[part.type].help),
        h('div', { class: 'buttons' }, h('button', { onclick: () => switchTo('build') }, 'Change its settings in Build'))) : null,
      h('h3', {}, 'How signals move'),
      h('p', { class: 'help' }, 'A sense part is on while its thing is happening. Logic parts shape that: And needs every wire in, Or any, Not none. Doers act when their signal turns on; a door stays open while its signal is on unless it is set to stay open.'),
    );
  }

  function renderToolbar() {
    fill(toolbar, 
      h('select', { 'aria-label': 'Level', onchange: (e) => store.setLevel(Number(e.target.value)) },
        store.doc.levels.map((l, i) => h('option', { value: i, selected: i === store.level }, `${i + 1}. ${l.name}`))),
      h('button', { onclick: () => map.fit() }, 'Fit'),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted small' }, `${level().wires.length} wires`),
      h('button', { class: 'primary', onclick: () => switchTo('play', { level: store.level }) }, 'Play this level'),
    );
  }

  store.on((what) => {
    if (what === 'screen' || what === 'won') return; // nothing changed in the world
    if (what === 'world' || what === 'level') fit = true;
    if (!visible) return;
    if (what === 'level' || what === 'world') {
      map.fit();
      fit = false;
    }
    map.state.selected = store.selected;
    if (selectedWire && !level().wires.some((w) => w.from === selectedWire.from && w.to === selectedWire.to)) selectedWire = null;
    map.state.selectedWire = selectedWire;
    renderLeft();
    renderRight();
    renderToolbar();
    map.draw();
  });

  return {
    show() {
      visible = true;
      map.state.selected = store.selected;
      map.state.highlight = new Set();
      renderLeft();
      renderRight();
      renderToolbar();
      setHint();
      requestAnimationFrame(() => {
        map.resize();
        if (fit) {
          map.fit();
          fit = false;
        }
      });
    },
    hide() {
      visible = false;
      map.state.wireFrom = null;
    },
    map,
  };
}
