// One tick of one player's input, as two 32-bit words (8 bytes), the way
// Critical Response sends it (ADR-0015). Every machine steps the world on
// these words, its own player's included, so all of them read the same
// numbers to the last bit.
//
//   word a: yaw (16 bits, a turn in 65536 steps) | pitch (16 bits, -1.5 to 1.5)
//   word b: strafe (8) | forward (8) | buttons (8) | leave (1) | wait (1)

const TURN = Math.PI * 2;
const YAW_STEP = TURN / 65536;
const PITCH = 1.5;
const PITCH_STEP = (PITCH * 2) / 65535;

export const BUTTONS = ['jump', 'attack', 'parry', 'use', 'run'];

const axis = (v) => (Math.max(-127, Math.min(127, Math.round((Number(v) || 0) * 127))) + 256) & 0xff;
const unaxis = (q) => (q > 127 ? q - 256 : q) / 127;

export function pack(input) {
  const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;
  const turn = ((yaw % TURN) + TURN) % TURN;
  const qYaw = Math.round(turn / YAW_STEP) & 0xffff;
  const pitch = Math.max(-PITCH, Math.min(PITCH, Number(input.pitch) || 0));
  const qPitch = Math.round((pitch + PITCH) / PITCH_STEP) & 0xffff;
  const [strafe = 0, forward = 0] = input.move ?? [];
  let bits = 0;
  BUTTONS.forEach((key, i) => {
    if (input[key]) bits |= 1 << i;
  });
  if (input.leave) bits |= 1 << 8;
  if (input.wait) bits |= 1 << 9;
  const a = (qYaw | (qPitch << 16)) >>> 0;
  const b = (axis(strafe) | (axis(forward) << 8) | (bits << 16)) >>> 0;
  return [a, b];
}

export function unpack(a, b) {
  const bits = b >>> 16;
  const input = {
    move: [unaxis(b & 0xff), unaxis((b >>> 8) & 0xff)],
    yaw: (a & 0xffff) * YAW_STEP,
    pitch: (a >>> 16) * PITCH_STEP - PITCH,
  };
  BUTTONS.forEach((key, i) => {
    input[key] = (bits & (1 << i)) !== 0;
  });
  if (bits & (1 << 8)) input.leave = true;
  if (bits & (1 << 9)) input.wait = true;
  return input;
}

// A teammate's input not yet arrived is guessed: what they did last, held.
export const predict = (b) => b >>> 0;
// Standing still, looking where it was: a player whose link is gone.
export const idleFrom = (a) => [a, (1 << 24) >>> 0];
export const WAITING = pack({ wait: true });
export const ARRIVED = pack({});
export const NEUTRAL = Object.freeze(unpack(...pack({})));
