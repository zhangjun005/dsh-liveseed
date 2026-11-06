import type { Context } from '@deepseek-ai/cordis';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-compaction-basic';

/** Bind native compaction explicitly in the private Agent scope, after evidence capture. */
export async function compactPressure(ctx: Context, agent: Agent, signal: AbortSignal): Promise<void> {
  try { await ctx.compaction.compactIfNeeded(agent, 'pressure', signal); }
  catch { ctx.logger.warn('LiveSeed native compaction could not reduce the current context.'); }
}
export function bindOverflow(agentCtx: Context, owner: Context): void {
  let attempts = 0;
  agentCtx.on('agent/status', ({ status }) => { if (status === 'idle') attempts = 0; });
  agentCtx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted || attempts >= 1) return next();
    attempts++;
    const generation = agent.session.surface.replaceGeneration;
    try {
      const result = await owner.compaction.compactIfNeeded(agent, 'context-overflow', signal);
      if (result && !signal.aborted) return { kind: 'retry' };
    } catch { owner.logger.warn('LiveSeed native overflow recovery did not finish.'); }
    if (!signal.aborted && agent.session.surface.replaceGeneration > generation) return { kind: 'retry' };
    return next();
  });
}
