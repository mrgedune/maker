/** Render-only displacement-driven suit locomotion and action blending.
 * Time is performance-clock milliseconds; records follow stable player objects.
 */
const tracks = new WeakMap();
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const finite = (v,f=0) => Number.isFinite(v)?v:f;
const wrap = v => Math.atan2(Math.sin(v),Math.cos(v));
const ease = (a,b,rate,dt) => a+(b-a)*(1-Math.exp(-rate*dt));
export function resolveOperativeMotion(entity, nowMs=0) {
  const x=finite(entity.x),y=finite(entity.y),angle=finite(entity.angle);
  let t=tracks.get(entity);
  const alive=!entity.isDead && entity.state!=='link_lost' && !entity.finisherPose;
  // Movement packets normally arrive at 20 Hz. A lost release must not leave
  // a hand suspended indefinitely after a pause, disconnect or floor change.
  const fresh=!Number.isFinite(entity.lastAuthorityPacketAt) || nowMs-entity.lastAuthorityPacketAt<750;
  const targets={scanner:alive&&fresh&&(entity.scannerRaised||entity.mapActive)?1:0,
    interact:alive&&fresh&&(entity.isInteracting||entity.isDrawingCharge)?1:0,
    calibrate:alive&&fresh&&entity.isCalibrating?1:0,
    lamp:alive&&entity.flashlightOn?1:0};
  if(!t || nowMs<t.time || nowMs-t.time>500 || entity.authoritativePhaseEpoch!==t.epoch) {
    t={x,y,angle,time:nowMs,epoch:entity.authoritativePhaseEpoch,gait:0,
      speed:0,forward:0,strafe:0,turn:0,look:0,...targets};tracks.set(entity,t);
  }
  const dt=clamp((nowMs-t.time)/1000,0,.1),dx=x-t.x,dy=y-t.y,d=Math.hypot(dx,dy);
  const teleport=dt>0&&d>Math.max(.65,dt*5);
  const valid=alive&&!teleport&&dt>0;
  const speed=valid?Math.min(4,d/dt):0;
  const f=valid?(dx*Math.cos(angle)+dy*Math.sin(angle))/dt:0;
  const s=valid?(-dx*Math.sin(angle)+dy*Math.cos(angle))/dt:0;
  t.speed=ease(t.speed,speed,speed>t.speed?14:18,dt);
  t.forward=ease(t.forward,f,14,dt);t.strafe=ease(t.strafe,s,14,dt);
  const turn=valid?clamp(wrap(angle-t.angle)/dt,-4,4):0;
  t.turn=ease(t.turn,turn,12,dt);
  // The stance foot travels rearward as the body advances. No idle marching,
  // and no extra steps from a teleport or authoritative position correction.
  if(valid)t.gait=(t.gait+Math.min(d*5.45,dt*10.8)+Math.abs(turn)*dt*1.5*(1-clamp(speed,0,1)))%(Math.PI*2);
  for(const key of Object.keys(targets))t[key]=ease(t[key],targets[key],targets[key]?12:9,dt);
  // Network pitch is the existing row-based camera value. Bound its cosmetic
  // conversion; it never participates in aim, light projection or authority.
  t.look=ease(t.look,clamp(finite(entity.pitch)*.008,-.55,.55),12,dt);
  if(!alive||teleport){t.speed=0;t.forward=0;t.strafe=0;t.turn=0;}
  if(!alive){t.scanner=0;t.interact=0;t.calibrate=0;t.lamp=0;}
  Object.assign(t,{x,y,angle,time:nowMs,epoch:entity.authoritativePhaseEpoch});
  const length=Math.hypot(t.forward,t.strafe);
  return {gait:t.gait,move:clamp(t.speed/1.05,0,1.3),speed:t.speed,
    forward:length>.02?t.forward/length:1,strafe:length>.02?t.strafe/length:0,
    turn:t.turn,look:t.look,scanner:t.scanner,interact:t.interact,
    calibrate:t.calibrate,lamp:t.lamp};
}
