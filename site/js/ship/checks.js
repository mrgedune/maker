// What the Ship screen checks before a world goes out: things that would
// stop it being played to the end (no), and things that are likely a
// mistake (maybe). Each: { status: 'ok' | 'no' | 'maybe', text }.

import { PART, LIMITS, partName } from '../kit/catalog.js';

// Receivers that do nothing until something is wired into them.
const NEEDS_INPUT = new Set(['spawner', 'launcher', 'sound', 'effect', 'score', 'message', 'win', 'lose', 'and', 'or', 'delay', 'counter', 'random', 'toggle']);

const label = (part, level) => partName(level, part);
const where = (i, doc) => (doc.levels.length > 1 ? ` on level ${i + 1}` : '');

export function checkWorld(doc, { playedToEnd = false } = {}) {
  const out = [];
  const push = (status, text) => out.push({ status, text });
  const creatureIds = new Set(doc.characters.filter((c) => c.role !== 'player').map((c) => c.id));

  // Starts.
  const noStart = doc.levels.map((l, i) => (l.parts.some((p) => p.type === 'start') ? null : i)).filter((i) => i !== null);
  if (!noStart.length) push('ok', doc.levels.length > 1 ? 'Every level has a player start.' : 'The level has a player start.');
  else for (const i of noStart) push('maybe', `${doc.levels.length > 1 ? `Level ${i + 1}` : 'The level'} has no player start, so players begin in the middle.`);

  // A way to finish.
  let finishOk = true;
  doc.levels.forEach((l, i) => {
    const wiredIn = new Set(l.wires.map((w) => w.to));
    const exit = l.parts.some((p) => p.type === 'exit');
    const win = l.parts.some((p) => p.type === 'win' && wiredIn.has(p.id));
    if (!exit && !win) {
      finishOk = false;
      push('no', `${doc.levels.length > 1 ? `Level ${i + 1}` : 'The level'} has no exit and no wired Win part, so it cannot be finished.`);
    }
  });
  if (finishOk) push('ok', doc.levels.length > 1 ? 'Every level can be finished.' : 'The level can be finished.');

  // Creatures.
  let creaturesOk = true;
  doc.levels.forEach((l, i) => {
    for (const p of l.parts) {
      if ((p.type === 'creature' || p.type === 'spawner') && p.props.character && !creatureIds.has(p.props.character)) {
        creaturesOk = false;
        push('no', `${label(p, l)}${where(i, doc)} uses a character that no longer exists. Pick one in Build.`);
      } else if (p.type === 'creature' && !p.props.character) {
        creaturesOk = false;
        push('no', `${label(p, l)}${where(i, doc)} has no character. Pick one in Build.`);
      }
    }
  });
  const anyCreature = doc.levels.some((l) => l.parts.some((p) => p.type === 'creature' || p.type === 'spawner'));
  if (creaturesOk && anyCreature) push('ok', 'Every creature has a character.');

  // Wiring.
  let wiresOk = true;
  doc.levels.forEach((l, i) => {
    const wiredIn = new Set(l.wires.map((w) => w.to));
    const wiredOut = new Set(l.wires.map((w) => w.from));
    for (const p of l.parts) {
      const spec = PART[p.type];
      if (!spec) continue;
      if (NEEDS_INPUT.has(p.type) && !wiredIn.has(p.id)) {
        wiresOk = false;
        push('maybe', `${label(p, l)}${where(i, doc)} has nothing wired into it, so it never does anything.`);
      } else if (p.type === 'door' && !wiredIn.has(p.id) && !p.props.locked && !p.props.startsOpen) {
        wiresOk = false;
        push('maybe', `${label(p, l)}${where(i, doc)} has nothing wired into it and is not locked, so it never opens.`);
      } else if (spec.out && !spec.in && !wiredOut.has(p.id) && p.type !== 'down') {
        wiresOk = false;
        push('maybe', `${label(p, l)}${where(i, doc)} is not wired to anything.`);
      }
    }
    if (l.parts.some((p) => p.type === 'door' && p.props.locked) && !l.parts.some((p) => p.type === 'key')) {
      wiresOk = false;
      push('no', `A locked door${where(i, doc)} has no key on the level.`);
    }
  });
  if (wiresOk) push('ok', 'Machines are wired up.');

  // Limits.
  let limitsOk = true;
  doc.levels.forEach((l, i) => {
    const toys = l.parts.filter((p) => PART[p.type]?.category === 'toys').length;
    if (l.parts.length > LIMITS.parts * 0.9 || toys > LIMITS.toys * 0.9 || l.wires.length > LIMITS.wires * 0.9) {
      limitsOk = false;
      push('maybe', `${doc.levels.length > 1 ? `Level ${i + 1}` : 'The level'} is close to the most parts a level can hold; slower computers may struggle.`);
    }
  });
  if (limitsOk) push('ok', 'Within the size limits.');

  // Played.
  if (playedToEnd) push('ok', 'You played it to the end since your last change.');
  else push('maybe', 'Play it from the first level to the end once, after your last change.');

  return out;
}
