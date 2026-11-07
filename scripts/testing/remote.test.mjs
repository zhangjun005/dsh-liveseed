import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import Defaults from '@deepseek-ai/dsh-agent-default-model';
import { SessionId } from '@deepseek-ai/dsh-session';
import { CompanionRuntime } from '../../dist/adapters/harness/runtime.js';
import { LiveSeedRemote } from '../../dist/adapters/harness/remote.js';
import { descriptors } from '../../dist/adapters/harness/remote-contract.js';
import { FixtureAdapter } from './fixture.mjs';

async function idle(runtime) { for (let count = 0; count < 400; count++) { if (!(await runtime.state()).running) return; await delay(10); } throw new Error('Not idle.'); }
test('private Remote catalog, daily views, historical retry and cancellable native follow', { timeout: 12000 }, async () => {
  await mkdir(resolve('.local'), { recursive: true }); const folder = await mkdtemp(join(resolve('.local'), 'remote-'));
  const host = new Context(); let runtime;
  try {
    await host.plugin(Llm); host.llm.registerAdapter(['fixture'], new FixtureAdapter()); await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    runtime = new CompanionRuntime(host, { stateDir: folder, maxTokens: 512, replyTimeoutMs: 5000, memoryIdleMs: 600000, memoryBatchSize: 64 }); await runtime.ready;
    const remote = new LiveSeedRemote(host, runtime);
    const catalog = await remote.catalog();
    assert.equal(catalog.sessions.filter(session => session.kind === 'memory').length, 1);
    const oldId = catalog.activeSessionId;
    const oldRequest = { sessionId: oldId, requestId: randomUUID(), text: '第一段独有记录' };
    const oldReceipt = await remote.send(oldRequest); await idle(runtime);
    runtime.currentDay = '2000-01-01';
    const abort = new AbortController(); const stream = remote.follow({ sessionId: 'current' }, abort.signal)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value.type, 'baseline');
    const next = stream.next();
    await remote.send({ sessionId: 'current', requestId: randomUUID(), text: '新段独有记录' }); await idle(runtime);
    assert.equal((await next).value.type, 'update');
    abort.abort(); await stream.return();
    const after = await remote.catalog(); assert.notEqual(after.activeSessionId, oldId);
    assert.equal(after.memorySessionId, catalog.memorySessionId);
    const historical = await remote.snapshot({ sessionId: oldId });
    assert.equal(historical.readOnly, true);
    assert.ok(historical.messages.some(message => message.text === oldRequest.text));
    assert.ok(!historical.messages.some(message => message.text === '新段独有记录'));
    const current = await remote.snapshot({ sessionId: 'current' });
    assert.ok(!current.messages.some(message => message.text === oldRequest.text));
    await assert.rejects(remote.send({ sessionId: oldId, requestId: randomUUID(), text: '不可在旧段继续' }), error => error.code === 'liveseed/conflict');
    assert.equal((await remote.send(oldRequest)).messageId, oldReceipt.messageId, 'accepted retries may acknowledge old segments without writing');
    await assert.rejects(remote.snapshot({ sessionId: 'ordinary-session' }), error => error.code === 'liveseed/not-found');
    await assert.rejects(remote.snapshot({ sessionId: 'liveseed-memory-journal' }), error => error.code === 'liveseed/not-found');
    const schema = descriptors.find(descriptor => descriptor.method === 'send').parameters[0].codec.create();
    assert.throws(() => schema.parse({ ...oldRequest, cwd: 'E:/' }));
  } finally { await runtime?.close(); await host.fiber.dispose(); }
});

test('follow replaces the whole view when new native sessions reuse the same revision number', async () => {
  const host = new Context(); let changed; let day = 1;
  const abort = new AbortController();
  const fake = { revision: 0, closed: false,
    subscribe(listener) { changed = listener; return () => {}; },
    async inspectView() {
      const id = `private-day-${day}`;
      return { catalog: { generation: 'test', activeSessionId: id, memorySessionId: 'memory', sessions: [] },
        view: { generation: 'test', revision: 10, sessionId: id, readOnly: false, running: false, configured: true, liveText: '', notice: null,
          messages: [{ id, role: 'user', text: `day ${day}`, at: 1000 }] } };
    },
  };
  const remote = new LiveSeedRemote(host, fake);
  const follow = remote.follow({ sessionId: 'current' }, abort.signal)[Symbol.asyncIterator]();
  try {
    assert.equal((await follow.next()).value.view.sessionId, 'private-day-1');
    const waiting = follow.next(); day = 2; changed();
    const update = (await waiting).value;
    assert.equal(update.view.sessionId, 'private-day-2');
    assert.equal(update.view.messages[0].text, 'day 2');
  } finally { abort.abort(); await follow.return(); await host.fiber.dispose(); }
});

test('memory worker assignment persists, scopes dialogue, rejects busy and stale switches', { timeout: 15000 }, async () => {
  await mkdir(resolve('.local'), { recursive: true }); const folder = await mkdtemp(join(resolve('.local'), 'worker-selection-'));
  const host = new Context(); let remoteScope = new Context(); let runtime;
  let release; const gate = new Promise(resolveGate => { release = resolveGate; });
  class HeldWorker extends FixtureAdapter {
    async *stream(options) {
      if (options.messages.some(message => message.source?.kind === 'liveseed-memory-task')) await gate;
      yield* super.stream(options);
    }
  }
  const config = { stateDir: folder, maxTokens: 512, replyTimeoutMs: 5000, memoryIdleMs: 600000, memoryBatchSize: 64 };
  try {
    await host.plugin(Llm); host.llm.registerAdapter(['fixture'], new HeldWorker()); await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    let remote = new LiveSeedRemote(remoteScope, runtime);
    const original = (await remote.catalog()).memorySessionId;
    const create = { requestId: randomUUID(), title: '指定的新整理会话' };
    const worker = await remote.createMemorySession(create);
    assert.equal((await remote.catalog()).memorySessionId, original, 'creating a Session must not assign it');
    assert.deepEqual(await remote.createMemorySession(create), worker, 'creation retries must not create duplicate workers');
    assert.deepEqual(await remote.createMemorySession({ ...create, requestId: create.requestId.toUpperCase() }), worker);
    await assert.rejects(remote.createMemorySession({ ...create, title: '不同的标题' }), error => error.code === 'liveseed/conflict');
    await assert.rejects(remote.selectMemorySession({ sessionId: 'ordinary-session', expectedSessionId: original }), error => error.code === 'liveseed/not-found');
    await assert.rejects(remote.selectMemorySession({ sessionId: 'liveseed-memory-journal', expectedSessionId: original }), error => error.code === 'liveseed/not-found');
    const request = { sessionId: original, requestId: randomUUID(), text: '原整理会话的独立对话' };
    const receipt = await remote.send(request);
    await assert.rejects(remote.selectMemorySession({ sessionId: worker.sessionId, expectedSessionId: original }), error => error.code === 'liveseed/conflict');
    release(); await runtime.organizeMemory();
    const signal = new AbortController(); const follow = remote.follow({ sessionId: 'memory' }, signal.signal)[Symbol.asyncIterator]();
    assert.equal((await follow.next()).value.view.sessionId, original);
    const next = follow.next();
    await remote.selectMemorySession({ sessionId: worker.sessionId, expectedSessionId: original });
    assert.equal((await next).value.view.sessionId, worker.sessionId, 'logical memory stream follows the selected real Session');
    signal.abort(); await follow.return();
    assert.equal((await remote.snapshot({ sessionId: 'memory' })).messages.length, 0);
    assert.equal((await remote.snapshot({ sessionId: original })).readOnly, false);
    await remote.send({ sessionId: original, requestId: randomUUID(), text: '继续未指定会话的对话' }); await runtime.organizeMemory();
    assert.equal((await remote.catalog()).memorySessionId, worker.sessionId, 'manual dialogue must not reassign automatic tasks');
    const manual = [...runtime.memory.snapshot().jobs.values()].find(job => job.input === '继续未指定会话的对话');
    assert.equal(manual.workerSessionId, original);
    const log = await runtime.memory.ctx.sessionPersistence.open(SessionId(original), 'read');
    try { assert.ok((await log.read()).events.some(event => event.type === 'user/message' && event.data.source.jobId === manual.id), 'dialogue must execute in its chosen native Session'); } finally { await log.close(); }
    assert.equal((await remote.send(request)).messageId, receipt.messageId, 'old accepted receipt can still be acknowledged');
    await assert.rejects(remote.selectMemorySession({ sessionId: original, expectedSessionId: original }), error => error.code === 'liveseed/conflict');
    await remote.send({ sessionId: worker.sessionId, requestId: randomUUID(), text: '由新整理会话处理' }); await runtime.organizeMemory();
    const jobs = [...runtime.memory.snapshot().jobs.values()];
    assert.equal(jobs.find(job => job.input === '由新整理会话处理').workerSessionId, worker.sessionId);
    await remote.send({ sessionId: original, requestId: randomUUID(), text: '再聊一次原会话' }); await runtime.organizeMemory();
    await remote.send({ sessionId: 'current', requestId: randomUUID(), text: '自动整理的新来源' }); await idle(runtime); await runtime.organizeMemory();
    const automatic = [...runtime.memory.snapshot().jobs.values()].findLast(job => job.kind !== 'dialogue');
    assert.equal(automatic.workerSessionId, worker.sessionId, 'automatic tasks still execute in the assigned Session after manual dialogue elsewhere');
    const automaticLog = await runtime.memory.ctx.sessionPersistence.open(SessionId(worker.sessionId), 'read');
    try { assert.ok((await automaticLog.read()).events.some(event => event.type === 'user/message' && event.data.source.jobId === automatic.id)); } finally { await automaticLog.close(); }
    await runtime.close(); runtime = new CompanionRuntime(host, config); await runtime.ready;
    await remoteScope.fiber.dispose(); remoteScope = new Context(); remote = new LiveSeedRemote(remoteScope, runtime);
    assert.equal((await remote.catalog()).memorySessionId, worker.sessionId);
    assert.ok((await remote.snapshot({ sessionId: 'memory' })).messages.some(message => message.text === '由新整理会话处理'));
    await remote.selectMemorySession({ sessionId: original, expectedSessionId: worker.sessionId });
    const restored = await remote.snapshot({ sessionId: 'memory' });
    assert.ok(restored.messages.some(message => message.text === request.text));
    assert.ok(!restored.messages.some(message => message.text === '由新整理会话处理'));
  } finally { release(); await runtime?.close(); await remoteScope.fiber.dispose(); await host.fiber.dispose(); }
});
