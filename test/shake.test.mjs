// The tools behind the public build: taking comments out changes no code,
// and shaking keeps exactly what is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripJs, stripCss, stripHtml } from '../tools/strip-comments.mjs';
import { shake, keepKeys } from '../tools/shake.mjs';

test('comments go; strings, templates and regexes stay as written', () => {
  const src = [
    '// a line comment',
    "const url = 'https://example.com/a'; // after code",
    'const re = /\\/\\/[^/]*\\/*/g; /* a block */ const n = 4 / 2 / 1;',
    'const t = `// not a comment ${url /* in an expression */} /* nor this */ ${`${n}//`}`;',
    'let a = 1',
    '/* spans',
    '   lines */',
    'let b = 2',
    'if (a) /x/.test(t);',
  ].join('\n');
  const out = stripJs(src);
  assert.equal(
    out,
    [
      "const url = 'https://example.com/a';",
      'const re = /\\/\\/[^/]*\\/*/g;   const n = 4 / 2 / 1;',
      'const t = `// not a comment ${url  } /* nor this */ ${`${n}//`}`;',
      'let a = 1',
      '',
      'let b = 2',
      'if (a) /x/.test(t);',
    ].join('\n'),
  );
  assert.equal(stripJs(out), out);
  assert.equal(stripCss('a { color: red; } /* why */\nb { content: "/* kept */"; }'), 'a { color: red; }\nb { content: "/* kept */"; }');
  assert.equal(stripHtml('<p>x</p>\n<!-- note -->\n<script>// hi\nrun();</script>'), '<p>x</p>\n<script>run();</script>');
  // Shader source loses its comments too, when asked.
  assert.equal(stripJs('const fs = `void main() { // why\n  x = 1; /* how */\n}`;', { glsl: true }), 'const fs = `void main() {\n  x = 1;\n}`;');
  assert.throws(() => stripJs('const fs = `x // ${y}\n`;', { glsl: true }), /runs into/);
});

test('shaking keeps what the importer uses, and what that uses', () => {
  const files = {
    'lib/index.js': [
      "export { used, alsoUsed as renamed } from './a.js';",
      "export * from './b.js';",
      "export * as Unused from './c.js';",
      "export { default as Thing } from './d.js';",
    ].join('\n'),
    'lib/a.js': [
      "import { helper, unusedHelper } from './util.js';",
      "import * as ns from './ns.js';",
      'const TABLE = Object.freeze({ one: 1, two: 2 });',
      'let counter = 0;',
      'const { x, y: [z] } = { x: 1, y: [2] }, w = 3;',
      'export function used() { counter += 1; return helper(TABLE.one) + z; }',
      'export const alsoUsed = () => ns.value + w;',
      'export function dropped() { return unusedHelper(); }',
      'class Dropped extends Object {}',
    ].join('\n'),
    'lib/b.js': "export const fromStar = 1;\nexport const notAsked = 2;",
    'lib/c.js': 'export const never = 1;',
    'lib/d.js': 'export default class Thing { go() { return 1; } }',
    'lib/util.js': "export function helper(n) { return n + 1; }\nexport function unusedHelper() { return 'gone'; }",
    'lib/ns.js': 'export const value = 1;\nexport const other = 2;',
  };
  const kept = shake((p) => files[p], { 'lib/index.js': ['used', 'renamed', 'fromStar', 'Thing'] });
  assert.deepEqual(Object.keys(kept).sort(), ['lib/a.js', 'lib/b.js', 'lib/d.js', 'lib/index.js', 'lib/ns.js', 'lib/util.js']);
  assert.equal(
    kept['lib/index.js'],
    "export { used, alsoUsed as renamed } from './a.js';\n\nexport * from './b.js';\n\nexport { default as Thing } from './d.js';\n",
  );
  const a = kept['lib/a.js'];
  assert.match(a, /^import \{ helper \} from '\.\/util\.js';/);
  assert.match(a, /import \* as ns from '\.\/ns\.js';/);
  for (const s of ['const TABLE', 'let counter', 'const { x, y: [z] }', 'function used', 'const alsoUsed']) assert.ok(a.includes(s), s);
  for (const s of ['dropped', 'Dropped', 'unusedHelper']) assert.ok(!a.includes(s), s);
  assert.ok(!kept['lib/util.js'].includes('unusedHelper'));
  assert.ok(kept['lib/b.js'].includes('fromStar') && !kept['lib/b.js'].includes('notAsked'));
  // A namespace import keeps the whole module.
  assert.ok(kept['lib/ns.js'].includes('other'));
});

test('shaking stops on a module it cannot read safely', () => {
  const files = { 'm.js': 'const a = 1\nconst b = 2;\nexport { a, b };' };
  assert.throws(() => shake((p) => files[p], { 'm.js': ['a'] }), /no semicolon/);
  assert.throws(() => shake(() => 'export const a = 1;', { 'm.js': ['missing'] }), /does not export missing/);
});

test('keepKeys keeps the listed entries of a table', () => {
  const src = "export const T = Object.freeze({\n  a: f('a', { x: 1 }),\n  'b': 2,\n  c: [1, 2],\n});\nconst U = 1;";
  assert.equal(keepKeys(src, 'T', ['a', 'b'], { need: ['a'] }), "export const T = Object.freeze({\n  a: f('a', { x: 1 }),\n  'b': 2\n});\nconst U = 1;");
  assert.throws(() => keepKeys(src, 'T', ['z'], { need: ['z'] }), /has no z/);
});
