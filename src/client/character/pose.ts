import { AnimationClip, Bone, QuaternionKeyframeTrack, VectorKeyframeTrack, Vector3, Quaternion } from 'three';
import type { MMDMesh } from '@takahirox/three-mmd';
import type { Gesture } from './controller.js';
import { motionTracks, trackMask, type MotionTrack } from './tracks.js';
import { sampleClip, sampleClipPositions, type CharacterClip } from './clips.js';

/** Small native-PMX calibration driver. Derived bones, D chains and physics bones remain owned by MMD. */
export class NativePose {
  private time = 0;
  private gestureTime = 0;
  private active: Gesture | undefined;
  private returning = 0;
  private readonly indices = new Map<string, number>();
  private readonly overrides = new Map<number, number>();
  private readonly axis = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly neutral: { rotation: Quaternion; position: Vector3 }[];
  private readonly palmAxes = new Map<string, Vector3>();
  private readonly previousInputs = new Map<number, { rotation: Quaternion; position: Vector3 }>();
  private readonly controlled = ['上半身', '上半身1', '上半身2', '下半身', '首', '頭', '両目', '右腕', '右ひじ', '右手首', '左腕', '左ひじ', '左手首', 'センター', '左足ＩＫ'];
  readonly base: AnimationClip;
  readonly height: number;
  constructor(private readonly mesh: MMDMesh, height: number, private readonly relaxedIdle = false) {
    this.height = height;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.bones.forEach((bone, i) => this.indices.set(bone.name, i));
    const neutral = mesh.skeleton.bones.map(bone => bone.quaternion.clone());
    for (const side of ['左', '右']) {
      const hand = this.bone(`${side}手首`), index = this.bone(`${side}人指１`), little = this.bone(`${side}小指１`);
      if (!hand || !index || !little) continue;
      const origin = hand.getWorldPosition(new Vector3());
      const normal = index.getWorldPosition(new Vector3()).sub(origin).cross(little.getWorldPosition(new Vector3()).sub(origin));
      if (normal.lengthSq() > 1e-10) this.palmAxes.set(side, normal.normalize().applyQuaternion(hand.getWorldQuaternion(new Quaternion()).invert()));
    }
    this.neutral = mesh.skeleton.bones.map((bone, i) => ({ rotation: neutral[i]!.clone(), position: bone.position.clone() }));
    const tracks = mesh.skeleton.bones.flatMap((bone, i) => [
      new QuaternionKeyframeTrack(`.bones[${i}].quaternion`, [0, 1], [...neutral[i]!.toArray(), ...neutral[i]!.toArray()]),
      new VectorKeyframeTrack(`.bones[${i}].position`, [0, 1], [...bone.position.toArray(), ...bone.position.toArray()]),
    ]);
    this.base = new AnimationClip('liveseed-native-neutral', 1, tracks);
  }
  private bone(name: string) { const index = this.indices.get(name); return index === undefined ? undefined : this.mesh.skeleton.bones[index]; }
  private turn(name: string, x: number, y = 0, z = 0): void {
    const bone = this.bone(name); if (!bone) return;
    const angle = Math.hypot(x, y, z); if (!angle) return;
    this.rotation.setFromAxisAngle(this.axis.set(x, y, z).normalize(), angle);
    bone.quaternion.multiply(this.rotation);
  }
  private aim(bone: Bone, end: Bone, target: Vector3): void {
    const from = end.getWorldPosition(new Vector3()).sub(bone.getWorldPosition(new Vector3()));
    if (from.lengthSq() < 1e-10) return;
    const delta = new Quaternion().setFromUnitVectors(from.normalize(), target.clone().normalize());
    const world = delta.multiply(bone.getWorldQuaternion(new Quaternion()));
    const parent = bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
    bone.quaternion.copy(parent.invert().multiply(world));
  }
  private arms(wave: number, phase: number): void {
    const torso = this.bone('上半身2')?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
    for (const side of ['左', '右']) {
      const arm = this.bone(`${side}腕`), elbow = this.bone(`${side}ひじ`), hand = this.bone(`${side}手首`);
      if (!arm || !elbow || !hand) continue;
      const sign = side === '右' ? -1 : 1;
      const amount = side === '右' ? wave : 0;
      // Targets are measured limb directions in torso space, not rotations about assumed PMX XYZ axes.
      // Keep wrists outside the coat and slightly forward instead of pressing both hands into the body.
      const upper = new Vector3(sign * .58, -.8, .15).normalize().lerp(new Vector3(sign * .85, .18, .5).normalize(), amount).normalize().applyQuaternion(torso);
      // Tilt the raised forearm gently toward the head rather than straight up/out.
      const forearm = new Vector3(sign * .36, -.86, .36).normalize().lerp(new Vector3(-sign * .18, .92, .38).normalize(), amount).normalize().applyQuaternion(torso);
      this.aim(arm, elbow, upper);
      this.aim(elbow, hand, forearm);
      const palm = this.palmAxes.get(side);
      if (palm && amount > 0) hand.quaternion.multiply(new Quaternion().setFromAxisAngle(palm, .18 * Math.sin(phase * Math.PI * 6) * amount));
    }
  }
  private smooth(dt: number): void {
    const gain = dt > 0 ? 1 - Math.exp(-20 * dt) : 1;
    for (const name of this.controlled) {
      const index = this.indices.get(name); if (index === undefined) continue;
      const bone = this.mesh.skeleton.bones[index]!;
      let previous = this.previousInputs.get(index);
      if (!previous) { previous = { rotation: bone.quaternion.clone(), position: bone.position.clone() }; this.previousInputs.set(index, previous); }
      previous.rotation.slerp(bone.quaternion, gain); previous.position.lerp(bone.position, gain);
      bone.quaternion.copy(previous.rotation); bone.position.copy(previous.position);
    }
  }
  gesture(name: Gesture): void {
    if (name === 'reset') { this.active = undefined; this.gestureTime = 0; this.returning = 0; this.overrides.clear(); this.previousInputs.clear(); return; }
    if (name === 'stop') { if (this.active) this.returning = .35; return; }
    // Every gesture starts and ends at the same authored baseline, without accumulating prior solver output.
    this.active = name; this.gestureTime = 0; this.returning = 0;
  }
  morph(name: string, weight: number): void {
    const index = this.mesh.morphTargetDictionary?.[name];
    if (index === undefined) return;
    if (weight <= 0) this.overrides.delete(index); else this.overrides.set(index, Math.min(1, weight));
  }
  clearMorphs(): void { this.overrides.clear(); }
  private readonly clipLayers = new Map<MotionTrack, { clip: CharacterClip; time: number; weight: number; releasing: boolean; exiting?: boolean; frozen?: boolean }[]>();
  /** A full recipe can start several tracks; a selected component touches only that track. */
  playClip(clip: CharacterClip, track?: MotionTrack): void {
    for (const part of track ? [track] : motionTracks) {
      const mask=trackMask(clip,part);if(!mask.length)continue;
      const layers=this.clipLayers.get(part) ?? [];
      // Freeze outgoing samples during crossfade, preserving continuity on interruption.
      for(const layer of layers){layer.releasing=true;layer.frozen=true;}
      layers.push({clip:{...clip,mask},time:0,weight:0,releasing:false});
      this.clipLayers.set(part,layers);
    }
  }
  stopClip(track?: MotionTrack): void {
    for(const part of track ? [track] : motionTracks)for(const layer of this.clipLayers.get(part) ?? []){
      if(layer.releasing)continue;
      if(layer.clip.holdAt !== undefined && !layer.exiting){
        if(layer.time<layer.clip.holdAt){layer.exiting=true;layer.releasing=true;}
        else {layer.time=layer.clip.releaseFrom ?? layer.time;layer.exiting=true;}
      }else layer.releasing=true;
    }
  }
  clipActive(track?: MotionTrack): boolean {
    return (track ? [track] : motionTracks).some(part=>(this.clipLayers.get(part)?.length ?? 0)>0);
  }
  motionNames(): Partial<Record<MotionTrack,string>> {
    return Object.fromEntries(motionTracks.flatMap(part=>{const layers=this.clipLayers.get(part) ?? [];const layer=layers.at(-1);return layer?[[part,layer.clip.name]]:[];}));
  }
  apply(dt: number): void {
    this.restore();
    this.authored(dt);
    this.applyClip(dt);
  }
  /** Restore this driver's authored baseline explicitly. Neither previous procedural offsets nor previous
   * IK / grant / physics output may become the next input, and PropertyMixer may skip constant tracks. */
  private restore(): void {
    this.mesh.skeleton.bones.forEach((bone, i) => { bone.quaternion.copy(this.neutral[i]!.rotation); bone.position.copy(this.neutral[i]!.position); });
  }
  private applyClip(dt: number): void {
    for(const part of motionTracks){
      const layers=this.clipLayers.get(part) ?? [];
      for(const layer of layers){
        if(!layer.frozen)layer.time+=dt;
        if(layer.clip.holdAt!==undefined&&!layer.exiting)layer.time=Math.min(layer.time,layer.clip.holdAt);
        if(!layer.releasing&&layer.time>layer.clip.duration-.25)layer.releasing=true;
        layer.weight=layer.releasing?Math.max(0,layer.weight-dt/.25):Math.min(1,layer.weight+dt/.25);
      }
      this.clipLayers.set(part,layers.filter(layer=>layer.weight>0));
    }
    const handWeight=Math.min(1,(this.clipLayers.get('hands') ?? []).reduce((sum,layer)=>sum+layer.weight,0));
    if(this.relaxedIdle&&this.active!=='wave')this.relaxArms(1-handWeight);
    for(const part of motionTracks){
      const layers=this.clipLayers.get(part) ?? [];
      const total=layers.reduce((sum,layer)=>sum+layer.weight,0);
      // Blend local deltas once per bone, rather than multiplying two competing poses.
      const inputs=new Map<string,{rotation:Quaternion;position:Vector3;weight:number}>();
      for(const layer of layers){
        const weight=layer.weight/Math.max(1,total);
        for(const [name,target] of sampleClip(layer.clip,layer.time)){
          const reference=layer.clip.frames[0]?.rotations[name];
          if(!reference||layer.clip.reference!=='clip-first-frame')continue;
          const delta=new Quaternion(...reference).normalize().invert().multiply(target);
          const input=inputs.get(name) ?? {rotation:new Quaternion(0,0,0,0),position:new Vector3(),weight:0};
          // Hemisphere-corrected linear quaternion blend, normalized after all layers.
          input.weight+=weight;
          const sign=delta.w<0?-1:1;
          input.rotation.x+=delta.x*weight*sign;input.rotation.y+=delta.y*weight*sign;
          input.rotation.z+=delta.z*weight*sign;input.rotation.w+=delta.w*weight*sign;
          inputs.set(name,input);
        }
        for(const [name,target] of sampleClipPositions(layer.clip,layer.time)){
          const input=inputs.get(name) ?? {rotation:new Quaternion(0,0,0,0),position:new Vector3(),weight:0};
          const reference=layer.clip.frames[0]?.positions?.[name];if(reference)target.sub(new Vector3(...reference));
          input.position.addScaledVector(target,weight);inputs.set(name,input);
        }
      }
      for(const [name,input] of inputs){const bone=this.bone(name);if(!bone)continue;
        input.rotation.w+=Math.max(0,1-input.weight);
        bone.quaternion.multiply(input.rotation.normalize()).normalize();bone.position.add(input.position);
      }
    }
  }
  private relaxArms(weight:number):void {
    if(weight<=0)return;
    const torso=this.bone('上半身2')?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
    for(const side of ['右','左']){
      const arm=this.bone(side+'腕'),elbow=this.bone(side+'ひじ'),hand=this.bone(side+'手首');
      if(!arm||!elbow||!hand)continue;
      const originalArm=arm.quaternion.clone(),originalElbow=elbow.quaternion.clone();
      const sign=side==='右'?-1:1;
      this.mesh.updateMatrixWorld(true);
      this.aim(arm,elbow,new Vector3(sign*.36,-.93,.07).normalize().applyQuaternion(torso));
      this.mesh.updateMatrixWorld(true);
      const horizontal=Math.hypot(.05,.16);
      const angle=Math.atan2(horizontal,.985)+15*Math.PI/180;
      this.aim(elbow,hand,new Vector3(sign*.05/horizontal*Math.sin(angle),-Math.cos(angle),.16/horizontal*Math.sin(angle)).applyQuaternion(torso));
      const targetArm=arm.quaternion.clone(),targetElbow=elbow.quaternion.clone();
      arm.quaternion.copy(originalArm).slerp(targetArm,weight);elbow.quaternion.copy(originalElbow).slerp(targetElbow,weight);
    }
  }
  /** Procedural baseline plus hand-authored gesture layers. */
  private authored(dt: number): void {
    this.time += dt;
    // Default quiet breathing is always present beneath manual clips.
    const breath=Math.sin(this.time * Math.PI * 2 / 4.8);
    this.turn('上半身1', .004 * breath);
    this.turn('上半身2', .008 * breath);
    this.turn('首', -.002 * breath);
    const eye = this.bone('両目');
    if (eye) this.turn('両目', .025 * Math.sin(this.time * .6), .04 * Math.sin(this.time * .4));
    if (this.mesh.morphTargetInfluences) {
      this.mesh.morphTargetInfluences.fill(0);
      const phase = this.time % 4;
      const blink = this.mesh.morphTargetDictionary?.['まばたき'];
      if (!this.overrides.size && blink !== undefined && phase < .22) this.mesh.morphTargetInfluences[blink] = Math.sin(Math.PI * phase / .22) ** 2;
      for (const [index, weight] of this.overrides) this.mesh.morphTargetInfluences[index] = weight;
    }
    if (!this.active) { this.arms(0, 0); this.smooth(dt); return; }
    this.gestureTime += dt;
    const progress = Math.min(1, this.gestureTime / (this.active === 'nod' ? 1.4 : 3));
    let amount = Math.sin(Math.PI * progress) ** 2;
    if (this.returning > 0) { this.returning = Math.max(0, this.returning - dt); amount *= this.returning / .35; }
    if (progress === 1 || this.returning === 0 && this.gestureTime > 0 && amount === 0) { this.active = undefined; this.arms(0, 0); this.smooth(dt); return; }
    if (this.active === 'nod') { this.turn('首', .035 * amount); this.turn('頭', .14 * amount); }
    if (this.active === 'lean') { this.turn('上半身', 0, 0, .055 * amount); this.turn('上半身1', 0, 0, .04 * amount); }
    if (this.active === 'weight' || this.active === 'leg') {
      const center = this.bone('センター'); if (center) center.position.x += this.height * .012 * amount;
      this.turn('下半身', 0, 0, -.02 * amount);
    }
    if (this.active === 'leg') {
      const foot = this.bone('左足ＩＫ');
      if (foot) { foot.position.y += this.height * .012 * amount; foot.position.z += this.height * .012 * Math.sin(progress * Math.PI * 2) * amount; }
    }
    this.arms(this.active === 'wave' ? amount : 0, progress);
    this.smooth(dt);
  }
}
