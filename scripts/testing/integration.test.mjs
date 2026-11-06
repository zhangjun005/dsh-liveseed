import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import Defaults from '@deepseek-ai/dsh-agent-default-model';
import Sessions from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import Query from '@deepseek-ai/dsh-session-query-sqlite';
import { FixtureAdapter } from './fixture.mjs';
import { CompanionRuntime } from '../../dist/adapters/harness/runtime.js';

async function waitFor(read, predicate, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (predicate(value)) return value; await delay(15); }
  throw new Error('Integration condition timed out.');
}
test('native companion, host bridge, durable retries, stop, restore and tool isolation', { timeout: 30000 }, async () => {
  await mkdir(resolve('.local'), { recursive: true });
  const folder = await mkdtemp(join(resolve('.local'), 'integration-'));
  const host = new Context();
  const adapter = new FixtureAdapter();
  let hostToolCalls = 0;
  let runtime;
  try {
    await host.plugin(Sessions);
    await host.plugin(Jsonl, { root: join(folder, 'host-sessions'), compression: 'none' });
    await host.plugin(Query, { path: join(folder, 'host-query.sqlite') });
    await host.plugin(Llm);
    await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Ordinary host test.' });
    await host.plugin(Tools);
    host.tools.register(defineTool({ name: 'read', description: 'Host-only test sentinel.', parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { hostToolCalls += 1; return 'host-only data'; } }));
    host.llm.registerAdapter(['fixture'], adapter);
    await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    const config = { stateDir: join(folder, 'companion'), maxTokens: 512, replyTimeoutMs: 5000 };
    runtime = new CompanionRuntime(host, config);
    await runtime.ready;
    const request = { requestId: randomUUID(), text: '记住这句验收消息' };
    const accepted = await runtime.send(request);
    await waitFor(() => runtime.state(), state => !state.running && state.messages.length === 2);
    assert.equal((await runtime.send(request)).messageId, accepted.messageId);
    assert.equal(adapter.requests.length, 1, 'retry must not spend another model call');
    await assert.rejects(runtime.send({ ...request, text: 'different content' }), error => error.status === 409);
    assert.equal(adapter.requests[0].sessionId, undefined, 'private session ID must not enter host metadata');
    assert.deepEqual(adapter.requests[0].tools.map(tool => tool.name).sort(), ['memory_intent', 'memory_recall', 'memory_reflect']);
    assert.ok(adapter.requests[0].messages.some(message => message.content.some(block => block.text?.includes(request.text))));
    assert.equal(host.sessions.list().length, 0);
    assert.equal((await host.sessionQuery.listSessions()).length, 0);
    assert.equal((await host.sessionPersistence.list()).length, 0);
    const before = (await runtime.state()).messages;
    await runtime.close();
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    assert.deepEqual((await runtime.state()).messages, before, 'restart must restore the same transcript from JSONL');
    assert.equal((await runtime.send(request)).messageId, accepted.messageId, 'retry receipt must survive restart');
    const slow = { requestId: randomUUID(), text: '停一下，这是一段较长的验收消息' };
    await runtime.send(slow);
    await waitFor(() => runtime.state(), state => Boolean(state.liveText));
    await assert.rejects(runtime.send({ requestId: randomUUID(), text: '并发消息' }), error => error.status === 409);
    await runtime.stop();
    assert.equal((await runtime.state()).running, false);
    assert.equal((await runtime.state()).notice, '这次回复已停止。');
    await runtime.send({ requestId: randomUUID(), text: '[tools]' });
    await waitFor(() => runtime.state(), state => !state.running);
    assert.ok(adapter.requests.every(call => call.tools?.every(tool => ['memory_intent', 'memory_recall', 'memory_reflect', 'memory_lookup'].includes(tool.name))), 'only scoped memory tools may cross the bridge');
    assert.equal(hostToolCalls, 0, 'a hallucinated tool call must not execute a host tool');
    assert.equal(host.sessions.list().length, 0);
    assert.ok((await runtime.state()).messages.some(message => message.text.includes('没有调用任何外部工具')));
    await runtime.send({ requestId: randomUUID(), text: '[fail]' });
    await waitFor(() => runtime.state(), state => !state.running);
    assert.equal((await runtime.state()).notice, '这次没能完成回复，请稍后再试。');
    await runtime.send({ requestId: randomUUID(), text: '故障后继续' });
    await waitFor(() => runtime.state(), state => !state.running);
    assert.ok((await runtime.state()).messages.some(message => message.text.includes('你刚才说：“故障后继续”')));
    console.log(`Integration artifacts: ${folder}`);
  } finally { await runtime?.close(); await host.fiber.dispose(); }
});
