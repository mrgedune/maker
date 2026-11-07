// Characters: the player's look and the cast of creatures, how they look and
// how they fight.

import { HAIR, TOPS, HELD, GLOVES, BOOTS, PRESETS, MOVES, newCharacter, newLevel, normalize, newWorld } from '../kit/format.js';
import { PACKS, packOf, tuning, DEFAULT_PACK } from '../kit/fight.js';
import { LIMITS } from '../kit/catalog.js';
import { h, settingField, toast, fill } from './dom.js';

const SIDES = [
  ['Front', 0], ['Front right', 0.25], ['Right', 0.5], ['Back right', 0.75], ['Back', 1], ['Back left', 1.25], ['Left', 1.5], ['Front left', 1.75],
];
const POSES = [['stand', 'Stand'], ['walk', 'Walk'], ['tell', 'Wind-up'], ['strike', 'Strike'], ['stagger', 'Parried'], ['down', 'Down']];
const HAIR_NAMES = { short: 'Short', choppy: 'Choppy', slick: 'Slicked back', swept: 'Swept', long: 'Long', none: 'None' };
const TOP_NAMES = { jacket: 'Jacket', suit: 'Suit and tie', bodysuit: 'Bodysuit' };
const HELD_NAMES = { none: 'Nothing (fists)', sword: 'Sword', pistol: 'Pistol', chainsaw: 'Chainsaw' };
const GLOVE_NAMES = { none: 'None', short: 'Short', opera: 'Long' };
const BOOT_NAMES = { shoe: 'Shoes', thigh: 'Thigh boots' };
const MOVE_NAMES = { swing: 'Swing (close)', slam: 'Slam the ground (hits everyone near)', throw: 'Throw (from far)', charge: 'Charge (runs at you)' };
const COLOR_NAMES = { outfit: 'Outfit', trousers: 'Trousers', skin: 'Skin', hair: 'Hair', boots: 'Boots', gloves: 'Gloves' };
const SLIDERS = [
  ['health', 'Health', 'How much it takes to beat.'],
  ['tell', 'Wind-up', 'How long it shows a move coming before it hits. Longer is fairer.'],
  ['parry', 'Reel when parried', 'How long it staggers after a parry.'],
  ['speed', 'Speed', 'How fast it moves.'],
  ['damage', 'Damage', 'How hard it hits.'],
];

export function mount(el, { store, switchTo }) {
  const left = h('aside', { class: 'side', 'aria-label': 'Cast' });
  const toolbar = h('div', { class: 'toolbar' });
  const canvas = h('canvas', { 'aria-label': 'Character preview' });
  const stageNote = h('div', { class: 'hint' }, 'Drag to turn the character.');
  const right = h('aside', { class: 'side right', 'aria-label': 'Character settings' });
  el.append(left, h('div', { class: 'center' }, toolbar, h('div', { class: 'stage' }, canvas, stageNote)), right);
  let current = null; // character id
  let visible = false;
  let view = null;
  let raf = 0;
  const preview = { side: 0.12, pose: 'walk', spin: false };
  let previewDoc = null;

  const chars = () => store.doc.characters;
  const char = () => chars().find((c) => c.id === current) ?? chars()[0];

  function setChar(fn) {
    const id = char().id;
    store.change((doc) => fn(doc.characters.find((c) => c.id === id), doc));
  }

  function newCreature(preset = 'brawler') {
    if (chars().length >= LIMITS.characters) return toast(`A world holds ${LIMITS.characters} characters at most.`);
    const ids = new Set(chars().map((c) => c.id));
    let n = 1;
    while (ids.has(`c${n}`)) n++;
    const names = { brawler: 'Brawler', duel: 'Duellist', ambusher: 'Ambusher', boss: 'Boss' };
    const c = newCharacter(`c${n}`, `${names[preset]} ${n}`, 'creature', preset);
    store.change((doc) => doc.characters.push(c));
    current = c.id;
    render();
  }

  function deleteChar() {
    const c = char();
    if (c.role === 'player') return;
    const uses = store.doc.levels.flatMap((l) => l.parts.filter((p) => p.props?.character === c.id)).length;
    if (!confirm(uses ? `${c.name} is used by ${uses} part(s). They will use another creature. Delete ${c.name}?` : `Delete ${c.name}?`)) return;
    store.change((doc) => {
      doc.characters = doc.characters.filter((x) => x.id !== c.id);
      const other = doc.characters.find((x) => x.role !== 'player');
      for (const l of doc.levels) for (const p of l.parts) if (p.props?.character === c.id) p.props.character = other?.id ?? '';
    });
    current = null;
    render();
  }

  function renderLeft() {
    const list = chars();
    fill(left, 
      h('h2', {}, 'Cast'),
      h('div', { class: 'list' },
        list.map((c) => h('button', { class: `item ${c.id === char().id ? 'on' : ''}`, onclick: () => { current = c.id; render(); } },
          h('span', { class: 'swatch', style: { background: c.look.colors.outfit } }), c.name, c.role === 'player' ? h('span', { class: 'muted small' }, ' (players)') : null))),
      h('h3', {}, 'New creature'),
      h('div', { class: 'buttons' },
        PRESETS.map((p) => h('button', { onclick: () => newCreature(p) }, { brawler: 'Brawler', duel: 'Duellist', ambusher: 'Ambusher', boss: 'Boss' }[p]))),
      h('p', { class: 'help' }, 'Place creatures in a level from Build, under Characters. Every player in a world looks like the player look.'),
    );
  }

  function renderRight() {
    const c = char();
    const look = c.look;
    const opts = (arr, names) => arr.map((v) => [v, names[v] ?? v]);
    const items = [
      h('h2', {}, c.role === 'player' ? 'Player look' : c.name),
      settingField({ type: 'text', label: 'Name', max: 32 }, c.name, (v) => setChar((x) => { x.name = v.trim() || x.name; })),
      settingField({ type: 'range', label: 'Size', min: 0, max: 10 }, c.size, (v, done = true) => { if (done) setChar((x) => { x.size = v; }); }),
      h('h3', {}, 'Look'),
      settingField({ type: 'select', label: 'Hair' }, look.hair, (v) => setChar((x) => { x.look.hair = v; }), { options: opts(HAIR, HAIR_NAMES) }),
      settingField({ type: 'select', label: 'Top' }, look.top, (v) => setChar((x) => { x.look.top = v; }), { options: opts(TOPS, TOP_NAMES) }),
      settingField({ type: 'range', label: 'Long coat (0 none)', min: 0, max: 10 }, Math.round(look.coat * 10), (v, done = true) => { if (done) setChar((x) => { x.look.coat = v / 10; }); }),
      settingField({ type: 'select', label: 'Gloves' }, look.gloves, (v) => setChar((x) => { x.look.gloves = v; }), { options: opts(GLOVES, GLOVE_NAMES) }),
      settingField({ type: 'select', label: 'Boots' }, look.boots, (v) => setChar((x) => { x.look.boots = v; }), { options: opts(BOOTS, BOOT_NAMES) }),
      settingField({ type: 'select', label: c.role === 'player' ? 'Weapon (what players fight with)' : 'Holds' }, look.held, (v) => setChar((x) => { x.look.held = v; }), { options: opts(HELD, HELD_NAMES) }),
      settingField({ type: 'check', label: 'Devil face (dark, glowing eyes)' }, look.devil, (v) => setChar((x) => { x.look.devil = v; })),
      h('div', { class: 'field' }, h('span', {}, 'Colours'),
        h('div', { class: 'xyz' }, Object.keys(look.colors).map((k) => h('label', {}, COLOR_NAMES[k] ?? k,
          h('input', { type: 'color', value: look.colors[k], onchange: (e) => setChar((x) => { x.look.colors[k] = e.target.value; }) }))))),
    ];
    if (c.role !== 'player') {
      const f = c.fight;
      const pack = packOf(f);
      const base = pack.presets[f.preset];
      const t1 = tuning(c, 1);
      const t4 = tuning(c, 4);
      items.push(
        h('h3', {}, 'Fight'),
        settingField({ type: 'select', label: 'Kind' }, f.preset, (v) => setChar((x) => {
          const moves = { swing: true, slam: v === 'boss', throw: v === 'boss', charge: v === 'boss' || v === 'ambusher' };
          x.fight.preset = v;
          x.fight.moves = moves;
        }), { options: PRESETS.map((p) => [p, pack.presets[p].label]) }),
        h('p', { class: 'help' }, base.about),
        ...SLIDERS.map(([key, label, help]) => settingField({ type: 'range', label, min: 0, max: 10, help }, f[key], (v, done = true) => { if (done) setChar((x) => { x.fight[key] = v; }); })),
        h('div', { class: 'field' }, h('span', {}, 'Moves'),
          ...MOVES.map((m) => h('label', { class: 'field check' },
            h('input', { type: 'checkbox', checked: f.moves[m], onchange: (e) => setChar((x) => { x.fight.moves[m] = e.target.checked; }) }),
            h('span', {}, MOVE_NAMES[m])))),
        settingField({ type: 'check', label: 'Tougher with more players' }, f.tougher, (v) => setChar((x) => { x.fight.tougher = v; })),
        Object.keys(PACKS).length > 1
          ? settingField({ type: 'select', label: 'Fight tuning' }, f.pack ?? DEFAULT_PACK, (v) => setChar((x) => { x.fight.pack = v; }), { options: Object.entries(PACKS).map(([k, p]) => [k, p.name]) })
          : null,
        h('p', { class: 'help' },
          `Alone: ${t1.health} health, hits for ${t1.damage}, wind-up ${(t1.tell / 60).toFixed(2)} s, reels ${(t1.stagger / 60).toFixed(2)} s when parried. With four players: ${t4.health} health.`),
      );
      const used = store.doc.levels.flatMap((l, i) => l.parts.filter((p) => p.props?.character === c.id).map(() => i + 1));
      items.push(h('p', { class: 'help' }, used.length ? `In level ${[...new Set(used)].join(', ')}.` : 'Not placed in any level yet.'));
      items.push(h('div', { class: 'buttons' }, h('button', { class: 'danger', onclick: deleteChar }, 'Delete')));
    } else {
      items.push(h('p', { class: 'help' }, 'Players have 100 health. A parry (right mouse, just as a hit lands) makes a creature reel; holding it blocks most of a hit.'));
    }
    const scroll = right.scrollTop;
    fill(right, ...items);
    right.scrollTop = scroll;
  }

  function renderToolbar() {
    fill(toolbar, 
      h('span', { class: 'muted small' }, 'Pose'),
      POSES.map(([k, label]) => h('button', { 'aria-pressed': String(preview.pose === k), onclick: () => { preview.pose = k; renderToolbar(); } }, label)),
      h('div', { class: 'sep' }),
      h('span', { class: 'muted small' }, 'Side'),
      h('select', { 'aria-label': 'Side', onchange: (e) => { preview.side = Number(e.target.value); preview.spin = false; renderToolbar(); } },
        SIDES.map(([label, v]) => h('option', { value: v, selected: Math.abs(preview.side - v) < 0.01 }, label))),
      h('button', { 'aria-pressed': String(preview.spin), onclick: () => { preview.spin = !preview.spin; renderToolbar(); } }, 'Turn'),
    );
  }

  function render() {
    if (!visible) return;
    renderLeft();
    renderRight();
    renderToolbar();
    syncPreview();
  }

  // ---------------------------------------------------------------- preview

  async function syncPreview() {
    if (!view) {
      try {
        const mod = await import('../view/scene.js');
        view = { ...mod, v: mod.createView(canvas, { detail: 'fine' }) };
        const w = newWorld('preview');
        const lv = newLevel('p', 'p', 9, 9);
        lv.light = 7;
        lv.floor = 'stone';
        w.levels = [lv];
        previewDoc = normalize(w);
      } catch (err) {
        stageNote.textContent = `The preview could not start: ${err.message}`;
        return;
      }
    }
    view.v.setWorld({ ...previewDoc, characters: store.doc.characters });
    view.v.setLevel(previewDoc.levels[0]);
    if (visible) loop();
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX };
    canvas.setPointerCapture(e.pointerId);
    preview.spin = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    preview.side = (preview.side - (e.clientX - drag.x) * 0.004 + 4) % 2;
    drag.x = e.clientX;
  });
  canvas.addEventListener('pointerup', () => { drag = null; renderToolbar(); });

  function loop() {
    cancelAnimationFrame(raf);
    let last = performance.now();
    const frame = (t) => {
      if (!visible || !view) return;
      const dt = (t - last) / 1000;
      last = t;
      if (preview.spin) preview.side = (preview.side + dt * 0.15) % 2;
      const r = canvas.getBoundingClientRect();
      if (r.width && (r.width !== view.v._w || r.height !== view.v._h)) {
        view.v._w = r.width;
        view.v._h = r.height;
        view.v.fit(r.width, r.height);
      }
      const c = char();
      const scale = view.PLAYER_SCALE * (c.role === 'player' ? 1 : view.sizeScale(c));
      const time = t / 1000;
      const cycle = (time * 1.2) % 1;
      const anim = { move: preview.pose === 'walk' ? 1 : 0, phase: time * 8 };
      if (preview.pose === 'tell') anim.tell = Math.min(1, cycle * 1.4);
      if (preview.pose === 'strike') anim.strike = 1;
      if (preview.pose === 'stagger') anim.stagger = 1;
      if (preview.pose === 'down') anim.down = true;
      const fig = view.figureEntity(`preview:${c.id}`, c, 4.5, 4.5, 0, 0, scale, anim, 1);
      const angle = Math.PI * preview.side; // 0: we look at its front
      const height = 1.8 * scale / view.PLAYER_SCALE;
      const dist = 2.6 + height * 1.2;
      const eye = { x: 4.5 + Math.cos(angle) * dist, y: 4.5 + Math.sin(angle) * dist, z: height * 0.62 };
      try {
        view.v.render({
          camera: { ...eye, yaw: angle + Math.PI, pitch: 0.12, fov: Math.PI / 3.4 },
          entities: [fig],
          lights: [{ id: 'key', x: eye.x, y: eye.y, z: 3.5, color: '#fff4e6', range: 9, intensity: 0.9, active: true, volumetricInfluence: 0 }],
          time,
          drawDistance: 20,
        });
      } catch (err) {
        console.error(err);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  store.on((what) => {
    if (!visible) return;
    if (what === 'doc' || what === 'world') render();
  });

  return {
    show(opts) {
      visible = true;
      if (opts?.character) current = opts.character;
      render();
    },
    hide() {
      visible = false;
      cancelAnimationFrame(raf);
    },
  };
}
