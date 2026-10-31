import type { ProviderRateInfo } from '@shared/models';
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
  | 'rejected';

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
