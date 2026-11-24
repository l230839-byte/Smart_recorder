import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_MODEL_BASE_URL, LOCAL_MODELS, type LocalModelId } from '@shared/providers';

/** One downloadable model file: where it comes from and how to check it. */
export interface ModelFile {
  file: string;
  sizeMb: number;
  sha256: string;
  /** Full download address; when absent, the file is fetched from whisper.cpp's model page. */
  url?: string;
}

export interface ModelStatus<Id extends string> {
  id: Id;
  installed: boolean;
  /** Set while downloading: bytes so far and in all. */
  downloading: { received: number; total: number } | null;
  /** A part file from an interrupted download, which "Download" continues. */
  partialBytes: number;
}

/** Attempts per download before the person is asked to continue it. */
const MAX_ATTEMPTS = 6;

/** The connection broke or the server stumbled; the part file is kept and the download resumes. */
class Interrupted extends Error {}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Downloaded models on disk, in the data folder (Whisper, the offline writing model, speaker models). Downloads continue where they stopped (HTTP Range), are
 * checked against the published SHA-256 before use, and nothing half-downloaded is ever loaded: a model
 * only gets its final name once its hash matches.
 */
export class LocalModelStore<Id extends string = LocalModelId> {
  private readonly active = new Map<Id, { controller: AbortController; received: number; total: number }>();

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly fetchFn: typeof fetch = fetch,
    /** The published models; tests pass their own small files and hashes. */
    private readonly catalog: Record<Id, ModelFile> = LOCAL_MODELS as unknown as Record<Id, ModelFile>,
    /** The wait before resuming grows with each attempt; tests shorten it. */
    private readonly retryDelayMs = 3000,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  path(id: Id): string {
    return join(this.dir, this.catalog[id].file);
  }

  installed(id: Id): boolean {
    return id in this.catalog && existsSync(this.path(id));
  }

  list(): ModelStatus<Id>[] {
    return (Object.keys(this.catalog) as Id[]).map((id) => {
      const job = this.active.get(id);
      const part = `${this.path(id)}.part`;
      return { id, installed: this.installed(id), downloading: job ? { received: job.received, total: job.total } : null, partialBytes: existsSync(part) ? statSync(part).size : 0 };
    });
  }

  /** Starts or continues a download. Resolves when the model is checked and ready. */
  async download(id: Id): Promise<void> {
    if (!(id in this.catalog)) throw new Error('Unknown model.');
    if (this.installed(id) || this.active.has(id)) return;
    const info = this.catalog[id];
    const final = this.path(id);
    const part = `${final}.part`;
    const controller = new AbortController();
    const job = { controller, received: existsSync(part) ? statSync(part).size : 0, total: info.sizeMb * 1024 * 1024 };
    this.active.set(id, job);
    this.onChange();
    const url = info.url ?? `${LOCAL_MODEL_BASE_URL}/${info.file}`;
    try {
      // Large files over slow or unsteady connections often break off. Each break resumes from the part
      // file by itself, a few times, before asking the person.
      for (let attempt = 1; ; attempt++) {
        try {
          if (await this.fetchPart(url, part, job, controller.signal)) break;
          throw new Interrupted();
        } catch (e) {
          if (controller.signal.aborted) return;
          if (!(e instanceof Interrupted) || attempt >= MAX_ATTEMPTS) throw e;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
          if (controller.signal.aborted) return;
        }
      }
      if ((await sha256(part)) !== info.sha256) {
        await rm(part, { force: true });
        throw new Error('The downloaded model did not match its published checksum, so it was deleted. Try again.');
      }
      await rename(part, final);
    } catch (e) {
      if (controller.signal.aborted) return;
      throw e instanceof Error && e.message.startsWith('The ') ? e : new Error('The download stopped. Check your connection; "Download" continues where it stopped.');
    } finally {
      this.active.delete(id);
      this.onChange();
    }
  }

  /**
   * One request: continues the part file from where it ends. True when the whole file has arrived; false
   * when the connection ended early (the part is kept). Throws Interrupted for a dropped connection or a
   * server hiccup, and a plain error for an answer that retrying cannot fix.
   */
  private async fetchPart(url: string, part: string, job: { received: number; total: number }, signal: AbortSignal): Promise<boolean> {
    let received = existsSync(part) ? statSync(part).size : 0;
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: received ? { Range: `bytes=${received}-` } : {}, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Interrupted();
    }
    // The part already holds the whole file.
    if (response.status === 416 && received > 0) return true;
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Interrupted();
    // 206 continues the part file; 200 means the server sent it all again, so start over.
    if (response.status === 200) received = 0;
    else if (response.status !== 206) throw new Error(`The download failed (HTTP ${response.status}). Try again later.`);
    const length = Number(response.headers.get('content-length'));
    const expected = Number.isFinite(length) && length > 0 ? received + length : null;
    if (expected) job.total = expected;
    job.received = received;
    let lastReport = 0;
    const file = await open(part, received ? 'a' : 'w');
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await file.write(chunk);
        job.received += chunk.length;
        if (Date.now() - lastReport > 400) {
          lastReport = Date.now();
          this.onChange();
        }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Interrupted();
    } finally {
      await file.close();
    }
    // A stream that ends short without an error is a dropped connection too, not a bad file.
    return expected === null || job.received >= expected;
  }

  /** Stops a download; the part file is kept so it can continue later. */
  cancel(id: Id): void {
    this.active.get(id)?.controller.abort();
  }

  async remove(id: Id): Promise<void> {
    this.cancel(id);
    await rm(this.path(id), { force: true });
    await rm(`${this.path(id)}.part`, { force: true });
    this.onChange();
  }
}
