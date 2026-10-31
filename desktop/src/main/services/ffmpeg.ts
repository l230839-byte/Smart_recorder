import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { ffmpegNormalizeArgs, ffprobeFormatArgs, isUnsafeDemuxer, parseProgressMs } from '@shared/media';

/**
 * Optional bundled LGPL FFmpeg, used only for formats Chromium and Mediabunny cannot read (AMR, WMA, 3GP
 * and others). It runs as a separate process on files EchoMind already copied, never through a shell.
 */
export class Ffmpeg {
  private readonly dir = app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'resources', 'bin');

  get available(): boolean {
    return existsSync(join(this.dir, 'ffmpeg.exe')) && existsSync(join(this.dir, 'ffprobe.exe'));
  }

  private formatName(input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(join(this.dir, 'ffprobe.exe'), ffprobeFormatArgs(input), { timeout: 60_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(new Error('Not a readable media file'));
        else resolve(stdout.trim());
      });
    });
  }

  /** Converts any audio FFmpeg can read into Ogg/Opus. Rejects playlists and other container tricks. */
  async normalize(input: string, output: string, durationHintMs: number, onProgress?: (fraction: number) => void): Promise<void> {
    const format = await this.formatName(input);
    if (isUnsafeDemuxer(format)) throw new Error('This file type is not allowed.');

    await new Promise<void>((resolve, reject) => {
      const child = spawn(join(this.dir, 'ffmpeg.exe'), ffmpegNormalizeArgs(input, output), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        const ms = parseProgressMs(data.toString());
        if (ms !== null && durationHintMs > 0) onProgress?.(Math.min(1, ms / durationHintMs));
      });
      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < 2000) stderr += data.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() || `FFmpeg exited with code ${code}`));
      });
    });
  }
}
