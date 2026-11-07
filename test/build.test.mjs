// The public build leaves the private fight presets out and still works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('the public build ships the plain presets alone', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'maker-build-')), 'dist');
  try {
    execFileSync(process.execPath, [new URL('../tools/build-site.mjs', import.meta.url).pathname, out]);
    assert.ok(!existsSync(join(out, 'js/presets/rabbit-house.js')));
    assert.ok(existsSync(join(out, '_headers')));
    const fight = await import(pathToFileURL(join(out, 'js/kit/fight.js')).href);
    assert.deepEqual(Object.keys(fight.PACKS), ['plain']);
    assert.equal(fight.DEFAULT_PACK, 'plain');
    // A world tuned with the private pack still plays, on the plain numbers.
    const t = fight.tuning({ fight: { preset: 'boss', pack: 'rabbit-house', health: 5, tell: 5, parry: 5, speed: 5, damage: 5, moves: { swing: true } } });
    assert.ok(t.health > 0 && t.boss);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});
