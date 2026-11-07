import { ENTITY_LOD, createMeshBuffer, finishMesh, resolveMaterial } from './EntityGeometry.js';

const clamp = (n, a=0, b=1) => Math.max(a, Math.min(b, n));
const finite = (n, fallback=0) => Number.isFinite(n) ? n : fallback;
const smooth = n => { const t=clamp(n); return t*t*(3-2*t); };
const add = (a,b) => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul = (a,n) => [a[0]*n,a[1]*n,a[2]*n];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = a => mul(a,1/(Math.hypot(...a)||1));
const mix = (a,b,t) => [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];

/** Two bones meet at one joint. Clamping the end target avoids stretching or
 * disconnected knees/elbows when an authored reach exceeds the limb length. */
export function shamblerJoint(start,end,upper,lower,bend=[1,0,0]) {
  const delta=sub(end,start),length=Math.hypot(...delta);
  const distance=clamp(length,Math.abs(upper-lower)+.0001,upper+lower-.0001);
  const axis=length>.00001?mul(delta,1/length):[0,0,-1];
  const along=(upper*upper-lower*lower+distance*distance)/(2*distance);
  let across=sub(bend,mul(axis,dot(bend,axis)));
  if(Math.hypot(...across)<.001)across=cross(axis,Math.abs(axis[1])<.9?[0,1,0]:[1,0,0]);
  const joint=add(add(start,mul(axis,along)),mul(unit(across),Math.sqrt(Math.max(0,upper*upper-along*along))));
  return {joint,end:add(start,mul(axis,distance))};
}

function footCycle(phase) {
  const t=((phase/(Math.PI*2))%1+1)%1;
  // Stance travels backwards at a constant speed. The game's distance clock
  // advances .60 native cells per cycle: planted soles cancel body travel.
  if(t<.6)return {x:.18-.36*t/.6,lift:0,planted:true};
  const u=(t-.6)/.4;
  return {x:-.18+.36*smooth(u),lift:Math.sin(Math.PI*u)*.070,planted:false};
}

const ATTACK_KEYS=[
  [0, 0, 0, 0], [.48, .58, 0, -.025], [.84, 1, 0, -.045],
  [1, .08, 1, .095], [1.18, 0, .70, .075], [1.5, 0, .18, .025], [2,0,0,0],
];
function attackShape(phase,keys=ATTACK_KEYS) {
  for(let i=1;i<keys.length;i++)if(phase<=keys[i][0]) {
    const a=keys[i-1],b=keys[i],t=smooth((phase-a[0])/(b[0]-a[0]));
    return a.slice(1).map((v,j)=>v+(b[j+1]-v)*t);
  }
  return [0,0,0];
}

// The heavy strike stays loaded until the last fifth of windup. Phase 1 is
// still the caller's impact; the whole 1..2 interval spends the recovery.
const BRUISER_ATTACK_KEYS=[
  [0,0,0,0],[.45,.65,0,-.018],[.80,1,0,-.035],
  [1,0,1,.075],[1.16,0,.85,.060],[1.65,0,.15,.012],[2,0,0,0],
];

// Normalized visual progress only; the caller owns rush distance and duration.
// Zero means inactive. The first positive sample releases the completed coil;
// the last quarter brakes and recovers, ending at the ordinary ready pose.
function rushShape(progress) {
  if(progress<=0)return [0,0];
  const release=smooth(progress/.22),recover=1-smooth((progress-.72)/.28);
  return [(1-release)*recover,release*recover];
}

/** All authored points are forward/right/height above the sole. Params are
 * optional: a game supplies its own clocks; the isolated archetype still has
 * a useful preview without AI state or mutable renderer-side animation tracks.
 * rusher === true opts into the crouched variant. rushPrepare (0..1) coils;
 * rush (0..1) releases through .22, commits through .72, then recovers to 1.
 * Zero is inactive: hand off a completed preparation to a positive rush sample.
 * Active rush takes precedence if both channels are supplied. Neither moves
 * the entity root nor advances gait, and legacy attack/hit/death still layer.
 * bruiser === true opts into broad shoulders and a braced two-arm strike.
 * screamer === true opts into a narrow chest and extended throat. Its call
 * (0 inactive, 0..1 inhale, 1 release, 1..2 recovery) and callWeight (0..1)
 * are independent of melee attack. Explicit priority: rusher > bruiser >
 * screamer. Nonfinite channels use 0; values clamp to their stated ranges.
 * No variant changes limb lengths, root, gait distance or gameplay bounds. */
export function sampleShamblerRig(entity,time=0) {
  const p=entity.params||{},state=entity.state||'idle',clock=finite(p.clock,finite(time)/1000);
  const death=clamp(finite(p.death,state==='dead'?1:0)),settle=smooth(death),vitality=1-settle;
  const moving=clamp(finite(p.move,['chase','investigate'].includes(state)?1:0))*vitality;
  const phase=finite(p.gait,clock*4.2+finite(p.phase));
  const aggression=clamp(finite(p.alert,['chase','windup','recover'].includes(state)?1:0))*vitality;
  const attack=clamp(finite(p.attack,state==='windup'?.82:state==='recover'?1.13:0),0,2);
  const attackWeight=clamp(finite(p.attackWeight,['windup','recover'].includes(state)?1:0))*vitality;
  const rusher=p.rusher===true,bruiser=!rusher&&p.bruiser===true;
  const screamer=!rusher&&!bruiser&&p.screamer===true;
  const call=screamer?clamp(finite(p.call),0,2):0;
  const callWeight=screamer&&call>0?clamp(finite(p.callWeight))*vitality:0;
  const inhale=smooth(Math.min(call,1))*(1-smooth((call-1)/.85))*callWeight;
  // The mouth releases exactly at 1, then closes over the first half of recovery.
  const calling=(call<1?smooth((call-.82)/.18):1-smooth((call-1)/.55))*callWeight;
  const [raise,slash,lunge]=attackShape(attack,bruiser?BRUISER_ATTACK_KEYS:ATTACK_KEYS)
    .map(v=>v*attackWeight*(screamer?1-callWeight:1));
  const recoil=clamp(finite(p.recoil,state==='stagger'?.8:0))*vitality;
  const flinch=clamp(finite(p.flinch))*vitality;
  const rushPrepare=rusher?clamp(finite(p.rushPrepare)):0,rush=rusher?clamp(finite(p.rush)):0;
  const [releaseCoil,releaseDrive]=rushShape(rush);
  const coil=(rush>0?releaseCoil:smooth(rushPrepare))*vitality,drive=releaseDrive*vitality;
  const breath=Math.sin(clock*1.5+finite(p.phase))*.003*vitality;
  const sway=Math.sin(phase)*.008*moving;
  const pelvis=[-.016, sway, .472-Math.abs(Math.sin(phase))*.009*moving-recoil*.025];
  const chest=[.048-settle*.024+aggression*.018+lunge-recoil*.045-flinch*.016,
    sway-.008+Math.sin(clock*.83)*.004*vitality, .690+breath-slash*.038-recoil*.028];
  if(rusher) {
    pelvis[0]+=-.015-coil*.040+drive*.040;
    pelvis[2]-=.057+coil*.042+drive*.018;
    chest[0]+=.032-coil*.065+drive*.125;
    chest[2]-=.100+coil*.070+drive*.065;
  }
  if(bruiser) {
    pelvis[2]-=.025;
    chest[0]+=.012;chest[2]-=.035+raise*.018;
  }
  if(screamer) {
    pelvis[2]-=.012;
    chest[0]+=.018-inhale*.060;chest[2]+=-.024+inhale*.036;
  }
  const neck=add(chest,[.038-settle*.020+(rusher?.014:0),-.008,rusher?.052:.075]);
  const head=add(neck,[.042-settle*.022+(rusher?.012:0),-.012,rusher?.062:.073]);
  if(screamer) {
    neck[0]+=.010-inhale*.020;neck[2]+=.018;
    head[0]+=.018-inhale*.035;head[2]+=.024;
  }
  const legs=[],arms=[];
  for(const side of [-1,1]) {
    const foot=footCycle(phase+(side===1?Math.PI:0));
    const hip=add(pelvis,[0,side*(bruiser?.096:.081),0]);
    const ankle=[foot.x*moving+(side===1?-.018:.010)*(1-moving),side*.09+sway*.2,
      .055+foot.lift*moving*(side===1?.66:1)];
    if(rusher) {
      // Keep the .60-cell distance gait and flat soles. Preparation settles
      // into a staggered brace; release blends back into caller-owned travel.
      const brace=side===1?-.115:.085;
      ankle[0]=(foot.x*moving+brace*(1-moving))*(1-coil)+brace*coil;
      ankle[1]=side*.112+sway*.2;
      ankle[2]=.055+foot.lift*moving*(1-coil);
    }
    if(bruiser) {
      ankle[0]+=(side===1?-.040:.030)*(1-moving);
      ankle[1]=side*.125+sway*.2;
    }
    const leg=shamblerJoint(hip,ankle,.229,.238,[1,side*.08,0]);
    legs.push({side,hip,knee:leg.joint,ankle:leg.end,planted:foot.planted||moving<.01||(rusher&&coil===1)});
    const shoulder=add(chest,[-.013,side*.125,.020+(side===-1?.007:-.007)]);
    if(rusher) {shoulder[0]-=.012;shoulder[1]+=side*.020;shoulder[2]+=.009;}
    if(bruiser) {shoulder[1]+=side*.042;shoulder[2]+=.014;}
    if(screamer) {shoulder[1]-=side*(.022-inhale*.012);shoulder[2]+=inhale*.018;}
    const swing=Math.sin(phase+(side===1?Math.PI:0))*.028*moving;
    let rest=add(shoulder,[.028+aggression*.12+swing,side*.018,-.316+aggression*.065]);
    if(rusher) {
      rest=add(shoulder,[.035+aggression*.08+swing,side*.045,-.205+aggression*.025]);
      rest=mix(rest,add(shoulder,[-.155,side*.025,-.190]),coil);
      rest=mix(rest,add(shoulder,side===-1?[.285,-.020,-.025]:[.140,.025,-.160]),drive);
    }
    let wrist;
    if(side===-1) {
      wrist=mix(rest,add(shoulder,[-.045,-.080,.180]),raise);
      const follow=smooth((attack-1)/.16)*(1-smooth((attack-1.2)/.5));
      wrist=mix(wrist,add(shoulder,[.300-.025*follow,.105+.025*follow,.060-.19*follow]),slash);
    } else {
      wrist=mix(rest,add(shoulder,[.215,-.033,-.115]),aggression*.58+raise*.25);
      wrist=mix(wrist,add(shoulder,[.20,-.085,-.15]),slash*.6);
    }
    if(bruiser) {
      rest=add(shoulder,[.065+aggression*.065+swing,side*.025,-.285]);
      wrist=mix(rest,add(shoulder,[-.095,side*.042,.240]),raise);
      wrist=mix(wrist,add(shoulder,[.285,-side*.060,-.120]),slash);
    }
    if(screamer) {
      // Hands gather beside the throat, elbows open for breath. At release
      // they spread beside the chest, never travelling through a melee arc.
      const breathHand=add(shoulder,[.075,-side*.040,.045]);
      const callHand=add(shoulder,[.045,side*.125,-.080]);
      wrist=mix(wrist,mix(breathHand,callHand,calling),inhale);
    }
    wrist=add(wrist,[-recoil*.05,side*recoil*.025,recoil*.06]);
    const arm=shamblerJoint(shoulder,wrist,.164,.163,(rusher||screamer)?[-.25,side,-.15]:bruiser?[-.35,side,.15]:[.75,side*.4,0]);
    arms.push({side,shoulder,elbow:arm.joint,wrist:arm.end});
  }
  return {pelvis,chest,neck,head,legs,arms,moving,phase,clock,aggression,attack,attackWeight,
    headPitch:.13+slash*.16-recoil*.28+(rusher?.17+coil*.04+drive*.18:0)+(screamer?.10-inhale*.52:0),
    headCant:-.12+Math.sin(clock*.65)*.025*vitality+flinch*.08,
    death,...(rusher?{rusher,rushPrepare,rush}:bruiser?{bruiser}:screamer?{screamer,call,callWeight,inhale,calling}: {})};
}

/** Faceted anatomical surfaces, continuous tapered limbs, and shared joints.
 * The material letters remain compatible with the original shambler palette. */
export function buildShamblerMesh(entity,time=0,lod=ENTITY_LOD.FULL,options={}) {
  if(!entity||!Number.isFinite(entity.x)||!Number.isFinite(entity.y)||lod===ENTITY_LOD.BILLBOARD)return finishMesh([],ENTITY_LOD.BILLBOARD);
  const full=lod===ENTITY_LOD.FULL,vertices=createMeshBuffer(),rig=sampleShamblerRig(entity,time);
  const rusher=rig.rusher===true,bruiser=rig.bruiser===true,screamer=rig.screamer===true;
  const breadth=bruiser?1.28:screamer?.84+rig.inhale*.08:1;
  const bulk=bruiser?1.20:screamer?.88:1;
  const sides=full?8:5,angle=finite(entity.angle),ca=Math.cos(angle),sa=Math.sin(angle);
  const material=(char,color,roughness=.92)=>resolveMaterial(entity,{color,emission:.10,roughness,lightResponse:.9},options,.5,.5,char);
  const skin=material('s',rusher?[.49,.445,.355]:[.48,.48,.405]),bone=material('s',[.56,.54,.455]);
  const coat=material('j',rusher?[.38,.225,.13]:[.235,.285,.27]),cloth=material('j',rusher?[.245,.16,.115]:[.19,.235,.22]);
  const pants=material('p',[.22,.235,.225]),dark=material('k',[.055,.063,.055]);
  const wound=material('t',[.245,.125,.105]),trim=material('r',[.48,.405,.25]);
  const eye=material('e',[.32,.34,.30]),teeth=material('s',[.55,.51,.405]);
  const emit=(p,n,m)=>vertices.push(p[0],p[1],p[2],n[0],n[1],n[2],m.color[0],m.color[1],m.color[2],m.roughness,m.emission,m.lightResponse);
  const triangle=(a,b,c,m,na,nb,nc)=>{
    if(!na) {
      const bx=b[0]-a[0],by=b[1]-a[1],bz=b[2]-a[2],cx=c[0]-a[0],cy=c[1]-a[1],cz=c[2]-a[2];
      const nx=by*cz-bz*cy,ny=bz*cx-bx*cz,nz=bx*cy-by*cx,inv=1/(Math.hypot(nx,ny,nz)||1);
      na=nb=nc=[nx*inv,ny*inv,nz*inv];
    }
    emit(a,na,m);emit(b,nb,m);emit(c,nc,m);
  };
  const loft=(rings,m,segments=sides)=>{
    // Shared surface normals keep an elbow/neck from reading as separate hard
    // pieces. Caps, seams and clothing details retain their crisp flat edges.
    const normals=rings.map((ring,r)=>ring.map((p,j)=>unit(cross(
      sub(ring[(j+1)%segments],ring[(j+segments-1)%segments]),
      sub(rings[Math.min(rings.length-1,r+1)][j],rings[Math.max(0,r-1)][j])))));
    for(let r=1;r<rings.length;r++)for(let j=0;j<segments;j++) {
      const next=(j+1)%segments,a=rings[r-1][j],b=rings[r-1][next],c=rings[r][next],d=rings[r][j];
      const surface=typeof m==='function'?m(r,j):m;
      triangle(a,b,c,surface,normals[r-1][j],normals[r-1][next],normals[r][next]);
      triangle(a,c,d,surface,normals[r-1][j],normals[r][next],normals[r][j]);
    }
    for(const [ring,reverse] of [[rings[0],true],[rings.at(-1),false]]) {
      const center=mul(ring.reduce((sum,p)=>add(sum,p),[0,0,0]),1/segments);
      const surface=typeof m==='function'?m(reverse?1:rings.length-1,0):m;
      for(let j=0;j<segments;j++)reverse?triangle(center,ring[(j+1)%segments],ring[j],surface):triangle(center,ring[j],ring[(j+1)%segments],surface);
    }
  };
  const ring=(center,rx,ry,segments=sides,transform=p=>p)=>Array.from({length:segments},(_,i)=>{
    const a=i/segments*Math.PI*2;return transform(add(center,[Math.cos(a)*rx,Math.sin(a)*ry,0]));
  });
  const body=(profiles,m,segments=sides,transform=p=>p)=>loft(profiles.map(([c,rx,ry])=>ring(c,rx,ry,segments,transform)),m,segments);
  const tube=(points,radii,m,segments=sides)=>{
    const rings=points.map((p,i)=>{
      const axis=unit(sub(points[Math.min(points.length-1,i+1)],points[Math.max(0,i-1)]));
      const across=unit(cross(Math.abs(axis[1])<.9?[0,1,0]:[1,0,0],axis)),around=cross(axis,across);
      return Array.from({length:segments},(_,j)=>add(p,add(mul(across,Math.cos(j/segments*Math.PI*2)*radii[i]),mul(around,Math.sin(j/segments*Math.PI*2)*radii[i]))));
    });
    loft(rings,m,segments);
  };
  const box=(center,size,m,transform=p=>p)=>{
    const corners=Array.from({length:8},(_,i)=>transform(add(center,[(i&1?1:-1)*size[0],(i&2?1:-1)*size[1],(i&4?1:-1)*size[2]])));
    for(const [a,b,c,d] of [[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]]) {
      triangle(corners[a],corners[b],corners[c],m);triangle(corners[a],corners[c],corners[d],m);
    }
  };
  const {pelvis,chest}=rig;
  body([[add(pelvis,[0,0,-.025]),.072,.108*breadth],[add(pelvis,[.002,0,.025]),.080,.110*breadth]],pants);
  body([[add(pelvis,[.008,0,rusher?.015:-.018]),.088,(rusher?.108:.122)*breadth],[add(pelvis,[.015,0,.050]),rusher?.065:.075,(rusher?.096:.105)*breadth],
    [mix(pelvis,chest,.65),.083*bulk,.126*breadth],[add(chest,[0,0,.024]),.074*bulk,(rusher?.157:.137)*breadth],
    [add(chest,[.010,0,.053]),.038,.075]],coat);
  // Jacket opening, folded lapels and worn strips, anchored to the chest.
  tube([add(pelvis,[.090,0,.012]),add(chest,[.077,-.008,.014])],[.014,.018],dark,4);
  for(const side of [-1,1]) {
    tube([add(chest,[.068,side*.055,.036]),add(chest,[.083,side*.023,-.047])],[.016,.010],cloth,4);
    box(add(chest,[.072,side*.084,-.02]),[.004,.026,rusher?.020:.009],trim);
    if(full) {
      box(add(chest,[.081,side*.077,-.085]),[.006,.026,.022],cloth);
      if(!rusher)triangle(add(pelvis,[.083,side*.040,-.025]),add(pelvis,[.074,side*.090,-.025]),add(pelvis,[.077,side*.069,-.059]),coat);
    }
  }
  box(add(chest,[.082,.046,-.047]),[.004,.017,.012],bone);
  for(const leg of rig.legs) {
    const {hip,knee,ankle,side}=leg;
    tube([hip,mix(hip,knee,.40),knee,mix(knee,ankle,.5),ankle],[.048,.049,.034,.036,.029].map(r=>r*bulk),pants);
    // A shallow torn knee patch shares the knee position, without a separate
    // exposed ball joint or a gap between thigh and shin.
    if(side===1)box(add(knee,[.034,0,0]),[.005,.023,.027],wound);
    body([[add(ankle,[.020,0,-.055]),.070,.041],[add(ankle,[.030,0,-.025]),.069,.043],
      [add(ankle,[.002,0,.012]),.040,.034]],dark);
  }
  for(const arm of rig.arms) {
    const {shoulder,elbow,wrist,side}=arm;
    const sleeveEnd=side===1?mix(shoulder,elbow,.70):elbow;
    // One ring at the elbow is shared by both adjacent surfaces. Color changes
    // at the sleeve edge, but the actual limb never ends and restarts there.
    tube([shoulder,mix(shoulder,elbow,.5),elbow,mix(elbow,wrist,.48),wrist],
      [.043,.041,.032,.029,.021].map(r=>r*bulk),ring=>ring<=(rusher?0:side===1?1:2)?coat:skin);
    const direction=unit(sub(wrist,elbow)),across=unit(cross(direction,[1,0,0])),normal=unit(cross(across,direction));
    const palm=add(wrist,mul(direction,.028));
    tube([wrist,palm,add(palm,mul(direction,.025))],[.023,.033,.026].map(r=>r*bulk),skin,full?6:5);
    if(full) {
      for(let finger=0;finger<4;finger++) {
        const base=add(add(palm,mul(direction,.021)),mul(across,(finger-1.5)*.013));
        const tip=add(add(base,mul(direction,.032-Math.abs(finger-1.5)*.004)),mul(normal,.015));
        tube([base,mix(base,tip,.55),tip,add(tip,mul(normal,.012))],[.009,.009,.007,.005],skin,4);
      }
      tube([add(palm,mul(across,.029)),add(add(palm,mul(across,.040)),mul(direction,.014)),add(palm,mul(direction,.028))],[.012,.010,.007],skin,4);
      if(!rusher)tube([mix(shoulder,sleeveEnd,.87),sleeveEnd],[.036,.034],cloth,5);
    }
  }
  tube([add(chest,[.015,-.012,.034]),rig.neck,add(rig.neck,[.023,-.006,.035])],[.043,.032,.033],skin);
  const c=Math.cos(rig.headPitch),s=Math.sin(rig.headPitch),cr=Math.cos(rig.headCant),sr=Math.sin(rig.headCant);
  const headTransform=p=>{
    const x=p[0]*c+p[2]*s,z=-p[0]*s+p[2]*c;
    return add(rig.head,[x,p[1]*cr-z*sr,p[1]*sr+z*cr]);
  };
  const jaw=screamer?rig.calling*.028:0;
  body([[[.016,0,-.064-jaw],.027,.031],[[.004,0,-.049-jaw],.045,.046],[[0,0,-.024],.050,.051],
    [[-.006,0,.011],.055,.058],[[0,0,.036],.053,.055],[[0,0,.060],.041,.045],
    [[-.007,0,.073],.014,.020]],skin,full?12:7,headTransform);
  // Small recessed eye sockets and an uneven open jaw replace the old mask.
  for(const side of [-1,1]) {
    box([.051,side*.024,.022],[.004,.014,.007],dark,headTransform);
    box([.052,side*.023,.033],[.006,.016,.005],bone,headTransform);
  }
  if(full)box([.056,-.025,.022],[.002,.004,.003],eye,headTransform);
  body([[[.057,.002,-.017],.010,.010],[[.071,.002,-.005],.011,.009],[[.054,.002,.026],.007,.009]],bone,5,headTransform);
  box([.053,.002,-.038-jaw*.5],[.004,.022,.011+jaw*.5],dark,headTransform);
  box([.055,.011,-.040-jaw],[.004,.012,.009],wound,headTransform);
  if(full)for(const side of [-1,0,1])box([.058,side*.010,-.029],[.002,.003,.003],teeth,headTransform);
  // Uneven remaining hair follows the crown, leaving the temples exposed.
  body(rusher?[[[-.023,0,.048],.035,.022],[[-.012,0,.084],.032,.016],[[-.010,0,.096],.011,.009]]:
    [[[-.023,0,.048],.035,.047],[[-.012,0,.067],.032,.035],[[-.010,0,.075],.011,.018]],dark,full?9:6,headTransform);
  if(full)box([.035,.047,-.021],[.006,.010,.021],wound,headTransform);

  // Fall the complete connected body; adjust its lowest surface to the floor
  // throughout the collapse. Normals rotate with it, including side headings.
  const fall=smooth(rig.death)*Math.PI/2,cf=Math.cos(fall),sf=Math.sin(fall);
  const raw=vertices.data,length=vertices.length;
  let lowest=Infinity;
  if(rig.death>0)for(let i=0;i<length;i+=12)lowest=Math.min(lowest,raw[i+2]*cf-raw[i]*sf);
  const lift=rig.death>0?-lowest:0;
  // Transform the pooled buffer in place, then reverse winding for z-down.
  for(let i=0;i<length;i+=12) {
    const x=raw[i]*cf+raw[i+2]*sf,y=raw[i+1],h=raw[i+2]*cf-raw[i]*sf+lift;
    const nx=raw[i+3]*cf+raw[i+5]*sf,ny=raw[i+4],nh=raw[i+5]*cf-raw[i+3]*sf;
    raw[i]=entity.x+x*ca-y*sa;raw[i+1]=entity.y+x*sa+y*ca;raw[i+2]=.5-h;
    raw[i+3]=nx*ca-ny*sa;raw[i+4]=nx*sa+ny*ca;raw[i+5]=-nh;
  }
  for(let i=0;i<length;i+=36)for(let j=0;j<12;j++){
    const swap=raw[i+12+j];raw[i+12+j]=raw[i+24+j];raw[i+24+j]=swap;
  }
  return finishMesh(vertices,lod,{state:entity.state||'idle',rig});
}
