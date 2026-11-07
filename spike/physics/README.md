# Physics test: can deterministic Rapier run physics toys under co-op rollback?

Run on 2026-11-07 before any maker code, to choose the physics base.

## What it does

`src/sim.js` builds a walled floor with two platforms and a ramp, 150 toys
(boxes, balls and barrels) stacked in a pile so they all fall and touch at the
start, and four player capsules driven by bot input (walk, jump, shove the
toys). A timer-wired "launch pad" throws the toys in one corner every two
seconds.

`src/rollback.js` runs it the way four co-op machines would:

- a reference run that knows every input on time;
- four peers, each with its own world, hearing the other three players' input
  60 ms late plus 0 to 33 ms of jitter (4 to 6 ticks at 60 Hz). Each peer
  guesses a late input (the last one, held), and when the real one differs it
  restores the world to that tick and replays to now, inside the frame;
- the same peer again with 2 ticks of input delay;
- a storm: rewind 8 ticks and replay them on every frame (the worst case);
- step and snapshot cost at 150, 300 and 500 toys.

Every 60 ticks, and at the end, each peer's world is hashed (position,
rotation and velocity of every moving body, as 32-bit floats) and compared
with the reference.

```
npm install --ignore-scripts          # @dimforge/rapier3d-deterministic-compat 0.21.0, pinned
node src/run-node.mjs 3600            # one minute of play, writes results/node.json
node src/run-chromium.cjs 3600        # the same in headless Chromium (Playwright)
node src/compare.mjs                  # do the two agree?
```

## Results (one minute, 3600 ticks)

Machine: the cloud container, Intel Xeon at 2.1 GHz, 4 cores (slower than a
typical gaming PC). Node 22.23.4, Chromium 1243.

| | Result |
| --- | --- |
| Four peers with late input and rollback | all four bit-identical to the reference at all 60 checkpoints and at the end, in Node and in Chromium |
| Node against Chromium | the same hash at every checkpoint (`959dd68a7a3ce121` at the end) |
| The same run twice in one process | identical |
| Rollbacks per peer | about 550 a minute, 4.9 ticks replayed on average, 6 at most |
| Frame cost per peer (rollback + step + snapshot) | 1.4 ms on average, 9.5 ms at the 99th percentile |
| Same with 2 ticks of input delay | 1.2 ms on average, 6.9 ms at the 99th percentile, 2.8 ticks replayed |
| Storm: rewind 8 ticks every frame | 11.4 ms on average, 21.6 ms at the 99th percentile |
| Step, 150 toys all awake | 1.0 ms (2.9 ms p99); later in the run most toys sleep and a step is 0.4 ms |
| Step, 300 / 500 toys | 2.0 ms / 3.7 ms |
| Snapshot, 150 toys | 0.23 ms to take, 0.7 ms to restore, 259 KB (148 KB gzipped) |

## Decision

Rapier's deterministic build is the physics base. It passed the hard part,
identical worlds across rollback and across Node and Chromium, and a normal
frame costs about a tenth of the 16.7 ms budget at 60 fps on a slow machine.
Writing our own solver would cost weeks and do less (no stacking, joints or
cylinders), so it was not built.

What follows from the numbers:

- **The co-op budget is 150 moving toys** per world, shown in the maker while
  you build. 300 also fits a frame on this machine, but leaves less room for
  creatures and drawing on a slow laptop.
- **2 ticks (33 ms) of input delay** is worth having in co-op: it cuts the
  worst frames by about a quarter.
- **The world sent to a joining friend is about 150 KB** gzipped with 150
  toys, which fits the room's chunked transfer.
- Firefox and Safari were not tested here (only Chromium is installed in this
  container). The maker's own determinism test runs in every browser it is
  opened in, so a difference shows up as a failed check rather than a silent
  drift; co-op's drift repair also puts a drifting machine back in step.

## Package vetting (2026-11-07)

`@dimforge/rapier3d-deterministic-compat@0.21.0`: the official dimforge
package (maintainer sebcrozet), published 2026-09-25 by GitHub Actions through
npm trusted publishing with SLSA provenance from `dimforge/rapier` tag
`js-v0.21.0` (commit `b716d375efc0201003f0cd9ef7168eee0b62c177`, confirmed on
GitHub). sha512 `n7JuU62Obljlgq+OeH2DHhTmRSjRzwuJPl54tS9pFIzVQyvXsO5CH+a5KkIRBtnFWDbg1Zicv9BulG0jfBAopA==`
matches the lockfile. No dependencies, no install scripts, Apache-2.0. The npm
advisory database lists no advisories for it. Nothing has been published to
the package since.
