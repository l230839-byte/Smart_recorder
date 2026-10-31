import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat, statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RecordingMode, RecordingSource } from '@shared/models';
import type { ImportRepository, LibraryRepository, QueuedImport } from '../db/library';
import { BadMediaError, type IngestPipeline } from './ingest';

const CONCURRENCY = 2;

/** Persistent queue: each file succeeds or fails on its own, and interrupted work resumes on launch. */
export class ImportService {
  private running = 0;

  constructor(
    private readonly jobs: ImportRepository,
    private readonly library: LibraryRepository,
    private readonly pipelineService: IngestPipeline,
    private readonly tempDir: string,
    private readonly changed: () => void,
    private readonly libraryChanged: () => void,
  ) {}

  /** Paths come from the system file dialog, drag and drop, or "Open with". */
  async enqueue(paths: string[], kind: RecordingSource, mode: RecordingMode): Promise<string> {
    const batchId = randomUUID();
    for (const path of paths) {
      const size = await stat(path).then(
        (s) => (s.isFile() ? s.size : null),
        () => null,
      );
      this.jobs.add(batchId, path, basename(path), size, kind, mode);
    }
    this.changed();
    this.pump();
    return batchId;
  }

  resume(): void {
    this.jobs.requeueInterrupted();
    this.pump();
  }

  retry(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'failed') return;
    this.jobs.requeue(id);
    this.changed();
    this.pump();
  }

  private pump(): void {
    while (this.running < CONCURRENCY) {
      const job = this.jobs.nextQueued();
      if (!job) return;
      this.running++;
      this.jobs.setStatus(job.id, 'copying', 0);
      void this.process(job).finally(() => {
        this.running--;
        this.changed();
        this.pump();
      });
    }
  }

  private async process(job: QueuedImport): Promise<void> {
    const workFile = join(this.tempDir, `${job.id}.part`);
    try {
      const size = (await stat(job.sourcePath).catch(() => null))?.size;
      if (size === undefined) throw new Error('The original file is no longer available. Check that it still exists, then retry.');
      if (size === 0) throw new BadMediaError('This file is empty.');
      await this.ensureSpace(size);

      const sha256 = await this.copyWithHash(job, workFile, size);

      const existing = this.library.findBySha(sha256);
      if (existing) {
        await rm(workFile, { force: true });
        this.jobs.duplicate(job.id, existing.id);
        return;
      }

      const result = await this.pipelineService.ingest({
        workFile,
        title: titleFromFileName(job.displayName),
        mode: job.mode,
        source: job.sourceKind,
        originalName: job.displayName,
        sourceSha256: sha256,
        onStage: (stage, progress) => {
          this.jobs.setStatus(job.id, stage, stage === 'converting' ? 0.5 + progress * 0.2 : 0.7 + progress * 0.3);
          this.changed();
        },
      });
      this.jobs.finish(job.id, result.recordingId, result.warning);
      this.libraryChanged();
    } catch (e) {
      await rm(workFile, { force: true }).catch(() => undefined);
      const message = e instanceof Error ? e.message : String(e);
      this.jobs.fail(job.id, message, !(e instanceof BadMediaError));
    }
  }

  private async ensureSpace(size: number): Promise<void> {
    const fs = await statfs(this.tempDir);
    if (fs.bavail * fs.bsize < size * 1.1) throw new Error('There is not enough free disk space to import this file.');
  }

  /** Streams the copy and hash together: large files never load into memory, and the original is only read. */
  private async copyWithHash(job: QueuedImport, target: string, size: number): Promise<string> {
    const hash = createHash('sha256');
    let copied = 0;
    let lastReport = 0;
    const tap = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        hash.update(chunk);
        copied += chunk.length;
        const progress = copied / size;
        if (progress - lastReport > 0.05) {
          lastReport = progress;
          this.jobs.setProgress(job.id, progress * 0.5);
          this.changed();
        }
        done(null, chunk);
      },
    });
    await pipeline(createReadStream(job.sourcePath), tap, createWriteStream(target));
    return hash.digest('hex');
  }
}

export function titleFromFileName(name: string): string {
  const stem = basename(name, extname(name)).replace(/[_]+/g, ' ').trim();
  return stem || name;
}
