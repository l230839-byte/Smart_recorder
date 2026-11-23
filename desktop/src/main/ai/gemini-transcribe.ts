import { readFile } from 'node:fs/promises';
import type { ChunkSegment } from '@shared/transcript';
import { ProviderError, type TranscribeRequest, type TranscribeResult, type TranscriptionProvider } from './types';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS, toProviderError } from './whisper-http';

interface WordInfo {
  type?: unknown;
  text?: unknown;
  start_index?: unknown;
  end_index?: unknown;
  start_offset?: unknown;
  end_offset?: unknown;
  speaker?: unknown;
}

interface Word {
  startMs: number;
  endMs: number;
  speaker: string | null;
  /** Where the word sits in the full text, so segments keep the model's punctuation and spacing. */
  from: number;
  to: number;
}

/** A new segment starts after a pause this long at the end of a sentence… */
const SENTENCE_PAUSE_MS = 700;
/** …or at any sentence end once a segment is this long, so lines stay easy to read and cite. */
const SOFT_MAX_MS = 20_000;
/** A run-on with no sentence end is still cut here. */
const HARD_MAX_MS = 40_000;

/** "1.5s", "3s" or a number of seconds, to milliseconds. */
function offsetMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value !== 'string') return null;
  const seconds = Number(value.replace(/s$/, ''));
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** "spk:0" → "Speaker A". Labels are per request, so they are only consistent within one piece. */
function speakerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = Number(/(\d+)\s*$/.exec(raw)?.[1]);
  return Number.isInteger(n) && n >= 0 && n < 26 ? `Speaker ${String.fromCharCode(65 + n)}` : null;
}

/**
 * Turns Gemini's per-word timing into transcript lines. Lines break at a change of speaker, at a sentence
 * end after a pause, and at sentence ends once a line grows long. Times come from the audio itself
 * (word_info annotations), not from text the model wrote.
 */
export function parseGeminiTranscript(body: unknown, durationMs: number): ChunkSegment[] {
  if (typeof body !== 'object' || body === null) throw new ProviderError('server', 'The transcription service returned an unexpected response.');
  const data = body as { status?: unknown; steps?: { type?: unknown; content?: { type?: unknown; text?: unknown; annotations?: WordInfo[] }[] }[] };
  if (data.status !== undefined && data.status !== 'completed') throw new ProviderError('server', 'The transcription did not finish. EchoMind will try again.');
  const segments: ChunkSegment[] = [];
  for (const step of data.steps ?? []) {
    for (const content of step.content ?? []) {
      const text = typeof content.text === 'string' ? content.text : '';
      if (!text.trim()) continue;
      const words: Word[] = (content.annotations ?? []).flatMap((a): Word[] => {
        if (a.type !== 'word_info') return [];
        const startMs = offsetMs(a.start_offset);
        const endMs = offsetMs(a.end_offset);
        const from = typeof a.start_index === 'number' ? a.start_index : null;
        const to = typeof a.end_index === 'number' ? a.end_index : null;
        if (startMs === null || endMs === null || from === null || to === null) return [];
        return [{ startMs, endMs: Math.max(startMs, endMs), speaker: speakerName(a.speaker), from, to }];
      });
      if (!words.length) {
        // Text with no timing: real words, but only one timestamp for the whole piece.
        segments.push({ startMs: 0, endMs: durationMs, text: text.trim(), speaker: null, confidence: null });
        continue;
      }
      let line: Word[] = [];
      const flush = () => {
        if (!line.length) return;
        const first = line[0]!;
        const last = line[line.length - 1]!;
        const lineText = text.slice(first.from, last.to).trim();
        if (lineText) segments.push({ startMs: first.startMs, endMs: last.endMs, text: lineText, speaker: first.speaker, confidence: null });
        line = [];
      };
      for (const word of words) {
        const prev = line[line.length - 1];
        if (prev) {
          const sentenceEnd = /[.!?…؟۔।。]["'”’)]*$/.test(text.slice(prev.from, prev.to));
          const length = prev.endMs - line[0]!.startMs;
          const pause = word.startMs - prev.endMs;
          if (word.speaker !== prev.speaker || (sentenceEnd && (pause >= SENTENCE_PAUSE_MS || length >= SOFT_MAX_MS)) || length >= HARD_MAX_MS) flush();
        }
        line.push(word);
      }
      flush();
    }
  }
  // Times are clamped to the piece, so a model's rounding can never place a line outside it.
  return segments.map((s) => ({ ...s, startMs: Math.min(Math.max(0, s.startMs), durationMs), endMs: Math.min(Math.max(s.startMs, s.endMs), durationMs) }));
}

/**
 * Google's dedicated transcription model, through the Gemini API's Interactions endpoint. It returns word
 * timings from the audio and tells speakers apart, which Whisper services do not. Checked live on
 * 2026-11-23: inline Ogg/Opus accepted; two voices separated at the right word.
 */
export class GeminiTranscribeProvider implements TranscriptionProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  private send(url: string, init: RequestInit): Promise<Response> {
    if (!this.apiKey) throw new ProviderError('auth', 'Add your Gemini key in Settings > AI providers.');
    return fetchWithTimeout(this.fetchFn, url, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-goog-api-key': this.apiKey } }, this.timeoutMs, 'Could not reach the transcription service. Check your internet connection.');
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    // Pieces are at most 10 minutes of 32 kbps speech (about 2.4 MB), well inside a single request.
    const audio = (await readFile(request.filePath)).toString('base64');
    const body = {
      model: request.model,
      input: [{ type: 'audio', data: audio, mime_type: request.mime }],
      generation_config: {
        transcription_config: {
          ...(request.language ? { language_codes: [request.language] } : {}),
          mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] },
        },
      },
    };
    const response = await this.send(`${this.baseUrl}/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal });
    if (!response.ok) throw await toProviderError(response);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError('server', 'The transcription service returned an unexpected response.');
    }
    return { language: request.language, segments: parseGeminiTranscript(data, request.durationMs), rate: null };
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    const response = await this.send(`${this.baseUrl}/models/${encodeURIComponent('gemini-3.5-transcribe')}`, { signal });
    if (!response.ok) throw await toProviderError(response);
  }
}
