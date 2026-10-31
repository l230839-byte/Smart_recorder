import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { MediaJob, MediaJobResult } from '@shared/media-jobs';

interface Pending {
  resolve: (value: never) => void;
  reject: (e: Error) => void;
  onProgress?: (value: number) => void;
}

/**
 * Owns the hidden window that does decoding (WebCodecs exists only in a renderer). The worker sees
 * numbered handles, never paths. If a bad file crashes the window, its jobs fail and it restarts.
 */
export class MediaWorker {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private nextJob = 1;
  private nextHandle = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly files = new Map<number, FileHandle>();

  constructor() {
    ipcMain.on('media:ready', () => this.markReady?.());
    ipcMain.on('media:done', (_e, id: number, value: unknown) => this.settle(id)?.resolve(value as never));
    ipcMain.on('media:fail', (_e, id: number, message: string) => this.settle(id)?.reject(new Error(message)));
    ipcMain.on('media:progress', (_e, id: number, value: number) => this.pending.get(id)?.onProgress?.(value));
    ipcMain.handle('media:size', async (event, handle: number) => {
      this.requireWorker(event.sender);
      return (await this.file(handle).stat()).size;
    });
    ipcMain.handle('media:read', async (event, handle: number, start: number, end: number) => {
      this.requireWorker(event.sender);
      const length = end - start;
      const buffer = new Uint8Array(length);
      let total = 0;
      // A single read may return less than asked for.
      while (total < length) {
        const { bytesRead } = await this.file(handle).read(buffer, total, length - total, start + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return total === length ? buffer : buffer.subarray(0, total);
    });
    ipcMain.handle('media:write', async (event, handle: number, position: number, data: Uint8Array) => {
      this.requireWorker(event.sender);
      await this.file(handle).write(data, 0, data.length, position);
    });
  }

  /** File handles are for the worker alone. */
  private requireWorker(sender: WebContents): void {
    if (sender !== this.window?.webContents) throw new Error('Not allowed.');
  }

  private file(handle: number): FileHandle {
    const file = this.files.get(handle);
    if (!file) throw new Error('Unknown media handle');
    return file;
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    return pending;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve) => (this.markReady = resolve));
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/media.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    win.webContents.on('render-process-gone', () => {
      this.window = null;
      this.ready = null;
      for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new Error('The media decoder stopped unexpectedly on this file.'));
      if (!win.isDestroyed()) win.destroy();
    });
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/media.html`);
    else void win.loadFile(join(__dirname, '../renderer/media.html'));
    return this.ready;
  }

  private async run<K extends keyof MediaJobResult>(job: MediaJob & { op: K }, onProgress?: (value: number) => void): Promise<MediaJobResult[K]> {
    await this.start();
    const id = this.nextJob++;
    return new Promise<MediaJobResult[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress });
      this.window!.webContents.send('media:job', id, job);
    });
  }

  private async withFile<T>(path: string, flags: 'r' | 'w+', work: (handle: number) => Promise<T>): Promise<T> {
    const handle = this.nextHandle++;
    const file = await open(path, flags);
    this.files.set(handle, file);
    try {
      return await work(handle);
    } finally {
      this.files.delete(handle);
      await file.close();
    }
  }

  probe(path: string): Promise<MediaJobResult['probe']> {
    return this.withFile(path, 'r', (input) => this.run<'probe'>({ op: 'probe', input }));
  }

  analyze(path: string, durationMs: number, onProgress?: (value: number) => void): Promise<MediaJobResult['analyze']> {
    return this.withFile(path, 'r', (input) => this.run<'analyze'>({ op: 'analyze', input, durationMs }, onProgress));
  }

  convert(
    from: string,
    to: string,
    options: Pick<Extract<MediaJob, { op: 'convert' }>, 'container' | 'transcode' | 'startMs' | 'endMs' | 'speechBitrate'>,
    onProgress?: (value: number) => void,
  ): Promise<MediaJobResult['convert']> {
    return this.withFile(from, 'r', (input) => this.withFile(to, 'w+', (output) => this.run<'convert'>({ op: 'convert', input, output, ...options }, onProgress)));
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
