import type { AiOutcome, Settings } from '@shared/models';
import { LLM_PROVIDER_INFO, llmChoice, type LlmProviderId } from '@shared/providers';
import {
  answerFromPlainText,
  answerMessages,
  buildContext,
  historyForPrompt,
  MAX_QUESTION_CHARS,
  planMessages,
  readAnswer,
  resolveChatCitations,
  validatePlan,
  type ChatPlan,
  type ChatScope,
  type ChatSource,
  type ChatTurn,
  type ContextRecording,
  type HistoryTurn,
} from '@shared/chat';
import { plural } from '@shared/format';
import { anyTermQuery, fuseRankings, promptChars, searchTerms, spreadSample } from '@shared/retrieval';
import { parseJsonReply, type ChatMessage } from '@shared/summaries';
import type { Segment } from '@shared/transcript';
import { ProviderError, type ChatProvider, type ChatTask } from '../ai/types';
import type { ChatRepository } from '../db/chats';
import type { KnowledgeRepository, PassageHit } from '../db/knowledge';
import type { LibraryRepository } from '../db/library';
import type { TranscriptRepository, UsageRepository } from '../db/transcripts';

/** Large-context services could take whole libraries, but answers stay quick and within free limits. */
const CONTEXT_CAP_CHARS = 48_000;
const PROMPT_OVERHEAD_CHARS = 2600;
const MIN_CONTEXT_CHARS = 3000;
const ANSWER_MAX_TOKENS = 2500;
const PLAN_MAX_TOKENS = 300;
/** A rate limit this short is simply waited out, once, rather than failing the answer. */
const SHORT_WAIT_MS = 20_000;
const MAX_CHAT_RETRIES = 3;
/** Recordings that can share one answer as an even selection of each. More than this needs a search. */
const MAX_OVERVIEW_RECORDINGS = 8;

export interface ChatDeps {
  chats: ChatRepository;
  knowledge: KnowledgeRepository;
  library: LibraryRepository;
  transcripts: TranscriptRepository;
  usage: UsageRepository;
  settings: () => Settings;
  makeProvider: (id: LlmProviderId) => ChatProvider;
  /** Why the text provider cannot be used now (offline only, no key, no consent), if it cannot. */
  blockedBy: (provider: LlmProviderId) => Exclude<AiOutcome, { ok: true }> | null;
  changed: () => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface Loaded {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  language: string | null;
  segments: Segment[];
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Canceled', 'AbortError'));
    });
  });
}

/**
 * Talking to recordings (prompt §9). Answers come from the user's transcripts: the whole transcript when
 * it fits, otherwise the passages a BM25 search finds. Every citation is checked, and the model must keep
 * general knowledge apart and say plainly when the recordings do not cover something.
 *
 * Chat runs straight away rather than in the job queue, so a question never waits behind a long
 * transcription. It still goes through the same provider, consent and offline checks.
 */
export class ChatService {
  private readonly running = new Map<string, AbortController>();
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: ChatDeps) {
    this.wait = deps.wait ?? defaultWait;
  }

  start(scope: ChatScope): string {
    if (scope.kind === 'recordings') {
      const ids = [...new Set(scope.recordingIds)];
      if (!ids.length) throw new Error('Choose at least one recording.');
      if (this.deps.knowledge.scopeRecordingIds({ kind: 'recordings', recordingIds: ids }).length !== ids.length) throw new Error('Some of these recordings no longer exist or are in the trash.');
      return this.deps.chats.create({ kind: 'recordings', recordingIds: ids });
    }
    return this.deps.chats.create(scope);
  }

  /** How many recordings a scope covers, and how many can be asked about. */
  scopeInfo(scope: ChatScope): { recordings: number; withTranscript: number; label: string } {
    const ids = this.deps.knowledge.scopeRecordingIds(scope);
    return { recordings: ids.length, withTranscript: ids.filter((id) => this.deps.transcripts.current(id)).length, label: this.deps.knowledge.scopeLabel(scope) };
  }

  ask(threadId: string, question: string): AiOutcome {
    const text = question.trim();
    if (!text) throw new Error('Type a question first.');
    if (text.length > MAX_QUESTION_CHARS) throw new Error(`Questions can be up to ${MAX_QUESTION_CHARS.toLocaleString()} characters.`);
    const thread = this.deps.chats.get(threadId);
    if (!thread) throw new Error('This chat no longer exists.');
    if (this.deps.chats.hasPending(threadId)) throw new Error('Wait for the current answer first.');
    const checked = this.check(thread.scope);
    if (!checked.ok) return checked;
    const { provider, model } = this.providerChoice();
    const { answerId } = this.deps.chats.addQuestion(threadId, text, provider, model);
    this.deps.changed();
    void this.answer(answerId);
    return { ok: true, jobId: answerId };
  }

  retry(answerId: string): AiOutcome {
    const found = this.deps.chats.questionFor(answerId);
    if (!found) throw new Error('This answer no longer exists.');
    const thread = this.deps.chats.get(found.threadId);
    if (!thread) throw new Error('This chat no longer exists.');
    if (this.running.has(answerId)) return { ok: true, jobId: answerId };
    const checked = this.check(thread.scope);
    if (!checked.ok) return checked;
    const { provider, model } = this.providerChoice();
    this.deps.chats.restart(answerId, provider, model);
    this.deps.changed();
    void this.answer(answerId);
    return { ok: true, jobId: answerId };
  }

  cancel(answerId: string): void {
    this.running.get(answerId)?.abort();
    this.deps.chats.fail(answerId, 'Stopped.');
    this.deps.changed();
  }

  private providerChoice(): { provider: LlmProviderId; model: string } {
    return llmChoice(this.deps.settings());
  }

  private check(scope: ChatScope): AiOutcome {
    if (this.scopeInfo(scope).withTranscript === 0) return { ok: false, reason: 'needs-transcript' };
    return this.deps.blockedBy(llmChoice(this.deps.settings()).provider) ?? { ok: true, jobId: '' };
  }

  private load(id: string): Loaded | null {
    const recording = this.deps.library.getRecording(id);
    const version = this.deps.transcripts.current(id);
    if (!recording || !version || recording.deletedAt !== null) return null;
    return { id, title: recording.title, createdAt: recording.createdAt, durationMs: recording.durationMs, language: version.language, segments: this.deps.transcripts.segments(version.id) };
  }

  private async answer(answerId: string): Promise<void> {
    const controller = new AbortController();
    this.running.set(answerId, controller);
    try {
      const found = this.deps.chats.questionFor(answerId);
      const thread = found ? this.deps.chats.get(found.threadId) : null;
      if (!found || !thread) return;
      const { provider: providerId, model } = this.providerChoice();
      // Checked again just before anything is sent, in case settings changed.
      const blocked = this.deps.blockedBy(providerId);
      if (blocked) throw new Error(blocked.reason === 'offline-only' ? 'Offline only is on, so nothing was sent.' : 'This provider needs setup or your agreement before anything is sent.');
      const provider = this.deps.makeProvider(providerId);
      const info = LLM_PROVIDER_INFO[providerId];
      const call = (messages: ChatMessage[], maxOutputTokens: number, json: boolean, task: ChatTask) => this.complete(provider, providerId, { messages, model, maxOutputTokens, json, task, signal: controller.signal });

      const inputBudget = Math.min(info.maxInputChars, CONTEXT_CAP_CHARS);
      const history = historyForPrompt(found.earlier, Math.min(3000, Math.round(inputBudget * 0.15)));
      const historyChars = history.reduce((sum, h) => sum + h.content.length, 0);
      const budget = Math.max(MIN_CONTEXT_CHARS, inputBudget - historyChars - found.question.length - PROMPT_OVERHEAD_CHARS);

      // Transcripts from before passages existed are indexed now if the background pass has not reached them.
      this.deps.transcripts.indexMissingPassages();
      const scopeIds = this.deps.knowledge.scopeRecordingIds(thread.scope);
      const selected = await this.select(scopeIds, found.question, history, budget, (messages) => call(messages, PLAN_MAX_TOKENS, true, 'chat-plan'));
      const { text: context, targets } = buildContext(selected.recordings);

      const messages = answerMessages({ context, scopeLabel: thread.scopeLabel, readNote: selected.modelNote, history, question: found.question });
      let reply = await call(messages, ANSWER_MAX_TOKENS, true, 'chat');
      let answer = readAnswer(reply);
      if (!answer) {
        // Free models sometimes slip out of JSON. One more try, then plain text is accepted as the answer.
        reply = await call(messages, ANSWER_MAX_TOKENS, true, 'chat');
        answer = readAnswer(reply) ?? answerFromPlainText(reply);
      }
      const main = resolveChatCitations(answer.answer, targets);
      const general = resolveChatCitations(answer.general, targets);
      const sources: ChatSource[] = main.used.map((t) => ({ recordingId: t.recordingId, recordingTitle: t.recordingTitle, startMs: t.startMs, text: t.text.length > 240 ? `${t.text.slice(0, 239)}…` : t.text }));
      this.deps.chats.finish(answerId, { content: main.markdown, found: answer.found, general: general.markdown, sources, readNote: selected.userNote, dropped: main.dropped + general.dropped, read: selected.recordings.map((r) => r.id) });
    } catch (e) {
      if (controller.signal.aborted) return;
      try {
        this.deps.chats.fail(answerId, e instanceof Error ? e.message : String(e));
      } catch {
        // The database closed (EchoMind is quitting). The answer is marked as interrupted at next launch.
      }
    } finally {
      this.running.delete(answerId);
      try {
        this.deps.changed();
      } catch {
        /* the window is gone */
      }
    }
  }

  /** One request. Short rate-limit waits and network blips are retried here, so the answer does not fail. */
  private async complete(provider: ChatProvider, providerId: LlmProviderId, request: Parameters<ChatProvider['complete']>[0]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await provider.complete(request);
        this.deps.usage.record(providerId, 1, 0, result.inputTokens, result.outputTokens);
        if (result.rate) this.deps.usage.saveRate(providerId, result.rate);
        return result.text;
      } catch (e) {
        // Up to three more tries. On Groq's free tier, a question about a long recording often meets the
        // per-minute limit twice in a row, and a slow connection can drop more than once (both seen live).
        const more = attempt < MAX_CHAT_RETRIES;
        if (more && e instanceof ProviderError && e.kind === 'rate' && (e.retryAfterMs ?? 0) <= SHORT_WAIT_MS) {
          await this.wait(e.retryAfterMs ?? 5000, request.signal);
          continue;
        }
        if (more && e instanceof ProviderError && (e.kind === 'network' || e.kind === 'server')) {
          await this.wait(3000 * (attempt + 1), request.signal);
          continue;
        }
        if (e instanceof ProviderError && (e.kind === 'rate' || e.kind === 'quota')) {
          const seconds = e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : null;
          throw new Error(`${e.message}${seconds ? ` Try again in about ${seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.` : ''}`);
        }
        throw e;
      }
    }
  }

  /**
   * Chooses what the model reads. Everything, when it fits. Otherwise a short plan from the model turns
   * the question (and the conversation) into searches, a time range, or a request for an overview, and
   * BM25 finds the passages. Results from several searches are merged by reciprocal rank fusion.
   */
  private async select(scopeIds: string[], question: string, history: HistoryTurn[], budget: number, plan: (messages: ChatMessage[]) => Promise<string>): Promise<{ recordings: ContextRecording[]; modelNote: string; userNote: string }> {
    const cache = new Map<string, Loaded | null>();
    const get = (id: string) => {
      if (!cache.has(id)) cache.set(id, this.load(id));
      return cache.get(id) ?? null;
    };
    const withTranscript = scopeIds.filter((id) => this.deps.transcripts.current(id));
    const n = withTranscript.length;
    const toContext = (loaded: Loaded, segments: Segment[], complete: boolean): ContextRecording => ({
      id: loaded.id,
      title: loaded.title,
      createdAt: loaded.createdAt,
      durationMs: loaded.durationMs,
      speakers: this.deps.transcripts.speakerNames(loaded.id),
      segments,
      complete,
    });

    // Small enough to read whole: the best possible grounding, and absence of something is meaningful.
    if (n <= MAX_OVERVIEW_RECORDINGS) {
      const all = withTranscript.map(get).filter((x): x is Loaded => x !== null);
      if (all.reduce((sum, r) => sum + promptChars(r.segments), 0) <= budget) {
        return {
          recordings: all.map((r) => toContext(r, r.segments, true)),
          modelNote: n === 1 ? 'This is the full transcript.' : `These are the full transcripts of ${n} recordings.`,
          userNote: n === 1 ? 'Read the full transcript' : `Read the full transcripts of ${n} recordings`,
        };
      }
    }

    let chatPlan: ChatPlan = { search: [], fromMinute: null, toMinute: null, overview: false };
    try {
      const recordings = withTranscript.slice(0, 20).map((id) => {
        const r = this.deps.library.getRecording(id);
        return { title: r?.title ?? 'Recording', language: this.deps.transcripts.current(id)?.language ?? null };
      });
      chatPlan = validatePlan(parseJsonReply(await plan(planMessages({ question, history, recordings, more: Math.max(0, n - 20) }))));
    } catch (e) {
      // Without a plan, the question's own words still make a good search. Limits and keys still fail loudly.
      if (e instanceof ProviderError || (e as Error | null)?.name === 'AbortError') throw e;
    }

    const chosen = new Map<string, Set<number>>();
    let used = 0;
    const take = (loaded: Loaded, segments: Segment[], limit: number): boolean => {
      const set = chosen.get(loaded.id) ?? new Set<number>();
      const fresh = segments.filter((s) => !set.has(s.idx));
      const cost = promptChars(fresh);
      if (!fresh.length) return true;
      if (used + cost > limit) return false;
      for (const s of fresh) set.add(s.idx);
      chosen.set(loaded.id, set);
      used += cost;
      return true;
    };

    // "Summarize them", "compare these": an even selection from each, when there are few enough.
    if (chatPlan.overview && n <= MAX_OVERVIEW_RECORDINGS) {
      const share = Math.floor(budget / n);
      for (const id of withTranscript) {
        const loaded = get(id);
        if (loaded) take(loaded, spreadSample(loaded.segments, share - 200), budget);
      }
      return this.finish(chosen, get, toContext, n, 'overview');
    }

    // "The first 20 minutes": that stretch, evenly selected if it is long.
    if (chatPlan.fromMinute !== null && n <= 3) {
      const from = chatPlan.fromMinute * 60_000;
      const to = chatPlan.toMinute !== null ? chatPlan.toMinute * 60_000 : Number.POSITIVE_INFINITY;
      for (const id of withTranscript) {
        const loaded = get(id);
        if (!loaded) continue;
        const range = loaded.segments.filter((s) => s.startMs < to && s.endMs > from);
        take(loaded, spreadSample(range, Math.floor((budget * 0.7) / n)), budget);
      }
    }

    const queries = [question, ...chatPlan.search];
    const lists = queries.map((q) => {
      const fts = anyTermQuery(searchTerms(q));
      return fts ? this.deps.knowledge.searchPassages(fts, withTranscript, 40) : [];
    });
    const fused = fuseRankings<PassageHit>(lists, (h) => `${h.recordingId}:${h.firstIdx}`);

    const addPassage = (hit: PassageHit): boolean => {
      const loaded = get(hit.recordingId);
      if (!loaded) return true;
      return take(loaded, loaded.segments.filter((s) => s.idx >= hit.firstIdx && s.idx <= hit.lastIdx), budget);
    };
    // Across many recordings, the best passage of each comes first, so one long recording cannot crowd out the rest.
    const firstOfEach = new Set<string>();
    if (n > 1) {
      for (const hit of fused) {
        if (firstOfEach.has(hit.recordingId) || used > budget * 0.6) continue;
        firstOfEach.add(hit.recordingId);
        addPassage(hit);
      }
    }
    for (const hit of fused) {
      if (!addPassage(hit) && used > budget - 400) break;
    }

    // Nothing matched in a few recordings: the words may simply differ, so show an even selection.
    if (!chosen.size && n <= 3) {
      for (const id of withTranscript) {
        const loaded = get(id);
        if (loaded) take(loaded, spreadSample(loaded.segments, Math.floor(budget / n) - 200), budget);
      }
      return this.finish(chosen, get, toContext, n, 'overview');
    }
    return this.finish(chosen, get, toContext, n, 'search');
  }

  private finish(chosen: Map<string, Set<number>>, get: (id: string) => Loaded | null, toContext: (l: Loaded, s: Segment[], complete: boolean) => ContextRecording, n: number, how: 'search' | 'overview') {
    const recordings: ContextRecording[] = [];
    let passages = 0;
    for (const [id, set] of chosen) {
      const loaded = get(id);
      if (!loaded) continue;
      const segments = loaded.segments.filter((s) => set.has(s.idx));
      // Count runs of consecutive lines as passages, for an honest note of what was read.
      passages += segments.filter((s, i) => i === 0 || s.idx !== segments[i - 1]!.idx + 1).length;
      recordings.push(toContext(loaded, segments, segments.length === loaded.segments.length));
    }
    const of = `${recordings.length} of ${plural(n, 'recording')}`;
    if (!recordings.length) {
      return { recordings, modelNote: `No passages in ${plural(n, 'recording')} matched the question.`, userNote: `Searched ${plural(n, 'recording')}; nothing matched` };
    }
    if (how === 'overview') {
      return {
        recordings,
        modelNote: `The recordings are too long to include whole, so this is an even selection of lines from ${of}.`,
        userNote: `Read an even selection from ${of}`,
      };
    }
    return {
      recordings,
      modelNote: `These are the passages that best match the question, from ${of}. Other parts of the recordings were not included.`,
      userNote: `Read ${plural(passages, 'passage')} from ${of}`,
    };
  }

  /** At launch: answers interrupted by a quit are marked, so they can be asked again. */
  recover(): void {
    this.deps.chats.failInterrupted();
  }

  turns(threadId: string): ChatTurn[] {
    return this.deps.chats.turns(threadId);
  }
}
