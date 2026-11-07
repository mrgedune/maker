// Build: paint blocks, place parts from the bucket, change their settings.

import { CATEGORIES, PARTS, PART, LIMITS } from '../kit/catalog.js';
import { levelStats, newLevel, MUSIC } from '../kit/format.js';
import { h, settingField, toast, fill } from './dom.js';
import { createMap } from './map.js';
import { partName } from '../app.js';

const SNAPS = [
  ['cell', 'Snap to cell centres'],
  ['half', 'Snap to half cells'],
  ['quarter', 'Snap to quarter cells'],
];
const BLOCK_SHAPES = [
  { label: 'Wall', bottom: 0, top: 3 },
  { label: 'Low wall', bottom: 0, top: 1 },
  { label: 'Step', bottom: 0, top: 0.5 },
  { label: 'Tall wall', bottom: 0, top: 6 },
  { label: 'Platform', bottom: 2, top: 2.5 },
  { label: 'Ceiling', bottom: 3, top: 3.5 },
];

export function mount(el, { store, switchTo }) {
  const bucket = h('aside', { class: 'side', 'aria-label': 'Parts' });
  const toolbar = h('div', { class: 'toolbar' });
  const mapCanvas = h('canvas', { 'aria-label': 'Level map', tabindex: 0 });
  const viewCanvas = h('canvas', { 'aria-label': '3D view', hidden: true, tabindex: 0 });
  const hint = h('div', { class: 'hint' });
  const stage = h('div', { class: 'stage' }, mapCanvas, viewCanvas, hint);
  const inspector = h('aside', { class: 'side right', 'aria-label': 'Settings' });
  // Where the pointer is on the map, in cells.
  const where = h('span', { class: 'muted small where', 'aria-live': 'off' });
  el.append(bucket, h('div', { class: 'center' }, toolbar, stage), inspector);

  const map = createMap(mapCanvas, { getDoc: () => store.doc, getLevel: () => store.levelDoc, mode: 'build' });
  map.state.cellHover = true;
  const tool = { kind: 'select', type: null, material: 'stone', bottom: 0, top: 3, stack: false, turn: 0, snap: 'cell' };
  let category = 'blocks';
  let view3d = null;
  let mode = 'map';
  let visible = false;
  let firstShow = true;

  // ---------------------------------------------------------------- helpers

  const level = () => store.levelDoc;
  const snap = (v) => {
    if (tool.snap === 'cell') return Math.floor(v) + 0.5;
    const step = tool.snap === 'half' ? 0.5 : 0.25;
    return Math.round(v / step) * step;
  };
  const inLevel = (x, y) => x >= 0 && y >= 0 && x < level().size[0] && y < level().size[1];
  function columnTop(x, y) {
    let top = 0;
    for (const [bx, by, , , t] of level().blocks) if (bx === Math.floor(x) && by === Math.floor(y)) top = Math.max(top, t);
    return top;
  }
  function setHint() {
    const t = tool.kind;
    hint.textContent =
      mode === '3d'
        ? 'Drag to look round. Wheel to move closer. W A S D to move. The map is where you build.'
        : t === 'paint'
          ? 'Drag to paint blocks. Shift + drag fills a rectangle. Alt + click picks up a block. Right click erases.'
          : t === 'erase'
            ? 'Drag to erase blocks. Shift + drag erases a rectangle.'
            : t === 'place'
              ? `Click to place a ${PART[tool.type].label.toLowerCase()}. R turns it. Esc stops placing.`
              : 'Click a part to select it, drag to move it. R turns it, Delete removes it. Wheel zooms, right drag pans.';
  }

  // ---------------------------------------------------------------- bucket

  function renderBucket() {
    const cats = h('div', { class: 'cats', role: 'tablist' },
      CATEGORIES.map((c) => h('button', { role: 'tab', 'aria-selected': String(c.id === category), class: c.id === category ? 'on' : '', onclick: () => { category = c.id; renderBucket(); } }, c.label)));
    const cat = CATEGORIES.find((c) => c.id === category);
    const body = [];
    if (category === 'blocks') {
      body.push(
        h('div', { class: 'buttons' },
          h('button', { class: tool.kind === 'paint' ? 'on' : '', onclick: () => setTool('paint') }, 'Paint'),
          h('button', { class: tool.kind === 'erase' ? 'on' : '', onclick: () => setTool('erase') }, 'Erase'),
          h('button', { class: tool.kind === 'select' ? 'on' : '', onclick: () => setTool('select') }, 'Select')),
        h('h3', {}, 'Material'),
        h('div', { class: 'mats' },
          store.doc.materials.map((m) =>
            h('button', {
              class: `mat-btn ${tool.material === m.id && tool.kind === 'paint' ? 'on' : ''}`,
              title: m.name,
              onclick: () => { tool.material = m.id; setTool('paint'); },
            }, h('span', { class: 'swatch', style: { background: m.color } }, m.glyph), m.name))),
        h('h3', {}, 'Shape'),
        h('div', { class: 'buttons' },
          BLOCK_SHAPES.map((s) => h('button', {
            class: tool.bottom === s.bottom && tool.top === s.top ? 'on' : '',
            onclick: () => { tool.bottom = s.bottom; tool.top = s.top; if (tool.kind !== 'paint') setTool('paint'); else renderBucket(); },
          }, s.label))),
        h('div', { class: 'field' },
          h('span', {}, 'From height to height (cells)'),
          h('div', { class: 'row' },
            h('input', { type: 'number', 'aria-label': 'Bottom', min: 0, max: LIMITS.height, step: 0.25, value: tool.bottom, onchange: (e) => { tool.bottom = Math.max(0, Number(e.target.value) || 0); renderBucket(); } }),
            h('span', {}, 'to'),
            h('input', { type: 'number', 'aria-label': 'Top', min: 0.25, max: LIMITS.height, step: 0.25, value: tool.top, onchange: (e) => { tool.top = Math.max(0.25, Number(e.target.value) || 1); renderBucket(); } }))),
        h('label', { class: 'field check' },
          h('input', { type: 'checkbox', checked: tool.stack, onchange: (e) => { tool.stack = e.target.checked; } }),
          h('span', {}, 'Stack on what is there (bridges, floors above)')),
        h('p', { class: 'help' }, 'A wall is 0 to 3. A platform starts above the floor, so things can go under it. One material per column.'),
        h('button', { onclick: () => materialsDialog() }, 'Change materials…'),
      );
    } else {
      body.push(h('p', { class: 'cat-help' }, cat.help));
      body.push(h('div', { class: 'parts' },
        PARTS.filter((p) => p.category === category).map((p) =>
          h('button', {
            class: `part-btn ${tool.kind === 'place' && tool.type === p.type ? 'on' : ''}`,
            title: p.help,
            'data-part': p.type,
            onclick: () => { tool.type = p.type; tool.turn = 0; setTool('place'); },
          }, h('span', { class: 'icon' }, p.icon), p.label))));
      if (tool.kind === 'place') body.push(h('p', { class: 'help' }, PART[tool.type].help));
      if (category === 'characters') body.push(h('div', { class: 'buttons' }, h('button', { onclick: () => switchTo('characters') }, 'Make or change characters…')));
    }
    fill(bucket, h('h2', {}, 'Parts'), cats, h('div', {}, body));
  }

  function setTool(kind) {
    tool.kind = kind;
    map.state.ghost = null;
    map.state.cellHover = kind === 'paint' || kind === 'erase';
    renderBucket();
    setHint();
    map.draw();
  }

  // ---------------------------------------------------------------- block edits

  function paintCell(cx, cy, erase) {
    if (!inLevel(cx, cy)) return false;
    const lv = level();
    const here = lv.blocks.filter((b) => b[0] === cx && b[1] === cy);
    if (erase) {
      if (!here.length) return false;
      lv.blocks = lv.blocks.filter((b) => !(b[0] === cx && b[1] === cy));
      return true;
    }
    const b = Math.min(tool.bottom, tool.top - 0.25);
    const t = Math.max(tool.top, b + 0.25);
    if (tool.stack && here.length) {
      if (here.some((s) => s[3] === b && s[4] === t)) return false;
      const m = here[0][2];
      lv.blocks.push([cx, cy, m, b, t]);
      return true;
    }
    if (here.length === 1 && here[0][2] === tool.material && here[0][3] === b && here[0][4] === t) return false;
    lv.blocks = lv.blocks.filter((s) => !(s[0] === cx && s[1] === cy));
    lv.blocks.push([cx, cy, tool.material, b, t]);
    return true;
  }

  function fillRect(r, erase) {
    const x0 = Math.max(0, Math.min(r.x0, r.x1));
    const x1 = Math.min(level().size[0] - 1, Math.max(r.x0, r.x1));
    const y0 = Math.max(0, Math.min(r.y0, r.y1));
    const y1 = Math.min(level().size[1] - 1, Math.max(r.y0, r.y1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paintCell(x, y, erase);
  }

  function pick(cx, cy) {
    const here = level().blocks.filter((b) => b[0] === cx && b[1] === cy);
    if (!here.length) return;
    const top = here.reduce((a, b) => (b[4] > a[4] ? b : a));
    tool.material = top[2];
    tool.bottom = top[3];
    tool.top = top[4];
    renderBucket();
    toast(`Picked ${store.doc.materials.find((m) => m.id === top[2])?.name ?? top[2]}, ${top[3]} to ${top[4]}.`);
  }

  // ---------------------------------------------------------------- parts

  function placePart(x, y) {
    const def = PART[tool.type];
    const lv = level();
    if (!inLevel(x, y)) return;
    if (lv.parts.length >= LIMITS.parts) {
      toast(`A level holds ${LIMITS.parts} parts at most.`);
      return;
    }
    if ((def.kind === 'toy' || def.kind === 'seesaw') && levelStats(lv).toys >= LIMITS.toys) {
      toast(`A level holds ${LIMITS.toys} physics toys at most, so co-op stays in step.`);
      return;
    }
    if (tool.type === 'start' && lv.parts.filter((p) => p.type === 'start').length >= 4) toast('Four starts are enough for four players; more are used in turn.');
    const id = store.newPartId(tool.type);
    const props = {};
    const creatures = store.doc.characters.filter((c) => c.role !== 'player');
    if (tool.type === 'creature' || tool.type === 'spawner') props.character = creatures[0]?.id ?? '';
    const z = def.shape === 'none' ? 0 : columnTop(x, y);
    store.change(() => {
      lv.parts.push({ id, type: tool.type, x, y, z, turn: tool.turn, size: [...def.size], color: def.color, props });
    });
    store.select(id);
  }

  function deleteSelected() {
    const id = store.selected;
    if (!id) return;
    store.change((doc, lv) => {
      lv.parts = lv.parts.filter((p) => p.id !== id);
      lv.wires = lv.wires.filter((w) => w.from !== id && w.to !== id);
      for (const p of lv.parts) if (p.type === 'down' && p.props.which === id) p.props.which = 'all';
    });
    store.select(null);
  }

  function duplicateSelected() {
    const part = level().parts.find((p) => p.id === store.selected);
    if (!part) return;
    const id = store.newPartId(part.type);
    const step = tool.snap === 'quarter' ? 0.25 : tool.snap === 'half' ? 0.5 : 1;
    store.change((doc, lv) => {
      lv.parts.push({ ...JSON.parse(JSON.stringify(part)), id, x: Math.min(lv.size[0] - 0.5, part.x + step), y: part.y });
    });
    store.select(id);
  }

  function turnSelected(by) {
    const part = level().parts.find((p) => p.id === store.selected);
    if (!part) return;
    store.change((doc, lv) => {
      const p = lv.parts.find((q) => q.id === part.id);
      p.turn = (((p.turn + by) % 360) + 360) % 360;
    });
  }

  // ---------------------------------------------------------------- pointer

  let drag = null;
  mapCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mapCanvas.focus();
    const at = map.toWorld(e.clientX, e.clientY);
    const cx = Math.floor(at.x);
    const cy = Math.floor(at.y);
    if (tool.kind === 'paint' || tool.kind === 'erase') {
      const erase = tool.kind === 'erase';
      if (e.altKey && !erase) {
        pick(cx, cy);
        return;
      }
      store.begin();
      if (e.shiftKey) {
        drag = { kind: 'rect', erase };
        map.state.rect = { x0: cx, y0: cy, x1: cx, y1: cy, erase };
      } else {
        drag = { kind: 'brush', erase, last: `${cx},${cy}` };
        paintCell(cx, cy, erase);
      }
      mapCanvas.setPointerCapture(e.pointerId);
      map.draw();
      return;
    }
    if (tool.kind === 'place') {
      placePart(snap(at.x), snap(at.y));
      return;
    }
    const part = map.partAt(at.x, at.y);
    store.select(part ? part.id : null);
    if (part) {
      drag = { kind: 'move', id: part.id, dx: part.x - at.x, dy: part.y - at.y, moved: false };
      mapCanvas.setPointerCapture(e.pointerId);
    }
  });
  mapCanvas.addEventListener('pointermove', (e) => {
    const at = map.toWorld(e.clientX, e.clientY);
    map.state.hover = at;
    const [w, d] = level().size;
    where.textContent = at.x >= 0 && at.y >= 0 && at.x < w && at.y < d ? `x ${at.x.toFixed(1)}, y ${at.y.toFixed(1)}` : '';
    if (tool.kind === 'place') map.state.ghost = { type: tool.type, x: snap(at.x), y: snap(at.y), turn: tool.turn, size: PART[tool.type].size };
    if (drag?.kind === 'brush') {
      const key = `${Math.floor(at.x)},${Math.floor(at.y)}`;
      if (key !== drag.last) {
        drag.last = key;
        paintCell(Math.floor(at.x), Math.floor(at.y), drag.erase);
      }
    } else if (drag?.kind === 'rect') {
      map.state.rect.x1 = Math.floor(at.x);
      map.state.rect.y1 = Math.floor(at.y);
    } else if (drag?.kind === 'move') {
      const part = level().parts.find((p) => p.id === drag.id);
      const x = Math.max(0, Math.min(level().size[0], snap(at.x + drag.dx)));
      const y = Math.max(0, Math.min(level().size[1], snap(at.y + drag.dy)));
      if (part && (x !== part.x || y !== part.y)) {
        if (!drag.moved) store.begin();
        drag.moved = true;
        part.x = x;
        part.y = y;
        if (PART[part.type].shape !== 'none') part.z = columnTop(x, y);
      }
    }
    map.draw();
  });
  mapCanvas.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.kind === 'rect') {
      fillRect(map.state.rect, drag.erase);
      map.state.rect = null;
    }
    const wasMove = drag.kind === 'move' && !drag.moved;
    drag = null;
    if (!wasMove) store.commit();
  });
  mapCanvas.addEventListener('pointerleave', () => {
    map.state.hover = null;
    where.textContent = '';
    map.state.ghost = null;
    map.draw();
  });
  mapCanvas.addEventListener('mapcontext', (e) => {
    const at = map.toWorld(e.detail.clientX, e.detail.clientY);
    if (tool.kind === 'paint' || tool.kind === 'erase') {
      store.begin();
      paintCell(Math.floor(at.x), Math.floor(at.y), true);
      store.commit();
    } else if (tool.kind === 'place') setTool('select');
  });

  function onKey(e) {
    if (!visible || e.target.closest('input, textarea, select') || document.getElementById('dialog').open) return;
    const k = e.key;
    if (k === 'Escape') {
      if (tool.kind !== 'select') setTool('select');
      else store.select(null);
    } else if ((k === 'Delete' || k === 'Backspace') && store.selected) {
      e.preventDefault();
      deleteSelected();
    } else if (k.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
      const by = e.shiftKey ? 15 : 90;
      if (tool.kind === 'place') {
        tool.turn = (tool.turn + by) % 360;
        if (map.state.ghost) map.state.ghost.turn = tool.turn;
        map.draw();
      } else turnSelected(by);
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected();
    } else if (store.selected && k.startsWith('Arrow')) {
      e.preventDefault();
      const step = tool.snap === 'quarter' ? 0.25 : tool.snap === 'half' ? 0.5 : 1;
      store.change((doc, lv) => {
        const p = lv.parts.find((q) => q.id === store.selected);
        if (!p) return;
        if (k === 'ArrowLeft') p.x -= step;
        if (k === 'ArrowRight') p.x += step;
        if (k === 'ArrowUp') p.y -= step;
        if (k === 'ArrowDown') p.y += step;
      });
    } else if (k === 'b' || k === 'B') setTool('paint');
    else if (k === 'e' || k === 'E') setTool('erase');
    else if (k === 'v' || k === 'V') setTool('select');
  }
  window.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------- toolbar

  function renderToolbar() {
    const doc = store.doc;
    const stats = levelStats(level());
    fill(toolbar, 
      h('label', {}, h('span', { class: 'sr' }, 'Level'),
        h('select', { 'aria-label': 'Level', onchange: (e) => store.setLevel(Number(e.target.value)) },
          doc.levels.map((l, i) => h('option', { value: i, selected: i === store.level }, `${i + 1}. ${l.name}`)))),
      h('div', { class: 'sep' }),
      h('button', { 'aria-pressed': String(mode === 'map'), onclick: () => setMode('map') }, 'Map'),
      h('button', { 'aria-pressed': String(mode === '3d'), onclick: () => setMode('3d') }, '3D look'),
      h('div', { class: 'sep' }),
      h('select', { 'aria-label': 'Snap', onchange: (e) => { tool.snap = e.target.value; } },
        SNAPS.map(([v, label]) => h('option', { value: v, selected: v === tool.snap }, label))),
      h('button', { onclick: () => map.fit(), title: 'Show the whole level' }, 'Fit'),
      h('div', { class: 'grow' }),
      mode === 'map' ? where : null,
      h('span', { class: 'muted small stats', title: `${stats.parts} parts · ${stats.toys}/${LIMITS.toys} toys · ${stats.wires} wires` }, `${stats.parts} parts · ${stats.toys}/${LIMITS.toys} toys · ${stats.wires} wires`),
      h('button', { class: 'primary', onclick: () => switchTo('play', { level: store.level }) }, 'Play this level'),
    );
  }

  // ---------------------------------------------------------------- inspector

  function selectOptions(spec, part) {
    const creatures = store.doc.characters.filter((c) => c.role !== 'player').map((c) => [c.id, c.name]);
    if (spec.key === 'character') return creatures.length ? creatures : [['', 'No creatures yet']];
    if (part.type === 'down' && spec.key === 'which') {
      const lv = level();
      return [['all', 'All creatures in the level'], ...lv.parts.filter((p) => p.type === 'creature').map((p) => [p.id, partName(lv, p)])];
    }
    return spec.options;
  }

  function renderInspector() {
    const lv = level();
    const part = lv.parts.find((p) => p.id === store.selected);
    if (!part) {
      renderLevelSettings();
      return;
    }
    const def = PART[part.type];
    const set = (fn) => store.change((doc, l) => fn(l.parts.find((p) => p.id === part.id)));
    const num = (label, key, step, idx) => h('label', {}, label,
      h('input', {
        type: 'number', step, value: idx === undefined ? part[key] : part[key][idx],
        onchange: (e) => set((p) => { const v = Number(e.target.value); if (!Number.isFinite(v)) return; if (idx === undefined) p[key] = v; else p[key][idx] = v; }),
      }));
    const fields = [];
    fields.push(h('h2', {}, partName(lv, part)), h('p', { class: 'help' }, def.help));
    fields.push(h('div', { class: 'field' }, h('span', {}, 'Where (x, y, height)'), h('div', { class: 'xyz' }, num('x', 'x', 0.125), num('y', 'y', 0.125), num('height', 'z', 0.125))));
    if (def.shape !== 'none') {
      fields.push(h('div', { class: 'field inline' }, h('span', {}, 'Turn (degrees)'),
        h('div', { class: 'row' },
          h('input', { type: 'number', step: 15, value: part.turn, 'aria-label': 'Turn', onchange: (e) => set((p) => { p.turn = Number(e.target.value) || 0; }) }),
          h('button', { title: 'Turn 90 degrees (R)', onclick: () => turnSelected(90) }, '↻'))));
    }
    if (def.shape !== 'none' && part.type !== 'creature' && part.type !== 'start') {
      fields.push(h('div', { class: 'field' }, h('span', {}, 'Size (across, deep, tall)'), h('div', { class: 'xyz' }, num('across', 'size', 0.05, 0), num('deep', 'size', 0.05, 1), num('tall', 'size', 0.05, 2))));
      fields.push(h('label', { class: 'field inline' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: part.color, onchange: (e) => set((p) => { p.color = e.target.value; }) })));
    }
    for (const spec of def.props) {
      fields.push(settingField(spec, part.props[spec.key], (v, done = true) => { if (done) set((p) => { p.props[spec.key] = v; }); }, { options: spec.type === 'select' ? selectOptions(spec, part) : undefined }));
    }
    if (part.type === 'creature') {
      const ch = store.doc.characters.find((c) => c.id === part.props.character);
      fields.push(h('div', { class: 'buttons' }, h('button', { onclick: () => switchTo('characters', { character: ch?.id }) }, ch ? `Change ${ch.name}…` : 'Make a creature…')));
    }
    if (def.in || def.out || part.type === 'creature') {
      const ins = lv.wires.filter((w) => w.to === part.id).length;
      const outs = lv.wires.filter((w) => w.from === part.id).length;
      fields.push(h('p', { class: 'help' }, `Wires: ${ins} in, ${outs} out. `, h('a', { href: '#wiring', onclick: (e) => { e.preventDefault(); switchTo('wiring'); } }, 'Wire it up')));
    }
    fields.push(h('div', { class: 'buttons' },
      h('button', { onclick: duplicateSelected, title: 'Ctrl+D' }, 'Duplicate'),
      h('button', { class: 'danger', onclick: deleteSelected, title: 'Delete' }, 'Delete')));
    const scroll = inspector.scrollTop;
    fill(inspector, ...fields);
    inspector.scrollTop = scroll;
  }

  function renderLevelSettings() {
    const lv = level();
    const doc = store.doc;
    const set = (fn) => store.change((d, l) => fn(l, d));
    const wIn = h('input', { type: 'number', min: 4, max: LIMITS.size, value: lv.size[0], 'aria-label': 'Width' });
    const hIn = h('input', { type: 'number', min: 4, max: LIMITS.size, value: lv.size[1], 'aria-label': 'Depth' });
    const items = [
      h('h2', {}, 'Level'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { value: lv.name, maxlength: 40, onchange: (e) => set((l) => { l.name = e.target.value.trim() || l.name; }) })),
      h('div', { class: 'field' }, h('span', {}, 'Size in cells (across, deep)'),
        h('div', { class: 'row' }, wIn, hIn, h('button', {
          onclick: () => set((l) => {
            l.size = [Number(wIn.value), Number(hIn.value)];
            l.blocks = l.blocks.filter(([x, y]) => x < l.size[0] && y < l.size[1]);
          }),
        }, 'Apply'))),
      settingField({ type: 'check', label: 'Open sky (no ceiling)' }, lv.sky, (v) => set((l) => { l.sky = v; })),
      settingField({ type: 'range', label: 'Daylight', min: 0, max: 10, step: 1 }, lv.light, (v, done = true) => { if (done) set((l) => { l.light = v; }); }),
      settingField({ type: 'select', label: 'Floor' }, lv.floor, (v) => set((l) => { l.floor = v; }), { options: doc.materials.map((m) => [m.id, m.name]) }),
      settingField({ type: 'select', label: 'Music' }, lv.music, (v) => set((l) => { l.music = v; }), { options: MUSIC }),
      h('h3', {}, 'Levels'),
      h('div', { class: 'list' },
        doc.levels.map((l, i) => h('button', { class: `item ${i === store.level ? 'on' : ''}`, onclick: () => store.setLevel(i) }, `${i + 1}. ${l.name}`))),
      h('div', { class: 'buttons' },
        h('button', { disabled: doc.levels.length >= LIMITS.levels, onclick: () => addLevel(false) }, 'Add level'),
        h('button', { disabled: doc.levels.length >= LIMITS.levels, onclick: () => addLevel(true) }, 'Copy this level'),
        h('button', { disabled: store.level === 0, onclick: () => moveLevel(-1) }, 'Move up'),
        h('button', { disabled: store.level >= doc.levels.length - 1, onclick: () => moveLevel(1) }, 'Move down'),
        h('button', { class: 'danger', disabled: doc.levels.length < 2, onclick: deleteLevel }, 'Delete level')),
      h('p', { class: 'help' }, 'Players play the levels in this order. Reaching an exit, or a Win part, goes on to the next one; the last one wins the game.'),
    ];
    fill(inspector, ...items);
  }

  function addLevel(copy) {
    const doc = store.doc;
    const ids = new Set(doc.levels.map((l) => l.id));
    let n = doc.levels.length + 1;
    while (ids.has(`l${n}`)) n++;
    store.change((d) => {
      const lv = copy ? { ...JSON.parse(JSON.stringify(level())), id: `l${n}`, name: `${level().name} copy` } : newLevel(`l${n}`, `Level ${d.levels.length + 1}`);
      if (!copy) {
        const [W, H] = lv.size;
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (x === 0 || y === 0 || x === W - 1 || y === H - 1) lv.blocks.push([x, y, 'brick', 0, 2]);
        lv.parts.push({ id: 'start1', type: 'start', x: 4.5, y: H / 2, z: 0, turn: 0, props: {} });
      }
      d.levels.splice(store.level + 1, 0, lv);
    });
    store.setLevel(store.level + 1);
  }
  function moveLevel(dir) {
    const i = store.level;
    store.change((d) => {
      const [lv] = d.levels.splice(i, 1);
      d.levels.splice(i + dir, 0, lv);
    });
    store.setLevel(i + dir);
  }
  function deleteLevel() {
    if (!confirm(`Delete level "${level().name}"? Undo brings it back.`)) return;
    const i = store.level;
    store.change((d) => {
      d.levels.splice(i, 1);
    });
    store.setLevel(Math.max(0, i - 1));
  }

  // ---------------------------------------------------------------- materials

  async function materialsDialog() {
    const { openDialog, closeDialog } = await import('./dom.js');
    const rows = () => store.doc.materials.map((m) =>
      h('div', { class: 'field inline' },
        h('span', {}, h('input', { value: m.name, maxlength: 24, 'aria-label': 'Material name', onchange: (e) => store.change((d) => { d.materials.find((x) => x.id === m.id).name = e.target.value; }) })),
        h('div', { class: 'row' },
          h('input', { value: m.glyph, maxlength: 1, style: { width: '2.4em', textAlign: 'center' }, 'aria-label': 'Character', onchange: (e) => store.change((d) => { d.materials.find((x) => x.id === m.id).glyph = e.target.value || '█'; }) }),
          h('input', { type: 'color', value: m.color, 'aria-label': 'Colour', onchange: (e) => store.change((d) => { d.materials.find((x) => x.id === m.id).color = e.target.value; }) }),
          h('label', { class: 'small muted' }, h('input', { type: 'checkbox', checked: m.glow, onchange: (e) => store.change((d) => { d.materials.find((x) => x.id === m.id).glow = e.target.checked; }) }), ' glows'))));
    const box = h('div', { class: 'list' }, rows());
    openDialog(
      h('h2', {}, 'Materials'),
      h('p', { class: 'help' }, 'Each material is a colour and the character the engine draws it with.'),
      box,
      h('div', { class: 'buttons' },
        h('button', {
          disabled: store.doc.materials.length >= LIMITS.materials,
          onclick: () => {
            const ids = new Set(store.doc.materials.map((m) => m.id));
            let n = 1;
            while (ids.has(`mat${n}`)) n++;
            store.change((d) => { d.materials.push({ id: `mat${n}`, name: `Material ${n}`, glyph: '█', color: '#9aa3ae', glow: false }); });
            fill(box, ...rows());
          },
        }, 'Add material'),
        h('button', { class: 'primary', onclick: () => { closeDialog(); renderBucket(); } }, 'Done')),
    );
  }

  // ---------------------------------------------------------------- 3D look

  const cam = { x: 12, y: 12, z: 0, yaw: -0.8, pitch: 0.55, dist: 18 };
  let raf = 0;
  const keys = new Set();
  async function setMode(m) {
    mode = m;
    mapCanvas.hidden = m !== 'map';
    viewCanvas.hidden = m !== '3d';
    renderToolbar();
    setHint();
    if (m === '3d') {
      if (!view3d) {
        try {
          const { createView } = await import('../view/scene.js');
          view3d = createView(viewCanvas);
        } catch (err) {
          toast(`The 3D look could not start: ${err.message}`);
          setMode('map');
          return;
        }
      }
      const [w, hh] = level().size;
      cam.x = w / 2;
      cam.y = hh / 2;
      cam.dist = Math.max(w, hh) * 0.9;
      sync3d();
      loop3d();
    } else {
      cancelAnimationFrame(raf);
      map.resize();
    }
  }
  function sync3d() {
    if (!view3d) return;
    view3d.setWorld(store.doc);
    view3d.setLevel(level());
  }
  let entitiesFor = null;
  async function loop3d() {
    if (!entitiesFor) entitiesFor = (await import('../view/scene.js')).editEntities;
    cancelAnimationFrame(raf);
    const frame = (t) => {
      if (mode !== '3d' || !visible) return;
      const r = viewCanvas.getBoundingClientRect();
      if (r.width && (r.width !== view3d._w || r.height !== view3d._h)) {
        view3d._w = r.width;
        view3d._h = r.height;
        view3d.fit(r.width, r.height);
      }
      const speed = cam.dist * 0.02;
      const fx = Math.cos(cam.yaw);
      const fy = Math.sin(cam.yaw);
      if (keys.has('KeyW')) { cam.x += fx * speed; cam.y += fy * speed; }
      if (keys.has('KeyS')) { cam.x -= fx * speed; cam.y -= fy * speed; }
      if (keys.has('KeyA')) { cam.x += fy * speed; cam.y -= fx * speed; }
      if (keys.has('KeyD')) { cam.x -= fy * speed; cam.y += fx * speed; }
      const time = t / 1000;
      const eye = {
        x: cam.x - Math.cos(cam.yaw) * Math.cos(cam.pitch) * cam.dist,
        y: cam.y - Math.sin(cam.yaw) * Math.cos(cam.pitch) * cam.dist,
        z: Math.max(0.4, cam.z + Math.sin(cam.pitch) * cam.dist),
      };
      const { entities, lights } = entitiesFor(store.doc, level(), { time, selected: store.selected });
      try {
        view3d.render({ camera: { ...eye, yaw: cam.yaw, pitch: cam.pitch }, entities, lights, time, drawDistance: Math.max(60, cam.dist * 3) });
      } catch (err) {
        console.error(err);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  let orbit = null;
  viewCanvas.addEventListener('pointerdown', (e) => {
    orbit = { x: e.clientX, y: e.clientY };
    viewCanvas.setPointerCapture(e.pointerId);
    viewCanvas.focus();
  });
  viewCanvas.addEventListener('pointermove', (e) => {
    if (!orbit) return;
    cam.yaw += (e.clientX - orbit.x) * 0.006;
    cam.pitch = Math.max(0.05, Math.min(1.45, cam.pitch + (e.clientY - orbit.y) * 0.005));
    orbit = { x: e.clientX, y: e.clientY };
  });
  viewCanvas.addEventListener('pointerup', () => { orbit = null; });
  viewCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(3, Math.min(90, cam.dist * (e.deltaY < 0 ? 0.88 : 1.14)));
  }, { passive: false });
  viewCanvas.addEventListener('keydown', (e) => keys.add(e.code));
  viewCanvas.addEventListener('keyup', (e) => keys.delete(e.code));
  viewCanvas.addEventListener('blur', () => keys.clear());

  // ---------------------------------------------------------------- store

  store.on((what) => {
    if (what === 'world') {
      firstShow = true;
      if (!store.doc.materials.some((m) => m.id === tool.material)) tool.material = store.doc.materials[0].id;
    }
    if (!visible) return;
    if (what === 'level' || what === 'world') map.fit();
    map.state.selected = store.selected;
    renderToolbar();
    renderInspector();
    if (what !== 'select') renderBucket();
    if (what !== 'select' && mode === '3d') sync3d();
    map.draw();
  });

  renderBucket();
  setHint();

  return {
    show() {
      visible = true;
      map.state.selected = store.selected;
      renderToolbar();
      renderInspector();
      renderBucket();
      requestAnimationFrame(() => {
        map.resize();
        if (firstShow) {
          map.fit();
          firstShow = false;
        }
        if (mode === '3d') {
          sync3d();
          loop3d();
        }
      });
    },
    hide() {
      visible = false;
      cancelAnimationFrame(raf);
    },
    map,
    tool,
  };
}
