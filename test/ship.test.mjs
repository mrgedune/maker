// Shipping a world: the checklist, the files a web game needs, and the .zip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { checkWorld } from '../site/js/ship/checks.js';
import { playerFiles, EXTRA, specifiers } from '../site/js/ship/export.js';
import { makeZip, crc32 } from '../site/js/ship/zip.js';
import { newWorld, normalize } from '../site/js/kit/format.js';
import { sampleWorld } from './sample-world.mjs';

const SITE = new URL('../site/', import.meta.url);
const read = async (path) => new Uint8Array(await readFile(new URL(path, SITE)));

test('the checklist: a finished world passes, an empty one cannot be finished', () => {
  const good = checkWorld(sampleWorld(), { playedToEnd: true });
  assert.equal(good.filter((c) => c.status === 'no').length, 0);
  assert.ok(good.some((c) => c.text.startsWith('You played it')));
  const empty = checkWorld(normalize(newWorld('Empty')));
  assert.ok(empty.some((c) => c.status === 'no' && /cannot be finished/.test(c.text)));
  const locked = sampleWorld();
  locked.levels[0].parts = locked.levels[0].parts.filter((p) => p.type !== 'key');
  assert.ok(checkWorld(locked).some((c) => c.status === 'no' && /no key/.test(c.text)));
});

test('a web game takes the player and what it imports, and none of the maker', async () => {
  assert.deepEqual(specifiers("import { a } from './a.js';\nexport * from \"../b.js\";\nconst u = new URL('./c.mjs', import.meta.url);\nimport('./d.js');\nimport 'x';"), ['./a.js', '../b.js', './d.js', './c.mjs']);
  const files = await playerFiles(read);
  const paths = [...files.keys()];
  for (const need of ['js/player.js', 'js/play/runner.js', 'js/kit/game.js', 'js/view/scene.js', 'engine/src/index.js', 'vendor/rapier/rapier.mjs', 'js/presets/plain.js'])
    assert.ok(paths.includes(need), `has ${need}`);
  for (const path of paths) assert.ok(!/^js\/(ui\/(build|wiring|characters|together|ship)|net\/|app\.js)/.test(path), `not ${path}`);
  for (const path of EXTRA) await read(path);
});

test('the .zip opens again, file for file', async () => {
  const files = [
    { name: 'index.html', data: new TextEncoder().encode('<!doctype html><p>hello</p>'.repeat(40)) },
    { name: 'js/a.js', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'world.json', data: '{"x":1}' },
  ];
  const zip = new Uint8Array(await (await makeZip(files)).arrayBuffer());
  const view = new DataView(zip.buffer);
  const endAt = zip.length - 22;
  assert.equal(view.getUint32(endAt, true), 0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = zip.subarray(start, start + packed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    assert.equal(crc32(data), crc, name);
    out[name] = data;
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  assert.deepEqual(Object.keys(out), ['index.html', 'js/a.js', 'world.json']);
  assert.equal(new TextDecoder().decode(out['world.json']), '{"x":1}');
  assert.deepEqual([...out['js/a.js']], [1, 2, 3, 4, 5]);
});
