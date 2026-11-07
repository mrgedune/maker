// node src/compare.mjs -> do Node and Chromium agree on every checkpoint hash?
import { readFileSync } from "node:fs";
const a = JSON.parse(readFileSync("results/node.json", "utf8"));
const b = JSON.parse(readFileSync("results/chromium.json", "utf8"));
let same = a.ticks === b.ticks && a.referenceFinalHash === b.referenceFinalHash;
let checks = 0;
for (const [k, h] of Object.entries(a.referenceCheckHashes)) { checks++; if (b.referenceCheckHashes[k] !== h) { same = false; console.log("differs at tick", k); } }
console.log(JSON.stringify({ ticks: a.ticks, checkpoints: checks, node: a.referenceFinalHash, chromium: b.referenceFinalHash, nodePeersMatch: a.peersMatchReference, chromiumPeersMatch: b.peersMatchReference, nodeAndChromiumAgree: same }));
process.exit(same ? 0 : 1);
