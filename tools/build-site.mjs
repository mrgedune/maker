// The public site: a copy of site/ without the private fight presets, for
// Cloudflare Pages to serve as it is (_headers included).
//   node tools/build-site.mjs [out]      out defaults to dist/

import { cp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(here, process.argv[2] || 'dist');

await rm(out, { recursive: true, force: true });
await cp(join(here, 'site'), out, { recursive: true });
await rm(join(out, 'js/presets/rabbit-house.js'));
await writeFile(
  join(out, 'js/presets/packs.js'),
  `// The public build: the plain fight presets alone.

import { PLAIN } from './plain.js';

export const PACKS = { plain: PLAIN };
export const DEFAULT_PACK = 'plain';
`,
);

// Nothing in the copy may name the private pack.
const TEXT = new Set(['.js', '.mjs', '.html', '.css', '.md', '.json', '.txt', '']);
const PRIVATE = [/rabbit-house\.js/, /RABBIT_HOUSE/, /action-brain/];
let files = 0, bytes = 0;
const bad = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) await walk(path);
    else {
      files += 1;
      const data = await readFile(path);
      bytes += data.length;
      if (TEXT.has(extname(e.name))) {
        const text = data.toString('utf8');
        for (const re of PRIVATE) if (re.test(text)) bad.push(`${path.slice(out.length + 1)}: ${re}`);
      }
    }
  }
}
await walk(out);
if (bad.length) {
  console.error(`The public build names private files:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`Built ${out}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, plain presets only.`);
