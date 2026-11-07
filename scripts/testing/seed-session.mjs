import { Context } from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import Defaults from '@deepseek-ai/dsh-agent-default-model';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompanionRuntime } from '../../dist/adapters/harness/runtime.js';
import { FixtureAdapter } from './fixture.mjs';

/** Test-owned native history, created before the isolated Web host starts. */
export async function seedCompanionHistory(stateDir) {
  const host = new Context(); let runtime;
  const actualNow = Date.now;
  const yesterday = actualNow() - 86400000;
  try {
    Date.now = () => yesterday;
    await host.plugin(Llm); host.llm.registerAdapter(['fixture'], new FixtureAdapter());
    await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    runtime = new CompanionRuntime(host, { stateDir, maxTokens: 512, replyTimeoutMs: 5000, memoryIdleMs: 600000, memoryBatchSize: 64 });
    await runtime.ready;
    await runtime.send({ requestId: randomUUID(), text: '昨日的陪伴记录' });
    for (let count = 0; count < 300; count++) { if (!(await runtime.state()).running) return; await delay(10); }
    throw new Error('Seed conversation did not finish.');
  } finally { await runtime?.close(); await host.fiber.dispose(); Date.now = actualNow; }
}
