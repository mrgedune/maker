// The example worlds in the File menu, from site/examples/. Each one opens as
// a copy, kept under My worlds like any other world.

export const EXAMPLES = [
  {
    id: 'vault-run',
    name: 'Vault Run',
    about: 'Two levels. A key on a high ledge, a door a crate opens, two guards, a wall to blow open, then the Keeper.',
  },
  {
    id: 'toy-box',
    name: 'Toy box',
    about: 'Physics toys. Throw, blast and bounce your way to three targets.',
  },
  {
    id: 'wiring-lab',
    name: 'Wiring lab',
    about: 'Three rooms, each door opened by a different machine: And, Delay and Counter.',
  },
  {
    id: 'arena',
    name: 'Arena',
    about: 'A fight. Beat three creatures and a gate opens on the champion. Right click parries.',
  },
];

export async function fetchExample(id) {
  const res = await fetch(new URL(`../../examples/${id}.world.json`, import.meta.url));
  if (!res.ok) throw new Error('That example could not be loaded.');
  return res.json();
}
