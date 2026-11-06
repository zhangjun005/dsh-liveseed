import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import Sessions, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Llm, { createUserMessage, joinAssistantStreamText, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import Agents, { installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Checkpoints from '@deepseek-ai/dsh-session-checkpoint-policy';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Compaction from '@deepseek-ai/dsh-compaction-basic';
import { z } from 'zod';
import { emptyMemory, foldMemory, hiddenReferences, recall, recentUnderstanding } from '../../core/memory/store.js';
import { proposalSchema, recordSchema, type Evidence, type MemoryJob, type MemoryRecord, type MemoryState } from '../../core/memory/schema.js';
import { CompanionError, type CompanionState, type SendRequest } from '../../core/protocol.js';
import { HostModelBridge } from './model-bridge.js';
import { bindOverflow, compactPressure } from './compaction.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'liveseed-memory-record': { kind: 'liveseed-memory-record'; record: MemoryRecord };
    'liveseed-memory-task': { kind: 'liveseed-memory-task'; jobId: string };
    'liveseed-memory-surface': { kind: 'liveseed-memory-surface' };
    'liveseed-handoff': { kind: 'liveseed-handoff' };
  }
}
export interface MemoryConfig {
  stateDir: string; memoryProvider?: string | undefined; memoryModel?: string | undefined;
  memoryIdleMs?: number | undefined; memoryBatchSize?: number | undefined; memoryMaxTokens?: number | undefined;
  memoryReflectionEvery?: number | undefined;
  replyTimeoutMs: number;
}
export const MAIN_TOOLS = new Set(['memory_recall', 'memory_intent', 'memory_reflect']);
const WORKER_TOOLS = new Set(['memory_lookup']);
const WORKER = SessionId('liveseed-memory');
const WORKER_PROMPT = `你是德谬歌的独立记忆整理线，与主线隔离。处理真实来源的经历、原生 reasoning 与显式内省，区分事实、理解和事后推测。
你可以维护已授权记忆域、独立决定保留/合并/更正/降权/归档，更新 narrative；不要假造经历，不把重注入、摘要或管理记录当新经历。保护和明确用户要求不能静默绕过。不调用外部工具，不自动改写 soul。
incremental 以核对近期事实、偏好和未完事项为主；reflection 回看长期理解、关系与保留/放下；dialogue 处理用户维护请求。没有新依据可以保持原状，不要求每个任务都改叙事。
使用 memory_lookup 按需查已提交记忆。最终只输出一个 JSON 对象，不使用 Markdown 围栏：
{"baseVersion":当前版本,"mutations":[{"op":"remember","id":"本域唯一短ID","text":"记忆摘要","evidence":["实际来源ref"]}],"reply":"仅在用户维护对话时答复"}
mutations 可为空。其他操作：{"op":"revise","id":"已有ID","text":"更正摘要","evidence":["来源ref"]}；{"op":"state","id":"已有ID","state":"active|quiet|archived|denied","reason":"依据"}；{"op":"protect","id":"已有ID","value":true,"reason":"依据"}。
可选 narrative / chapter 均为 {"text":"有限的自然语言叙事","evidence":["来源ref"]}。narrative 是跨日自我/关系理解，chapter 是当下未完话题和处境；有变化才提交完整当前版本，不追加所有旧版本。不得用模型推测代替用户事实。放下/纠正相关经历时同步更正叙事。soulCandidate 仅记录变更候选、不执行。维护对话的执行结果以提交成功为准。`;

/** Public async persistence handle; never use deprecated synchronous Session log reads. */
export async function readEvents(ctx: Context, session: Session): Promise<readonly SessionEvent[]> {
  await ctx.sessions.flush(session);
  const handle = await ctx.sessionPersistence.open(session.id, 'read');
  try { return (await handle.read()).events; } finally { await handle.close(); }
}
export function dialogueEvidence(sessionId: string, events: readonly SessionEvent[]): Evidence[] {
  const result: Evidence[] = [];
  let parent: string | undefined;
  for (const event of events) {
    let text = ''; let reasoning = ''; let role: 'user' | 'assistant'; let partial = false;
    if (event.type === 'user/message' && event.data.source.kind === 'liveseed-user') {
      role = 'user'; text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      parent = `${sessionId}:${event.seq}`;
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
      text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      for (const block of event.data.message.content) {
        const raw = block as unknown as Record<string, unknown>;
        if (raw['type'] === 'reasoning' && typeof raw['text'] === 'string') reasoning += raw['text'];
      }
    } else if (event.type === 'assistant/attempt') {
      role = 'assistant'; text = joinAssistantStreamText(event.data.stream); partial = true;
      reasoning = event.data.stream.filter(record => record.type === 'reasoning-chunks').map(record => record.texts.join('')).join('');
      // Exact provider stream remains in the native event even when it has no textual rendering.
    } else continue;
    if (!text && !reasoning) continue;
    result.push({ ref: `${sessionId}:${event.seq}`, sessionId, seq: event.seq, at: event.time, role, text,
      ...(reasoning ? { reasoning } : {}), ...(partial ? { partial } : {}), ...(role === 'assistant' && parent ? { parents: [parent] } : {}) });
  }
  return result;
}
export const productDay = (time = Date.now()): string => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);

/** One long-lived worker Session; code-only commits use a separate native audit log with no Agent. */
export class MemoryRuntime {
  private readonly ctx = new Context();
  private handle: AgentHandle | undefined;
  private journal: Awaited<ReturnType<Context['sessionPersistence']['open']>> | undefined;
  private journalSeq = 0;
  private state: MemoryState = emptyMemory();
  private mutation: Promise<unknown> = Promise.resolve();
  private driving: Promise<void> | undefined;
  private closing = false;
  private failed = false;
  private lastError: string | null = null;
  private cancelTimer: (() => void) | undefined;
  private registration: AdapterRegistrationHandle | undefined;
  private releaseAdapters: (() => unknown) | undefined;
  private selection: ModelSelection | undefined;
  private readonly modelSelection: ModelSelectionRef = { current: undefined, assembled: undefined };
  private activeJob: MemoryJob | undefined;
  private cancelling = new Set<string>();
  private workerScrubbedRevision = -1;
  private lookupRefs = new Set<string>();
  private lookupCalls = 0;
  private liveText = '';
  private soul = '';
  private closeTask: Promise<void> | undefined;
  private delivery: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly host: Context, private readonly config: MemoryConfig) { this.ready = this.start(); }
  private selected(): ModelSelection | undefined {
    if (this.config.memoryProvider && this.config.memoryModel) return { provider: this.config.memoryProvider, model: this.config.memoryModel };
    const selected = this.host.agentDefaultModel.currentSelection();
    return selected.provider && selected.model ? selected : undefined;
  }
  private async start(): Promise<void> {
    const ctx = this.ctx;
    ctx.logger.exporter({ export: message => { if (message.type === 'error') this.host.logger.warn('LiveSeed memory runtime reported an error.'); } });
    await ctx.plugin(Timer); await ctx.plugin(Sessions); await ctx.plugin(Projections);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: WORKER_PROMPT });
    await ctx.plugin(Llm); await ctx.plugin(Tools); await ctx.plugin(Agents); await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(Jsonl, { root: join(this.config.stateDir, 'memory-sessions'), compression: 'none' }); await ctx.plugin(Checkpoints);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(Compaction, { auto: false, headroomTokens: 1024, maxTokens: 512, thresholdRatio: 0.8, retainRatio: 0.16, maxOverflowRetries: 1 });
    const bridge = new HostModelBridge(this.host.llm, () => this.selection, this.config.memoryMaxTokens ?? 4096, WORKER_TOOLS);
    const sync = (): void => {
      if (this.closing) return;
      const providers = this.host.llm.listProviders().map(provider => provider.id);
      if (this.registration) this.registration.replace(providers);
      else if (providers.length) this.registration = ctx.llm.registerAdapter(providers, bridge);
    };
    sync(); this.releaseAdapters = this.host.on('llm/adapters-updated', sync);
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'start') this.liveText = '';
      else if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') this.liveText += frame.chunk.text;
    });
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, this.modelSelection);
      agentCtx.tools.guard(exec => WORKER_TOOLS.has(exec.name) && exec.agent?.session.id === WORKER ? undefined : 'Memory grants only scoped lookup.');
      bindOverflow(agentCtx, ctx);
      agentCtx.on('agent/pre-step', async ({ step, agent, signal }, next) => {
        if (step > 6 || !this.activeJob || this.closing) return { kind: 'reject' };
        await compactPressure(ctx, agent, signal); return next();
      });
      agentCtx.systemPrompt.section({ name: 'liveseed-soul-reference', order: 10, text: () => this.soul, interpolate: false });
      agentCtx.systemPrompt.variable('liveseed_memory_task', () => this.workerContext());
      agentCtx.systemPrompt.context({ name: 'liveseed-memory-task-state', order: 10, text: '{{liveseed_memory_task}}' });
      agentCtx.tools.register(defineTool({ name: 'memory_lookup', description: '在已授权记忆域内查历史记忆和原文。返回真实来源，不执行外部操作。',
        parameters: { query: { type: 'string', required: true }, ids: { type: 'array', items: { type: 'string' } }, ref: { type: 'string' }, offset: { type: 'integer' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async args => {
          if (++this.lookupCalls > 12) throw new Error('Maintenance lookup budget reached.');
          const parsed = z.object({ query: z.string().max(6000), ids: z.array(z.string()).max(16).optional(), ref: z.string().optional(), offset: z.number().int().min(0).max(300000).optional() }).strict().parse(args);
          if (parsed.ref) {
            if (hiddenReferences(this.state, true).has(parsed.ref)) throw new Error('Evidence is denied.');
            const entry = this.state.evidence.get(parsed.ref);
            if (!entry) throw new Error('Unknown evidence.');
            this.lookupRefs.add(entry.ref);
            const offset = parsed.offset ?? 0;
            return JSON.stringify({ ...entry, text: entry.text.slice(offset, offset + 4000), reasoning: entry.reasoning?.slice(offset, offset + 4000), offset });
          }
          const hits = recall(this.state, parsed.query, { maintenance: true, ...(parsed.ids ? { ids: parsed.ids } : {}) });
          for (const hit of hits) for (const entry of hit.evidence) this.lookupRefs.add(entry.ref);
          const denied = hiddenReferences(this.state, true);
          const terms = parsed.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 8);
          const raw = terms.length ? [...this.state.evidence.values()].filter(entry => !denied.has(entry.ref) && terms.some(term => entry.text.toLocaleLowerCase().includes(term)))
            .slice(-4).map(({ ref, role, at, text }) => ({ ref, role, at, text: text.slice(0, 1500) })) : [];
          for (const entry of raw) this.lookupRefs.add(entry.ref);
          return JSON.stringify({ memories: hits, raw });
        } }));
    };
    const journalId = SessionId('liveseed-memory-journal');
    this.journal = await ctx.sessionPersistence.stat(journalId)
      ? await ctx.sessionPersistence.open(journalId, 'write')
      : await ctx.sessionPersistence.create(Session.create(journalId).header);
    const recorded = await this.journal.read();
    this.journalSeq = recorded.events.length;
    for (const event of recorded.events) {
      if (event.type === 'user/message' && event.data.source.kind === 'liveseed-memory-record') this.state = foldMemory(this.state, recordSchema.parse(event.data.source.record));
    }
    this.handle = await ctx.sessionPersistence.stat(WORKER)
      ? await ctx.agents.resume({ resumeSessionId: WORKER, setup })
      : await ctx.agents.create({ sessionId: WORKER, setup });
    await this.handle.agent.whenIdle();
    this.handle.agent.inbox.clear();
    await ctx.sessions.flush(this.handle.agent.session);
    this.soul = this.state.soulVersions.at(-1)?.text ?? '';
    try {
      const supplied = await readFile(join(this.config.stateDir, 'soul.md'), 'utf8');
      if (supplied !== this.soul) { await this.persist({ type: 'soul', text: supplied, at: Date.now(), source: 'stateDir/soul.md' }); this.soul = supplied; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.renderNarrative();
    this.arm();
  }
  snapshot(): MemoryState { return structuredClone(this.state); }
  private persist(record: MemoryRecord): Promise<void> {
    const task = this.mutation.then(async () => {
      if (this.failed || this.closing || !this.handle) throw new Error('Memory persistence is unavailable.');
      const next = foldMemory(this.state, record);
      if (next === this.state) return;
      const event: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(this.journalSeq), time: Date.now(), surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: '（内部维护记录；不是新的角色经历。）' }], source: { kind: 'liveseed-memory-record', record } }) };
      try { await this.journal!.append([event]); await this.journal!.flush(); }
      catch (error) { this.failed = true; throw error; }
      this.journalSeq++; this.state = next;
    });
    this.mutation = task.catch(() => {}); return task;
  }
  async segment(sessionId: string, day: string, handoff?: { ref: string; role: 'user' | 'assistant'; text: string }[]): Promise<void> {
    await this.ready;
    if (!this.state.segments.some(segment => segment.sessionId === sessionId)) await this.persist({ type: 'segment', sessionId, day, ...(handoff ? { handoff } : {}) });
  }
  async ingest(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    await this.ready;
    const items = dialogueEvidence(sessionId, events).filter(item => !this.state.evidence.has(item.ref));
    for (let index = 0; index < items.length; index += 64) await this.persist({ type: 'evidence', items: items.slice(index, index + 64) });
    this.arm();
  }
  private arm(delay?: number): void {
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (this.closing || this.failed) return;
    this.cancelTimer = this.ctx.timeout(() => { this.cancelTimer = undefined; void this.drain().catch(() => { this.lastError = '记忆整理暂未完成，原始记录仍保留。'; }); }, delay ?? this.config.memoryIdleMs ?? 60000);
    const pending = [...this.state.evidence.keys()].filter(ref => !this.state.processed.has(ref));
    if (delay === undefined && (pending.length >= (this.config.memoryBatchSize ?? 8) || [...this.state.jobs.keys()].some(id => !this.state.accepted.has(id) && !this.state.cancelled.has(id)) || [...this.state.intents.keys()].some(id => !this.state.handledIntents.has(id)))) {
      this.cancelTimer?.(); this.cancelTimer = undefined;
      queueMicrotask(() => { void this.drain().catch(() => { this.lastError = '记忆整理暂未完成，原始记录仍保留。'; }); });
    }
  }
  private workerContext(): string {
    if (!this.activeJob) return '';
    const denied = hiddenReferences(this.state, true);
    const entries = this.activeJob.refs.filter(ref => !denied.has(ref)).map(ref => this.state.evidence.get(ref)!)
      .map(entry => ({ ...entry, text: entry.text.slice(0, 3000), ...(entry.reasoning ? { reasoning: entry.reasoning.slice(0, 3000) } : {}), excerpt: entry.text.length > 3000 || (entry.reasoning?.length ?? 0) > 3000 }));
    return JSON.stringify({ baseVersion: this.state.version, job: this.activeJob, evidence: entries, narrative: this.state.narrative, chapter: this.state.chapter,
      intents: [...this.state.intents.values()].filter(intent => intent.expiresAt > Date.now() && !intent.evidence.some(ref => denied.has(ref))).slice(-24),
      memoryCatalog: [...this.state.items.values()].filter(item => item.state !== 'denied' && !item.evidence.some(ref => denied.has(ref))).slice(-48).map(({ id, text, state, protected: protectedValue }) => ({ id, text: text.slice(0, 240), state, protected: protectedValue })) });
  }
  async drain(): Promise<void> {
    await this.ready;
    if (this.driving) return this.driving;
    if (this.closing || this.failed || !this.selected()) return;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    let success = false;
    this.driving = this.process().then(() => { success = true; }).finally(() => {
      this.driving = undefined;
      if (!this.closing) this.arm(success ? undefined : 60000);
    });
    return this.driving;
  }
  private async process(): Promise<void> {
    let job = [...this.state.jobs.values()].filter(candidate => !this.state.accepted.has(candidate.id) && !this.state.cancelled.has(candidate.id)).sort((a, b) => Number(b.kind === 'dialogue') - Number(a.kind === 'dialogue'))[0];
    if (!job) {
      const refs: string[] = []; let length = 0;
      const intentIds: string[] = [];
      for (const intent of this.state.intents.values()) {
        if (this.state.handledIntents.has(intent.id) || intentIds.length >= 32) continue;
        const extra = intent.evidence.filter(ref => !refs.includes(ref));
        if (refs.length + extra.length > 48) continue;
        intentIds.push(intent.id);
        for (const ref of extra) { refs.push(ref); const item = this.state.evidence.get(ref)!; length += item.text.length + (item.reasoning?.length ?? 0); }
      }
      for (const item of this.state.evidence.values()) {
        if (this.state.processed.has(item.ref) || refs.includes(item.ref)) continue;
        const cost = item.text.length + (item.reasoning?.length ?? 0);
        if (refs.length && (refs.length >= 48 || length + cost > 24000)) break;
        refs.push(item.ref); length += cost;
      }
      if (!refs.length && !intentIds.length) return;
      const every = this.config.memoryReflectionEvery ?? 4;
      job = { id: randomUUID(), refs, intentIds, kind: intentIds.length || this.state.version % every === every - 1 ? 'reflection' : 'incremental', input: '', at: Date.now() };
      await this.persist({ type: 'job', job });
    }
    const handle = this.handle!;
    this.selection = this.selected(); this.modelSelection.current = this.selection;
    this.activeJob = job; this.lookupRefs = new Set(job.refs); this.lookupCalls = 0; this.liveText = '';
    if (this.state.contextRevision > 0 && this.workerScrubbedRevision !== this.state.contextRevision) {
      const session = handle.agent.session;
      const events = await readEvents(this.ctx, session);
      const nodes = [...session.surface.nodes];
      const systems = new Set(events.filter(event => event.type === 'system/message').map(event => event.seq));
      const tail = nodes.slice(nodes.map(seq => systems.has(seq)).lastIndexOf(true) + 1);
      if (tail.length) {
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '旧工作上下文已撤下；以当前已接受版本、任务和允许查询的来源继续整理。' }], source: { kind: 'liveseed-memory-surface' } }),
          { surfaceOp: { op: 'replace', startSeq: tail[0]!, endSeq: tail.at(-1)! }, sourceEventSeqs: tail });
        await this.ctx.sessions.flush(session);
      }
      this.workerScrubbedRevision = this.state.contextRevision;
    }
    const before = handle.agent.session.seq;
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ kind: job.kind, input: job.input, jobId: job.id }) }], source: { kind: 'liveseed-memory-task', jobId: job.id } }));
    const cancel = this.ctx.timeout(() => handle.agent.cancel({ kind: 'hook', reason: 'Memory deadline exceeded.' }), this.config.replyTimeoutMs);
    try {
      await handle.agent.whenIdle();
      const events = await readEvents(this.ctx, handle.agent.session);
      const ending = [...events].reverse().find(event => event.seq >= before && event.type === 'turn/end');
      if (!ending || ending.type !== 'turn/end' || ending.data.reason.kind !== 'completed') throw new Error('Memory turn did not complete.');
      const message = [...events].reverse().find(event => event.seq >= before && event.type === 'assistant/message');
      if (!message || message.type !== 'assistant/message') throw new Error('Memory reply missing.');
      const text = message.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      const proposal = proposalSchema.parse(JSON.parse(text));
      const allowed = new Set([...this.lookupRefs, ...this.state.narrative.evidence, ...this.state.chapter.evidence]);
      for (const item of this.state.items.values()) for (const ref of item.evidence) allowed.add(ref);
      for (const mutation of proposal.mutations) if ('evidence' in mutation && mutation.evidence.some(ref => !allowed.has(ref))) throw new Error('Proposal references unseen evidence.');
      for (const key of ['narrative', 'chapter'] as const) if (proposal[key]?.evidence.some(ref => !allowed.has(ref))) throw new Error('Passage references unseen evidence.');
      if (this.cancelling.has(job.id)) throw new Error('Memory job was cancelled.');
      await this.persist({ type: 'accepted', id: job.id, at: Date.now(), proposal });
      await this.renderNarrative(); this.lastError = null;
    } finally { cancel(); this.activeJob = undefined; this.liveText = ''; }
  }
  private async renderNarrative(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true });
    const target = join(this.config.stateDir, 'narrative.md');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, this.state.narrative.text, 'utf8'); await rename(temporary, target);
  }
  mainContext(query: string): { soul: string; narrative: string; chapter: string; recalled: string } {
    return { soul: this.soul, narrative: this.state.narrative.text,
      chapter: JSON.stringify({ current: this.state.chapter, understanding: recentUnderstanding(this.state), time: new Date().toISOString() }),
      recalled: JSON.stringify(recall(this.state, query)) };
  }
  bindMain(agentCtx: Context, session: () => Session, readCtx: Context): void {
    bindOverflow(agentCtx, readCtx);
    let budget = 0;
    let observed = new Set<string>();
    let current: Evidence | undefined;
    let inputText = '';
    let scrubbedVersion = -1;
    let assembledVersion = -1;
    const refresh = async (): Promise<void> => {
      const events = await readEvents(readCtx, session());
      await this.ingest(String(session().id), events);
      const hidden = hiddenReferences(this.state);
      const nodes = [...session().surface.nodes];
      const eventMap = new Map(events.map(event => [Number(event.seq), event]));
      const withdrawn = this.state.contextRevision > 0 && scrubbedVersion !== this.state.contextRevision;
      if (withdrawn) {
        const head = nodes.map(seq => eventMap.get(seq)?.type === 'system/message').lastIndexOf(true);
        const tail = nodes.slice(head + 1);
        if (tail.length) {
          const entries = withdrawn ? [] : dialogueEvidence(String(session().id), events).filter(entry => !hidden.has(entry.ref)).slice(-8);
          const context = JSON.stringify({ kind: 'context-handoff', chapter: this.state.chapter,
            recent: entries.map(({ ref, role, text }) => ({ ref, role, text: text.slice(0, 1600) })) });
          session().append('user/message', createUserMessage({ content: [{ type: 'text', text: context }], source: { kind: 'liveseed-handoff' } }),
            { surfaceOp: { op: 'replace', startSeq: tail[0]!, endSeq: tail.at(-1)! }, sourceEventSeqs: tail });
          await readCtx.sessions.flush(session());
        }
        scrubbedVersion = this.state.contextRevision;
      }
      current = [...dialogueEvidence(String(session().id), events)].reverse().find(item => item.role === 'user');
      for (const entry of dialogueEvidence(String(session().id), events).slice(-8)) if (!hidden.has(entry.ref)) observed.add(entry.ref);
      const hits = recall(this.state, inputText);
      for (const hit of hits) for (const entry of hit.evidence) observed.add(entry.ref);
    };
    agentCtx.on('agent/pre-step', async ({ step, messages, agent, signal }, next) => {
      if (step === 1) {
        observed = new Set(); budget = 0;
        const incoming = messages.filter(message => message.source.kind === 'liveseed-user').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
        if (incoming) inputText = incoming;
      }
      if (step === 1 || assembledVersion !== this.state.version) {
        await refresh();
        assembledVersion = this.state.version;
      }
      await compactPressure(readCtx, agent, signal);
      return step > 6 ? { kind: 'reject' } : next();
    });
    const query = (): string => inputText;
    agentCtx.systemPrompt.section({ name: 'liveseed-soul', order: 10, text: () => this.soul, interpolate: false });
    for (const [name, order, field] of [['l1', 10, 'narrative'], ['l2', 20, 'chapter'], ['l3', 30, 'recalled']] as const) {
      agentCtx.systemPrompt.variable(`liveseed_${name}`, () => {
        const value = this.mainContext(query())[field];
        if (name !== 'l2') return value;
        const hidden = hiddenReferences(this.state);
        const handoff = this.state.segments.find(segment => segment.sessionId === session().id)?.handoff?.filter(entry => !hidden.has(entry.ref)) ?? [];
        return JSON.stringify({ current: value, handoff });
      });
      agentCtx.systemPrompt.context({ name: `liveseed-${name.toUpperCase()}`, order, text: `{{liveseed_${name}}}` });
    }
    agentCtx.tools.guard(exec => MAIN_TOOLS.has(exec.name) && exec.agent?.session.id === session().id ? undefined : 'Main grants only scoped memory tools.');
    agentCtx.tools.register(defineTool({ name: 'memory_recall', description: '主动回想已授权记忆，按主题补查或展开已有记忆的原话。只读，不修改记忆。',
      parameters: { query: { type: 'string', required: true }, ids: { type: 'array', items: { type: 'string' } }, ref: { type: 'string' }, offset: { type: 'integer' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async args => {
        if (++budget > 4) throw new Error('Recall budget reached.');
        const parsed = z.object({ query: z.string().max(3000), ids: z.array(z.string()).max(8).optional(), ref: z.string().optional(), offset: z.number().int().min(0).max(100000).optional() }).strict().parse(args);
        if (parsed.ref) {
          if (!observed.has(parsed.ref) || hiddenReferences(this.state).has(parsed.ref)) throw new Error('Evidence is outside the visible scope.');
          const entry = this.state.evidence.get(parsed.ref)!;
          const offset = parsed.offset ?? 0;
          return JSON.stringify({ ref: entry.ref, role: entry.role, at: entry.at, text: entry.text.slice(offset, offset + 3000), offset });
        }
        const hits = recall(this.state, parsed.query, { ...(parsed.ids ? { ids: parsed.ids } : {}) });
        for (const hit of hits) for (const entry of hit.evidence) observed.add(entry.ref);
        return JSON.stringify(hits);
      } }));
    const intent = async (kind: 'important' | 'protect' | 'understanding', text: string, requested?: string[], id?: string): Promise<string> => {
      if (++budget > 8) throw new Error('Intent budget reached.');
      const events = await readEvents(readCtx, session());
      await this.ingest(String(session().id), events);
      current = [...dialogueEvidence(String(session().id), events)].reverse().find(item => item.role === 'user');
      if (!current) throw new Error('Current source is unavailable.');
      observed.add(current.ref);
      const refs = requested?.length ? requested : [current.ref];
      if (refs.some(ref => !observed.has(ref))) throw new Error('Intent evidence is not visible to this turn.');
      const intentId = `${session().id}:${id ?? randomUUID()}`;
      const prior = this.state.intents.get(intentId);
      if (prior) {
        if (prior.kind !== kind || prior.text !== text || JSON.stringify(prior.evidence) !== JSON.stringify(refs)) throw new Error('Intent ID conflicts with its accepted content.');
        return '已记录；长期整理结果尚待整理线处理。';
      }
      if (kind === 'protect' && [...this.state.intents.values()].some(existing => existing.kind === 'protect' && existing.evidence.some(ref => refs.includes(ref)))) throw new Error('Main cannot renew temporary protection for the same evidence.');
      await this.persist({ type: 'intent', intent: { id: intentId, kind, evidence: refs, text, at: Date.now(), expiresAt: Date.now() + (kind === 'protect' ? 24 : 48) * 3600000 } });
      this.arm(); return '已记录；长期整理结果尚待整理线处理。';
    };
    agentCtx.tools.register(defineTool({ name: 'memory_intent', description: '标记可见经历重要，或临时保护 24 小时。长期取舍由整理线处理，不写 narrative。',
      parameters: { kind: { type: 'string', enum: ['important', 'protect'], required: true }, text: { type: 'string', required: true }, refs: { type: 'array', items: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async (args, exec) => { const parsed = z.object({ kind: z.enum(['important', 'protect']), text: z.string().min(1).max(1800), refs: z.array(z.string()).max(8).optional() }).strict().parse(args); return intent(parsed.kind, parsed.text, parsed.refs, exec.callId); } }));
    agentCtx.tools.register(defineTool({ name: 'memory_reflect', description: '记录此刻形成的简短自我理解或未定看法，供后续当日 context 和长期整理使用，不直接改写 narrative。',
      parameters: { text: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async (args, exec) => { const parsed = z.object({ text: z.string().min(1).max(1800) }).strict().parse(args); return intent('understanding', parsed.text, undefined, exec.callId); } }));
  }
  send(request: SendRequest): Promise<{ messageId: string }> {
    const task = this.delivery.then(() => this.enqueueDialogue(request));
    this.delivery = task.catch(() => {}); return task;
  }
  private async enqueueDialogue(request: SendRequest): Promise<{ messageId: string }> {
    await this.ready;
    if (this.failed || this.closing) throw new CompanionError(503, '记忆整理暂时不可用。');
    const existing = [...this.state.jobs.values()].find(job => job.requestId === request.requestId);
    if (existing) {
      if (existing.input !== request.text) throw new CompanionError(409, '发送记录与内容不一致。');
      if (!this.state.accepted.has(existing.id) && !this.state.cancelled.has(existing.id)) void this.drain().catch(() => { this.lastError = '这次整理尚未完成，请稍后重试。'; });
      return { messageId: existing.id };
    }
    if (!this.selected()) throw new CompanionError(409, '请先配置整理模型。');
    const refs = [...this.state.evidence.keys()].slice(-32);
    const job: MemoryJob = { id: randomUUID(), kind: 'dialogue', refs, input: request.text, requestId: request.requestId, at: Date.now() };
    await this.persist({ type: 'job', job });
    void this.drain().catch(() => { this.lastError = '这次整理尚未完成，请稍后重试。'; });
    return { messageId: job.id };
  }
  async panel(): Promise<CompanionState> {
    await this.ready;
    const messages = [...this.state.jobs.values()].filter(job => job.kind === 'dialogue').flatMap(job => {
      const reply = job.requestId ? this.state.replies.get(job.requestId) : undefined;
      return [{ id: job.id, role: 'user' as const, text: job.input, at: job.at }, ...(reply ? [{ id: `${job.id}-reply`, role: 'assistant' as const, text: reply.reply, at: reply.at }] : [])];
    });
    return { generation: 'memory', revision: this.state.version, configured: Boolean(this.selected()), running: Boolean(this.driving), messages: messages.slice(-200), liveText: '', notice: this.lastError };
  }
  async stop(): Promise<void> {
    const active = this.activeJob;
    if (active) this.cancelling.add(active.id);
    this.handle?.agent.cancel({ kind: 'user' }); await this.driving?.catch(() => {});
    if (active && !this.state.accepted.has(active.id)) { await this.persist({ type: 'cancelled', id: active.id, at: Date.now() }); this.lastError = '本次整理已停止。'; }
  }
  close(): Promise<void> {
    return this.closeTask ??= (async () => { this.closing = true; this.cancelTimer?.(); await this.ready.catch(() => {}); this.cancelTimer?.();
      await this.releaseAdapters?.(); this.handle?.agent.cancel({ kind: 'disposed' }); await this.driving?.catch(() => {});
      await this.mutation.catch(() => {}); await this.handle?.dispose(); await this.journal?.close(); await this.ctx.fiber.dispose(); })();
  }
}
