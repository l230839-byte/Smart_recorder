import { useSyncExternalStore } from 'react';
import { AUDIO_QUALITY, type RecordingMode, type Settings } from '@shared/models';
import { api, errorMessage } from './api';

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'saving';

export interface RecorderState {
  status: RecorderStatus;
  sessionId: string | null;
  title: string;
  mode: RecordingMode;
  description: string;
  elapsedMs: number;
  level: number;
  /** Recent levels for the live waveform, oldest first. */
  levels: number[];
  bookmarkCount: number;
  warning: string | null;
  error: string | null;
  lastSavedId: string | null;
}

const CHUNK_MS = 1000;
const LEVEL_HISTORY = 160;
const SILENCE_WARNING_MS = 30_000;
const SILENCE_LEVEL = 0.012;
const LOW_DISK_BYTES = 500 * 1024 * 1024;
const CRITICAL_DISK_BYTES = 50 * 1024 * 1024;
const DISK_CHECK_MS = 30_000;

const INITIAL: RecorderState = {
  status: 'idle',
  sessionId: null,
  title: '',
  mode: 'lecture',
  description: '',
  elapsedMs: 0,
  level: 0,
  levels: [],
  bookmarkCount: 0,
  warning: null,
  error: null,
  lastSavedId: null,
};

export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') return 'Windows is blocking the microphone. Allow it under Settings > Privacy & security > Microphone, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app or unavailable.';
  if (name === 'OverconstrainedError') return 'The selected microphone is not available. Choose another one.';
  return errorMessage(e);
}

/** One recorder for the whole app. It lives outside React, so recording continues on every screen. */
class Recorder {
  state: RecorderState = INITIAL;
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private media: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private diskTimer: ReturnType<typeof setInterval> | null = null;
  private accumulatedMs = 0;
  private runningSince = 0;
  private silentSince = 0;
  private bytesWritten = 0;
  private failedWrite = false;
  private pendingChunks: Promise<unknown> = Promise.resolve();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<RecorderState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  get isActive(): boolean {
    return this.state.status !== 'idle';
  }

  elapsed(): number {
    return this.accumulatedMs + (this.runningSince ? performance.now() - this.runningSince : 0);
  }

  async start(title: string, mode: RecordingMode, settings: Settings): Promise<void> {
    if (this.isActive) return;
    this.set({ ...INITIAL, status: 'starting', title, mode });
    try {
      const free = await api.getFreeSpace();
      if (free < CRITICAL_DISK_BYTES) throw new Error('There is not enough free disk space to record.');

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
          noiseSuppression: settings.noiseSuppression,
          echoCancellation: settings.echoCancellation,
          autoGainControl: settings.autoGain,
        },
      });
      const sessionId = await api.beginRecording(title, mode);

      this.media = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: AUDIO_QUALITY[settings.audioQuality].bitrate });
      this.media.ondataavailable = (e) => this.onChunk(sessionId, e.data);
      this.media.onerror = () => void this.stop('Recording stopped because of an audio error. Everything captured so far was saved.');
      // A microphone that is unplugged or taken away ends the track: save what was captured.
      this.stream.getAudioTracks()[0]?.addEventListener('ended', () => void this.stop('The microphone was disconnected, so recording stopped. Everything captured so far was saved.'));

      this.startMeter();
      this.accumulatedMs = 0;
      this.runningSince = performance.now();
      this.silentSince = performance.now();
      this.bytesWritten = 0;
      this.failedWrite = false;
      this.pendingChunks = Promise.resolve();
      this.media.start(CHUNK_MS);
      this.set({ status: 'recording', sessionId, warning: free < LOW_DISK_BYTES ? 'Disk space is low. Recording will stop safely if it runs out.' : null });
      this.diskTimer = setInterval(() => void this.checkDisk(), DISK_CHECK_MS);
    } catch (e) {
      this.releaseDevices();
      this.set({ ...INITIAL, error: micErrorMessage(e) });
    }
  }

  private onChunk(sessionId: string, blob: Blob): void {
    if (blob.size === 0) return;
    this.bytesWritten += blob.size;
    // Chunks are sent in order; each waits for the previous, even across async work.
    this.pendingChunks = this.pendingChunks
      .then(async () => api.appendRecording(sessionId, new Uint8Array(await blob.arrayBuffer())))
      .catch((e: unknown) => {
        if (this.failedWrite) return;
        this.failedWrite = true;
        void this.stop(errorMessage(e));
      });
  }

  private startMeter(): void {
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.stream!).connect(this.analyser);
    const data = new Float32Array(this.analyser.fftSize);
    let tick = 0;
    this.meterTimer = setInterval(() => {
      if (!this.analyser || this.state.status !== 'recording') {
        if (this.state.status === 'paused') this.set({ level: 0 });
        return;
      }
      this.analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      const now = performance.now();
      if (peak > SILENCE_LEVEL) {
        this.silentSince = now;
        if (this.state.warning?.startsWith('No sound')) this.set({ warning: null });
      } else if (now - this.silentSince > SILENCE_WARNING_MS && !this.state.warning) {
        this.set({ warning: 'No sound for 30 seconds. Check that the right microphone is selected and not muted.' });
      }
      const level = Math.min(1, Math.sqrt(peak));
      const levels = ++tick % 2 === 0 ? [...this.state.levels.slice(1 - LEVEL_HISTORY), level] : this.state.levels;
      this.set({ level, levels, elapsedMs: this.elapsed() });
    }, 50);
  }

  private async checkDisk(): Promise<void> {
    const free = await api.getFreeSpace();
    if (free < CRITICAL_DISK_BYTES) await this.stop('Disk space ran out, so recording stopped. Everything captured so far was saved.');
    else if (free < LOW_DISK_BYTES && !this.state.warning) this.set({ warning: 'Disk space is low. Recording will stop safely if it runs out.' });
  }

  pause(): void {
    if (this.state.status !== 'recording' || !this.media) return;
    this.media.pause();
    this.accumulatedMs = this.elapsed();
    this.runningSince = 0;
    this.set({ status: 'paused', elapsedMs: this.accumulatedMs, level: 0 });
  }

  resume(): void {
    if (this.state.status !== 'paused' || !this.media) return;
    this.media.resume();
    this.runningSince = performance.now();
    this.silentSince = performance.now();
    this.set({ status: 'recording' });
  }

  bookmark(positionMs: number, label: string, note: string | null): void {
    const { sessionId } = this.state;
    if (!sessionId) return;
    void api.addSessionBookmark(sessionId, positionMs, label, note, this.elapsed());
    this.set({ bookmarkCount: this.state.bookmarkCount + 1 });
  }

  setDetails(details: { title?: string; description?: string }): void {
    this.set(details);
  }

  private flushAndStop(): Promise<void> {
    return new Promise<void>((resolve) => {
      const media = this.media;
      if (!media || media.state === 'inactive') return resolve();
      media.addEventListener('stop', () => resolve(), { once: true });
      media.stop();
    });
  }

  /** Saves what was captured. `warning` explains why, when the stop was not the user's choice. */
  async stop(warning?: string): Promise<string | null> {
    const { sessionId, title, description, status } = this.state;
    if (!sessionId || status === 'saving' || status === 'idle') return null;
    this.accumulatedMs = this.elapsed();
    this.runningSince = 0;
    this.set({ status: 'saving', elapsedMs: this.accumulatedMs });
    await this.flushAndStop();
    this.releaseDevices();
    await this.pendingChunks;
    try {
      if (this.bytesWritten === 0) {
        // Stopped before any audio was captured: there is nothing to keep.
        await api.discardRecording(sessionId);
        this.set({ ...INITIAL, warning: warning ?? 'Recording stopped before any audio was captured.' });
        return null;
      }
      const id = await api.finishRecording(sessionId, { title: title.trim() || 'Untitled recording', description });
      if (!id) {
        this.set({ ...INITIAL, warning: warning ?? 'That recording was too short to keep.' });
        return null;
      }
      this.set({ ...INITIAL, lastSavedId: id, warning: warning ?? null });
      return id;
    } catch (e) {
      this.set({ ...INITIAL, error: `The recording could not be finished, but its audio is kept and will be recovered on next launch. ${errorMessage(e)}` });
      return null;
    }
  }

  async discard(): Promise<void> {
    const { sessionId } = this.state;
    if (!sessionId) return;
    this.runningSince = 0;
    await this.flushAndStop();
    this.releaseDevices();
    await this.pendingChunks;
    await api.discardRecording(sessionId);
    this.set({ ...INITIAL });
  }

  dismissMessages(): void {
    this.set({ warning: null, error: null, lastSavedId: null });
  }

  private releaseDevices(): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.meterTimer = this.diskTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.media = null;
  }
}

export const recorder = new Recorder();

export function useRecorder(): RecorderState {
  return useSyncExternalStore(recorder.subscribe, recorder.getState);
}
