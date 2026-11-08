import { ENTITY_LOD, createMeshBuffer, createBasis, addLocalBox, addLocalEllipsoid,
  addLocalSegment, finishMesh, resolveMaterial } from './EntityGeometry.js';

/** An original, unarmed human contact. Z points down; soles rest at +0.5. */
export function buildShelterContactMesh(entity, time = 0, lod = ENTITY_LOD.FULL, options = {}) {
  if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) || lod === ENTITY_LOD.BILLBOARD) {
    return finishMesh([], ENTITY_LOD.BILLBOARD);
  }
  const vertices = createMeshBuffer(), basis = createBasis(entity), full = lod === ENTITY_LOD.FULL;
  const future = entity.params?.future === true;
  const segments = full ? 10 : 6, rings = full ? 7 : 4;
  const material = (char, color, emission = 0.18) => resolveMaterial(entity,
    { color, roughness: 0.8, emission, lightResponse: 0.8 }, options, 0.5, 0.5, char);
  const coat = material('j', future ? [.40,.39,.27] : [.32,.48,.54]);
  const seam = material('+', future ? [.64,.56,.35] : [.59,.69,.68]);
  const trousers = material('p', [.23,.27,.27]), boots = material('b', [.11,.13,.12]);
  const skin = material('s', future ? [.64,.43,.30] : [.78,.60,.44]);
  const hair = material('h', future ? [.17,.12,.08] : [.54,.53,.47]);
  const dark = material('k', [.07,.08,.07]), radio = material('r', [.22,.27,.25]);
  const breath = Math.sin((Number.isFinite(time) ? time : 0) * .0014) * .003;
  const box = (center, half, mat) => addLocalBox(vertices,basis,center,half,mat);
  const ellipsoid = (center,radii,mat) => addLocalEllipsoid(vertices,basis,center,radii,mat,segments,rings);
  const limb = (a,b,r1,r2,mat) => addLocalSegment(vertices,basis,a,b,r1,r2,mat,full ? 8 : 5);

  // Separate legs and sleeves leave clear negative space around the body.
  for (const side of [-1,1]) {
    limb([0,side*.08,.12],[.008,side*.09,.30],.067,.048,trousers);
    limb([.008,side*.09,.30],[0,side*.10,.445],.048,.041,trousers);
    box([.025,side*.10,.462],[.085,.053,.038],boots);
    const shoulder=[0,side*.164,-.15+breath],elbow=[.01,side*.198,.008+breath];
    const hand=[.027,side*.19,.185+breath];
    ellipsoid(shoulder,[.066,.067,.077],coat);
    limb(shoulder,elbow,.060,.046,coat); limb(elbow,hand,.047,.033,coat);
    ellipsoid([hand[0],hand[1],hand[2]+.023],[.038,.031,.048],skin);
  }
  ellipsoid([-.003,0,-.014+breath],[.095,.151,.211],coat);
  box([0,0,.13],[.091,.13,.027],trousers);
  box([.094,0,.117],[.011,.026,.018],seam);
  box([.092,0,-.045+breath],[.009,.008,.145],seam);
  box([.082,-.075,-.105+breath],[.025,.042,.048],radio);
  limb([.074,-.094,-.13+breath],[.069,-.095,-.239+breath],.006,.004,dark);
  box([.096,.076,-.099+breath],[.009,.041,.04],seam);
  ellipsoid([0,0,-.241+breath],[.044,.05,.055],skin);
  box([.02,0,-.218+breath],[.077,.09,.02],seam);

  // Exposed face, nose and ears make a person rather than an armored operative.
  ellipsoid([.009,0,-.363+breath],[.087,future?.081:.075,.111],skin);
  ellipsoid([-.018,0,-.411+breath],[.086,future?.085:.079,future?.071:.068],hair);
  ellipsoid([-.07,0,-.362+breath],[.026,.067,.076],hair);
  ellipsoid([.096,0,-.352+breath],[.022,.017,.033],skin);
  for (const side of [-1,1]) ellipsoid([.005,side*.078,-.354+breath],[.018,.019,.03],skin);
  // Ear cup and boom microphone have volume from the side as well as the front.
  ellipsoid([0,-.096,-.36+breath],[.036,.021,.042],radio);
  limb([-.025,-.092,-.401+breath],[-.025,-.054,-.47+breath],.009,.009,dark);
  limb([-.025,-.054,-.47+breath],[-.025,.049,-.47+breath],.009,.009,dark);
  limb([0,-.10,-.339+breath],[.114,-.052,-.31+breath],.006,.006,dark);
  ellipsoid([.117,-.043,-.31+breath],[.019,.011,.011],dark);
  if (full) {
    for (const side of [-1,1]) {
      box([.084,side*.033,-.383+breath],[.009,.015,.009],dark);
      box([.081,side*.033,-.400+breath],[.008,.019,.005],hair);
    }
    box([.087,0,-.312+breath],[.007,.025,.006],dark);
    box([.109,-.075,-.11+breath],[.002,.021,.008],seam);
  }
  return finishMesh(vertices,lod,{breath,variant:future?'future':'original'});
}
