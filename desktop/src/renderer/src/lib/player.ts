import { useSyncExternalStore } from 'react';
import { findSilences, skipTarget, type TimeRange } from '@shared/media';
import type { Recording } from '@shared/models';
import { api } from './api';

export interface PlayerState {
  recording: Recording | null;
  peaks: Uint8Array | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  speed: number;
  skipSilence: boolean;
  voiceBoost: boolean;
  error: string | null;
}

const VOICE_BOOST_GAIN = 2.2;

/** One player for the whole app. It lives outside React, so audio keeps playing while the user navigates. */
class Player {
  private audio = new Audio();
  private silences: TimeRange[] = [];
  private listeners = new Set<() => void>();
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  state: PlayerState = { recording: null, peaks: null, playing: false, positionMs: 0, durationMs: 0, speed: 1, skipSilence: false, voiceBoost: false, error: null };

  constructor() {
    // Needed for the audio graph behind voice boost; the media protocol allows it.
    this.audio.crossOrigin = 'anonymous';
    this.audio.preservesPitch = true;
    this.audio.addEventListener('timeupdate', () => {
      const positionMs = this.audio.currentTime * 1000;
      if (this.state.skipSilence && !this.audio.paused) {
        const jump = skipTarget(this.silences, positionMs);
        if (jump !== null) this.audio.currentTime = jump / 1000;
      }
      this.set({ positionMs });
    });
    this.audio.addEventListener('play', () => this.set({ playing: true }));
    this.audio.addEventListener('pause', () => this.set({ playing: false }));
    this.audio.addEventListener('ended', () => this.set({ playing: false, positionMs: this.state.durationMs }));
    this.audio.addEventListener('durationchange', () => {
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) this.set({ durationMs: this.audio.duration * 1000 });
    });
    this.audio.addEventListener('error', () => {
      if (this.state.recording) this.set({ playing: false, error: 'This recording could not be played. Its file may have been moved or damaged.' });
    });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => void this.audio.play());
      navigator.mediaSession.setActionHandler('pause', () => this.audio.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-10_000));
      navigator.mediaSession.setActionHandler('seekforward', () => this.skip(10_000));
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Loads a recording. Keeps position when it is already loaded, so opening its screen never restarts it. */
  async load(recording: Recording, startMs?: number, autoplay = false): Promise<void> {
    const same = this.state.recording?.id === recording.id;
    if (!same) {
      const [peaks, settings] = await Promise.all([api.getPeaks(recording.id), api.getSettings()]);
      this.silences = peaks ? findSilences(peaks, recording.durationMs) : [];
      this.audio.src = `echomind-media://audio/${recording.id}`;
      this.audio.playbackRate = settings.playbackSpeed;
      this.set({ recording, peaks, positionMs: 0, durationMs: recording.durationMs, playing: false, speed: settings.playbackSpeed, skipSilence: settings.skipSilence, error: null });
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: recording.title, artist: 'EchoMind' });
    }
    if (startMs !== undefined) this.seek(startMs);
    if (autoplay) await this.play();
  }

  async play(): Promise<void> {
    if (this.audio.ended) this.audio.currentTime = 0;
    await this.audio.play().catch(() => undefined);
  }

  toggle(): void {
    if (this.audio.paused) void this.play();
    else this.audio.pause();
  }

  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(ms, this.state.durationMs));
    this.audio.currentTime = clamped / 1000;
    this.set({ positionMs: clamped });
  }

  skip(deltaMs: number): void {
    this.seek(this.audio.currentTime * 1000 + deltaMs);
  }

  setSpeed(speed: number): void {
    this.audio.playbackRate = speed;
    this.set({ speed });
    void api.updateSettings({ playbackSpeed: speed });
  }

  setSkipSilence(skipSilence: boolean): void {
    this.set({ skipSilence });
    void api.updateSettings({ skipSilence });
  }

  /** The audio graph is only built on first use, so ordinary playback stays on the plain element. */
  setVoiceBoost(voiceBoost: boolean): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.context.createMediaElementSource(this.audio).connect(this.gain).connect(this.context.destination);
    }
    void this.context.resume();
    this.gain!.gain.value = voiceBoost ? VOICE_BOOST_GAIN : 1;
    this.set({ voiceBoost });
  }

  /** Called when the loaded recording is trashed or deleted. */
  close(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.silences = [];
    this.set({ recording: null, peaks: null, playing: false, positionMs: 0, durationMs: 0, error: null });
  }

  closeIfLoaded(ids: string[]): void {
    if (this.state.recording && ids.includes(this.state.recording.id)) this.close();
  }

  refresh(recording: Recording): void {
    if (this.state.recording?.id === recording.id) this.set({ recording });
  }
}

export const player = new Player();

export function usePlayer(): PlayerState {
  return useSyncExternalStore(player.subscribe, player.getState);
}
