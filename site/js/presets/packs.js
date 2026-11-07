// The fight tunings this copy of the maker offers, and the one new characters
// start with. The public build (tools/build-site.mjs) writes its own packs.js
// with the plain presets alone and leaves rabbit-house.js out.

import { PLAIN } from './plain.js';
import { RABBIT_HOUSE } from './rabbit-house.js';

export const PACKS = { plain: PLAIN, 'rabbit-house': RABBIT_HOUSE };
export const DEFAULT_PACK = 'rabbit-house';
