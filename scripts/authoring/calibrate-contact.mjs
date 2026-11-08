// Offline authored contact/response poses: no physics, no model assets exported.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Vector3,Quaternion} from 'three';
import {loadAuthoringRig} from './local-rig.mjs';
import {characterClips,sampleClip} from '../../dist/client/character/clips.js';
const [path,...selected]=process.argv.slice(2);if(!path)throw new Error('Pass local PMX path after build');
const only=new Set(selected);
const {pose,mesh,get,byName,aim,ease}=loadAuthoringRig(path);
const torso=['上半身','上半身1','上半身2','首','頭'];
const arms=['右','左'].flatMap(s=>[s+'腕',s+'ひじ',s+'手首']);
const world=n=>get(n).getWorldPosition(new Vector3());
pose.apply(0);mesh.updateMatrixWorld(true);
const unit=world('右腕').distanceTo(world('右ひじ'));
const neutralPositions=new Map(['センター','左足ＩＫ','右足ＩＫ','左つま先ＩＫ','右つま先ＩＫ'].map(n=>[n,get(n).position.clone()]));
const rot=(n,x=0,y=0,z=0)=>{
  for(const [v,a] of [[new Vector3(1,0,0),x],[new Vector3(0,1,0),y],[new Vector3(0,0,1),z]])
    if(a)get(n).quaternion.multiply(new Quaternion().setFromAxisAngle(v,a));
};
const env=(t,d=4.5)=>ease(t/1.1)*(1-ease((t-d+1.1)/1.1));
const palmNormal=(side='右')=>world(side+'人指１').sub(world(side+'手首')).cross(world(side+'小指１').sub(world(side+'手首'))).normalize().multiplyScalar(side==='右'?1:-1);
function projectedAngle(from,to,axis){
 const a=from.clone().addScaledVector(axis,-from.dot(axis)),b=to.clone().addScaledVector(axis,-to.dot(axis));
 if(a.lengthSq()<1e-10||b.lengthSq()<1e-10)return 0;
 a.normalize();b.normalize();return Math.atan2(axis.dot(a.clone().cross(b)),a.dot(b));
}
function worldRotate(bone,q){
 const result=q.clone().multiply(bone.getWorldQuaternion(new Quaternion()));
 bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).invert().multiply(result));mesh.updateMatrixWorld(true);
}
// Resolve the second orientation axis as well as fingertip direction. Normal from
// wrist/index/little landmarks points out of the palm of the right hand.
function reachPalm(target,pole,fingers,palm,amount,side='右'){
 const a=get(side+'腕'),e=get(side+'ひじ'),h=get(side+'手首');
 const original=[a.quaternion.clone(),e.quaternion.clone(),h.quaternion.clone()];
 reach(side,target,pole,new Vector3(0,1,0),1);mesh.updateMatrixWorld(true);
 const forearm=world(side+'手首').sub(world(side+'ひじ')).normalize();
 const fingerDirection=(typeof fingers==='function'?fingers(forearm):fingers).clone().normalize();
 const palmDirection=(typeof palm==='function'?palm():palm).clone().normalize();
 const palmTarget=palmDirection;
 // Share axial pronation with the forearm input; leave positional bend at wrist small.
 const roll=projectedAngle(palmNormal(side),palmTarget,forearm);
 worldRotate(e,new Quaternion().setFromAxisAngle(forearm,roll));
 const currentFinger=world(side+'中指１').sub(world(side+'手首')).normalize();
 worldRotate(h,new Quaternion().setFromUnitVectors(currentFinger,fingerDirection));
 const twist=projectedAngle(palmNormal(side),palmTarget,fingerDirection);
 worldRotate(h,new Quaternion().setFromAxisAngle(fingerDirection,twist));
 const targetRotations=[a.quaternion.clone(),e.quaternion.clone(),h.quaternion.clone()];
 [a,e,h].forEach((bone,i)=>bone.quaternion.copy(original[i]).slerp(targetRotations[i],amount));
 mesh.updateMatrixWorld(true);
}
// Two-segment geometric construction is an offline posing tool, not a runtime solver.
function reach(side,target,pole,fingerDirection,amount){
  mesh.updateMatrixWorld(true);
  const a=get(side+'腕'),e=get(side+'ひじ'),h=get(side+'手首');
  const qa=a.quaternion.clone(),qe=e.quaternion.clone();
  const s=world(side+'腕'),ep=world(side+'ひじ'),hp=world(side+'手首');
  const l1=s.distanceTo(ep),l2=ep.distanceTo(hp);
  const dir=target.clone().sub(s),d=Math.min(l1+l2-.001,Math.max(Math.abs(l1-l2)+.001,dir.length()));dir.normalize();
  const p=pole.clone().sub(s);p.addScaledVector(dir,-p.dot(dir)).normalize();
  const along=(l1*l1-l2*l2+d*d)/(2*d),off=Math.sqrt(Math.max(0,l1*l1-along*along));
  const elbow=s.clone().addScaledVector(dir,along).addScaledVector(p,off);
  aim(a,e,elbow.sub(s));mesh.updateMatrixWorld(true);
  aim(e,h,target.clone().sub(world(side+'ひじ')));
  const ta=a.quaternion.clone(),te=e.quaternion.clone();
  a.quaternion.copy(qa).slerp(ta,amount);e.quaternion.copy(qe).slerp(te,amount);mesh.updateMatrixWorld(true);
  const finger=byName.get(side+'中指１');
  if(finger){const q=h.quaternion.clone();aim(h,finger,fingerDirection);const targetQ=h.quaternion.clone();h.quaternion.copy(q).slerp(targetQ,amount);}
}
const hold=sampleClip(characterClips['behind-curious'],2),ref=sampleClip(characterClips['behind-curious'],0);
const rightFingers=['人指','中指','薬指','小指'].flatMap(n=>['１','２','３'].map(i=>'右'+n+i)).filter(n=>byName.has(n));
const leftFingers=rightFingers.map(n=>'左'+n.slice(1)).filter(n=>byName.has(n));
function curlFingers(amount,bend=.85,side='右'){
 mesh.updateMatrixWorld(true);
 const axis=world(side+'人指１').sub(world(side+'小指１')).normalize().multiplyScalar(side==='右'?1:-1);
 for(const n of (side==='右'?rightFingers:leftFingers)){const b=get(n),local=axis.clone().applyQuaternion(b.getWorldQuaternion(new Quaternion()).invert());b.quaternion.multiply(new Quaternion().setFromAxisAngle(local,(Array.isArray(bend)?bend[['１','２','３'].indexOf(n.slice(-1))]:bend)*amount));mesh.updateMatrixWorld(true);}
}
const thumbs=['右','左'].flatMap(side=>['０','１','２'].map(i=>side+'親指'+i));
// Thumb uses a separate three-bone chain. Aim each segment from its actual
// child direction, rather than sharing the four-finger flexion axis.
function openThumb(side,direction,amount){
 for(const [name,end] of [['親指０','親指１'],['親指１','親指２'],['親指２','親指先']]){
   const bone=get(side+name),original=bone.quaternion.clone();
   aim(bone,get(side+end),direction);const target=bone.quaternion.clone();
   bone.quaternion.copy(original).slerp(target,amount);mesh.updateMatrixWorld(true);
 }
}
const specs=[
 {id:'soft-shake',duration:3.5,mask:torso,apply(t){const a=env(t,3.5);rot('首',0,.035*Math.sin((t-.5)*Math.PI*2/1.8)*a);rot('頭',0,.14*Math.sin((t-.5)*Math.PI*2/1.8)*a,.025*a);}},
 {id:'thoughtful-look',duration:4.5,mask:torso,apply(t){const a=env(t),back=ease((t-2.3)/.8);rot('首',.05*a,0);rot('頭',.14*a*(1-back),-.13*a*(1-back),-.06*a);}},
 {id:'listening-lean',duration:4.5,mask:torso,apply(t){const a=env(t);rot('上半身',.06*a,0,-.055*a);rot('上半身1',.045*a,0,-.045*a);rot('首',-.03*a);rot('頭',-.06*a,0,.13*a);}},
 {id:'behind-rest',duration:4.2,holdAt:1.3,releaseFrom:3.1,mask:[...torso,...arms],apply(t){const a=ease(t/.85)*(1-ease((t-3.1)/1.1));for(const n of arms)get(n).quaternion.multiply(new Quaternion().slerp(ref.get(n).clone().invert().multiply(hold.get(n)),a));}},
 {id:'hands-front',duration:4.5,mask:[...torso,...arms,...rightFingers,...leftFingers,...thumbs],apply(t){
   const a=env(t),center=world('上半身2');
   for(const [side,sign] of [['右',-1],['左',1]]){
     reachPalm(center.clone().add(new Vector3(sign*.49*unit,.20*unit,.78*unit)),center.clone().add(new Vector3(sign*1.05*unit,-.65*unit,.45*unit)),new Vector3(-sign*.80,.02,.60),new Vector3(0,-1,0),a,side);
     curlFingers(a,[0,1.25,1.05],side);
     openThumb(side,new Vector3(-sign*.57,-.80,.18).normalize(),a);
     // Preserve the solved arm and forearm; straighten only the hand along its forearm.
     const finger=world(side+'中指１').sub(world(side+'手首')).normalize();
     const forearm=world(side+'手首').sub(world(side+'ひじ')).normalize();
     const wristRotation=new Quaternion().slerp(new Quaternion().setFromUnitVectors(finger,forearm),a);
     worldRotate(get(side+'手首'),wristRotation);
     worldRotate(get(side+'手首'),new Quaternion().setFromAxisAngle(new Vector3(0,1,0),-sign*(.30+30*Math.PI/180)*a));
     const handDirection=world(side+'中指１').sub(world(side+'手首')).normalize();
     const liftAxis=handDirection.clone().cross(new Vector3(0,1,0)).normalize();
     worldRotate(get(side+'手首'),new Quaternion().setFromAxisAngle(liftAxis,5*Math.PI/180*a));
   }
   rot('頭',.025*a,0,.05*a);
 }},
 {id:'hand-on-chest',duration:4.5,mask:[...torso,...arms.slice(0,3)],apply(t){
   const a=env(t),shoulder=world('右腕');
   const upperLength=shoulder.distanceTo(world('右ひじ'));
   const foreLength=world('右ひじ').distanceTo(world('右手首'));
   // Preserve the 45-degree upper arm; forearm rises 60 degrees from vertical.
   const elbow=shoulder.clone().addScaledVector(new Vector3(-.60,-Math.SQRT1_2,Math.sqrt(.5-.60**2)),upperLength);
   const foreAngle=60*Math.PI/180, forwardAzimuth=20*Math.PI/180;
   const wrist=elbow.clone().addScaledVector(new Vector3(Math.sin(foreAngle)*Math.cos(forwardAzimuth),Math.cos(foreAngle),Math.sin(foreAngle)*Math.sin(forwardAzimuth)),foreLength);
   reachPalm(wrist,elbow,new Vector3(.95,.30,0),new Vector3(0,0,-1),a);
   rot('頭',.045*a,0,.045*a);
 }},
 {id:'chin-rest',duration:4.5,mask:[...torso,...arms,...rightFingers,...leftFingers],apply(t){
   const a=env(t);rot('頭',.035*a,0,-.17*a);mesh.updateMatrixWorld(true);const head=world('頭');
   for(const [side,sign] of [['右',-1],['左',1]]){
     reachPalm(head.clone().add(new Vector3(sign*.38*unit,(-.25-sign*.06)*unit,.72*unit)),world('上半身2').add(new Vector3(sign*.65*unit,-.60*unit,1.10*unit)),new Vector3(sign*.50,.05,-.86),new Vector3(0,1,0),a,side);
     curlFingers(a,.10,side);
   }
 }},
 {id:'touch-hair',duration:4.8,mask:[...torso,...arms.slice(0,3),...rightFingers],apply(t){const a=env(t,4.8);rot('頭',0,0,-.07*a);mesh.updateMatrixWorld(true);const head=world('頭');reachPalm(head.clone().add(new Vector3(-.65*unit,(.35+.035*Math.sin(t*3))*unit,.40*unit)),world('上半身2').add(new Vector3(-1.1*unit,.1*unit,.3*unit)),new Vector3(.30,.94,-.12),()=>head.clone().sub(world('右手首')),a);curlFingers(a,.32);}},
 {id:'weight-shift',duration:4.5,mask:['センター','下半身'],positions:['センター'],apply(t){const a=env(t);get('センター').position.x+=unit*.08*a;rot('下半身',0,0,-.018*a);}},
 {id:'tiptoe-rock',duration:6.4,mask:['センター','上半身','上半身1','上半身2','左足ＩＫ','右足ＩＫ','左つま先ＩＫ','右つま先ＩＫ'],positions:['センター','左足ＩＫ','右足ＩＫ','左つま先ＩＫ','右つま先ＩＫ'],apply(t){
   const a=env(t,6.4),rock=Math.sin((t-1.1)*Math.PI*2/3.2)*a;
   get('センター').position.y+=unit*.055*a;get('センター').position.z+=unit*.10*rock;
   rot('上半身',.060*rock);rot('上半身1',.040*rock);rot('上半身2',-.020*rock);
   mesh.updateMatrixWorld(true);
   for(const side of ['左','右']){
     const foot=get(side+'足ＩＫ'),toe=get(side+'つま先ＩＫ');
     const anchor=world(side+'つま先ＩＫ'),origin=world(side+'足ＩＫ');
     const theta=.075*a,reach=Math.abs(anchor.z-origin.z);
     foot.position.y+=reach*Math.sin(theta);foot.position.z+=reach*(1-Math.cos(theta));
     rot(side+'足ＩＫ',theta);mesh.updateMatrixWorld(true);
     toe.position.copy(toe.parent.worldToLocal(anchor.clone()));mesh.updateMatrixWorld(true);
   }
 }},
 {id:'leg-sway',duration:5,mask:['センター','下半身','左足ＩＫ'],positions:['センター','左足ＩＫ'],apply(t){const shift=env(t,5),lift=ease((t-1.1)/.7)*(1-ease((t-3.0)/.8));get('センター').position.x-=unit*.08*shift;rot('下半身',0,0,.018*shift);get('左足ＩＫ').position.y+=unit*.06*lift;get('左足ＩＫ').position.z+=unit*.055*Math.sin((t-1.1)*Math.PI/1.9)*lift;}},
];
const clips={};
for(const spec of specs){if(only.size&&!only.has(spec.id)){clips[spec.id]=characterClips[spec.id];continue;}const frames=[];for(let i=0;i<=Math.round(spec.duration*30);i++){
 const t=i/30;pose.gesture('reset');pose.apply(0);mesh.updateMatrixWorld(true);spec.apply(t);
 const frame={t,rotations:Object.fromEntries(spec.mask.map(n=>[n,get(n).quaternion.toArray().map(v=>+v.toFixed(7))]))};
 if(spec.positions)frame.positions=Object.fromEntries(spec.positions.map(n=>[n,get(n).position.clone().sub(neutralPositions.get(n)).toArray().map(v=>+v.toFixed(7))]));
 frames.push(frame);
}clips[spec.id]={name:spec.id,fps:30,duration:spec.duration,mask:spec.mask,reference:'clip-first-frame',interpolation:'offline-contact-poses@30fps',...(spec.holdAt?{holdAt:spec.holdAt,releaseFrom:spec.releaseFrom}:{}),frames,source:{tool:'LiveSeed contact and response poses v1',author:'AI-authored candidates; no physics or game animation extraction',authoringSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}};}
writeFileSync('src/client/character/contact.generated.ts','// Generated offline; rotation and relative displacement only, no model assets.\nimport type { CharacterClip } from \'./clips.js\';\nexport const contactClips: Record<string, CharacterClip> = '+JSON.stringify(clips,null,2)+';\n');
console.log('Authored '+Object.keys(clips).join(', '));
