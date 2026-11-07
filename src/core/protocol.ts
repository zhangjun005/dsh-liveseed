export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface CompanionState {
  generation: string;
  revision: number;
  running: boolean;
  configured: boolean;
  messages: ChatMessage[];
  liveText: string;
  notice: string | null;
}

export interface SendRequest {
  requestId: string;
  text: string;
}

export interface CompanionSession {
  id: string;
  kind: 'chat' | 'memory';
  title: string;
  day: string | null;
  active: boolean;
  running: boolean;
}
export interface CompanionCatalog {
  generation: string;
  activeSessionId: string;
  memorySessionId: string;
  memorySessions: { id: string; title: string; active: boolean; running: boolean }[];
  filePaths: { soul: string; narrative: string };
  sessions: CompanionSession[];
}
export interface SessionView extends CompanionState { sessionId: string; readOnly: boolean }
export interface ViewRequest { sessionId: string; limit?: number }
export type FollowFrame = {
  type: 'baseline'; revision: number; catalog: CompanionCatalog; view: SessionView;
} | {
  type: 'update'; revision: number; catalog?: CompanionCatalog; view?: SessionView;
  live?: Omit<SessionView, 'messages' | 'sessionId' | 'readOnly'>;
};

export class CompanionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
