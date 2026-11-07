// Physics toy world for the rollback test. Runs unchanged in Node and in a browser.
// Z is up, like the engine. Only + - * / and Math.sqrt are used on the game side,
// because Math.sin/cos/pow may round differently between browsers.

export const TICK_HZ = 60;
export const PLAYERS = 4;

const ARENA = 15; // half-size of the walled floor, metres
const PLAYER_SPEED = 6;
const JUMP_SPEED = 6;
const SHOVE_RADIUS = 2.2;
const SHOVE_IMPULSE = 2.5;
const LAUNCH_EVERY = 120; // ticks: a wired "launch pad" machine fires on a timer
const LAUNCH_ZONE = { x: 6, y: 6, r: 2.5 };
const LAUNCH_IMPULSE = 6;

// Input is 3 bytes of game data (CR packs 8): move x, move y (-127..127), buttons.
export const BTN_JUMP = 1;
export const BTN_SHOVE = 2;
export const NO_INPUT = Object.freeze({ mx: 0, my: 0, b: 0 });
export function sameInput(a, b) {
  return a.mx === b.mx && a.my === b.my && a.b === b.b;
}

export function createSim(RAPIER, { toys = 150 } = {}) {
  let world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = 1 / TICK_HZ;

  const fixed = (hx, hy, hz, x, y, z, rot) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(rot ?? { x: 0, y: 0, z: 0, w: 1 }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.8), body);
    return body.handle;
  };

  // Floor, four walls, two platforms and a ramp (15 degrees, quaternion written out).
  fixed(ARENA + 1, ARENA + 1, 0.5, 0, 0, -0.5);
  fixed(0.5, ARENA + 1, 2, ARENA + 0.5, 0, 2);
  fixed(0.5, ARENA + 1, 2, -ARENA - 0.5, 0, 2);
  fixed(ARENA + 1, 0.5, 2, 0, ARENA + 0.5, 2);
  fixed(ARENA + 1, 0.5, 2, 0, -ARENA - 0.5, 2);
  fixed(3, 3, 0.5, -8, 8, 1.5);
  fixed(2, 4, 0.5, 9, -7, 2.5);
  fixed(2, 4, 0.25, 9, -1.5, 1.2, { x: 0.13052619, y: 0, z: 0, w: 0.99144486 });

  // Toys: boxes, balls and barrels stacked in a pile in the middle, so it collapses
  // and everything is awake and touching at the start (the expensive case).
  const toyHandles = [];
  for (let i = 0; i < toys; i++) {
    const col = i % 25;
    const layer = (i - col) / 25;
    const gx = (col % 5) - 2;
    const gy = (col - (col % 5)) / 5 - 2;
    const x = gx * 1.15 + layer * 0.07;
    const y = gy * 1.15 - layer * 0.05;
    const z = 0.6 + layer * 1.1;
    const kind = i % 3;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    const desc =
      kind === 0
        ? RAPIER.ColliderDesc.cuboid(0.45, 0.45, 0.45)
        : kind === 1
          ? RAPIER.ColliderDesc.ball(0.42)
          : RAPIER.ColliderDesc.cylinder(0.45, 0.38);
    world.createCollider(desc.setDensity(kind === 1 ? 0.6 : 1).setFriction(0.6).setRestitution(0.1), body);
    toyHandles.push(body.handle);
  }

  // Players: upright capsules driven by input.
  const starts = [
    [-11, -11],
    [11, -11],
    [-11, 11],
    [11, 11],
  ];
  const playerHandles = starts.map(([x, y]) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, 1.0).lockRotations().setLinearDamping(0.5),
    );
    world.createCollider(
      RAPIER.ColliderDesc.capsule(0.5, 0.35).setRotation({ x: 0.70710678, y: 0, z: 0, w: 0.70710678 }).setFriction(0),
      body,
    );
    return body.handle;
  });

  let tick = 0;

  function applyInputs(inputs) {
    for (let p = 0; p < PLAYERS; p++) {
      const body = world.getRigidBody(playerHandles[p]);
      const inp = inputs[p];
      const v = body.linvel();
      let vz = v.z;
      const pos = body.translation();
      if (inp.b & BTN_JUMP && pos.z < 1.05 && vz < 0.5 && vz > -0.5) vz = JUMP_SPEED;
      body.setLinvel({ x: (PLAYER_SPEED * inp.mx) / 127, y: (PLAYER_SPEED * inp.my) / 127, z: vz }, true);
      if (inp.b & BTN_SHOVE) {
        for (let i = 0; i < toyHandles.length; i++) {
          const t = world.getRigidBody(toyHandles[i]);
          const tp = t.translation();
          const dx = tp.x - pos.x;
          const dy = tp.y - pos.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 0.0001 && d2 < SHOVE_RADIUS * SHOVE_RADIUS) {
            const d = Math.sqrt(d2);
            t.applyImpulse({ x: (dx / d) * SHOVE_IMPULSE, y: (dy / d) * SHOVE_IMPULSE, z: 1 }, true);
          }
        }
      }
    }
    if (tick % LAUNCH_EVERY === LAUNCH_EVERY - 1) {
      for (let i = 0; i < toyHandles.length; i++) {
        const t = world.getRigidBody(toyHandles[i]);
        const tp = t.translation();
        const dx = tp.x - LAUNCH_ZONE.x;
        const dy = tp.y - LAUNCH_ZONE.y;
        if (dx * dx + dy * dy < LAUNCH_ZONE.r * LAUNCH_ZONE.r && tp.z < 2) {
          t.applyImpulse({ x: -1, y: -1, z: LAUNCH_IMPULSE }, true);
        }
      }
    }
  }

  return {
    get tick() {
      return tick;
    },
    step(inputs) {
      applyInputs(inputs);
      world.step();
      tick++;
    },
    // A snapshot is the whole physics world plus our tick counter.
    snapshot() {
      return { tick, bytes: world.takeSnapshot() };
    },
    restore(snap) {
      const next = RAPIER.World.restoreSnapshot(snap.bytes);
      world.free();
      world = next;
      tick = snap.tick;
    },
    // Hash of every moving body's position, rotation and velocity, read back as 32-bit floats.
    hash() {
      const all = playerHandles.concat(toyHandles);
      const f = new Float32Array(all.length * 13);
      let k = 0;
      for (const h of all) {
        const b = world.getRigidBody(h);
        const t = b.translation();
        const r = b.rotation();
        const v = b.linvel();
        const w = b.angvel();
        f[k++] = t.x; f[k++] = t.y; f[k++] = t.z;
        f[k++] = r.x; f[k++] = r.y; f[k++] = r.z; f[k++] = r.w;
        f[k++] = v.x; f[k++] = v.y; f[k++] = v.z;
        f[k++] = w.x; f[k++] = w.y; f[k++] = w.z;
      }
      return hashBytes(new Uint8Array(f.buffer));
    },
    awakeToys() {
      let n = 0;
      for (const h of toyHandles) if (!world.getRigidBody(h).isSleeping()) n++;
      return n;
    },
    free() {
      world.free();
    },
  };
}

// FNV-1a, two lanes, as a 16-hex-digit string.
export function hashBytes(bytes) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
