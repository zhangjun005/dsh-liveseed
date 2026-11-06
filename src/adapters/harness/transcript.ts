import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session-projection';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'liveseed-user': { kind: 'liveseed-user'; requestId: string };
  }
}

const messageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), at: z.number() });
const transcriptSchema = z.object({
  messages: z.array(messageSchema), requests: z.record(z.string(), z.object({ messageId: z.string(), digest: z.string() })),
  revision: z.number(), notice: z.string().nullable(),
});
export type Transcript = z.infer<typeof transcriptSchema>;
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { liveseedTranscript: Transcript }
}
const textOf = (content: UserMessage['content']): string => content.filter(block => block.type === 'text').map(block => block.text).join('\n');
export const messageDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Rebuildable UI state only. All authoritative entries remain native Session events. */
function fold(state: Transcript, event: SessionEvent): Transcript {
  if (event.type === 'agent/inbox/spliced') {
    // Receipts must survive retries even before a queued message becomes user/message.
    const requests = { ...state.requests };
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const item = value as Record<string, unknown>;
      const source = item['source'] as Record<string, unknown> | undefined;
      if (source?.['kind'] === 'liveseed-user' && typeof source['requestId'] === 'string' && typeof item['id'] === 'string' && Array.isArray(item['content'])) {
        requests[source['requestId']] = { messageId: item['id'], digest: messageDigest(textOf(item['content'] as UserMessage['content'])) };
      }
      for (const child of Object.values(item)) if (child && typeof child === 'object') walk(child);
    };
    walk(event.data);
    return { ...state, requests, revision: event.seq };
  }
  if (event.type === 'user/message' && event.data.source.kind === 'liveseed-user') {
    const message = { id: event.data.id, role: 'user' as const, text: textOf(event.data.content), at: event.time };
    return { ...state, messages: [...state.messages, message].slice(-200), requests: { ...state.requests, [event.data.source.requestId]: { messageId: message.id, digest: messageDigest(message.text) } }, revision: event.seq, notice: null };
  }
  if (event.type === 'assistant/message') {
    const message = event.data.message;
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!text) return state;
    return { ...state, messages: [...state.messages, { id: message.id, role: 'assistant' as const, text, at: event.time }].slice(-200), revision: event.seq };
  }
  if (event.type === 'assistant/attempt') {
    const text = joinAssistantStreamText(event.data.stream);
    if (!text) return state;
    return { ...state, messages: [...state.messages, { id: `attempt-${event.seq}`, role: 'assistant' as const, text, at: event.time }].slice(-200), revision: event.seq };
  }
  if (event.type === 'turn/end') {
    const notice = event.data.reason.kind === 'error' ? '这次没能完成回复，请稍后再试。'
      : event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted' ? '这次回复已停止。'
      : event.data.reason.kind === 'blocked' ? '这次回复暂时停在这里。' : null;
    return { ...state, notice, revision: event.seq };
  }
  return state;
}

export function registerTranscript(ctx: Context): void {
  ctx.sessionProjections.register({ key: 'liveseedTranscript', stateVersion: 2, stateSchema: transcriptSchema,
    init: () => ({ messages: [], requests: {}, revision: -1, notice: null }), apply: fold });
}
export function transcriptOf(ctx: Context, session: Session): Transcript {
  const state = ctx.sessionProjections.stateOf(session, 'liveseedTranscript');
  if (!state) throw new Error('LiveSeed transcript projection is unavailable.');
  return state;
}
export function transcriptFromEvents(events: readonly SessionEvent[]): Transcript {
  return events.reduce(fold, { messages: [], requests: {}, revision: -1, notice: null } as Transcript);
}
