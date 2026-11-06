import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { CompanionState } from '../core/protocol.js';

const PANEL = 'liveseed' as MainPanelId;
export const inject = ['slots'];
async function call<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/liveseed/api/${action}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'x-liveseed-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? '暂时连接不上，请稍后再试。');
  return value;
}
export function SeedIcon({ size }: Pick<SidebarPanelIconOwnerProps, 'size'>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21V12M12 15C5 15 3 10 4 5c6 0 9 3 8 10ZM12 11c0-5 3-8 8-8 1 5-2 9-8 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CompanionPanel() {
  const [mode, setMode] = useState<'main' | 'memory'>('main');
  const [state, setState] = useState<CompanionState>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const pending = useRef<{ requestId: string; text: string }>();
  const scroll = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    live.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    refresh.current = async () => {
      if (running || !active) return;
      running = true;
      try { const next = await call<CompanionState>(mode === 'memory' ? 'memory-state' : 'state'); if (active) { setState(next); setConnectionError(''); } }
      catch (failure) { if (active) setConnectionError(failure instanceof Error ? failure.message : '连接中断。'); }
      finally { running = false; }
    };
    const poll = async () => { await refresh.current(); if (active) timer = setTimeout(poll, document.hidden ? 4000 : 500); };
    void poll();
    return () => { active = false; live.current = false; clearTimeout(timer); };
  }, [mode]);
  useEffect(() => { scroll.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [state?.messages.length, state?.liveText]);
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || sending || state?.running || !state?.configured) return;
    const request = pending.current?.text === text.trim() ? pending.current : { requestId: crypto.randomUUID(), text: text.trim() };
    pending.current = request; setSending(true); setError('');
    try {
      await call(mode === 'memory' ? 'memory-send' : 'send', request);
      if (live.current) { setText(''); pending.current = undefined; await refresh.current(); }
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '消息暂未送达。'); }
    finally { if (live.current) setSending(false); }
  };
  const stop = async () => {
    setStopping(true);
    try { await call(mode === 'memory' ? 'memory-stop' : 'stop', {}); await refresh.current(); }
    catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '暂时无法停止。'); }
    finally { if (live.current) setStopping(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  return <section className="ls-panel" aria-label="德谬歌陪伴面板">
    <style>{styles}</style>
    <div className="ls-story" role="log" aria-live="polite" aria-relevant="additions text">
      {!state?.messages.length && !state?.liveText && <p className="ls-empty">想聊什么？</p>}
      <div className="ls-messages">{state?.messages.map(message => <article className={`ls-message ls-${message.role}`} key={message.id}><span className="ls-speaker">{message.role === 'user' ? '你' : mode === 'memory' ? '记忆整理' : '德谬歌'}</span><div className="ls-bubble">{message.text}</div></article>)}
        {state?.liveText && <article className="ls-message ls-assistant"><span className="ls-speaker">德谬歌</span><div className="ls-bubble">{state.liveText}<span className="ls-caret" /></div></article>}
        {state?.running && !state.liveText && <div className="ls-thinking" role="status">正在想一想<span>···</span></div>}
        <div ref={scroll} />
      </div>
    </div>
    <footer className="ls-footer">
      {(error || connectionError) && <p className="ls-error" role="alert">{error || connectionError}</p>}
      {!error && !connectionError && state?.notice && <p className="ls-note" role="status">{state.notice}</p>}
      {!error && !connectionError && state && !state.configured && <p className="ls-note">先在 DSH 设置中选择默认模型，再回来聊聊。</p>}
      <form className="ls-compose" onSubmit={event => void send(event)}><textarea aria-label={mode === 'memory' ? '给整理线的消息' : '给德谬歌的消息'} placeholder={mode === 'memory' ? '想怎样整理这些记忆？' : '想说什么，都可以。'} value={text} maxLength={6000} rows={2} onChange={event => setText(event.target.value)} onKeyDown={keyDown} disabled={!state || sending} />
        {state?.running ? <button className="ls-send" type="button" onClick={() => void stop()} disabled={stopping}>{stopping ? '停止中' : '停止'}</button> : <button className="ls-send" type="submit" disabled={!state?.configured || !text.trim() || sending}>{sending ? '发送中' : '发送'}<span aria-hidden="true">↗</span></button>}
      </form><div className="ls-footnote"><button type="button" className="ls-mode" disabled={sending || stopping} aria-pressed={mode === 'memory'} onClick={() => {
        setMode(mode === 'main' ? 'memory' : 'main'); setState(undefined); setText(''); setError(''); setConnectionError(''); pending.current = undefined;
      }}>{mode === 'memory' ? '返回对话' : '整理记忆'}</button><span>Enter 发送 · Shift + Enter 换行</span></div>
    </footer>
  </section>;
}

export function apply(ctx: Context): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({}) }, CompanionPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 15, label: '德谬歌' }, SeedIcon));
}

const styles = `
.ls-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.ls-story{flex:1;overflow:auto;min-height:0;padding:24px 32px;scrollbar-width:thin}
.ls-empty{margin:24vh auto 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:14px}
.ls-messages{max-width:800px;margin:auto}
.ls-message{display:flex;flex-direction:column;align-items:flex-start;margin-bottom:24px}
.ls-user{align-items:flex-end}
.ls-speaker{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.ls-bubble{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;line-height:1.7;font-size:14px}
.ls-user .ls-bubble{max-width:88%;padding:10px 14px;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-lg)}
.ls-thinking{font-size:12px;color:var(--dsw-alias-label-tertiary);padding-bottom:20px}
.ls-thinking span{margin-left:4px}
.ls-caret{display:inline-block;width:2px;height:14px;background:currentColor;margin-left:3px;vertical-align:middle}
.ls-footer{padding:12px 32px 16px}
.ls-compose{display:flex;align-items:flex-end;gap:12px;max-width:800px;margin:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);padding:12px}
.ls-compose:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.ls-compose textarea{flex:1;min-width:0;resize:vertical;max-height:180px;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1.7}
.ls-compose textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.ls-send{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;min-width:60px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;cursor:pointer}
.ls-send:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ls-send:disabled{opacity:.4;cursor:default}
.ls-send:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ls-footnote{display:flex;align-items:center;justify-content:space-between;max-width:800px;margin:8px auto 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ls-mode{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0}.ls-mode:hover{color:var(--dsw-alias-label-primary)}
.ls-error,.ls-note{max-width:800px;margin:0 auto 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
@media(max-width:600px){.ls-story{padding:20px 16px}.ls-footer{padding:10px 16px 16px}.ls-footnote span{display:none}.ls-user .ls-bubble{max-width:95%}}
`;
