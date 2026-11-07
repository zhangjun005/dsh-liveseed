import { useEffect, useRef, useState } from 'react';
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { NativeComposer } from './composer.js';
import { SettingsDialog } from './settings-dialog.js';
import type { Context } from '@deepseek-ai/cordis';
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { RemoteStreamCarrierError, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { descriptors } from '../adapters/harness/remote-contract.js';
import type { CompanionCatalog, FollowFrame, SessionView } from '../core/protocol.js';

const PANEL = 'liveseed' as MainPanelId;
export const inject = ['slots', 'remote', 'connection'];
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' };
export function SeedIcon({ size }: Pick<SidebarPanelIconOwnerProps, 'size'>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21V12M12 15C5 15 3 10 4 5c6 0 9 3 8 10ZM12 11c0-5 3-8 8-8 1 5-2 9-8 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function CompanionPanel({ ctx }: { ctx: Context }) {
  const [catalog, setCatalog] = useState<CompanionCatalog>();
  const [selection, setSelection] = useState('current');
  const [view, setView] = useState<SessionView>();
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState<'chat' | 'memory' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [workerTitle, setWorkerTitle] = useState('');
  const [workerChoice, setWorkerChoice] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [choosingWorker, setChoosingWorker] = useState(false);
  const createWorkerRequest = useRef<{ requestId: string; title: string }>();
  const pending = useRef(new Map<string, { requestId: string; text: string }>());
  const mounted = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const navigationButton = useRef<HTMLButtonElement>(null);
  const selected = useRef(selection); selected.current = selection;
  const limit = limits[selection] ?? 200;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!navigationOpen) return;
    const outside = (event: PointerEvent) => { if (!navigation.current?.contains(event.target as Node)) setNavigationOpen(null); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setNavigationOpen(null); navigation.current?.querySelector<HTMLButtonElement>(`button[data-entry="${navigationOpen}"]`)?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [navigationOpen]);
  useEffect(() => {
    let active = true;
    let stream: RemoteStream<FollowFrame> | undefined;
    setView(undefined); setError('');
    void (async () => {
      try {
        stream = ctx.remote.$stream<FollowFrame>({
          name: 'liveseed.session',
          open: async function* (signal) {
            const handle = ctx.remote.liveseed.follow({ sessionId: selection, limit });
            const cancel = () => handle.dispose();
            signal.addEventListener('abort', cancel);
            if (signal.aborted) cancel();
            try { yield* handle; } finally { signal.removeEventListener('abort', cancel); handle.dispose(); }
          },
          ended: () => new RemoteStreamCarrierError('德谬歌会话连接已结束。'),
          carrierFailed: () => { if (active) setConnectionError('连接中断，正在重新连接。'); },
        });
        for await (const item of stream) {
          if (!active) break;
          const frame = item.value;
          if (frame.type === 'baseline') { setCatalog(frame.catalog); setView(frame.view); item.accept(); }
          else {
            if (frame.catalog) setCatalog(frame.catalog);
            if (frame.view) setView(frame.view);
            else if (frame.live) setView(previous => previous ? { ...previous, ...frame.live } : previous);
          }
          setConnectionError('');
        }
      } catch (failure) { if (active) setConnectionError(failure instanceof Error ? failure.message : '会话暂时不可用。'); }
    })();
    return () => { active = false; void stream?.dispose(); };
  }, [ctx, selection, limit, connectionAttempt]);
  useEffect(() => { scroll.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [view?.messages.length, view?.liveText]);
  const choose = (id: string) => { setSelection(id); setNavigationOpen(null); setError(''); };
  const memory = selection === 'memory' || catalog?.memorySessions.some(worker => worker.id === selection);
  const assignWorker = async (sessionId: string) => {
    if (!catalog) return;
    const result = await ctx.remote.liveseed.selectMemorySession({ sessionId, expectedSessionId: catalog.memorySessionId });
    if (!result.ok) throw result.error;
    if (mounted.current) { setWorkerChoice(sessionId); setSettingsMessage('已指定整理 Session。'); }
  };
  const selectWorker = async (sessionId: string) => {
    setChoosingWorker(true); setError(''); setSettingsMessage('');
    try { await assignWorker(sessionId); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '暂时无法指定整理会话。'); }
    finally { if (mounted.current) setChoosingWorker(false); }
  };
  const createWorker = async (assign = true) => {
    const title = workerTitle.trim(); if (!title || !catalog) return;
    setChoosingWorker(true); setError(''); setSettingsMessage('');
    const request = createWorkerRequest.current?.title === title ? createWorkerRequest.current : { requestId: crypto.randomUUID(), title };
    createWorkerRequest.current = request;
    try {
      const result = await ctx.remote.liveseed.createMemorySession(request); if (!result.ok) throw result.error;
      if (assign) await assignWorker(result.value.sessionId);
      else choose(result.value.sessionId);
      if (mounted.current) { setWorkerTitle(''); createWorkerRequest.current = undefined; }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '暂时无法创建整理会话。'); }
    finally { if (mounted.current) setChoosingWorker(false); }
  };
  const send = async (target: string, text: string): Promise<SubmitOutcome> => {
    if (!text.trim() || text.trim().length > 6000) return { kind: 'error', text: '消息请保持在 1–6000 字以内。' };
    const prior = pending.current.get(target);
    const request = prior?.text === text.trim() ? prior : { requestId: crypto.randomUUID(), text: text.trim() };
    pending.current.set(target, request); setError('');
    try {
      const result = await ctx.remote.liveseed.send({ sessionId: target, ...request });
      if (!result.ok) throw result.error;
      pending.current.delete(target);
      return { kind: 'success' };
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '消息暂未送达。';
      if (mounted.current && selected.current === target) setError(message);
      return { kind: 'error', text: message };
    }
  };
  const stop = async () => {
    setStopping(true);
    try { const result = await ctx.remote.liveseed.stop({ sessionId: selection }); if (!result.ok) throw result.error; }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '暂时无法停止。'); }
    finally { if (mounted.current) setStopping(false); }
  };
  const days = [...new Set(catalog?.sessions.filter(session => session.kind === 'chat').map(session => session.day) ?? [])].reverse();
  return <section className="ls-panel" aria-label="德谬歌陪伴面板">
    <style>{styles}</style>
    <div className="ls-floating-navigation" ref={navigation}>
      <button ref={navigationButton} data-entry="chat" type="button" className="ls-navigation-toggle" aria-label="聊天会话" title="聊天" aria-expanded={navigationOpen === 'chat'} aria-controls="ls-chat-menu" onClick={() => setNavigationOpen(navigationOpen === 'chat' ? null : 'chat')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h14v11H9l-4 3V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      </button>
      <button data-entry="memory" type="button" className="ls-navigation-toggle" aria-label="记忆整理会话" title="记忆整理" aria-expanded={navigationOpen === 'memory'} aria-controls="ls-memory-menu" onClick={() => setNavigationOpen(navigationOpen === 'memory' ? null : 'memory')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 4h12v16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 4v16M11 8h4M11 12h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button data-entry="settings" type="button" className="ls-navigation-toggle" aria-label="德谬歌设置" title="设置" aria-expanded={settingsOpen} aria-haspopup="dialog" onClick={() => { setNavigationOpen(null); setSettingsOpen(true); }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 4 1-2h4l1 2 2 1 2 0 2 4-1 2v2l1 2-2 4h-2l-2 1-1 2h-4l-1-2-2-1H5l-2-4 1-2v-2L3 9l2-4h2l2-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.4"/></svg>
      </button>
    {navigationOpen === 'chat' && <nav id="ls-chat-menu" className="ls-sessions" aria-label="聊天会话列表">
      <Button variant="ghost" className={`ls-thread ${selection === 'current' ? 'ls-selected' : ''}`} onClick={() => choose('current')}>聊天</Button>
      <div className="ls-daily">{days.map(day => <div key={day} className="ls-day-group">{catalog?.sessions.filter(session => session.kind === 'chat' && session.day === day).map((session, index, group) => <Button
        variant="ghost" key={session.id} className={`ls-session ${session.active && selection === 'current' || selection === session.id ? 'ls-selected' : ''}`}
        aria-label={`聊天 ${day}${group.length > 1 ? ` · ${index + 1}` : ''}`} aria-current={session.active && selection === 'current' || selection === session.id ? 'page' : undefined}
        onClick={() => choose(session.active ? 'current' : session.id)}><span>{day}{group.length > 1 ? ` · ${index + 1}` : ''}</span><span className="ls-session-status">{session.running ? '回复中' : session.active ? '当前' : ''}</span></Button>)}</div>)}</div>
    </nav>}
    {navigationOpen === 'memory' && <nav id="ls-memory-menu" className="ls-sessions" aria-label="记忆整理会话列表">
      {catalog?.memorySessions.map(worker => <Button variant="ghost" key={worker.id} className={`ls-session ${selection === worker.id || selection === 'memory' && worker.active ? 'ls-selected' : ''}`}
        aria-label={`打开 ${worker.title}`} aria-current={selection === worker.id || selection === 'memory' && worker.active ? 'page' : undefined}
        onClick={() => choose(worker.id)}><span>{worker.title}</span><span className="ls-session-status">{worker.running ? '回复中' : worker.active ? '整理任务' : ''}</span></Button>)}
      <form className="ls-new-worker" onSubmit={event => { event.preventDefault(); void createWorker(false); }}>
        <input aria-label="新整理会话名称" placeholder="新整理会话名称" maxLength={80} value={workerTitle} onChange={event => setWorkerTitle(event.target.value)} disabled={choosingWorker} />
        <Button type="submit" variant="ghost" size="sm" disabled={!workerTitle.trim() || choosingWorker}>新建会话</Button>
      </form>
    </nav>}
    </div>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} sections={[{ id: 'memory', label: '记忆整理', content: <>
      <form className="ls-setting-row" onSubmit={event => { event.preventDefault(); void selectWorker(workerChoice || catalog?.memorySessionId || ''); }}>
        <div className="ls-setting-copy"><label htmlFor="ls-worker-select">整理任务会话</label><p>自动整理和反思任务投递到此 Session。打开其他会话不会改变这项设置。</p></div>
        <div className="ls-setting-controls"><select id="ls-worker-select" value={workerChoice || catalog?.memorySessionId || ''} onChange={event => { setWorkerChoice(event.target.value); setSettingsMessage(''); }} disabled={!catalog || choosingWorker}>
          {catalog?.memorySessions.map(worker => <option key={worker.id} value={worker.id}>{worker.title}{worker.active ? '（当前）' : ''}</option>)}
        </select><Button type="submit" variant="ghost" size="sm" disabled={!catalog || !workerChoice || workerChoice === catalog.memorySessionId || choosingWorker || catalog.memorySessions.some(worker => worker.running)}>指定</Button></div>
      </form>
      <form className="ls-setting-row" onSubmit={event => { event.preventDefault(); void createWorker(); }}>
        <div className="ls-setting-copy"><label htmlFor="ls-worker-title">新建整理 Session</label><p>创建一个新会话，并指定它承担后续整理任务。</p></div>
        <div className="ls-setting-controls"><input id="ls-worker-title" aria-label="新整理会话名称" placeholder="新整理会话名称" maxLength={80} value={workerTitle} onChange={event => setWorkerTitle(event.target.value)} disabled={choosingWorker} />
        <Button type="submit" variant="ghost" size="sm" disabled={!workerTitle.trim() || choosingWorker || catalog?.memorySessions.some(worker => worker.running)}>新建并指定</Button></div>
      </form>
      <div className="ls-setting-row">
        <div className="ls-setting-copy"><span>soul.md</span><p>人物材料</p></div>
        <div className="ls-setting-controls"><code className="ls-file-path" aria-label="soul.md 路径">{catalog?.filePaths.soul ?? '正在读取路径…'}</code></div>
      </div>
      <div className="ls-setting-row">
        <div className="ls-setting-copy"><span>narrative.md</span><p>积累的自我与关系叙事</p></div>
        <div className="ls-setting-controls"><code className="ls-file-path" aria-label="narrative.md 路径">{catalog?.filePaths.narrative ?? '正在读取路径…'}</code></div>
      </div>
      {settingsMessage && <p className="ls-settings-status" role="status">{settingsMessage}</p>}
      {error && <p className="ls-settings-status" role="alert">{error}</p>}
    </> }]} />
    <div className="ls-conversation">
      <div className="ls-story" role="log" aria-live="polite" aria-relevant="additions text">
        {view && !view.messages.length && !view.liveText && <p className="ls-empty">{memory ? '想怎样整理这些记忆？' : '想聊什么？'}</p>}
        <div className="ls-messages">
          {view && view.messages.length >= limit && limit < 2000 && <Button variant="ghost" size="sm" className="ls-older" onClick={() => setLimits(previous => ({ ...previous, [selection]: Math.min(limit + 200, 2000) }))}>加载更早的记录</Button>}
          {view?.messages.map(message => <article className={`ls-message ls-${message.role}`} key={message.id}><span className="ls-speaker">{message.role === 'user' ? '你' : memory ? '记忆整理' : '德谬歌'}</span><div className="ls-bubble">{message.role === 'user' ? message.text : <MarkdownText text={message.text} labels={markdownLabels} />}</div></article>)}
          {view?.liveText && <article className="ls-message ls-assistant"><span className="ls-speaker">德谬歌</span><div className="ls-bubble"><MarkdownText text={view.liveText} streaming labels={markdownLabels} /></div></article>}
          {view?.running && !view.liveText && <div className="ls-thinking" role="status">{memory ? '正在整理' : '正在想一想'}···</div>}
          <div ref={scroll} />
        </div>
      </div>
      <footer className="ls-footer">
        {(error || connectionError) && <div className="ls-note" role="alert">{error || connectionError}{connectionError && <Button variant="ghost" size="sm" onClick={() => setConnectionAttempt(value => value + 1)}>重试连接</Button>}</div>}
        {!error && !connectionError && view?.notice && <p className="ls-note" role="status">{view.notice}</p>}
        {view?.readOnly ? <div className="ls-history-note">这份记录已结束，后续交流会保存在当前对话中。<Button size="sm" variant="ghost" onClick={() => choose('current')}>继续当前对话</Button></div>
          : view && !view.configured && <p className="ls-note">先在 DSH 设置中选择默认模型，再回来聊聊。</p>}
        <div hidden={view?.readOnly}><NativeComposer target={memory ? selection === 'memory' ? catalog?.memorySessionId ?? 'liveseed-memory' : selection : 'current'} view={view} send={send} stop={() => void stop()} stopping={stopping} /></div>
      </footer>
    </div>
  </section>;
}
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount({ package: 'dsh-liveseed', descriptors });
  ctx.inject(['remote.liveseed'], scoped => {
    scoped.slots.inject('main', () => scoped.slots.register({ name: 'main', key: PANEL, inject: () => ({}) }, () => <CompanionPanel ctx={scoped} />));
    scoped.slots.inject('sidebar.panellist', () => scoped.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 15, label: '德谬歌' }, SeedIcon));
  });
}
const styles = `
.ls-panel{position:relative;display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
 .ls-floating-navigation{position:absolute;top:16px;right:20px;z-index:5;display:flex;flex-direction:column;gap:10px}.ls-navigation-toggle{display:grid;place-items:center;box-sizing:border-box;padding:0;flex:none;width:40px;height:40px;border-radius:50%;corner-shape:round;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;box-shadow:0 2px 8px #0001}.ls-navigation-toggle:hover{background:var(--dsw-alias-bg-layer-2)}.ls-navigation-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
.ls-sessions{position:absolute;right:50px;top:0;width:260px;max-width:calc(100vw - 96px);max-height:calc(100dvh - 140px);box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);box-shadow:0 8px 32px #0002;overflow:auto}
.ls-thread,.ls-session{width:100%;justify-content:flex-start!important;text-align:left}.ls-thread{font-weight:500}.ls-daily{flex:1;min-height:0;overflow:auto}.ls-session{display:flex!important;justify-content:space-between!important;font-size:12px!important}.ls-session-status{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ls-new-worker{border-top:.5px solid var(--dsw-alias-border-l4);padding-top:10px;display:flex;flex-direction:column;gap:8px}.ls-new-worker input{box-sizing:border-box;min-width:0;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:8px}.ls-selected{background:var(--dsw-alias-bg-layer-2)!important}.ls-memory-entry{border-top:.5px solid var(--dsw-alias-border-l4);padding-top:10px}.ls-memory-entry p{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:2px 12px 6px}
.ls-conversation{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
.ls-story{flex:1;overflow:auto;min-height:0;padding:24px 32px;scrollbar-width:thin}.ls-empty{margin:24vh auto 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size,14px)}.ls-messages{max-width:800px;margin:auto}.ls-older{display:flex;margin:0 auto 20px}
.ls-message{display:flex;flex-direction:column;align-items:flex-start;margin-bottom:24px}.ls-user{align-items:flex-end}.ls-speaker{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-tertiary);margin-bottom:6px}.ls-bubble{overflow-wrap:anywhere;max-width:100%;line-height:calc(24px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size,14px)}.ls-user .ls-bubble{white-space:pre-wrap;max-width:88%;padding:10px 14px;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-lg)}.ls-thinking{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-tertiary);padding-bottom:20px}
.ls-footer{padding:12px 32px 20px}.ls-native-composer{max-width:800px;margin:auto;--dsh-composer-card-max-width:800px;--dsh-composer-side-clearance:0px;--dsh-composer-dock-inset:0px}.ls-note,.ls-history-note{max-width:800px;margin:0 auto 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
@media(max-width:760px){.ls-floating-navigation{top:12px;right:12px}.ls-story{padding:162px 16px 18px}.ls-footer{padding:10px 16px 16px}.ls-user .ls-bubble{max-width:95%}}
`;
