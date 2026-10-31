import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { powerSaveBlocker } from 'electron';
import { clampPosition } from '@shared/media';
import type { RecordingMode } from '@shared/models';
import type { SessionRepository, SessionRow } from '../db/library';
import { BadMediaError, type IngestPipeline } from './ingest';

/**
 * Below this, an unreadable capture is only a container header from stopping at once, not audio.
 * About 2 seconds at the standard bitrate. Anything larger is kept even if it cannot be read today.
 */
const NOTHING_CAPTURED_BYTES = 16 * 1024;

interface ActiveSession {
  id: string;
  file: FileHandle;
  /** Writes run strictly in order; each one is flushed to disk before the next. */
  writes: Promise<void>;
  error: Error | null;
  blocker: number;
}

/**
 * Crash-safe capture. Audio chunks are appended and flushed as they arrive, and the session row exists
 * from the first moment. After any crash, the file on disk is still a readable recording.
 */
export class RecorderService {
  private active: ActiveSession | null = null;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly pipeline: IngestPipeline,
    private readonly dir: string,
    private readonly libraryChanged: () => void,
  ) {}

  get isRecording(): boolean {
    return this.active !== null;
  }

  private path(id: string): string {
    return join(this.dir, `${id}.webm`);
  }

  async begin(title: string, mode: RecordingMode): Promise<string> {
    if (this.active) throw new Error('A recording is already in progress.');
    const id = randomUUID();
    const file = await open(this.path(id), 'wx');
    this.sessions.create({ id, title, mode, startedAt: Date.now() });
    // A long lecture must not be cut off by the computer going to sleep.
    const blocker = powerSaveBlocker.start('prevent-app-suspension');
    this.active = { id, file, writes: Promise.resolve(), error: null, blocker };
    return id;
  }

  append(id: string, chunk: Uint8Array): Promise<void> {
    const session = this.require(id);
    session.writes = session.writes.then(async () => {
      if (session.error) return;
      try {
        await session.file.appendFile(chunk);
        await session.file.datasync();
      } catch (e) {
        session.error = e instanceof Error ? e : new Error(String(e));
      }
    });
    // Reports a failed write (such as a full disk) back to the recorder so it can stop and save.
    return session.writes.then(() => {
      if (session.error) throw new Error('Could not write the recording to disk. It may be full.');
    });
  }

  addBookmark(id: string, positionMs: number, label: string, note: string | null, maxMs: number): void {
    this.sessions.addBookmark(id, { positionMs: clampPosition(positionMs, maxMs), label: label.trim() || 'Bookmark', note: note?.trim() || null });
  }

  /**
   * Stops writing and sends the audio through the same pipeline as every other source.
   * Returns null when nothing usable was captured, in which case nothing is left behind.
   */
  async finish(id: string, details: { title: string; description: string }): Promise<string | null> {
    const session = this.require(id);
    await this.close(session);
    this.sessions.update(id, details);
    const row = this.sessions.get(id)!;
    try {
      const recordingId = await this.finalize(row, 'native');
      this.libraryChanged();
      return recordingId;
    } catch (e) {
      if (await this.dropIfNothingCaptured(id, e)) return null;
      throw e;
    }
  }

  async discard(id: string): Promise<void> {
    await this.close(this.require(id));
    await rm(this.path(id), { force: true });
    this.sessions.remove(id);
  }

  /** On launch: anything still marked as recording was interrupted, so rebuild it. Returns how many were saved. */
  async recover(): Promise<number> {
    let recovered = 0;
    for (const session of this.sessions.all()) {
      const size = (await stat(this.path(session.id)).catch(() => null))?.size ?? 0;
      if (size === 0) {
        await rm(this.path(session.id), { force: true });
        this.sessions.remove(session.id);
        continue;
      }
      try {
        await this.finalize(session, 'recovered');
        recovered++;
      } catch (e) {
        if (await this.dropIfNothingCaptured(session.id, e)) continue;
        // Keep the session and its file: a later version may be able to read it. Never delete audio on doubt.
        console.error('Could not recover an interrupted recording', e instanceof Error ? e.message : e);
      }
    }
    await this.removeOrphans();
    if (recovered > 0) this.libraryChanged();
    return recovered;
  }

  async stopForQuit(): Promise<void> {
    if (this.active) await this.close(this.active);
  }

  private async finalize(session: SessionRow, source: 'native' | 'recovered'): Promise<string> {
    const path = this.path(session.id);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    const { recordingId } = await this.pipeline.ingest({
      workFile: path,
      title: session.title,
      description: session.description,
      mode: session.mode,
      source,
      createdAt: session.startedAt,
      sourceSha256: hash.digest('hex'),
      bookmarks: session.bookmarks,
    });
    this.sessions.remove(session.id);
    return recordingId;
  }

  private async dropIfNothingCaptured(id: string, error: unknown): Promise<boolean> {
    const size = (await stat(this.path(id)).catch(() => null))?.size ?? 0;
    if (!(error instanceof BadMediaError) || size >= NOTHING_CAPTURED_BYTES) return false;
    await rm(this.path(id), { force: true });
    this.sessions.remove(id);
    return true;
  }

  private async close(session: ActiveSession): Promise<void> {
    await session.writes;
    await session.file.close();
    powerSaveBlocker.stop(session.blocker);
    if (this.active === session) this.active = null;
  }

  private require(id: string): ActiveSession {
    if (this.active?.id !== id) throw new Error('This recording session is no longer active.');
    return this.active;
  }

  private async removeOrphans(): Promise<void> {
    const known = new Set(this.sessions.all().map((s) => s.id));
    for (const name of await readdir(this.dir)) {
      const id = name.replace(/\.webm(\.converted)?$/, '');
      if (!known.has(id)) await rm(join(this.dir, name), { force: true });
    }
  }
}
