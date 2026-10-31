import type { ProviderRateInfo } from '@shared/models';
import type { ChatMessage } from '@shared/summaries';
import type { ChunkSegment } from '@shared/transcript';

export type ProviderErrorKind =
  /** The key is wrong or lacks access. Retrying cannot help until the user acts. */
  | 'auth'
  /** Too many requests right now. Wait as long as the provider says. */
  | 'rate'
  /** A daily or plan limit. Same handling, with a clearer message. */
  | 'quota'
  /** The provider or the connection had a problem. Back off and retry. */
  | 'network'
  | 'server'
  /** The request itself is unacceptable. Retrying the same thing cannot help. */
  | 'rejected'
  /** The piece is too big for this service or plan. A smaller one may work. */
  | 'too-large';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface TranscribeRequest {
  filePath: string;
  fileName: string;
  mime: string;
  durationMs: number;
  model: string;
  /** Null lets the provider detect the language. */
  language: string | null;
  signal: AbortSignal;
}

export interface TranscribeResult {
  language: string | null;
  segments: ChunkSegment[];
  rate: ProviderRateInfo | null;
}

/** Every transcription service implements this, so any provider can be swapped (prompt §0). */
export interface TranscriptionProvider {
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  /** Checks the key with a harmless request. Sends no audio. */
  testConnection(signal: AbortSignal): Promise<void>;
}

export type ChatTask = 'summary' | 'chapters' | 'suggest';

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  maxOutputTokens: number;
  /** Ask for a JSON reply. The prompt must also say so, which some services require. */
  json: boolean;
  signal: AbortSignal;
  /** What this is for. Real models read the prompt; the demo model uses this to choose its reply. */
  task: ChatTask;
}

export interface ChatResult {
  text: string;
  /** The reply stopped at the length limit, so it may be cut off. */
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  rate: ProviderRateInfo | null;
}

export interface ChatProvider {
  complete(request: ChatRequest): Promise<ChatResult>;
  testConnection(signal: AbortSignal): Promise<void>;
}
