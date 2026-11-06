// Test-only in-process composition; never loads a user profile or credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.LIVESEED_DSH_ROOT) throw new Error('Set LIVESEED_DSH_ROOT to the installed @deepseek-ai/dsh directory.');
const hostRoot = resolve(process.env.LIVESEED_DSH_ROOT);
const hostRequire = createRequire(join(hostRoot, 'package.json'));
const load = async name => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
const modules = {};
for (const name of ['cordis', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-session-persistence-jsonl', 'dsh-session-query-sqlite', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace']) modules[name] = await load(name);
const { Context } = modules.cordis;
const { SessionId } = modules['dsh-session'];
const { LlmAdapter, createUserMessage } = modules['dsh-llm'];
const { defineTool } = modules['dsh-tools'];
const loopRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-agent-loop'));
const { z } = await import(pathToFileURL(loopRequire.resolve('zod')).href);
await mkdir(resolve('.local'), { recursive: true });
const runRoot = await mkdtemp(join(resolve('.local'), 'context-probe-'));
const results = [], requests = [], roots = [], errors = [];
const gates = new Map();
const sourceKind = 'liveseed-context-probe', projectionKey = 'liveseedContextProbe';
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const allText = messages => messages.map(textOf).join('\n');
const evidence = {};
for (const name of ['dsh', 'cordis', 'dsh-session', 'dsh-agent-loop', 'dsh-session-projection', 'dsh-workspace', 'dsh-api-session-controller', 'dsh-client-ui-workspace']) {
  const manifest = JSON.parse(await readFile(hostRequire.resolve(`@deepseek-ai/${name}/package.json`), 'utf8'));
  const entry = hostRequire.resolve(name === 'dsh' ? '@deepseek-ai/dsh/profile-boot' : `@deepseek-ai/${name}`);
  evidence[name] = { version: manifest.version, entry, sha256: createHash('sha256').update(await readFile(entry)).digest('hex') };
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function check(name, fn) {
  const details = await fn(); results.push({ name, status: 'passed', ...details }); console.log(`PASS ${name}`);
}
function newRoot() {
  const ctx = new Context();
  ctx.logger.exporter({ export(message) { if (message.type === 'error') errors.push(message.args.map(String).join(' ')); } });
  roots.push(ctx); return ctx;
}
class ProbeAdapter extends LlmAdapter {
  constructor(ctx) { super(); this.ctx = ctx; }
  async *stream(options) {
    const session = this.ctx.get('agents').get(options.sessionId).session;
    assert.deepEqual(options.messages, session.deriveMessages(), 'actual request must equal the native logged surface');
    assert.equal(options.system, undefined);
    assert.ok(Object.isFrozen(options.messages));
    assert.throws(() => options.messages.push({}), TypeError);
    requests.push({ sessionId: options.sessionId, messages: structuredClone(options.messages) });
    const gate = gates.get(options.sessionId);
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    const firstCall = requests.filter(request => request.sessionId === options.sessionId).length === 1;
    if (firstCall && allText(options.messages).includes('[ask-tool]')) {
      const block = { type: 'tool-call', id: 'probe-tool-call', name: 'probe_ack', arguments: JSON.stringify({ value: 'synthetic tool input' }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: 'tool-calls' }; return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'synthetic probe reply' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic probe reply' } };
    yield { type: 'finish', reason: 'stop' };
  }
}
async function mountRuntime(ctx, label) {
  for (const name of ['dsh-session', 'dsh-session-projection']) await ctx.plugin(modules[name].default);
  await ctx.plugin(modules['dsh-system-prompt'].default, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Synthetic architecture probe; no real user data.' });
  await ctx.plugin(modules['dsh-llm'].default);
  await ctx.plugin({ inject: ['llm', 'agents'], apply(adapterCtx) { adapterCtx.llm.registerAdapter(['liveseed-probe'], new ProbeAdapter(adapterCtx)); } });
  await ctx.plugin(modules['dsh-tools'].default);
  await ctx.plugin(modules['dsh-agent'].default);
  await ctx.plugin(modules['dsh-agent-loop'].default, { agents: [] });
  await ctx.plugin(modules['dsh-session-persistence-jsonl'].default, { root: join(runRoot, label, 'sessions'), compression: 'none' });
  await ctx.plugin(modules['dsh-session-query-sqlite'].default, { path: join(runRoot, label, `index-${Math.random().toString(16).slice(2)}.sqlite`) });
  await ctx.plugin({ inject: ['sessionProjections'], apply(projectionCtx) {
    projectionCtx.sessionProjections.register({
      key: projectionKey, stateVersion: 1,
      stateSchema: z.object({ version: z.number(), content: z.string(), sourceSeq: z.number().nullable() }),
      init: () => ({ version: 0, content: '', sourceSeq: null }),
      apply(state, event) {
        if (event.type !== 'user/message' || event.data.source.kind !== sourceKind) return state;
        return { ...JSON.parse(textOf(event.data)), sourceSeq: event.seq };
      },
    });
  } });
}
function setupFor(ctx, memory) {
  return async function setup(agentCtx, agent) {
    agentCtx.tools.register(defineTool({
      name: 'probe_ack', description: 'Synthetic no-side-effect tool for loop verification.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { return `ack: ${args.value}`; },
    }));
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      const state = ctx.get('sessionProjections').stateOf(agent.session, projectionKey);
      if (state.version === memory.version) return decision;
      const message = createUserMessage({ content: [{ type: 'text', text: JSON.stringify(memory) }], source: { kind: sourceKind } });
      if (state.sourceSeq === null) return { ...decision, messages: [...decision.messages, message] };
      // Update an existing context slot through native durable replacement.
      // The protected system head already exists at this point.
      agent.session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: state.sourceSeq, endSeq: state.sourceSeq },
        sourceEventSeqs: [state.sourceSeq],
      });
      return decision;
    });
  };
}
async function turn(handle, text) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await bounded(handle.agent.whenIdle(), `turn ${handle.agent.id}`);
}
const optionsFor = id => ({ sessionId: SessionId(id), meta: { cwd: resolve('.') }, agentOptions: { provider: 'liveseed-probe', model: 'synthetic' } });
let finalError;
try {
  const root = newRoot(); await mountRuntime(root, 'ordinary');
  await root.plugin(modules['dsh-storage'].default);
  await root.plugin(modules['dsh-storage-json'], { root: join(runRoot, 'workspace-storage') });
  await root.plugin(modules['dsh-storage-domain'], { backend: 'json' });
  await root.plugin(modules['dsh-workspace'].default);
  await root.workspaceRegistry.create(resolve('.'), 'Synthetic probe workspace');
  const ordinary = await root.agents.create(optionsFor('probe-ordinary'));
  await turn(ordinary, 'ordinary synthetic input');
  const memory = { version: 1, content: 'memory-v1: short replies' };
  const companion = await root.agents.create({ ...optionsFor('probe-companion'), setup: setupFor(root, memory) });
  await check('native loop + scoped context + tool continuation', async () => {
    await turn(companion, 'first companion input [ask-tool]');
    const calls = requests.filter(request => request.sessionId === companion.agent.id);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].messages.some(message => message.role === 'tool' && message.isError === false && textOf(message) === 'ack: synthetic tool input'));
    assert.ok(calls.every(call => allText(call.messages).includes('memory-v1')));
    const log = await root.sessionQuery.readSession(companion.agent.id);
    for (const type of ['tool/call', 'tool/result']) assert.ok(log.events.some(event => event.type === type));
    assert.ok(log.events.some(event => event.type === 'user/message' && event.data.source.kind === sourceKind));
    await turn(ordinary, 'ordinary input after companion hooks registered');
    assert.ok(!allText(requests.filter(request => request.sessionId === ordinary.agent.id).at(-1).messages).includes('memory-v1'));
    return { modelCalls: calls.length, customAgentLoop: false, externalModelCalls: 0 };
  });
  await check('context replacement retains raw evidence', async () => {
    memory.version = 2; memory.content = 'memory-v2: detailed replies';
    await turn(companion, 'second companion input');
    const latest = requests.filter(request => request.sessionId === companion.agent.id).at(-1);
    assert.ok(allText(latest.messages).includes('memory-v2'));
    assert.ok(!allText(latest.messages).includes('memory-v1'));
    const log = await root.sessionQuery.readSession(companion.agent.id);
    assert.ok(log.events.some(event => event.type === 'user/message' && textOf(event.data).includes('memory-v1')));
    assert.ok(log.events.some(event => event.surfaceOp?.op === 'replace'));
    assert.equal(root.sessionProjections.stateOf(companion.agent.session, projectionKey).version, 2);
    return { oldSnapshotRetained: true, oldSnapshotInContext: false };
  });
  await check('dedicated ID in shared store remains listed and searchable', async () => {
    assert.ok((await root.sessionQuery.listSessions()).some(record => record.header.id === companion.agent.id));
    assert.ok(JSON.stringify(await root.sessionQuery.searchSessions({ query: 'companion', limit: 10 })).includes(companion.agent.id));
    return { hidden: false, listed: true, searchable: true, workspaceAttached: root.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(companion.agent.id)) };
  });
  await check('archive rejects a running companion', async () => {
    const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; gates.set(companion.agent.id, gate);
    const running = turn(companion, 'third companion input');
    await bounded(gate.entered.promise, 'synthetic model entry');
    try { await assert.rejects(root.workspaceRegistry.archiveSession(companion.agent.id), error => error.name === 'WorkspaceActiveSessionError'); }
    finally { gate.release.resolve(); gates.delete(companion.agent.id); await running; }
    return { archiveIsVisibilityOnly: false };
  });
  await check('surface summary + JSONL restore + projection rebuild', async () => {
    const history = await root.sessionQuery.readSession(companion.agent.id);
    const target = history.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user');
    companion.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'synthetic summary of first input' }], source: { kind: 'liveseed-probe-summary' } }), {
      surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq }, sourceEventSeqs: [target.seq],
    });
    const before = structuredClone(companion.agent.session.deriveMessages());
    const beforeState = structuredClone(root.sessionProjections.stateOf(companion.agent.session, projectionKey));
    await root.sessions.flush(companion.agent.session);
    await companion.dispose(); await ordinary.dispose(); await root.fiber.dispose();
    const restoredRoot = newRoot(); await mountRuntime(restoredRoot, 'ordinary');
    const restored = await restoredRoot.agents.resume({ resumeSessionId: SessionId('probe-companion'), setup: setupFor(restoredRoot, memory) });
    assert.deepEqual(restored.agent.session.deriveMessages(), before);
    assert.deepEqual(restoredRoot.sessionProjections.stateOf(restored.agent.session, projectionKey), beforeState);
    assert.ok(!allText(before).includes('first companion input'));
    assert.ok((await restoredRoot.sessionQuery.readSession(restored.agent.id)).events.some(event => event.type === 'user/message' && textOf(event.data).includes('first companion input')));
    await turn(restored, 'fourth companion input after restore');
    assert.ok(allText(requests.at(-1).messages).includes('memory-v2'));
    assert.equal(requests.at(-1).messages.filter(message => message.source?.kind === sourceKind).length, 1);
    await restoredRoot.sessions.flush(restored.agent.session);
    return { exactSurfaceRestored: true, projectionRebuiltFromLog: true, automaticCompactionAlgorithmTested: false };
  });
  await check('same process with separate native containers excludes companion from ordinary corpus', async () => {
    const host = newRoot(), inner = newRoot();
    await mountRuntime(host, 'container-host'); await mountRuntime(inner, 'container-companion');
    let hostEvents = 0; host.on('session/event', () => { hostEvents += 1; });
    host.effect(() => () => inner.fiber.dispose());
    const handle = await inner.agents.create(optionsFor('probe-private-companion'));
    await turn(handle, 'private companion marker'); await inner.sessions.flush(handle.agent.session);
    assert.equal(host.sessions.get(handle.agent.id), undefined);
    assert.equal(host.agents.get(handle.agent.id), undefined);
    assert.ok(!(await host.sessionPersistence.list()).some(record => record.header.id === handle.agent.id));
    assert.ok(!(await host.sessionQuery.listSessions()).some(record => record.header.id === handle.agent.id));
    assert.ok(!JSON.stringify(await host.sessionQuery.searchSessions({ query: 'companion', limit: 10 })).includes(handle.agent.id));
    assert.equal(hostEvents, 0);
    assert.ok((await inner.sessionQuery.listSessions()).some(record => record.header.id === handle.agent.id));
    await host.fiber.dispose(); assert.equal(inner.registry.size, 0);
    return { sameProcess: true, nativeLogAndLoop: true, ordinaryCorpusContainsCompanion: false, uiEndToEndTested: false, permissionsBridgeImplemented: false };
  });
  const realmHost = newRoot(); await mountRuntime(realmHost, 'realm-host');
  let realm = realmHost;
  for (const key of ['sessions', 'sessionPersistence', 'sessionProjections', 'systemPrompt', 'llm', 'tools', 'agents', 'agentLoop', 'sessionQuery']) realm = realm.isolate(key);
  try {
    await realm.plugin({ name: 'probe-realm', async apply(ctx) { realm = ctx; await mountRuntime(ctx, 'realm-companion'); } });
    let handle;
    await realm.plugin({ inject: ['agents', 'sessions', 'sessionProjections', 'llm', 'tools', 'systemPrompt'], async apply(ctx) { handle = await ctx.agents.create(optionsFor('probe-scoped-companion')); } });
    await turn(handle, 'realm companion input');
    results.push({ name: 'direct ctx.isolate full native stack', status: 'passed', note: 'Corpus exclusion still needs verification.' });
  } catch (error) {
    assert.match(error.message, /sessionProjections.*without inject/);
    results.push({ name: 'direct ctx.isolate full native stack', status: 'blocked', error: error.message, hostPatched: false });
    console.log(`BLOCKED direct ctx.isolate: ${error.message}`);
  }
} catch (error) {
  finalError = error; results.push({ name: 'unexpected experiment failure', status: 'failed', error: error.stack });
} finally {
  for (const gate of gates.values()) gate.release.resolve();
  for (const ctx of roots.reverse()) await bounded(ctx.fiber.dispose(), 'runtime disposal').catch(error => { finalError ??= error; errors.push(error.message); });
  await writeFile(join(runRoot, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), runRoot, hostRoot, evidence, results, modelCalls: requests.length, externalModelCalls: 0, errors }, null, 2));
  await writeFile(join(runRoot, 'requests.json'), JSON.stringify(requests, null, 2));
  console.log(`Report: ${join(runRoot, 'report.json')}`);
  if (finalError) { console.error(finalError); process.exitCode = 1; }
}
