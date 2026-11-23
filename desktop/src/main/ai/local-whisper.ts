import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { ChunkSegment } from '@shared/transcript';
import { ProviderError, type TranscribeRequest, type TranscribeResult, type TranscriptionProvider } from './types';

/** whisper-cli's JSON (-oj): segments with offsets in milliseconds, and the detected language. */
export function parseWhisperCppJson(body: unknown, durationMs: number): { language: string | null; segments: ChunkSegment[] } {
  if (typeof body !== 'object' || body === null) throw new ProviderError('server', 'Offline transcription produced no readable result.');
  const data = body as { result?: { language?: unknown }; transcription?: { offsets?: { from?: unknown; to?: unknown }; text?: unknown }[] };
  const language = typeof data.result?.language === 'string' ? data.result.language : null;
  const segments = (data.transcription ?? []).flatMap((s): ChunkSegment[] => {
    const from = s.offsets?.from;
    const to = s.offsets?.to;
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    // Whisper writes non-speech as bracketed tags, such as [BLANK_AUDIO] or [Music]; they are not words.
    if (typeof from !== 'number' || typeof to !== 'number' || !text || /^[[(][^\])]*[\])]$/.test(text)) return [];
    const startMs = Math.min(Math.max(0, from), durationMs);
    return [{ startMs, endMs: Math.min(Math.max(startMs, to), durationMs), text, speaker: null, confidence: null }];
  });
  return { language, segments };
}

/**
 * Transcribes on this computer with whisper.cpp. Nothing is sent anywhere: the piece (16 kHz WAV) and the
 * model are local files, and the result comes back as a JSON file beside the piece.
 */
export class LocalWhisperProvider implements TranscriptionProvider {
  constructor(
    private readonly cliPath: string,
    private readonly modelPath: (model: string) => string | null,
    private readonly threads: number,
  ) {}

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    const model = this.modelPath(request.model);
    if (!existsSync(this.cliPath)) throw new ProviderError('rejected', 'Offline transcription is not installed in this copy of EchoMind.');
    if (!model || !existsSync(model)) throw new ProviderError('rejected', 'Download the offline model first, in Settings > AI providers.');
    const outBase = request.filePath.replace(/\.[^.\\/]+$/, '');
    const args = ['-m', model, '-f', request.filePath, '-l', request.language ?? 'auto', '-t', String(this.threads), '-oj', '-of', outBase, '-np'];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.cliPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      const onAbort = () => child.kill();
      request.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => reject(new ProviderError('rejected', 'Offline transcription could not start on this computer.')));
      child.on('close', (code) => {
        request.signal.removeEventListener('abort', onAbort);
        if (request.signal.aborted) reject(new DOMException('Canceled', 'AbortError'));
        else if (code === 0) resolve();
        // Out of memory is the usual reason a large model fails on a smaller computer.
        else reject(new ProviderError('rejected', /alloc|memory/i.test(stderr) ? 'This computer ran out of memory for this model. Choose a smaller one in Settings > AI providers.' : `Offline transcription stopped unexpectedly (code ${code}).`));
      });
    });
    const json = `${outBase}.json`;
    try {
      const parsed = parseWhisperCppJson(JSON.parse(await readFile(json, 'utf8')), request.durationMs);
      return { ...parsed, rate: null };
    } finally {
      await rm(json, { force: true });
    }
  }

  async testConnection(): Promise<void> {
    if (!existsSync(this.cliPath)) throw new Error('Offline transcription is not installed in this copy of EchoMind.');
  }
}
