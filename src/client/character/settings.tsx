import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useCharacter, type CharacterController, type Gesture } from './controller.js';
import type { MotionTrack } from './tracks.js';
import { MIN_SCALE, MAX_SCALE, upperBodyFrame } from './layout.js';

export function CharacterSettings({ controller }: { controller: CharacterController }) {
  const view = useCharacter(controller);
  const model = view.catalog?.models.find(item => item.id === view.settings.modelId) ?? view.catalog?.models[0];
  const gestures: [Gesture, string][] = [['nod', '轻点头'], ['wave', '轻挥手'], ['lean', '身体侧倾'], ['weight', '重心移动'], ['leg', '腿部轻摆'], ['stop', '停止动作'], ['reset', '重置姿态']];
  const groups: {track:MotionTrack;label:string;clips:[string,string][]}[] = [
    {track:'hands',label:'手',clips:[['wave-small','播放挥手片段'],['behind-rest','保持背手'],['soft-open','轻张双臂'],['hands-front','胸前收手'],['hand-on-chest','手放胸口'],['chin-rest','托腮思考'],['touch-hair','整理头发']]},
    {track:'head',label:'头',clips:[['gentle-nod','缓点头回应'],['soft-shake','温和摇头'],['thoughtful-look','低头思索再抬眼'],['listening-lean','侧倾聆听'],['side-glance','侧身回望']]},
    {track:'body',label:'身体及腿部',clips:[['tiptoe-rock','微踮脚前后轻晃'],['weight-shift','重心轻移片段'],['leg-sway','轻摆腿片段'],['listening-lean','身体侧倾']]},
  ];
  const recipes:[string,string][]=[['hands-behind-look','背手前倾'],['behind-curious','背手歪头'],['listening-lean','背手侧倾聆听']];
  return <>
    <h3>角色显示</h3>
    <p className="ls-settings-description">角色常驻在 DSH 网页中，切换工作区和会话时保持显示。</p>
    {(view.status === 'error' || Boolean(view.catalog?.models.length)) && <Button variant="ghost" size="sm" onClick={() => controller.retry()}>重新加载角色</Button>}
    <div className="ls-setting-row"><div className="ls-setting-copy"><label htmlFor="ls-character-visible">显示角色</label></div><div className="ls-setting-controls"><input id="ls-character-visible" type="checkbox" checked={view.settings.visible} onChange={event => controller.setSettings({ visible: event.target.checked })}/></div></div>
    <div className="ls-setting-row"><div className="ls-setting-copy"><label htmlFor="ls-character-model">本地模型</label><p>{view.status === 'ready' ? '模型已加载' : view.status === 'loading' ? '正在加载…' : view.status === 'unavailable' ? '本地角色目录中暂无模型。' : view.message}</p></div><div className="ls-setting-controls"><select id="ls-character-model" value={model?.id ?? ''} onChange={event => controller.setSettings({ modelId: event.target.value })}><option value="" disabled>选择本地模型</option>{view.catalog?.models.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div></div>
    <div className="ls-setting-row"><div className="ls-setting-copy"><label htmlFor="ls-character-scale">显示大小</label><p>{Math.round(view.settings.scale * 100)}%</p></div><div className="ls-setting-controls"><input id="ls-character-scale" type="range" min={MIN_SCALE} max={MAX_SCALE} step="0.05" value={view.settings.scale} onChange={event => controller.setSettings({ scale: Number(event.target.value) })}/><Button variant="ghost" size="sm" onClick={() => controller.setSettings(upperBodyFrame({ width: innerWidth, height: innerHeight }))}>上半身构图</Button><Button variant="ghost" size="sm" onClick={() => controller.setSettings({ x: 24, y: 24, scale: 1 })}>恢复位置和大小</Button></div></div>
    <h3 style={{ marginTop: 24 }}>动作与表情预览</h3>
    <p className="ls-settings-description">先校准模型的原生表现；此处的预览不会写入对话或记忆。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{gestures.map(([name, label]) => <Button key={name} size="sm" variant="ghost" disabled={view.status !== 'ready'} onClick={() => controller.gesture(name)}>{label}</Button>)}</div>
    <p className="ls-settings-description">手、头、身体及腿部可分别选择并组合；同一组内切换。头部反应在手部空闲时配背手。</p>
    {groups.map(group=><div key={group.track} className="ls-setting-row"><div className="ls-setting-copy"><label>{group.label}</label></div><div className="ls-setting-controls" style={{display:'flex',flexWrap:'wrap',gap:8}}>{group.clips.map(([id,label])=><Button key={id} variant="ghost" size="sm" disabled={view.status!=='ready'} aria-pressed={view.motionNames?.[group.track]===id} onClick={()=>controller.clip(id,group.track)}>{label}</Button>)}<Button variant="ghost" size="sm" disabled={view.status!=='ready'} onClick={()=>controller.clip(undefined,group.track)}>停止{group.label}</Button></div></div>)}
    <div className="ls-setting-row"><div className="ls-setting-copy"><label>组合动作</label></div><div className="ls-setting-controls" style={{display:'flex',flexWrap:'wrap',gap:8}}>{recipes.map(([id,label])=><Button key={id} variant="ghost" size="sm" disabled={view.status!=='ready'} onClick={()=>controller.clip(id)}>{label}</Button>)}<Button variant="ghost" size="sm" disabled={view.status!=='ready'} onClick={()=>controller.clip(undefined)}>停止片段</Button></div></div>
    <div className="ls-setting-row"><div className="ls-setting-copy"><label htmlFor="ls-character-morph">表情预览</label></div><div className="ls-setting-controls"><select id="ls-character-morph" value={view.selectedMorph} disabled={view.status !== 'ready'} onChange={event => controller.morph(event.target.value, 1)}><option value="">无</option>{view.diagnostics?.morphs.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select><input aria-label="表情强度" type="range" min="0" max="1" step="0.05" value={view.morphWeight} onChange={event => controller.morph(view.selectedMorph, Number(event.target.value))}/><Button variant="ghost" size="sm" onClick={() => controller.clearMorphs()}>清除表情</Button></div></div>
    <div className="ls-setting-row"><div className="ls-setting-copy"><label htmlFor="ls-character-physics">头发与服装物理</label><p>{view.physicsState === 'loading' ? '正在准备物理…' : view.physicsState === 'error' ? '物理暂不可用，可关闭后重试。' : '首次验证默认关闭，开启后会增加渲染开销。'}</p></div><div className="ls-setting-controls"><input id="ls-character-physics" type="checkbox" disabled={view.status !== 'ready' || view.physicsState === 'loading'} checked={view.settings.physics} onChange={event => controller.setSettings({ physics: event.target.checked })}/></div></div>
  </>;
}
