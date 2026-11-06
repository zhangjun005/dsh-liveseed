import { recordSchema, type Evidence, type Intent, type MemoryItem, type MemoryRecord, type MemoryState, type Proposal } from './schema.js';

export function emptyMemory(): MemoryState {
  return { version: 0, contextRevision: 0, evidence: new Map(), items: new Map(), intents: new Map(), handledIntents: new Set(), jobs: new Map(), accepted: new Set(), cancelled: new Set(), processed: new Set(),
    narrative: { text: '', evidence: [] }, chapter: { text: '', evidence: [] }, segments: [], replies: new Map(), soulCandidates: [], soulVersions: [] };
}
const validRefs = (state: MemoryState, refs: string[]): void => {
  if (refs.some(ref => !state.evidence.has(ref))) throw new Error('Unknown evidence reference.');
};
export function hiddenReferences(state: MemoryState, maintenance = false): Set<string> {
  const hidden = new Set([...state.items.values()].filter(item => item.state === 'denied' || (!maintenance && (item.state === 'quiet' || item.state === 'archived'))).flatMap(item => item.evidence));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of state.evidence.values()) if (!hidden.has(entry.ref) && entry.parents?.some(ref => hidden.has(ref))) { hidden.add(entry.ref); changed = true; }
  }
  return hidden;
}
function validatePassage(state: MemoryState, passage: { text: string; evidence: string[] } | undefined): void {
  if (!passage) return;
  validRefs(state, passage.evidence);
  if (passage.text.trim() && !passage.evidence.length) throw new Error('Narrative requires evidence.');
  const hidden = hiddenReferences(state);
  if (passage.evidence.some(ref => hidden.has(ref))) throw new Error('Passage includes withdrawn evidence.');
}
/** Pure fold. The adapter must durably append before publishing the returned state. */
export function foldMemory(previous: MemoryState, raw: MemoryRecord): MemoryState {
  const record = recordSchema.parse(raw);
  const state = structuredClone(previous);
  switch (record.type) {
    case 'soul':
      state.soulVersions.push({ text: record.text, at: record.at, source: record.source });
      break;
    case 'evidence':
      for (const item of record.items) {
        if (item.ref !== `${item.sessionId}:${item.seq}`) throw new Error('Evidence identity mismatch.');
        const prior = state.evidence.get(item.ref);
        if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw new Error('Evidence is immutable.');
        state.evidence.set(item.ref, item);
      }
      break;
    case 'intent':
      validRefs(state, record.intent.evidence);
      if (!state.intents.has(record.intent.id)) state.intents.set(record.intent.id, record.intent);
      break;
    case 'job':
      validRefs(state, record.job.refs);
      if (!state.jobs.has(record.job.id)) state.jobs.set(record.job.id, record.job);
      break;
    case 'cancelled':
      if (!state.jobs.has(record.id)) throw new Error('Unknown cancelled job.');
      if (!state.accepted.has(record.id)) state.cancelled.add(record.id);
      break;
    case 'segment':
      if (record.handoff) validRefs(state, record.handoff.map(entry => entry.ref));
      if (!state.segments.some(segment => segment.sessionId === record.sessionId)) state.segments.push({ sessionId: record.sessionId, day: record.day, ...(record.handoff ? { handoff: record.handoff } : {}) });
      break;
    case 'accepted': {
      if (state.accepted.has(record.id)) return previous;
      if (state.cancelled.has(record.id)) throw new Error('Cancelled memory job.');
      const job = state.jobs.get(record.id);
      if (!job) throw new Error('Commit has no durable job.');
      const proposal: Proposal = record.proposal;
      if (proposal.baseVersion !== state.version) throw new Error('Stale memory version.');
      for (const mutation of proposal.mutations) {
        if ('evidence' in mutation) {
          validRefs(state, mutation.evidence);
          const denied = hiddenReferences(state, true);
          if (mutation.evidence.some(ref => denied.has(ref))) throw new Error('Cannot reintroduce denied evidence.');
        }
        if (mutation.op === 'remember') {
          if (state.items.has(mutation.id)) throw new Error('Memory ID already exists.');
          state.items.set(mutation.id, { id: mutation.id, text: mutation.text, evidence: mutation.evidence, state: 'active', protected: false, version: state.version + 1 });
        } else {
          const item = state.items.get(mutation.id);
          if (!item) throw new Error('Unknown memory ID.');
          if (mutation.op === 'revise') {
            if (item.state === 'denied') throw new Error('Denied memories cannot be revised.');
            const temporary = [...state.intents.values()].some(intent => intent.kind === 'protect' && intent.expiresAt > record.at && intent.evidence.some(ref => item.evidence.includes(ref)));
            if ((item.protected || temporary) && item.evidence.some(ref => !mutation.evidence.includes(ref))) throw new Error('Cannot discard protected evidence.');
            state.items.set(item.id, { ...item, text: mutation.text, evidence: mutation.evidence, version: state.version + 1 });
          } else if (mutation.op === 'protect') {
            state.items.set(item.id, { ...item, protected: mutation.value, version: state.version + 1 });
          } else {
            const temporary = [...state.intents.values()].some(intent => intent.kind === 'protect' && intent.expiresAt > record.at && intent.evidence.some(ref => item.evidence.includes(ref)));
            if (mutation.state !== 'active' && (item.protected || temporary)) throw new Error('Memory is protected.');
            if (item.state === 'denied' && mutation.state !== 'denied') throw new Error('Denied memories require a separate authorization change.');
            state.items.set(item.id, { ...item, state: mutation.state, version: state.version + 1 });
          }
        }
      }
      // Changed or withdrawn evidence must not linger in an older readable passage.
      const changed = new Set(proposal.mutations.flatMap(mutation => mutation.op === 'revise' || mutation.op === 'state' ? previous.items.get(mutation.id)?.evidence ?? [] : []));
      for (const key of ['narrative', 'chapter'] as const) {
        validatePassage(state, proposal[key]);
        if (proposal[key]) state[key] = proposal[key];
        else if (changed.size > 0) state[key] = { text: '', evidence: [] };
      }
      if (proposal.soulCandidate) state.soulCandidates.push({ id: record.id, text: proposal.soulCandidate, at: record.at });
      if (job.kind === 'dialogue' && job.requestId) state.replies.set(job.requestId, { input: job.input, reply: proposal.reply ?? '这次整理已完成。', at: record.at });
      for (const ref of job.refs) state.processed.add(ref);
      for (const id of job.intentIds ?? []) state.handledIntents.add(id);
      if (proposal.mutations.some(mutation => mutation.op === 'revise' || mutation.op === 'state')) state.contextRevision++;
      state.accepted.add(record.id); state.version += 1;
      break;
    }
  }
  return state;
}

const tokens = (text: string): string[] => {
  const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words = normalized.split(/\s+/u).filter(Boolean);
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) ? [...word].flatMap((_, index, chars) => index + 1 < chars.length ? [chars.slice(index, index + 2).join('')] : []) : [word]))].slice(0, 80);
};
export function recall(state: MemoryState, query: string, options: { maintenance?: boolean; ids?: string[]; limit?: number; budget?: number; now?: number } = {}) {
  const hidden = hiddenReferences(state, options.maintenance);
  const terms = tokens(query);
  const items = [...state.items.values()].filter(item => (options.maintenance || item.state === 'active') && item.state !== 'denied' && !item.evidence.some(ref => hidden.has(ref)) && (!options.ids || options.ids.includes(item.id)));
  const ranked = items.map(item => ({ item, score: terms.reduce((sum, term) => sum + (item.text.toLocaleLowerCase().includes(term) ? 2 : 0), 0)
    + (item.protected ? 0.3 : 0) + ([...state.intents.values()].some(intent => intent.expiresAt > (options.now ?? Date.now()) && intent.evidence.some(ref => item.evidence.includes(ref))) ? 0.2 : 0) }))
    .filter(hit => options.ids || terms.length === 0 || hit.score >= 2).sort((a, b) => b.score - a.score || b.item.version - a.item.version);
  const result: { id: string; text: string; evidence: Pick<Evidence, 'ref' | 'at' | 'role' | 'text' | 'partial'>[] }[] = [];
  let remaining = Math.min(options.budget ?? 6000, 16000);
  for (const { item } of ranked.slice(0, Math.min(options.limit ?? 6, 16))) {
    const evidence = item.evidence.slice(0, 4).map(ref => state.evidence.get(ref)!).map(({ ref, at, role, text, partial }) => ({ ref, at, role, text: text.slice(0, 1500), ...(partial ? { partial } : {}) }));
    const hit = { id: item.id, text: item.text, evidence };
    const cost = JSON.stringify(hit).length;
    if (cost > remaining) continue;
    result.push(hit); remaining -= cost;
  }
  return result;
}
export function recentUnderstanding(state: MemoryState, now = Date.now()): Intent[] {
  const hidden = hiddenReferences(state);
  return [...state.intents.values()].filter(intent => intent.kind === 'understanding' && intent.expiresAt > now && !intent.evidence.some(ref => hidden.has(ref))).slice(-6);
}
