// node src/run-chromium.cjs [ticks] -> runs the same test in headless Chromium, writes results/chromium.json
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === "/" ) file = path.join(root, "src/index.html");
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ticks = process.argv[2] ?? "3600";
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => console.error("[page]", m.text()));
  page.on("pageerror", (e) => console.error("[page error]", e.message));
  // index.html lives in src/, so serve it at /src/ to keep its relative imports working.
  await page.goto(`http://127.0.0.1:${port}/src/index.html?ticks=${ticks}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 0, polling: 1000 });
  const res = await page.evaluate(() => window.__result);
  res.browser = `chromium ${browser.version()}`;
  fs.mkdirSync(path.join(root, "results"), { recursive: true });
  fs.writeFileSync(path.join(root, "results/chromium.json"), JSON.stringify(res, null, 2));
  await browser.close();
  server.close();
  console.log(JSON.stringify({ final: res.referenceFinalHash, peersMatch: res.peersMatchReference, mismatches: res.hashMismatches, secondRunSame: res.secondRunSame, step: res.referenceStepMs, storm: res.storm.frameMs, seconds: res.totalSeconds }));
})().catch((e) => { console.error(e); process.exit(1); });
