// Play together: open a room for the world being made, or join a friend's
// with its code; wait in the lobby while the world goes to everyone; then
// the run. The lobby's workings are net/lobby.js.

import { $, h, fill, toast } from './dom.js';
import { worldHash } from '../kit/format.js';

const NAME_KEY = 'maker.name';
const loadName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveName = (name) => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // not kept
  }
};
const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

export function mount(el, { store, switchTo }) {
  const page = h('div', { class: 'page' });
  const box = h('div', { class: 'center', hidden: true });
  el.append(page, box);

  let lobby = null;
  let runner = null;
  let busy = null; // 'host' | 'join'
  let error = '';
  let shown = false;
  let joinCode = '';
  let startLevel = 0;
  let refresh = 0;
  let sync = 0;
  let offStore = null;

  // ------------------------------------------------------------ views

  // Draws the page again when what it shows has changed (a timer asks every
  // second, for the links), so a field being typed in keeps its place.
  let drawn = '';
  function signature() {
    if (!lobby) return `start|${busy}|${error}`;
    return JSON.stringify([
      lobby.members.map((m) => [m.slot, m.name, m.hasWorld, m.link, m.late, m.ready]),
      lobby.receiving, lobby.canStart, lobby.world?.hash, Boolean(lobby.run?.late),
      lobby.isHost && lobby.world ? worldHash(store.doc) : '', error, store.doc.levels.length, JSON.stringify(store.doc.coop),
    ]);
  }
  function render(force = true) {
    if (runner || starting) return;
    page.hidden = false;
    box.hidden = true;
    const sig = signature();
    if (!force && sig === drawn) return;
    drawn = sig;
    if (lobby) fill(page, lobby.run?.late ? lateView() : lobbyView());
    else fill(page, startView());
  }

  function nameField() {
    return h('label', { class: 'field' }, h('span', {}, 'Your name'),
      h('input', { id: 'together-name', maxlength: 16, value: loadName(), placeholder: 'Player', spellcheck: false, oninput: (e) => saveName(e.target.value.trim()) }));
  }

  function startView() {
    const code = h('input', { id: 'together-code', maxlength: 4, value: joinCode, placeholder: 'ABCD', spellcheck: false, autocomplete: 'off', style: { textTransform: 'uppercase', fontFamily: 'var(--mono)', letterSpacing: '0.2em', width: '7em' },
      oninput: (e) => { joinCode = cleanCode(e.target.value); e.target.value = joinCode; },
      onkeydown: (e) => { if (e.key === 'Enter') join(); } });
    return h('div', { class: 'cols' },
      h('div', { class: 'panel', style: { gridColumn: '1 / -1' } },
        h('h2', {}, 'Play together'),
        h('p', {}, 'Up to four players, each in their own browser, play one world in step. Everyone needs a keyboard and mouse.'),
        h('div', { style: { maxWidth: '20em' } }, nameField())),
      h('div', { class: 'panel' },
        h('h2', {}, 'Host a room'),
        h('p', {}, 'Your friends play the world you have open: ', h('b', {}, store.doc.name), '.'),
        h('div', { class: 'buttons' },
          h('button', { class: 'primary', 'data-action': 'host', disabled: Boolean(busy), onclick: host }, busy === 'host' ? 'Opening a room…' : 'Open a room')),
        h('p', { class: 'muted small' }, 'You get a four-letter code and a link to send. The world is sent to each player when they join.'),
        coopSettings(),
      ),
      h('div', { class: 'panel' },
        h('h2', {}, 'Join a room'),
        h('label', { class: 'field' }, h('span', {}, 'Room code'), code),
        h('div', { class: 'buttons' },
          h('button', { class: 'primary', 'data-action': 'join', disabled: Boolean(busy), onclick: join }, busy === 'join' ? 'Joining…' : 'Join')),
        h('p', { class: 'muted small' }, 'You play the host\'s world. Your own world in the maker is not changed.'),
      ),
      error ? h('div', { class: 'panel', role: 'alert' }, h('p', {}, error)) : null,
    );
  }

  // The world's own co-op settings (kept in the world file).
  function coopSettings() {
    const c = store.doc.coop;
    const set = (key, value) => store.change((doc) => {
      doc.coop[key] = value;
    });
    const check = (key, label) => h('label', { class: 'field check' },
      h('input', { type: 'checkbox', 'data-coop': key, checked: c[key], onchange: (e) => set(key, e.target.checked) }), h('span', {}, label));
    return h('div', {},
      h('h3', {}, 'Co-op settings for this world'),
      h('label', { class: 'field inline' }, h('span', {}, 'Most players'),
        h('select', { 'data-coop': 'players', onchange: (e) => set('players', Number(e.target.value)) },
          [2, 3, 4].map((n) => h('option', { value: n, selected: n === c.players }, String(n))))),
      check('revive', 'A teammate standing next to a downed player brings them back'),
      check('tougher', 'Creatures get tougher with more players'),
      check('friendlyFire', 'Players can hurt each other'),
      check('dropIn', 'Friends can join a run under way'),
    );
  }

  function linkFor(code) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', code);
    const rooms = new URLSearchParams(location.search).get('rooms');
    if (rooms) url.searchParams.set('rooms', rooms);
    return url.toString();
  }

  function memberRow(m) {
    let world;
    if (m.slot === 0) world = 'host';
    else if (m.hasWorld) world = 'has the world';
    else if (m.you && lobby.receiving.count) world = `getting the world (${lobby.receiving.got} of ${lobby.receiving.count})`;
    else world = 'getting the world';
    const link = m.link === 'direct' ? 'direct link' : m.link === 'relay' ? 'through the room' : null;
    return h('li', { 'data-slot': m.slot },
      h('span', { class: m.hasWorld || m.slot === 0 ? 'ok' : 'maybe', 'aria-hidden': 'true' }, m.hasWorld || m.slot === 0 ? '●' : '○'),
      h('b', {}, m.name), m.you ? h('span', { class: 'muted' }, '(you)') : null,
      h('span', { class: 'muted' }, `· ${world}`), link ? h('span', { class: 'muted small' }, `· ${link}`) : null,
      m.late ? h('span', { class: 'muted small' }, '· joins the run under way') : null);
  }

  function lobbyView() {
    const members = lobby.members;
    const isHost = lobby.isHost;
    const doc = isHost ? store.doc : lobby.world?.doc;
    const levels = doc?.levels ?? [];
    if (startLevel >= levels.length) startLevel = 0;
    const link = linkFor(lobby.code);
    const waiting = members.filter((m) => !m.hasWorld && m.slot !== 0).length;
    const stale = isHost && lobby.world && worldHash(store.doc) !== lobby.world.hash;
    let startNote = '';
    const most = (doc ?? store.doc).coop.players;
    if (members.length < 2) startNote = 'You can start alone, or wait for friends to join.';
    if (waiting) startNote = waiting === 1 ? 'One player is still getting the world.' : `${waiting} players are still getting the world.`;
    if (members.length > most) startNote = `This world is set for at most ${most} players. Change it below, or ask someone to leave.`;
    return h('div', { class: 'cols' },
      h('div', { class: 'panel' },
        h('h2', {}, isHost ? 'Your room' : 'In the room'),
        h('div', { class: 'code', 'data-code': lobby.code }, lobby.code),
        h('p', { class: 'muted small' }, isHost ? 'Send your friends this code, or the link.' : 'The room code.'),
        h('div', { class: 'field inline' },
          h('input', { readonly: true, value: link, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() }),
          h('button', { onclick: () => copy(link) }, 'Copy link')),
        h('h3', {}, `Players (${members.length} of 4)`),
        h('ul', { class: 'players checklist' }, members.map(memberRow)),
        h('label', { class: 'field' }, h('span', {}, 'Your name'),
          h('input', { maxlength: 16, value: members.find((m) => m.you)?.name ?? loadName(), spellcheck: false,
            onchange: (e) => { const v = e.target.value.trim(); saveName(v); lobby.setName(v); } })),
      ),
      h('div', { class: 'panel' },
        h('h2', {}, doc ? doc.name : 'The host\'s world'),
        isHost
          ? [
            levels.length > 1
              ? h('label', { class: 'field' }, h('span', {}, 'Start at'),
                h('select', { 'data-field': 'level', onchange: (e) => { startLevel = Number(e.target.value); } },
                  levels.map((l, i) => h('option', { value: i, selected: i === startLevel }, `${i + 1}. ${l.name}`))))
              : null,
            h('div', { class: 'buttons' },
              h('button', { class: 'primary', 'data-action': 'start', disabled: !lobby.canStart || stale, onclick: start }, 'Start the run'),
              h('button', { 'data-action': 'close', onclick: () => leave('You closed the room.') }, 'Close the room')),
            startNote ? h('p', { class: 'muted' }, startNote) : null,
            stale ? h('p', { class: 'muted' }, 'Sending your latest changes…') : null,
            h('p', { class: 'muted small' }, 'Changes you make in the maker while the room is open go to everyone before the next start.'),
            coopSettings(),
          ]
          : [
            lobby.world ? h('p', {}, 'You have the world. Waiting for the host to start.') : h('p', {}, 'Getting the world from the host…'),
            h('div', { class: 'buttons' }, h('button', { 'data-action': 'leave', onclick: () => leave('You left the room.') }, 'Leave the room')),
          ],
        h('p', { class: 'muted small' }, 'Controls: W A S D move, the mouse looks, Space jumps, Shift runs, left click attacks, right click parries, E uses. A player who is down comes back when a teammate stands next to them.'),
      ),
      error ? h('div', { class: 'panel', role: 'alert' }, h('p', {}, error)) : null,
    );
  }

  function lateView() {
    return h('div', { class: 'cols' },
      h('div', { class: 'panel' },
        h('h2', {}, 'The run has started'),
        h('div', { class: 'code' }, lobby.code),
        h('p', {}, !lobby.world
          ? `Getting the world from the host${lobby.receiving.count ? ` (${lobby.receiving.got} of ${lobby.receiving.count})` : ''}…`
          : lobby.world.doc.coop.dropIn ? 'You have the world. The host\'s game lets you in shortly.' : 'This world does not let players join a run under way. You join at the next start.'),
        h('ul', { class: 'players checklist' }, lobby.members.map(memberRow)),
        h('div', { class: 'buttons' }, h('button', { 'data-action': 'leave', onclick: () => leave('You left the room.') }, 'Leave the room')),
      ));
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied.');
    } catch {
      toast('Select the link and copy it.');
    }
  }

  // ------------------------------------------------------------ the room

  async function openWith(code) {
    const name = (loadName() || '').trim();
    error = '';
    busy = code === 'new' ? 'host' : 'join';
    render();
    try {
      const [{ openLobby }, { loadRapier }, { roomService }] = await Promise.all([
        import('../net/lobby.js'),
        import('../play/runner.js'),
        import('../net/rooms.js'),
      ]);
      const RAPIER = await loadRapier();
      const params = new URLSearchParams(location.search);
      lobby = await openLobby({ RAPIER, service: roomService(params), code, name, doc: code === 'new' ? store.doc : null });
    } catch (err) {
      lobby = null;
      error = err?.message || 'The room could not be reached.';
    }
    busy = null;
    if (!lobby) {
      render();
      return;
    }
    // Each handler hears only the lobby it was set on, not one already left.
    const mine = lobby;
    lobby.on('change', () => {
      if (lobby === mine && !runner) render(false);
    });
    lobby.on('start', (run) => {
      if (lobby === mine) startRunner(run);
    });
    lobby.on('stop', () => {
      if (lobby !== mine) return;
      stopRunner();
      if (shown) toast('Back in the lobby.');
    });
    lobby.on('closed', (why) => {
      if (lobby !== mine) return;
      stopRunner();
      lobby = null;
      error = why;
      stopTimers();
      render();
    });
    if (lobby.isHost) {
      offStore = store.on((what) => {
        if (what !== 'doc' && what !== 'world') return;
        clearTimeout(sync);
        sync = setTimeout(() => {
          if (lobby && !lobby.run) lobby.setWorld(store.doc);
          render(false);
        }, 400);
      });
    }
    clearInterval(refresh);
    refresh = setInterval(() => {
      if (lobby && !runner && shown) render(false);
    }, 1000);
    render();
  }

  function host() {
    if (busy) return;
    openWith('new');
  }
  function join() {
    if (busy) return;
    const code = cleanCode(joinCode || $('#together-code')?.value);
    if (code.length !== 4) {
      error = 'A room code is four letters.';
      render();
      return;
    }
    openWith(code);
  }
  function start() {
    if (!lobby?.isHost) return;
    if (lobby.world && worldHash(store.doc) !== lobby.world.hash) {
      lobby.setWorld(store.doc);
      render();
      return;
    }
    if (!lobby.start(startLevel)) toast('Everyone needs the world first.');
  }
  function stopTimers() {
    clearInterval(refresh);
    clearTimeout(sync);
    offStore?.();
    offStore = null;
  }
  function leave(why) {
    stopRunner();
    lobby?.leave();
    lobby = null;
    stopTimers();
    error = why ?? '';
    render();
  }

  // ------------------------------------------------------------ the run

  // The lobby is not drawn while the run starts: drawing it would hide the
  // game's box again before the game is in it.
  let starting = false;
  async function startRunner(run) {
    stopRunner();
    page.hidden = true;
    box.hidden = false;
    starting = true;
    fill(box, h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Starting…')));
    try {
      await startedRunner(run);
    } catch (err) {
      console.error(err);
      error = `The run could not start: ${err.message}`;
    } finally {
      starting = false;
      if (!runner) render();
    }
  }
  async function startedRunner(run) {
    const { createRunner } = await import('../play/runner.js');
    if (!lobby || lobby.run !== run) return;
    const isHost = lobby.isHost;
    runner = await createRunner(box, {
      doc: lobby.world.doc,
      session: run.session,
      names: run.names,
      exitLabel: isHost ? 'End the run for everyone' : 'Leave the room',
      wonLabel: isHost ? 'Back to the lobby' : 'Leave the room',
      wonNote: isHost ? null : 'The host takes everyone back to the lobby.',
      onExit: (why) => {
        if (why === 'menu' || why === 'won') {
          if (isHost) lobby?.stop();
          else leave('You left the room.');
          return;
        }
        // The session is over: the host has gone, or the run stopped.
        if (lobby?.closed || why !== 'stopped') leave(lobby?.closed ?? why);
        else stopRunner();
      },
    });
    if (!lobby || lobby.run !== run) {
      stopRunner();
      return;
    }
    run.onBytes = () => runner?.pump();
    run.driven = true;
    runner.setActive(shown);
    window.maker.runner = runner;
  }

  function stopRunner() {
    if (!runner) return;
    const r = runner;
    runner = null;
    r.stop();
    if (window.maker?.runner === r) window.maker.runner = null;
    page.hidden = false;
    box.hidden = true;
    render();
  }

  window.addEventListener('beforeunload', () => lobby?.leave());

  return {
    show(opts) {
      shown = true;
      if (opts?.join && !lobby) {
        joinCode = cleanCode(opts.join);
        render();
        setTimeout(() => $('#together-name')?.focus?.(), 0);
      }
      if (runner) runner.setActive(true);
      else render();
    },
    hide() {
      shown = false;
      runner?.setActive(false);
    },
    get lobby() {
      return lobby;
    },
  };
}
