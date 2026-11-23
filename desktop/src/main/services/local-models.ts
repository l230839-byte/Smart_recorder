import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_MODEL_BASE_URL, LOCAL_MODELS, LOCAL_MODEL_IDS, type LocalModelId, type LocalModelStatus } from '@shared/providers';

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Whisper models on disk, in the data folder. Downloads continue where they stopped (HTTP Range), are
 * checked against the published SHA-256 before use, and nothing half-downloaded is ever loaded: a model
 * only gets its final name once its hash matches.
 */
export class LocalModelStore {
  private readonly active = new Map<LocalModelId, { controller: AbortController; received: number; total: number }>();

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly fetchFn: typeof fetch = fetch,
    /** The published models; tests pass their own small files and hashes. */
    private readonly catalog: Record<LocalModelId, { file: string; sizeMb: number; sha256: string }> = LOCAL_MODELS,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  path(id: LocalModelId): string {
    return join(this.dir, this.catalog[id].file);
  }

  installed(id: LocalModelId): boolean {
    return id in this.catalog && existsSync(this.path(id));
  }

  list(): LocalModelStatus[] {
    return LOCAL_MODEL_IDS.map((id) => {
      const job = this.active.get(id);
      const part = `${this.path(id)}.part`;
      return { id, installed: this.installed(id), downloading: job ? { received: job.received, total: job.total } : null, partialBytes: existsSync(part) ? statSync(part).size : 0 };
    });
  }

  /** Starts or continues a download. Resolves when the model is checked and ready. */
  async download(id: LocalModelId): Promise<void> {
    if (!(id in this.catalog)) throw new Error('Unknown model.');
    if (this.installed(id) || this.active.has(id)) return;
    const info = this.catalog[id];
    const final = this.path(id);
    const part = `${final}.part`;
    const controller = new AbortController();
    let received = existsSync(part) ? statSync(part).size : 0;
    const job = { controller, received, total: info.sizeMb * 1024 * 1024 };
    this.active.set(id, job);
    this.onChange();
    let lastReport = 0;
    try {
      const response = await this.fetchFn(`${LOCAL_MODEL_BASE_URL}/${info.file}`, { headers: received ? { Range: `bytes=${received}-` } : {}, signal: controller.signal });
      // 206 continues the part file; 200 means the server sent it all again, so start over.
      if (response.status === 200) received = 0;
      else if (response.status !== 206) throw new Error(`The download failed (HTTP ${response.status}). Try again later.`);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0) job.total = received + length;
      job.received = received;
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
      } finally {
        await file.close();
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

  /** Stops a download; the part file is kept so it can continue later. */
  cancel(id: LocalModelId): void {
    this.active.get(id)?.controller.abort();
  }

  async remove(id: LocalModelId): Promise<void> {
    this.cancel(id);
    await rm(this.path(id), { force: true });
    await rm(`${this.path(id)}.part`, { force: true });
    this.onChange();
  }
}
