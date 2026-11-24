import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredJob, JobRepository, TranscriptRepository } from '../db/transcripts';
import type { LibraryRepository } from '../db/library';
import { assignSpeakers, runDiarization } from '../ai/diarize';
import type { JobHandler, JobQueue } from './job-queue';

export type SpeakersOutcome = { ok: true; jobId: string } | { ok: false; reason: 'needs-transcript' | 'needs-setup' };

export interface SpeakerDeps {
  jobs: JobRepository;
  queue: JobQueue;
  transcripts: TranscriptRepository;
  library: LibraryRepository;
  exe: string;
  /** The two model files, or null while either is not downloaded. */
  models: () => { segmentation: string; voices: string } | null;
  threads: number;
  /** Writes the whole recording as 16 kHz mono WAV at this path. */
  prepareAudio: (recordingId: string, durationMs: number, outputPath: string) => Promise<void>;
  tempDir: string;
  changed: () => void;
  speakersReady: (recordingId: string, title: string) => void;
}

/**
 * Finds who spoke when, on this computer, and labels the current transcript's lines. The whole recording
 * is read at once, so a voice keeps one label from start to end, whatever made the transcript.
 */
export class SpeakerService implements JobHandler {
  constructor(private readonly deps: SpeakerDeps) {
    deps.queue.register('diarize', this);
  }

  /** sherpa-onnx is part of this copy of EchoMind (models may still need downloading). */
  installed(): boolean {
    return existsSync(this.deps.exe);
  }

  ready(): boolean {
    return this.installed() && this.deps.models() !== null;
  }

  request(recordingId: string, speakers: number | null): SpeakersOutcome {
    const { library, transcripts, jobs } = this.deps;
    const recording = library.getRecording(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    if (!transcripts.current(recordingId)) return { ok: false, reason: 'needs-transcript' };
    if (!this.ready()) return { ok: false, reason: 'needs-setup' };
    const active = jobs.activeFor(recordingId, 'diarize');
    if (active) return { ok: true, jobId: active.id };
    const count = speakers && speakers >= 1 && speakers <= 20 ? Math.round(speakers) : null;
    const id = jobs.create(recordingId, 'sherpa-onnx', 'pyannote-3.0 + eres2net', 'auto', 'diarize', JSON.stringify({ speakers: count }));
    this.deps.changed();
    this.deps.queue.pump();
    return { ok: true, jobId: id };
  }

  blocked(): string | null {
    return this.ready() ? null : 'Download the speaker models first, in Settings > AI providers.';
  }

  async run(job: StoredJob, signal: AbortSignal): Promise<void> {
    const { jobs, library, transcripts } = this.deps;
    const recording = library.getRecording(job.recordingId);
    const current = transcripts.current(job.recordingId);
    const models = this.deps.models();
    if (!recording || !current || !models) {
      jobs.setFailed(job.id, 'The recording, its transcript or the speaker models are no longer available.', false);
      return;
    }
    const options = (job.options ?? {}) as { speakers?: number | null };
    const wav = join(this.deps.tempDir, `${job.id}-speakers.wav`);
    try {
      jobs.setRunning(job.id, 'Preparing the audio', 0.05);
      this.deps.changed();
      await this.deps.prepareAudio(recording.id, recording.durationMs, wav);
      if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
      jobs.setRunning(job.id, 'Listening for different voices', 0.3);
      this.deps.changed();
      const turns = await runDiarization({ exe: this.deps.exe, segmentationModel: models.segmentation, voiceModel: models.voices, wavPath: wav, speakers: options.speakers ?? null, threads: this.deps.threads, signal });
      if (turns.length === 0) {
        jobs.setFailed(job.id, 'No voices were found to tell apart in this recording.', false);
        return;
      }
      const labelled = assignSpeakers(transcripts.segments(current.id), turns);
      transcripts.addWithSpeakers(recording.id, current, labelled);
      jobs.setDone(job.id);
      this.deps.speakersReady(recording.id, recording.title);
    } finally {
      await rm(wav, { force: true }).catch(() => undefined);
    }
  }
}
