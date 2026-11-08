// The public build: the plain presets alone, the part of the engine the
// maker uses, no comments, nothing private, and it still works.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripJs } from '../tools/strip-comments.mjs';
import { tokenize } from '../tools/shake.mjs';
import { playerFiles } from '../site/js/ship/export.js';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
let out;

before(() => {
  out = join(mkdtempSync(join(tmpdir(), 'maker-build-')), 'dist');
  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/build-site.mjs', import.meta.url)), out], { stdio: 'pipe' });
});
after(() => rmSync(join(out, '..'), { recursive: true, force: true }));

const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
const rel = (path) => relative(out, path).split(sep).join('/');

test('the public build ships the plain presets alone', async () => {
  assert.ok(!existsSync(join(out, 'js/presets/rabbit-house.js')));
  assert.ok(existsSync(join(out, '_headers')));
  assert.ok(existsSync(join(out, 'engine/LICENSE.md')));
  assert.ok(!existsSync(join(out, 'engine/VENDOR.md')));
  const fight = await import(pathToFileURL(join(out, 'js/kit/fight.js')).href);
  assert.deepEqual(Object.keys(fight.PACKS), ['plain']);
  assert.equal(fight.DEFAULT_PACK, 'plain');
  // A world tuned with the private pack still plays, on the plain numbers.
  const t = fight.tuning({ fight: { preset: 'boss', pack: 'rabbit-house', health: 5, tell: 5, parry: 5, speed: 5, damage: 5, moves: { swing: true } } });
  assert.ok(t.health > 0 && t.boss);
});

test('the engine in the public build has only the figure and the shape, drawn as before', async () => {
  const slim = await import(pathToFileURL(join(out, 'engine/src/renderer/EntityArchetypes.js')).href);
  const full = await import(pathToFileURL(join(SITE, 'engine/src/renderer/EntityArchetypes.js')).href);
  assert.deepEqual([...slim.ENTITY_MESH_ARCHETYPE_NAMES], ['figure', 'shape']);
  const ser = (m) => JSON.stringify(m, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : typeof v === 'function' ? String(v) : v instanceof Set ? [...v] : v));
  for (const name of ['figure', 'shape']) {
    const a = slim.ENTITY_MESH_ARCHETYPES[name];
    const b = full.ENTITY_MESH_ARCHETYPES[name];
    assert.equal(ser({ ...a, build: null }), ser({ ...b, build: null }), `${name}'s description changed`);
  }
  const figure = () => ({ x: 1, y: 2, z: 0, heading: 0.3, params: { armL: { raise: 0.4 }, legR: { lift: 0.3 }, props: [{ at: 'handR', kind: 'sword', length: 1 }] } });
  const shape = (kind) => ({ x: 1, y: 2, z: 0.5, params: { kind, sx: 1, sy: 2, sz: 0.5, qx: 0.1, qy: 0.2, qz: 0, qw: 0.97 } });
  assert.equal(ser(slim.ENTITY_MESH_ARCHETYPES.figure.build(figure(), 1.5)), ser(full.ENTITY_MESH_ARCHETYPES.figure.build(figure(), 1.5)));
  for (const kind of ['box', 'ball', 'cylinder'])
    assert.equal(ser(slim.ENTITY_MESH_ARCHETYPES.shape.build(shape(kind), 0)), ser(full.ENTITY_MESH_ARCHETYPES.shape.build(shape(kind), 0)));
  // What the maker imports from the engine is there.
  const engine = await import(pathToFileURL(join(out, 'engine/src/index.js')).href);
  for (const name of ['AsciiEngine', 'createSceneSnapshot', 'createWorldMetrics']) assert.equal(typeof engine[name], 'function', name);
});

test('every module the pages load is in the public build, and nothing else is', async () => {
  const read = async (path) => {
    const file = join(out, path);
    if (!path || path.endsWith('/') || (existsSync(file) && statSync(file).isDirectory())) return new Uint8Array();
    assert.ok(existsSync(file), `${path} is imported but not in the build`);
    return new Uint8Array(readFileSync(file));
  };
  const reached = new Set([...(await playerFiles(read, 'js/app.js')).keys(), ...(await playerFiles(read, 'js/player.js')).keys()]);
  const modules = filesUnder(out).map(rel).filter((p) => /\.m?js$/.test(p) && !p.startsWith('vendor/'));
  assert.deepEqual(modules.filter((p) => !reached.has(p)), []);
});

test('the code in the public build carries no comments', () => {
  for (const path of filesUnder(out)) {
    const r = rel(path);
    if (!/\.m?js$/.test(r) || r.startsWith('vendor/')) continue;
    const text = readFileSync(path, 'utf8');
    assert.equal(stripJs(text), text, `${r} has comments`);
    // Nor does the shader source the engine keeps in template literals.
    if (r.startsWith('engine/')) for (const t of tokenize(text)) if (t.t === 'tpl') assert.ok(!/\/\/|\/\*/.test(t.v), `${r} has a shader comment`);
  }
  for (const r of ['index.html', 'player.html']) assert.ok(!readFileSync(join(out, r), 'utf8').includes('<!--'), `${r} has comments`);
});
