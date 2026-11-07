import type { Context } from '@deepseek-ai/cordis';
import { useSyncExternalStore } from 'react';
import type { CharacterCatalog } from '../../core/character.js';
import { constrainHandle, MIN_SCALE, MAX_SCALE, stageSize } from './layout.js';

export type Gesture = 'nod' | 'wave' | 'lean' | 'weight' | 'leg' | 'stop' | 'reset';
export interface CharacterSettings { visible: boolean; scale: number; x: number; y: number; modelId: string; physics: boolean }
export interface CharacterDiagnostics {
  bones: number; morphs: { name: string; kind: number }[]; rigidBodies: number;
  materialMorphs: number; missingTextures: number;
}
export interface CharacterView {
  catalog?: CharacterCatalog; settings: CharacterSettings; status: 'loading' | 'ready' | 'error' | 'unavailable';
  message: string; diagnostics?: CharacterDiagnostics; selectedMorph: string; morphWeight: number;
  clipName: string;
  physicsState: 'off' | 'loading' | 'on' | 'error';
  generation: number;
}
export interface StageDriver {
  gesture(name: Gesture): void; clip(name?: string): void; morph(name: string, weight: number): void; clearMorphs(): void;
}
const KEY = 'liveseed.character.stage.v1';
const initial: CharacterSettings = { visible: true, scale: 1, x: 24, y: 24, modelId: '', physics: false };

/** Shared by the root stage and settings panel; contains display state only. */
export class CharacterController {
  private view: CharacterView;
  private readonly listeners = new Set<() => void>();
  private driver: StageDriver | undefined;
  private closed = false;
  constructor(private readonly ctx: Context) {
    let saved: Partial<CharacterSettings> = {};
    try {
      const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) saved = value as Partial<CharacterSettings>;
    } catch {}
    this.view = { settings: { ...initial, ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => {
      if (key === 'visible' || key === 'physics') return typeof value === 'boolean';
      if (key === 'modelId') return typeof value === 'string';
      return ['scale', 'x', 'y'].includes(key) && typeof value === 'number' && Number.isFinite(value);
    })) }, status: 'loading', message: '', selectedMorph: '', morphWeight: 0, clipName: '', physicsState: 'off', generation: 0 };
    this.setSettings({ scale: this.view.settings.scale });
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = (): CharacterView => this.view;
  private publish(update: Partial<CharacterView>): void {
    if (this.closed) return;
    this.view = { ...this.view, ...update }; this.listeners.forEach(listener => listener());
  }
  async load(): Promise<void> {
    try {
      const result = await this.ctx.remote.liveseed.character();
      if (!result.ok) throw result.error;
      this.publish({ catalog: result.value, status: result.value.models.length ? 'loading' : 'unavailable' });
    } catch { this.publish({ status: 'error', message: '暂时无法读取本地角色。' }); }
  }
  setSettings(update: Partial<CharacterSettings>): void {
    if (update.modelId !== undefined && update.modelId !== this.view.settings.modelId) this.clearMorphs();
    const settings = { ...this.view.settings, ...update };
    settings.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, settings.scale));
    if (settings.scale !== this.view.settings.scale) {
      const before = stageSize(this.view.settings.scale), after = stageSize(settings.scale);
      if (update.x === undefined) settings.x += (before.width - after.width) / 2;
      if (update.y === undefined) settings.y += before.height - after.height;
    }
    Object.assign(settings, constrainHandle(settings, { width: window.innerWidth, height: window.innerHeight }));
    this.publish({ settings });
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
  }
  report(update: Pick<CharacterView, 'status' | 'message'> & { diagnostics?: CharacterDiagnostics }): void { this.publish(update); }
  fail(error: unknown, message: string): void {
    this.ctx.logger.warn('Character stage failed: %s', error instanceof Error ? error.message : 'unknown error');
    this.publish({ status: 'error', message });
  }
  physics(state: CharacterView['physicsState']): void { this.publish({ physicsState: state }); }
  retry(): void {
    this.clearMorphs(); this.publish({ status: 'loading', message: '', generation: this.view.generation + 1 });
    if (!this.view.catalog) void this.load();
  }
  attach(driver: StageDriver): () => void { this.driver = driver; return () => { if (this.driver === driver) this.driver = undefined; }; }
  gesture(name: Gesture): void { this.driver?.gesture(name); }
  clip(name?: string): void { this.driver?.clip(name); this.publish({ clipName: name ?? '' }); }
  morph(name: string, weight = this.view.morphWeight): void {
    this.driver?.morph(this.view.selectedMorph, 0);
    this.driver?.morph(name, weight);
    this.publish({ selectedMorph: name, morphWeight: weight });
  }
  clearMorphs(): void { this.driver?.clearMorphs(); this.publish({ selectedMorph: '', morphWeight: 0 }); }
  close(): void { this.closed = true; this.driver = undefined; this.listeners.clear(); }
}
export function useCharacter(controller: CharacterController): CharacterView { return useSyncExternalStore(controller.subscribe, controller.snapshot); }
