import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { codecLabel, CONTAINER_LABEL, CONTAINER_MIME, isTruncated, planIngest, rejectionReason, sniffAmr, type IngestPlan, type MediaProbe } from '@shared/media';
import type { RecordingMode, RecordingSource } from '@shared/models';
import { formatDuration } from '@shared/format';
import type { LibraryRepository, NewRecording } from '../db/library';
import type { Ffmpeg } from './ffmpeg';
import type { MediaWorker } from './media-worker';

const IMPORT_SOURCES = new Set<RecordingSource>(['picker', 'dropped', 'opened']);

/** A problem caused by the file itself: trying again cannot help, so the UI offers only Remove. */
export class BadMediaError extends Error {}

export interface IngestRequest {
  /** A file EchoMind owns. It is consumed: on success it has been moved or replaced. */
  workFile: string;
  title: string;
  mode: RecordingMode;
  source: RecordingSource;
  description?: string;
  originalName?: string | null;
  sourceSha256?: string | null;
  collectionId?: string | null;
  createdAt?: number;
  bookmarks?: NewRecording['bookmarks'];
  onStage?: (stage: 'checking' | 'converting', progress: number) => void;
}

export interface IngestResult {
  recordingId: string;
  warning: string | null;
}

/**
 * The single entry point to the library (prompt §18). Recorded, imported, dropped, opened, trimmed,
 * recovered and video audio all pass through here and come out as the same kind of recording.
 */
export class IngestPipeline {
  constructor(
    private readonly media: MediaWorker,
    private readonly library: LibraryRepository,
    private readonly mediaDir: string,
    private readonly ffmpeg: Pick<Ffmpeg, 'available' | 'normalize'> | null = null,
  ) {}

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const { workFile, onStage } = request;
    onStage?.('checking', 0);

    const probe = await this.readableProbe(workFile, onStage);

    const plan: IngestPlan = planIngest(probe);
    const id = randomUUID();
    const fileName = `${id}.${plan.container}`;
    const finalPath = join(this.mediaDir, fileName);

    let current = workFile;
    if (plan.kind !== 'keep') {
      onStage?.('converting', 0);
      const converted = `${workFile}.converted`;
      try {
        await this.media.convert(workFile, converted, { container: plan.container, transcode: plan.kind === 'transcode' }, (p) => onStage?.('converting', p));
      } catch (e) {
        await rm(converted, { force: true });
        throw new BadMediaError(`This file could not be converted: ${e instanceof Error ? e.message : String(e)}`);
      }
      current = converted;
    }

    let finalProbe = probe;
    try {
      if (current !== workFile) finalProbe = await this.media.probe(current);
      onStage?.('checking', 0);
      let analysis;
      try {
        analysis = await this.media.analyze(current, finalProbe.durationMs, (p) => onStage?.('checking', p));
      } catch (e) {
        if (e instanceof Error && /stopped unexpectedly/.test(e.message)) throw e;
        throw new BadMediaError('This file is damaged and could not be fully decoded.');
      }
      if (analysis.decodedMs <= 0) throw new BadMediaError('This file contains no playable audio.');

      const truncated = isTruncated(finalProbe.durationMs, analysis.decodedMs);
      const warning = truncated ? `This file ends early. Only ${formatDuration(analysis.decodedMs)} of ${formatDuration(finalProbe.durationMs)} could be read.` : null;

      await rename(current, finalPath);
      const { size } = await stat(finalPath);
      this.library.insertRecording({
        id,
        title: request.title,
        description: request.description,
        mode: request.mode,
        // Decided from the file's content, not its name.
        source: probe.hasVideo && IMPORT_SOURCES.has(request.source) ? 'video' : request.source,
        originalName: request.originalName,
        format: CONTAINER_LABEL[plan.container],
        codec: codecLabel(finalProbe.codec ?? ''),
        durationMs: truncated ? analysis.decodedMs : finalProbe.durationMs,
        sizeBytes: size,
        sampleRate: finalProbe.sampleRate,
        channels: finalProbe.channels,
        sourceSha256: request.sourceSha256,
        collectionId: request.collectionId,
        fileName,
        mime: CONTAINER_MIME[plan.container],
        peaks: analysis.peaks,
        createdAt: request.createdAt,
        bookmarks: request.bookmarks,
      });
      if (current !== workFile) await rm(workFile, { force: true });
      return { recordingId: id, warning };
    } catch (e) {
      if (current !== workFile) await rm(current, { force: true });
      throw e;
    }
  }

  /** Probes the file. What the built-in decoders cannot read gets one more chance through FFmpeg, if bundled. */
  private async readableProbe(workFile: string, onStage: IngestRequest['onStage']): Promise<MediaProbe> {
    const amr = await this.isAmr(workFile);
    let probe: MediaProbe | null = null;
    if (!amr) probe = await this.media.probe(workFile).catch(() => null);
    const reason = probe ? rejectionReason(probe) : null;
    if (probe && !reason) return probe;

    if (!this.ffmpeg?.available) {
      if (amr) throw new BadMediaError('AMR voice recordings are recognized but cannot be read without the FFmpeg add-on. Convert this file to MP3 or M4A first, or install the add-on.');
      throw new BadMediaError(reason ?? 'This file is not audio EchoMind can read. It may be damaged, or not really the format its name suggests.');
    }

    const normalized = `${workFile}.normalized`;
    onStage?.('converting', 0);
    try {
      await this.ffmpeg.normalize(workFile, normalized, probe?.durationMs ?? 0, (p) => onStage?.('converting', p));
      await rm(workFile, { force: true });
      await rename(normalized, workFile);
      return await this.media.probe(workFile);
    } catch {
      await rm(normalized, { force: true });
      throw new BadMediaError(reason ?? 'This file is not audio EchoMind can read. It may be damaged, or not really the format its name suggests.');
    }
  }

  private async isAmr(path: string): Promise<boolean> {
    const file = await open(path, 'r');
    try {
      const head = new Uint8Array(16);
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      return sniffAmr(head.subarray(0, bytesRead)) !== null;
    } finally {
      await file.close();
    }
  }
}
