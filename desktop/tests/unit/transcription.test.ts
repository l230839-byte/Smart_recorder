import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVerboseJson, parseWait, toProviderError, WhisperHttpProvider } from '../../src/main/ai/whisper-http';
import { ProviderError, type TranscribeRequest, type TranscribeResult, type TranscriptionProvider } from '../../src/main/ai/types';
import { openDatabase, type Db } from '../../src/main/db/database';
import { LibraryRepository } from '../../src/main/db/library';
import { ConsentRepository, JobRepository, SecretStore, TranscriptRepository, UsageRepository, type Cipher } from '../../src/main/db/transcripts';
import { backoffMs, keyName, TranscriptionService } from '../../src/main/services/transcription';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/models';
import { validateBaseUrl } from '../../src/shared/providers';
import { activeBlockIndex, cleanText, findMatches, hasQuestions, mergeChunks, planChunks, toBlocks, toSrt, toVtt, type Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, endMs: number, text: string, speaker: string | null = null, confidence: number | null = null): Segment => ({ idx, startMs, endMs, text, speaker, confidence });

describe('planChunks', () => {
  it('keeps short audio whole', () => {
    expect(planChunks(5000, null, 60_000)).toEqual([{ startMs: 0, endMs: 5000 }]);
  });

  it('covers the whole recording with no gaps or overlaps', () => {
    const ranges = planChunks(3_600_000, null, 600_000);
    expect(ranges).toHaveLength(6);
    expect(ranges[0]!.startMs).toBe(0);
    expect(ranges.at(-1)!.endMs).toBe(3_600_000);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.startMs).toBe(ranges[i - 1]!.endMs);
  });

  it('cuts at the quietest moment near the limit, so a word is not split', () => {
    const peaks = new Uint8Array(100).fill(200);
    peaks[46] = 3;
    const [first] = planChunks(100_000, peaks, 50_000);
    expect(first!.endMs).toBeGreaterThanOrEqual(46_000);
    expect(first!.endMs).toBeLessThanOrEqual(47_000);
  });

  it('never makes a piece longer than the limit', () => {
    const peaks = new Uint8Array(800).map((_, i) => (i * 37) % 255);
    for (const r of planChunks(7_200_000, peaks, 600_000)) expect(r.endMs - r.startMs).toBeLessThanOrEqual(600_000 + 1);
  });
});

describe('mergeChunks', () => {
  it('shifts timestamps onto the recording and renumbers', () => {
    const merged = mergeChunks([
      { startMs: 0, segments: [{ startMs: 0, endMs: 1000, text: ' a ', speaker: null, confidence: null }] },
      { startMs: 60_000, segments: [{ startMs: 500, endMs: 1500, text: 'b', speaker: null, confidence: 0.9 }, { startMs: 2000, endMs: 2100, text: '   ', speaker: null, confidence: null }] },
    ]);
    expect(merged).toEqual([seg(0, 0, 1000, 'a'), seg(1, 60_500, 61_500, 'b', null, 0.9)]);
  });
});

describe('display modes', () => {
  const segments = [
    seg(0, 0, 1000, 'Hello everyone.', 'A'),
    seg(1, 1000, 2000, 'What is a neural network?', 'A'),
    seg(2, 2000, 3000, 'It is a model.', 'B'),
    seg(3, 9000, 10_000, 'Moving on.', 'B', 0.2),
  ];

  it('raw and timestamped keep each segment, and only timestamped shows time', () => {
    expect(toBlocks('raw', segments).map((b) => b.showTime)).toEqual([false, false, false, false]);
    expect(toBlocks('timestamped', segments).map((b) => b.segmentIdx)).toEqual([0, 1, 2, 3]);
  });

  it('flags uncertain segments', () => {
    expect(toBlocks('timestamped', segments).map((b) => b.uncertain)).toEqual([false, false, false, true]);
  });

  it('speakers merge consecutive turns', () => {
    expect(toBlocks('speaker', segments).map((b) => [b.speaker, b.startMs])).toEqual([['A', 0], ['B', 2000]]);
  });

  it('paragraphs break on a long pause or a new speaker', () => {
    expect(toBlocks('paragraph', segments).map((b) => b.text)).toEqual(['Hello everyone. What is a neural network?', 'It is a model.', 'Moving on.']);
  });

  it('Q&A finds questions in English and Urdu', () => {
    const blocks = toBlocks('qa', segments);
    expect(blocks.map((b) => b.kind)).toEqual(['answer', 'question', 'answer']);
    expect(hasQuestions([seg(0, 0, 1, 'یہ کیا ہے؟')])).toBe(true);
    expect(hasQuestions([seg(0, 0, 1, 'Done.')])).toBe(false);
  });

  it('cleaning removes fillers and stutters without rephrasing', () => {
    expect(cleanText('Um, the the model, uh, learns.')).toBe('The model, learns.');
    expect(cleanText('umbrella and error stay')).toBe('Umbrella and error stay');
    expect(cleanText('یہ ایک جملہ ہے')).toBe('یہ ایک جملہ ہے');
  });

  it('finds the block being spoken', () => {
    const blocks = toBlocks('timestamped', segments);
    expect(activeBlockIndex(blocks, 1500)).toBe(1);
    expect(activeBlockIndex(blocks, 5000)).toBe(2);
    expect(activeBlockIndex([], 5000)).toBe(-1);
  });

  it('search ignores case and finds every match', () => {
    expect(findMatches('Net net NET', 'net')).toEqual([[0, 3], [4, 7], [8, 11]]);
    expect(findMatches('anything', '  ')).toEqual([]);
  });
});

describe('subtitle writers', () => {
  const segments = [seg(0, 0, 1500, 'Hi', 'A'), seg(1, 3_661_001, 3_662_000, 'Bye --> now')];

  it('writes valid SRT', () => {
    expect(toSrt(segments, { A: 'Sara' })).toBe('1\n00:00:00,000 --> 00:00:01,500\nSara: Hi\n\n2\n01:01:01,001 --> 01:01:02,000\nBye --> now\n');
  });

  it('writes valid VTT, and cue text cannot break a cue', () => {
    const vtt = toVtt(segments);
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nSpeaker A: Hi\n')).toBe(true);
    expect(vtt).toContain('Bye → now');
  });
});

describe('Whisper response parsing', () => {
  it('reads verbose_json as Groq documents it', () => {
    const parsed = parseVerboseJson({ language: 'ur', text: 'x', segments: [{ start: 1.5, end: 3, text: 'سلام', avg_logprob: -0.2 }] }, 10_000);
    expect(parsed.language).toBe('ur');
    expect(parsed.segments[0]).toMatchObject({ startMs: 1500, endMs: 3000, text: 'سلام', speaker: null });
    expect(parsed.segments[0]!.confidence).toBeCloseTo(Math.exp(-0.2));
  });

  it('survives missing language, missing fields and text-only services', () => {
    expect(parseVerboseJson({ segments: [{ start: 0, end: 1, text: 'a' }, { nonsense: true }] }, 1000).segments).toHaveLength(1);
    expect(parseVerboseJson({ text: 'whole thing' }, 5000).segments).toEqual([{ startMs: 0, endMs: 5000, text: 'whole thing', speaker: null, confidence: null }]);
    expect(parseVerboseJson({ text: '   ' }, 5000).segments).toEqual([]);
  });

  it('rejects anything else rather than inventing a transcript', () => {
    for (const bad of [null, 'text', 5, {}, { segments: 'x' }]) expect(() => parseVerboseJson(bad, 1000)).toThrow(ProviderError);
  });

  it('reads wait times in the forms providers use', () => {
    expect(parseWait('2')).toBe(2000);
    expect(parseWait('7.66s')).toBeCloseTo(7660);
    expect(parseWait('2m59.56s')).toBeCloseTo(179_560);
    expect(parseWait('1h2m')).toBe(3_720_000);
    expect(parseWait('250ms')).toBe(250);
    expect(parseWait(null)).toBeNull();
    expect(parseWait('soon')).toBeNull();
  });
});

describe('provider errors', () => {
  const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it('maps each failure to what should happen next', async () => {
    expect((await toProviderError(response(401))).kind).toBe('auth');
    expect((await toProviderError(response(403))).kind).toBe('auth');
    expect((await toProviderError(response(413))).kind).toBe('too-large');
    expect((await toProviderError(response(404))).kind).toBe('rejected');
    expect((await toProviderError(response(400, { error: { message: 'bad audio' } }))).message).toContain('bad audio');
    expect((await toProviderError(response(503))).kind).toBe('server');
  });

  it('separates short rate limits from daily quotas and honors retry-after', async () => {
    const rate = await toProviderError(response(429, {}, { 'retry-after': '20' }));
    expect(rate).toMatchObject({ kind: 'rate', retryAfterMs: 20_000 });
    const byText = await toProviderError(response(429, { error: { message: 'Rate limit reached: audio seconds per day' } }));
    expect(byText.kind).toBe('quota');
    const byWait = await toProviderError(response(429, {}, { 'retry-after': '7200' }));
    expect(byWait.kind).toBe('quota');
  });

  it('never includes the key in a message', async () => {
    const error = await toProviderError(response(401, { error: { message: 'Invalid key gsk_secret' } }));
    expect(error.message).not.toContain('gsk_secret');
  });
});

describe('validateBaseUrl', () => {
  it('requires https, except on this computer', () => {
    expect(validateBaseUrl('https://example.com/v1/')).toBe('https://example.com/v1');
    expect(validateBaseUrl('http://localhost:9000/v1')).toBe('http://localhost:9000/v1');
    expect(validateBaseUrl('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(validateBaseUrl('http://example.com/v1')).toBeNull();
    expect(validateBaseUrl('ftp://example.com')).toBeNull();
    expect(validateBaseUrl('not a url')).toBeNull();
  });
});

describe('WhisperHttpProvider against a real HTTP server', () => {
  let server: Server;
  let base: string;
  let seen: { auth?: string; contentType?: string; body: string }[];
  let reply: { status: number; body: unknown; headers?: Record<string, string> };
  const file = join(mkdtempSync(join(tmpdir(), 'echomind-unit-')), 'a.ogg');
  writeFileSync(file, 'OggS fake bytes');

  beforeEach(async () => {
    seen = [];
    reply = { status: 200, body: { language: 'en', segments: [{ start: 0, end: 1, text: 'hi', avg_logprob: -0.1 }] }, headers: { 'x-ratelimit-remaining-requests': '19', 'x-ratelimit-limit-requests': '20', 'x-ratelimit-reset-requests': '3s' } };
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(parts).toString() });
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => new Promise((r) => server.close(r)));

  const request = (over: Partial<TranscribeRequest> = {}): TranscribeRequest => ({ filePath: file, fileName: 'audio-0.ogg', mime: 'audio/ogg', durationMs: 1000, model: 'whisper-large-v3-turbo', language: 'ur', signal: new AbortController().signal, ...over });

  it('sends a correct multipart request and reads the limits the service reports', async () => {
    const result = await new WhisperHttpProvider(base, 'gsk_key').transcribe(request());
    expect(result.segments[0]!.text).toBe('hi');
    expect(result.rate).toEqual({ remainingRequests: 19, limitRequests: 20, resetsInMs: 3000 });
    const sent = seen[0]!;
    expect(sent.auth).toBe('Bearer gsk_key');
    expect(sent.contentType).toMatch(/^multipart\/form-data/);
    for (const part of ['name="model"', 'whisper-large-v3-turbo', 'name="response_format"', 'verbose_json', 'name="language"', 'filename="audio-0.ogg"', 'OggS fake bytes']) expect(sent.body).toContain(part);
  });

  it('omits language for auto-detection, and the header when there is no key', async () => {
    await new WhisperHttpProvider(base, null).transcribe(request({ language: null }));
    expect(seen[0]!.auth).toBeUndefined();
    expect(seen[0]!.body).not.toContain('name="language"');
  });

  it('turns HTTP 429 into a rate error with the wait', async () => {
    reply = { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } };
    await expect(new WhisperHttpProvider(base, 'k').transcribe(request())).rejects.toMatchObject({ kind: 'rate', retryAfterMs: 2000 });
  });

  it('reports a dropped connection as a network problem', async () => {
    const dead = new WhisperHttpProvider('http://127.0.0.1:1', 'k');
    await expect(dead.transcribe(request())).rejects.toMatchObject({ kind: 'network' });
  });

  it('testing the connection sends no audio', async () => {
    await new WhisperHttpProvider(base, 'k').testConnection(new AbortController().signal);
    expect(seen[0]!.body).toBe('');
  });

  it('can be canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new WhisperHttpProvider(base, 'k').transcribe(request({ signal: controller.signal }))).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('backoffMs', () => {
  it('honors the provider, otherwise doubles with a cap', () => {
    expect(backoffMs(3, 20_000)).toBe(20_500);
    expect(backoffMs(0, null, () => 0.5)).toBe(5000);
    expect(backoffMs(2, null, () => 0.5)).toBe(20_000);
    expect(backoffMs(30, null, () => 0.5)).toBe(15 * 60_000);
  });
});

const plainCipher: Cipher = {
  available: () => true,
  encrypt: (s) => new TextEncoder().encode(`enc:${[...s].reverse().join('')}`),
  decrypt: (d) => [...new TextDecoder().decode(d).slice(4)].reverse().join(''),
};

describe('transcription queue', () => {
  let db: Db;
  let clock: number;
  let settings: Settings;
  let library: LibraryRepository;
  let jobs: JobRepository;
  let transcripts: TranscriptRepository;
  let usage: UsageRepository;
  let consents: ConsentRepository;
  let secrets: SecretStore;
  let calls: TranscribeRequest[];
  let script: ((r: TranscribeRequest) => TranscribeResult | Error)[];
  let ready: string[];
  let prepared: number;
  let wakeups: number[];

  const ok = (text = 'hello'): TranscribeResult => ({ language: 'en', segments: [{ startMs: 0, endMs: 1000, text, speaker: null, confidence: null }], rate: null });

  const provider: TranscriptionProvider = {
    transcribe: async (r) => {
      calls.push(r);
      const next = script.shift();
      const out = next ? next(r) : ok();
      if (out instanceof Error) throw out;
      return out;
    },
    testConnection: async () => undefined,
  };

  const service = () =>
    new TranscriptionService({
      jobs,
      transcripts,
      library,
      usage,
      consents,
      secrets,
      settings: () => settings,
      makeProvider: () => provider,
      prepareChunk: async () => {
        prepared++;
      },
      tempDir: tmpdir(),
      changed: () => undefined,
      transcriptReady: (id) => ready.push(id),
      now: () => clock,
      schedule: (ms) => wakeups.push(ms),
    });

  const addRecording = (durationMs = 1000) =>
    library.insertRecording({ title: 'A lecture', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: `${Math.random()}.ogg`, mime: 'audio/ogg', peaks: new Uint8Array(800) });

  /** Runs until the queue is idle. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 30));
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    clock = 1_700_000_000_000;
    library = new LibraryRepository(db, () => clock);
    jobs = new JobRepository(db, () => clock);
    transcripts = new TranscriptRepository(db, () => clock);
    usage = new UsageRepository(db, () => clock);
    consents = new ConsentRepository(db, () => clock);
    secrets = new SecretStore(db, plainCipher);
    settings = { ...DEFAULT_SETTINGS, offlineOnly: false, transcriptionProvider: 'groq' };
    secrets.set(keyName('groq'), 'gsk_test');
    consents.accept('groq');
    calls = [];
    script = [];
    ready = [];
    prepared = 0;
    wakeups = [];
  });

  afterEach(async () => {
    await settle();
    db.close();
  });

  describe('privacy: nothing leaves without permission', () => {
    it('offline-only blocks every cloud provider, and nothing is sent', async () => {
      settings.offlineOnly = true;
      const id = addRecording();
      expect(service().request(id)).toEqual({ ok: false, reason: 'offline-only', provider: 'groq', purpose: 'audio' });
      await settle();
      expect(calls).toHaveLength(0);
      expect(prepared).toBe(0);
    });

    it('without consent nothing is sent', async () => {
      consents.revoke('groq');
      const id = addRecording();
      expect(service().request(id)).toEqual({ ok: false, reason: 'needs-consent', provider: 'groq', purpose: 'audio' });
      await settle();
      expect(calls).toHaveLength(0);
    });

    it('without a key nothing is sent', () => {
      secrets.clear(keyName('groq'));
      expect(service().request(addRecording())).toMatchObject({ ok: false, reason: 'needs-setup' });
    });

    it('turning on offline-only stops queued work at the last moment', async () => {
      const s = service();
      const id = addRecording();
      const jobId = jobs.create(id, 'groq', 'm', 'auto');
      settings.offlineOnly = true;
      s.pump();
      await settle();
      expect(calls).toHaveLength(0);
      expect(jobs.get(jobId)).toMatchObject({ status: 'failed', retryable: true });
      expect(jobs.get(jobId)!.error).toMatch(/Offline only/);
    });

    it('the demo provider needs nothing, because nothing leaves', async () => {
      settings = { ...settings, offlineOnly: true, transcriptionProvider: 'fake' };
      consents.revoke('fake');
      expect(service().request(addRecording())).toMatchObject({ ok: true });
      await settle();
      expect(calls).toHaveLength(1);
    });

    it('a trashed recording cannot start paid work', () => {
      const id = addRecording();
      library.trash([id]);
      expect(() => service().request(id)).toThrow(/Restore/);
    });
  });

  it('transcribes, stores a version, indexes it and notifies', async () => {
    const id = addRecording();
    const outcome = service().request(id, 'ur');
    await settle();
    expect(outcome.ok).toBe(true);
    expect(calls[0]).toMatchObject({ language: 'ur', model: 'whisper-large-v3-turbo' });
    const version = transcripts.current(id)!;
    expect(version).toMatchObject({ kind: 'original', provider: 'groq', language: 'en', version: 1 });
    expect(transcripts.segments(version.id)[0]!.text).toBe('hello');
    expect(ready).toEqual([id]);
    expect(library.list({ view: 'all', sort: 'newest', text: 'hello' }).map((r) => r.id)).toEqual([id]);
    expect(library.getRecording(id)!.hasTranscript).toBe(true);
    expect(usage.summary()[0]).toMatchObject({ provider: 'groq', requestsToday: 1, audioMsToday: 1000 });
  });

  it('asking twice does not start a second job', async () => {
    const s = service();
    const id = addRecording();
    const a = s.request(id);
    const b = s.request(id);
    expect(a).toEqual(b);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('long audio is sent in pieces and merged with correct timestamps', async () => {
    const id = addRecording(25 * 60_000);
    service().request(id);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(3);
    expect(prepared).toBe(3);
    const segments = transcripts.segments(transcripts.current(id)!.id);
    expect(segments.map((s) => s.startMs)).toEqual(planChunks(25 * 60_000, new Uint8Array(800), 600_000).map((r) => r.startMs));
    expect(segments[1]!.startMs).toBeGreaterThan(500_000);
  });

  it('HTTP 429: waits as told, keeps finished pieces and continues without re-sending them', async () => {
    const id = addRecording(25 * 60_000);
    script = [() => ok('one'), () => new ProviderError('rate', 'The service asked EchoMind to slow down.', 20_000)];
    const s = service();
    const { jobId } = s.request(id) as { jobId: string };
    await settle();
    const waiting = jobs.get(jobId)!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.nextAttemptAt).toBe(clock + 20_500);
    expect(waiting.error).toMatch(/continue on its own/);
    expect(wakeups).toEqual([20_500]);
    expect(calls).toHaveLength(2);

    // Not due yet: nothing runs.
    s.pump();
    await settle();
    expect(calls).toHaveLength(2);

    clock += 21_000;
    s.pump();
    await settle();
    await settle();
    expect(calls).toHaveLength(4);
    expect(jobs.get(jobId)!.status).toBe('done');
    const segments = transcripts.segments(transcripts.current(id)!.id);
    expect(segments.map((x) => x.text)).toEqual(['one', 'hello', 'hello']);
  });

  it('quota exhaustion tells the user and retries without using up attempts', async () => {
    script = [() => new ProviderError('quota', 'The free limit for this service has been reached.', null)];
    const s = service();
    const { jobId } = s.request(addRecording()) as { jobId: string };
    await settle();
    expect(jobs.get(jobId)).toMatchObject({ status: 'waiting', attempts: 0 });
    expect(jobs.get(jobId)!.error).toMatch(/free limit/);
    expect(jobs.get(jobId)!.nextAttemptAt!).toBeGreaterThan(clock + 25 * 60_000);
  });

  it('network failures back off, then stop and offer retry', async () => {
    script = Array.from({ length: 6 }, () => () => new ProviderError('network', 'No connection.'));
    const s = service();
    const { jobId } = s.request(addRecording()) as { jobId: string };
    for (let i = 0; i < 6; i++) {
      await settle();
      clock += 16 * 60_000;
      s.pump();
    }
    await settle();
    expect(calls).toHaveLength(6);
    expect(jobs.get(jobId)).toMatchObject({ status: 'failed', retryable: true });
    s.retry(jobId);
    await settle();
    expect(jobs.get(jobId)!.status).toBe('done');
  });

  it('a bad key stops immediately, with no retry storm', async () => {
    script = [() => new ProviderError('auth', 'The service rejected the API key.')];
    const { jobId } = service().request(addRecording()) as { jobId: string };
    await settle();
    expect(calls).toHaveLength(1);
    expect(jobs.get(jobId)).toMatchObject({ status: 'failed', retryable: true });
  });

  it('survives a crash: a restart continues after the last finished piece', async () => {
    const id = addRecording(25 * 60_000);
    const jobId = jobs.create(id, 'groq', 'm', 'auto');
    jobs.addChunks(jobId, [{ startMs: 0, endMs: 600_000 }, { startMs: 600_000, endMs: 1_500_000 }]);
    jobs.saveChunk(jobId, 0, [{ startMs: 0, endMs: 1000, text: 'saved before the crash', speaker: null, confidence: null }], 'en');
    jobs.setRunning(jobId, 'Transcribing', 0.4);
    service().resume();
    await settle();
    expect(calls).toHaveLength(1);
    const segments = transcripts.segments(transcripts.current(id)!.id);
    expect(segments.map((s) => s.text)).toEqual(['saved before the crash', 'hello']);
  });

  it('canceling stops the work, and an empty result is not saved as a transcript', async () => {
    const s = service();
    const id = addRecording();
    let release: (v: unknown) => void = () => undefined;
    const slow: TranscriptionProvider = {
      transcribe: (r) =>
        new Promise((_, reject) => {
          release = reject;
          r.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')));
        }),
      testConnection: async () => undefined,
    };
    const cancelable = new TranscriptionService({ jobs, transcripts, library, usage, consents, secrets, settings: () => settings, makeProvider: () => slow, prepareChunk: async () => undefined, tempDir: tmpdir(), changed: () => undefined, transcriptReady: (x) => ready.push(x) });
    const { jobId } = cancelable.request(id) as { jobId: string };
    await settle();
    cancelable.cancel(jobId);
    await settle();
    expect(jobs.get(jobId)!.status).toBe('canceled');
    expect(transcripts.current(id)).toBeNull();
    release(new Error('late'));

    script = [() => ({ language: null, segments: [], rate: null })];
    const other = addRecording();
    const second = s.request(other) as { jobId: string };
    await settle();
    expect(jobs.get(second.jobId)).toMatchObject({ status: 'failed', retryable: false });
    expect(transcripts.current(other)).toBeNull();
  });

  it('deleting a recording removes its transcript, search entries and jobs', async () => {
    const id = addRecording();
    service().request(id);
    await settle();
    library.trash([id]);
    library.deleteForever([id]);
    expect(transcripts.versions(id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_search WHERE transcript_search MATCH 'hello'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get()).toEqual({ n: 0 });
  });
});

describe('transcript versions', () => {
  let db: Db;
  let library: LibraryRepository;
  let transcripts: TranscriptRepository;
  let id: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    library = new LibraryRepository(db);
    transcripts = new TranscriptRepository(db);
    id = library.insertRecording({ title: 'T', mode: 'lecture', source: 'native', format: 'OGG', codec: 'Opus', durationMs: 1000, sizeBytes: 1, sampleRate: 48000, channels: 1, fileName: 'f.ogg', mime: 'audio/ogg', peaks: new Uint8Array(4) });
    transcripts.addOriginal(id, 'groq', 'm', 'en', [seg(0, 0, 500, 'teh model', null, 0.2), seg(1, 500, 1000, 'learns')]);
  });

  afterEach(() => db.close());

  it('editing preserves the original and updates search', () => {
    const original = transcripts.current(id)!;
    transcripts.editSegment(id, 0, 'the model');
    const current = transcripts.current(id)!;
    expect(current.kind).toBe('edited');
    expect(transcripts.segments(current.id)[0]).toMatchObject({ text: 'the model', confidence: null });
    expect(transcripts.segments(original.id)[0]).toMatchObject({ text: 'teh model', confidence: 0.2 });
    expect(library.list({ view: 'all', sort: 'newest', text: 'teh' })).toEqual([]);
    expect(library.list({ view: 'all', sort: 'newest', text: 'the' })).toHaveLength(1);
  });

  it('further edits update one edited copy, not a new version each time', () => {
    transcripts.editSegment(id, 0, 'one');
    transcripts.editSegment(id, 1, 'two');
    expect(transcripts.versions(id).map((v) => v.kind)).toEqual(['edited', 'original']);
    expect(transcripts.segments(transcripts.current(id)!.id).map((s) => s.text)).toEqual(['one', 'two']);
  });

  it('the original can be restored without losing the edits', () => {
    const original = transcripts.current(id)!;
    transcripts.editSegment(id, 0, 'fixed');
    const edited = transcripts.current(id)!;
    transcripts.setCurrent(id, original.id);
    expect(transcripts.current(id)!.kind).toBe('original');
    expect(library.list({ view: 'all', sort: 'newest', text: 'teh' })).toHaveLength(1);
    transcripts.setCurrent(id, edited.id);
    expect(transcripts.segments(transcripts.current(id)!.id)[0]!.text).toBe('fixed');
  });

  it('refuses empty edits, and re-transcribing adds a version', () => {
    expect(() => transcripts.editSegment(id, 0, '   ')).toThrow(/empty/);
    transcripts.addOriginal(id, 'groq', 'm2', 'ur', [seg(0, 0, 1000, 'نیا')]);
    expect(transcripts.versions(id).map((v) => v.version)).toEqual([2, 1]);
    expect(transcripts.current(id)!.version).toBe(2);
  });

  it('speaker names can be changed', () => {
    transcripts.renameSpeaker(id, 'A', 'Dr. Khan');
    transcripts.renameSpeaker(id, 'A', 'Dr. Ali');
    expect(transcripts.speakerNames(id)).toEqual({ A: 'Dr. Ali' });
  });
});

describe('secret storage', () => {
  it('stores only encrypted bytes', () => {
    const db = openDatabase(':memory:');
    const secrets = new SecretStore(db, plainCipher);
    secrets.set('k', 'gsk_secret_value');
    expect(secrets.get('k')).toBe('gsk_secret_value');
    const raw = db.prepare('SELECT value FROM secrets').get() as { value: Uint8Array };
    expect(new TextDecoder().decode(raw.value)).not.toContain('gsk_secret_value');
    secrets.clear('k');
    expect(secrets.has('k')).toBe(false);
    db.close();
  });

  it('refuses to save when encryption is unavailable, rather than storing plain text', () => {
    const db = openDatabase(':memory:');
    const secrets = new SecretStore(db, { ...plainCipher, available: () => false });
    expect(() => secrets.set('k', 'v')).toThrow(/secure storage/);
    expect(secrets.has('k')).toBe(false);
    db.close();
  });

  it('a key that can no longer be decrypted reads as missing', () => {
    const db = openDatabase(':memory:');
    new SecretStore(db, plainCipher).set('k', 'v');
    const broken = new SecretStore(db, { ...plainCipher, decrypt: () => { throw new Error('nope'); } });
    expect(broken.get('k')).toBeNull();
    db.close();
  });
});
