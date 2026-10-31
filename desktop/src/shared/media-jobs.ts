import type { MediaProbe, OutputContainer } from './media';

/** Jobs the main process asks the hidden media worker to run. File access goes through numbered handles. */
export type MediaJob =
  | { op: 'probe'; input: number }
  | { op: 'analyze'; input: number; durationMs: number }
  | { op: 'convert'; input: number; output: number; container: OutputContainer; transcode: boolean; startMs?: number; endMs?: number; speechBitrate?: number };

export interface MediaJobResult {
  probe: MediaProbe;
  analyze: { peaks: Uint8Array; decodedMs: number };
  convert: { durationMs: number };
}

export interface MediaBridge {
  onJob(listener: (id: number, job: MediaJob) => void): void;
  done(id: number, value: unknown): void;
  fail(id: number, message: string): void;
  progress(id: number, value: number): void;
  size(handle: number): Promise<number>;
  read(handle: number, start: number, end: number): Promise<Uint8Array>;
  write(handle: number, position: number, data: Uint8Array): Promise<void>;
  ready(): void;
}
