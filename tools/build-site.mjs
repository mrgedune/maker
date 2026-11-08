// The public site, for Cloudflare Pages to serve as it is (_headers included):
// a copy of site/ with
//   - the plain fight presets alone (the private pack is left out),
//   - only the part of the engine the maker uses: the modules and the
//     statements its imports reach, and of the engine's character models only
//     the ones the maker draws (figure and shape),
//   - no comments in the code, the shaders' included,
//   - nothing that names the private pack, the other games or the studio's
//     own machines; the build stops if anything does.
//   node tools/build-site.mjs [out]      out defaults to dist/

import { cp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve, extname, relative, sep, posix, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJs, stripCss, stripHtml } from './strip-comments.mjs';
import { shake, keepKeys, parseModule, tokenize } from './shake.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const site = join(here, 'site');
const out = resolve(here, process.argv[2] || 'dist');
const rel = (path) => relative(out, path).split(sep).join('/');

// The engine's character models the maker draws (js/view/scene.js); the
// build stops if the maker asks for one not on the list.
const MAKER_ARCHETYPES = ['figure', 'shape'];

// Words that must not be in the public build: the private pack, the other
// games and what is in them, the studio's own people and machines.
const PRIVATE = [
  /rabbit-house\.js/, /RABBIT_HOUSE/, /action-brain/,
  /\bliminal/i, /beyond ?dawn/i, /critical ?response/i, /infinitum/i,
  /\bwarden/i, /\bhider/i, /\bseeker/i, /\bmourner/i, /\bbanshee/i, /\bspecter/i, /\bshambler/i,
  /corp_?guard/i, /\bcorporate\b/i, /scavenger/i, /\bshelter/i, /\bsurvivor/i, /\boperative/i,
  /data_core/i, /tram_car/i, /pod_car/i, /\bskimmer/i, /arc_?bolt/i,
  /\bDavid\b/, /\bTARDIS\b/, /C:\\Projects/i, /\bADR-\d/,
];
// Licences say whose work it is, by name; they ship as written.
const EXEMPT = new Set(['engine/LICENSE.md', 'vendor/rapier/LICENSE']);

await rm(out, { recursive: true, force: true });
await cp(site, out, { recursive: true });

// 1. The fight presets: plain only.
await rm(join(out, 'js/presets/rabbit-house.js'));
await writeFile(
  join(out, 'js/presets/packs.js'),
  `import { PLAIN } from './plain.js';

export const PACKS = { plain: PLAIN };
export const DEFAULT_PACK = 'plain';
`,
);
// Notes for whoever updates the engine copy; not for the site.
await rm(join(out, 'engine/VENDOR.md'));

// 2. The engine: what the maker's modules import from it, and what that needs.
async function files(dir) {
  const list = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) list.push(...(await files(path)));
    else list.push(path);
  }
  return list;
}
const roots = {};
for (const path of await files(join(out, 'js'))) {
  if (extname(path) !== '.js') continue;
  const from = rel(path);
  for (const u of parseModule(readFileSync(path, 'utf8'), from).units) {
    if (u.kind !== 'import' || !u.from.startsWith('.')) continue;
    const target = posix.normalize(posix.join(posix.dirname(from), u.from));
    if (!target.startsWith('engine/')) continue;
    roots[target] ??= [];
    for (const b of u.bindings) roots[target].push(b.imported);
  }
}
// The models the maker asks the engine for must be the ones kept.
for (const path of await files(join(out, 'js'))) {
  for (const m of readFileSync(path, 'utf8').matchAll(/\barchetype:\s*['"]([^'"]+)['"]/g))
    if (!MAKER_ARCHETYPES.includes(m[1])) {
      console.error(`${rel(path)} draws the engine's "${m[1]}" model; add it to MAKER_ARCHETYPES in tools/build-site.mjs.`);
      process.exit(1);
    }
}
// Engine files whose template literals are all shader source, for the
// shaders' comments to go too. The build stops if another file's template
// still holds a comment.
const SHADER_FILES = ['engine/src/renderer/ShaderSources.js', 'engine/src/renderer/StrokeGlyphs.js'];
const engineSource = (path) => {
  let text = stripJs(readFileSync(join(site, path), 'utf8'), { glsl: SHADER_FILES.includes(path) });
  if (path === 'engine/src/renderer/EntityArchetypes.js') text = keepKeys(text, 'ENTITY_MESH_ARCHETYPES', MAKER_ARCHETYPES, { need: MAKER_ARCHETYPES });
  if (path === 'engine/src/renderer/EntityAnimation.js') text = keepKeys(text, 'ENTITY_ANIMATION_PROFILES', MAKER_ARCHETYPES);
  return text;
};
const engine = shake(engineSource, roots);
const engineBefore = (await files(join(out, 'engine/src'))).length;
await rm(join(out, 'engine/src'), { recursive: true });
for (const [path, text] of Object.entries(engine)) {
  const left = tokenize(text).find((t) => t.t === 'tpl' && /\/\/|\/\*/.test(t.v));
  if (left) {
    console.error(`${path} has a comment in a template literal (shader source?); add it to SHADER_FILES in tools/build-site.mjs.`);
    process.exit(1);
  }
  await mkdir(dirname(join(out, path)), { recursive: true });
  await writeFile(join(out, path), text);
}

// 3. No comments in the rest (the engine's went in step 2; vendor/ is
// Rapier's own build, as it ships).
for (const path of await files(out)) {
  const r = rel(path);
  if (r.startsWith('vendor/') || r.startsWith('engine/src/')) continue;
  const strip = { '.js': stripJs, '.mjs': stripJs, '.css': stripCss, '.html': stripHtml }[extname(path)];
  if (strip) await writeFile(path, strip(await readFile(path, 'utf8')));
}

// 4. Nothing in the copy may name what is private.
const TEXT = new Set(['.js', '.mjs', '.html', '.css', '.md', '.json', '.txt', '']);
let count = 0;
let bytes = 0;
const bad = [];
for (const path of await files(out)) {
  const data = await readFile(path);
  count += 1;
  bytes += data.length;
  const r = rel(path);
  if (!TEXT.has(extname(path)) || EXEMPT.has(r) || r.startsWith('vendor/')) continue;
  const text = data.toString('utf8');
  for (const re of PRIVATE) {
    const m = text.match(re);
    if (m) bad.push(`${r}: "${m[0]}"`);
  }
}
if (bad.length) {
  console.error(`The public build names private things:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`Built ${out}: ${count} files, ${(bytes / 1048576).toFixed(1)} MB; plain presets only; engine ${Object.keys(engine).length} of ${engineBefore} modules; no comments.`);
