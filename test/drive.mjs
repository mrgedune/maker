// A scripted player for the node simulation: walk to a point, face a thing,
// press a key. The example tests play the example worlds with it.

import { createGame } from '../site/js/kit/game.js';
import { normalize } from '../site/js/kit/format.js';

export function drive(RAPIER, world, { seed = 1 } = {}) {
  const game = createGame({ RAPIER, world: normalize(world), crew: 1, seed });
  const events = [];
  const p = () => game.state.players[0];
  let yaw = p()?.yaw ?? 0;
  let pitch = 0;
  const playing = () => game.state.phase === 'play';
  const d = {
    game,
    events,
    get p() {
      return p();
    },
    step(input = {}) {
      if (input.yaw !== undefined) yaw = input.yaw;
      if (input.pitch !== undefined) pitch = input.pitch;
      for (const e of game.step([{ move: [0, 0], ...input, yaw, pitch }])) events.push(e);
    },
    wait(n) {
      for (let i = 0; i < n && playing(); i++) d.step();
    },
    // Walk to (x, y); jump when stuck. False if it did not get there.
    goTo(x, y, { tol = 0.3, max = 900, run = false, jumpAt = null } = {}) {
      let last = { x: p().x, y: p().y };
      for (let i = 0; i < max && playing(); i++) {
        const dx = x - p().x, dy = y - p().y;
        const dist = Math.hypot(dx, dy);
        if (dist < tol) return true;
        let jump = false;
        if (i % 20 === 19) {
          if (Math.hypot(p().x - last.x, p().y - last.y) < 0.15) jump = true;
          last = { x: p().x, y: p().y };
        }
        if (jumpAt && jumpAt(p())) jump = true;
        d.step({ move: [0, dist < 0.8 ? 0.4 : 1], yaw: Math.atan2(dy, dx), jump, run });
      }
      return Math.hypot(x - p().x, y - p().y) < tol;
    },
    path(points, opts) {
      for (const [x, y] of points) if (!d.goTo(x, y, opts)) return false;
      return true;
    },
    face(x, y, look = 0) {
      d.step({ yaw: Math.atan2(y - p().y, x - p().x), pitch: look });
      d.step();
    },
    press(key) {
      d.step({ [key]: true });
      d.step();
      d.step();
    },
    // Fight the nearest creature in range (of those who() picks) until none
    // are left: swing when close, parry a swing as it comes, back off from a
    // slam. 'low' when health drops under lowHp first.
    fight({ range = 30, max = 60 * 90, lowHp = 0, who = () => true } = {}) {
      let lastSwing = -99, lastParry = -99;
      for (let i = 0; i < max && playing(); i++) {
        const me = p();
        const near = game.state.creatures
          .filter((c) => c.state !== 'dead' && who(c))
          .map((c) => ({ c, dist: Math.hypot(c.x - me.x, c.y - me.y) }))
          .filter((n) => n.dist < range)
          .sort((a, b) => a.dist - b.dist);
        if (!near.length) return true;
        if (lowHp && me.health < lowHp) return 'low';
        const { c, dist } = near[0];
        const yaw = Math.atan2(c.y - me.y, c.x - me.x);
        const reach = 2.2 + (c.scale ?? 1) * 0.3;
        if (c.state === 'tell' && c.move === 'slam' && dist < 3.2 * Math.max(1, c.scale ?? 1)) {
          d.step({ move: [0, -1], yaw });
          continue;
        }
        const parry = c.state === 'tell' && c.move !== 'slam' && c.t <= 6 && i - lastParry > 24 && dist < reach + 1.5;
        const attack = !parry && dist < reach && i - lastSwing >= 20;
        if (parry) lastParry = i;
        if (attack) lastSwing = i;
        d.step({ move: [0, dist > reach - 0.6 ? 1 : 0], yaw, parry, attack });
      }
      return !playing() ? game.state.phase : false;
    },
    seen: (t) => events.some((e) => e.t === t),
  };
  return d;
}
