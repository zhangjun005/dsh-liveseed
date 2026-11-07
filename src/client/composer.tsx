import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Context } from '@deepseek-ai/cordis';
import type { ComposerBarProps, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { LiveSeedInputBar, LiveSeedInputShell, type NativeShell, type Source } from 'dsh-liveseed-native-composer';
import type { SessionView } from '../core/protocol.js';

function useSource<T>(source: Source<T>) {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
const labels: Record<string, string> = { 'input.send': '发送', 'input.stop': '停止', 'input.commands': '指令', 'input.send.queue': '发送', 'input.send.steer': '发送' };
// This is the sole version-specific UI boundary. Original bar, Lexical editor,
// keymap and submit machine stay together; its sink is our private Remote API.
export function NativeComposer({ target, view, send, stop, stopping }: {
  target: string; view: SessionView | undefined;
  send(target: string, text: string): Promise<SubmitOutcome>;
  stop(): void; stopping: boolean;
}) {
  const current = useRef({ send }); current.current = { send };
  const shells = useRef(new Map<string, { shell: NativeShell; scope: Context }>());
  let owned = shells.current.get(target);
  if (!owned) {
    const scope = new Context();
    const shell: NativeShell = new LiveSeedInputShell({ actx: scope,
      defaultSink: text => {
        // A new attempt supersedes the previous notice, including after view remounts.
        shell.notices.set(null);
        return current.current.send(target, text);
      },
      commandAttachments: { serialize: async () => [], release() {}, unsupportedNotice: () => '此处仅支持文字消息。' },
    });
    owned = { shell, scope }; shells.current.set(target, owned);
  }
  const shell = owned.shell;
  useEffect(() => () => { for (const item of shells.current.values()) { item.shell.dispose(); void item.scope.fiber.dispose(); } shells.current.clear(); }, []);
  // Hooks are supplied explicitly instead of acquiring ordinary Session bindings.
  const props = {
    variant: 'composer', sessionId: view?.sessionId ?? target,
    disabled: !view?.configured || view.readOnly,
    ...(view?.running ? { blocked: { reason: '正在回复' } } : {}),
    keyboard: shell, inputActions: shell.actions,
    useInput: (select: (value: NativeShell['snapshot']) => unknown) => select(useSource(shell.state)),
    useNotices: (select: (value: unknown) => unknown) => select(useSource(shell.notices)),
    useLexicon: (select: (value: unknown) => unknown) => select(useSource(shell.lexicon)),
    useSession: (select: (value: unknown) => unknown) => select({ running: view?.running ?? false, promptError: null, subagent: null, removed: false }),
    useProjection: (_key: string, select?: (value: undefined) => unknown) => select ? select(undefined) : undefined,
    useBusyEnter: (select: (value: string) => unknown) => select('queue'),
    useFileUploads: (select: (value: object) => unknown) => select({}),
    useMenuLauncher: (select: (value: null) => unknown) => select(null),
    useStopShortcut: (select: (value: readonly string[]) => unknown) => select([]),
    stop: stopping ? undefined : stop,
    placeholder: target === 'current' ? '给德谬歌的消息' : '给整理线的消息',
    t: (key: string) => labels[key] ?? key,
    // Permission, workspace commands and ordinary Agent controls are not mounted.
    renderSlot: () => null,
  } as unknown as ComposerBarProps;
  return <div className="ls-native-composer"><LiveSeedInputBar key={target} {...props} /></div>;
}
