// Four offline-authored candidates for the small Cyrene rig. Rotations only.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Vector3,Quaternion} from 'three';
import {loadAuthoringRig} from './local-rig.mjs';
import {characterClips,sampleClip} from '../../dist/client/character/clips.js';
const [path]=process.argv.slice(2);
if(!path)throw new Error('Pass local PMX after pnpm build.');
const {pose,mesh,get,byName,aim,ease}=loadAuthoringRig(path);
const torsoMask=['上半身','上半身1','上半身2','首','頭'];
const armMask=['右','左'].flatMap(s=>[s+'腕',s+'ひじ',s+'手首']);
const behind=sampleClip(characterClips['hands-behind-look'],2.2);
const behindRef=sampleClip(characterClips['hands-behind-look'],0);
const turn=(name,x=0,y=0,z=0)=>{
  for(const [axis,angle] of [[new Vector3(1,0,0),x],[new Vector3(0,1,0),y],[new Vector3(0,0,1),z]])
    if(angle)get(name).quaternion.multiply(new Quaternion().setFromAxisAngle(axis,angle));
};
const specs=[
  {id:'behind-curious',duration:4.2,mask:[...torsoMask,...armMask],apply(t){
    const arms=ease(t/.85)*(1-ease((t-3.1)/1.1));
    for(const name of armMask){
      const delta=behindRef.get(name).clone().invert().multiply(behind.get(name));
      get(name).quaternion.multiply(new Quaternion().slerp(delta,arms));
    }
    const tilt=ease((t-.85)/.7)*(1-ease((t-2.8)/.7));
    turn('首',0,0,-.035*tilt);turn('頭',-.035*tilt,0,-.18*tilt);
    turn('上半身2',0,0,.025*tilt);
  }},
  {id:'side-glance',duration:3.8,mask:torsoMask,apply(t){
    const body=ease(t/.85)*(1-ease((t-2.9)/.9));
    const glance=ease((t-.55)/.8)*(1-ease((t-2.55)/.85));
    turn('上半身',0,-.10*body);turn('上半身1',0,-.08*body);turn('上半身2',0,-.10*body);
    turn('首',0,.10*glance);turn('頭',-.025*glance,.18*glance,.065*glance);
  }},
  {id:'soft-open',duration:4.2,mask:[...torsoMask,...armMask],apply(t){
    const amount=ease(t/1.05)*(1-ease((t-2.95)/1.25));
    turn('上半身2',-.035*amount);turn('頭',-.025*amount,0,-.045*amount);
    mesh.updateMatrixWorld(true);
    const torso=get('上半身2').getWorldQuaternion(new Quaternion());
    for(const [side,sign] of [['右',-1],['左',1]]){
      const arm=get(side+'腕'),elbow=get(side+'ひじ'),hand=get(side+'手首');
      const baseArm=arm.quaternion.clone(),baseElbow=elbow.quaternion.clone();
      aim(arm,elbow,new Vector3(sign*.75,-.58,.32).normalize().applyQuaternion(torso));
      aim(elbow,hand,new Vector3(sign*.65,-.40,.65).normalize().applyQuaternion(torso));
      const targetArm=arm.quaternion.clone(),targetElbow=elbow.quaternion.clone();
      arm.quaternion.copy(baseArm).slerp(targetArm,amount);elbow.quaternion.copy(baseElbow).slerp(targetElbow,amount);
      mesh.updateMatrixWorld(true);
      const finger=byName.get(side+'中指１');
      if(finger){const base=hand.quaternion.clone();aim(hand,finger,new Vector3(sign*.6,-.08,.75).normalize().applyQuaternion(torso));const target=hand.quaternion.clone();hand.quaternion.copy(base).slerp(target,amount);}
    }
  }},
  {id:'gentle-nod',duration:2.8,mask:torsoMask,apply(t){
    const nod=ease((t-.3)/.65)*(1-ease((t-1.15)/.8));
    const tilt=ease(t/.45)*(1-ease((t-2.15)/.65));
    turn('首',.045*nod);turn('頭',.15*nod,0,.045*tilt);turn('上半身2',.02*nod);
  }},
];
const clips={};
for(const spec of specs){
  const frames=[];
  for(let i=0;i<=Math.round(spec.duration*30);i++){
    const t=i/30;pose.gesture('reset');pose.apply(0);mesh.updateMatrixWorld(true);
    spec.apply(t);
    frames.push({t,rotations:Object.fromEntries(spec.mask.map(n=>[n,get(n).quaternion.toArray().map(v=>+v.toFixed(7))]))});
  }
  clips[spec.id]={name:spec.id,fps:30,duration:spec.duration,mask:spec.mask,reference:'clip-first-frame',interpolation:'authored-reactions@30fps',frames,
    source:{tool:'LiveSeed small Cyrene reactions v1',author:'AI-authored candidates, pending user approval; not extracted game animations',authoringSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}};
}
writeFileSync('src/client/character/reactions.generated.ts','// Generated offline by scripts/authoring/calibrate-reactions.mjs; rotations only.\nexport const reactionClips = '+JSON.stringify(clips,null,2)+' as const;\n');
console.log('Authored '+Object.keys(clips).join(', '));
