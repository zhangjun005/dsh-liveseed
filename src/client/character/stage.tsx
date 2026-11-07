import { useEffect, useRef, type PointerEvent } from 'react';
import { useCharacter, type CharacterController } from './controller.js';
import type { CharacterRenderer } from './renderer.js';
import { stageSize } from './layout.js';

export function CharacterStage({ controller }: { controller: CharacterController }) {
  const view = useCharacter(controller);
  const mount = useRef<HTMLDivElement>(null);
  const driver = useRef<CharacterRenderer>();
  const drag = useRef<{ x: number; y: number; right: number; bottom: number }>();
  const model = view.catalog?.models.find(item => item.id === view.settings.modelId) ?? view.catalog?.models[0];
  useEffect(() => {
    if (!model || !mount.current) return;
    const container = mount.current;
    let active = true;
    void (async () => {
      try {
        const { CharacterRenderer } = await import('./renderer.js');
        if (!active) return;
        const renderer = new CharacterRenderer(container, model, controller); driver.current = renderer;
        await renderer.load();
        if (active) { renderer.setVisible(controller.snapshot().settings.visible); void renderer.setPhysics(controller.snapshot().settings.physics); }
      } catch (error) { if (active) controller.fail(error, '角色加载失败，请检查本地模型与贴图。'); }
    })();
    return () => { active = false; driver.current?.dispose(); driver.current = undefined; };
  }, [model?.id, controller, view.generation]);
  useEffect(() => { driver.current?.setVisible(view.settings.visible); }, [view.settings.visible]);
  useEffect(() => { void driver.current?.setPhysics(view.settings.physics); }, [view.settings.physics]);
  useEffect(() => { driver.current?.resize(); }, [view.settings.x, view.settings.y, view.settings.scale]);
  useEffect(() => {
    const fit = () => {
      const { settings } = controller.snapshot();
      controller.setSettings({ x: settings.x, y: settings.y });
    };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, [controller, view.settings.scale]);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    controller.setSettings({ x: drag.current.right - (event.clientX - drag.current.x),
      y: drag.current.bottom - (event.clientY - drag.current.y) });
  };
  if (!model) return null;
  const { width, height } = stageSize(view.settings.scale);
  return <div className="ls-character-stage" role="region" aria-label="德谬歌常驻角色" data-character-model={model.id}
    style={{ right: view.settings.x, bottom: view.settings.y, width, height, visibility: view.settings.visible ? 'visible' : 'hidden' }}>
    <style>{styles}</style>
    <div className="ls-character-canvas" ref={mount}/>
    <button type="button" className="ls-character-handle" aria-label="移动德谬歌角色"
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, right: view.settings.x, bottom: view.settings.y }; }}
      onPointerMove={move} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>
    </button>
    {view.status === 'error' && <div className="ls-character-notice" role="status">{view.message}</div>}
  </div>;
}
const styles = `
.ls-character-stage{position:fixed;pointer-events:none!important;isolation:isolate;color:var(--dsw-alias-label-secondary);font:inherit}
.ls-character-canvas{position:absolute;inset:0;pointer-events:none}.ls-character-canvas canvas{display:block;position:absolute;pointer-events:none}
.ls-character-handle{position:absolute;top:0;left:50%;transform:translateX(-50%);display:grid;place-items:center;width:32px;height:24px;pointer-events:auto;touch-action:none;cursor:grab;background:var(--dsw-alias-bg-layer-1);color:inherit;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;opacity:.45}.ls-character-handle:hover,.ls-character-handle:focus-visible{opacity:1}.ls-character-handle:active{cursor:grabbing}
.ls-character-notice{position:absolute;bottom:30px;left:0;right:0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;text-align:center}
`;
