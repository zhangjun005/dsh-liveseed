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

export class CompanionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
