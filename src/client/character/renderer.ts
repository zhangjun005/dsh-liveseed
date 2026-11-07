import { Box3, DirectionalLight, LoadingManager, OrthographicCamera, Scene, Texture, Vector3 } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { MMDLoader, MMDOutlineEffect, type MMDMesh } from '@takahirox/three-mmd';
import type { CharacterModel } from '../../core/character.js';
import { NativePose } from './pose.js';
import { initializePhysics } from './physics.js';
import { FramePacer } from './timing.js';
import { CharacterMMDHelper } from './helper.js';
import type { CharacterController, CharacterDiagnostics, Gesture, StageDriver } from './controller.js';
import { characterClips } from './clips.js';

export class CharacterRenderer implements StageDriver {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, .01, 1000);
  private readonly renderer = new WebGPURenderer({ alpha: true, antialias: true, forceWebGL: true });
  private readonly outlines = new MMDOutlineEffect(this.renderer);
  private readonly manager = new LoadingManager();
  private readonly helper = new CharacterMMDHelper({ sync: false, pmxAnimation: true });
  private mesh: MMDMesh | undefined;
  private pose?: NativePose;
  private disposed = false;
  private frame = 0;
  private readonly clock = new FramePacer();
  private frames = 0;
  private busy = false;
  private visible = true;
  private height = 1;
  private detach?: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly visibility = () => { this.clock.reset(); this.sampleAt = 0; this.sampleFrames = 0; this.updateMs = 0; this.renderMs = 0; if (document.hidden) cancelAnimationFrame(this.frame); else this.schedule(); };
  private readonly windowResize = () => this.fit();
  private diagnosticsDirty = true;
  private diagnosticAt = 0;
  private sampleAt = 0;
  private sampleFrames = 0;
  private updateMs = 0;
  private renderMs = 0;
  constructor(private readonly container: HTMLElement, private readonly model: CharacterModel, private readonly controller: CharacterController) {
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.domElement.setAttribute('aria-label', '德谬歌角色');
    this.renderer.domElement.dataset.characterCanvas = model.id;
    container.append(this.renderer.domElement);
    this.resizeObserver = new ResizeObserver(() => this.fit()); this.resizeObserver.observe(container);
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('resize', this.windowResize);
  }
  async load(): Promise<void> {
    this.controller.report({ status: 'loading', message: '' });
    await this.renderer.init();
    if (this.disposed) { this.renderer.dispose(); return; }
    const virtual = new URL(`/__liveseed_character__/${this.model.id}/`, location.href);
    const urls = new Map(this.model.resources.map(resource => [new URL(resource.name, virtual).href, resource.url]));
    urls.set(new URL('model.pmx', virtual).href, this.model.model);
    this.manager.setURLModifier(value => {
      if (value.startsWith('data:')) return value;
      const mapped = urls.get(new URL(value, location.href).href);
      if (!mapped) throw new Error('模型引用了未登记的本地资源。');
      return mapped;
    });
    let missingTextures = 0;
    const loaded = new Promise<void>((resolveLoaded, reject) => {
      this.manager.onLoad = () => resolveLoaded();
      this.manager.onError = () => { missingTextures++; reject(new Error('模型贴图未能完整加载。')); };
    });
    // Attach rejection handling immediately while the model request is still in flight.
    void loaded.catch(() => {});
    const loader = new MMDLoader(this.manager).setResourcePath(virtual.href);
    const mesh = await loader.loadAsync(new URL('model.pmx', virtual).href);
    this.mesh = mesh;
    await loaded;
    if (this.disposed) { this.releaseMesh(); return; }
    this.scene.add(mesh);
    // This MMD material already applies authored ambient; a second ambient light clips pale textures.
    const light = new DirectionalLight(0xffffff, .45); light.position.set(-1, 2, 3); this.scene.add(light);
    const bounds = new Box3().setFromObject(mesh);
    this.height = bounds.getSize(new Vector3()).y;
    const center = bounds.getCenter(new Vector3());
    this.camera.position.set(center.x, center.y, center.z + this.height * 2);
    this.camera.lookAt(center); this.camera.far = this.height * 6;
    this.pose = new NativePose(mesh, this.height);
    this.helper.add(mesh, { animation: this.pose.base, physics: false });
    this.bindPoseInput();
    this.detach = this.controller.attach(this);
    const metadata = mesh.geometry.userData.MMD;
    const kinds = new Map<number, number>();
    metadata.materialMorphs?.forEach(morph => kinds.set(morph.index, 8));
    metadata.boneMorphs?.forEach(morph => kinds.set(morph.index, 2));
    metadata.groupMorphs?.forEach(morph => kinds.set(morph.index, 0));
    metadata.uvMorphs?.forEach(morph => kinds.set(morph.index, 3 + morph.channel));
    const diagnostics: CharacterDiagnostics = { bones: mesh.skeleton.bones.length,
      morphs: Object.entries(mesh.morphTargetDictionary ?? {}).map(([name, index]) => ({ name, kind: kinds.get(index) ?? 1 })),
      rigidBodies: metadata.rigidBodies.length, materialMorphs: metadata.materialMorphs?.length ?? 0, missingTextures };
    this.renderer.domElement.dataset.characterBones = String(diagnostics.bones);
    this.renderer.domElement.dataset.characterMorphs = String(diagnostics.morphs.length);
    this.renderer.domElement.dataset.characterMaterialMorphs = String(diagnostics.materialMorphs);
    this.fit(); this.helper.update(0);
    this.outlines.render(this.scene, this.camera);
    this.renderer.domElement.dataset.characterReady = 'true';
    this.controller.report({ status: 'ready', message: '', diagnostics });
    this.schedule();
  }
  private bindPoseInput(): void {
    const mixer = this.mesh && this.helper.objects.get(this.mesh)?.mixer;
    if (!mixer) throw new Error('角色动作执行器尚未就绪。');
    const update = mixer.update.bind(mixer);
    // Owned mixer input hook: authored pose and Morphs enter once, before MMD grants/IK/material evaluation.
    mixer.update = dt => { const result = update(dt); this.pose?.apply(dt); return result; };
  }
  async setPhysics(enabled: boolean): Promise<void> {
    if (this.disposed || !this.mesh || !this.pose) return;
    if (!enabled) { this.helper.enable('physics', false); this.renderer.domElement.dataset.characterPhysics = 'false'; this.controller.physics('off'); return; }
    this.controller.physics('loading');
    try {
      await initializePhysics();
      if (this.disposed || !this.controller.snapshot().settings.physics || !this.mesh) return;
      if (!this.helper.objects.get(this.mesh)?.physics) {
        this.helper.remove(this.mesh);
        this.helper.add(this.mesh, { animation: this.pose.base, physics: true, warmup: 0, unitStep: 1 / 60, maxStepNum: 2,
          physicsMode: 'worker', workerPhysics: { ammoURL: new URL('/api/liveseed/character-engine/ammo.js', location.href).href,
            createWorker: () => new Worker('/api/liveseed/character-engine/physics-worker.js') } });
        this.bindPoseInput();
      }
      await this.helper.objects.get(this.mesh)?.physics?.ready;
      if (this.disposed || !this.controller.snapshot().settings.physics) return;
      this.helper.objects.get(this.mesh)?.physics?.reset();
      this.helper.enable('physics', true);
      this.renderer.domElement.dataset.characterPhysics = 'true'; this.controller.physics('on');
    } catch {
      if (this.mesh && this.pose && !this.helper.meshes.includes(this.mesh)) {
        this.helper.add(this.mesh, { animation: this.pose.base, physics: false }); this.bindPoseInput();
      }
      this.helper.enable('physics', false); this.controller.physics('error');
    }
  }
  setVisible(value: boolean): void { this.visible = value; this.visibility(); }
  resize(): void { this.fit(); }
  private fit(): void {
    if (this.disposed) return;
    const bounds = this.container.getBoundingClientRect();
    const { width, height } = bounds;
    if (width <= 0 || height <= 0) return;
    const left = Math.max(0, -bounds.left), top = Math.max(0, -bounds.top);
    const visibleWidth = Math.max(1, Math.min(width - left, innerWidth - Math.max(0, bounds.left)));
    const visibleHeight = Math.max(1, Math.min(height - top, innerHeight - Math.max(0, bounds.top)));
    this.renderer.setSize(visibleWidth, visibleHeight);
    this.renderer.domElement.style.left = `${left}px`; this.renderer.domElement.style.top = `${top}px`;
    const half = this.height * .57;
    this.camera.top = half; this.camera.bottom = -half; this.camera.left = -half * width / height; this.camera.right = half * width / height;
    this.camera.setViewOffset(width, height, left, top, visibleWidth, visibleHeight);
  }
  private schedule(): void { cancelAnimationFrame(this.frame); if (!this.disposed && !document.hidden && this.visible && this.mesh) this.frame = requestAnimationFrame(time => void this.draw(time)); }
  private draw(time: number): void {
    if (this.disposed || this.busy || !this.visible || document.hidden) return;
    const dt = this.clock.sample(time);
    if (dt === undefined) { this.schedule(); return; }
    this.busy = true;
    try {
      const start = performance.now();
      this.helper.update(dt);
      const updated = performance.now();
      this.outlines.render(this.scene, this.camera);
      const rendered = performance.now();
      this.updateMs += updated - start; this.renderMs += rendered - updated; this.sampleFrames++;
      if (!this.sampleAt) this.sampleAt = time;
      if (time - this.sampleAt >= 1000) {
        const data = this.renderer.domElement.dataset;
        data.characterFps = (this.sampleFrames * 1000 / (time - this.sampleAt)).toFixed(1);
        data.characterUpdateMs = (this.updateMs / this.sampleFrames).toFixed(2);
        data.characterRenderMs = (this.renderMs / this.sampleFrames).toFixed(2);
        data.characterPhysicsMode = this.mesh ? this.helper.objects.get(this.mesh)?.physics?.physicsMode ?? 'off' : 'off';
        const projection = this.mesh && this.helper.projectionStatus(this.mesh);
        if (projection) data.characterProjection = JSON.stringify(projection);
        this.sampleAt = time; this.sampleFrames = 0; this.updateMs = 0; this.renderMs = 0;
      }
      this.frames++;
      this.renderer.domElement.dataset.characterFrames = String(this.frames);
      if (this.diagnosticsDirty || time - this.diagnosticAt > 500) {
        this.diagnosticsDirty = false; this.diagnosticAt = time;
        this.renderer.domElement.dataset.characterMorphWeight = String(Math.max(0, ...(this.mesh?.morphTargetInfluences ?? [])));
        this.renderer.domElement.dataset.characterMorphName = this.controller.snapshot().selectedMorph;
        this.renderer.domElement.dataset.characterFinite = String(this.mesh?.skeleton.bones.every(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()].every(Number.isFinite)));
        const materials = Array.isArray(this.mesh?.material) ? this.mesh.material : this.mesh ? [this.mesh.material] : [];
        const flatten = (value: unknown): number[] => typeof value === 'number' ? [value] : Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? Object.values(value).flatMap(flatten) : [];
        let change = 0;
        for (const material of materials) {
          const data = material.userData.MMD;
          if (!data?.materialBase || !data.materialMorph) continue;
          const base = flatten(data.materialBase), applied = flatten(data.materialMorph);
          change += applied.reduce((sum, value, i) => sum + Math.abs(value - (base[i] ?? value)), 0);
        }
        this.renderer.domElement.dataset.characterMaterialChange = String(change);
      }
    } catch (error) {
      this.visible = false;
      this.controller.fail(error, '角色渲染暂时不可用，请重新加载页面后重试。');
    } finally { this.busy = false; this.schedule(); }
  }
  gesture(name: Gesture): void { this.pose?.gesture(name); this.diagnosticsDirty = true; }
  clip(name?: string): void { if (!name) { this.pose?.stopClip(); return; } const clip = characterClips[name]; if (clip) this.pose?.playClip(clip); }
  morph(name: string, weight: number): void { this.pose?.morph(name, weight); this.diagnosticsDirty = true; }
  clearMorphs(): void { this.pose?.clearMorphs(); this.diagnosticsDirty = true; }
  private releaseMesh(): void {
    const mesh = this.mesh; if (!mesh) return;
    if (this.helper.meshes.includes(mesh)) this.helper.remove(mesh);
    mesh.geometry.dispose(); mesh.skeleton.dispose();
    const textures = new Set<Texture>();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      Object.values(material).forEach(value => { if (value instanceof Texture) textures.add(value); });
      material.dispose();
    }
    textures.forEach(texture => texture.dispose()); this.scene.remove(mesh); this.mesh = undefined;
  }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.frame); this.manager.abort(); this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('resize', this.windowResize); this.detach?.(); this.releaseMesh();
    this.outlines.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
