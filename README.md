# Rabbit House maker

A block game maker on my own game engine: build a world from a bucket of parts,
wire up machines, make characters that fight, drop in physics toys, and play it
with friends in co-op from a link.

Private while it is being built. Nothing to install: the site is plain
JavaScript modules, and Node 20 or later runs the tools and the tests.

## Working on it

- `npm run serve` serves `site/` at http://localhost:5180 with the live
  site's headers.
- `npm run rooms` runs the co-op room service on this machine at
  ws://127.0.0.1:8787; open the maker with `?rooms=ws://127.0.0.1:8787` to
  use it.
- `npm test` runs the tests: the game steps the same way from the same
  inputs, rollback lands on the same state, co-op sessions stay in step, the
  web game export, the public build, and a scripted player wins every
  example world.

## Examples and the tutorial

- The File menu opens the example worlds (`site/examples/`) as copies, and
  starts the tutorial (`site/js/ui/tutorial.js`): a new world and a card of
  steps that tick off as they are done. A first visit offers both.
- Toy box, Wiring lab and Arena are laid out in `tools/examples.mjs`;
  `node tools/examples.mjs` writes their files after a change. Vault Run is
  the world built through the maker's screens, kept as it is.
- The list in the File menu is `site/js/ui/examples.js`; the tests check it
  matches the files.

## The live site

- `npm run build` writes `dist/`: the site as it goes online.
  - Plain fight presets only (the Rabbit House presets stay in this repo; see
    `docs/rabbit-house-presets.md`).
  - Only the part of the engine the maker uses (`tools/shake.mjs`): of the
    engine's character models, just the figure and the shape. The other
    games' models stay out.
  - No comments in the code or the shaders (`tools/strip-comments.mjs`).
  - The build stops if anything in it names the private presets, the other
    games or what is in them (the list is in `tools/build-site.mjs`).
  - `npm run serve -- 5181 dist` serves it to try before it goes up.
- `dist/` goes to the Cloudflare Pages project `rabbithouse-maker`
  (maker.rabbithouse.art).
- The room service is a Cloudflare Worker with a Durable Object per room,
  deployed from `server/rooms/` with `wrangler deploy`
  (wss://maker-rooms.mrgedune.workers.dev).

## Folders

- `site/` the maker, the player page for exported games, the engine copy
  (`site/engine/`) and Rapier (`site/vendor/rapier/`).
- `server/rooms/` the room service.
- `site/examples/` the example worlds.
- `tools/` the dev server, the local room service, the build and the
  example layouts.
- `e2e/pages/` a page for checking the 3D view by hand.
- `spike/physics/` the test that chose the physics engine (Rapier's
  deterministic build), with its results.
