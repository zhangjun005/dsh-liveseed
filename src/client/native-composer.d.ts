declare module 'dsh-liveseed-native-composer' {
  import type { ComponentType } from 'react';
  import type { Context } from '@deepseek-ai/cordis';
  import type { ComposerBarProps, InputState, SessionInput, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-conversation/client';
  export interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
  export type NativeShell = SessionInput & NonNullable<ComposerBarProps['keyboard']> & {
    state: Source<InputState>;
    notices: Source<{ level: string; text: string } | null> & { set(value: null): void };
    lexicon: Source<ReadonlyMap<'/' | '@', readonly string[]>>;
    dispose(): void;
  };
  export const LiveSeedInputBar: ComponentType<ComposerBarProps>;
  export const LiveSeedInputShell: new (deps: {
    actx: Context;
    defaultSink(text: string, ids: readonly unknown[], mode: unknown, signal: AbortSignal): Promise<SubmitOutcome>;
    commandAttachments: { serialize(): Promise<never[]>; release(): void; unsupportedNotice(): string };
  }) => NativeShell;
}
