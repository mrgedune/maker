// The game a world becomes when you press Play: one world that steps forward
// from players' inputs, the same on every machine (the way Critical
// Response's fights run). Nothing here reads the clock, the DOM or
// Math.random; trigonometry comes from dmath.js and chance from rng.js, so a
// world, a seed and the inputs decide everything.
//
//   const game = createGame({ RAPIER, world, crew: 2, seed: 7 });
//   game.step([input0, input1]);      // one tick, 1/60 s
//   game.save() / game.load(snap)     // for rollback
//   game.hash()                       // for the drift check
//
// Positions are cells (about a metre); x and y on the ground, z up.

import { PART } from './catalog.js';
import { atan2, cos, sin } from './dmath.js';
import { createRng } from './rng.js';
import { tuning, worldFeel } from './fight.js';
import { NEUTRAL } from './input.js';

export const TICK_HZ = 60;
const DT = 1 / TICK_HZ;

export const PLAYER = Object.freeze({
  radius: 0.35,
  half: 0.55, // capsule's half height between the caps: 1.8 tall in all
  eye: 1.62,
  speed: 5.2,
  run: 1.35,
  jump: 8.6,
  gravity: 24,
  health: 100,
  reviveTicks: 180,
  reviveRange: 1.7,
  useRange: 1.9,
  grabRange: 2.1,
  hold: 1.25,
});

// What a player swings with: damage, reach, ticks to the hit, ticks before
// the next swing.
const WEAPON = {
  none: { damage: 18, reach: 2.0, windup: 4, cool: 16, arc: 0.35 },
  sword: { damage: 26, reach: 2.4, windup: 5, cool: 18, arc: 0.3 },
  chainsaw: { damage: 40, reach: 1.9, windup: 8, cool: 26, arc: 0.35 },
  pistol: { damage: 16, reach: 30, windup: 2, cool: 14, arc: 0.985, ranged: true },
};
const PARRY_TICKS = 10;
const INVULN = 24;

const TOY_GRAVITY = -16;
const SIZE_SCALE = (v) => 0.55 + v * 0.17; // a character's size slider: 5 is 1.4x the figure, about 1.8 cells

const hyp2 = (x, y) => x * x + y * y;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createGame({ RAPIER, world: doc, crew = 1, seed = 1, startLevel = 0 }) {
  const characters = new Map(doc.characters.map((c) => [c.id, c]));
  const playerLook = doc.characters.find((c) => c.role === 'player');
  const feel = worldFeel(doc);
  let phys = null; // { world, controller }
  let level = null; // the level document now playing
  let wiresIn = new Map(); // part id -> ids wired into it
  let partById = new Map();
  let events = [];

  const state = {
    tick: 0,
    seed: seed >>> 0,
    rng: 0,
    level: 0,
    phase: 'play', // play | clear | over | won
    phaseT: 0,
    score: 0,
    levelScore: 0,
    keys: 0,
    freeze: 0,
    crew,
    players: [],
    creatures: [],
    parts: {},
    signals: {},
    projectiles: [],
    messages: [],
    nextId: 1,
    boss: null,
    flash: null,
  };
  const rng = createRng(seed);

  // ---------------------------------------------------------------- physics

  function newController(world) {
    const c = world.createCharacterController(0.02);
    c.setUp({ x: 0, y: 0, z: 1 });
    c.enableAutostep(0.55, 0.12, false);
    c.enableSnapToGround(0.35);
    c.setMaxSlopeClimbAngle(0.85);
    c.setMinSlopeSlideAngle(1.0);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setCharacterMass(80);
    return c;
  }

  const Z_UP_CAPSULE = { x: 0.70710678, y: 0, z: 0, w: 0.70710678 }; // Rapier's capsule and cylinder run along y
  const yawQuat = (deg) => {
    const h = (deg * Math.PI) / 360;
    return { x: 0, y: 0, z: sin(h), w: cos(h) };
  };

  // The blocks as few boxes as possible: columns with the same span merge
  // into rectangles.
  function blockBoxes(lv) {
    const [w, h] = lv.size;
    const byspan = new Map();
    for (const [x, y, , b, t] of lv.blocks) {
      const key = `${b}:${t}`;
      if (!byspan.has(key)) byspan.set(key, { b, t, grid: new Uint8Array(w * h) });
      byspan.get(key).grid[y * w + x] = 1;
    }
    const boxes = [];
    for (const { b, t, grid } of byspan.values()) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!grid[y * w + x]) continue;
          let x1 = x;
          while (x1 + 1 < w && grid[y * w + x1 + 1]) x1++;
          let y1 = y;
          grow: while (y1 + 1 < h) {
            for (let k = x; k <= x1; k++) if (!grid[(y1 + 1) * w + k]) break grow;
            y1++;
          }
          for (let yy = y; yy <= y1; yy++) for (let k = x; k <= x1; k++) grid[yy * w + k] = 0;
          boxes.push({ x0: x, y0: y, x1: x1 + 1, y1: y1 + 1, b, t });
        }
    }
    return boxes;
  }

  function fixedBox(world, cx, cy, cz, hx, hy, hz, rot) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz).setRotation(rot ?? { x: 0, y: 0, z: 0, w: 1 }));
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.8), body);
    return body.handle;
  }

  function characterBody(world, x, y, z, scale) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z + (PLAYER.half + PLAYER.radius) * scale));
    world.createCollider(RAPIER.ColliderDesc.capsule(PLAYER.half * scale, PLAYER.radius * Math.min(1.6, scale)).setRotation(Z_UP_CAPSULE).setFriction(0), body);
    return body.handle;
  }

  function toyBody(world, part) {
    const def = PART[part.type];
    const [sx, sy, sz] = part.size;
    const p = part.props;
    const pinned = p.pinned === true;
    const desc = (pinned ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(part.x, part.y, part.z + sz / 2 + 0.002)
      .setRotation(yawQuat(part.turn))
      .setLinearDamping(0.05)
      .setAngularDamping(0.2)
      .setCcdEnabled(def.shape === 'ball');
    const body = world.createRigidBody(desc);
    let shape;
    if (def.shape === 'ball') shape = RAPIER.ColliderDesc.ball(sx / 2);
    else if (def.shape === 'cylinder') shape = RAPIER.ColliderDesc.cylinder(sz / 2, Math.min(sx, sy) / 2).setRotation(Z_UP_CAPSULE);
    else shape = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
    const weight = Number.isFinite(p.weight) ? p.weight : 4;
    shape.setDensity(0.15 + weight * 0.3).setFriction(0.7).setRestitution(Number.isFinite(p.bounce) ? p.bounce * 0.085 : 0.1);
    world.createCollider(shape, body);
    return body.handle;
  }

  function buildLevel(index) {
    if (phys) {
      phys.world.free();
      phys = null;
    }
    level = doc.levels[index];
    partById = new Map(level.parts.map((p) => [p.id, p]));
    wiresIn = new Map();
    for (const w of level.wires) {
      if (!wiresIn.has(w.to)) wiresIn.set(w.to, []);
      wiresIn.get(w.to).push(w.from);
    }
    const world = new RAPIER.World({ x: 0, y: 0, z: TOY_GRAVITY });
    world.timestep = DT;
    const [w, h] = level.size;
    // Floor and the walls round the edge, so nothing leaves the level.
    fixedBox(world, w / 2, h / 2, -0.5, w / 2 + 1, h / 2 + 1, 0.5);
    fixedBox(world, -0.5, h / 2, 10, 0.5, h / 2 + 1, 20);
    fixedBox(world, w + 0.5, h / 2, 10, 0.5, h / 2 + 1, 20);
    fixedBox(world, w / 2, -0.5, 10, w / 2 + 1, 0.5, 20);
    fixedBox(world, w / 2, h + 0.5, 10, w / 2 + 1, 0.5, 20);
    for (const b of blockBoxes(level)) {
      fixedBox(world, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.b + b.t) / 2, (b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2, (b.t - b.b) / 2);
    }
    phys = { world, controller: newController(world) };

    state.level = index;
    state.parts = {};
    state.signals = {};
    state.creatures = [];
    state.projectiles = [];
    state.boss = null;
    state.keys = 0;
    for (const part of level.parts) {
      const def = PART[part.type];
      const rt = {};
      state.parts[part.id] = rt;
      const [sx, sy, sz] = part.size;
      if (def.kind === 'toy') {
        rt.body = toyBody(world, part);
        rt.held = -1;
        rt.gone = false;
        rt.speed = 0;
      } else if (part.type === 'seesaw') {
        const rot = yawQuat(part.turn);
        const pivotH = 0.45;
        const pivot = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(part.x, part.y, part.z + pivotH / 2).setRotation(rot));
        world.createCollider(RAPIER.ColliderDesc.cuboid(0.12, sy / 2, pivotH / 2), pivot);
        const plank = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(part.x, part.y, part.z + pivotH + sz / 2 + 0.01).setRotation(rot).setAngularDamping(0.3));
        world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setDensity(0.2 + part.props.weight * 0.15).setFriction(0.9), plank);
        world.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: 0, z: pivotH / 2 + 0.01 }, { x: 0, y: 0, z: -sz / 2 }, { x: 0, y: 1, z: 0 }), pivot, plank, true);
        rt.body = plank.handle;
        rt.pivot = pivot.handle;
      } else if (part.type === 'spring') {
        rt.body = fixedBox(world, part.x, part.y, part.z + sz / 2, sx / 2, sy / 2, sz / 2, yawQuat(part.turn));
        rt.fired = -999;
      } else if (part.type === 'breakable' || part.type === 'target') {
        rt.body = fixedBox(world, part.x, part.y, part.z + sz / 2, sx / 2, sy / 2, sz / 2, yawQuat(part.turn));
        rt.hits = 0;
        rt.gone = false;
        rt.hitT = -999;
      } else if (part.type === 'door') {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(part.x, part.y, part.z + sz / 2).setRotation(yawQuat(part.turn)));
        world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setFriction(0.5), body);
        rt.body = body.handle;
        rt.open = part.props.startsOpen ? 1 : 0;
        rt.latched = Boolean(part.props.startsOpen && part.props.stayOpen);
        rt.unlocked = !part.props.locked;
      } else if (def.kind === 'item') {
        rt.taken = false;
      } else if (part.type === 'creature') {
        const ch = characters.get(part.props.character) ?? [...characters.values()].find((c) => c.role !== 'player');
        if (ch) spawnCreature(ch, part.x, part.y, part.z, part.turn, part.id, part.props.waits ? 'wait' : 'idle');
        rt.down = false;
      } else if (part.type === 'lever') {
        rt.on = Boolean(part.props.startsOn);
      } else if (part.type === 'toggle') {
        rt.on = Boolean(part.props.startsOn);
      } else if (part.type === 'button') {
        rt.until = -1;
      } else if (part.type === 'counter') {
        rt.count = 0;
      } else if (part.type === 'delay') {
        rt.queue = [];
        rt.last = false;
        rt.out = false;
      } else if (part.type === 'random') {
        rt.until = -1;
      } else if (part.type === 'spawner') {
        rt.alive = [];
      }
      state.signals[part.id] = false;
    }
    placePlayers();
  }

  function starts() {
    const list = level.parts.filter((p) => p.type === 'start');
    if (list.length) return list;
    const [w, h] = level.size;
    return [{ x: w / 2, y: h / 2, z: 0, turn: 0 }];
  }

  function newPlayer(slot) {
    return {
      slot, x: 0, y: 0, z: 0, vz: 0, yaw: 0, pitch: 0, grounded: true, body: -1,
      health: PLAYER.health, down: false, out: false, revive: 0, invuln: 0,
      attackT: -1, cool: 0, parryT: 0, blocking: false, held: null, buttons: 0,
      kx: 0, ky: 0, moving: 0, hitT: -999,
    };
  }

  function placePlayers() {
    const list = starts();
    for (const p of state.players) {
      if (p.out) {
        p.body = -1;
        continue;
      }
      const s = list[p.slot % list.length];
      const spread = Math.floor(p.slot / list.length);
      const x = s.x + spread * 0.9;
      const y = s.y;
      p.body = characterBody(phys.world, x, y, s.z, 1);
      p.x = x;
      p.y = y;
      p.z = s.z;
      p.vz = 0;
      p.yaw = (s.turn * Math.PI) / 180;
      p.pitch = 0;
      p.health = PLAYER.health;
      p.down = false;
      p.revive = 0;
      p.invuln = 60;
      p.held = null;
      p.attackT = -1;
      p.cool = 0;
    }
  }

  function spawnCreature(ch, x, y, z, turn, partId, mode) {
    const tun = tuning(ch, state.crew, doc.coop.tougher);
    const scale = SIZE_SCALE(ch.size) / 1.4;
    const id = `c${state.nextId++}`;
    const c = {
      id, char: ch.id, part: partId, x, y, z, vz: 0, yaw: (turn * Math.PI) / 180, scale,
      health: tun.health, max: tun.health, stage: 0, state: mode, t: 0, move: null, target: -1,
      cool: 30, hit: false, stuck: 0, side: 0, sideT: 0, lastX: x, lastY: y, hitT: -999, seen: false, sees: false, lost: 0, n: state.nextId,
      body: characterBody(phys.world, x, y, z, scale),
    };
    state.creatures.push(c);
    if (tun.boss && !state.boss) state.boss = id;
    return c;
  }

  // Moves a character's capsule through the world; returns where it ended up.
  function moveCharacter(handle, dx, dy, dz, ignore = -1) {
    const world = phys.world;
    const body = world.getRigidBody(handle);
    const collider = body.collider(0);
    const filter = ignore >= 0 ? (c) => c.parent()?.handle !== ignore : undefined;
    phys.controller.computeColliderMovement(collider, { x: dx, y: dy, z: dz }, undefined, undefined, filter);
    const m = phys.controller.computedMovement();
    const t = body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    body.setNextKinematicTranslation(next);
    return { next, moved: m, grounded: phys.controller.computedGrounded() };
  }

  const footZ = (p, scale = 1) => phys.world.getRigidBody(p.body).translation().z - (PLAYER.half + PLAYER.radius) * scale;

  // How far a line goes before blocks, walls or a shut door stop it. Toys and
  // characters do not block a line.
  function doorBodies() {
    const set = new Set();
    for (const part of level.parts) if (part.type === 'door') set.add(state.parts[part.id].body);
    return set;
  }
  function wallDistance(ox, oy, oz, dx, dy, dz, max) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const doors = doorBodies();
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx / len, y: dy / len, z: dz / len });
    const hit = phys.world.castRay(ray, max, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined, (col) => {
      const b = col.parent();
      return !b || b.isFixed() || doors.has(b.handle);
    });
    return hit ? hit.timeOfImpact : max;
  }
  function clearLine(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.05) return true;
    return wallDistance(ax, ay, az, dx, dy, dz, d) >= d - 0.05;
  }
  const chest = (o, scale = 1) => o.z + 1.1 * scale;

  // ---------------------------------------------------------------- events

  const emit = (e) => events.push(e);
  function message(text, seconds = 4) {
    state.messages.push({ text, until: state.tick + Math.round(seconds * TICK_HZ) });
    if (state.messages.length > 3) state.messages.shift();
  }
  function hitstop(kind) {
    if (state.crew !== 1) return; // never in co-op: freezing one freezes everyone
    const n = feel.hitstopSolo?.[kind] ?? 0;
    state.freeze = Math.max(state.freeze, n);
  }

  // ---------------------------------------------------------------- damage

  function hurtPlayer(p, damage, fromX, fromY, kind, creature) {
    if (p.down || p.out || p.invuln > 0) return 'missed';
    const dx = fromX - p.x;
    const dy = fromY - p.y;
    const len = Math.sqrt(hyp2(dx, dy)) || 1;
    const facing = (cos(p.yaw) * dx + sin(p.yaw) * dy) / len > 0.3;
    if (kind !== 'slam' && p.parryT > 0 && facing) {
      if (creature) {
        const tun = tuning(characters.get(creature.char), state.crew, doc.coop.tougher);
        creature.state = 'stagger';
        creature.t = tun.stagger;
        creature.move = null;
      }
      emit({ t: 'parry', x: p.x, y: p.y, z: p.z + 1.2, slot: p.slot });
      hitstop('parry');
      state.flash = { kind: 'parry', tick: state.tick };
      p.parryT = 0;
      return 'parried';
    }
    let dmg = damage;
    if (p.blocking && facing && kind !== 'slam') dmg = Math.round(dmg * 0.3);
    p.health -= dmg;
    p.invuln = INVULN;
    p.hitT = state.tick;
    p.kx = (-dx / len) * 7;
    p.ky = (-dy / len) * 7;
    emit({ t: 'hurt', slot: p.slot, x: p.x, y: p.y, z: p.z + 1, amount: dmg });
    if (p.health <= 0) {
      p.health = 0;
      p.down = true;
      p.revive = 0;
      if (p.held) dropHeld(p, 0);
      emit({ t: 'down', slot: p.slot, x: p.x, y: p.y, z: p.z });
    }
    return 'hit';
  }

  function hurtCreature(c, damage, fromX, fromY, heavy = false) {
    if (c.state === 'dead') return;
    c.health -= damage;
    c.hitT = state.tick;
    c.seen = true;
    const dx = c.x - fromX;
    const dy = c.y - fromY;
    const len = Math.sqrt(hyp2(dx, dy)) || 1;
    c.kx = (dx / len) * (heavy ? 6 : 3);
    c.ky = (dy / len) * (heavy ? 6 : 3);
    emit({ t: 'hit', id: c.id, x: c.x, y: c.y, z: c.z + 1.2 * c.scale, amount: damage });
    if (c.state === 'idle' || c.state === 'wait') c.state = 'chase';
    if (c.health <= 0) {
      c.health = 0;
      c.state = 'dead';
      c.t = 0;
      hitstop('kill');
      emit({ t: 'kill', id: c.id, x: c.x, y: c.y, z: c.z, boss: state.boss === c.id });
      creatureDown(c);
    } else {
      hitstop(heavy ? 'heavy' : 'hit');
    }
  }

  function explode(x, y, z, size, source) {
    const radius = 1.6 + size * 0.35;
    emit({ t: 'boom', x, y, z, radius });
    state.flash = { kind: 'boom', tick: state.tick };
    const world = phys.world;
    for (const part of level.parts) {
      const rt = state.parts[part.id];
      if (part.id === source) continue;
      const def = PART[part.type];
      if ((def.kind === 'toy' || part.type === 'seesaw') && !rt.gone) {
        const body = world.getRigidBody(rt.body);
        const t = body.translation();
        const dx = t.x - x, dy = t.y - y, dz = t.z - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < radius * radius * 1.6) {
          const d = Math.sqrt(d2) || 0.1;
          const k = (1 - d / (radius * 1.27)) * 9 * body.mass();
          if (k > 0) body.applyImpulse({ x: (dx / d) * k, y: (dy / d) * k, z: k * 0.8 }, true);
          if (part.type === 'barrel' && part.props.explodes && d < radius * 0.8 && rt.fuse === undefined) rt.fuse = state.tick + 8;
        }
      } else if ((part.type === 'breakable' || part.type === 'target') && !rt.gone) {
        const dx = part.x - x, dy = part.y - y;
        if (hyp2(dx, dy) < (radius + 0.6) * (radius + 0.6)) {
          if (part.type === 'breakable') breakPart(part, rt);
          else rt.hitT = state.tick;
        }
      }
    }
    for (const p of state.players) {
      if (p.out || p.down) continue;
      const d2 = hyp2(p.x - x, p.y - y) + (p.z + 0.9 - z) ** 2;
      if (d2 < radius * radius) {
        const d = Math.sqrt(d2);
        p.invuln = 0;
        hurtPlayer(p, Math.round(45 * (1 - d / radius)) + 5, x, y, 'slam', null);
        p.vz = Math.max(p.vz, 6);
      }
    }
    for (const c of state.creatures) {
      if (c.state === 'dead') continue;
      const d2 = hyp2(c.x - x, c.y - y);
      if (d2 < radius * radius) hurtCreature(c, Math.round(70 * (1 - Math.sqrt(d2) / radius)) + 10, x, y, true);
    }
  }

  function breakPart(part, rt) {
    if (rt.gone) return;
    rt.gone = true;
    const body = phys.world.getRigidBody(rt.body);
    if (body) phys.world.removeRigidBody(body);
    emit({ t: 'break', x: part.x, y: part.y, z: part.z + part.size[2] / 2, id: part.id });
  }

  function creatureDown(c) {
    for (const part of level.parts) {
      if (part.type === 'down') {
        const rt = state.parts[part.id];
        const which = part.props.which;
        if (which === 'all') {
          if (state.creatures.every((x) => x.state === 'dead')) rt.pulse = state.tick;
        } else if (which === c.part) rt.pulse = state.tick;
      }
      if (part.type === 'spawner') {
        const rt = state.parts[part.id];
        rt.alive = rt.alive.filter((id) => id !== c.id);
      }
    }
    if (c.part && state.parts[c.part]) state.parts[c.part].down = state.tick;
  }

  // ---------------------------------------------------------------- players

  const edge = (p, input, key, bit) => input[key] && !(p.buttons & bit);
  const BIT = { jump: 1, attack: 2, parry: 4, use: 8, run: 16 };
  const bitsOf = (input) => (input.jump ? 1 : 0) | (input.attack ? 2 : 0) | (input.parry ? 4 : 0) | (input.use ? 8 : 0) | (input.run ? 16 : 0);

  function heldPoint(p) {
    const cp = cos(p.pitch);
    return {
      x: p.x + cos(p.yaw) * PLAYER.hold * cp,
      y: p.y + sin(p.yaw) * PLAYER.hold * cp,
      z: p.z + PLAYER.eye - 0.35 - sin(p.pitch) * PLAYER.hold,
    };
  }

  function dropHeld(p, speed) {
    const rt = state.parts[p.held];
    p.held = null;
    if (!rt || rt.gone) return;
    rt.held = -1;
    const body = phys.world.getRigidBody(rt.body);
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    if (speed > 0) {
      const cp = cos(p.pitch);
      body.setLinvel({ x: cos(p.yaw) * cp * speed, y: sin(p.yaw) * cp * speed, z: -sin(p.pitch) * speed + 2.5 }, true);
      rt.thrown = state.tick;
      emit({ t: 'throw', slot: p.slot });
    }
  }

  function nearestUsable(p) {
    let best = null;
    let bestD = PLAYER.useRange * PLAYER.useRange;
    for (const part of level.parts) {
      if (part.type !== 'button' && part.type !== 'lever') continue;
      const d = hyp2(part.x - p.x, part.y - p.y);
      if (d < bestD && Math.abs(part.z - (p.z + 0.9)) < 2) {
        best = part;
        bestD = d;
      }
    }
    return best;
  }

  function nearestCarry(p) {
    let best = null;
    let bestScore = Infinity;
    const fx = cos(p.yaw), fy = sin(p.yaw);
    for (const part of level.parts) {
      if (PART[part.type].kind !== 'toy' || !part.props.carry || part.props.pinned) continue;
      const rt = state.parts[part.id];
      if (rt.gone || rt.held >= 0) continue;
      const t = phys.world.getRigidBody(rt.body).translation();
      const dx = t.x - p.x, dy = t.y - p.y;
      const d2 = hyp2(dx, dy);
      if (d2 > PLAYER.grabRange * PLAYER.grabRange || Math.abs(t.z - (p.z + 0.8)) > 1.6) continue;
      const d = Math.sqrt(d2) || 0.01;
      if ((fx * dx + fy * dy) / d < 0.2 && d > 0.8) continue;
      if (d2 < bestScore) {
        best = part;
        bestScore = d2;
      }
    }
    return best;
  }

  function attack(p) {
    const weapon = WEAPON[playerLook?.look?.held] ?? WEAPON.none;
    const fx = cos(p.yaw), fy = sin(p.yaw);
    const cp = cos(p.pitch);
    emit({ t: weapon.ranged ? 'shot' : 'swing', slot: p.slot, x: p.x, y: p.y, z: p.z + PLAYER.eye });
    if (weapon.ranged) {
      // A shot: the nearest creature in a narrow cone, unless a wall is nearer.
      const ox = p.x, oy = p.y, oz = p.z + PLAYER.eye;
      const dir = { x: fx * cp, y: fy * cp, z: -sin(p.pitch) };
      const wall = wallDistance(ox, oy, oz, dir.x, dir.y, dir.z, weapon.reach);
      let best = null;
      let bestD = wall;
      for (const c of state.creatures) {
        if (c.state === 'dead') continue;
        const dx = c.x - ox, dy = c.y - oy, dz = c.z + 1.1 * c.scale - oz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestD + 0.6 && (dir.x * dx + dir.y * dy + dir.z * dz) / d > weapon.arc) {
          best = c;
          bestD = d;
        }
      }
      if (best) hurtCreature(best, weapon.damage, p.x, p.y);
      hitThings(p, Math.min(wall, 30), 0.99, weapon.damage, true);
      return;
    }
    let landed = false;
    for (const c of state.creatures) {
      if (c.state === 'dead') continue;
      const dx = c.x - p.x, dy = c.y - p.y;
      const d = Math.sqrt(hyp2(dx, dy)) || 0.01;
      if (d < weapon.reach + c.scale * 0.3 && (fx * dx + fy * dy) / d > weapon.arc && Math.abs(c.z - p.z) < 2 && clearLine(p.x, p.y, chest(p), c.x, c.y, chest(c, c.scale))) {
        hurtCreature(c, weapon.damage, p.x, p.y, weapon.damage >= 35);
        landed = true;
      }
    }
    if (doc.coop.friendlyFire)
      for (const q of state.players) {
        if (q === p || q.out || q.down) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        const d = Math.sqrt(hyp2(dx, dy)) || 0.01;
        if (d < weapon.reach && (fx * dx + fy * dy) / d > weapon.arc && clearLine(p.x, p.y, chest(p), q.x, q.y, chest(q))) hurtPlayer(q, Math.round(weapon.damage / 2), p.x, p.y, 'swing', null);
      }
    hitThings(p, weapon.reach, weapon.arc, weapon.damage, false);
    if (landed) emit({ t: 'landed', slot: p.slot });
  }

  // A swing or a shot also knocks toys, sets off barrels, breaks walls and
  // trips targets.
  function hitThings(p, reach, arc, damage, ranged) {
    const fx = cos(p.yaw), fy = sin(p.yaw);
    for (const part of level.parts) {
      const rt = state.parts[part.id];
      const def = PART[part.type];
      if (rt.gone) continue;
      let px = part.x, py = part.y, pz = part.z;
      if (def.kind === 'toy' || part.type === 'seesaw') {
        const t = phys.world.getRigidBody(rt.body).translation();
        px = t.x;
        py = t.y;
        pz = t.z;
      } else if (part.type !== 'breakable' && part.type !== 'target') continue;
      const dx = px - p.x, dy = py - p.y;
      const d = Math.sqrt(hyp2(dx, dy)) || 0.01;
      const half = Math.max(part.size[0], part.size[1]) / 2;
      if (d > reach + half || (fx * dx + fy * dy) / d < (ranged ? arc : arc * 0.8) || pz - p.z > 2.6) continue;
      if (part.type === 'barrel' && part.props.explodes) {
        rt.fuse = state.tick + (ranged ? 1 : 4);
      } else if (def.kind === 'toy' || part.type === 'seesaw') {
        const body = phys.world.getRigidBody(rt.body);
        if (body.isDynamic()) {
          const k = (ranged ? 2 : 4.5) * body.mass();
          body.applyImpulse({ x: fx * k, y: fy * k, z: k * 0.35 }, true);
        }
      } else if (part.type === 'breakable') {
        if (part.props.hits > 0 && ++rt.hits >= part.props.hits) breakPart(part, rt);
        else emit({ t: 'clank', x: px, y: py, z: pz + 1 });
      } else if (part.type === 'target') {
        rt.hitT = state.tick;
        emit({ t: 'ding', x: px, y: py, z: pz + 0.5 });
      }
    }
  }

  function stepPlayer(p, input) {
    if (p.out) return;
    const bits = bitsOf(input);
    if (input.leave) {
      leavePlayer(p);
      return;
    }
    p.yaw = input.yaw;
    p.pitch = clamp(input.pitch, -1.45, 1.45);
    if (p.invuln > 0) p.invuln--;
    if (p.parryT > 0) p.parryT--;
    if (p.cool > 0) p.cool--;

    let dx = 0, dy = 0;
    if (p.down) {
      // Down: still, waiting for a teammate to stand over you.
      let helped = false;
      for (const q of state.players)
        if (q !== p && !q.out && !q.down && hyp2(q.x - p.x, q.y - p.y) < PLAYER.reviveRange * PLAYER.reviveRange) helped = true;
      p.revive = helped ? p.revive + 1 : Math.max(0, p.revive - 2);
      if (p.revive >= PLAYER.reviveTicks) {
        p.down = false;
        p.health = 40;
        p.invuln = 90;
        p.revive = 0;
        emit({ t: 'revived', slot: p.slot, x: p.x, y: p.y, z: p.z });
      }
    } else {
      const [strafe, forward] = input.move;
      const fx = cos(p.yaw), fy = sin(p.yaw);
      const speed = PLAYER.speed * (input.run ? PLAYER.run : 1) * (p.blocking ? 0.55 : 1) * (p.held ? 0.85 : 1);
      dx = (fx * forward - fy * strafe) * speed * DT;
      dy = (fy * forward + fx * strafe) * speed * DT;
      p.moving = Math.abs(forward) + Math.abs(strafe) > 0.1 ? 1 : 0;
      if (edge(p, input, 'jump', BIT.jump) && p.grounded) {
        p.vz = PLAYER.jump;
        emit({ t: 'jump', slot: p.slot });
      }
      if (edge(p, input, 'parry', BIT.parry)) p.parryT = PARRY_TICKS;
      p.blocking = input.parry && p.parryT === 0;
      if (edge(p, input, 'use', BIT.use)) {
        const usable = nearestUsable(p);
        if (usable) {
          const rt = state.parts[usable.id];
          if (usable.type === 'button') rt.until = state.tick + Math.max(1, Math.round(usable.props.hold * TICK_HZ));
          else rt.on = !rt.on;
          emit({ t: 'use', id: usable.id, x: usable.x, y: usable.y, z: usable.z });
        } else if (p.held) {
          dropHeld(p, 3);
        } else {
          const toy = nearestCarry(p);
          if (toy) {
            const rt = state.parts[toy.id];
            rt.held = p.slot;
            p.held = toy.id;
            phys.world.getRigidBody(rt.body).setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
            emit({ t: 'grab', slot: p.slot });
          }
        }
      }
      if (edge(p, input, 'attack', BIT.attack) && p.cool === 0) {
        if (p.held) {
          dropHeld(p, 13);
          p.cool = 12;
        } else {
          const weapon = WEAPON[playerLook?.look?.held] ?? WEAPON.none;
          p.attackT = 0;
          p.cool = weapon.cool;
        }
      }
      if (p.attackT >= 0) {
        const weapon = WEAPON[playerLook?.look?.held] ?? WEAPON.none;
        p.attackT++;
        if (p.attackT === weapon.windup) attack(p);
        if (p.attackT > weapon.windup + 8) p.attackT = -1;
      }
    }
    // Knockback fades out.
    dx += p.kx * DT;
    dy += p.ky * DT;
    p.kx *= 0.82;
    p.ky *= 0.82;
    if (Math.abs(p.kx) < 0.01) p.kx = 0;
    if (Math.abs(p.ky) < 0.01) p.ky = 0;

    p.vz -= PLAYER.gravity * DT;
    const held = p.held ? state.parts[p.held].body : -1;
    const r = moveCharacter(p.body, dx, dy, p.vz * DT, held);
    if (r.grounded && p.vz < 0) p.vz = 0;
    if (p.vz > 0 && r.moved.z < p.vz * DT * 0.5) p.vz = 0; // a ceiling
    p.grounded = r.grounded;
    p.x = r.next.x;
    p.y = r.next.y;
    p.z = r.next.z - (PLAYER.half + PLAYER.radius);
    p.buttons = bits;

    if (p.held) {
      const rt = state.parts[p.held];
      if (!rt || rt.gone) p.held = null;
      else {
        const at = heldPoint(p);
        phys.world.getRigidBody(rt.body).setNextKinematicTranslation(at);
      }
    }
  }

  function leavePlayer(p) {
    if (p.out) return;
    if (p.held) dropHeld(p, 0);
    p.out = true;
    p.down = false;
    if (p.body >= 0) {
      const body = phys.world.getRigidBody(p.body);
      if (body) phys.world.removeRigidBody(body);
    }
    p.body = -1;
    emit({ t: 'left', slot: p.slot });
  }

  // ---------------------------------------------------------------- creatures

  function stepCreature(c) {
    const ch = characters.get(c.char);
    const tun = tuning(ch, state.crew, doc.coop.tougher);
    if (c.state === 'dead') {
      c.t++;
      if (c.t === 90 && c.body >= 0) {
        const body = phys.world.getRigidBody(c.body);
        if (body) phys.world.removeRigidBody(body);
        c.body = -1;
      }
      return;
    }
    // Stages, for a boss: each one changes the terms.
    if (tun.stages) {
      const ratio = c.health / c.max;
      let stage = 0;
      for (let i = 0; i < tun.stages.length; i++) if (ratio <= tun.stages[i].at) stage = i;
      if (stage > c.stage) {
        c.stage = stage;
        emit({ t: 'stage', id: c.id, stage, x: c.x, y: c.y, z: c.z });
        for (const part of level.parts) if (part.type === 'down' && part.props.which === `stage:${c.part}`) state.parts[part.id].pulse = state.tick;
      }
    }
    const st = tun.stages ? tun.stages[c.stage] : { tell: 1, speed: 1, cooldown: 1 };
    // The nearest player standing.
    let target = null;
    let best = Infinity;
    for (const p of state.players) {
      if (p.out || p.down) continue;
      const d = hyp2(p.x - c.x, p.y - c.y);
      if (d < best) {
        best = d;
        target = p;
      }
    }
    const dist = Math.sqrt(best);
    // Sight is checked a few times a second, not every tick.
    if (target && (state.tick + c.n) % 6 === 0) c.sees = clearLine(c.x, c.y, c.z + 1.5 * c.scale, target.x, target.y, target.z + PLAYER.eye);
    const sees = Boolean(target && c.sees);
    let dx = 0, dy = 0;
    const speed = tun.speed * st.speed;
    const face = (tx, ty, rate) => {
      const want = atan2(ty - c.y, tx - c.x);
      let diff = want - c.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      c.yaw += clamp(diff, -rate, rate);
    };
    if (c.cool > 0) c.cool--;

    switch (c.state) {
      case 'wait':
        if (sees && dist < Math.max(4, tun.sight * 0.6)) {
          c.state = 'chase';
          c.seen = true;
          emit({ t: 'alert', id: c.id, x: c.x, y: c.y, z: c.z });
        }
        break;
      case 'idle':
        if (sees && dist < tun.sight) {
          c.state = 'chase';
          c.seen = true;
          emit({ t: 'alert', id: c.id, x: c.x, y: c.y, z: c.z });
        }
        break;
      case 'chase': {
        if (!target) {
          c.state = 'idle';
          break;
        }
        // Out of sight for long enough, it gives up and waits.
        c.lost = sees ? 0 : c.lost + 1;
        if (c.lost > 240) {
          c.state = 'idle';
          c.lost = 0;
          break;
        }
        face(target.x, target.y, 0.18);
        if (c.cool === 0 && sees) {
          const options = [];
          const w = tun.weights;
          const reach = tun.reach * Math.max(1, c.scale * 0.8);
          if (w.swing && dist <= reach + 0.3) options.push(['swing', w.swing]);
          if (w.slam && dist <= 2.8 + c.scale * 0.4) options.push(['slam', w.slam]);
          if (w.charge && dist > 3 && dist < 10) options.push(['charge', w.charge]);
          if (w.throw && dist > 4 && dist < 16) options.push(['throw', w.throw]);
          if (options.length) {
            let total = 0;
            for (const [, wt] of options) total += wt;
            let roll = rng.next() * total;
            let pick = options[0][0];
            for (const [m, wt] of options) {
              if ((roll -= wt) < 0) {
                pick = m;
                break;
              }
            }
            c.move = pick;
            c.state = 'tell';
            c.t = Math.max(6, Math.round(tun.tell * st.tell * (pick === 'slam' ? 1.3 : pick === 'charge' ? 1.1 : 1)));
            c.target = target.slot;
            emit({ t: 'tell', id: c.id, move: pick, x: c.x, y: c.y, z: c.z + 1.4 * c.scale, ticks: c.t });
            break;
          }
        }
        // Approach, or circle at a distance (a duellist).
        const fx = cos(c.yaw), fy = sin(c.yaw);
        const reach = tun.reach * Math.max(1, c.scale * 0.8);
        if (tun.circle > 0 && dist < tun.circle + 1.2 && c.cool > 0) {
          const dir = c.side || 1;
          dx = -fy * dir * speed * 0.6 * DT;
          dy = fx * dir * speed * 0.6 * DT;
          if (dist < tun.circle - 0.5) {
            dx -= fx * speed * 0.4 * DT;
            dy -= fy * speed * 0.4 * DT;
          }
        } else if (dist > reach * 0.75) {
          dx = fx * speed * DT;
          dy = fy * speed * DT;
        }
        // Stuck on a wall: step sideways for a moment.
        if (c.sideT > 0) {
          c.sideT--;
          dx = -fy * c.side * speed * DT;
          dy = fx * c.side * speed * DT;
        }
        break;
      }
      case 'tell':
        if (target && c.move !== 'charge') face(target.x, target.y, 0.12);
        else if (target) face(target.x, target.y, 0.05);
        if (--c.t <= 0) {
          c.state = 'strike';
          c.t = c.move === 'charge' ? 24 : tun.strike;
          c.hit = false;
          emit({ t: 'strike', id: c.id, move: c.move, x: c.x, y: c.y, z: c.z });
          if (c.move === 'throw' && target) {
            const sx = c.x + cos(c.yaw) * 0.8, sy = c.y + sin(c.yaw) * 0.8, sz = c.z + 1.4 * c.scale;
            const tx = target.x - sx, ty = target.y - sy, tz = target.z + 1 - sz;
            const d = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            state.projectiles.push({ id: state.nextId++, x: sx, y: sy, z: sz, vx: (tx / d) * 13, vy: (ty / d) * 13, vz: (tz / d) * 13 + 1.5, ttl: 120, from: c.id, damage: tun.damage });
          }
          if (c.move === 'slam') {
            emit({ t: 'slam', id: c.id, x: c.x, y: c.y, z: c.z, radius: 2.8 + c.scale * 0.4 });
            for (const p of state.players) {
              if (p.out || p.down) continue;
              if (hyp2(p.x - c.x, p.y - c.y) < (2.8 + c.scale * 0.4) ** 2 && p.grounded && clearLine(c.x, c.y, c.z + 0.5, p.x, p.y, p.z + 0.5)) hurtPlayer(p, Math.round(tun.damage * 1.3), c.x, c.y, 'slam', c);
            }
            for (const part of level.parts) {
              const rt = state.parts[part.id];
              if (PART[part.type].kind !== 'toy' || rt.gone || rt.held >= 0) continue;
              const body = phys.world.getRigidBody(rt.body);
              const t = body.translation();
              if (body.isDynamic() && hyp2(t.x - c.x, t.y - c.y) < 16) body.applyImpulse({ x: 0, y: 0, z: 4 * body.mass() }, true);
            }
          }
        }
        break;
      case 'strike': {
        const fx = cos(c.yaw), fy = sin(c.yaw);
        if (c.move === 'charge') {
          dx = fx * speed * 2.6 * DT;
          dy = fy * speed * 2.6 * DT;
        }
        if (!c.hit && (c.move === 'swing' || c.move === 'charge')) {
          const reach = c.move === 'swing' ? tun.reach * Math.max(1, c.scale * 0.8) + 0.2 : 1.1 * c.scale;
          for (const p of state.players) {
            if (p.out || p.down) continue;
            const px = p.x - c.x, py = p.y - c.y;
            const d = Math.sqrt(hyp2(px, py)) || 0.01;
            if (d < reach && (fx * px + fy * py) / d > 0.25 && Math.abs(p.z - c.z) < 2.2 * c.scale && clearLine(c.x, c.y, chest(c, c.scale), p.x, p.y, chest(p))) {
              c.hit = true;
              const result = hurtPlayer(p, tun.damage, c.x, c.y, c.move, c);
              if (result === 'parried') return;
              break;
            }
          }
        }
        if (--c.t <= 0) {
          c.state = 'recover';
          c.t = tun.recover;
        }
        break;
      }
      case 'recover':
        if (--c.t <= 0) {
          c.state = 'chase';
          c.cool = Math.round(tun.cooldown * st.cooldown);
          c.side = rng.next() < 0.5 ? -1 : 1;
        }
        break;
      case 'stagger':
        if (--c.t <= 0) {
          c.state = 'chase';
          c.cool = Math.round(tun.cooldown * 0.5);
        }
        break;
      default:
        break;
    }
    // Knockback.
    dx += (c.kx || 0) * DT;
    dy += (c.ky || 0) * DT;
    c.kx = (c.kx || 0) * 0.8;
    c.ky = (c.ky || 0) * 0.8;
    if (Math.abs(c.kx) < 0.01) c.kx = 0;
    if (Math.abs(c.ky) < 0.01) c.ky = 0;
    c.vz -= PLAYER.gravity * DT;
    const r = moveCharacter(c.body, dx, dy, c.vz * DT);
    if (r.grounded && c.vz < 0) c.vz = 0;
    const wanted = hyp2(dx, dy);
    const got = hyp2(r.moved.x, r.moved.y);
    if (c.state === 'chase' && wanted > 1e-6 && got < wanted * 0.15) {
      if (++c.stuck > 18) {
        c.stuck = 0;
        c.side = rng.next() < 0.5 ? -1 : 1;
        c.sideT = 30;
      }
    } else c.stuck = 0;
    c.x = r.next.x;
    c.y = r.next.y;
    c.z = r.next.z - (PLAYER.half + PLAYER.radius) * c.scale;
    c.moving = got > 1e-6 ? 1 : 0;
  }

  function stepProjectiles() {
    const keep = [];
    for (const s of state.projectiles) {
      s.vz -= 6 * DT;
      s.x += s.vx * DT;
      s.y += s.vy * DT;
      s.z += s.vz * DT;
      let hit = false;
      for (const p of state.players) {
        if (p.out || p.down) continue;
        if (hyp2(p.x - s.x, p.y - s.y) < 0.5 && s.z > p.z && s.z < p.z + 1.9) {
          const creature = state.creatures.find((c) => c.id === s.from) ?? null;
          hurtPlayer(p, s.damage, s.x - s.vx * 0.1, s.y - s.vy * 0.1, 'shot', creature);
          hit = true;
          break;
        }
      }
      const [w, h] = level.size;
      if (!hit && (s.z < 0 || s.x < 0 || s.y < 0 || s.x > w || s.y > h || --s.ttl <= 0 || solidAt(s.x, s.y, s.z))) hit = true;
      if (hit) emit({ t: 'splat', x: s.x, y: s.y, z: s.z });
      else keep.push(s);
    }
    state.projectiles = keep;
  }

  let columns = null;
  function solidAt(x, y, z) {
    if (!columns || columns.level !== level) {
      columns = { level, map: new Map() };
      for (const [bx, by, , b, t] of level.blocks) {
        const key = by * 1000 + bx;
        if (!columns.map.has(key)) columns.map.set(key, []);
        columns.map.get(key).push([b, t]);
      }
    }
    const spans = columns.map.get(Math.floor(y) * 1000 + Math.floor(x));
    return Boolean(spans?.some(([b, t]) => z >= b && z <= t));
  }

  // ---------------------------------------------------------------- machines

  const anyIn = (id, prev) => (wiresIn.get(id) ?? []).some((from) => prev[from]);
  const allIn = (id, prev) => {
    const list = wiresIn.get(id) ?? [];
    return list.length > 0 && list.every((from) => prev[from]);
  };
  const hasIn = (id) => (wiresIn.get(id) ?? []).length > 0;

  function inBox(part, x, y, z, pad = 0) {
    // Turned by quarter turns only for the area test (zones, plates, launchers).
    const quarter = Math.round(part.turn / 90) % 2 === 1;
    const hx = (quarter ? part.size[1] : part.size[0]) / 2 + pad;
    const hy = (quarter ? part.size[0] : part.size[1]) / 2 + pad;
    return Math.abs(x - part.x) <= hx && Math.abs(y - part.y) <= hy && z >= part.z - 0.3 && z <= part.z + Math.max(part.size[2], 0.3) + pad;
  }

  function somethingIn(part, who, pad = 0) {
    if (who === 'players' || who === 'anything')
      for (const p of state.players) if (!p.out && !p.down && inBox(part, p.x, p.y, p.z + 0.1, pad)) return true;
    if (who === 'creatures' || who === 'anything')
      for (const c of state.creatures) if (c.state !== 'dead' && inBox(part, c.x, c.y, c.z + 0.1, pad)) return true;
    if (who === 'toys' || who === 'anything')
      for (const q of level.parts) {
        const rt = state.parts[q.id];
        if ((PART[q.type].kind !== 'toy' && q.type !== 'seesaw') || rt.gone) continue;
        const t = phys.world.getRigidBody(rt.body).translation();
        if (inBox(part, t.x, t.y, t.z - q.size[2] / 2 + 0.05, pad)) return true;
      }
    return false;
  }

  function stepMachines() {
    const prev = state.signals;
    const next = {};
    const now = state.tick;
    for (const part of level.parts) {
      const rt = state.parts[part.id];
      let out = false;
      switch (part.type) {
        case 'button':
          out = rt.until > now;
          break;
        case 'lever':
          out = rt.on;
          break;
        case 'plate':
          out = somethingIn(part, part.props.who === 'players' ? 'players' : 'anything', 0.05);
          if (out !== Boolean(rt.pressed)) emit({ t: out ? 'press' : 'release', id: part.id, x: part.x, y: part.y, z: part.z });
          rt.pressed = out;
          break;
        case 'zone':
          out = somethingIn(part, part.props.who);
          break;
        case 'target': {
          // Toys hitting it count too.
          if (!rt.gone)
            for (const q of level.parts) {
              const qt = state.parts[q.id];
              if (PART[q.type].kind !== 'toy' || qt.gone) continue;
              const body = phys.world.getRigidBody(qt.body);
              const t = body.translation();
              const v = body.linvel();
              if (hyp2(t.x - part.x, t.y - part.y) < 1.1 && Math.abs(t.z - (part.z + part.size[2] / 2)) < 1 && hyp2(v.x, v.y) + v.z * v.z > 9) rt.hitT = now;
            }
          out = now - rt.hitT < 30;
          break;
        }
        case 'down':
          out = rt.pulse === now - 1 || rt.pulse === now;
          break;
        case 'creature':
          out = rt.down === now - 1 || rt.down === now;
          break;
        case 'timer': {
          const every = Math.max(1, Math.round(part.props.every * TICK_HZ));
          const running = !hasIn(part.id) || anyIn(part.id, prev);
          if (running) {
            rt.t = (rt.t ?? 0) + 1;
            if (rt.t >= every) {
              rt.t = 0;
              out = true;
            }
          } else rt.t = 0;
          break;
        }
        case 'and':
          out = allIn(part.id, prev);
          break;
        case 'or':
          out = anyIn(part.id, prev);
          break;
        case 'not':
          out = !anyIn(part.id, prev);
          break;
        case 'delay': {
          const v = anyIn(part.id, prev);
          if (v !== rt.last) {
            rt.queue.push([now + Math.max(1, Math.round(part.props.seconds * TICK_HZ)), v]);
            rt.last = v;
          }
          while (rt.queue.length && rt.queue[0][0] <= now) rt.out = rt.queue.shift()[1];
          out = rt.out;
          break;
        }
        case 'counter': {
          const v = anyIn(part.id, prev);
          if (v && !rt.last) rt.count++;
          rt.last = v;
          out = rt.count >= part.props.target;
          break;
        }
        case 'random': {
          const v = anyIn(part.id, prev);
          if (v && !rt.last && rng.next() * 10 < part.props.chance) rt.until = now + 30;
          rt.last = v;
          out = rt.until > now;
          break;
        }
        case 'toggle': {
          const v = anyIn(part.id, prev);
          if (v && !rt.last) rt.on = !rt.on;
          rt.last = v;
          out = rt.on;
          break;
        }
        default:
          break;
      }
      next[part.id] = out;
    }
    // Doers act on what reaches them.
    for (const part of level.parts) {
      const def = PART[part.type];
      if (!def.in || def.kind === 'logic' || part.type === 'timer') continue;
      const rt = state.parts[part.id];
      const on = anyIn(part.id, prev);
      const rising = on && !rt.wasOn;
      rt.wasOn = on;
      switch (part.type) {
        case 'door': {
          if (part.props.stayOpen && on) rt.latched = true;
          const wired = hasIn(part.id);
          const want = rt.latched || (rt.unlocked && part.props.locked && !wired) || (wired && on) || (!wired && !part.props.locked && part.props.startsOpen) ? 1 : 0;
          const before = rt.open;
          rt.open = clamp(rt.open + (want ? 1 : -1) * DT * 1.6, 0, 1);
          if (before === 0 && rt.open > 0) emit({ t: 'door', id: part.id, x: part.x, y: part.y, z: part.z, open: true });
          if (before === 1 && rt.open < 1) emit({ t: 'door', id: part.id, x: part.x, y: part.y, z: part.z, open: false });
          const body = phys.world.getRigidBody(rt.body);
          body.setNextKinematicTranslation({ x: part.x, y: part.y, z: part.z + part.size[2] / 2 - rt.open * (part.size[2] + 0.05) });
          break;
        }
        case 'spawner':
          if (rising) {
            const ch = characters.get(part.props.character) ?? [...characters.values()].find((c) => c.role !== 'player');
            if (ch && rt.alive.length < part.props.most) {
              const c = spawnCreature(ch, part.x, part.y, part.z, part.turn, null, 'chase');
              c.seen = true;
              rt.alive.push(c.id);
              emit({ t: 'spawn', id: c.id, x: part.x, y: part.y, z: part.z });
            }
          }
          break;
        case 'launcher':
          if (rising) launch(part);
          break;
        case 'sound':
          if (rising) emit({ t: 'sound', name: part.props.sound, x: part.x, y: part.y, z: part.z });
          break;
        case 'effect':
          if (rising) {
            emit({ t: 'effect', name: part.props.effect, x: part.x, y: part.y, z: part.z });
            if (part.props.effect === 'flash') state.flash = { kind: 'effect', tick: now };
          }
          break;
        case 'score':
          if (rising) {
            state.score += part.props.amount;
            emit({ t: 'score', amount: part.props.amount });
          }
          break;
        case 'message':
          if (rising) message(part.props.text, part.props.seconds);
          break;
        case 'win':
          if (rising) finishLevel();
          break;
        case 'lose':
          if (rising) gameOver();
          break;
        case 'lamp':
          rt.on = !hasIn(part.id) || on;
          break;
        default:
          break;
      }
    }
    state.signals = next;
  }

  function launch(part) {
    const strength = 4 + part.props.strength * 1.6;
    const lift = part.props.lift * 1.4;
    const fx = cos((part.turn * Math.PI) / 180), fy = sin((part.turn * Math.PI) / 180);
    emit({ t: 'launch', id: part.id, x: part.x, y: part.y, z: part.z });
    for (const p of state.players)
      if (!p.out && !p.down && inBox(part, p.x, p.y, p.z + 0.1)) {
        p.vz = Math.max(p.vz, lift);
        p.kx += fx * strength;
        p.ky += fy * strength;
      }
    for (const c of state.creatures)
      if (c.state !== 'dead' && inBox(part, c.x, c.y, c.z + 0.1)) {
        c.vz = Math.max(c.vz, lift);
        c.kx = (c.kx || 0) + fx * strength;
        c.ky = (c.ky || 0) + fy * strength;
      }
    for (const q of level.parts) {
      const rt = state.parts[q.id];
      if (PART[q.type].kind !== 'toy' || rt.gone || rt.held >= 0) continue;
      const body = phys.world.getRigidBody(rt.body);
      const t = body.translation();
      if (body.isDynamic() && inBox(part, t.x, t.y, t.z - q.size[2] / 2 + 0.05)) {
        const m = body.mass();
        body.applyImpulse({ x: fx * strength * m * 0.6, y: fy * strength * m * 0.6, z: lift * m * 0.8 }, true);
      }
    }
  }

  // Spring pads, barrels' fuses and hard landings, items.
  function stepThings() {
    const now = state.tick;
    for (const part of level.parts) {
      const rt = state.parts[part.id];
      const def = PART[part.type];
      if (part.type === 'spring') {
        const top = part.z + part.size[2];
        const power = 7 + part.props.strength * 1.4;
        let fired = false;
        for (const p of state.players) {
          if (p.out || p.down || p.vz > 0.1) continue;
          if (Math.abs(p.x - part.x) < part.size[0] / 2 + 0.2 && Math.abs(p.y - part.y) < part.size[1] / 2 + 0.2 && Math.abs(p.z - top) < 0.25) {
            p.vz = power;
            fired = true;
          }
        }
        for (const c of state.creatures) {
          if (c.state === 'dead' || c.vz > 0.1) continue;
          if (Math.abs(c.x - part.x) < part.size[0] / 2 + 0.2 && Math.abs(c.y - part.y) < part.size[1] / 2 + 0.2 && Math.abs(c.z - top) < 0.25) {
            c.vz = power;
            fired = true;
          }
        }
        for (const q of level.parts) {
          const qt = state.parts[q.id];
          if (PART[q.type].kind !== 'toy' || qt.gone || qt.held >= 0) continue;
          const body = phys.world.getRigidBody(qt.body);
          if (!body.isDynamic()) continue;
          const t = body.translation();
          const v = body.linvel();
          if (Math.abs(t.x - part.x) < part.size[0] / 2 && Math.abs(t.y - part.y) < part.size[1] / 2 && t.z - q.size[2] / 2 - top < 0.15 && v.z < 0.5) {
            body.setLinvel({ x: v.x, y: v.y, z: power * 0.9 }, true);
            fired = true;
          }
        }
        if (fired && now - rt.fired > 10) {
          rt.fired = now;
          emit({ t: 'spring', id: part.id, x: part.x, y: part.y, z: part.z });
        }
      } else if (part.type === 'barrel' && !rt.gone) {
        const body = phys.world.getRigidBody(rt.body);
        const v = body.linvel();
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        // Thrown or knocked hard into something: boom.
        if (part.props.explodes && rt.held < 0 && rt.speed > 7 && rt.speed - speed > 4.5 && rt.fuse === undefined) rt.fuse = now + 1;
        rt.speed = speed;
        if (rt.fuse !== undefined && now >= rt.fuse) {
          const t = body.translation();
          for (const p of state.players) if (p.held === part.id) p.held = null;
          rt.gone = true;
          phys.world.removeRigidBody(body);
          explode(t.x, t.y, t.z, part.props.blast, part.id);
        }
      } else if (def.kind === 'item' && !rt.taken && part.type !== 'exit') {
        for (const p of state.players) {
          if (p.out || p.down) continue;
          if (hyp2(p.x - part.x, p.y - part.y) < 0.9 && part.z - p.z < 1.9 && p.z - part.z < 1.2) {
            if (part.type === 'health' && p.health >= PLAYER.health) continue;
            rt.taken = true;
            if (part.type === 'key') {
              state.keys++;
              message('Picked up a key.', 2);
            } else if (part.type === 'gem') state.score += part.props.value;
            else if (part.type === 'health') p.health = Math.min(PLAYER.health, p.health + part.props.amount);
            emit({ t: 'pickup', kind: part.type, x: part.x, y: part.y, z: part.z });
            break;
          }
        }
      } else if (part.type === 'door' && part.props.locked && !rt.unlocked) {
        for (const p of state.players) {
          if (p.out || p.down) continue;
          if (hyp2(p.x - part.x, p.y - part.y) < (Math.max(part.size[0], part.size[1]) / 2 + 0.9) ** 2) {
            if (state.keys > 0) {
              state.keys--;
              rt.unlocked = true;
              rt.latched = true;
              emit({ t: 'unlock', id: part.id, x: part.x, y: part.y, z: part.z });
            } else if (!rt.told || now - rt.told > 180) {
              rt.told = now;
              message('Locked. It needs a key.', 2);
            }
          }
        }
      } else if (part.type === 'exit') {
        const standing = state.players.filter((p) => !p.out && !p.down);
        const inside = standing.filter((p) => inBox(part, p.x, p.y, p.z + 0.1, 0.1));
        if (inside.length && (!part.props.everyone || inside.length === standing.length)) finishLevel();
      }
    }
  }

  // ---------------------------------------------------------------- flow

  function finishLevel() {
    if (state.phase !== 'play') return;
    const last = state.level >= doc.levels.length - 1;
    state.phase = last ? 'won' : 'clear';
    state.phaseT = 0;
    emit({ t: last ? 'won' : 'clear' });
  }

  function gameOver() {
    if (state.phase !== 'play') return;
    state.phase = 'over';
    state.phaseT = 0;
    emit({ t: 'over' });
  }

  function stepFlow() {
    state.phaseT++;
    if (state.phase === 'clear' && state.phaseT >= 150) {
      state.levelScore = state.score;
      buildLevel(state.level + 1);
      state.phase = 'play';
      state.phaseT = 0;
      emit({ t: 'level', index: state.level });
    } else if (state.phase === 'over' && state.phaseT >= 170) {
      state.score = state.levelScore;
      buildLevel(state.level);
      state.phase = 'play';
      state.phaseT = 0;
      emit({ t: 'level', index: state.level, again: true });
    }
  }

  // ---------------------------------------------------------------- step

  function step(inputs) {
    events = [];
    if (state.phase !== 'play') {
      // Players keep their inputs' edges, so a held button does not fire on
      // the first tick back.
      for (let i = 0; i < state.players.length; i++) state.players[i].buttons = bitsOf(inputs[i] ?? NEUTRAL);
      stepFlow();
      state.tick++;
      return events;
    }
    if (state.freeze > 0) {
      state.freeze--;
      state.tick++;
      return events;
    }
    for (let i = 0; i < state.players.length; i++) stepPlayer(state.players[i], inputs[i] ?? NEUTRAL);
    for (let i = 0; i < state.creatures.length; i++) stepCreature(state.creatures[i]);
    stepMachines();
    stepThings();
    phys.world.step();
    stepProjectiles();
    // Anyone fallen out of the world comes back to a start.
    for (const p of state.players) {
      if (p.out || p.z > -12) continue;
      const s = starts()[0];
      phys.world.getRigidBody(p.body).setTranslation({ x: s.x, y: s.y, z: s.z + 1 }, true);
      p.health -= 25;
      p.vz = 0;
    }
    const standing = state.players.filter((p) => !p.out);
    if (standing.length && standing.every((p) => p.down)) gameOver();
    state.messages = state.messages.filter((m) => m.until > state.tick);
    state.tick++;
    state.rng = rng.getState();
    return events;
  }

  // A player joining a run under way (co-op drop-in): next slot, at a start.
  function addPlayer() {
    const p = newPlayer(state.players.length);
    state.players.push(p);
    const s = starts()[p.slot % starts().length];
    p.body = characterBody(phys.world, s.x, s.y, s.z, 1);
    p.x = s.x;
    p.y = s.y;
    p.z = s.z;
    p.invuln = 120;
    return p;
  }

  // ---------------------------------------------------------------- save, load, hash

  function save() {
    return { tick: state.tick, state: structuredClone(state), phys: phys.world.takeSnapshot(), rng: rng.getState(), level: state.level };
  }

  function load(snap) {
    const s = structuredClone(snap.state);
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, s);
    rng.setState(snap.rng);
    if (level !== doc.levels[snap.level]) {
      level = doc.levels[snap.level];
      partById = new Map(level.parts.map((p) => [p.id, p]));
      wiresIn = new Map();
      for (const w of level.wires) {
        if (!wiresIn.has(w.to)) wiresIn.set(w.to, []);
        wiresIn.get(w.to).push(w.from);
      }
    }
    const world = RAPIER.World.restoreSnapshot(snap.phys);
    phys.world.free();
    phys = { world, controller: newController(world) };
  }

  function hashBytes(bytes, h1 = 0x811c9dc5, h2 = 0x9e3779b9) {
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
      h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995) ^ (h2 >>> 15);
    }
    return [h1 >>> 0, h2 >>> 0];
  }

  // A 32-bit fingerprint of everything that matters: the game's own state and
  // every moving body, as the physics has it.
  function hash() {
    const text = JSON.stringify(state);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    let [a, b] = hashBytes(bytes);
    const f = new Float32Array(13);
    const u = new Uint8Array(f.buffer);
    phys.world.forEachRigidBody((body) => {
      if (body.isFixed()) return;
      const t = body.translation(), r = body.rotation(), v = body.linvel(), w = body.angvel();
      f[0] = body.handle; f[1] = t.x; f[2] = t.y; f[3] = t.z; f[4] = r.x; f[5] = r.y; f[6] = r.z; f[7] = r.w;
      f[8] = v.x; f[9] = v.y; f[10] = v.z; f[11] = w.x; f[12] = w.y;
      [a, b] = hashBytes(u, a, b);
    });
    return (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  }

  // ---------------------------------------------------------------- start

  for (let i = 0; i < crew; i++) state.players.push(newPlayer(i));
  rng.setState((seed >>> 0) || 1);
  buildLevel(Math.max(0, Math.min(doc.levels.length - 1, startLevel)));

  return {
    state,
    doc,
    feel,
    get level() {
      return level;
    },
    get physics() {
      return phys;
    },
    get world() {
      return phys.world;
    },
    characters,
    step,
    save,
    load,
    hash,
    addPlayer,
    get players() {
      return state.players;
    },
    get tick() {
      return state.tick;
    },
    // Where a body is, for drawing.
    pose(handle) {
      const body = phys.world.getRigidBody(handle);
      if (!body) return null;
      const t = body.translation();
      const r = body.rotation();
      return { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w };
    },
    lastEvents: () => events,
  };
}
