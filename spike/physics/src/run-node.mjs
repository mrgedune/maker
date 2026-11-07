// node src/run-node.mjs [ticks]  -> prints results, writes results/node.json
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { runAll } from "./rollback.js";

await RAPIER.init();
const ticks = Number(process.argv[2] ?? 3600);
const res = await runAll(RAPIER, { ticks, log: (s) => console.error("..", s) });
res.where = `node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} cores`;
res.rapier = RAPIER.version();
{
  const sim = (await import("./sim.js")).createSim(RAPIER, { toys: res.toys });
  for (let t = 0; t < 300; t++) sim.step([0, 1, 2, 3].map(() => ({ mx: 0, my: 0, b: 0 })));
  const snap = sim.snapshot().bytes;
  res.snapshotGzipBytesAfter5s = gzipSync(snap).length;
  res.snapshotBytesAfter5s = snap.length;
  sim.free();
}
mkdirSync("results", { recursive: true });
writeFileSync("results/node.json", JSON.stringify(res, null, 2));
const { peers, withInputDelay, scale, referenceCheckHashes, ...top } = res;
console.log(JSON.stringify(top, null, 1));
for (const p of peers.concat([res.withInputDelay])) console.log(JSON.stringify({ peer: p.peer, final: p.finalHash, rollbacks: p.rollbacks, wrong: `${p.guessesWrong}/${p.guesses}`, frame: p.frameMs, step: p.stepMs, snap: p.snapshotMs, restore: p.restoreMs, replay: p.replayTicks }));
