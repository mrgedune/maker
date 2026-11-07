// Playing a world: the game stepped 60 times a second on the keyboard and
// mouse, drawn by the engine, with the HUD, sounds and the screens between
// levels. Alone it steps the game directly; in co-op a rollback session steps
// it (net/session.js) and this only hands it this machine's input.

import { createGame, PLAYER, TICK_HZ } from '../kit/game.js';
import { createView, playEntities } from '../view/scene.js';
import { createAudio } from './audio.js';
import { h, fill } from '../ui/dom.js';

const DT = 1 / TICK_HZ;
const SETTINGS_KEY = 'maker.settings';
export const DEFAULT_SETTINGS = { volume: 0.7, mouse: 5, invert: false, flashes: 'full', detail: 'medium' };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // kept for this visit only
  }
}

let rapierPromise = null;
export function loadRapier(base = new URL('../../vendor/rapier/rapier.mjs', import.meta.url)) {
  rapierPromise ??= import(base.href).then(async (m) => {
    await m.default.init();
    return m.default;
  });
  return rapierPromise;
}

// The same shape a co-op session has, for one player alone.
export function soloSession(game) {
  return {
    game,
    local: 0,
    host: true,
    over: null,
    joining: false,
    settle: () => [],
    blocked: () => null,
    advance: (input) => game.step([input]),
    pace: () => 1,
    behind: () => 0,
    flush() {},
    links: () => [],
  };
}

const TIPS = {
  tell: 'Right click just as a hit lands to parry. Hold it to block.',
  grab: 'Left click throws what you hold. E puts it down.',
  down: 'Down: a teammate standing next to you brings you back.',
  locked: 'A locked door opens when a player carrying a key walks up to it.',
};

// container: an element the runner fills. opts:
//   doc, startLevel, seed            the world and where to start (alone)
//   session                          a co-op session (its game already made)
//   names                            players' names, by slot (co-op)
//   title: true                      show the title screen first (alone)
//   onExit(why)                      Back to the maker / lobby
export async function createRunner(container, opts) {
  const RAPIER = await loadRapier(opts.rapierUrl);
  const settings = { ...loadSettings(), ...(opts.settings ?? {}) };
  const doc = opts.doc;
  const coop = Boolean(opts.session);

  // ---------------------------------------------------------------- DOM

  const canvas = h('canvas', { tabindex: 0, 'aria-label': 'Game' });
  const hud = h('div', { class: 'hud' });
  const els = {
    cross: h('div', { class: 'cross' }),
    flash: h('div', { class: 'flash' }),
    hurt: h('div', { class: 'hurt' }),
    bl: h('div', { class: 'bl' }),
    br: h('div', { class: 'br' }),
    tr: h('div', { class: 'tr' }),
    boss: h('div', { class: 'boss', hidden: true }),
    msgs: h('div', { class: 'msgs' }),
    note: h('div', { class: 'center-note' }),
    tip: h('div', { class: 'tip' }),
  };
  els.health = h('div', { class: 'bar' }, h('i'));
  els.healthText = h('div', {});
  els.team = h('div', { class: 'team' });
  els.bl.append(els.healthText, els.health, els.team);
  els.score = h('div', {});
  els.keys = h('div', {});
  els.levelName = h('div', { class: 'muted' });
  els.br.append(els.score, els.keys);
  els.tr.append(els.levelName);
  els.bossName = h('div', { class: 'name' });
  els.bossBar = h('div', { class: 'bar' }, h('i'));
  els.boss.append(els.bossName, els.bossBar);
  hud.append(els.flash, els.hurt, els.cross, els.bl, els.br, els.tr, els.boss, els.msgs, els.note, els.tip);
  const overlay = h('div', { class: 'overlay', hidden: true });
  const wrap = h('div', { class: 'play-wrap' }, canvas, hud, overlay);
  fill(container, wrap);

  const view = createView(canvas, { detail: settings.detail });
  view.setWorld(doc);
  const audio = createAudio();
  audio.setVolume(settings.volume);

  // ---------------------------------------------------------------- game

  let session;
  let game;
  let seed = opts.seed ?? ((Date.now() & 0xffff) || 1);
  function newSoloGame(level) {
    game = createGame({ RAPIER, world: doc, crew: 1, seed, startLevel: level });
    session = soloSession(game);
  }
  if (coop) {
    session = opts.session;
    game = session.game;
  } else newSoloGame(opts.startLevel ?? 0);
  let local = session.local;
  view.setLevel(game.level);
  let shownLevel = game.level;

  // ---------------------------------------------------------------- input

  const held = new Set();
  const latched = new Set();
  let look = { yaw: 0, pitch: 0 };
  const me = () => game.state.players[local];
  {
    const p = me();
    if (p) look = { yaw: p.yaw, pitch: 0 };
  }
  let running = false;
  let paused = !coop && opts.title !== false;
  let stopped = false;
  let locked = false;
  let active = true; // the screen is showing (co-op runs on behind the maker's other screens)

  const press = (name) => {
    held.add(name);
    latched.add(name);
  };
  const KEYMAP = {
    KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
    Space: 'jump', ShiftLeft: 'run', ShiftRight: 'run', KeyE: 'use', KeyF: 'use', KeyQ: 'parry',
    ArrowLeft: 'turnL', ArrowRight: 'turnR', ArrowUp: 'lookU', ArrowDown: 'lookD', KeyJ: 'attack', KeyK: 'parry',
  };
  function onKeyDown(e) {
    if (stopped || !active) return;
    if (e.code === 'Escape') {
      if (!coop && running) openPause();
      else if (coop) openPause();
      return;
    }
    const k = KEYMAP[e.code];
    if (k && !e.repeat) press(k);
    if (k && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
  }
  function onKeyUp(e) {
    const k = KEYMAP[e.code];
    if (k) held.delete(k);
  }
  function onMouseDown(e) {
    if (stopped || !running) return;
    if (!locked && canvas.requestPointerLock && e.target === canvas) {
      try {
        const p = canvas.requestPointerLock();
        p?.catch?.(() => {});
      } catch {
        // drag to look still works
      }
    }
    if (e.button === 0) press('attack');
    if (e.button === 2) press('parry');
    audio.unlock();
  }
  function onMouseUp(e) {
    if (e.button === 0) held.delete('attack');
    if (e.button === 2) held.delete('parry');
  }
  function onMouseMove(e) {
    if (!running || !active) return;
    // With the pointer locked, every move turns; without it, a held button does.
    if (!locked && !(e.buttons & 1) && !(e.buttons & 2)) return;
    const k = 0.0005 * settings.mouse;
    look.yaw += e.movementX * k;
    look.pitch = Math.max(-1.45, Math.min(1.45, look.pitch + e.movementY * k * (settings.invert ? -1 : 1)));
  }
  function onLockChange() {
    locked = document.pointerLockElement === canvas;
    if (!locked && running && !coop && !stopped && !overlayOpen()) openPause();
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', onLockChange);
  window.addEventListener('blur', () => held.clear());

  function sampleInput() {
    const on = (k) => held.has(k) || latched.has(k);
    if (held.has('turnL')) look.yaw -= 0.045;
    if (held.has('turnR')) look.yaw += 0.045;
    if (held.has('lookU')) look.pitch = Math.max(-1.45, look.pitch - 0.03);
    if (held.has('lookD')) look.pitch = Math.min(1.45, look.pitch + 0.03);
    const input = {
      move: [(on('right') ? 1 : 0) - (on('left') ? 1 : 0), (on('fwd') ? 1 : 0) - (on('back') ? 1 : 0)],
      yaw: look.yaw,
      pitch: look.pitch,
      jump: on('jump'),
      attack: on('attack'),
      parry: on('parry'),
      use: on('use'),
      run: on('run'),
    };
    latched.clear();
    return input;
  }

  // ---------------------------------------------------------------- feel

  const feel = game.feel;
  const fx = { flash: 0, flashColor: [1, 1, 1], hurt: 0, shake: 0, stageTint: 0, boss: null, bossShown: false, tipsShown: new Set(), tip: null, tipUntil: 0, title: null, titleUntil: 0 };
  const reduce = () => settings.flashes === 'reduced';
  function showTip(key) {
    if (!feel.tips || fx.tipsShown.has(key)) return;
    fx.tipsShown.add(key);
    fx.tip = TIPS[key];
    fx.tipUntil = performance.now() + 6000;
  }
  function onEvents(events) {
    const p = me();
    const listener = p ? { x: p.x, y: p.y, yaw: look.yaw } : null;
    for (const e of events) {
      const at = e.x !== undefined ? e : null;
      switch (e.t) {
        case 'hurt':
          if (e.slot === local) {
            fx.hurt = 1;
            audio.play('hurt');
          } else audio.play('hit', at, listener);
          break;
        case 'parry':
          fx.flash = Math.max(fx.flash, feel.flash?.parry ?? 0.4);
          fx.flashColor = [0.85, 0.95, 1];
          audio.play('parry', at, listener);
          break;
        case 'hit':
          fx.flash = Math.max(fx.flash, (feel.flash?.hit ?? 0.2) * 0.5);
          fx.flashColor = [1, 1, 1];
          audio.play('hit', at, listener);
          break;
        case 'boom':
          fx.flash = Math.max(fx.flash, feel.flash?.boom ?? 0.5);
          fx.flashColor = [1, 0.75, 0.4];
          if (p) fx.shake = Math.max(fx.shake, 1 / (1 + Math.hypot(e.x - p.x, e.y - p.y) * 0.3));
          audio.play('boom', at, listener);
          break;
        case 'slam':
          if (p) fx.shake = Math.max(fx.shake, 0.6 / (1 + Math.hypot(e.x - p.x, e.y - p.y) * 0.3));
          audio.play('slam', at, listener);
          break;
        case 'kill':
          audio.play('kill', at, listener);
          if (e.boss && feel.quietEnd) audio.quiet(2.5);
          break;
        case 'alert': {
          const c = game.state.creatures.find((x) => x.id === e.id);
          if (c && game.state.boss === c.id && !fx.bossShown) {
            fx.bossShown = true;
            fx.title = game.characters.get(c.char)?.name ?? 'Boss';
            fx.titleUntil = performance.now() + 2600;
          }
          audio.play('alert', at, listener);
          break;
        }
        case 'stage':
          if (feel.stageShift) fx.stageTint = e.stage;
          audio.play('stage', at, listener);
          break;
        case 'tell':
          showTip('tell');
          audio.play('tell', at, listener);
          break;
        case 'grab':
          if (e.slot === local) showTip('grab');
          audio.play('grab', at, listener);
          break;
        case 'down':
          if (e.slot === local && coop && doc.coop.revive) showTip('down');
          audio.play('down', at, listener);
          break;
        case 'sound':
          audio.play(e.name, at, listener);
          break;
        case 'effect':
          if (e.name === 'flash') {
            fx.flash = Math.max(fx.flash, 0.6);
            fx.flashColor = [1, 1, 1];
          } else if (e.name === 'shake') fx.shake = Math.max(fx.shake, 0.7);
          audio.play('effect', at, listener);
          break;
        case 'swing':
        case 'shot':
        case 'jump':
          if (e.slot === local) audio.play(e.t);
          else audio.play(e.t, at, listener);
          break;
        case 'level':
          fx.stageTint = 0;
          fx.bossShown = false;
          audio.play('use');
          break;
        default:
          audio.play(e.t, at, listener);
      }
    }
  }

  // ---------------------------------------------------------------- HUD

  let lastHud = '';
  function updateHud(now) {
    const s = game.state;
    const p = me();
    if (!p) return;
    const parts = [];
    const hp = Math.max(0, Math.round(p.health));
    els.health.firstChild.style.width = `${hp}%`;
    els.health.classList.toggle('low', hp < 35);
    els.healthText.textContent = p.down ? 'Down' : `Health ${hp}`;
    parts.push(hp);
    const team = s.players.filter((q) => q.slot !== local && !q.out && !q.waiting);
    const teamKey = team.map((q) => `${q.slot}:${Math.round(q.health)}:${q.down}`).join(',');
    if (teamKey !== lastHud) {
      lastHud = teamKey;
      fill(els.team, ...team.map((q) =>
        h('div', {}, h('div', {}, `${opts.names?.[q.slot] ?? `Player ${q.slot + 1}`}${q.down ? ' (down)' : ''}`),
          h('div', { class: `bar ${q.health < 35 ? 'low' : ''}` }, h('i', { style: { width: `${Math.max(0, q.health)}%` } })))));
    }
    els.score.textContent = `Score ${s.score}`;
    els.keys.textContent = s.keys ? `Keys ${s.keys}` : '';
    els.levelName.textContent = `${game.level.name}${doc.levels.length > 1 ? ` (${s.level + 1} of ${doc.levels.length})` : ''}`;
    // Boss bar, once the boss has seen someone.
    const boss = s.boss ? s.creatures.find((c) => c.id === s.boss) : null;
    const showBoss = feel.bossBar && boss && boss.seen && boss.state !== 'dead';
    els.boss.hidden = !showBoss;
    if (showBoss) {
      els.bossName.textContent = (game.characters.get(boss.char)?.name ?? 'Boss').toUpperCase();
      els.bossBar.firstChild.style.width = `${(100 * boss.health) / boss.max}%`;
    }
    const msgs = s.messages.map((m) => m.text);
    if (fx.title && now < fx.titleUntil) msgs.unshift(fx.title.toUpperCase());
    const key = msgs.join('|');
    if (els.msgs.dataset.key !== key) {
      els.msgs.dataset.key = key;
      fill(els.msgs, ...msgs.map((m, i) => h('div', { style: i === 0 && fx.title && now < fx.titleUntil ? { fontSize: '1.8em', letterSpacing: '0.12em' } : {} }, m)));
    }
    // What E does here.
    let note = '';
    if (p.down) note = !coop ? 'Down.' : doc.coop.revive ? `Down. A teammate standing by you brings you back. ${p.revive ? Math.round((100 * p.revive) / PLAYER.reviveTicks) + '%' : ''}` : 'Down. You are out until the level starts again.';
    else if (p.held) note = 'Left click throws it. E puts it down.';
    else {
      const near = nearThing(p);
      if (near) note = near;
    }
    if (session.joining) note = 'Joining the run…';
    els.note.textContent = note;
    els.tip.textContent = fx.tip && now < fx.tipUntil ? fx.tip : '';
    els.flash.style.opacity = String(Math.min(1, fx.flash) * (reduce() ? 0.25 : 0.55));
    els.flash.style.background = `rgb(${fx.flashColor.map((c) => Math.round(c * 255)).join(',')})`;
    els.hurt.style.opacity = String(fx.hurt * (reduce() ? 0.4 : 1));
  }

  function nearThing(p) {
    const lv = game.level;
    let best = null;
    let bestD = PLAYER.useRange * PLAYER.useRange;
    for (const part of lv.parts) {
      const d = (part.x - p.x) ** 2 + (part.y - p.y) ** 2;
      if (part.type === 'button' || part.type === 'lever') {
        if (d < bestD) {
          bestD = d;
          best = part.type === 'button' ? 'E presses the button.' : 'E pulls the lever.';
        }
      } else if (part.type === 'door' && part.props.locked && !game.state.parts[part.id]?.unlocked && d < 4) {
        showTip('locked');
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- overlays

  const overlayOpen = () => !overlay.hidden;
  function setOverlay(...children) {
    fill(overlay, ...children);
    overlay.hidden = children.length === 0;
  }
  function settingsCard(onDone) {
    const row = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
    return h('div', { class: 'card' },
      h('h2', {}, 'Settings'),
      row('Volume', h('input', { type: 'range', min: 0, max: 10, value: Math.round(settings.volume * 10), oninput: (e) => { settings.volume = Number(e.target.value) / 10; audio.setVolume(settings.volume); saveSettings(settings); } })),
      row('Mouse speed', h('input', { type: 'range', min: 1, max: 15, value: settings.mouse, oninput: (e) => { settings.mouse = Number(e.target.value); saveSettings(settings); } })),
      h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: settings.invert, onchange: (e) => { settings.invert = e.target.checked; saveSettings(settings); } }), h('span', {}, 'Invert mouse up and down')),
      h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: settings.flashes === 'reduced', onchange: (e) => { settings.flashes = e.target.checked ? 'reduced' : 'full'; saveSettings(settings); } }), h('span', {}, 'Reduce flashes and shaking')),
      row('Detail', h('select', { onchange: (e) => { settings.detail = e.target.value; view.setDetail(settings.detail); saveSettings(settings); } },
        [['chunky', 'Chunky (fastest)'], ['medium', 'Medium'], ['fine', 'Fine']].map(([v, l]) => h('option', { value: v, selected: v === settings.detail }, l)))),
      h('div', { class: 'buttons' }, h('button', { class: 'primary', onclick: onDone }, 'Done')),
    );
  }
  const CONTROLS = 'W A S D move · mouse looks (or arrow keys) · Space jumps · Shift runs · left click attacks · right click (or Q) parries, hold to block · E uses and picks up · Esc pauses';

  function openTitle() {
    running = false;
    paused = true;
    const levelPick = h('select', { 'aria-label': 'Start at level' }, doc.levels.map((l, i) => h('option', { value: i, selected: i === (opts.startLevel ?? 0) }, `${i + 1}. ${l.name}`)));
    setOverlay(
      h('h1', {}, doc.screens.title || doc.name),
      doc.screens.subtitle ? h('p', { class: 'sub' }, doc.screens.subtitle) : null,
      h('div', { class: 'buttons' },
        h('button', { class: 'primary', 'data-action': 'start', onclick: () => { const lv = Number(levelPick.value); if (lv !== game.state.level || game.tick > 0) restart(lv); begin(); } }, 'Start'),
        doc.levels.length > 1 ? levelPick : null,
        h('button', { onclick: () => setOverlay(settingsCard(openTitle)) }, 'Settings'),
        opts.onExit ? h('button', { onclick: () => opts.onExit('title') }, opts.exitLabel ?? 'Back to the maker') : null),
      h('p', { class: 'muted small' }, CONTROLS),
    );
  }
  function openPause() {
    if (stopped) return;
    if (!coop) running = false;
    paused = !coop;
    try {
      document.exitPointerLock?.();
    } catch {
      // not locked
    }
    setOverlay(
      h('h1', {}, coop ? 'Menu' : 'Paused'),
      coop ? h('p', { class: 'sub' }, 'The run goes on while this is open.') : null,
      h('div', { class: 'buttons' },
        h('button', { class: 'primary', 'data-action': 'resume', onclick: begin }, 'Back to the game'),
        !coop ? h('button', { onclick: () => { restart(game.state.level); begin(); } }, 'Restart level') : null,
        h('button', { onclick: () => setOverlay(settingsCard(openPause)) }, 'Settings'),
        opts.onExit ? h('button', { onclick: () => opts.onExit('menu') }, opts.exitLabel ?? (coop ? 'Leave the run' : 'Back to the maker')) : null),
      h('p', { class: 'muted small' }, CONTROLS),
    );
  }
  function phaseOverlay() {
    const s = game.state;
    if (s.phase === 'play') {
      if (overlay.dataset.phase) {
        overlay.dataset.phase = '';
        setOverlay();
      }
      return;
    }
    if (overlay.dataset.phase === s.phase) return;
    overlay.dataset.phase = s.phase;
    try {
      document.exitPointerLock?.();
    } catch {
      // not locked
    }
    if (s.phase === 'clear') setOverlay(h('h1', {}, 'Level clear'), h('p', { class: 'sub' }, `Score ${s.score}`));
    else if (s.phase === 'over') setOverlay(h('h1', {}, doc.screens.lose || 'Game over'), h('p', { class: 'sub' }, 'The level starts again.'));
    else if (s.phase === 'won') {
      opts.onWin?.(game);
      setOverlay(
        h('h1', {}, doc.screens.win || 'You win'),
        h('p', { class: 'sub' }, `Score ${s.score}`),
        opts.wonNote ? h('p', { class: 'muted' }, opts.wonNote) : null,
        h('div', { class: 'buttons' },
          !coop ? h('button', { class: 'primary', onclick: () => { restart(0); begin(); } }, 'Play again') : null,
          opts.onExit ? h('button', { class: coop ? 'primary' : '', 'data-action': 'won-exit', onclick: () => opts.onExit('won') }, opts.wonLabel ?? (coop ? 'Back to the lobby' : (opts.exitLabel ?? 'Back to the maker'))) : null),
      );
    }
  }

  function begin() {
    setOverlay();
    overlay.dataset.phase = '';
    running = true;
    paused = false;
    audio.unlock();
    canvas.focus();
    last = performance.now();
    acc = 0;
  }

  function restart(level) {
    if (coop) return;
    seed = (seed * 1103515245 + 12345) >>> 0 || 1;
    try {
      game.world.free();
    } catch {
      // gone already
    }
    newSoloGame(level);
    prev = null;
    view.setLevel(game.level);
    shownLevel = game.level;
    fx.stageTint = 0;
    fx.bossShown = false;
    const p = me();
    look = { yaw: p ? p.yaw : 0, pitch: 0 };
  }

  // ---------------------------------------------------------------- loop

  let prev = null;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  const snapPrev = () => {
    const s = game.state;
    const players = s.players.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const creatures = {};
    for (const c of s.creatures) creatures[c.id] = { x: c.x, y: c.y, z: c.z };
    return { players, creatures };
  };

  // Steps the game as far as the clock says; in co-op, the session decides
  // what is stepped. `hidden`: the browser has hidden the tab (it steps from
  // the messages that come in, and says ahead it stands still).
  function simulate(now, hidden = false) {
    const dt = Math.min(hidden ? 1 : 0.25, (now - last) / 1000);
    last = now;
    if (!(running || coop)) return dt;
    onEvents(session.settle());
    acc += dt * session.pace();
    if (hidden && coop) session.pledge?.(look, 45);
    // Dropping in: catch up quickly.
    const extra = session.behind() > 4 ? Math.min(30, session.behind()) : 0;
    const most = (hidden ? 70 : 6) + extra;
    let steps = 0;
    while ((acc >= DT || steps < extra) && steps < most) {
      if (session.blocked()) {
        acc = Math.min(acc, DT);
        break;
      }
      prev = snapPrev();
      const input = running && !paused && active && !hidden ? sampleInput() : { move: [0, 0], yaw: look.yaw, pitch: look.pitch };
      onEvents(session.advance(input));
      acc = Math.max(0, acc - DT);
      steps++;
    }
    if (acc > DT * 8) acc = DT * 8;
    session.flush(now);
    if (session.over) {
      const why = session.over;
      stopped = true;
      opts.onExit?.(why);
    }
    return dt;
  }

  // A hidden tab gets no frames: messages coming in step it instead.
  let lastPump = 0;
  function pump() {
    if (stopped || !coop || !document.hidden) return;
    const now = performance.now();
    if (now - lastPump < 12) return;
    lastPump = now;
    simulate(now, true);
  }

  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    const dt = simulate(now);
    if (stopped) return;
    if (game.level !== shownLevel) {
      view.setLevel(game.level);
      shownLevel = game.level;
      prev = null;
      const p = me();
      if (p) look.yaw = p.yaw;
    }
    if (!active) return;
    if (!overlay.hidden || game.state.phase !== 'play') phaseOverlay();
    // Effects fade.
    fx.flash *= Math.pow(0.5, dt * 60 / Math.max(1, (feel.flashTicks ?? 6) * 0.6));
    fx.hurt *= Math.pow(0.5, dt * 6);
    fx.shake *= Math.pow(0.5, dt * 10);
    draw(now / 1000, Math.min(1, acc / DT));
    updateHud(now);
  }

  function draw(time, alpha) {
    const r = canvas.getBoundingClientRect();
    if (r.width && (r.width !== view._w || r.height !== view._h)) {
      view._w = r.width;
      view._h = r.height;
      view.fit(r.width, r.height);
    }
    const p = me();
    const q = prev?.players?.[local];
    const lerp = (a, b) => (q ? a + (b - a) * alpha : b);
    let cam = { x: 0, y: 0, z: 2, yaw: look.yaw, pitch: look.pitch };
    if (p && !p.out) {
      const bob = p.moving && p.grounded ? Math.sin(time * 11) * 0.035 : 0;
      cam = { x: lerp(q?.x, p.x), y: lerp(q?.y, p.y), z: lerp(q?.z, p.z) + (p.down ? 0.45 : PLAYER.eye + bob), yaw: look.yaw, pitch: p.down ? 0.25 : look.pitch };
    }
    if (fx.shake > 0.02 && !reduce()) {
      cam.yaw += (Math.random() - 0.5) * 0.03 * fx.shake;
      cam.pitch += (Math.random() - 0.5) * 0.03 * fx.shake;
    }
    const { entities, lights } = playEntities(game, { me: p && !p.out ? local : null, time, prev, alpha });
    let atmosphere = null;
    if (fx.stageTint > 0) {
      const k = fx.stageTint / 2;
      atmosphere = {
        fogColor: k > 0.6 ? '#3a0608' : '#2a0c10',
        skyTop: k > 0.6 ? '#1a0204' : '#140608',
        skyHorizon: k > 0.6 ? '#6a0a10' : '#3a1418',
        ambient: 0.35 + 0.1 * k,
        exposure: 1,
        fogDensity: 0.03,
      };
    }
    try {
      view.render({ camera: cam, entities, lights, time, atmosphere });
    } catch (err) {
      console.error(err);
    }
  }

  // ---------------------------------------------------------------- start

  running = !paused;
  if (paused) openTitle();
  else begin();
  raf = requestAnimationFrame(frame);

  return {
    get game() {
      return game;
    },
    get session() {
      return session;
    },
    settings,
    begin,
    pump,
    // Co-op goes on while the maker shows another screen; input stops.
    setActive(on) {
      active = Boolean(on);
      if (!active) {
        held.clear();
        latched.clear();
        try {
          document.exitPointerLock?.();
        } catch {
          // not locked
        }
      } else {
        last = performance.now();
        view._w = 0;
      }
    },
    stop() {
      stopped = true;
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      try {
        document.exitPointerLock?.();
      } catch {
        // not locked
      }
      view.dispose();
      if (!coop) {
        try {
          game.world.free();
        } catch {
          // gone already
        }
      }
      fill(container);
    },
  };
}
