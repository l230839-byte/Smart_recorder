import type { ContextRecording } from '@shared/chat';
import { resolveChatCitations } from '@shared/chat';
import type { AiOutcome, Settings } from '@shared/models';
import { LLM_PROVIDER_INFO, type LlmProviderId } from '@shared/providers';
import { spreadSample } from '@shared/retrieval';
import {
  contextPieces,
  flashcardMessages,
  interleave,
  mindMapMessages,
  quizMessages,
  readJson,
  REWRITE_STYLES,
  shareCount,
  STUDIO_KINDS,
  STUDY_TYPES,
  taskMessages,
  translateLinesMessages,
  translateMarkdownMessages,
  validateFlashcards,
  validateMindMap,
  validateQuiz,
  validateTasks,
  validateTranslation,
  writingCombineMessages,
  writingInstruction,
  writingMessages,
  writingNotesMessages,
  type Flashcard,
  type QuizQuestion,
  type StartStudioInput,
  type StudioContent,
  type StudioOutput,
  type TaskSuggestion,
} from '@shared/studio';
import type { ChatMessage } from '@shared/summaries';
import { ProviderError, type ChatProvider } from '../ai/types';
import type { LibraryRepository } from '../db/library';
import type { StudioRepository, TaskRepository } from '../db/studio';
import type { SummaryRepository } from '../db/summaries';
import type { JobRepository, StoredJob, TranscriptRepository, UsageRepository } from '../db/transcripts';
import type { JobHandler, JobQueue } from './job-queue';

const CONTEXT_CAP_CHARS = 48_000;
const PROMPT_OVERHEAD_CHARS = 3000;
const MIN_PIECE_CHARS = 1500;
const JSON_MAX_TOKENS = 3500;
const WRITING_MAX_TOKENS = 3500;
const NOTES_MAX_TOKENS = 1500;
/** A translation is about as long as what it translates, so its pieces are smaller. */
const TRANSLATE_PIECE_CHARS = 5000;

export interface StudioDeps {
  studio: StudioRepository;
  tasks: TaskRepository;
  jobs: JobRepository;
  queue: JobQueue;
  library: LibraryRepository;
  transcripts: TranscriptRepository;
  summaries: SummaryRepository;
  usage: UsageRepository;
  settings: () => Settings;
  makeProvider: (id: LlmProviderId) => ChatProvider;
  blockedBy: (provider: LlmProviderId) => Exclude<AiOutcome, { ok: true }> | null;
  changed: () => void;
  ready: (recordingId: string, title: string) => void;
}

interface StudioJobOptions {
  outputId: string;
  /** Lowered when a service says a piece was too large. */
  maxChars?: number;
}

export type StartStudioOutcome = { ok: true; outputId: string } | Exclude<AiOutcome, { ok: true }>;

/**
 * AI Studio, the study assistant and action items (prompt §10, §13, §14). Every tool runs on the shared,
 * persistent job queue: long material is split into pieces, finished pieces are stored, and a crash or a
 * rate limit never repeats work. Every item points at the transcript line it came from.
 */
export class StudioService implements JobHandler {
  constructor(private readonly deps: StudioDeps) {
    deps.queue.register('studio', this);
  }

  start(input: StartStudioInput): StartStudioOutcome {
    const info = STUDIO_KINDS[input.kind];
    if (!info) throw new Error('Unknown tool.');
    const ids = [...new Set(input.recordingIds)];
    if (ids.length < info.minRecordings) throw new Error(info.minRecordings === 1 ? 'Choose a recording.' : `Choose at least ${info.minRecordings} recordings.`);
    if (ids.length > info.maxRecordings) throw new Error(`${info.label} works with up to ${info.maxRecordings} recordings at a time.`);
    const recordings = ids.map((id) => this.deps.library.getRecording(id));
    if (recordings.some((r) => !r || r.deletedAt !== null)) throw new Error('Some of these recordings no longer exist or are in the trash.');
    if (ids.some((id) => !this.deps.transcripts.current(id))) return { ok: false, reason: 'needs-transcript' };
    if (input.kind === 'translate' && input.options.translateSource === 'summary') {
      const summary = input.options.summaryId ? this.deps.summaries.get(input.options.summaryId) : null;
      if (!summary || summary.recordingId !== ids[0]) throw new Error('Choose a summary of this recording to translate.');
    }
    const s = this.deps.settings();
    const blocked = this.deps.blockedBy(s.llmProvider);
    if (blocked) return blocked;

    const first = recordings[0]!.title;
    const what =
      input.kind === 'study' ? STUDY_TYPES[input.options.studyType].label : input.kind === 'rewrite' ? REWRITE_STYLES[input.options.rewriteStyle].label : input.kind === 'translate' ? `${info.label} (${input.options.targetLanguage})` : info.label;
    const title = input.title?.trim() || `${what}: ${first}${ids.length > 1 ? ` and ${ids.length - 1} more` : ''}`;
    const options = { ...input.options, count: Math.min(60, Math.max(3, Math.round(input.options.count || 15))) };
    const outputId = this.deps.studio.create({ kind: input.kind, title, recordingIds: ids, options, provider: s.llmProvider });
    const model = s.llmModel ?? LLM_PROVIDER_INFO[s.llmProvider].models[0]!;
    this.deps.jobs.create(ids[0]!, s.llmProvider, model, 'auto', 'studio', JSON.stringify({ outputId } satisfies StudioJobOptions));
    this.deps.changed();
    this.deps.queue.pump();
    return { ok: true, outputId };
  }

  blocked(job: StoredJob): string | null {
    const blocked = this.deps.blockedBy(job.provider as LlmProviderId);
    if (!blocked) return null;
    return blocked.reason === 'offline-only' ? 'Offline only is on, so nothing was sent. Turn it off in Settings, then retry.' : 'This provider needs setup or your agreement before anything is sent.';
  }

  private async complete(job: StoredJob, provider: ChatProvider, messages: ChatMessage[], maxOutputTokens: number, json: boolean, signal: AbortSignal) {
    const result = await provider.complete({ messages, model: job.model, maxOutputTokens, json, signal, task: json ? 'studio-json' : 'studio' });
    this.deps.usage.record(job.provider, 1, 0, result.inputTokens, result.outputTokens);
    if (result.rate) this.deps.usage.saveRate(job.provider, result.rate);
    return result;
  }

  /** Asks for JSON and asks once more if the reply cannot be read or validated. */
  private async completeJson<T>(job: StoredJob, provider: ChatProvider, messages: ChatMessage[], signal: AbortSignal, validate: (value: unknown) => T): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.complete(job, provider, messages, JSON_MAX_TOKENS, true, signal);
      try {
        return readJson(reply.text, validate);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof SyntaxError ? new Error('The AI service returned something EchoMind could not read. Please retry.') : lastError;
  }

  /** Runs `work` on each piece, storing each result so a retry continues where it stopped. */
  private async perPiece(job: StoredJob, pieces: string[], stage: string, work: (piece: string, i: number) => Promise<string>): Promise<string[]> {
    const { jobs } = this.deps;
    let stored = jobs.pieceResults(job.id);
    if (stored.length !== pieces.length) {
      jobs.clearChunks(job.id);
      jobs.addChunks(job.id, pieces.map(() => ({ startMs: 0, endMs: 0 })));
      stored = jobs.pieceResults(job.id);
    }
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      let result = stored[i] ?? null;
      if (result === null) {
        jobs.setRunning(job.id, pieces.length > 1 ? `${stage}: part ${i + 1} of ${pieces.length}` : stage, (i + 0.5) / (pieces.length + 1));
        this.deps.changed();
        result = await work(pieces[i]!, i);
        jobs.savePieceResult(job.id, i, result);
      }
      out.push(result);
    }
    return out;
  }

  private contextFor(output: StudioOutput): ContextRecording[] {
    return output.recordingIds.flatMap((id) => {
      const rec = this.deps.library.getRecording(id);
      const version = this.deps.transcripts.current(id);
      if (!rec || !version || rec.deletedAt !== null) return [];
      return [{ id, title: rec.title, createdAt: rec.createdAt, durationMs: rec.durationMs, speakers: this.deps.transcripts.speakerNames(id), segments: this.deps.transcripts.segments(version.id), complete: true }];
    });
  }

  async run(job: StoredJob, signal: AbortSignal): Promise<void> {
    const { jobs, studio } = this.deps;
    const options = (job.options ?? {}) as Partial<StudioJobOptions>;
    const output = options.outputId ? studio.get(options.outputId) : null;
    if (!output) {
      jobs.setFailed(job.id, 'This result was deleted.', false);
      return;
    }
    const recordings = this.contextFor(output);
    if (recordings.length !== output.recordingIds.length || !recordings.length) {
      jobs.setFailed(job.id, 'A recording this needs no longer has a transcript.', false);
      return;
    }
    const provider = this.deps.makeProvider(job.provider as LlmProviderId);
    const maxChars = options.maxChars ?? Math.min(LLM_PROVIDER_INFO[job.provider as LlmProviderId].maxInputChars, CONTEXT_CAP_CHARS) - PROMPT_OVERHEAD_CHARS;

    try {
      const { content, dropped, truncated } = await this.generate(job, output, recordings, provider, Math.max(MIN_PIECE_CHARS, maxChars), signal);
      studio.setContent(output.id, content, dropped, truncated);
      jobs.setDone(job.id);
      this.deps.ready(recordings[0]!.id, output.title);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'too-large' && maxChars / 2 >= MIN_PIECE_CHARS) {
        jobs.clearChunks(job.id);
        jobs.setOptions(job.id, JSON.stringify({ ...options, maxChars: Math.floor(maxChars / 2) }));
        jobs.requeue(job.id);
        return;
      }
      throw e;
    }
  }

  private async generate(job: StoredJob, output: StudioOutput, recordings: ContextRecording[], provider: ChatProvider, maxChars: number, signal: AbortSignal): Promise<{ content: StudioContent; dropped: number; truncated: boolean }> {
    const o = output.options;
    switch (output.kind) {
      case 'flashcards':
      case 'quiz': {
        const { pieces, targets, sizes } = contextPieces(recordings, maxChars);
        const counts = shareCount(o.count, sizes);
        const results = await this.perPiece(job, pieces, output.kind === 'quiz' ? 'Writing questions' : 'Writing flashcards', async (piece, i) => {
          if (output.kind === 'quiz') return JSON.stringify(await this.completeJson(job, provider, quizMessages(o, piece, counts[i]!), signal, (v) => validateQuiz(v, targets, o.questionTypes)));
          return JSON.stringify(await this.completeJson(job, provider, flashcardMessages(o, piece, counts[i]!), signal, (v) => validateFlashcards(v, targets)));
        });
        if (output.kind === 'quiz') {
          const parsed = results.map((r) => JSON.parse(r) as { questions: QuizQuestion[]; dropped: number });
          const questions = interleave(dedupe(parsed.map((p) => p.questions), (q) => q.question), o.count);
          if (!questions.length) throw new Error('No usable questions came back. Retry, or try different question types.');
          return { content: { type: 'quiz', questions }, dropped: parsed.reduce((s, p) => s + p.dropped, 0), truncated: false };
        }
        const parsed = results.map((r) => JSON.parse(r) as { cards: Flashcard[]; dropped: number });
        const cards = interleave(dedupe(parsed.map((p) => p.cards), (c) => c.front), o.count);
        if (!cards.length) throw new Error('No usable flashcards came back. Please retry.');
        return { content: { type: 'flashcards', cards }, dropped: parsed.reduce((s, p) => s + p.dropped, 0), truncated: false };
      }

      case 'mindmap': {
        // A map needs the whole picture at once, so long material is read as an even selection.
        const share = Math.floor(maxChars / recordings.length);
        const sampled = recordings.map((r) => ({ ...r, segments: spreadSample(r.segments, share) }));
        const { pieces, targets } = contextPieces(sampled, Number.MAX_SAFE_INTEGER);
        this.deps.jobs.setRunning(job.id, 'Mapping the ideas', 0.4);
        this.deps.changed();
        const root = await this.completeJson(job, provider, mindMapMessages(o, pieces[0]!), signal, (v) => validateMindMap(v, targets));
        return { content: { type: 'mindmap', root }, dropped: 0, truncated: false };
      }

      case 'tasks': {
        const { pieces, targets } = contextPieces(recordings, maxChars);
        const recordedOn = new Date(recordings[0]!.createdAt).toISOString().slice(0, 10);
        const results = await this.perPiece(job, pieces, 'Finding action items', async (piece) => JSON.stringify(await this.completeJson(job, provider, taskMessages(piece), signal, (v) => validateTasks(v, targets, recordedOn))));
        const found = results.flatMap((r) => JSON.parse(r) as TaskSuggestion[]);
        const added = this.deps.tasks.addSuggestions(output.recordingIds, found);
        return { content: { type: 'tasks', count: added }, dropped: 0, truncated: false };
      }

      case 'translate': {
        if (o.translateSource === 'summary') {
          const summary = o.summaryId ? this.deps.summaries.get(o.summaryId) : null;
          if (!summary) throw new Error('The summary to translate no longer exists.');
          const parts = splitMarkdown(summary.markdown, TRANSLATE_PIECE_CHARS);
          const results = await this.perPiece(job, parts, 'Translating', async (part) => (await this.complete(job, provider, translateMarkdownMessages(part, o.targetLanguage), JSON_MAX_TOKENS, false, signal)).text.trim());
          return { content: { type: 'markdown', markdown: results.join('\n\n') }, dropped: 0, truncated: false };
        }
        const { pieces, targets } = contextPieces(recordings, Math.min(maxChars, TRANSLATE_PIECE_CHARS));
        const results = await this.perPiece(job, pieces, 'Translating', async (piece) => JSON.stringify([...(await this.completeJson(job, provider, translateLinesMessages(piece, o.targetLanguage), signal, (v) => validateTranslation(v, targets))).entries()]));
        const translated = new Map(results.flatMap((r) => JSON.parse(r) as [number, string][]));
        const lines = [...targets.entries()].map(([n, t]) => ({ startMs: t.startMs, original: t.text, text: translated.get(n) ?? '' }));
        return { content: { type: 'translation', language: o.targetLanguage, lines }, dropped: 0, truncated: false };
      }

      case 'study':
      case 'rewrite':
      case 'compare':
      case 'custom': {
        const instruction = writingInstruction(output.kind, o);
        const { pieces, targets } = contextPieces(recordings, maxChars);
        let text: string;
        let truncated = false;
        if (pieces.length === 1) {
          this.deps.jobs.setRunning(job.id, 'Writing', 0.4);
          this.deps.changed();
          const result = await this.complete(job, provider, writingMessages(instruction, pieces[0]!), WRITING_MAX_TOKENS, false, signal);
          text = result.text;
          truncated = result.truncated;
        } else {
          const notes = await this.perPiece(job, pieces, 'Reading', async (piece, i) => (await this.complete(job, provider, writingNotesMessages(instruction, piece, i + 1, pieces.length), NOTES_MAX_TOKENS, false, signal)).text);
          this.deps.jobs.setRunning(job.id, 'Writing', pieces.length / (pieces.length + 1));
          this.deps.changed();
          const result = await this.complete(job, provider, writingCombineMessages(instruction, notes), WRITING_MAX_TOKENS, false, signal);
          text = result.text;
          truncated = result.truncated;
        }
        const resolved = resolveChatCitations(text, targets);
        return { content: { type: 'markdown', markdown: resolved.markdown }, dropped: resolved.dropped, truncated };
      }
    }
  }

  jobFor(outputId: string): StoredJob | null {
    return this.deps.jobs.latestByOption('studio', 'outputId', outputId);
  }
}

/** Removes items repeated across pieces (the same question asked twice), keeping the first. */
function dedupe<T>(lists: T[][], key: (item: T) => string): T[][] {
  const seen = new Set<string>();
  return lists.map((list) =>
    list.filter((item) => {
      const k = key(item).toLowerCase().replace(/\W+/g, ' ').trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  );
}

/** Splits Markdown at blank lines into parts of at most `max` characters, never inside a paragraph. */
export function splitMarkdown(markdown: string, max: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const block of markdown.split(/\n{2,}/)) {
    if (current && current.length + block.length + 2 > max) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  return parts;
}
