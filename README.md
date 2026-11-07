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
  web game export, and the public build.

## The live site

- `npm run build` writes `dist/`: the site as it goes online, with the plain
  fight presets only (the Rabbit House presets stay in this repo; see
  `docs/rabbit-house-presets.md`).
- `dist/` goes to the Cloudflare Pages project `rabbithouse-maker`
  (maker.rabbithouse.art).
- The room service is a Cloudflare Worker with a Durable Object per room,
  deployed from `server/rooms/` with `wrangler deploy`
  (wss://maker-rooms.mrgedune.workers.dev).

## Folders

- `site/` the maker, the player page for exported games, the engine copy
  (`site/engine/`) and Rapier (`site/vendor/rapier/`).
- `server/rooms/` the room service.
- `tools/` the dev server, the local room service and the build.
- `e2e/pages/` a page for checking the 3D view by hand.
- `spike/physics/` the test that chose the physics engine (Rapier's
  deterministic build), with its results.
