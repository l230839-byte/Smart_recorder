import { readFile } from 'node:fs/promises';
import type { ProviderRateInfo } from '@shared/models';
import type { ChunkSegment } from '@shared/transcript';
import { ProviderError, type TranscribeRequest, type TranscribeResult, type TranscriptionProvider } from './types';

interface VerboseSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
  avg_logprob?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Converts Whisper's response. Fields are checked, not assumed, because free services change. */
export function parseVerboseJson(body: unknown, durationMs: number): { language: string | null; segments: ChunkSegment[] } {
  if (typeof body !== 'object' || body === null) throw new ProviderError('server', 'The transcription service returned an unexpected response.');
  const data = body as { text?: unknown; language?: unknown; segments?: unknown };
  const language = typeof data.language === 'string' ? data.language : null;
  if (Array.isArray(data.segments)) {
    const segments = (data.segments as VerboseSegment[]).flatMap((s): ChunkSegment[] => {
      const start = num(s.start);
      const end = num(s.end);
      if (start === null || end === null || typeof s.text !== 'string') return [];
      const logprob = num(s.avg_logprob);
      return [{ startMs: start * 1000, endMs: end * 1000, text: s.text, speaker: null, confidence: logprob === null ? null : Math.exp(logprob) }];
    });
    if (segments.length || (data.segments as unknown[]).length === 0) return { language, segments };
  }
  // Some compatible services return only text. The transcript is real but has one timestamp.
  if (typeof data.text === 'string') {
    return { language, segments: data.text.trim() ? [{ startMs: 0, endMs: durationMs, text: data.text, speaker: null, confidence: null }] : [] };
  }
  throw new ProviderError('server', 'The transcription service returned an unexpected response.');
}

/** "2m59.56s", "7.66s" or a number of seconds. */
export function parseWait(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?$/.exec(value.trim());
  if (!match || !value.trim()) return null;
  const [, h, m, s, ms] = match;
  return Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000 + Number(ms ?? 0);
}

function rateFromHeaders(headers: Headers): ProviderRateInfo | null {
  const remaining = headers.get('x-ratelimit-remaining-requests');
  const limit = headers.get('x-ratelimit-limit-requests');
  if (remaining === null && limit === null) return null;
  return { remainingRequests: remaining === null ? null : Number(remaining), limitRequests: limit === null ? null : Number(limit), resetsInMs: parseWait(headers.get('x-ratelimit-reset-requests')) };
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? body.error.message : '';
  } catch {
    return '';
  }
}

/** Maps a failed response to what EchoMind should do about it. */
export async function toProviderError(response: Response): Promise<ProviderError> {
  const detail = await errorText(response);
  const status = response.status;
  if (status === 401 || status === 403) return new ProviderError('auth', 'The service rejected the API key. Check it in Settings.');
  if (status === 429) {
    const wait = parseWait(response.headers.get('retry-after'));
    const quota = /per day|daily|quota|exceeded your/i.test(detail) || (wait !== null && wait > 10 * 60_000);
    return new ProviderError(quota ? 'quota' : 'rate', quota ? 'The free limit for this service has been reached.' : 'The service asked EchoMind to slow down.', wait);
  }
  if (status === 413) return new ProviderError('rejected', 'This piece of audio is larger than the service accepts.');
  if (status === 404) return new ProviderError('rejected', 'The service does not recognize this model or address. Check Settings.');
  if (status >= 500) return new ProviderError('server', 'The transcription service is having problems.', parseWait(response.headers.get('retry-after')));
  return new ProviderError('rejected', detail ? `The service refused this request: ${detail.slice(0, 200)}` : `The service refused this request (HTTP ${status}).`);
}

/** Any OpenAI-compatible transcription endpoint, such as Groq or a self-hosted Whisper server. */
export class WhisperHttpProvider implements TranscriptionProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ProviderError('network', 'Could not reach the transcription service. Check your internet connection.');
    }
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    const form = new FormData();
    // Pieces are small (minutes of speech audio), so memory stays modest.
    form.set('file', new File([await readFile(request.filePath)], request.fileName, { type: request.mime }));
    form.set('model', request.model);
    form.set('response_format', 'verbose_json');
    form.set('timestamp_granularities[]', 'segment');
    if (request.language) form.set('language', request.language);

    // Encoded up front: passing FormData directly uses an internal stream that throws an unhandled error when canceled.
    const encoded = new Response(form);
    const contentType = encoded.headers.get('content-type')!;
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const response = await this.send(`${this.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { ...this.headers(), 'content-type': contentType }, body: bytes, signal: request.signal });
    if (!response.ok) throw await toProviderError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError('server', 'The transcription service returned an unexpected response.');
    }
    return { ...parseVerboseJson(body, request.durationMs), rate: rateFromHeaders(response.headers) };
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    const response = await this.send(`${this.baseUrl}/models`, { headers: this.headers(), signal });
    if (!response.ok) throw await toProviderError(response);
  }
}
