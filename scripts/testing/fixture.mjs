import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export class FixtureAdapter extends LlmAdapter {
  requests = [];
  async resolveModel(provider, model) { return { provider, id: model, name: '本地验收模型', context: { contextWindow: 8192 }, inputModalities: ['text'] }; }
  async *stream(options) {
    this.requests.push(options);
    if (options.purpose === 'compaction') {
      const latest = [...options.messages].reverse().find(message => message.source?.kind === 'liveseed-user');
      const pending = latest?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
      const text = `前文已收拢；具体经历仍可按原始来源查询。\n待回应的用户原话：${pending}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' }; return;
    }
    if (options.messages.some(message => message.source?.kind === 'liveseed-memory-task')) {
      let baseVersion = 0;
      for (const message of options.messages) for (const block of message.content) if (block.type === 'text') for (const line of block.text.split('\n')) {
        try { const value = JSON.parse(line); if (value.job && typeof value.baseVersion === 'number') baseVersion = value.baseVersion; } catch {}
      }
      const text = JSON.stringify({ baseVersion, mutations: [], reply: '这次整理已完成。' });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' }; return;
    }
    const input = [...options.messages].reverse().find(message => message.source?.kind === 'liveseed-user');
    const checkpoint = [...options.messages].reverse().flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('待回应的用户原话：'));
    const recovered = checkpoint?.type === 'text' ? checkpoint.text.split('待回应的用户原话：').at(-1).split('\n')[0] : '';
    const text = input?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? recovered;
    if (text === '[fail]') throw new Error('Synthetic model failure');
    const latestDialogue = [...options.messages].reverse().find(message => message.role === 'tool' || message.role === 'assistant' || message.source?.kind === 'liveseed-user');
    if (text === '[tools]' && latestDialogue?.role !== 'tool') {
      const block = { type: 'tool-call', id: 'ungranted-call', name: 'read', arguments: '{"path":"not-a-real-path"}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: 'tool-calls' }; return;
    }
    const answer = text === '[tools]' ? '我没有调用任何外部工具。' : `我在。你刚才说：“${text}”。`;
    if (text.includes('红茶')) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: 'synthetic-provider-reasoning' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'synthetic-provider-reasoning' } };
    }
    const textIndex = text.includes('红茶') ? 1 : 0;
    yield { type: 'block-start', index: textIndex, blockType: 'text' };
    for (const part of answer) {
      await delay(text.includes('停一下') ? 50 : 3, undefined, { signal: options.signal });
      yield { type: 'text-delta', index: textIndex, text: part };
    }
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: answer } };
    yield { type: 'finish', reason: 'stop' };
  }
}
