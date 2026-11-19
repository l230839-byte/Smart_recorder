import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeChatProvider } from '../../src/main/ai/fake-chat';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from '../../src/main/ai/types';
import { openDatabase, type Db } from '../../src/main/db/database';
import { LibraryRepository } from '../../src/main/db/library';
import { StudioRepository, TaskRepository } from '../../src/main/db/studio';
import { SummaryRepository } from '../../src/main/db/summaries';
import { JobRepository, TranscriptRepository, UsageRepository } from '../../src/main/db/transcripts';
import { JobQueue } from '../../src/main/services/job-queue';
import { splitMarkdown, StudioService } from '../../src/main/services/studio';
import type { CitationTarget, ContextRecording } from '../../src/shared/chat';
import { DEFAULT_SETTINGS, type AiOutcome, type Settings } from '../../src/shared/models';
import {
  contextPieces,
  DEFAULT_STUDIO_OPTIONS,
  interleave,
  scoreQuiz,
  shareCount,
  studioMarkdown,
  validateFlashcards,
  validateMindMap,
  validateQuiz,
  validateTasks,
  validateTranslation,
  type StudioKind,
  type QuizQuestion,
  type StudioOptions,
} from '../../src/shared/studio';
import type { Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, text: string, speaker: string | null = null): Segment => ({ idx, startMs, endMs: startMs + 4000, text, speaker, confidence: null });
const A = '11111111-1111-4111-8111-111111111111';

const recording = (segments: Segment[], over: Partial<ContextRecording> = {}): ContextRecording => ({ id: A, title: 'Lecture', createdAt: Date.UTC(2026, 2, 9), durationMs: 600_000, speakers: {}, segments, complete: true, ...over });

describe('pieces', () => {
  it('number lines across recordings, repeat headers in each piece, and fit the size', () => {
    const lines = Array.from({ length: 30 }, (_, i) => seg(i, i * 4000, `Line number ${i} with some words.`));
    const { pieces, targets, sizes } = contextPieces([recording(lines), recording([seg(0, 0, 'Other')], { id: 'b', title: 'Meeting' })], 400);
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) {
      expect(p.startsWith('=== RECORDING')).toBe(true);
      expect(p.length).toBeLessThan(400 + 120);
    }
    expect(pieces.at(-1)).toContain('=== RECORDING 2: "Meeting"');
    expect(pieces.at(-1)).toContain('[S31 0:00] Other');
    expect(targets.size).toBe(31);
    expect(sizes).toHaveLength(pieces.length);
    expect(shareCount(10, [100, 300])).toEqual([3, 8]);
    expect(shareCount(2, [10, 10, 10])).toEqual([1, 1, 1]);
  });

  it('long Markdown splits at blank lines only', () => {
    expect(splitMarkdown('a\n\nb\n\nc', 3)).toEqual(['a', 'b', 'c']);
    expect(splitMarkdown('one\ntwo\n\nthree', 100)).toEqual(['one\ntwo\n\nthree']);
  });

  it('items are taken evenly from each piece', () => {
    expect(interleave([[1, 2, 3], [4], [5, 6]], 5)).toEqual([1, 4, 5, 2, 6]);
  });
});

describe('validation', () => {
  const targets = new Map<number, CitationTarget>([[3, { recordingId: A, recordingTitle: 'L', startMs: 9000, text: 'Gradient descent' }]]);

  it('flashcards keep good cards, link real sources and count invented ones', () => {
    const { cards, dropped } = validateFlashcards({ cards: [{ front: 'Q', back: 'A', source: 3 }, { front: 'Q2', back: 'A2', source: 99, supplemental: true }, { front: '', back: 'x' }] }, targets);
    expect(cards).toEqual([
      { front: 'Q', back: 'A', source: { recordingId: A, startMs: 9000 }, supplemental: false },
      { front: 'Q2', back: 'A2', source: null, supplemental: true },
    ]);
    expect(dropped).toBe(1);
    expect(() => validateFlashcards({ nope: [] }, targets)).toThrow(/could not read/);
  });

  it('quiz questions must be answerable: one real correct option, a true or false answer, a model answer', () => {
    const { questions } = validateQuiz(
      {
        questions: [
          { type: 'mcq', question: 'Pick', options: ['a', 'b', 'c', 'd'], answer: 'B', source: 'S3' },
          { type: 'mcq', question: 'Dup', options: ['a', 'a', 'c', 'd'], answer: 'a' },
          { type: 'mcq', question: 'Missing', options: ['a', 'b'], answer: 'z' },
          { type: 'tf', question: 'Yes?', answer: 'true', explanation: 'Because', explanation_supplemental: true },
          { type: 'tf', question: 'Maybe?', answer: 'maybe' },
          { type: 'short', question: 'Why?', answer: 'Reason' },
          { type: 'long', question: 'Not asked for', answer: 'x' },
        ],
      },
      targets,
      ['mcq', 'tf', 'short'],
    );
    expect(questions.map((q) => [q.type, q.question, q.answer])).toEqual([
      ['mcq', 'Pick', 'b'],
      ['tf', 'Yes?', 'True'],
      ['short', 'Why?', 'Reason'],
    ]);
    expect(questions[0]!.source).toEqual({ recordingId: A, startMs: 9000 });
    expect(questions[1]!.explanationSupplemental).toBe(true);
  });

  it('mind maps are limited in depth and size, and must have branches', () => {
    const deep = { label: 'd4', children: [{ label: 'd5', children: [] }] };
    const root = validateMindMap({ root: { label: 'Root', children: [{ label: 'B', source: 3, children: [{ label: 'C', children: [{ label: 'D', children: [deep] }] }] }] } }, targets);
    expect(root.children[0]!.source).toEqual({ recordingId: A, startMs: 9000 });
    expect(root.children[0]!.children[0]!.children[0]!.children).toEqual([]);
    expect(() => validateMindMap({ root: { label: 'Alone', children: [] } }, targets)).toThrow();
  });

  it('tasks: duplicates removed, only real dates, priority only when given', () => {
    const tasks = validateTasks(
      {
        tasks: [
          { title: 'Send the report', due_date: '2026-03-20', due_text: 'by Friday', owner: 'Ahmed', priority: 'high', source: 3 },
          { title: 'send the report', due_date: '2026-03-13' },
          { title: 'Plan', due_date: 'next week', priority: 'urgent' },
          { title: '' },
        ],
      },
      targets,
      '2026-03-09',
    );
    // The model's own date (2026-03-20) is ignored: "by Friday" from Monday 9 March is 13 March.
    expect(tasks).toEqual([
      { title: 'Send the report', description: '', dueDate: '2026-03-13', dueText: 'by Friday', owner: 'Ahmed', priority: 'high', source: { recordingId: A, startMs: 9000, text: 'Gradient descent' } },
      { title: 'Plan', description: '', dueDate: null, dueText: '', owner: '', priority: null, source: null },
    ]);
    expect([...validateTranslation({ lines: [{ id: 3, text: 'Descenso' }, { id: 9, text: 'x' }] }, targets)]).toEqual([[3, 'Descenso']]);
  });
});

describe('Markdown for documents, and quiz scoring', () => {
  it('every kind becomes readable Markdown, with times linked and AI explanations marked', () => {
    const src = { recordingId: A, startMs: 65_000 };
    expect(studioMarkdown({ type: 'flashcards', cards: [{ front: 'Q | x', back: 'A', source: src, supplemental: true }] }, 'T')).toContain('| Q / x | A (AI explanation) [1:05](cite:65000) |');
    const quiz = studioMarkdown(
      { type: 'quiz', questions: [{ type: 'mcq', question: 'Pick', options: ['a', 'b'], answer: 'b', explanation: 'Why', explanationSupplemental: false, source: src }] },
      'T',
    );
    expect(quiz).toContain('1. **Pick** _(Multiple choice)_');
    expect(quiz).toContain('   B. b');
    expect(quiz).toContain('## Answer key\n\n1. B. b [1:05](cite:65000). Why');
    expect(studioMarkdown({ type: 'mindmap', root: { label: 'R', source: null, children: [{ label: 'C', source: src, children: [] }] } }, 'T')).toContain('- **R**\n  - C [1:05](cite:65000)');
    expect(studioMarkdown({ type: 'translation', language: 'Urdu', lines: [{ startMs: 0, original: 'Hi', text: 'سلام' }] }, 'T')).toContain('[0:00](cite:0) سلام');
  });

  it('multiple choice and true or false are marked automatically; written answers by the learner', () => {
    const qs: QuizQuestion[] = [
      { type: 'mcq', question: '', options: ['a', 'b'], answer: 'b', explanation: '', explanationSupplemental: false, source: null },
      { type: 'tf', question: '', options: [], answer: 'False', explanation: '', explanationSupplemental: false, source: null },
      { type: 'short', question: '', options: [], answer: 'x', explanation: '', explanationSupplemental: false, source: null },
    ];
    expect(
      scoreQuiz(qs, [
        { given: 'b', selfMarked: null },
        { given: 'True', selfMarked: null },
        { given: 'my words', selfMarked: true },
      ]),
    ).toEqual({ score: 2, total: 3, correct: [true, false, true] });
  });
});

class ScriptedProvider implements ChatProvider {
  requests: ChatRequest[] = [];
  constructor(private readonly reply: (request: ChatRequest, n: number) => string | Error) {}
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const r = this.reply(request, this.requests.length);
    if (r instanceof Error) throw r;
    return { text: r, truncated: false, inputTokens: 1, outputTokens: 1, rate: null };
  }
  async testConnection(): Promise<void> {}
}

describe('Studio on a real database', () => {
  let db: Db;
  let library: LibraryRepository;
  let transcripts: TranscriptRepository;
  let jobs: JobRepository;
  let studio: StudioRepository;
  let tasks: TaskRepository;
  let summaries: SummaryRepository;
  let queue: JobQueue;
  let settings: Settings;
  let blocked: Exclude<AiOutcome, { ok: true }> | null;
  let provider: ChatProvider;
  let service: StudioService;
  let lecture: string;
  let meeting: string;

  const rec = (title: string) =>
    library.insertRecording({ title, mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 600_000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: `${title}.ogg`, mime: 'audio/ogg', peaks: new Uint8Array(4) });
  const opts = (over: Partial<StudioOptions> = {}): StudioOptions => ({ ...DEFAULT_STUDIO_OPTIONS, ...over });
  const run = async (kind: StudioKind, ids: string[], over: Partial<StudioOptions> = {}) => {
    const out = service.start({ kind, recordingIds: ids, options: opts(over) });
    if (!out.ok) throw new Error(out.reason);
    await finish(out.outputId);
    return { id: out.outputId, output: studio.get(out.outputId)!, job: service.jobFor(out.outputId)! };
  };
  const finish = async (outputId: string) => {
    for (let i = 0; i < 400; i++) {
      const job = service.jobFor(outputId);
      if (job && ['done', 'failed', 'canceled', 'waiting'].includes(job.status)) return;
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    library = new LibraryRepository(db);
    transcripts = new TranscriptRepository(db);
    jobs = new JobRepository(db);
    studio = new StudioRepository(db);
    tasks = new TaskRepository(db, () => Date.UTC(2026, 2, 10, 12));
    summaries = new SummaryRepository(db);
    settings = { ...DEFAULT_SETTINGS, offlineOnly: false, llmProvider: 'fake' };
    blocked = null;
    provider = new FakeChatProvider(0);
    queue = new JobQueue(jobs, () => undefined, { schedule: () => undefined });
    service = new StudioService({
      studio,
      tasks,
      jobs,
      queue,
      library,
      transcripts,
      summaries,
      usage: new UsageRepository(db),
      settings: () => settings,
      makeProvider: () => provider,
      blockedBy: () => blocked,
      changed: () => undefined,
      ready: () => undefined,
    });
    lecture = rec('Lecture');
    transcripts.addOriginal(lecture, 'groq', 'm', 'en', [seg(0, 0, 'Neural networks learn from data.'), seg(1, 5000, 'Gradient descent adjusts weights.'), seg(2, 10_000, 'You must submit the assignment on Friday.')]);
    meeting = rec('Meeting');
    transcripts.addOriginal(meeting, 'groq', 'm', 'en', [seg(0, 0, 'Ahmed will send the report.')]);
  });

  afterEach(async () => {
    queue.stop();
    await new Promise((r) => setTimeout(r, 10));
    db.close();
  });

  it('flashcards, a quiz and a mind map are made and saved with their recording', async () => {
    const cards = await run('flashcards', [lecture], { count: 3 });
    expect(cards.job.status).toBe('done');
    expect(cards.output).toMatchObject({ kind: 'flashcards', title: 'Flashcards: Lecture', recordingIds: [lecture], recordingTitles: ['Lecture'] });
    expect(cards.output.content).toMatchObject({ type: 'flashcards' });
    if (cards.output.content?.type === 'flashcards') {
      expect(cards.output.content.cards).toHaveLength(3);
      expect(cards.output.content.cards[1]).toMatchObject({ back: 'Gradient descent adjusts weights.', source: { recordingId: lecture, startMs: 5000 } });
    }
    const quiz = await run('quiz', [lecture], { count: 3, questionTypes: ['mcq', 'tf'] });
    expect(quiz.output.content?.type === 'quiz' && quiz.output.content.questions.map((q) => q.type)).toEqual(['mcq', 'tf', 'mcq']);
    const map = await run('mindmap', [lecture]);
    expect(map.output.content?.type === 'mindmap' && map.output.content.root.children.length).toBe(3);
    expect(studio.list(lecture).map((o) => o.kind)).toEqual(['mindmap', 'quiz', 'flashcards']);
  });

  it('action items wait for review, and finding them again adds no duplicates', async () => {
    await run('tasks', [lecture]);
    const found = tasks.list({ status: 'suggested' });
    expect(found.map((t) => t.title)).toEqual(['Demo: You must submit the assignment on Friday']);
    expect(found[0]).toMatchObject({ recordingId: lecture, startMs: 10_000, sourceText: 'You must submit the assignment on Friday.' });
    const again = await run('tasks', [lecture]);
    expect(again.output.content).toEqual({ type: 'tasks', count: 0 });
    expect(tasks.list({ status: 'suggested' })).toHaveLength(1);
  });

  it('a transcript is translated line by line with its times; a summary is translated as Markdown', async () => {
    const t = await run('translate', [lecture], { targetLanguage: 'Urdu' });
    expect(t.output.title).toBe('Translation (Urdu): Lecture');
    expect(t.output.content?.type === 'translation' && t.output.content.lines[2]).toEqual({ startMs: 10_000, original: 'You must submit the assignment on Friday.', text: '[Demo translation] You must submit the assignment on Friday.' });
    const sid = summaries.add({ recordingId: lecture, label: 'x', options: {} as never, markdown: '## Points\n\n- Data [0:00](cite:0)', provider: 'fake', model: 'demo', transcriptVersionId: null, droppedCitations: 0, truncated: false });
    const s = await run('translate', [lecture], { targetLanguage: 'Urdu', translateSource: 'summary', summaryId: sid });
    expect(s.output.content?.type === 'markdown' && s.output.content.markdown).toContain('- Data [0:00](cite:0)');
    expect(() => service.start({ kind: 'translate', recordingIds: [meeting], options: opts({ translateSource: 'summary', summaryId: sid }) })).toThrow(/summary of this recording/);
  });

  it('written tools read long material in parts, keep each part, and finish with one result with checked citations', async () => {
    const long = rec('Long');
    transcripts.addOriginal(long, 'groq', 'm', 'en', Array.from({ length: 400 }, (_, i) => seg(i, i * 4000, `Long line ${i} about many important things in the course.`)));
    settings = { ...settings, llmProvider: 'groq' };
    let failOnce = true;
    const scripted = new ScriptedProvider((req, n) => {
      const user = req.messages.at(-1)!.content;
      if (user.includes('This is part 2') && failOnce) {
        failOnce = false;
        return new ProviderError('server', 'Temporary problem.');
      }
      if (user.includes('NOTES:')) return '# Guide\n\nCombined [S1] and [S9999].';
      return `- Notes ${n} [S1]`;
    });
    provider = scripted;
    const first = service.start({ kind: 'study', recordingIds: [long], options: opts({ studyType: 'revision' }) });
    if (!first.ok) throw new Error('blocked');
    await finish(first.outputId);
    // The failed part waits to be tried again; the parts already done are kept.
    const job = service.jobFor(first.outputId)!;
    expect(job.status).toBe('waiting');
    const before = scripted.requests.length;
    jobs.requeue(job.id);
    queue.pump();
    await finish(first.outputId);
    const parts = scripted.requests.filter((r) => r.messages.at(-1)!.content.includes('This is part')).length;
    const total = Number(/of (\d+)\./.exec(scripted.requests[0]!.messages.at(-1)!.content)![1]);
    expect(parts).toBe(total + 1);
    expect(scripted.requests.length - before).toBe(total - 1 + 1);
    const output = studio.get(first.outputId)!;
    expect(output.title).toBe('Revision sheet: Long');
    expect(output.content).toEqual({ type: 'markdown', markdown: `# Guide\n\nCombined [0:00](cite:0@${long}) and.` });
    expect(output.droppedCitations).toBe(1);
  });

  it('a comparison needs two recordings and names each in its citations', async () => {
    expect(() => service.start({ kind: 'compare', recordingIds: [lecture], options: opts() })).toThrow(/at least 2/);
    provider = new ScriptedProvider(() => 'Lecture says [S1]; meeting says [S4].');
    const c = await run('compare', [lecture, meeting]);
    expect(c.output.content?.type === 'markdown' && c.output.content.markdown).toBe(`Lecture says [Lecture 0:00](cite:0@${lecture}); meeting says [Meeting 0:00](cite:0@${meeting}).`);
  });

  it('nothing starts when the provider is blocked or a transcript is missing', () => {
    blocked = { ok: false, reason: 'needs-consent', provider: 'groq', purpose: 'text' };
    expect(service.start({ kind: 'quiz', recordingIds: [lecture], options: opts() })).toEqual(blocked);
    blocked = null;
    const empty = rec('Empty');
    expect(service.start({ kind: 'quiz', recordingIds: [empty], options: opts() })).toEqual({ ok: false, reason: 'needs-transcript' });
    expect(() => service.start({ kind: 'translate', recordingIds: [lecture, meeting], options: opts() })).toThrow(/up to 1/);
    expect(studio.list()).toEqual([]);
  });

  it('deleting a recording deletes its results and unapproved tasks; approved tasks stay without its words', async () => {
    await run('flashcards', [lecture], { count: 2 });
    await run('compare', [lecture, meeting]);
    await run('tasks', [lecture]);
    tasks.addSuggestions([lecture], [{ title: 'Approved one', description: '', dueDate: null, dueText: '', owner: '', priority: null, source: { recordingId: lecture, startMs: 0, text: 'secret words' } }]);
    const approved = tasks.list({ status: 'suggested' }).find((t) => t.title === 'Approved one')!;
    tasks.update(approved.id, { status: 'open' });
    library.deleteForever([lecture]);
    expect(studio.list()).toEqual([]);
    expect(tasks.list()).toEqual([expect.objectContaining({ title: 'Approved one', recordingId: null, sourceText: '', startMs: null, status: 'open' })]);
  });
});

describe('tasks', () => {
  let db: Db;
  let now: number;
  let tasks: TaskRepository;
  beforeEach(() => {
    db = openDatabase(':memory:');
    now = Date.UTC(2026, 2, 10, 9);
    tasks = new TaskRepository(db, () => now);
  });
  afterEach(() => db.close());

  it('are created, edited, completed, searched and counted, with overdue ones flagged', () => {
    const a = tasks.create({ title: 'Send report', dueDate: '2026-03-09' });
    const b = tasks.create({ title: 'Book room', description: 'For Thursday' });
    expect(() => tasks.create({ title: '  ' })).toThrow(/needs a title/);
    expect(() => tasks.update(a, { dueDate: 'tomorrow' })).toThrow(/2026-03-14/);
    expect(tasks.counts()).toEqual({ suggested: 0, open: 2, overdue: 1 });
    tasks.update(a, { status: 'done' });
    expect(tasks.get(a)!.completedAt).toBe(now);
    tasks.update(a, { status: 'open' });
    expect(tasks.get(a)!.completedAt).toBeNull();
    expect(tasks.list({ text: 'thursday' }).map((t) => t.id)).toEqual([b]);
    expect(tasks.list().map((t) => t.id)).toEqual([a, b]);
    tasks.update(b, { status: 'dismissed' });
    expect(tasks.list().map((t) => t.id)).toEqual([a]);
  });

  it('reminders fire once, only for open tasks, and again only if the time is changed', () => {
    const a = tasks.create({ title: 'Call client' });
    const b = tasks.create({ title: 'Done already' });
    tasks.update(a, { remindAt: now - 1000 });
    tasks.update(b, { remindAt: now - 1000, status: 'done' });
    tasks.update(tasks.create({ title: 'Later' }), { remindAt: now + 60_000 });
    expect(tasks.takeDueReminders().map((t) => t.title)).toEqual(['Call client']);
    expect(tasks.takeDueReminders()).toEqual([]);
    tasks.update(a, { remindAt: now - 500 });
    expect(tasks.takeDueReminders().map((t) => t.title)).toEqual(['Call client']);
  });
});
