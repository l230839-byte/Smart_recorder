import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeChatProvider } from '../../src/main/ai/fake-chat';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from '../../src/main/ai/types';
import { ChatRepository } from '../../src/main/db/chats';
import { openDatabase, type Db } from '../../src/main/db/database';
import { KnowledgeRepository } from '../../src/main/db/knowledge';
import { LibraryRepository } from '../../src/main/db/library';
import { SummaryRepository } from '../../src/main/db/summaries';
import { TranscriptRepository, UsageRepository } from '../../src/main/db/transcripts';
import { DocumentRepository } from '../../src/main/db/documents';
import { ChatService } from '../../src/main/services/chat';
import {
  answerFromPlainText,
  buildContext,
  historyForPrompt,
  readAnswer,
  resolveChatCitations,
  validatePlan,
  type ChatTurn,
  type ContextRecording,
} from '../../src/shared/chat';
import { parseInline } from '../../src/shared/markdown';
import { DEFAULT_SETTINGS, type AiOutcome, type Settings } from '../../src/shared/models';
import { anyTermQuery, chunkSegments, fuseRankings, searchTerms, spreadSample } from '../../src/shared/retrieval';
import { snippetParts, MATCH_END, MATCH_START } from '../../src/shared/search';
import { DEFAULT_DOCUMENT_SETTINGS } from '../../src/shared/documents';
import type { Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, text: string, speaker: string | null = null): Segment => ({ idx, startMs, endMs: startMs + 4000, text, speaker, confidence: null });

describe('passages', () => {
  it('group lines up to the size, overlapping by one line', () => {
    const lines = Array.from({ length: 10 }, (_, i) => seg(i, i * 5000, 'x'.repeat(190)));
    const chunks = chunkSegments(lines, 700);
    expect(chunks.map((c) => [c.firstIdx, c.lastIdx])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
      [6, 8],
      [8, 9],
    ]);
    expect(chunks[1]!.startMs).toBe(10_000);
    expect(chunks[1]!.endMs).toBe(24_000);
  });

  it('cope with very long lines, empty lines and empty transcripts', () => {
    const chunks = chunkSegments([seg(0, 0, 'a'.repeat(900)), seg(1, 1, '  '), seg(2, 2, 'b'.repeat(900)), seg(3, 3, 'short')], 700);
    // A line longer than a passage stands alone; the next one starts fresh.
    expect(chunks.map((c) => [c.firstIdx, c.lastIdx])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
    expect(chunkSegments([])).toEqual([]);
  });

  it('never repeat a line on its own', () => {
    const chunks = chunkSegments([seg(0, 0, 'a'.repeat(400)), seg(1, 1, 'b'.repeat(250)), seg(2, 2, 'c'.repeat(900))], 700);
    expect(chunks.map((c) => [c.firstIdx, c.lastIdx])).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });
});

describe('search terms', () => {
  it('drop filler words in English and Urdu, keep meaning, and are safe for FTS5', () => {
    expect(searchTerms('What did the teacher explain about Neural Networks?')).toEqual(['teacher', 'neural', 'networks']);
    expect(searchTerms('استاد نے نیورل نیٹ ورک کے بارے میں کیا کہا')).toEqual(['استاد', 'نیورل', 'نیٹ', 'ورک', 'بارے', 'کہا']);
    expect(searchTerms('Is 3 the "answer"? a')).toEqual(['3', 'answer']);
    expect(anyTermQuery(['network', 'ai'])).toBe('"network"* OR "ai"');
    expect(anyTermQuery([])).toBeNull();
  });

  it('rank fusion favours what several searches agree on', () => {
    const fused = fuseRankings([['a', 'b', 'c'], ['c', 'b'], ['b']], (x) => x);
    expect(fused).toEqual(['b', 'c', 'a']);
  });

  it('an even selection stays inside the budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => seg(i, i, 'y'.repeat(80)));
    const sample = spreadSample(lines, 2000);
    expect(sample.reduce((s, l) => s + l.text.length + 20, 0)).toBeLessThanOrEqual(2000);
    expect(sample[0]!.idx).toBe(0);
    expect(sample.at(-1)!.idx).toBeGreaterThan(80);
  });
});

describe('context and citations', () => {
  const recordings: ContextRecording[] = [
    { id: '11111111-1111-4111-8111-111111111111', title: 'Lecture "One"', createdAt: Date.UTC(2026, 0, 2), durationMs: 600_000, speakers: { A: 'Dr. Khan' }, segments: [seg(0, 0, 'Hello', 'A'), seg(1, 4000, 'Gradients', 'A'), seg(5, 65_000, 'Later')], complete: false },
    { id: '22222222-2222-4222-8222-222222222222', title: 'Meeting', createdAt: Date.UTC(2026, 0, 3), durationMs: 60_000, speakers: {}, segments: [seg(0, 0, 'Budget')], complete: true },
  ];

  it('number lines across recordings, mark skipped stretches and name speakers', () => {
    const { text, targets } = buildContext(recordings);
    expect(text).toContain(`=== RECORDING 1: "Lecture 'One'" (recorded 2026-01-02, 10:00 long, excerpts) ===`);
    expect(text).toContain('[S2 0:04] Dr. Khan: Gradients\n[…]\n[S3 1:05] Later');
    expect(text).toContain('=== RECORDING 2: "Meeting" (recorded 2026-01-03, 1:00 long, full transcript) ===\n[S4 0:00] Budget');
    expect(targets.get(4)).toMatchObject({ recordingId: recordings[1]!.id, startMs: 0 });
  });

  it('link real citations to the right recording and drop invented ones', () => {
    const { targets } = buildContext(recordings);
    const one = resolveChatCitations('Gradients were covered [S2]. Also [S99].', targets);
    expect(one.markdown).toBe(`Gradients were covered [0:04](cite:4000@${recordings[0]!.id}). Also.`);
    expect(one.dropped).toBe(1);
    expect(one.used.map((u) => u.text)).toEqual(['Gradients']);
    const two = resolveChatCitations('Both [S2, S4] and a range [S2-S3].', targets);
    expect(two.markdown).toContain(`[Lecture "One" 0:04](cite:4000@${recordings[0]!.id})`);
    expect(two.markdown).toContain(`[Meeting 0:00](cite:0@${recordings[1]!.id})`);
    expect(two.used).toHaveLength(3);
    // The links survive the Markdown reader with their recording.
    const inline = parseInline(two.markdown).find((n) => n.type === 'cite');
    expect(inline).toEqual({ type: 'cite', label: 'Lecture "One" 0:04', ms: 4000, recordingId: recordings[0]!.id });
  });

  it('old links without a recording still work, and odd ones are plain text', () => {
    expect(parseInline('[1:00](cite:60000)')).toEqual([{ type: 'cite', label: '1:00', ms: 60000 }]);
    expect(parseInline('[x](cite:5@not-an-id)')).toEqual([{ type: 'text', text: 'x' }]);
  });
});

describe('model replies', () => {
  it('plans are validated and cleaned', () => {
    expect(validatePlan({ search: ['neural nets', 3, ' '], from_minute: 0, to_minute: 20, overview: 'yes' })).toEqual({ search: ['neural nets'], fromMinute: 0, toMinute: 20, overview: false });
    expect(validatePlan({ from_minute: 10, to_minute: 5 })).toMatchObject({ fromMinute: 10, toMinute: null });
    expect(validatePlan({ to_minute: 5 })).toMatchObject({ fromMinute: 0, toMinute: 5 });
    expect(validatePlan(null)).toEqual({ search: [], fromMinute: null, toMinute: null, overview: false });
  });

  it('answers are read from JSON, with a safe fallback for plain text and never raw JSON', () => {
    expect(readAnswer('```json\n{"answer":"Yes [S1]","found":"yes","general":""}\n```')).toEqual({ answer: 'Yes [S1]', found: 'yes', general: '' });
    expect(readAnswer('{"answer":"","general":"Paris","found":"no"}')).toEqual({ answer: '', found: 'no', general: 'Paris' });
    expect(readAnswer('{"answer":"x","found":"maybe"}')!.found).toBe('partly');
    expect(readAnswer('{"answer":""}')).toBeNull();
    expect(readAnswer('not json')).toBeNull();
    expect(answerFromPlainText('A plain answer [S1]')).toEqual({ answer: 'A plain answer [S1]', found: 'partly', general: '' });
    expect(() => answerFromPlainText('{"answer": broken')).toThrow(/could not read/);
  });

  it('history keeps recent finished turns as plain text and starts with a question', () => {
    const turn = (role: 'user' | 'assistant', content: string, status: ChatTurn['status'] = 'done') => ({ id: content, role, content, status }) as ChatTurn;
    const history = historyForPrompt([turn('user', 'q1'), turn('assistant', 'a1 [0:04](cite:4000@x)'), turn('user', 'q2'), turn('assistant', 'oops', 'failed')], 3000);
    expect(history).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1 [0:04]' },
      { role: 'user', content: 'q2' },
    ]);
    expect(historyForPrompt([turn('user', 'x'.repeat(1000)), turn('assistant', 'short')], 600)).toEqual([]);
  });

  it('snippet marks become parts, with no markup', () => {
    expect(snippetParts(`a ${MATCH_START}b${MATCH_END} c`)).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
      { text: ' c', match: false },
    ]);
  });
});

/** A model whose replies the test writes, and which records what it was asked. */
class ScriptedProvider implements ChatProvider {
  requests: ChatRequest[] = [];
  constructor(private readonly reply: (request: ChatRequest, n: number) => string | Error) {}
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const r = this.reply(request, this.requests.length);
    if (r instanceof Error) throw r;
    return { text: r, truncated: false, inputTokens: 10, outputTokens: 5, rate: null };
  }
  async testConnection(): Promise<void> {}
}

describe('chat and search on a real database', () => {
  let db: Db;
  let library: LibraryRepository;
  let transcripts: TranscriptRepository;
  let chats: ChatRepository;
  let knowledge: KnowledgeRepository;
  let settings: Settings;
  let blocked: Exclude<AiOutcome, { ok: true }> | null;
  let provider: ChatProvider;
  let waits: number[];
  let service: ChatService;
  let lecture: string;
  let meeting: string;

  const rec = (title: string, durationMs = 600_000) =>
    library.insertRecording({ title, mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: `${title}.ogg`, mime: 'audio/ogg', peaks: new Uint8Array(4) });

  /** Waits until no answer is being written. */
  const settle = async () => {
    const pending = () => (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE status = 'pending'").get() as { n: number }).n;
    for (let i = 0; i < 2000 && pending() > 0; i++) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    library = new LibraryRepository(db);
    transcripts = new TranscriptRepository(db);
    chats = new ChatRepository(db);
    knowledge = new KnowledgeRepository(db);
    settings = { ...DEFAULT_SETTINGS, offlineOnly: false, llmProvider: 'fake' };
    blocked = null;
    provider = new FakeChatProvider(0);
    waits = [];
    service = new ChatService({
      chats,
      knowledge,
      library,
      transcripts,
      usage: new UsageRepository(db),
      settings: () => settings,
      makeProvider: () => provider,
      blockedBy: () => blocked,
      changed: () => undefined,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    lecture = rec('Machine learning lecture');
    transcripts.addOriginal(lecture, 'groq', 'm', 'en', [
      seg(0, 0, 'Today we study neural networks and how they learn.', 'A'),
      seg(1, 5000, 'Gradient descent adjusts the weights step by step.', 'A'),
      seg(2, 10_000, 'Homework: read chapter four before Friday.', 'A'),
    ]);
    meeting = rec('Weekly meeting');
    transcripts.addOriginal(meeting, 'groq', 'm', 'en', [seg(0, 0, 'The budget is twelve thousand dollars.', 'B'), seg(1, 5000, 'Offline sync is postponed.', 'B')]);
  });

  afterEach(() => db.close());

  it('passages are indexed with the transcript, follow edits, and are found by BM25 within scope', () => {
    const fts = anyTermQuery(searchTerms('what about gradient descent'))!;
    expect(knowledge.searchPassages(fts, [lecture, meeting]).map((h) => h.recordingId)).toEqual([lecture]);
    expect(knowledge.searchPassages(fts, [meeting])).toEqual([]);
    transcripts.editSegment(meeting, 0, 'Gradient descent came up here too.');
    expect(knowledge.searchPassages(fts, [lecture, meeting]).map((h) => h.recordingId).sort()).toEqual([lecture, meeting].sort());
    library.trash([meeting]);
    expect(knowledge.scopeRecordingIds({ kind: 'library' })).toEqual([lecture]);
  });

  it('transcripts from before this version get their passages once', () => {
    db.exec('DELETE FROM transcript_chunks');
    expect(transcripts.indexMissingPassages()).toBe(2);
    expect(transcripts.indexMissingPassages()).toBe(0);
    expect(knowledge.searchPassages('"budget"', [meeting])).toHaveLength(1);
  });

  it('a small recording is read whole, with no planning request, and the answer is grounded', async () => {
    const scripted = new ScriptedProvider((req) => (req.task === 'chat' ? JSON.stringify({ answer: 'Read chapter four by Friday [S3]. Also [S40].', found: 'yes', general: '' }) : '{}'));
    provider = scripted;
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    expect(service.ask(thread, 'What homework was assigned?')).toMatchObject({ ok: true });
    await settle();
    expect(scripted.requests.map((r) => r.task)).toEqual(['chat']);
    const prompt = scripted.requests[0]!.messages.at(-1)!.content;
    expect(prompt).toContain('This is the full transcript.');
    expect(prompt).toContain('[S3 0:10] Speaker A: Homework: read chapter four before Friday.');
    expect(scripted.requests[0]!.json).toBe(true);
    const [question, answer] = chats.turns(thread);
    expect(question).toMatchObject({ role: 'user', content: 'What homework was assigned?' });
    expect(answer).toMatchObject({ status: 'done', found: 'yes', droppedCitations: 1, readNote: 'Read the full transcript' });
    expect(answer!.content).toBe(`Read chapter four by Friday [0:10](cite:10000@${lecture}). Also.`);
    expect(answer!.sources).toEqual([{ recordingId: lecture, recordingTitle: 'Machine learning lecture', startMs: 10_000, text: 'Homework: read chapter four before Friday.' }]);
    expect(chats.get(thread)).toMatchObject({ title: 'What homework was assigned?', scopeLabel: 'Machine learning lecture', messageCount: 2 });
  });

  it('a library too large to read whole is searched, using the plan, and diverse passages are read', async () => {
    for (let i = 0; i < 12; i++) {
      const id = rec(`Filler ${i}`);
      transcripts.addOriginal(id, 'groq', 'm', 'en', Array.from({ length: 40 }, (_, j) => seg(j, j * 4000, `Unrelated talk about cooking recipes and gardening, part ${j}.`)));
    }
    const scripted = new ScriptedProvider((req) =>
      req.task === 'chat-plan' ? JSON.stringify({ search: ['offline synchronisation postponed'], from_minute: null, to_minute: null, overview: false }) : JSON.stringify({ answer: 'It was postponed [S1].', found: 'yes', general: '' }),
    );
    provider = scripted;
    const thread = service.start({ kind: 'library' });
    service.ask(thread, 'What happened with sync?');
    await settle();
    expect(scripted.requests.map((r) => r.task)).toEqual(['chat-plan', 'chat']);
    expect(scripted.requests[0]!.messages.at(-1)!.content).toContain('NEW QUESTION: What happened with sync?');
    const prompt = scripted.requests[1]!.messages.at(-1)!.content;
    expect(prompt).toContain('Offline sync is postponed.');
    expect(prompt).not.toContain('cooking');
    const answer = chats.turns(thread)[1]!;
    expect(answer.readNote).toBe('Read 1 passage from 1 of 14 recordings');
    expect(answer.sources[0]!.recordingId).toBe(meeting);
  });

  it('says so when nothing matches, and keeps general knowledge apart', async () => {
    for (let i = 0; i < 10; i++) {
      const id = rec(`Filler ${i}`);
      transcripts.addOriginal(id, 'groq', 'm', 'en', Array.from({ length: 60 }, (_, j) => seg(j, j * 4000, `Talk about cooking, part ${j}.`)));
    }
    const scripted = new ScriptedProvider((req) => (req.task === 'chat-plan' ? '{"search":[]}' : JSON.stringify({ answer: 'Your recordings do not mention this.', found: 'no', general: 'Paris is the capital of France.' })));
    provider = scripted;
    const thread = service.start({ kind: 'library' });
    service.ask(thread, 'What is the capital of France?');
    await settle();
    expect(scripted.requests[1]!.messages.at(-1)!.content).toContain('(No passages matched this question.)');
    expect(chats.turns(thread)[1]).toMatchObject({ found: 'no', general: 'Paris is the capital of France.', sources: [], readNote: 'Searched 12 recordings; nothing matched' });
  });

  it('a time range in the question reads that stretch', async () => {
    const long = rec('Long lecture', 3_600_000);
    transcripts.addOriginal(long, 'groq', 'm', 'en', Array.from({ length: 900 }, (_, j) => seg(j, j * 4000, `Minute ${Math.floor((j * 4) / 60)} content line ${j} about many things.`)));
    const scripted = new ScriptedProvider((req) => (req.task === 'chat-plan' ? JSON.stringify({ search: [], from_minute: 0, to_minute: 5, overview: false }) : '{"answer":"x [S1]","found":"yes","general":""}'));
    provider = scripted;
    const thread = service.start({ kind: 'recordings', recordingIds: [long] });
    service.ask(thread, 'Summarize the first five minutes');
    await settle();
    const prompt = scripted.requests[1]!.messages.at(-1)!.content;
    expect(prompt).toContain('Minute 0 content');
    expect(prompt).toContain('Minute 4 content');
    expect(prompt).not.toContain('Minute 30 content');
  });

  it('follow-up questions carry the conversation', async () => {
    const scripted = new ScriptedProvider(() => '{"answer":"About gradients [S2].","found":"yes","general":""}');
    provider = scripted;
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    service.ask(thread, 'What is gradient descent?');
    await settle();
    service.ask(thread, 'Explain it more simply');
    await settle();
    const messages = scripted.requests[1]!.messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[2]!.content).toBe('About gradients [0:05].');
  });

  it('a slip out of JSON is asked again once, then plain text is accepted', async () => {
    const scripted = new ScriptedProvider((_req, n) => (n === 1 ? 'Sure! Here you go' : 'Weights change step by step [S2].'));
    provider = scripted;
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    service.ask(thread, 'How do weights change?');
    await settle();
    expect(scripted.requests).toHaveLength(2);
    expect(chats.turns(thread)[1]).toMatchObject({ status: 'done', found: 'partly', content: `Weights change step by step [0:05](cite:5000@${lecture}).` });
  });

  it('short rate limits are waited out; long ones fail with when to try again, and retry works', async () => {
    let calls = 0;
    provider = new ScriptedProvider(() => (++calls === 1 ? new ProviderError('rate', 'Too many requests.', 3000) : '{"answer":"ok [S1]","found":"yes","general":""}'));
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    service.ask(thread, 'Anything?');
    await settle();
    expect(waits).toEqual([3000]);
    expect(chats.turns(thread)[1]!.status).toBe('done');

    provider = new ScriptedProvider(() => new ProviderError('quota', 'The daily limit was reached.', 600_000));
    service.ask(thread, 'Again?');
    await settle();
    const failed = chats.turns(thread)[3]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'The daily limit was reached. Try again in about 10 minutes.' });
    provider = new FakeChatProvider(0);
    expect(service.retry(failed.id)).toMatchObject({ ok: true });
    await settle();
    expect(chats.turns(thread)[3]!.status).toBe('done');
  });

  it('a network blip gets one more try; a lasting outage fails with the reason', async () => {
    let calls = 0;
    provider = new ScriptedProvider(() => (++calls === 1 ? new ProviderError('network', 'Could not reach the AI service.') : '{"answer":"ok [S1]","found":"yes","general":""}'));
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    service.ask(thread, 'Anything?');
    await settle();
    expect(waits).toEqual([3000]);
    expect(chats.turns(thread)[1]!.status).toBe('done');

    provider = new ScriptedProvider(() => new ProviderError('network', 'Could not reach the AI service.'));
    service.ask(thread, 'Again?');
    await settle();
    expect(chats.turns(thread)[3]).toMatchObject({ status: 'failed', error: 'Could not reach the AI service.' });
  });

  it('nothing is sent or stored when the provider is blocked or there is no transcript', () => {
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    blocked = { ok: false, reason: 'needs-consent', provider: 'groq', purpose: 'text' };
    expect(service.ask(thread, 'Hi?')).toEqual(blocked);
    expect(chats.turns(thread)).toEqual([]);
    blocked = null;
    const empty = rec('No transcript');
    const other = service.start({ kind: 'recordings', recordingIds: [empty] });
    expect(service.ask(other, 'Hi?')).toEqual({ ok: false, reason: 'needs-transcript' });
    expect(() => service.ask(thread, '   ')).toThrow(/Type a question/);
    expect(() => service.start({ kind: 'recordings', recordingIds: [] })).toThrow(/at least one/);
  });

  it('one answer at a time per chat, cancel stops it, and a quit mid-answer is recovered', async () => {
    provider = new FakeChatProvider(10_000);
    const thread = service.start({ kind: 'recordings', recordingIds: [lecture] });
    const out = service.ask(thread, 'First?') as { ok: true; jobId: string };
    expect(() => service.ask(thread, 'Second?')).toThrow(/Wait for the current answer/);
    service.cancel(out.jobId);
    await settle();
    expect(chats.turns(thread)[1]).toMatchObject({ status: 'failed', error: 'Stopped.' });
    chats.addQuestion(thread, 'Third?', 'fake', 'demo');
    service.recover();
    expect(chats.turns(thread)[3]).toMatchObject({ status: 'failed', error: expect.stringContaining('closed before') });
  });

  it('deleting a recording deletes its passages and every chat that read it, cited or not', async () => {
    const about = service.start({ kind: 'recordings', recordingIds: [meeting] });
    const library_ = service.start({ kind: 'library' });
    provider = new ScriptedProvider((req) => (req.task === 'chat-plan' ? '{"search":["budget"]}' : '{"answer":"Twelve thousand [S1]","found":"yes","general":""}'));
    service.ask(library_, 'What is the budget?');
    await settle();
    const unrelated = service.start({ kind: 'recordings', recordingIds: [lecture] });
    library.deleteForever([meeting]);
    expect(chats.list().map((t) => t.id)).toEqual([unrelated]);
    expect(chats.get(about)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks WHERE recording_id = ?').get(meeting)).toEqual({ n: 0 });
  });

  it('a chat on a deleted collection says so instead of failing', () => {
    const c = library.createCollection('Semester 1', null);
    library.moveToCollection([lecture], c);
    const thread = service.start({ kind: 'collection', collectionId: c });
    expect(chats.get(thread)).toMatchObject({ scopeLabel: 'Collection: Semester 1', scopeValid: true });
    expect(service.scopeInfo({ kind: 'collection', collectionId: c })).toEqual({ recordings: 1, withTranscript: 1, label: 'Collection: Semester 1' });
    library.deleteCollection(c);
    expect(chats.get(thread)).toMatchObject({ scopeLabel: 'A deleted collection', scopeValid: false });
    expect(service.ask(thread, 'Hi?')).toEqual({ ok: false, reason: 'needs-transcript' });
  });

  it('global search finds every kind of content with snippets and times, and honours filters', () => {
    const summaries = new SummaryRepository(db);
    const documents = new DocumentRepository(db);
    library.addTag(lecture, 'deep-learning');
    summaries.add({ recordingId: meeting, label: 'Bullets', options: {} as never, markdown: '- Budget stays at twelve thousand [0:00](cite:0)', provider: 'fake', model: 'demo', transcriptVersionId: null, droppedCitations: 0, truncated: false });
    documents.create({ recordingId: lecture, title: 'Study notes', template: 'custom', settings: DEFAULT_DOCUMENT_SETTINGS, markdown: 'Neural networks revision sheet' });
    summaries.saveChapters(lecture, null, [{ idx: 0, startMs: 5000, endMs: 10_000, title: 'Gradient descent basics', summary: 'How weights change' }]);
    transcripts.renameSpeaker(meeting, 'B', 'Budget Owner');

    const neural = knowledge.search({ text: 'neural' });
    expect(neural.map((r) => r.recordingId)).toEqual([lecture]);
    expect(neural[0]!.hits.map((h) => h.kind)).toEqual(['transcript', 'document']);
    expect(neural[0]!.hits[0]).toMatchObject({ kind: 'transcript', startMs: 0 });
    expect(neural[0]!.hits[0]!.snippet).toContain(`${MATCH_START}neural${MATCH_END}`);
    expect(neural[0]!.hits[1]).toMatchObject({ kind: 'document', label: 'Study notes' });

    const budget = knowledge.search({ text: 'budget' });
    expect(budget[0]!.recordingId).toBe(meeting);
    expect(budget[0]!.hits.map((h) => h.kind).sort()).toEqual(['speaker', 'summary', 'transcript']);
    expect(budget[0]!.hits.find((h) => h.kind === 'summary')!.snippet).not.toContain('cite:');

    expect(knowledge.search({ text: 'gradient basics' })[0]!.hits.map((h) => h.kind)).toContain('chapter');
    expect(knowledge.search({ text: 'deep' })[0]!.hits[0]!.kind).toBe('title');
    expect(knowledge.search({ text: 'budget', kind: 'summary' })[0]!.hits.map((h) => h.kind)).toEqual(['summary']);
    expect(knowledge.search({ text: 'budget', from: Date.now() + 60_000 })).toEqual([]);
    expect(knowledge.search({ text: '   ' })).toEqual([]);
    expect(knowledge.search({ text: '"* OR NEAR(' })).toEqual([]);
    library.trash([meeting]);
    expect(knowledge.search({ text: 'budget' })).toEqual([]);
  });
});

describe('search at scale', () => {
  it('a word used often in many recordings still finds every recording, with true match counts', () => {
    const db = openDatabase(':memory:');
    const library = new LibraryRepository(db);
    const transcripts = new TranscriptRepository(db);
    for (let r = 0; r < 70; r++) {
      const id = library.insertRecording({ title: `Talk ${r}`, mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 1, sizeBytes: 1, sampleRate: 1, channels: 1, fileName: `${r}.ogg`, mime: 'audio/ogg', peaks: new Uint8Array(1) });
      transcripts.addOriginal(id, 'groq', 'm', 'en', Array.from({ length: 50 }, (_, i) => seg(i, i * 1000, `common words in line ${i}`)));
    }
    const results = new KnowledgeRepository(db).search({ text: 'common' });
    expect(results).toHaveLength(60);
    expect(results.every((r) => r.totalHits === 50 && r.hits.length === 3)).toBe(true);
    db.close();
  });
});

describe('demo model', () => {
  it('answers chat with the best matching lines and says when nothing matches', async () => {
    const fake = new FakeChatProvider(0);
    const ask = (question: string) =>
      fake
        .complete({ task: 'chat', json: true, model: 'demo', maxOutputTokens: 100, signal: new AbortController().signal, messages: [{ role: 'user', content: `EXCERPTS:\n[S1 0:00] The budget is fixed.\n[S2 0:04] Sync is postponed.\n\nQUESTION: ${question}` }] })
        .then((r) => readAnswer(r.text)!);
    const budget = await ask('What about the budget?');
    expect(budget.answer).toContain('The budget is fixed. [S1]');
    expect(budget.answer).not.toContain('[S2]');
    expect(await ask('Who won the match?')).toMatchObject({ found: 'no' });
  });
});
