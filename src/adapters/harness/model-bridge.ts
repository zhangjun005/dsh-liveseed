import { LlmAdapter, callConfigEquals, type LlmCallConfig, type LlmRuntime, type GenerateOptions, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';

/** Narrow bridge: host credentials/adapters stay in the host; private Session IDs do not. */
export class HostModelBridge extends LlmAdapter {
  constructor(private readonly host: LlmRuntime, private readonly selection: () => ModelSelection | undefined, private readonly maxTokens: number, private readonly allowedTools: ReadonlySet<string> = new Set()) { super(); }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return (await this.prepareCall(provider, model, signal)).model;
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const selected = this.selection();
    if (!selected || selected.provider !== provider || selected.model !== model) throw new Error('LiveSeed model route is not authorized.');
    const prepared = await this.host.prepareCall({ provider, model, maxTokens: this.maxTokens,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) }, signal);
    const effort = prepared.config.reasoningEffort;
    return {
      model: { provider, id: model, name: model,
        ...(prepared.context ? { context: prepared.context } : {}),
        ...(prepared.inputModalities ? { inputModalities: prepared.inputModalities } : {}),
        ...(prepared.systemPromptUpdate ? { systemPromptUpdate: prepared.systemPromptUpdate } : {}),
        ...(prepared.toolUpdate ? { toolUpdate: prepared.toolUpdate } : {}),
        defaultMaxTokens: this.maxTokens,
        ...(effort ? { reasoning: { efforts: [{ id: effort, name: effort }], defaultEffort: effort } } : {}),
      },
      stream: async function* (this: HostModelBridge, options: GenerateOptions): AsyncIterable<StreamChunk> {
        const route = this.selection();
        if (!route || options.provider !== provider || options.model !== model || route.provider !== provider || route.model !== model) throw new Error('LiveSeed model route changed before dispatch.');
        if (options.tools?.some(tool => !this.allowedTools.has(tool.name))) throw new Error('LiveSeed has not granted these model tools.');
        const config: LlmCallConfig = { provider: options.provider, model: options.model,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.stop === undefined ? {} : { stop: options.stop }) };
        // Auxiliary native calls may reserve fewer output tokens than the conversation.
        const effective = callConfigEquals(config, prepared.config) ? prepared : await this.host.prepareCall(config, options.signal);
        if (JSON.stringify([effective.context, effective.inputModalities, effective.systemPromptUpdate, effective.toolUpdate]) !== JSON.stringify([prepared.context, prepared.inputModalities, prepared.systemPromptUpdate, prepared.toolUpdate])) throw new Error('LiveSeed model capabilities changed during request admission.');
        const { sessionId: _privateSession, ...forwarded } = options;
        yield* effective.stream(Object.freeze(forwarded));
      }.bind(this),
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Native compaction uses llm.stream rather than the AgentLoop prepared-call path.
    // Apply the same route, tool and private-session checks before entering the host.
    const prepared = await this.prepareCall(options.provider, options.model, options.signal);
    yield* prepared.stream(options);
  }
}
