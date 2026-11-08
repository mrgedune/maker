import { createBasis, createMeshBuffer, addLocalBox, resolveMaterial, finishMesh } from './EntityGeometry.js';

/** A hollow wall frame. Dimensions are renderer cells; origin is front bottom center.
 * Local +x faces the room. The opening is width - 2*jamb by height - jamb;
 * all pieces stay outside it. No threshold or collision is added implicitly.
 * Both LODs retain the same silhouette: six small boxes cost less than a prop.
 */
export function buildArchitecturalFrame(entity, currentTime = 0, lod = 'full', options = {}) {
  const p = entity.params || {};
  const number = (name, fallback, min, max) => Math.max(min, Math.min(max,
    Number.isFinite(p[name]) ? p[name] : fallback));
  const band = p.band === true, sill = !band && p.sill === true;
  const width = number('width', 1.6, .2, 12);
  const height = number('height', 2.3, band ? .02 : .2, 12);
  const jamb = number('jamb', .1, .01, Math.min(width / 3, height / 3));
  const depth = number('depth', .04, .005, .5);
  const basis = createBasis(entity), vertices = createMeshBuffer();
  const body = resolveMaterial(entity, { color: [.25,.30,.32], roughness: .86,
    emission: .06, lightResponse: .8 }, options, .5, .5, '#');
  const edge = resolveMaterial(entity, { color: [.40,.44,.43], roughness: .75,
    emission: .06, lightResponse: .8 }, options, .5, .5, '-');
  const box = (x,y,z,dx,dy,dz,material) => addLocalBox(vertices,basis,[x-depth,y,.5-z],[dx/2,dy/2,dz/2],material);
  if(band) {
    box(depth*.3,0,height/2,depth*.6,width,height,body);
    box(depth*.8,0,height*.125,depth*.4,width,height*.25,edge);
    return finishMesh(vertices,lod,{archetype:'architectural_frame',width,height,depth,band:true,openingWidth:0,openingHeight:0});
  }
  const sideHeight=height-jamb-(sill?jamb:0),sideCenter=(sill?jamb:0)+sideHeight/2;
  // Broad recessed face and a shallow inner lip. The lip is part of the jamb,
  // never an intrusion into the declared opening. There is no fine tile noise.
  for (const side of [-1,1]) {
    const y = side * (width-jamb)/2;
    box(depth*.3,y,sideCenter,depth*.6,jamb,sideHeight,body);
    box(depth*.8,side*(width/2-jamb*.85),sideCenter,depth*.4,jamb*.3,sideHeight,edge);
  }
  box(depth*.3,0,height-jamb/2,depth*.6,width,jamb,body);
  box(depth*.8,0,height-jamb*.85,depth*.4,width,jamb*.3,edge);
  if(sill) {
    box(depth*.3,0,jamb/2,depth*.6,width,jamb,body);
    box(depth*.8,0,jamb*.85,depth*.4,width,jamb*.3,edge);
  }
  return finishMesh(vertices,lod,{archetype:'architectural_frame',width,height,jamb,depth,
    openingWidth:width-2*jamb,openingHeight:height-jamb*(sill?2:1),sill});
}
