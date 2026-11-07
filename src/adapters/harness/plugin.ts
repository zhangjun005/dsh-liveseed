import type { Context } from '@deepseek-ai/cordis';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { CompanionRuntime } from './runtime.js';
import { registerRemote } from './remote.js';
import { CharacterAssets } from './character-assets.js';

export const name = 'dsh-liveseed';
export const inject = ['llm', 'connection', 'agentDefaultModel', 'typert', 'typertGateway'];
export const Config = z.object({
  stateDir: z.string().refine(isAbsolute, 'stateDir must be an absolute path'),
  characterDir: z.string().refine(isAbsolute, 'characterDir must be an absolute path').optional(),
  provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  maxTokens: z.number().int().min(64).max(2048).default(512),
  replyTimeoutMs: z.number().int().min(1000).max(300000).default(90000),
  memoryProvider: z.string().min(1).optional(), memoryModel: z.string().min(1).optional(),
  memoryIdleMs: z.number().int().min(1000).max(3600000).default(60000),
  memoryBatchSize: z.number().int().min(2).max(64).default(8),
  memoryMaxTokens: z.number().int().min(512).max(8192).default(4096),
  memoryReflectionEvery: z.number().int().min(1).max(1000).default(4),
}).strict().refine(value => Boolean(value.provider) === Boolean(value.model), 'provider and model must be supplied together')
  .refine(value => Boolean(value.memoryProvider) === Boolean(value.memoryModel), 'memoryProvider and memoryModel must be supplied together');

export async function apply(ctx: Context, config: z.infer<typeof Config>): Promise<void> {
  const characters = new CharacterAssets(config.characterDir ?? fileURLToPath(new URL('../../../CharacterModel/', import.meta.url)));
  void characters.ready.catch(() => ctx.logger.warn('Character asset inventory is unavailable; companion chat remains enabled.'));
  characters.install(ctx);
  const runtime = new CompanionRuntime(ctx, config);
  ctx.effect(() => () => runtime.close());
  await runtime.ready;
  registerRemote(ctx, runtime, characters);
  ctx.logger.info('LiveSeed companion is ready in its private native runtime.');
}
