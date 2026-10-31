import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings, TranscribeOutcome } from '@shared/models';
import { MAX_CHUNK_MS, PROVIDER_INFO, type TranscriptionProviderId } from '@shared/providers';
import { mergeChunks, planChunks } from '@shared/transcript';
import type { TranscriptionProvider } from '../ai/types';
import type { LibraryRepository } from '../db/library';
import type { ConsentRepository, JobRepository, SecretStore, StoredJob, TranscriptRepository, UsageRepository } from '../db/transcripts';
import { JobQueue, type JobHandler } from './job-queue';

export { backoffMs } from './job-queue';

export interface TranscriptionDeps {
  jobs: JobRepository;
  transcripts: TranscriptRepository;
  library: LibraryRepository;
  usage: UsageRepository;
  consents: ConsentRepository;
  secrets: SecretStore;
  settings: () => Settings;
  makeProvider: (id: TranscriptionProviderId) => TranscriptionProvider;
  /** Encodes one piece of the recording as small speech audio at this path. */
  prepareChunk: (recordingId: string, startMs: number, endMs: number, outputPath: string) => Promise<void>;
  tempDir: string;
  changed: () => void;
  transcriptReady: (recordingId: string, title: string) => void;
  now?: () => number;
  schedule?: (ms: number, run: () => void) => void;
  /** Shared when other kinds of job use the same queue. */
  queue?: JobQueue;
}

export function keyName(provider: string): string {
  return `provider-key:${provider}`;
}

/** Turns recordings into transcripts: the gate, the request, and the job itself. */
export class TranscriptionService implements JobHandler {
  readonly queue: JobQueue;

  constructor(private readonly deps: TranscriptionDeps) {
    this.queue = deps.queue ?? new JobQueue(deps.jobs, deps.changed, { now: deps.now, schedule: deps.schedule });
    this.queue.register('transcribe', this);
  }

  /** The privacy gate. Nothing can reach a provider without passing it, at request time and again at run time. */
  blockedBy(provider: TranscriptionProviderId): Exclude<TranscribeOutcome, { ok: true }> | null {
    const info = PROVIDER_INFO[provider];
    if (info.local) return null;
    if (this.deps.settings().offlineOnly) return { ok: false, reason: 'offline-only', provider, purpose: 'audio' };
    if (provider === 'custom' && !this.deps.settings().customBaseUrl) return { ok: false, reason: 'needs-setup', provider, purpose: 'audio' };
    if (info.needsKey && !this.deps.secrets.has(keyName(provider))) return { ok: false, reason: 'needs-setup', provider, purpose: 'audio' };
    if (!this.deps.consents.has(provider)) return { ok: false, reason: 'needs-consent', provider, purpose: 'audio' };
    return null;
  }

  blocked(job: StoredJob): string | null {
    const blocked = this.blockedBy(job.provider as TranscriptionProviderId);
    if (!blocked) return null;
    return blocked.reason === 'offline-only' ? 'Offline only is on, so nothing was sent. Turn it off in Settings, then retry.' : 'This provider needs setup or your agreement before anything is sent. Retry from the recording.';
  }

  request(recordingId: string, language?: string): TranscribeOutcome {
    const { settings, library, jobs } = this.deps;
    const recording = library.getRecording(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    if (recording.deletedAt !== null) throw new Error('Restore this recording before transcribing it.');
    const active = jobs.activeFor(recordingId, 'transcribe');
    if (active) return { ok: true, jobId: active.id };

    const s = settings();
    const provider = s.transcriptionProvider;
    const blocked = this.blockedBy(provider);
    if (blocked) return blocked;
    const id = jobs.create(recordingId, provider, s.transcriptionModel ?? PROVIDER_INFO[provider].models[0]!, language ?? s.transcriptionLanguage);
    this.deps.changed();
    this.queue.pump();
    return { ok: true, jobId: id };
  }

  cancel(jobId: string): void {
    this.queue.cancel(jobId);
  }

  retry(jobId: string): void {
    this.queue.retry(jobId);
  }

  resume(): void {
    this.queue.resume();
  }

  pump(): void {
    this.queue.pump();
  }

  async run(job: StoredJob, signal: AbortSignal): Promise<void> {
    const { jobs, library, transcripts, usage } = this.deps;
    const recording = library.getRecording(job.recordingId);
    if (!recording) return;

    let chunkFile: string | null = null;
    try {
      const provider = this.deps.makeProvider(job.provider as TranscriptionProviderId);
      let chunks = jobs.chunks(job.id);
      if (chunks.length === 0) {
        jobs.addChunks(job.id, planChunks(recording.durationMs, library.peaks(recording.id), MAX_CHUNK_MS));
        chunks = jobs.chunks(job.id);
      }
      const totalMs = Math.max(1, recording.durationMs);
      const language = job.language === 'auto' ? null : job.language;

      for (const chunk of chunks) {
        if (chunk.segments) continue;
        const doneMs = chunks.filter((c) => c.segments).reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
        jobs.setRunning(job.id, chunks.length > 1 ? `Transcribing part ${chunk.idx + 1} of ${chunks.length}` : 'Transcribing', doneMs / totalMs);
        this.deps.changed();

        const durationMs = chunk.endMs - chunk.startMs;
        chunkFile = join(this.deps.tempDir, `${job.id}-${chunk.idx}.ogg`);
        await this.deps.prepareChunk(recording.id, chunk.startMs, chunk.endMs, chunkFile);
        if (signal.aborted) throw new DOMException('Canceled', 'AbortError');

        const result = await provider.transcribe({ filePath: chunkFile, fileName: `audio-${chunk.idx}.ogg`, mime: 'audio/ogg', durationMs, model: job.model, language, signal });
        usage.record(job.provider, 1, durationMs);
        if (result.rate) usage.saveRate(job.provider, result.rate);
        jobs.saveChunk(job.id, chunk.idx, result.segments, result.language);
        chunk.segments = result.segments;
        chunk.language = result.language;
        await rm(chunkFile, { force: true });
        chunkFile = null;
      }

      const segments = mergeChunks(chunks.map((c) => ({ startMs: c.startMs, segments: c.segments ?? [] })));
      if (segments.length === 0) {
        jobs.setFailed(job.id, 'No speech was found in this recording.', false);
        return;
      }
      transcripts.addOriginal(recording.id, job.provider, job.model, chunks.find((c) => c.language)?.language ?? language, segments);
      jobs.setDone(job.id);
      this.deps.transcriptReady(recording.id, recording.title);
    } finally {
      if (chunkFile) await rm(chunkFile, { force: true }).catch(() => undefined);
    }
  }
}
