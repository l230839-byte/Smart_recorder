import { randomUUID } from 'node:crypto';
import type { JobKind, JobStatus, ProcessingJob, ProviderRateInfo, TranscriptVersion, UsageSummary } from '@shared/models';
import type { ChunkSegment, Segment } from '@shared/transcript';
import { transaction, type Db } from './database';

interface VersionRow {
  id: string;
  recording_id: string;
  version: number;
  kind: 'original' | 'edited';
  provider: string;
  model: string;
  language: string | null;
  is_current: number;
  created_at: number;
}

function toVersion(r: VersionRow): TranscriptVersion {
  return { id: r.id, recordingId: r.recording_id, version: r.version, kind: r.kind, provider: r.provider, model: r.model, language: r.language, isCurrent: r.is_current === 1, createdAt: r.created_at };
}

export class TranscriptRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private nextVersion(recordingId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM transcript_versions WHERE recording_id = ?').get(recordingId) as { v: number };
    return row.v;
  }

  private insertSegments(versionId: string, segments: Segment[]): void {
    const insert = this.db.prepare('INSERT INTO transcript_segments (version_id, idx, start_ms, end_ms, speaker, text, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const s of segments) insert.run(versionId, s.idx, s.startMs, s.endMs, s.speaker, s.text, s.confidence);
  }

  private makeCurrent(recordingId: string, versionId: string): void {
    // Two steps: the database allows only one current version at any moment.
    this.db.prepare('UPDATE transcript_versions SET is_current = 0 WHERE recording_id = ? AND is_current = 1').run(recordingId);
    this.db.prepare('UPDATE transcript_versions SET is_current = 1 WHERE id = ?').run(versionId);
    this.db.prepare('DELETE FROM transcript_search WHERE recording_id = ?').run(recordingId);
    const insert = this.db.prepare('INSERT INTO transcript_search (recording_id, segment_idx, start_ms, text) VALUES (?, ?, ?, ?)');
    for (const s of this.segments(versionId)) insert.run(recordingId, s.idx, s.startMs, s.text);
  }

  /** A provider's result. Always a new version, so re-transcribing never destroys earlier work. */
  addOriginal(recordingId: string, provider: string, model: string, language: string | null, segments: Segment[]): string {
    const id = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare("INSERT INTO transcript_versions (id, recording_id, version, kind, provider, model, language, is_current, created_at) VALUES (?, ?, ?, 'original', ?, ?, ?, 0, ?)")
        .run(id, recordingId, this.nextVersion(recordingId), provider, model, language, this.now());
      this.insertSegments(id, segments);
      this.makeCurrent(recordingId, id);
    });
    return id;
  }

  current(recordingId: string): TranscriptVersion | null {
    const row = this.db.prepare('SELECT * FROM transcript_versions WHERE recording_id = ? AND is_current = 1').get(recordingId) as VersionRow | undefined;
    return row ? toVersion(row) : null;
  }

  versions(recordingId: string): TranscriptVersion[] {
    return (this.db.prepare('SELECT * FROM transcript_versions WHERE recording_id = ? ORDER BY version DESC').all(recordingId) as unknown as VersionRow[]).map(toVersion);
  }

  segments(versionId: string): Segment[] {
    const rows = this.db.prepare('SELECT idx, start_ms, end_ms, speaker, text, confidence FROM transcript_segments WHERE version_id = ? ORDER BY idx').all(versionId) as unknown as {
      idx: number;
      start_ms: number;
      end_ms: number;
      speaker: string | null;
      text: string;
      confidence: number | null;
    }[];
    return rows.map((r) => ({ idx: r.idx, startMs: r.start_ms, endMs: r.end_ms, speaker: r.speaker, text: r.text, confidence: r.confidence }));
  }

  setCurrent(recordingId: string, versionId: string): void {
    const row = this.db.prepare('SELECT 1 FROM transcript_versions WHERE id = ? AND recording_id = ?').get(versionId, recordingId);
    if (!row) throw new Error('This transcript version no longer exists.');
    transaction(this.db, () => this.makeCurrent(recordingId, versionId));
  }

  /**
   * Edits never touch an original. The first edit copies the current version into an edited one, and
   * later edits update that copy, so the provider's text stays one click away.
   */
  editSegment(recordingId: string, idx: number, text: string): void {
    const clean = text.trim();
    if (!clean) throw new Error('A segment cannot be empty.');
    transaction(this.db, () => {
      const current = this.current(recordingId);
      if (!current) throw new Error('This recording has no transcript.');
      let versionId = current.id;
      if (current.kind === 'original') {
        versionId = randomUUID();
        this.db
          .prepare("INSERT INTO transcript_versions (id, recording_id, version, kind, provider, model, language, is_current, created_at) VALUES (?, ?, ?, 'edited', ?, ?, ?, 0, ?)")
          .run(versionId, recordingId, this.nextVersion(recordingId), current.provider, current.model, current.language, this.now());
        this.insertSegments(versionId, this.segments(current.id));
      }
      // The user has checked this text, so it no longer counts as uncertain.
      this.db.prepare('UPDATE transcript_segments SET text = ?, confidence = NULL WHERE version_id = ? AND idx = ?').run(clean, versionId, idx);
      this.makeCurrent(recordingId, versionId);
    });
  }

  speakerNames(recordingId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT label, display_name FROM speakers WHERE recording_id = ?').all(recordingId) as { label: string; display_name: string }[];
    return Object.fromEntries(rows.map((r) => [r.label, r.display_name]));
  }

  renameSpeaker(recordingId: string, label: string, name: string): void {
    this.db
      .prepare('INSERT INTO speakers (recording_id, label, display_name) VALUES (?, ?, ?) ON CONFLICT (recording_id, label) DO UPDATE SET display_name = excluded.display_name')
      .run(recordingId, label, name.trim());
  }
}

interface JobRow {
  id: string;
  kind: JobKind;
  recording_id: string;
  title: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  retryable: number;
  attempts: number;
  provider: string;
  model: string;
  language: string;
  options: string | null;
  next_attempt_at: number | null;
  created_at: number;
}

export interface StoredJob extends ProcessingJob {
  attempts: number;
  model: string;
  language: string;
  options: unknown;
}

function toJob(r: JobRow): StoredJob {
  return {
    id: r.id,
    kind: r.kind,
    recordingId: r.recording_id,
    recordingTitle: r.title,
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    error: r.error,
    retryable: r.retryable === 1,
    attempts: r.attempts,
    provider: r.provider,
    model: r.model,
    language: r.language,
    options: r.options ? (JSON.parse(r.options) as unknown) : null,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
  };
}

const JOB_SELECT = 'SELECT j.*, r.title FROM processing_jobs j JOIN recordings r ON r.id = j.recording_id';

export interface StoredChunk {
  idx: number;
  startMs: number;
  endMs: number;
  segments: ChunkSegment[] | null;
  language: string | null;
}

export class JobRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(recordingId: string, provider: string, model: string, language: string, kind: JobKind = 'transcribe', options: string | null = null): string {
    const id = randomUUID();
    const t = this.now();
    this.db
      .prepare("INSERT INTO processing_jobs (id, kind, recording_id, status, stage, provider, model, language, options, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'Waiting', ?, ?, ?, ?, ?, ?)")
      .run(id, kind, recordingId, provider, model, language, options, t, t);
    return id;
  }

  setOptions(id: string, options: string): void {
    this.db.prepare('UPDATE processing_jobs SET options = ?, updated_at = ? WHERE id = ?').run(options, this.now(), id);
  }

  get(id: string): StoredJob | null {
    const row = this.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  list(): StoredJob[] {
    return (this.db.prepare(`${JOB_SELECT} WHERE r.deleted_at IS NULL OR j.status IN ('queued', 'running', 'waiting') ORDER BY j.created_at DESC, j.rowid DESC`).all() as unknown as JobRow[]).map(toJob);
  }

  /** The active job for a recording, or its latest one. */
  latestFor(recordingId: string, kind: JobKind): StoredJob | null {
    const row = this.db.prepare(`${JOB_SELECT} WHERE j.recording_id = ? AND j.kind = ? ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`).get(recordingId, kind) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  activeFor(recordingId: string, kind: JobKind): StoredJob | null {
    const row = this.db.prepare(`${JOB_SELECT} WHERE j.recording_id = ? AND j.kind = ? AND j.status IN ('queued', 'running', 'waiting') LIMIT 1`).get(recordingId, kind) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  activeForRecording(recordingId: string): StoredJob[] {
    return (this.db.prepare(`${JOB_SELECT} WHERE j.recording_id = ? AND j.status IN ('queued', 'running', 'waiting')`).all(recordingId) as unknown as JobRow[]).map(toJob);
  }

  /** The next job due. Waiting jobs count once their retry time passes. */
  nextDue(): StoredJob | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE j.status = 'queued' OR (j.status = 'waiting' AND j.next_attempt_at <= ?) ORDER BY j.created_at, j.rowid LIMIT 1`)
      .get(this.now()) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  earliestWaiting(): number | null {
    const row = this.db.prepare("SELECT MIN(next_attempt_at) AS t FROM processing_jobs WHERE status = 'waiting'").get() as { t: number | null };
    return row.t;
  }

  setRunning(id: string, stage: string, progress: number): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'running', stage = ?, progress = ?, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(stage, progress, this.now(), id);
  }

  setWaiting(id: string, message: string, nextAttemptAt: number, attempts: number): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'waiting', stage = 'Waiting to retry', error = ?, next_attempt_at = ?, attempts = ?, updated_at = ? WHERE id = ?").run(message, nextAttemptAt, attempts, this.now(), id);
  }

  setDone(id: string): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'done', stage = 'Finished', progress = 1, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
    this.db.prepare('DELETE FROM job_chunks WHERE job_id = ?').run(id);
  }

  setFailed(id: string, message: string, retryable: boolean): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'failed', stage = 'Failed', error = ?, retryable = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(message, retryable ? 1 : 0, this.now(), id);
  }

  setCanceled(id: string): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'canceled', stage = 'Canceled', error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
    this.db.prepare('DELETE FROM job_chunks WHERE job_id = ?').run(id);
  }

  /** Finished chunks are kept, so a retry continues where the failure happened. */
  requeue(id: string): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'queued', stage = 'Waiting', error = NULL, retryable = 1, attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  requeueInterrupted(): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'queued', stage = 'Waiting', updated_at = ? WHERE status = 'running'").run(this.now());
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM processing_jobs WHERE id = ?').run(id);
  }

  clearFinished(): void {
    this.db.prepare("DELETE FROM processing_jobs WHERE status IN ('done', 'canceled')").run();
  }

  // Chunks

  chunks(jobId: string): StoredChunk[] {
    const rows = this.db.prepare('SELECT idx, start_ms, end_ms, result, language FROM job_chunks WHERE job_id = ? ORDER BY idx').all(jobId) as unknown as {
      idx: number;
      start_ms: number;
      end_ms: number;
      result: string | null;
      language: string | null;
    }[];
    return rows.map((r) => ({ idx: r.idx, startMs: r.start_ms, endMs: r.end_ms, segments: r.result ? (JSON.parse(r.result) as ChunkSegment[]) : null, language: r.language }));
  }

  addChunks(jobId: string, ranges: { startMs: number; endMs: number }[]): void {
    const insert = this.db.prepare('INSERT INTO job_chunks (job_id, idx, start_ms, end_ms) VALUES (?, ?, ?, ?)');
    transaction(this.db, () => ranges.forEach((r, i) => insert.run(jobId, i, r.startMs, r.endMs)));
  }

  clearChunks(jobId: string): void {
    this.db.prepare('DELETE FROM job_chunks WHERE job_id = ?').run(jobId);
  }

  /** Text results for jobs made of pieces, such as notes on each part of a long summary. */
  pieceResults(jobId: string): (string | null)[] {
    const rows = this.db.prepare('SELECT result FROM job_chunks WHERE job_id = ? ORDER BY idx').all(jobId) as { result: string | null }[];
    return rows.map((r) => r.result);
  }

  savePieceResult(jobId: string, idx: number, text: string): void {
    this.db.prepare('UPDATE job_chunks SET result = ? WHERE job_id = ? AND idx = ?').run(text, jobId, idx);
  }

  saveChunk(jobId: string, idx: number, segments: ChunkSegment[], language: string | null): void {
    this.db.prepare('UPDATE job_chunks SET result = ?, language = ? WHERE job_id = ? AND idx = ?').run(JSON.stringify(segments), language, jobId, idx);
  }
}

/** Requests and audio per provider and day, so limits can be shown honestly (prompt §23). */
export class UsageRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private day(at = this.now()): string {
    return new Date(at).toISOString().slice(0, 10);
  }

  record(provider: string, requests: number, audioMs: number, inputTokens = 0, outputTokens = 0): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage (provider, day, requests, audio_ms, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, day) DO UPDATE SET requests = requests + excluded.requests, audio_ms = audio_ms + excluded.audio_ms,
           input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(provider, this.day(), requests, Math.round(audioMs), inputTokens, outputTokens);
  }

  saveRate(provider: string, info: ProviderRateInfo): void {
    this.db.prepare('INSERT INTO provider_rate (provider, info, updated_at) VALUES (?, ?, ?) ON CONFLICT (provider) DO UPDATE SET info = excluded.info, updated_at = excluded.updated_at').run(provider, JSON.stringify(info), this.now());
  }

  summary(): UsageSummary[] {
    const today = this.day();
    const monthPrefix = today.slice(0, 7);
    const rows = this.db
      .prepare(
        `SELECT provider,
           SUM(CASE WHEN day = ? THEN requests ELSE 0 END) AS rd, SUM(CASE WHEN day = ? THEN audio_ms ELSE 0 END) AS ad,
           SUM(CASE WHEN day = ? THEN input_tokens + output_tokens ELSE 0 END) AS td,
           SUM(CASE WHEN substr(day, 1, 7) = ? THEN requests ELSE 0 END) AS rm, SUM(CASE WHEN substr(day, 1, 7) = ? THEN audio_ms ELSE 0 END) AS am,
           SUM(CASE WHEN substr(day, 1, 7) = ? THEN input_tokens + output_tokens ELSE 0 END) AS tm
         FROM ai_usage GROUP BY provider ORDER BY provider`,
      )
      .all(today, today, today, monthPrefix, monthPrefix, monthPrefix) as unknown as { provider: string; rd: number; ad: number; td: number; rm: number; am: number; tm: number }[];
    return rows.map((r) => {
      const rate = this.db.prepare('SELECT info, updated_at FROM provider_rate WHERE provider = ?').get(r.provider) as { info: string; updated_at: number } | undefined;
      return {
        provider: r.provider,
        requestsToday: r.rd,
        audioMsToday: r.ad,
        requestsMonth: r.rm,
        audioMsMonth: r.am,
        tokensToday: r.td,
        tokensMonth: r.tm,
        rate: rate ? (JSON.parse(rate.info) as ProviderRateInfo) : null,
        rateUpdatedAt: rate?.updated_at ?? null,
      };
    });
  }

  audioMsToday(provider: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(audio_ms), 0) AS a FROM ai_usage WHERE provider = ? AND day = ?').get(provider, this.day()) as { a: number };
    return row.a;
  }
}

export class ConsentRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  has(provider: string): boolean {
    return this.db.prepare('SELECT 1 FROM provider_consents WHERE provider = ?').get(provider) !== undefined;
  }

  accept(provider: string): void {
    this.db.prepare('INSERT OR REPLACE INTO provider_consents (provider, accepted_at) VALUES (?, ?)').run(provider, this.now());
  }

  revoke(provider: string): void {
    this.db.prepare('DELETE FROM provider_consents WHERE provider = ?').run(provider);
  }
}

/** Secrets are stored only as encrypted bytes. Encryption is injected, so this also runs in unit tests. */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  set(name: string, value: string): void {
    if (!this.cipher.available()) throw new Error('Windows secure storage is not available, so the key was not saved.');
    this.db.prepare('INSERT OR REPLACE INTO secrets (name, value) VALUES (?, ?)').run(name, this.cipher.encrypt(value));
  }

  get(name: string): string | null {
    const row = this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: Uint8Array } | undefined;
    if (!row) return null;
    try {
      return this.cipher.decrypt(new Uint8Array(row.value));
    } catch {
      // Secure storage changed, such as after moving to a new Windows account. The user can enter it again.
      return null;
    }
  }

  has(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name) !== undefined;
  }

  clear(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }
}
