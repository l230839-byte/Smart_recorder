import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscribeOutcome } from '@shared/models';
import { MAX_CHUNK_MS, PROVIDER_INFO, type TranscriptionProviderId } from '@shared/providers';
import { mergeChunks, planChunks } from '@shared/transcript';
import { ProviderError, type TranscriptionProvider } from '../ai/types';
import type { ConsentRepository, JobRepository, SecretStore, StoredJob, TranscriptRepository, UsageRepository } from '../db/transcripts';
import type { LibraryRepository } from '../db/library';
import type { Settings } from '@shared/models';

const MAX_AUTO_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_RATE_WAIT_MS = 60_000;

/** How long to wait: what the provider said if it said, otherwise doubling with some randomness. */
export function backoffMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  if (retryAfterMs !== null) return retryAfterMs + 500;
  const exact = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(exact * (0.75 + random() * 0.5));
}

export interface TranscriptionDeps {
  jobs: JobRepository;
  transcripts: TranscriptRepository;
  library: LibraryRepository;
  usage: UsageRepository;
  consents: ConsentRepository;
  secrets: SecretStore;
  settings: () => Settings;
  makeProvider: (id: TranscriptionProviderId) => TranscriptionProvider;
  /** Encodes one piece of the recording as small speech audio. Returns the file name inside tempDir. */
  prepareChunk: (recordingId: string, startMs: number, endMs: number, outputPath: string) => Promise<void>;
  tempDir: string;
  changed: () => void;
  transcriptReady: (recordingId: string, title: string) => void;
  now?: () => number;
  schedule?: (ms: number, run: () => void) => void;
}

export function keyName(provider: TranscriptionProviderId): string {
  return `provider-key:${provider}`;
}

/**
 * The persistent transcription queue. One job runs at a time, to stay within free limits. Finished pieces
 * are stored as they complete, so nothing already paid for in quota is lost to a crash or a retry.
 */
export class TranscriptionService {
  private running: { id: string; controller: AbortController } | null = null;
  private wakeAt: number | null = null;
  private readonly now: () => number;
  private readonly schedule: (ms: number, run: () => void) => void;

  constructor(private readonly deps: TranscriptionDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((ms, run) => void setTimeout(run, ms));
  }

  /** The privacy gate. Nothing can reach a provider without passing it, at request time and again at run time. */
  blockedBy(provider: TranscriptionProviderId): Exclude<TranscribeOutcome, { ok: true }> | null {
    const info = PROVIDER_INFO[provider];
    if (info.local) return null;
    if (this.deps.settings().offlineOnly) return { ok: false, reason: 'offline-only', provider };
    if (provider === 'custom' && !this.deps.settings().customBaseUrl) return { ok: false, reason: 'needs-setup', provider };
    if (info.needsKey && !this.deps.secrets.has(keyName(provider))) return { ok: false, reason: 'needs-setup', provider };
    if (!this.deps.consents.has(provider)) return { ok: false, reason: 'needs-consent', provider };
    return null;
  }

  request(recordingId: string, language?: string): TranscribeOutcome {
    const { settings, library, jobs } = this.deps;
    const recording = library.getRecording(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    if (recording.deletedAt !== null) throw new Error('Restore this recording before transcribing it.');
    const active = jobs.activeFor(recordingId);
    if (active) return { ok: true, jobId: active.id };

    const s = settings();
    const provider = s.transcriptionProvider;
    const blocked = this.blockedBy(provider);
    if (blocked) return blocked;
    const id = jobs.create(recordingId, provider, s.transcriptionModel ?? PROVIDER_INFO[provider].models[0]!, language ?? s.transcriptionLanguage);
    this.deps.changed();
    this.pump();
    return { ok: true, jobId: id };
  }

  cancel(jobId: string): void {
    if (this.running?.id === jobId) this.running.controller.abort();
    this.deps.jobs.setCanceled(jobId);
    this.deps.changed();
  }

  retry(jobId: string): void {
    const job = this.deps.jobs.get(jobId);
    if (!job || job.status !== 'failed') return;
    this.deps.jobs.requeue(jobId);
    this.deps.changed();
    this.pump();
  }

  resume(): void {
    this.deps.jobs.requeueInterrupted();
    this.pump();
  }

  pump(): void {
    if (this.running) return;
    const job = this.deps.jobs.nextDue();
    if (job) {
      const controller = new AbortController();
      this.running = { id: job.id, controller };
      void this.run(job, controller.signal).finally(() => {
        this.running = null;
        this.deps.changed();
        this.pump();
      });
      return;
    }
    const next = this.deps.jobs.earliestWaiting();
    if (next !== null && this.wakeAt !== next) {
      this.wakeAt = next;
      this.schedule(Math.max(0, next - this.now()), () => {
        this.wakeAt = null;
        this.pump();
      });
    }
  }

  private async run(job: StoredJob, signal: AbortSignal): Promise<void> {
    const { jobs, library, transcripts, usage } = this.deps;
    const recording = library.getRecording(job.recordingId);
    if (!recording) return;

    const blocked = this.blockedBy(job.provider);
    if (blocked) {
      jobs.setFailed(job.id, blocked.reason === 'offline-only' ? 'Offline only is on, so nothing was sent. Turn it off in Settings, then retry.' : 'This provider needs setup or your agreement before anything is sent. Retry from the recording.', true);
      return;
    }

    let chunkFile: string | null = null;
    try {
      const provider = this.deps.makeProvider(job.provider);
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
    } catch (e) {
      if (chunkFile) await rm(chunkFile, { force: true }).catch(() => undefined);
      if (signal.aborted) return;
      this.handleFailure(job, e);
    }
  }

  private handleFailure(job: StoredJob, error: unknown): void {
    const { jobs } = this.deps;
    if (!(error instanceof ProviderError)) {
      jobs.setFailed(job.id, error instanceof Error ? error.message : String(error), true);
      return;
    }
    const attempts = job.attempts + 1;
    if (error.kind === 'auth' || error.kind === 'rejected') {
      jobs.setFailed(job.id, error.message, true);
      return;
    }
    if (error.kind === 'rate' || error.kind === 'quota') {
      // Limits reset by themselves, so these never use up the retry count.
      const wait = error.retryAfterMs ?? DEFAULT_RATE_WAIT_MS * (error.kind === 'quota' ? 30 : 1);
      jobs.setWaiting(job.id, `${error.message} Progress is saved, and EchoMind will continue on its own.`, this.now() + backoffMs(attempts, wait), job.attempts);
      return;
    }
    if (attempts >= MAX_AUTO_ATTEMPTS) {
      jobs.setFailed(job.id, `${error.message} EchoMind stopped after ${attempts} attempts. Progress is saved, so retrying continues from here.`, true);
      return;
    }
    jobs.setWaiting(job.id, `${error.message} Trying again soon. Progress is saved.`, this.now() + backoffMs(attempts, error.retryAfterMs), attempts);
  }
}
