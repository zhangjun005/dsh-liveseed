import { AnimationClip, Bone, QuaternionKeyframeTrack, VectorKeyframeTrack, Vector3, Quaternion } from 'three';
import type { MMDMesh } from '@takahirox/three-mmd';
import type { Gesture } from './controller.js';
import { sampleClip, type CharacterClip } from './clips.js';

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
  constructor(private readonly mesh: MMDMesh, height: number) {
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
      const forearm = new Vector3(sign * .36, -.86, .36).normalize().lerp(new Vector3(sign * .05, .92, .38).normalize(), amount).normalize().applyQuaternion(torso);
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
  private clipLayer: { clip: CharacterClip; time: number; weight: number; releasing: boolean } | undefined;
  /** Play a baked clip over the authored baseline. The clip never replaces the baseline outright. */
  playClip(clip: CharacterClip): void { this.clipLayer = { clip, time: 0, weight: 0, releasing: false }; }
  stopClip(): void { if (this.clipLayer) this.clipLayer.releasing = true; }
  clipActive(): boolean { return this.clipLayer !== undefined; }
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
    const layer = this.clipLayer;
    if (!layer) return;
    layer.time += dt;
    const fade = .25;
    if (!layer.releasing && layer.time > layer.clip.duration - fade) layer.releasing = true;
    layer.weight = layer.releasing ? Math.max(0, layer.weight - dt / fade) : Math.min(1, layer.weight + dt / fade);
    if (layer.weight <= 0) { this.clipLayer = undefined; return; }
    for (const [name, target] of sampleClip(layer.clip, layer.time)) {
      const index = this.indices.get(name);
      if (index === undefined) continue;
      this.mesh.skeleton.bones[index]!.quaternion.slerp(target, layer.weight);
    }
  }
  /** Procedural baseline plus hand-authored gesture layers. */
  private authored(dt: number): void {
    this.time += dt;
    this.turn('上半身2', .006 * Math.sin(this.time * 1.7));
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
