import type { Context } from '@deepseek-ai/cordis';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { z } from 'zod';
import { CompanionError, type FollowFrame, type ViewRequest } from '../../core/protocol.js';
import type { CompanionRuntime } from './runtime.js';
import { createMemoryRequest, selectMemoryRequest, descriptors, sendRequest, viewRequest } from './remote-contract.js';
import type { CharacterAssets } from './character-assets.js';

function boundary(error: unknown): never {
  if (error instanceof CompanionError) {
    const code = error.status === 404 ? 'liveseed/not-found' : error.status === 409 ? 'liveseed/conflict' : 'liveseed/unavailable';
    throw new RemoteError(code, error.message, {});
  }
  if (error instanceof z.ZodError) throw new RemoteError('liveseed/invalid', '请输入有效消息。', {});
  throw new RemoteError('liveseed/unavailable', '暂时连接不上，请稍后重试。', {});
}
/** Same Gateway, authentication, RPC envelopes and WebSocket mux as DSH's own domains. */
export class LiveSeedRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly runtime: CompanionRuntime, private readonly characters?: CharacterAssets) { super(ctx, 'liveseed'); }
  async character() { try { return this.characters ? await this.characters.catalog() : { models: [] }; } catch (error) { return boundary(error); } }
  async catalog() { try { return await this.runtime.catalog(); } catch (error) { return boundary(error); } }
  async createMemorySession(request: z.infer<typeof createMemoryRequest>) {
    try { return await this.runtime.createMemorySession(createMemoryRequest.parse(request)); } catch (error) { return boundary(error); }
  }
  async selectMemorySession(request: z.infer<typeof selectMemoryRequest>) {
    try { return await this.runtime.selectMemorySession(selectMemoryRequest.parse(request)); } catch (error) { return boundary(error); }
  }
  async snapshot(request: ViewRequest) {
    try { const parsed = viewRequest.parse(request); return await this.runtime.sessionView(parsed.sessionId, parsed.limit); } catch (error) { return boundary(error); }
  }
  async send(request: z.infer<typeof sendRequest>) {
    try {
      const parsed = sendRequest.parse(request);
      const catalog = await this.runtime.catalog();
      const entry = catalog.sessions.find(item => item.id === (parsed.sessionId === 'current' ? catalog.activeSessionId : parsed.sessionId === 'memory' ? catalog.memorySessionId : parsed.sessionId));
      if (!entry) throw new CompanionError(404, '这份会话不属于德谬歌。');
      if (entry.kind === 'chat' && !entry.active) {
        const receipt = await this.runtime.receipt(parsed);
        if (receipt) return { ...receipt, sessionId: entry.id };
        throw new CompanionError(409, '历史记录仅供回看，请在当前对话中继续。');
      }
      const result = entry.kind === 'memory' ? await this.runtime.sendMemory(parsed, entry.id) : await this.runtime.send(parsed);
      return { ...result, sessionId: entry.kind === 'memory' ? entry.id : (await this.runtime.catalog()).activeSessionId };
    } catch (error) { return boundary(error); }
  }
  async stop(request: { sessionId: string }) {
    try {
      const catalog = await this.runtime.catalog();
      const entry = catalog.sessions.find(item => item.id === (request.sessionId === 'current' ? catalog.activeSessionId : request.sessionId === 'memory' ? catalog.memorySessionId : request.sessionId));
      if (!entry) throw new CompanionError(404, '这份会话不属于德谬歌。');
      if (entry.kind === 'memory') await this.runtime.stopMemory(entry.id);
      else if (entry.active) await this.runtime.stop();
      else throw new CompanionError(409, '这份历史记录没有正在运行的回复。');
      return { stopped: true };
    } catch (error) { return boundary(error); }
  }
  async *follow(request: ViewRequest, signal: AbortSignal): AsyncIterable<FollowFrame> {
    const parsed = viewRequest.parse(request);
    let wake: (() => void) | undefined;
    let dirty = true;
    const changed = () => { dirty = true; wake?.(); };
    const release = this.runtime.subscribe(changed);
    signal.addEventListener('abort', changed);
    let first = true; let lastCatalog = ''; let lastView = ''; let lastLive = '';
    try {
      while (!signal.aborted) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        if (signal.aborted) break;
        dirty = false;
        const { catalog, view } = await this.runtime.inspectView({ sessionId: parsed.sessionId, ...(parsed.limit === undefined ? {} : { limit: parsed.limit }) });
        const revision = this.runtime.revision;
        const catalogKey = JSON.stringify(catalog);
        const viewKey = `${view.generation}:${view.sessionId}:${view.revision}:${view.readOnly}`;
        const { messages: _messages, sessionId: _id, readOnly: _readOnly, ...live } = view;
        const liveKey = JSON.stringify(live);
        if (first) yield { type: 'baseline', revision, catalog, view };
        else if (catalogKey !== lastCatalog || viewKey !== lastView || liveKey !== lastLive) yield {
          type: 'update', revision,
          ...(catalogKey === lastCatalog ? {} : { catalog }),
          ...(viewKey === lastView ? { live } : { view }),
        };
        first = false; lastCatalog = catalogKey; lastView = viewKey; lastLive = liveKey;
      }
    } catch (error) { if (!signal.aborted && !this.runtime.closed) boundary(error); }
    finally { release(); signal.removeEventListener('abort', changed); }
  }
}
export function registerRemote(ctx: Context, runtime: CompanionRuntime, characters?: CharacterAssets): void {
  new LiveSeedRemote(ctx, runtime, characters);
  ctx.typert.register({ package: 'dsh-liveseed', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: descriptors });
}
