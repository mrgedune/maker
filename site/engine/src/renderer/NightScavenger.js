import { ENTITY_LOD, createMeshBuffer, createBasis, addLocalBox, addLocalEllipsoid,
  addLocalSegment, addLocalRing, finishMesh, resolveMaterial } from './EntityGeometry.js';
import { resolveEntityAnimation } from './EntityAnimation.js';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const mix = (a, b, t) => a.map((n, i) => n + (b[i] - n) * t);

// Local coordinates: +x faces forward, +y right, +z down. The ankle target
// stays independent of torso breathing, so planted soles remain at z=.5.
// Solve a two-bone chain in its sagittal plane; both lengths stay constant.
function kneeBetween(hip, ankle, upper = .225, lower = .225) {
  const dx = ankle[0] - hip[0], dz = ankle[2] - hip[2];
  const distance = Math.max(.0001, Math.hypot(dx, dz));
  const d = clamp(distance, .0001, upper + lower - .0001);
  const along = (upper * upper - lower * lower + d * d) / (2 * d);
  const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
  return [hip[0] + dx / distance * along + dz / distance * bend,
    hip[1], hip[2] + dz / distance * along - dx / distance * bend];
}

/** Beyond Dawn's civilian night scavenger. Entirely separate from hider and
 * corp_guard. Cropped jacket, soft hood, amber eye glass, scarf, climbing
 * harness, roll-top canvas pack and work boots. No corporate marks or weapons.
 * params.livery: 0 scavenged, 1 repairs, 2 salvaged protection. Optional
 * gait/move/crouch stage the same rig for inspection, without another clock.
 */
export function buildNightScavengerMesh(entity, time = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return finishMesh([], ENTITY_LOD.BILLBOARD);
  }
  const vertices = createMeshBuffer(), worldBasis = createBasis(entity), full = lod === ENTITY_LOD.FULL;
  const basis = createBasis({ x: 0, y: 0, angle: 0 });
  const radial = full ? 8 : 5, rings = full ? 5 : 3;
  const motion = resolveEntityAnimation(entity, 'night_scavenger', finite(time), { lod });
  const p = entity.params || {}, livery = clamp(Math.floor(finite(p.livery)), 0, 2);
  const move = clamp(finite(p.move, (motion.pose.stride || 0) / .19), 0, 1.3);
  const gait = finite(p.gait, motion.gait), crouch = clamp(finite(p.crouch, motion.pose.crouch || 0), 0, 1);
  const breath = motion.breath * .35;
  const pelvis = [-.02, 0, .012 + crouch * .12 + Math.sin(gait) ** 2 * .06 * move];
  const lean = .018 + move * .022 + crouch * .085;
  const cosine = Math.cos(lean), sine = Math.sin(lean);
  // Upper body attachments share this rigid pitch transform, including the
  // pack straps and hood. They cannot slide independently when the body leans.
  const upper = v => {
    const x = v[0], z = v[2] - .052;
    return [pelvis[0] + x * cosine - z * sine, v[1],
      pelvis[2] + x * sine + z * cosine + breath];
  };
  const material = (char, color, roughness = .85, emission = .12) => resolveMaterial(entity,
    { color, roughness, emission, lightResponse: .8 }, options, .5, .5, char);
  const coat = material('j', [.27,.38,.36]);
  const yoke = material('y', [.40,.48,.44]);
  const trousers = material('p', [.25,.27,.25]);
  const boots = material('b', [.14,.12,.10]);
  const leather = material('g', [.39,.28,.17]);
  const canvas = material('c', [.57,.47,.31]);
  const scarf = material('s', [.66,.56,.38]);
  const webbing = material('#', [.15,.18,.16]);
  const repair = material('+', [.61,.38,.23]);
  const metal = material('m', [.57,.60,.55], .58);
  const glass = material('=', [.82,.65,.32], .24, .22);
  const dark = material('k', [.08,.105,.095]);
  const box = (c, h, m) => addLocalBox(vertices, basis, c, h, m);
  const orb = (c, r, m, n = radial, bands = rings) => addLocalEllipsoid(vertices, basis, c, r, m, n, bands);
  const segment = (a, b, r1, r2, m) => addLocalSegment(vertices, basis, a, b, r1, r2, m, radial);

  // The torso is built in rest space, then pitched about the pelvis in one
  // pass. Broad panels remain readable at simplified LOD; only tiny hardware
  // and stitching drop away. Each colour describes a real layer of clothing.
  const torsoStart = vertices.length;
  orb([0,0,-.092],[.095,.145,.185],coat);
  box([.005,0,-.11],[.077,.126,.13],coat);
  orb([-.01,0,-.212],[.094,.148,.055],yoke);
  box([0,0,.057],[.086,.132,.032],webbing);
  box([.091,0,.047],[.014,.026,.02],metal);
  // Split hem and flat utility pockets, no floating armour slabs.
  for (const side of [-1,1]) {
    box([.006,side*.080,.087],[.088,.055,.029],coat);
    box([.083,side*.075,-.071],[.015,.043,.051],yoke);
    box([.100,side*.075,-.113],[.006,.044,.014],canvas);
    box([.101,side*.095,-.177],[.012,.018,.064],webbing);
    segment([.103,side*.095,-.117],[.089,side*.105,.037],.012,.012,webbing);
  }
  box([.098,0,-.135],[.008,.008,.106],canvas);
  // Warm neck wrap and soft, close-fitting hood. Glass is a physical narrow
  // flip-down eye panel, with side hinges; there is no powered helmet mast.
  orb([.012,0,-.245],[.083,.098,.044],scarf);
  box([.087,-.04,-.196],[.016,.042,.061],scarf);
  orb([-.006,0,-.369],[.103,.105,.128],coat,full?10:6,full?6:4);
  orb([.041,0,-.363],[.073,.079,.098],dark);
  orb([.067,0,-.325],[.041,.080,.043],scarf);
  box([.107,0,-.388],[.017,.087,.031],webbing);
  box([.127,0,-.386],[.007,.077,.022],glass);
  box([.065,0,-.440],[.062,.093,.014],yoke);
  for (const side of [-1,1]) {
    box([.012,side*.103,-.383],[.045,.014,.024],webbing);
    box([.055,side*.111,-.383],[.018,.009,.018],metal);
  }
  // Compact canvas roll-top pack, carried close to the back. Its contrasting
  // folded mouth and broad straps carry identity in the title's rear view.
  box([-.130,0,-.071],[.055,.113,.131],canvas);
  orb([-.132,0,-.071],[.068,.122,.139],canvas);
  segment([-.132,-.11,-.220],[-.132,.11,-.220],.045,.045,yoke);
  box([-.190,0,-.154],[.013,.104,.047],canvas);
  for (const side of [-1,1]) {
    box([-.202,side*.067,-.065],[.01,.018,.117],webbing);
    box([-.214,side*.067,-.119],[.007,.024,.021],metal);
    segment([-.142,side*.08,-.230],[-.013,side*.104,-.241],.018,.018,webbing);
  }
  // A loop of salvaged cable and one hip pouch break the symmetry without
  // making the rig too wide for shelter doorways.
  addLocalRing(vertices,basis,[-.139,-.134,-.025],.060,.012,scarf,full?12:8,'y');
  box([-.043,.163,.088],[.062,.037,.060],leather);
  box([-.04,.201,.052],[.056,.005,.022],canvas);
  if (livery >= 1) {
    box([-.203,-.027,-.010],[.012,.042,.027],repair);
    box([.103,.075,-.052],[.008,.037,.026],repair);
  }
  if (livery >= 2) {
    box([-.209,.030,-.047],[.016,.034,.071],metal);
    box([.104,.076,-.075],[.017,.045,.060],metal);
  }
  if (full) {
    box([-.215,0,-.180],[.004,.037,.008],scarf);
    box([.108,-.075,-.072],[.006,.025,.005],webbing);
    for (const side of [-1,1]) box([-.216,side*.067,.034],[.005,.019,.011],leather);
  }
  // Pitch both positions and normals in local space. Scalar writes avoid
  // allocating temporary point arrays for every torso vertex every frame.
  // This keeps lighting attached to the clothing and pack as the body leans.
  for (let i = torsoStart; i < vertices.length; i += 12) {
    const data = vertices.data;
    const x=data[i],z=data[i+2]-.052,nx=data[i+3],nz=data[i+5];
    data[i]=pelvis[0]+x*cosine-z*sine;
    data[i+2]=pelvis[2]+x*sine+z*cosine+breath;
    data[i+3]=nx*cosine-nz*sine;data[i+5]=nx*sine+nz*cosine;
  }

  const joints = [];
  for (const side of [-1,1]) {
    const wave = gait + (side < 0 ? 0 : Math.PI);
    const hip = [pelvis[0],side*.09,pelvis[2]];
    const lift = Math.max(0,Math.cos(wave))*.065*move;
    const ankle = [-.012+Math.sin(wave)*.19*move,side*.09,.447-lift];
    const knee = kneeBetween(hip,ankle);
    segment(hip,knee,.072,.053,trousers);
    orb(knee,[.054,.054,.052],trousers);
    segment(knee,ankle,.053,.039,trousers);
    // Knee repairs/protection follow the solved joint, never a separate wave.
    if (livery >= 1) box([knee[0]+.043,knee[1],knee[2]],[.017,.043,.047],livery>=2?metal:repair);
    const boot = [ankle[0]+.03,ankle[1],ankle[2]+.019];
    box(boot,[.084,.050,.026],boots);
    box([boot[0],boot[1],ankle[2]+.047],[.088,.053,.006],webbing);
    orb([ankle[0]+.002,ankle[1],ankle[2]-.017],[.047,.044,.052],leather);
    box([boot[0]+.048,boot[1],boot[2]-.008],[.029,.051,.020],leather);

    // Forward-kinematic sleeves: shoulder -> elbow -> wrist, fixed lengths.
    // Hands counter the advancing leg, elbows flex on the forward swing.
    const swing = -Math.sin(wave)*.65*move;
    const shoulder = upper([0,side*.153,-.204]);
    const upperAngle = -.11+swing-crouch*.4;
    const foreAngle = upperAngle+.23+Math.max(0,swing)*.50+crouch*.5;
    const elbow = [shoulder[0]+Math.sin(upperAngle)*.185,shoulder[1]+side*.031,
      shoulder[2]+Math.cos(upperAngle)*.185];
    const hand = [elbow[0]+Math.sin(foreAngle)*.177,elbow[1]+side*.003,
      elbow[2]+Math.cos(foreAngle)*.177];
    // Shared centres overlap the sleeves at every joint and at the gloves.
    orb(shoulder,[.065,.068,.068],yoke);
    segment(shoulder,elbow,.063,.048,coat);orb(elbow,[.050,.051,.048],coat);
    segment(elbow,hand,.049,.037,coat);
    const cuff=mix(elbow,hand,.84);
    segment(mix(elbow,hand,.74),hand,.046,.043,canvas);
    orb([hand[0]+.009,hand[1],hand[2]+.019],[.047,.038,.051],leather);
    if (livery >= 1 && side < 0) orb(elbow,[.054,.055,.052],repair);
    if (livery >= 2 && side > 0) orb(shoulder,[.070,.073,.073],metal);
    if (full) box([cuff[0]+.037,cuff[1],cuff[2]],[.008,.022,.023],webbing);
    joints.push({ side, hip, knee, ankle, shoulder, elbow, hand, lift });
  }
  // Rotate the complete local mesh, including ellipsoid axes and normals.
  // addLocalEllipsoid itself rotates only its centre, so using a rotated
  // basis while constructing it would make limbs change shape when turning.
  const data = vertices.data, f = worldBasis.forward, r = worldBasis.right;
  for (let i=0;i<vertices.length;i+=12) {
    const x=data[i],y=data[i+1],nx=data[i+3],ny=data[i+4];
    data[i]=entity.x+x*f[0]+y*r[0];data[i+1]=entity.y+x*f[1]+y*r[1];
    data[i+3]=nx*f[0]+ny*r[0];data[i+4]=nx*f[1]+ny*r[1];
  }
  return finishMesh(vertices,lod,{state:motion.state,livery,gait,move,crouch,joints});
}
