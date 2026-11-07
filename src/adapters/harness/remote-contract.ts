import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol';
import type { CompanionCatalog, FollowFrame, SessionView, ViewRequest } from '../../core/protocol.js';

export const viewRequest = z.object({ sessionId: z.string().min(1).max(160), limit: z.number().int().min(1).max(2000).optional() }).strict();
export const sendRequest = z.object({ sessionId: z.string().min(1).max(160), requestId: z.string().uuid(), text: z.string().trim().min(1).max(6000) }).strict();
export const createMemoryRequest = z.object({ requestId: z.string().uuid(), title: z.string().trim().min(1).max(80) }).strict();
export const selectMemoryRequest = z.object({ sessionId: z.string().min(1).max(160), expectedSessionId: z.string().min(1).max(160) }).strict();
const chatMessage = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), at: z.number() });
const liveState = z.object({ generation: z.string(), revision: z.number(), running: z.boolean(), configured: z.boolean(), liveText: z.string(), notice: z.string().nullable() });
const stateSchema = liveState.extend({ sessionId: z.string(), readOnly: z.boolean(), messages: z.array(chatMessage) });
const catalogSchema = z.object({ generation: z.string(), activeSessionId: z.string(), memorySessionId: z.string(),
  filePaths: z.object({ soul: z.string(), narrative: z.string() }),
  memorySessions: z.array(z.object({ id: z.string(), title: z.string(), active: z.boolean(), running: z.boolean() })),
  sessions: z.array(z.object({ id: z.string(), kind: z.enum(['chat', 'memory']), title: z.string(), day: z.string().nullable(), active: z.boolean(), running: z.boolean() })) });
const followSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), revision: z.number(), catalog: catalogSchema, view: stateSchema }),
  z.object({ type: z.literal('update'), revision: z.number(), catalog: catalogSchema.optional(), view: stateSchema.optional(), live: liveState.optional() }),
]);
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `liveseed.${name}`, create: () => schema });
const descriptor = (method: string, schema?: z.ZodType, result: z.ZodType = z.unknown(), stream = false): InvocationDescriptor => ({
  id: `dsh-liveseed:${method}`, namespace: 'liveseed', service: 'liveseed', method, invocation: { kind: 'direct' },
  parameters: schema ? [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}.request`, schema) }] : [],
  result: codec(`${method}.result`, result), ...(stream ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
});
export const descriptors: readonly InvocationDescriptor[] = [
  descriptor('catalog', undefined, catalogSchema), descriptor('snapshot', viewRequest, stateSchema),
  descriptor('send', sendRequest, z.object({ messageId: z.string(), sessionId: z.string() })),
  descriptor('stop', z.object({ sessionId: z.string() }).strict(), z.object({ stopped: z.boolean() })),
  descriptor('follow', viewRequest, followSchema, true),
  descriptor('createMemorySession', createMemoryRequest, z.object({ sessionId: z.string() })),
  descriptor('selectMemorySession', selectMemoryRequest, z.object({ sessionId: z.string() })),
];
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'liveseed/invalid': object; 'liveseed/not-found': object; 'liveseed/conflict': object; 'liveseed/unavailable': object }
  interface TypertRemoteMap {
    'liveseed/catalog': () => Promise<RemoteResult<CompanionCatalog>>;
    'liveseed/createMemorySession': (request: z.infer<typeof createMemoryRequest>) => Promise<RemoteResult<{ sessionId: string }>>;
    'liveseed/selectMemorySession': (request: z.infer<typeof selectMemoryRequest>) => Promise<RemoteResult<{ sessionId: string }>>;
    'liveseed/snapshot': (request: ViewRequest) => Promise<RemoteResult<SessionView>>;
    'liveseed/send': (request: z.infer<typeof sendRequest>) => Promise<RemoteResult<{ messageId: string; sessionId: string }>>;
    'liveseed/stop': (request: { sessionId: string }) => Promise<RemoteResult<{ stopped: boolean }>>;
    'liveseed/follow': (request: ViewRequest) => RemoteStreamHandle<FollowFrame, never>;
  }
  interface TypertRemoteNamespaceMap { liveseed: TypertRemoteNamespace<'liveseed'> }
}
