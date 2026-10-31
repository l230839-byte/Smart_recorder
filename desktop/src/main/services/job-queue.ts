import type { JobKind } from '@shared/models';
import { ProviderError } from '../ai/types';
import type { JobRepository, StoredJob } from '../db/transcripts';

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

export interface JobHandler {
  /** Why this job may not run now, as a message. Checked again just before any data could leave. */
  blocked(job: StoredJob): string | null;
  run(job: StoredJob, signal: AbortSignal): Promise<void>;
}

/**
 * The persistent AI queue shared by every kind of job. One runs at a time, to stay within free limits.
 * Handlers store finished pieces as they go, so a crash or retry never repeats paid-for work.
 */
export class JobQueue {
  private running: { id: string; controller: AbortController } | null = null;
  private wakeAt: number | null = null;
  private stopped = false;
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly now: () => number;
  private readonly schedule: (ms: number, run: () => void) => void;

  constructor(
    private readonly jobs: JobRepository,
    private readonly changed: () => void,
    options: { now?: () => number; schedule?: (ms: number, run: () => void) => void } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((ms, run) => void setTimeout(run, ms));
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  cancel(jobId: string): void {
    if (this.running?.id === jobId) this.running.controller.abort();
    this.jobs.setCanceled(jobId);
    this.changed();
  }

  /** A recording going to the trash or away for good must stop using the user's quota. */
  cancelForRecordings(recordingIds: string[]): void {
    for (const id of recordingIds) {
      for (const job of this.jobs.activeForRecording(id)) this.cancel(job.id);
    }
  }

  retry(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'failed') return;
    this.jobs.requeue(jobId);
    this.changed();
    this.pump();
  }

  resume(): void {
    this.jobs.requeueInterrupted();
    this.pump();
  }

  /** At quit: no new work starts, and what is running is abandoned. It resumes from saved pieces next launch. */
  stop(): void {
    this.stopped = true;
    this.running?.controller.abort();
  }

  pump(): void {
    if (this.running || this.stopped) return;
    const job = this.jobs.nextDue();
    if (job) {
      const controller = new AbortController();
      this.running = { id: job.id, controller };
      void this.execute(job, controller.signal).finally(() => {
        this.running = null;
        if (this.stopped) return;
        this.changed();
        this.pump();
      });
      return;
    }
    const next = this.jobs.earliestWaiting();
    if (next !== null && this.wakeAt !== next) {
      this.wakeAt = next;
      this.schedule(Math.max(0, next - this.now()), () => {
        this.wakeAt = null;
        this.pump();
      });
    }
  }

  private async execute(job: StoredJob, signal: AbortSignal): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      this.jobs.setFailed(job.id, 'This version of EchoMind cannot run this job.', false);
      return;
    }
    const blocked = handler.blocked(job);
    if (blocked) {
      this.jobs.setFailed(job.id, blocked, true);
      return;
    }
    try {
      await handler.run(job, signal);
    } catch (e) {
      if (signal.aborted) return;
      this.handleFailure(job, e);
    }
  }

  private handleFailure(job: StoredJob, error: unknown): void {
    if (!(error instanceof ProviderError)) {
      this.jobs.setFailed(job.id, error instanceof Error ? error.message : String(error), true);
      return;
    }
    const attempts = job.attempts + 1;
    if (error.kind === 'auth' || error.kind === 'rejected' || error.kind === 'too-large') {
      this.jobs.setFailed(job.id, error.message, true);
      return;
    }
    if (error.kind === 'rate' || error.kind === 'quota') {
      // Limits reset by themselves, so these never use up the retry count.
      const wait = error.retryAfterMs ?? DEFAULT_RATE_WAIT_MS * (error.kind === 'quota' ? 30 : 1);
      this.jobs.setWaiting(job.id, `${error.message} Progress is saved, and EchoMind will continue on its own.`, this.now() + backoffMs(attempts, wait), job.attempts);
      return;
    }
    if (attempts >= MAX_AUTO_ATTEMPTS) {
      this.jobs.setFailed(job.id, `${error.message} EchoMind stopped after ${attempts} attempts. Progress is saved, so retrying continues from here.`, true);
      return;
    }
    this.jobs.setWaiting(job.id, `${error.message} Trying again soon. Progress is saved.`, this.now() + backoffMs(attempts, error.retryAfterMs), attempts);
  }
}
