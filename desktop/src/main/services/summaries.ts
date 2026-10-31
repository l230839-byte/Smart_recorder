import type { AiOutcome, JobKind, Settings } from '@shared/models';
import { LLM_PROVIDER_INFO, type LlmProviderId } from '@shared/providers';
import {
  chaptersMessages,
  combineMessages,
  parseJsonReply,
  pieceNotesMessages,
  resolveCitations,
  segmentsInScope,
  splitSegments,
  suggestMessages,
  SUMMARY_LENGTHS,
  summaryLabel,
  summaryMessages,
  transcriptForPrompt,
  validateChapters,
  validateSuggestions,
  type ChatMessage,
  type SummaryOptions,
} from '@shared/summaries';
import type { Segment } from '@shared/transcript';
import { ProviderError, type ChatProvider, type ChatTask } from '../ai/types';
import type { LibraryRepository } from '../db/library';
import type { SummaryRepository } from '../db/summaries';
import type { ConsentRepository, JobRepository, SecretStore, StoredJob, TranscriptRepository, UsageRepository } from '../db/transcripts';
import type { JobHandler, JobQueue } from './job-queue';
import { keyName } from './transcription';

const NOTES_MAX_TOKENS = 1500;
const JSON_MAX_TOKENS = 2000;
const MIN_PIECE_CHARS = 1500;

export interface SummaryDeps {
  jobs: JobRepository;
  queue: JobQueue;
  transcripts: TranscriptRepository;
  library: LibraryRepository;
  summaries: SummaryRepository;
  usage: UsageRepository;
  consents: ConsentRepository;
  secrets: SecretStore;
  settings: () => Settings;
  makeProvider: (id: LlmProviderId) => ChatProvider;
  changed: () => void;
  ready: (recordingId: string, title: string, kind: JobKind) => void;
}

interface SummaryJobOptions {
  summary?: SummaryOptions;
  language?: string;
  /** Lowered when a service says a piece was too large, up to a limit. */
  maxChars?: number;
}

export function textConsentKey(provider: string): string {
  return `${provider}:text`;
}

/**
 * Summaries, chapters and suggested titles. All of them read the stored transcript, so changing a
 * format never transcribes anything again (prompt §8).
 */
export class SummaryService implements JobHandler {
  constructor(private readonly deps: SummaryDeps) {
    for (const kind of ['summarize', 'chapters', 'suggest'] as const) deps.queue.register(kind, this);
  }

  blockedBy(provider: LlmProviderId): Exclude<AiOutcome, { ok: true }> | null {
    const info = LLM_PROVIDER_INFO[provider];
    const s = this.deps.settings();
    if (info.local) return null;
    if (s.offlineOnly) return { ok: false, reason: 'offline-only', provider, purpose: 'text' };
    if (provider === 'custom-chat' && !s.llmBaseUrl) return { ok: false, reason: 'needs-setup', provider, purpose: 'text' };
    if (info.needsKey && !this.deps.secrets.has(keyName(provider))) return { ok: false, reason: 'needs-setup', provider, purpose: 'text' };
    if (!this.deps.consents.has(textConsentKey(provider))) return { ok: false, reason: 'needs-consent', provider, purpose: 'text' };
    return null;
  }

  blocked(job: StoredJob): string | null {
    const blocked = this.blockedBy(job.provider as LlmProviderId);
    if (!blocked) return null;
    return blocked.reason === 'offline-only' ? 'Offline only is on, so nothing was sent. Turn it off in Settings, then retry.' : 'This provider needs setup or your agreement before anything is sent. Retry from the recording.';
  }

  request(recordingId: string, kind: 'summarize' | 'chapters' | 'suggest', options: SummaryJobOptions = {}): AiOutcome {
    const { library, jobs, transcripts, settings } = this.deps;
    const recording = library.getRecording(recordingId);
    if (!recording) throw new Error('This recording no longer exists.');
    if (recording.deletedAt !== null) throw new Error('Restore this recording before using AI features.');
    if (!transcripts.current(recordingId)) return { ok: false, reason: 'needs-transcript' };
    const active = jobs.activeFor(recordingId, kind);
    if (active) return { ok: true, jobId: active.id };

    const s = settings();
    const blocked = this.blockedBy(s.llmProvider);
    if (blocked) return blocked;
    const model = s.llmModel ?? LLM_PROVIDER_INFO[s.llmProvider].models[0]!;
    const id = jobs.create(recordingId, s.llmProvider, model, 'auto', kind, JSON.stringify(options));
    this.deps.changed();
    this.deps.queue.pump();
    return { ok: true, jobId: id };
  }

  private async chat(job: StoredJob, provider: ChatProvider, messages: ChatMessage[], maxOutputTokens: number, signal: AbortSignal, task: ChatTask, json = false) {
    const result = await provider.complete({ messages, model: job.model, maxOutputTokens, json, signal, task });
    this.deps.usage.record(job.provider, 1, 0, result.inputTokens, result.outputTokens);
    if (result.rate) this.deps.usage.saveRate(job.provider, result.rate);
    return result;
  }

  /** Asks for JSON, and asks once more if the reply cannot be read, since free models sometimes slip. */
  private async chatJson<T>(job: StoredJob, provider: ChatProvider, messages: ChatMessage[], signal: AbortSignal, task: ChatTask, validate: (value: unknown) => T): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.chat(job, provider, messages, JSON_MAX_TOKENS, signal, task, true);
      try {
        return validate(parseJsonReply(reply.text));
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof SyntaxError ? new Error('The AI service returned something EchoMind could not read. Please retry.') : lastError;
  }

  async run(job: StoredJob, signal: AbortSignal): Promise<void> {
    const { jobs, library, transcripts } = this.deps;
    const recording = library.getRecording(job.recordingId);
    const version = transcripts.current(job.recordingId);
    if (!recording || !version) {
      jobs.setFailed(job.id, 'This recording no longer has a transcript.', false);
      return;
    }
    const segments = transcripts.segments(version.id);
    const options = (job.options ?? {}) as SummaryJobOptions;
    const provider = this.deps.makeProvider(job.provider as LlmProviderId);
    const names = transcripts.speakerNames(recording.id);
    const maxChars = options.maxChars ?? LLM_PROVIDER_INFO[job.provider as LlmProviderId].maxInputChars;
    const limited = splitSegments(segments, maxChars)[0] ?? [];

    try {
      if (job.kind === 'chapters') {
        jobs.setRunning(job.id, 'Finding chapters', 0.2);
        this.deps.changed();
        // Long recordings: read an evenly spread sample of lines, which is enough to see where topics change.
        const sample = sampleSegments(segments, maxChars);
        const chapters = await this.chatJson(job, provider, chaptersMessages(transcriptForPrompt(sample, names), options.language ?? 'Same as the recording'), signal, 'chapters', (value) => validateChapters(value, segments, recording.durationMs));
        this.deps.summaries.saveChapters(recording.id, version.id, chapters);
      } else if (job.kind === 'suggest') {
        jobs.setRunning(job.id, 'Suggesting a title and tags', 0.2);
        this.deps.changed();
        const suggestions = await this.chatJson(job, provider, suggestMessages(transcriptForPrompt(limited, names), 'Same as the recording'), signal, 'suggest', validateSuggestions);
        this.deps.summaries.saveSuggestions(recording.id, suggestions);
      } else {
        await this.summarize(job, provider, recording.mode, version.id, segments, names, options, maxChars, signal);
      }
      jobs.setDone(job.id);
      this.deps.ready(recording.id, recording.title, job.kind);
    } catch (e) {
      // A smaller piece usually fits. Restart with what is left, keeping within what the service accepts.
      if (e instanceof ProviderError && e.kind === 'too-large' && maxChars / 2 >= MIN_PIECE_CHARS) {
        jobs.clearChunks(job.id);
        jobs.setOptions(job.id, JSON.stringify({ ...options, maxChars: Math.floor(maxChars / 2) }));
        jobs.requeue(job.id);
        return;
      }
      throw e;
    }
  }

  private async summarize(job: StoredJob, provider: ChatProvider, mode: Parameters<typeof summaryMessages>[1], versionId: string, allSegments: Segment[], names: Record<string, string>, options: SummaryJobOptions, maxChars: number, signal: AbortSignal): Promise<void> {
    const { jobs } = this.deps;
    const summary = options.summary;
    if (!summary) throw new Error('This summary has no settings.');
    const segments = segmentsInScope(allSegments, summary.scope);
    if (segments.length === 0) {
      jobs.setFailed(job.id, 'The selected part of the recording has no transcript text.', false);
      return;
    }
    const pieces = splitSegments(segments, maxChars);
    const maxTokens = summary.length === 'custom' && summary.customWords ? Math.min(8000, Math.round(summary.customWords * 2.5)) : SUMMARY_LENGTHS[summary.length].maxTokens;
    let text: string;
    let truncated = false;

    if (pieces.length === 1) {
      jobs.setRunning(job.id, 'Writing the summary', 0.3);
      this.deps.changed();
      const result = await this.chat(job, provider, summaryMessages(summary, mode, transcriptForPrompt(segments, names)), maxTokens, signal, 'summary');
      text = result.text;
      truncated = result.truncated;
    } else {
      // Long recordings: notes on each piece, then one result from the notes. Finished notes are kept.
      let stored = jobs.pieceResults(job.id);
      if (stored.length === 0) {
        jobs.addChunks(job.id, pieces.map((p) => ({ startMs: p[0]!.startMs, endMs: p[p.length - 1]!.endMs })));
        stored = jobs.pieceResults(job.id);
      }
      const notes: string[] = [];
      for (let i = 0; i < pieces.length; i++) {
        let note = stored[i] ?? null;
        if (note === null) {
          jobs.setRunning(job.id, `Reading part ${i + 1} of ${pieces.length}`, i / (pieces.length + 1));
          this.deps.changed();
          note = (await this.chat(job, provider, pieceNotesMessages(summary, mode, transcriptForPrompt(pieces[i]!, names), i + 1, pieces.length), NOTES_MAX_TOKENS, signal, 'summary')).text;
          jobs.savePieceResult(job.id, i, note);
        }
        notes.push(note);
      }
      jobs.setRunning(job.id, 'Writing the summary', pieces.length / (pieces.length + 1));
      this.deps.changed();
      const result = await this.chat(job, provider, combineMessages(summary, mode, notes), maxTokens, signal, 'summary');
      text = result.text;
      truncated = result.truncated;
    }

    const { markdown, dropped } = resolveCitations(text, allSegments);
    this.deps.summaries.add({ recordingId: job.recordingId, label: summaryLabel(summary), options: summary, markdown, provider: job.provider, model: job.model, transcriptVersionId: versionId, droppedCitations: dropped, truncated });
  }
}

/** An evenly spread selection of lines that fits the budget, keeping their real ids. */
export function sampleSegments(segments: Segment[], maxChars: number): Segment[] {
  const total = segments.reduce((sum, s) => sum + s.text.length + 20, 0);
  if (total <= maxChars) return segments;
  const keepEvery = Math.ceil(total / maxChars);
  return segments.filter((_, i) => i % keepEvery === 0);
}
