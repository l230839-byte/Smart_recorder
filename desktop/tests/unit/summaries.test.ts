import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatHttpProvider } from '../../src/main/ai/chat-http';
import { FakeChatProvider } from '../../src/main/ai/fake-chat';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from '../../src/main/ai/types';
import { openDatabase, type Db } from '../../src/main/db/database';
import { LibraryRepository } from '../../src/main/db/library';
import { SummaryRepository } from '../../src/main/db/summaries';
import { ConsentRepository, JobRepository, SecretStore, TranscriptRepository, UsageRepository, type Cipher } from '../../src/main/db/transcripts';
import { JobQueue } from '../../src/main/services/job-queue';
import { sampleSegments, SummaryService, textConsentKey } from '../../src/main/services/summaries';
import { keyName, TranscriptionService } from '../../src/main/services/transcription';
import { parseInline, parseMarkdown, markdownToClipboard } from '../../src/shared/markdown';
import { DEFAULT_SETTINGS, RECORDING_MODES, type Settings } from '../../src/shared/models';
import {
  DEFAULT_SUMMARY_OPTIONS,
  MODE_GUIDANCE,
  optionsForMode,
  parseJsonReply,
  resolveCitations,
  segmentsInScope,
  splitSegments,
  SUMMARY_FORMATS,
  SUMMARY_LENGTHS,
  summaryLabel,
  summaryMessages,
  transcriptForPrompt,
  validateChapters,
  validateSuggestions,
  type SummaryOptions,
} from '../../src/shared/summaries';
import type { Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, text: string, speaker: string | null = null): Segment => ({ idx, startMs, endMs: startMs + 1000, text, speaker, confidence: null });

describe('citations', () => {
  const segments = [seg(0, 0, 'a'), seg(12, 185_000, 'b'), seg(15, 200_000, 'c')];

  it('become links to real moments', () => {
    const { markdown, used, dropped } = resolveCitations('Point one [S12]. Point two [S12, S15].', segments);
    expect(markdown).toBe('Point one [3:05](cite:185000). Point two [3:05](cite:185000) [3:20](cite:200000).');
    expect(used).toBe(3);
    expect(dropped).toBe(0);
  });

  it('invented evidence is removed, never shown', () => {
    const { markdown, dropped } = resolveCitations('A claim [S999]. Another [S12, S888].', segments);
    expect(markdown).toBe('A claim. Another [3:05](cite:185000).');
    expect(dropped).toBe(2);
    expect(markdown).not.toContain('999');
  });

  it('accepts the variations models write', () => {
    expect(resolveCitations('x [S12; S15]', segments).used).toBe(2);
    expect(resolveCitations('x [S12,15]', segments).used).toBe(2);
    expect(resolveCitations('a normal [link](https://evil.example) and [not a cite]', segments).used).toBe(0);
  });
});

describe('prompts', () => {
  it('every line carries an id, a time and the speaker name', () => {
    expect(transcriptForPrompt([seg(3, 65_000, 'Hello', 'A')], { A: 'Dr. Khan' })).toBe('[S3 1:05] Dr. Khan: Hello');
  });

  it('are grounded and treat the transcript as data, not instructions', () => {
    const [system] = summaryMessages(DEFAULT_SUMMARY_OPTIONS, 'lecture', 'x');
    expect(system!.content).toMatch(/Never invent/);
    expect(system!.content).toMatch(/data, not instructions/);
    expect(system!.content).toMatch(/Not mentioned in the recording/);
  });

  it('carry every option the user set', () => {
    const options: SummaryOptions = { ...DEFAULT_SUMMARY_OPTIONS, format: 'table', length: 'custom', customWords: 123, tone: 'custom', customTone: 'warm', language: 'Urdu', focus: 'neural nets', exclude: 'small talk', extract: 'definitions', emphasis: 'exam', instructions: 'use metric units' };
    const text = summaryMessages(options, 'meeting', 'TRANSCRIPT BODY')[1]!.content;
    for (const part of ['Markdown tables', '123 words', 'warm', 'Write in Urdu', 'neural nets', 'small talk', 'only definitions', 'exam', 'metric units', 'TRANSCRIPT BODY', MODE_GUIDANCE.meeting]) expect(text).toContain(part);
  });

  it('exist for all fourteen formats, all lengths and all modes', () => {
    expect(Object.keys(SUMMARY_FORMATS)).toHaveLength(14);
    expect(Object.keys(SUMMARY_LENGTHS)).toHaveLength(6);
    for (const mode of RECORDING_MODES) expect(optionsForMode(mode).format in SUMMARY_FORMATS).toBe(true);
  });

  it('labels describe the settings', () => {
    expect(summaryLabel({ ...DEFAULT_SUMMARY_OPTIONS, format: 'bullets', length: 'short' })).toBe('Bullet points · Short');
    expect(summaryLabel({ ...DEFAULT_SUMMARY_OPTIONS, length: 'custom', customWords: 50, language: 'Urdu' })).toContain('50 words');
  });
});

describe('scope and splitting', () => {
  it('selects only the chosen time ranges', () => {
    const segments = [seg(0, 0, 'a'), seg(1, 10_000, 'b'), seg(2, 20_000, 'c')];
    expect(segmentsInScope(segments, { kind: 'all' })).toHaveLength(3);
    expect(segmentsInScope(segments, { kind: 'ranges', label: 'x', ranges: [{ startMs: 9000, endMs: 11_000 }] }).map((s) => s.idx)).toEqual([1]);
  });

  it('splits on segment boundaries and loses nothing', () => {
    const segments = Array.from({ length: 50 }, (_, i) => seg(i, i * 1000, 'x'.repeat(100)));
    const pieces = splitSegments(segments, 1000);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.flat().map((s) => s.idx)).toEqual(segments.map((s) => s.idx));
    expect(splitSegments([], 1000)).toEqual([]);
  });

  it('an oversized single segment still goes through', () => {
    expect(splitSegments([seg(0, 0, 'x'.repeat(5000))], 100)).toHaveLength(1);
  });

  it('samples evenly for chapters, keeping real ids', () => {
    const segments = Array.from({ length: 1000 }, (_, i) => seg(i, i * 1000, 'x'.repeat(100)));
    const sample = sampleSegments(segments, 12_000);
    expect(sample.length).toBeLessThan(200);
    expect(sample[0]!.idx).toBe(0);
    expect(sampleSegments(segments.slice(0, 5), 12_000)).toHaveLength(5);
  });
});

describe('chapters and suggestions are validated', () => {
  const segments = [seg(0, 0, 'a'), seg(5, 60_000, 'b'), seg(9, 120_000, 'c')];

  it('chapters point only at real lines, ordered, covering the recording', () => {
    const chapters = validateChapters({ chapters: [{ title: 'Two', start: 9 }, { title: 'One', summary: 's', start: 0 }, { title: 'Fake', start: 500 }, { start: 5 }] }, segments, 180_000);
    expect(chapters.map((c) => [c.title, c.startMs, c.endMs])).toEqual([['One', 0, 120_000], ['Two', 120_000, 180_000]]);
  });

  it('the first chapter starts at zero, so nothing is left out', () => {
    expect(validateChapters({ chapters: [{ title: 'Late', start: 5 }] }, segments, 180_000)[0]!.startMs).toBe(0);
  });

  it('nothing usable is an error, not an empty success', () => {
    for (const bad of [null, {}, { chapters: 'x' }, { chapters: [] }, { chapters: [{ title: 'x', start: 999 }] }]) expect(() => validateChapters(bad, segments, 1000)).toThrow();
  });

  it('suggestions are cleaned and limited', () => {
    expect(validateSuggestions({ title: ' A title ', tags: ['#exam', 'exam', 5, ' ml ', 'a', 'b', 'c', 'd'], topics: 'nope' })).toEqual({ title: 'A title', tags: ['exam', 'ml', 'a', 'b', 'c'], topics: [] });
    expect(() => validateSuggestions({})).toThrow();
  });

  it('JSON replies may come in a code fence', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply(' {"a":1} ')).toEqual({ a: 1 });
    expect(() => parseJsonReply('sorry')).toThrow();
  });
});

describe('Markdown reader', () => {
  it('reads every block type', () => {
    const blocks = parseMarkdown('# Title\n\nSome **bold** text\nsame paragraph\n\n- one\n  - nested\n- two\n\n1. first\n\n> quote\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'table']);
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(list.items.map((i) => i.depth)).toEqual([0, 1, 0]);
    const table = blocks[6] as Extract<(typeof blocks)[number], { type: 'table' }>;
    expect(table.rows).toHaveLength(1);
  });

  it('keeps citations, and turns every other link into plain text', () => {
    expect(parseInline('See [3:05](cite:185000) and [bad](https://evil.example) and [x](javascript:alert(1))')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'cite', label: '3:05', ms: 185_000 },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'bad' },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'x' },
      { type: 'text', text: ')' },
    ]);
  });

  it('HTML stays literal text', () => {
    const [block] = parseMarkdown('<img src=x onerror=alert(1)> <script>bad()</script>');
    expect(block).toEqual({ type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)> <script>bad()</script>' }] });
  });

  it('nests inline styles, and handles Urdu', () => {
    expect(parseInline('**a *b***')[0]).toMatchObject({ type: 'bold' });
    expect(parseMarkdown('## موضوع\n\n- پہلا نکتہ [0:05](cite:5000)')[0]).toMatchObject({ type: 'heading', level: 2 });
  });

  it('copying shows readable times', () => {
    expect(markdownToClipboard('Point [3:05](cite:185000).')).toBe('Point [3:05].');
  });

  it('an empty string is no blocks', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

describe('ChatHttpProvider against a real HTTP server', () => {
  let server: Server;
  let base: string;
  let seen: { auth?: string; path?: string; body: string }[];
  let reply: { status: number; body: unknown; headers?: Record<string, string> };

  beforeEach(async () => {
    seen = [];
    reply = { status: 200, body: { choices: [{ message: { content: 'Hello [S1]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }, headers: { 'x-ratelimit-remaining-requests': '9', 'x-ratelimit-limit-requests': '10' } };
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, path: req.url, body: Buffer.concat(parts).toString() });
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({ messages: [{ role: 'user', content: 'Hi' }], model: 'm', maxOutputTokens: 100, json: false, signal: new AbortController().signal, task: 'summary', ...over });

  it('sends the documented request and reads usage and limits', async () => {
    const result = await new ChatHttpProvider(base, 'gsk_x').complete(request());
    expect(result).toMatchObject({ text: 'Hello [S1]', truncated: false, inputTokens: 10, outputTokens: 5 });
    expect(result.rate?.remainingRequests).toBe(9);
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer gsk_x');
    const body = JSON.parse(seen[0]!.body);
    expect(body).toMatchObject({ model: 'm', max_tokens: 100 });
    expect(body.response_format).toBeUndefined();
  });

  it('asks for JSON when needed', async () => {
    await new ChatHttpProvider(base, null).complete(request({ json: true }));
    expect(JSON.parse(seen[0]!.body).response_format).toEqual({ type: 'json_object' });
    expect(seen[0]!.auth).toBeUndefined();
  });

  it('reports a reply cut off at the length limit', async () => {
    reply.body = { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] };
    expect((await new ChatHttpProvider(base, 'k').complete(request())).truncated).toBe(true);
  });

  it('turns failures into actions', async () => {
    reply = { status: 429, body: {}, headers: { 'retry-after': '3' } };
    await expect(new ChatHttpProvider(base, 'k').complete(request())).rejects.toMatchObject({ kind: 'rate', retryAfterMs: 3000 });
    reply = { status: 413, body: {} };
    await expect(new ChatHttpProvider(base, 'k').complete(request())).rejects.toMatchObject({ kind: 'too-large' });
    await expect(new ChatHttpProvider('http://127.0.0.1:1', 'k').complete(request())).rejects.toMatchObject({ kind: 'network' });
  });

  it('never accepts an empty or malformed reply as a result', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: '  ' } }] }]) {
      reply = { status: 200, body };
      await expect(new ChatHttpProvider(base, 'k').complete(request())).rejects.toMatchObject({ kind: 'server' });
    }
  });
});

const plainCipher: Cipher = { available: () => true, encrypt: (s) => new TextEncoder().encode(s), decrypt: (d) => new TextDecoder().decode(d) };

describe('summary jobs', () => {
  let db: Db;
  let settings: Settings;
  let library: LibraryRepository;
  let jobs: JobRepository;
  let transcripts: TranscriptRepository;
  let summaries: SummaryRepository;
  let consents: ConsentRepository;
  let secrets: SecretStore;
  let usage: UsageRepository;
  let calls: ChatRequest[];
  let script: ((r: ChatRequest) => ChatResult | Error)[];
  let ready: string[];
  let transcriptionCalls: number;
  let service: SummaryService;
  let queue: JobQueue;
  let id: string;

  const ok = (text: string): ChatResult => ({ text, truncated: false, inputTokens: 3, outputTokens: 2, rate: null });
  const provider: ChatProvider = {
    complete: async (r) => {
      calls.push(r);
      const next = script.shift();
      const out = next ? next(r) : ok('Default [S0]');
      if (out instanceof Error) throw out;
      return out;
    },
    testConnection: async () => undefined,
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  beforeEach(() => {
    db = openDatabase(':memory:');
    library = new LibraryRepository(db);
    jobs = new JobRepository(db);
    transcripts = new TranscriptRepository(db);
    summaries = new SummaryRepository(db);
    consents = new ConsentRepository(db);
    secrets = new SecretStore(db, plainCipher);
    usage = new UsageRepository(db);
    settings = { ...DEFAULT_SETTINGS, offlineOnly: false, llmProvider: 'groq' };
    secrets.set(keyName('groq'), 'k');
    consents.accept(textConsentKey('groq'));
    calls = [];
    script = [];
    ready = [];
    transcriptionCalls = 0;
    queue = new JobQueue(jobs, () => undefined, { schedule: () => undefined });
    new TranscriptionService({ jobs, transcripts, library, usage, consents, secrets, settings: () => settings, makeProvider: () => ({ transcribe: async () => { transcriptionCalls++; throw new Error('must not run'); }, testConnection: async () => undefined }), prepareChunk: async () => undefined, tempDir: tmpdir(), changed: () => undefined, transcriptReady: () => undefined, queue });
    service = new SummaryService({ jobs, queue, transcripts, library, summaries, usage, consents, secrets, settings: () => settings, makeProvider: () => provider, changed: () => undefined, ready: (rid) => ready.push(rid) });
    id = library.insertRecording({ title: 'T', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 60_000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: 'f.ogg', mime: 'audio/ogg', peaks: new Uint8Array(8) });
    transcripts.addOriginal(id, 'groq', 'm', 'en', [seg(0, 0, 'Neural networks learn.'), seg(1, 5000, 'The exam is on Friday.')]);
  });

  afterEach(async () => {
    queue.stop();
    await settle();
    db.close();
  });

  describe('privacy', () => {
    it('offline-only, a missing key and missing consent each stop it before anything is sent', async () => {
      settings.offlineOnly = true;
      expect(service.request(id, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS })).toMatchObject({ ok: false, reason: 'offline-only', purpose: 'text' });
      settings.offlineOnly = false;
      consents.revoke(textConsentKey('groq'));
      expect(service.request(id, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS })).toMatchObject({ ok: false, reason: 'needs-consent' });
      consents.accept(textConsentKey('groq'));
      secrets.clear(keyName('groq'));
      expect(service.request(id, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS })).toMatchObject({ ok: false, reason: 'needs-setup' });
      await settle();
      expect(calls).toHaveLength(0);
    });

    it('agreeing to send audio is not agreeing to send text', () => {
      consents.revoke(textConsentKey('groq'));
      consents.accept('groq');
      expect(service.request(id, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS })).toMatchObject({ ok: false, reason: 'needs-consent' });
    });

    it('turning on offline-only stops queued work at the last moment', async () => {
      const jobId = jobs.create(id, 'groq', 'm', 'auto', 'summarize', JSON.stringify({ summary: DEFAULT_SUMMARY_OPTIONS }));
      settings.offlineOnly = true;
      queue.pump();
      await settle();
      expect(calls).toHaveLength(0);
      expect(jobs.get(jobId)!.error).toMatch(/Offline only/);
    });

    it('a trashed recording cannot start AI work, and one with no transcript is told why', () => {
      const other = library.insertRecording({ title: 'U', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 1, sizeBytes: 1, sampleRate: 1, channels: 1, fileName: 'g.ogg', mime: 'audio/ogg', peaks: new Uint8Array(1) });
      expect(service.request(other, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS })).toEqual({ ok: false, reason: 'needs-transcript' });
      library.trash([other]);
      expect(() => service.request(other, 'chapters')).toThrow(/Restore/);
    });
  });

  it('writes a summary with resolved citations and never re-transcribes', async () => {
    script = [() => ok('## Notes\n\n- Exam on Friday [S1]\n- Invented claim [S99]')];
    service.request(id, 'summarize', { summary: { ...DEFAULT_SUMMARY_OPTIONS, format: 'bullets' } });
    await settle();
    const [summary] = summaries.list(id);
    expect(summary).toMatchObject({ version: 1, provider: 'groq', droppedCitations: 1, truncated: false, label: 'Bullet points · Medium' });
    expect(summary!.markdown).toContain('[0:05](cite:5000)');
    expect(summary!.markdown).not.toContain('S99');
    expect(summary!.transcriptVersionId).toBe(transcripts.current(id)!.id);
    expect(ready).toEqual([id]);
    expect(transcriptionCalls).toBe(0);
    expect(usage.summary()[0]).toMatchObject({ provider: 'groq', tokensToday: 5, audioMsToday: 0 });
  });

  it('changing the format makes a new version from the same transcript, with no transcription', async () => {
    for (const format of ['bullets', 'paragraphs', 'structured'] as const) {
      service.request(id, 'summarize', { summary: { ...DEFAULT_SUMMARY_OPTIONS, format } });
      await settle();
    }
    expect(summaries.list(id).map((s) => s.version)).toEqual([3, 2, 1]);
    expect(transcriptionCalls).toBe(0);
    expect(calls[0]!.messages[1]!.content).toContain('Neural networks learn.');
  });

  it('library search finds summary text, and deleting the recording removes it', async () => {
    script = [() => ok('Backpropagation explained [S0]')];
    service.request(id, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS });
    await settle();
    expect(library.list({ view: 'all', sort: 'newest', text: 'backpropagation' })).toHaveLength(1);
    library.deleteForever([id]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summary_search WHERE summary_search MATCH 'backpropagation'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM summaries').get()).toEqual({ n: 0 });
  });

  it('a summary marks when it hit the length limit', async () => {
    script = [() => ({ ...ok('Cut off'), truncated: true })];
    service.request(id, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS });
    await settle();
    expect(summaries.list(id)[0]!.truncated).toBe(true);
  });

  it('long transcripts go in pieces, then combine, keeping the citations', async () => {
    const long = library.insertRecording({ title: 'Long', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 3_000_000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: 'l.ogg', mime: 'audio/ogg', peaks: new Uint8Array(8) });
    transcripts.addOriginal(long, 'groq', 'm', 'en', Array.from({ length: 300 }, (_, i) => seg(i, i * 10_000, `Sentence number ${i} `.repeat(5))));
    service.request(long, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.at(-1)!.messages[1]!.content).toContain('NOTES:');
    expect(calls[0]!.messages[1]!.content).toContain('part 1 of');
    expect(summaries.list(long)).toHaveLength(1);
  });

  it('429 midway keeps finished notes, and continues without re-sending them', async () => {
    const long = library.insertRecording({ title: 'Long', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 3_000_000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: 'l.ogg', mime: 'audio/ogg', peaks: new Uint8Array(8) });
    transcripts.addOriginal(long, 'groq', 'm', 'en', Array.from({ length: 300 }, (_, i) => seg(i, i * 10_000, `Sentence number ${i} `.repeat(5))));
    script = [() => ok('first notes [S0]'), () => new ProviderError('rate', 'Slow down.', 0)];
    const { jobId } = service.request(long, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS }) as { jobId: string };
    await settle();
    expect(jobs.get(jobId)!.status).toBe('waiting');
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 600));
    queue.pump();
    await new Promise((r) => setTimeout(r, 80));
    expect(jobs.get(jobId)!.status).toBe('done');
    const firstPrompts = calls.slice(before).filter((c) => c.messages[1]!.content.includes('part 1 of'));
    expect(firstPrompts).toHaveLength(0);
  });

  it('a piece too large for the service is retried smaller, automatically', async () => {
    const long = library.insertRecording({ title: 'Long', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 3_000_000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: 'l.ogg', mime: 'audio/ogg', peaks: new Uint8Array(8) });
    transcripts.addOriginal(long, 'groq', 'm', 'en', Array.from({ length: 100 }, (_, i) => seg(i, i * 10_000, 'word '.repeat(20))));
    script = [() => new ProviderError('too-large', 'Too big.')];
    const { jobId } = service.request(long, 'summarize', { summary: DEFAULT_SUMMARY_OPTIONS }) as { jobId: string };
    await new Promise((r) => setTimeout(r, 120));
    expect(jobs.get(jobId)!.status).toBe('done');
    expect((jobs.get(jobId)!.options as { maxChars: number }).maxChars).toBe(6000);
  });

  it('chapters are validated against the transcript and replace older ones', async () => {
    script = [() => ok('{"chapters":[{"title":"Intro","summary":"s","start":0},{"title":"Exam","start":1},{"title":"Made up","start":77}]}')];
    service.request(id, 'chapters');
    await settle();
    expect(summaries.chapters(id).map((c) => c.title)).toEqual(['Intro', 'Exam']);
    expect(calls[0]!.json).toBe(true);
    expect(calls[0]!.messages[0]!.content).toContain('JSON');
    script = [() => ok('{"chapters":[{"title":"Only","start":0}]}')];
    service.request(id, 'chapters');
    await settle();
    expect(summaries.chapters(id).map((c) => c.title)).toEqual(['Only']);
  });

  it('an unreadable JSON reply gets one more try, then a clear failure', async () => {
    script = [() => ok('sorry, no JSON'), () => ok('{"title":"Good title","tags":["a"]}')];
    service.request(id, 'suggest');
    await settle();
    expect(summaries.suggestions(id)).toEqual({ title: 'Good title', tags: ['a'], topics: [] });

    script = [() => ok('nope'), () => ok('still nope')];
    const { jobId } = service.request(id, 'suggest') as { jobId: string };
    await settle();
    expect(jobs.get(jobId)).toMatchObject({ status: 'failed', retryable: true });
    expect(jobs.get(jobId)!.error).toMatch(/could not read/);
  });

  it('suggestions change nothing in the library until the user accepts', async () => {
    script = [() => ok('{"title":"AI title","tags":["x"]}')];
    service.request(id, 'suggest');
    await settle();
    expect(library.getRecording(id)!.title).toBe('T');
    expect(library.getRecording(id)!.tags).toEqual([]);
  });

  it('a transcription and a summary can queue for one recording at once', () => {
    const a = service.request(id, 'chapters') as { jobId: string };
    const b = service.request(id, 'suggest') as { jobId: string };
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('templates forget the one-recording time range', () => {
    const tid = summaries.saveTemplate('Exam prep', { ...DEFAULT_SUMMARY_OPTIONS, emphasis: 'exam', scope: { kind: 'ranges', label: 'x', ranges: [{ startMs: 0, endMs: 1 }] } });
    expect(summaries.templates()[0]).toMatchObject({ id: tid, name: 'Exam prep', options: { emphasis: 'exam', scope: { kind: 'all' } } });
    summaries.deleteTemplate(tid);
    expect(summaries.templates()).toEqual([]);
  });

  it('settings reject wrong types', async () => {
    const { SettingsStore } = await import('../../src/main/services/settings');
    const store = new SettingsStore(db);
    store.update({ offlineOnly: 'no' as never, theme: 5 as never, trashRetentionDays: null as never, customBaseUrl: null, llmBaseUrl: 'https://x.example' });
    const s = store.get();
    expect(s.offlineOnly).toBe(DEFAULT_SETTINGS.offlineOnly);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.trashRetentionDays).toBe(DEFAULT_SETTINGS.trashRetentionDays);
    expect(s.llmBaseUrl).toBe('https://x.example');
  });
});

describe('demo model', () => {
  const request = (task: ChatRequest['task'], prompt: string): ChatRequest => ({ messages: [{ role: 'user', content: prompt }], model: 'demo', maxOutputTokens: 100, json: task !== 'summary', signal: new AbortController().signal, task });

  it('only quotes real lines, and its output passes the same checks as a real model', async () => {
    const fake = new FakeChatProvider(0);
    const segments = [seg(0, 0, 'First line'), seg(1, 1000, 'Second line')];
    const prompt = `TRANSCRIPT:\n${transcriptForPrompt(segments)}`;
    const summary = resolveCitations((await fake.complete(request('summary', prompt))).text, segments);
    expect(summary.dropped).toBe(0);
    expect(summary.used).toBe(2);
    expect(summary.markdown).toMatch(/placeholder/);
    expect(validateChapters(JSON.parse((await fake.complete(request('chapters', prompt))).text), segments, 2000).length).toBeGreaterThan(0);
    expect(validateSuggestions(JSON.parse((await fake.complete(request('suggest', prompt))).text)).tags).toContain('demo');
  });
});
