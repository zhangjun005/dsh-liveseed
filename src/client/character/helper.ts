import { MMDAnimationHelper, type MMDMesh } from '@takahirox/three-mmd';
import { Quaternion, Vector3 } from 'three';

interface ProjectionStatus { frames: number; checks: number; batched: boolean; positionError: number; angleError: number; baseError: number }

/** Version-pinned 0.1.4 adapter. Preserve every native projection; batch redundant whole-mesh world updates. */
export class CharacterMMDHelper extends MMDAnimationHelper {
  private readonly status = new WeakMap<MMDMesh, ProjectionStatus>();
  projectionStatus(mesh: MMDMesh): ProjectionStatus | undefined { return this.status.get(mesh); }
  override _reprojectDynamicBones(mesh: MMDMesh): void {
    const state = this.objects.get(mesh);
    if (!state?.physics?.workerAdapter || !state.poseLayers) { super._reprojectDynamicBones(mesh); return; }
    const scale = mesh.getWorldScale(new Vector3());
    if ([scale.x, scale.y, scale.z].some(value => !Number.isFinite(value) || Math.abs(value-1)>1e-8)) { super._reprojectDynamicBones(mesh); return; }
    let status = this.status.get(mesh);
    if (!status) { status = { frames: 0, checks: 0, batched: true, positionError: 0, angleError: 0, baseError: 0 }; this.status.set(mesh, status); }
    status.frames++;
    if (!status.batched) { super._reprojectDynamicBones(mesh); return; }
    const run = () => {
      const update = mesh.updateMatrixWorld;
      update.call(mesh, true);
      // This actor keeps its mesh transform at unit scale. Native per-bone writes already update their
      // descendants; rewalking all 493 bones twice per rigid body is redundant inside this one pass.
      mesh.updateMatrixWorld = () => mesh.updateWorldMatrix(true, false);
      try { super._reprojectDynamicBones(mesh); }
      finally { mesh.updateMatrixWorld = update; update.call(mesh, true); }
    };
    if (![1, 10, 60].includes(status.frames)) { run(); return; }
    // Compare real, identical Bullet results with the unmodified upstream path at startup and in motion.
    // On any mismatch restore its exact output and permanently use that path for this model instance.
    const before = this.capture(mesh), beforeBase = state.poseLayers.postPhysicsBase.slice();
    super._reprojectDynamicBones(mesh);
    const expected = this.capture(mesh), expectedBase = state.poseLayers.postPhysicsBase.slice();
    this.restore(mesh, before); state.poseLayers.postPhysicsBase.set(beforeBase);
    run();
    const actual = this.capture(mesh), a = new Quaternion(), b = new Quaternion();
    for (let i=0; i<actual.length; i+=7) {
      status.positionError = Math.max(status.positionError, Math.hypot(actual[i]!-expected[i]!, actual[i+1]!-expected[i+1]!, actual[i+2]!-expected[i+2]!));
      status.angleError = Math.max(status.angleError, a.fromArray(actual,i+3).angleTo(b.fromArray(expected,i+3)));
    }
    for (let i=0; i<expectedBase.length; i++) status.baseError = Math.max(status.baseError, Math.abs(state.poseLayers.postPhysicsBase[i]!-expectedBase[i]!));
    status.checks++;
    if (!Number.isFinite(status.positionError+status.angleError+status.baseError) || status.positionError>1e-6 || status.angleError>1e-5 || status.baseError>1e-6) {
      status.batched = false; this.restore(mesh, expected); state.poseLayers.postPhysicsBase.set(expectedBase);
    }
  }
  private capture(mesh: MMDMesh): Float64Array {
    const result = new Float64Array(mesh.skeleton.bones.length*7);
    mesh.skeleton.bones.forEach((bone,i) => { bone.position.toArray(result,i*7); bone.quaternion.toArray(result,i*7+3); });
    return result;
  }
  private restore(mesh: MMDMesh, values: Float64Array): void {
    mesh.skeleton.bones.forEach((bone,i) => { bone.position.fromArray(values,i*7); bone.quaternion.fromArray(values,i*7+3); });
    mesh.updateMatrixWorld(true);
  }
}
