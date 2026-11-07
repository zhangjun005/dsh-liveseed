import type { AmmoAPI } from '@takahirox/three-mmd';

type Factory = (options: { locateFile(name: string): string }) => Promise<AmmoAPI>;
let initialized: Promise<void> | undefined;

/** The MMD runtime uses the browser's shared Ammo global; loaded only after the user enables physics. */
export function initializePhysics(): Promise<void> {
  return initialized ??= (async () => {
    const scope = globalThis as typeof globalThis & { Ammo?: AmmoAPI | Factory };
    if (scope.Ammo && typeof scope.Ammo !== 'function') {
      if (typeof scope.Ammo.btVector3 !== 'function') throw new Error('现有物理运行时不兼容。');
      return;
    }
    if (!scope.Ammo) await new Promise<void>((done, reject) => {
      const script = document.createElement('script');
      script.src = '/api/liveseed/character-engine/ammo.js';
      const timeout = window.setTimeout(() => { script.remove(); reject(new Error('物理运行时加载超时。')); }, 15000);
      script.onload = () => { clearTimeout(timeout); script.remove(); done(); };
      script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('物理运行时加载失败。')); };
      document.head.append(script);
    });
    const factory = scope.Ammo;
    if (typeof factory !== 'function') throw new Error('物理运行时未能初始化。');
    const engine = await factory({ locateFile: () => '/api/liveseed/character-engine/ammo.wasm' });
    if (typeof engine.btVector3 !== 'function') throw new Error('物理运行时无效。');
    scope.Ammo = engine;
  })().catch(error => { initialized = undefined; throw error; });
}
