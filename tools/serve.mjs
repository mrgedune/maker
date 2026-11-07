// A static server for working on the maker: no packages, no build step.
//   node tools/serve.mjs [port] [root]     root defaults to site/
// Serves with the headers the live site sends (see site/_headers).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 5180);
const root = resolve(here, process.argv[3] || 'site');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

// The live site's headers for every page (the "/*" block of _headers), so a
// policy that would break the site breaks it here first. Rooms on this
// machine (npm run rooms) are let through too.
async function siteHeaders() {
  const text = await readFile(join(root, '_headers'), 'utf8').catch(() => '');
  const out = {};
  let inAll = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === '/*';
      continue;
    }
    const at = line.indexOf(':');
    if (inAll && at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  if (out['content-security-policy'])
    out['content-security-policy'] = out['content-security-policy'].replace('connect-src', 'connect-src ws://127.0.0.1:* ws://localhost:*');
  return out;
}
const HEADERS = await siteHeaders();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) throw Object.assign(new Error('outside'), { code: 'ENOENT' });
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, {
      ...HEADERS,
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(err.code === 'ENOENT' ? 'Not found' : 'Error');
  }
}).listen(port, () => console.log(`maker: http://localhost:${port}/ (serving ${root})`));
