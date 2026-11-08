// Local-only rig for offline motion authoring. No model data is exported.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Bone, Skeleton, SkinnedMesh, BufferGeometry, MeshBasicMaterial, Vector3, Quaternion } from 'three';
import { NativePose } from '../../dist/client/character/pose.js';
export function loadAuthoringRig(path) {
const {Parser} = createRequire(import.meta.url)('mmd-parser');
const bytes = readFileSync(path);
const model = new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength),true);
const bones = model.bones.map(b => {const node=new Bone();node.name=b.name;return node;});
const mesh = new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());
model.bones.forEach((b,i)=>{
  bones[i].position.fromArray(b.position);
  if(b.parentIndex>=0) bones[i].position.sub(new Vector3(...model.bones[b.parentIndex].position));
  (b.parentIndex>=0?bones[b.parentIndex]:mesh).add(bones[i]);
});
mesh.bind(new Skeleton(bones));
const byName=new Map(bones.map(b=>[b.name,b]));
const get=name=>{const b=byName.get(name);if(!b)throw new Error('Missing control '+name);return b;};
const pose=new NativePose(mesh,1);
const mask=['上半身','上半身1','上半身2','首','頭',...['右','左'].flatMap(s=>[s+'腕',s+'ひじ',s+'手首'])];
const ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*t*(t*(t*6-15)+10);};
function aim(bone,end,direction){
  mesh.updateMatrixWorld(true);
  const from=end.getWorldPosition(new Vector3()).sub(bone.getWorldPosition(new Vector3())).normalize();
  const q=new Quaternion().setFromUnitVectors(from,direction.clone().normalize()).multiply(bone.getWorldQuaternion(new Quaternion()));
  bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).invert().multiply(q));
}
return {pose,mesh,get,byName,aim,ease,mask};
}
