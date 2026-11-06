import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Llm, { LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import Defaults from '@deepseek-ai/dsh-agent-default-model';
import { CompanionRuntime } from '../../dist/adapters/harness/runtime.js';
import { emptyMemory, foldMemory, recall } from '../../dist/core/memory/store.js';
import { FixtureAdapter } from './fixture.mjs';

const source = { ref: 'day-a:5', sessionId: 'day-a', seq: 5, at: 1000, role: 'user', text: '我喜欢红茶' };
test('memory fold validates evidence, versions, idempotency, protection and withdrawn narrative', () => {
  let state = foldMemory(emptyMemory(), { type: 'evidence', items: [source] });
  const job = id => ({ type: 'job', job: { id, kind: 'incremental', refs: [source.ref], input: '', at: 2000 } });
  const commit = (id, proposal) => ({ type: 'accepted', id, at: 3000, proposal });
  state = foldMemory(state, job('a'));
  state = foldMemory(state, commit('a', { baseVersion: 0, mutations: [{ op: 'remember', id: 'tea', text: '喜欢红茶', evidence: [source.ref] }], narrative: { text: '我们聊过红茶', evidence: [source.ref] } }));
  assert.equal(recall(state, '红茶')[0].id, 'tea');
  assert.equal(foldMemory(state, commit('a', { baseVersion: 0, mutations: [] })), state);
  state = foldMemory(state, job('b'));
  assert.throws(() => foldMemory(state, commit('b', { baseVersion: 0, mutations: [] })), /Stale/);
  assert.throws(() => foldMemory(state, commit('b', { baseVersion: 1, mutations: [{ op: 'remember', id: 'fake', text: '伪造', evidence: ['host:999'] }] })), /Unknown evidence/);
  state = foldMemory(state, { type: 'intent', intent: { id: 'protect', kind: 'protect', evidence: [source.ref], text: '暂时保留', at: 2000, expiresAt: 9999 } });
  assert.throws(() => foldMemory(state, commit('b', { baseVersion: 1, mutations: [{ op: 'state', id: 'tea', state: 'quiet', reason: '过时' }] })), /protected/);
  state = foldMemory(state, { ...commit('b', { baseVersion: 1, mutations: [{ op: 'state', id: 'tea', state: 'quiet', reason: '不再主动提起' }] }), at: 10000 });
  assert.equal(recall(state, '红茶').length, 0);
  assert.equal(recall(state, '红茶', { maintenance: true }).length, 1);
  assert.equal(state.narrative.text, '');
  assert.equal(state.evidence.get(source.ref).text, source.text);
});

async function* textReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: 'stop' };
}
function taskState(options) {
  for (const message of [...options.messages].reverse()) {
    for (const block of message.content) {
      if (block.type !== 'text') continue;
      for (const line of block.text.split('\n')) {
        try { const value = JSON.parse(line); if (value.job && typeof value.baseVersion === 'number') return value; } catch {}
      }
    }
  }
  throw new Error('Native worker context was not present.');
}
class MemoryFixture extends FixtureAdapter {
  workerCalls = 0;
  staleOnce = false;
  overflowOnce = false;
  async *stream(options) {
    if (options.purpose === 'compaction') { yield* super.stream(options); return; }
    if (options.messages.some(message => message.source?.kind === 'liveseed-memory-task')) {
      this.requests.push(options); this.workerCalls++;
      const state = taskState(options);
      if (this.staleOnce) { this.staleOnce = false; yield* textReply(JSON.stringify({ baseVersion: state.baseVersion + 1, mutations: [] })); return; }
      if (state.job.input === '[slow-worker]') await delay(10000, undefined, { signal: options.signal });
      const mutations = [];
      let narrative;
      if (state.job.input === '归档饮料') {
        for (const item of state.memoryCatalog.filter(item => item.text.includes('红茶'))) mutations.push({ op: 'state', id: item.id, state: 'quiet', reason: '用户不希望继续主动提及' });
      } else {
        for (const entry of state.evidence.filter(entry => entry.role === 'user' && entry.text.includes('红茶'))) {
          const id = `tea-${entry.ref}`;
          if (state.memoryCatalog.some(item => item.id === id && item.state !== 'active')) continue;
          if (!state.memoryCatalog.some(item => item.id === id)) mutations.push({ op: 'remember', id, text: '用户喜欢红茶', evidence: [entry.ref] });
          narrative = { text: '我们聊过红茶，留下了一次关于口味的交流。', evidence: [entry.ref] };
        }
      }
      yield* textReply(JSON.stringify({ baseVersion: state.baseVersion, mutations, ...(narrative ? { narrative } : {}), reply: '已按你的意思整理。' })); return;
    }
    const input = [...options.messages].reverse().find(message => message.source?.kind === 'liveseed-user');
    const text = input?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
    if (text === '[overflow]' && this.overflowOnce) { this.overflowOnce = false; this.requests.push(options); throw new LlmError('Synthetic context overflow.', CONTEXT_WINDOW_EXCEEDED_CODE); }
    if (text.startsWith('pressure-')) { this.requests.push(options); yield* textReply(text); return; }
    const tool = text === '[reflect]' ? ['memory_reflect', { text: '我愿意先听你把话说完，再给建议。' }]
      : text === '[recall]' ? ['memory_recall', { query: '红茶' }]
      : text === '[forge]' ? ['memory_intent', { kind: 'protect', text: '伪造范围', refs: ['ordinary-session:999'] }] : null;
    const latestDialogue = [...options.messages].reverse().find(message => message.role === 'tool' || message.role === 'assistant' || message.source?.kind === 'liveseed-user');
    if (tool && latestDialogue?.role !== 'tool') {
      this.requests.push(options);
      const block = { type: 'tool-call', id: randomUUID(), name: tool[0], arguments: JSON.stringify(tool[1]) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: 'tool-calls' }; return;
    }
    yield* super.stream(options);
  }
}
async function idle(runtime) {
  for (let count = 0; count < 500; count++) { const state = await runtime.state(); if (!state.running) return state; await delay(10); }
  throw new Error('Main did not become idle.');
}
test('native memory loop, active recall, private reflection, archival and rebuild', { timeout: 30000 }, async () => {
  await mkdir(resolve('.local'), { recursive: true });
  const folder = await mkdtemp(join(resolve('.local'), 'memory-'));
  await writeFile(join(folder, 'soul.md'), '底层材料 {{literal}} 应当完整保留。', 'utf8');
  const host = new Context(); const adapter = new MemoryFixture(); let runtime;
  const config = { stateDir: folder, maxTokens: 512, replyTimeoutMs: 5000, memoryIdleMs: 600000, memoryBatchSize: 64 };
  try {
    await host.plugin(Llm); host.llm.registerAdapter(['fixture'], adapter);
    await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    const first = { requestId: randomUUID(), text: '我喜欢红茶，今天也想喝。' };
    await runtime.send(first); await idle(runtime);
    assert.ok([...runtime.memory.snapshot().evidence.values()].some(entry => entry.reasoning === 'synthetic-provider-reasoning'), 'native provider reasoning remains separate from explicit understanding');
    await runtime.organizeMemory();
    assert.equal(adapter.workerCalls, 1);
    assert.ok((await readFile(join(folder, 'narrative.md'), 'utf8')).includes('红茶'));
    assert.ok([...runtime.memory.snapshot().items.values()].some(item => item.text.includes('红茶')));
    await runtime.send({ requestId: randomUUID(), text: '[recall]' }); await idle(runtime);
    const recallCall = adapter.requests.filter(call => call.messages.some(message => message.source?.kind === 'liveseed-user')).at(-1);
    assert.ok(recallCall.messages.some(message => message.role === 'tool' && message.content.some(block => block.text?.includes('用户喜欢红茶'))));
    await runtime.send({ requestId: randomUUID(), text: '[reflect]' }); await idle(runtime);
    assert.ok([...runtime.memory.snapshot().intents.values()].some(intent => intent.kind === 'understanding' && intent.evidence[0].startsWith('liveseed-main:')));
    await runtime.send({ requestId: randomUUID(), text: '[forge]' }); await idle(runtime);
    assert.equal([...runtime.memory.snapshot().intents.values()].some(intent => intent.evidence.includes('ordinary-session:999')), false);
    const maintenance = { requestId: randomUUID(), text: '归档饮料' };
    await runtime.sendMemory(maintenance); await runtime.organizeMemory();
    assert.equal((await runtime.memoryState()).messages.at(-1).text, '已按你的意思整理。');
    assert.equal((await readFile(join(folder, 'narrative.md'), 'utf8')), '');
    await runtime.send({ requestId: randomUUID(), text: '今天换个话题' }); await idle(runtime);
    const last = adapter.requests.filter(call => call.messages.some(message => message.source?.kind === 'liveseed-user')).at(-1);
    assert.ok(!JSON.stringify(last.messages).includes('用户喜欢红茶'), 'withdrawn memory must not remain in tool results or context snapshots');
    assert.ok(!JSON.stringify(last.messages).includes('今天也想喝'), 'withdrawn conversation quotes and derivative replies must not linger');
    assert.ok(adapter.requests.filter(call => call.messages.some(message => message.source?.kind === 'liveseed-user')).every(call => !call.messages.some(message => message.source?.kind === 'liveseed-memory-record')));
    assert.equal(host.get('sessions'), undefined, 'private sessions must not register into host');
    const version = runtime.memory.snapshot().version;
    const calls = adapter.workerCalls;
    await runtime.close(); await rm(join(folder, 'narrative.md'));
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    assert.equal(runtime.memory.snapshot().version, version);
    assert.equal(await readFile(join(folder, 'narrative.md'), 'utf8'), '');
    assert.equal(adapter.workerCalls, calls, 'rebuild must not invent new model output');
    const receipt = await runtime.send(first); assert.ok(receipt.messageId);
    runtime.currentDay = '2000-01-01';
    await runtime.send({ requestId: randomUUID(), text: '换日后继续' }); await idle(runtime);
    const segments = runtime.memory.snapshot().segments;
    assert.equal(segments.length, 2);
    assert.notEqual(segments[0].sessionId, segments[1].sessionId);
    assert.equal((await runtime.send(first)).messageId, receipt.messageId, 'retry receipt must survive native segment rotation');
    await runtime.close();
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    assert.ok((await runtime.state()).messages.some(message => message.text === first.text), 'UI history survives cross-day restore');
    assert.equal((await runtime.send(first)).messageId, receipt.messageId);
    for (let index = 0; index < 9; index++) {
      await runtime.sendMemory({ requestId: randomUUID(), text: `回看整理 ${index}` });
      await runtime.organizeMemory();
    }
    const summaryFailures = [];
    runtime.memory.ctx.on('compaction/summary-error', ({ error }, next) => { summaryFailures.push(String(error)); return next(); });
    await runtime.memory.ctx.compaction.compactNow(runtime.memory.handle.agent, new AbortController().signal).catch(error => { throw new Error(`Worker compaction: ${summaryFailures.join('; ')}`, { cause: error }); });
    await runtime.close();
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    assert.ok((await runtime.memoryState()).messages.some(message => message.text === '回看整理 8'));
    const nativeWarnings = [];
    runtime.inner.logger.exporter({ export: message => { if (message.type === 'warn') nativeWarnings.push(message); } });
    const workerLog = await runtime.memory.ctx.sessionPersistence.open('liveseed-memory', 'read');
    try { assert.ok((await workerLog.read()).events.some(event => event.surfaceOp?.op === 'replace'), 'long worker uses native compaction and remains readable'); }
    finally { await workerLog.close(); }
    for (let index = 0; index < 7; index++) {
      await runtime.send({ requestId: randomUUID(), text: `pressure-${index} ` + '甲乙丙丁'.repeat(1200) }); await idle(runtime);
    }
    const mainArtifacts = await runtime.inner.sessionPersistence.open(runtime.handle.agent.session.id, 'read');
    try {
      const events = (await mainArtifacts.read()).events;
      assert.ok(events.some(event => event.type === 'compaction/summary'), `native pressure compaction should run: ${JSON.stringify({ warnings: nativeWarnings, compaction: Boolean(runtime.inner.get('compaction')), tokenMeter: Boolean(runtime.inner.get('tokenMeter')), measurement: runtime.inner.get('tokenMeter')?.measure(runtime.handle.agent.session).totalTokens, config: runtime.inner.get('compaction')?.config })}`);
      assert.ok(events.some(event => event.sourceEventSeqs?.length > 0), 'large main context must use native surface replacement');
      assert.ok(events.some(event => event.type === 'user/message' && event.data.source.kind === 'liveseed-user' && event.data.content.some(block => block.text?.startsWith('pressure-0'))), 'raw sources must survive compression');
    } finally { await mainArtifacts.close(); }
    adapter.overflowOnce = true;
    await runtime.send({ requestId: randomUUID(), text: '[overflow]' });
    const recovered = await idle(runtime);
    assert.equal(recovered.notice, null);
    assert.ok(recovered.messages.some(message => message.text.includes('你刚才说：“[overflow]”')), 'native overflow should compact then retry the main request');
    assert.equal(recovered.messages.filter(message => message.role === 'user' && message.text === '[overflow]').length, 1);
    console.log(`Memory artifacts: ${folder}`);
  } finally { await runtime?.close(); await host.fiber.dispose(); }
});

test('pending memory jobs recover after failed proposal; cancelled maintenance does not replay', { timeout: 15000 }, async () => {
  await mkdir(resolve('.local'), { recursive: true });
  const folder = await mkdtemp(join(resolve('.local'), 'memory-retry-'));
  const host = new Context(); const adapter = new MemoryFixture(); let runtime;
  const config = { stateDir: folder, maxTokens: 512, replyTimeoutMs: 5000, memoryIdleMs: 600000, memoryBatchSize: 64 };
  try {
    await host.plugin(Llm); host.llm.registerAdapter(['fixture'], adapter); await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    runtime = new CompanionRuntime(host, config); await runtime.ready;
    adapter.staleOnce = true;
    const request = { requestId: randomUUID(), text: '回看整理' };
    const receipt = await runtime.sendMemory(request);
    await assert.rejects(runtime.organizeMemory(), /Stale/);
    assert.equal(runtime.memory.snapshot().version, 0);
    await runtime.close(); runtime = new CompanionRuntime(host, config); await runtime.ready;
    await runtime.organizeMemory();
    assert.equal(runtime.memory.snapshot().version, 1);
    assert.equal((await runtime.sendMemory(request)).messageId, receipt.messageId);
    const slow = { requestId: randomUUID(), text: '[slow-worker]' };
    await runtime.sendMemory(slow);
    for (let count = 0; count < 100 && runtime.memory.activeJob?.input !== slow.text; count++) await delay(10);
    await runtime.stopMemory();
    assert.equal(runtime.memory.snapshot().cancelled.size, 1);
    await runtime.close(); runtime = new CompanionRuntime(host, config); await runtime.ready;
    const before = adapter.workerCalls; await runtime.organizeMemory();
    assert.equal(adapter.workerCalls, before, 'cancelled user maintenance must not be retried after restart');
    assert.equal(runtime.memory.snapshot().cancelled.size, 1);
  } finally { await runtime?.close(); await host.fiber.dispose(); }
});

test('journal failure does not publish memory state and rejects subsequent mutations', { timeout: 10000 }, async () => {
  await mkdir(resolve('.local'), { recursive: true });
  const folder = await mkdtemp(join(resolve('.local'), 'memory-durability-'));
  const host = new Context(); const adapter = new MemoryFixture(); let runtime;
  try {
    await host.plugin(Llm); host.llm.registerAdapter(['fixture'], adapter); await host.plugin(Defaults, { provider: 'fixture', model: 'fixture-chat' });
    runtime = new CompanionRuntime(host, { stateDir: folder, maxTokens: 512, replyTimeoutMs: 5000, memoryIdleMs: 600000 }); await runtime.ready;
    const journal = runtime.memory.journal;
    const originalFlush = journal.flush.bind(journal);
    journal.flush = async () => { throw new Error('Synthetic flush failure.'); };
    try {
      await assert.rejects(runtime.sendMemory({ requestId: randomUUID(), text: '不能先公布缓存' }), /Synthetic flush failure/);
      assert.equal(runtime.memory.snapshot().jobs.size, 0);
      await assert.rejects(runtime.sendMemory({ requestId: randomUUID(), text: '后续维护' }), error => error.status === 503);
    } finally { journal.flush = originalFlush; }
  } finally { await runtime?.close(); await host.fiber.dispose(); }
});
