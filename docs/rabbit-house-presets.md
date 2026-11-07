# Rabbit House fight presets

`site/js/presets/rabbit-house.js` holds the studio's tuned fight presets. They
are private: the public build (`node tools/build-site.mjs`) leaves that file
out and ships `plain.js` alone, so the live site at maker.rabbithouse.art
offers the plain presets only. A game exported from a local copy of the maker
carries the numbers it uses, but not this explanation.

The numbers were tuned from the studio's fight brain (studio-hq
docs/action-brain). The brain's rules stay in studio-hq; what is here is only
what the numbers came to, by rule:

- 13, 32: the player's best move gets the biggest moment. A parry stops the
  world for about a quarter of a second (solo) on a full flash.
- 32: stops sized to the hit: 0.1 s a hit, 0.17 s heavy, 0.25 s a parry.
- 34: a fight starts at full pitch: no slow walk-up; creatures see you
  further and close faster.
- 5: the calmer fighter reads as stronger. The boss's first stage is slow and
  heavy; it speeds up as it cracks.
- 11, 8: each stage changes the terms and the colour of the room.
- 12: the last move takes the longest, and the fight ends in quiet.
- 36, 38: the boss is named on arrival; one line teaches the parry.
