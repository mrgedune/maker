import { ENTITY_LOD, createMeshBuffer, createBasis, addLocalBox,
  addLocalSegment, finishMesh, resolveMaterial } from './EntityGeometry.js';

export { buildShamblerMesh } from './ShamblerMesh.js';

export function buildCrowbarMesh(entity,time=0,lod=ENTITY_LOD.FULL,options={}) {
  if (!entity||!Number.isFinite(entity.x)||!Number.isFinite(entity.y)||lod===ENTITY_LOD.BILLBOARD) return finishMesh([],ENTITY_LOD.BILLBOARD);
  const vertices=createMeshBuffer(),basis=createBasis(entity);
  const mat=(char,color)=>resolveMaterial(entity,{color,emission:.32,roughness:.62,lightResponse:.7},options,.5,.5,char);
  const steel=mat('m',[.59,.65,.62]),grip=mat('g',[.26,.17,.11]);
  addLocalSegment(vertices,basis,[0,0,.49],[.1,0,-.12],.018,.021,steel,lod===ENTITY_LOD.FULL?8:5);
  addLocalSegment(vertices,basis,[.1,0,-.12],[.17,0,-.17],.021,.018,steel,5);
  addLocalBox(vertices,basis,[.185,0,-.17],[.028,.026,.01],steel);
  addLocalSegment(vertices,basis,[.018,0,.38],[.05,0,.20],.027,.027,grip,6);
  return finishMesh(vertices,lod);
}
