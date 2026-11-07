import { z } from 'zod';

export const evidenceSchema = z.object({
  ref: z.string().min(1).max(180), sessionId: z.string().min(1).max(120), seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), text: z.string().max(100000),
  reasoning: z.string().max(200000).optional(), partial: z.boolean().optional(),
  parents: z.array(z.string()).max(8).optional(),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
const refs = z.array(z.string().min(1).max(180)).min(1).max(48);
export const mutationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remember'), id: z.string().min(1).max(120), text: z.string().min(1).max(3000), evidence: refs }).strict(),
  z.object({ op: z.literal('revise'), id: z.string().min(1).max(120), text: z.string().min(1).max(3000), evidence: refs }).strict(),
  z.object({ op: z.literal('state'), id: z.string().min(1).max(120), state: z.enum(['active', 'quiet', 'archived', 'denied']), reason: z.string().min(1).max(1000) }).strict(),
  z.object({ op: z.literal('protect'), id: z.string().min(1).max(120), value: z.boolean(), reason: z.string().min(1).max(1000) }).strict(),
]);
export const passageSchema = z.object({ text: z.string().max(14000), evidence: z.array(z.string()).max(64) }).strict();
export const proposalSchema = z.object({
  baseVersion: z.number().int().nonnegative(), mutations: z.array(mutationSchema).max(32),
  narrative: passageSchema.optional(), chapter: passageSchema.optional(),
  reply: z.string().max(12000).optional(), soulCandidate: z.string().max(12000).optional(),
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;
export const intentSchema = z.object({
  id: z.string().min(1).max(200), kind: z.enum(['important', 'protect', 'understanding']),
  evidence: refs, text: z.string().min(1).max(1800), at: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict();
export type Intent = z.infer<typeof intentSchema>;
export const jobSchema = z.object({ id: z.string().min(1), refs: z.array(z.string()).max(64), kind: z.enum(['incremental', 'reflection', 'dialogue']),
  workerSessionId: z.string().optional(),
  input: z.string().max(6000), at: z.number().int().nonnegative(), requestId: z.string().optional(), intentIds: z.array(z.string()).max(32).optional() }).strict();
export type MemoryJob = z.infer<typeof jobSchema>;
export const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('worker-created'), sessionId: z.string().regex(/^liveseed-memory-[0-9a-f-]{36}$/), title: z.string().min(1).max(80), at: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('worker-selected'), sessionId: z.string(), previousSessionId: z.string(), at: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('soul'), text: z.string().max(1000000), at: z.number().int().nonnegative(), source: z.literal('stateDir/soul.md') }).strict(),
  z.object({ type: z.literal('evidence'), items: z.array(evidenceSchema).max(128) }).strict(),
  z.object({ type: z.literal('intent'), intent: intentSchema }).strict(),
  z.object({ type: z.literal('job'), job: jobSchema }).strict(),
  z.object({ type: z.literal('cancelled'), id: z.string(), at: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('accepted'), id: z.string(), at: z.number().int().nonnegative(), proposal: proposalSchema }).strict(),
  z.object({ type: z.literal('segment'), sessionId: z.string(), day: z.string(), handoff: z.array(z.object({ ref: z.string(), role: z.enum(['user', 'assistant']), text: z.string().max(1600) }).strict()).max(8).optional() }).strict(),
]);
export type MemoryRecord = z.infer<typeof recordSchema>;
export interface MemoryItem { id: string; text: string; evidence: string[]; state: 'active' | 'quiet' | 'archived' | 'denied'; protected: boolean; version: number }
export interface MemoryState {
  workerSessions: { id: string; title: string; at: number }[]; activeWorkerSessionId: string;
  version: number; contextRevision: number; evidence: Map<string, Evidence>; items: Map<string, MemoryItem>; intents: Map<string, Intent>; handledIntents: Set<string>;
  jobs: Map<string, MemoryJob>; accepted: Set<string>; cancelled: Set<string>; processed: Set<string>;
  narrative: z.infer<typeof passageSchema>; chapter: z.infer<typeof passageSchema>;
  segments: { sessionId: string; day: string; handoff?: { ref: string; role: 'user' | 'assistant'; text: string }[] }[]; replies: Map<string, { input: string; reply: string; at: number }>;
  soulCandidates: { id: string; text: string; at: number }[];
  soulVersions: { text: string; at: number; source: string }[];
}
