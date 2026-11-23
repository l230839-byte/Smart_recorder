import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatHttpProvider } from '../../src/main/ai/chat-http';
import { ModelFallbackProvider, pickModel } from '../../src/main/ai/model-fallback';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from '../../src/main/ai/types';
import { toProviderError, WhisperHttpProvider } from '../../src/main/ai/whisper-http';
import { reasoningOptions } from '../../src/shared/providers';

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('a retired model is told apart from other errors', () => {
  it('as Groq and OpenAI-style services report it', async () => {
    const groq404 = await toProviderError(response(404, { error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', code: 'model_not_found' } }));
    expect(groq404).toMatchObject({ kind: 'model' });
    const decommissioned = await toProviderError(response(400, { error: { message: 'The model `x` has been decommissioned and is no longer supported.', code: 'model_decommissioned' } }));
    expect(decommissioned).toMatchObject({ kind: 'model' });
    expect(await toProviderError(response(404, { error: { message: 'Not found' } }))).toMatchObject({ kind: 'rejected' });
    expect(await toProviderError(response(400, { error: { message: 'messages must not be empty' } }))).toMatchObject({ kind: 'rejected' });
  });
});

describe('choosing a replacement', () => {
  const live = ['allam-2-7b', 'meta-llama/llama-prompt-guard-2-22m', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'whisper-large-v3'];
  it('prefers EchoMind’s list, then any text model, never speech or safety models', () => {
    expect(pickModel(live, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], 'llama-3.3-70b-versatile')).toBe('openai/gpt-oss-120b');
    expect(pickModel(live, ['openai/gpt-oss-120b'], 'openai/gpt-oss-120b')).toBe('allam-2-7b');
    expect(pickModel(['whisper-large-v3', 'llama-guard-4'], [], 'gone')).toBeNull();
  });
});

describe('recovering from a retired model', () => {
  const ok = (model: string): ChatResult => ({ text: `answer from ${model}`, truncated: false, inputTokens: 1, outputTokens: 1, rate: null });
  const request = (model: string): ChatRequest => ({ messages: [{ role: 'user', content: 'hi' }], model, maxOutputTokens: 10, json: false, signal: new AbortController().signal, task: 'summary' });

  it('switches once, remembers the switch, and reports it', async () => {
    const asked: string[] = [];
    const inner: ChatProvider = {
      complete: async (r) => {
        asked.push(r.model);
        if (r.model === 'old') throw new ProviderError('model', 'gone');
        return ok(r.model);
      },
      listModels: async () => ['new', 'other'],
      testConnection: async () => undefined,
    };
    const switches: string[] = [];
    const provider = new ModelFallbackProvider(inner, ['new'], (from, to) => switches.push(`${from}->${to}`));
    expect((await provider.complete(request('old'))).text).toBe('answer from new');
    expect((await provider.complete(request('old'))).text).toBe('answer from new');
    expect(asked).toEqual(['old', 'new', 'new']);
    expect(switches).toEqual(['old->new']);
  });

  it('other errors pass through, and no usable model gives a clear message', async () => {
    const rate: ChatProvider = { complete: async () => Promise.reject(new ProviderError('rate', 'slow down', 1000)), listModels: async () => ['x'], testConnection: async () => undefined };
    await expect(new ModelFallbackProvider(rate, [], () => undefined).complete(request('m'))).rejects.toMatchObject({ kind: 'rate' });
    const none: ChatProvider = { complete: async () => Promise.reject(new ProviderError('model', 'gone')), listModels: async () => ['whisper-large-v3'], testConnection: async () => undefined };
    await expect(new ModelFallbackProvider(none, [], () => undefined).complete(request('m'))).rejects.toThrow(/Choose one in Settings/);
  });
});

describe('what live models taught us', () => {
  it('deadline words become the right dates, counted from the recording day', async () => {
    const { resolveDueDate } = await import('../../src/shared/studio');
    const thursday = '2026-11-19';
    const cases: [string, string | null][] = [
      ['by Friday', '2026-11-20'],
      ['next Monday', '2026-11-23'],
      ['by Wednesday', '2026-11-25'],
      ['on Thursday at 10 in the morning', '2026-11-26'],
      ['Thurs', '2026-11-26'],
      ['tomorrow', '2026-11-20'],
      ['today', '2026-11-19'],
      ['end of the week', '2026-11-20'],
      ['end of the month', '2026-11-30'],
      ['in 2 weeks', '2026-12-03'],
      ['March 14th', '2027-03-14'],
      ['14th of March 2026', '2026-03-14'],
      ['December 1', '2026-12-01'],
      ['2026-12-24', '2026-12-24'],
      ['next week', null],
      ['soon', null],
      ['', null],
    ];
    for (const [words, date] of cases) expect(resolveDueDate(words, thursday), words).toBe(date);
  });

  it('citations in other brackets are linked like any other', async () => {
    const { resolveCitations } = await import('../../src/shared/summaries');
    const segments = [{ idx: 1, startMs: 6400, endMs: 8000, text: 'x', speaker: null, confidence: null }];
    const out = resolveCitations('Launch moved【S1】. Also ［S1］ and (S1, S1).', segments);
    expect(out.markdown).toBe('Launch moved [0:06](cite:6400). Also [0:06](cite:6400) and [0:06](cite:6400) [0:06](cite:6400).');
    expect(out.dropped).toBe(0);
    expect(resolveCitations('See (Section 2) and (S9).', segments)).toMatchObject({ markdown: 'See (Section 2) and.', dropped: 1 });
  });
});

describe('more citation styles seen live', () => {
  it('spaces inside brackets', async () => {
    const { resolveCitations } = await import('../../src/shared/summaries');
    const segments = [1, 2].map((idx) => ({ idx, startMs: idx * 1000, endMs: idx * 1000 + 500, text: 'x', speaker: null, confidence: null }));
    expect(resolveCitations('Moved [ S1 ] and owners [ S1, S2 ].', segments)).toMatchObject({ markdown: 'Moved [0:01](cite:1000) and owners [0:01](cite:1000) [0:02](cite:2000).', used: 3, dropped: 0 });
  });
});

describe('what Gemini taught us', () => {
  it('a bare 404 from a chat request means the model, so EchoMind can switch', async () => {
    const { ChatHttpProvider } = await import('../../src/main/ai/chat-http');
    const fetchFn = (async (url: string) => (String(url).endsWith('/models') ? response(200, { data: [{ id: 'models/gemini-3.5-flash-lite' }, { id: 'models/gemini-embedding-001' }] }) : new Response('', { status: 404 }))) as typeof fetch;
    const http = new ChatHttpProvider('https://example.test/v1', 'k', fetchFn);
    const request = { messages: [{ role: 'user' as const, content: 'hi' }], model: 'openai/gpt-oss-120b', maxOutputTokens: 5, json: false, signal: new AbortController().signal, task: 'summary' as const };
    await expect(http.complete(request)).rejects.toMatchObject({ kind: 'model' });
    // Gemini's "models/" prefix is removed, so the names match EchoMind's.
    expect(await http.listModels(new AbortController().signal)).toEqual(['gemini-3.5-flash-lite', 'gemini-embedding-001']);
  });

  it('when even the model list cannot be read, the original error is shown', async () => {
    const original = new ProviderError('model', 'The service does not recognize this model or address. Check Settings.');
    const broken: ChatProvider = { complete: async () => Promise.reject(original), listModels: async () => Promise.reject(new Error('404')), testConnection: async () => undefined };
    await expect(new ModelFallbackProvider(broken, ['x'], () => undefined).complete({ messages: [], model: 'm', maxOutputTokens: 1, json: false, signal: new AbortController().signal, task: 'summary' })).rejects.toBe(original);
  });

  it('changing provider drops a model that belongs to the old one', async () => {
    const { openDatabase } = await import('../../src/main/db/database');
    const { SettingsStore } = await import('../../src/main/services/settings');
    const db = openDatabase(':memory:');
    const store = new SettingsStore(db);
    store.update({ llmProvider: 'groq', llmModel: 'openai/gpt-oss-120b' });
    expect(store.update({ llmProvider: 'gemini' }).llmModel).toBeNull();
    // A model chosen together with the provider is kept, and one that fits the new provider is kept too.
    expect(store.update({ llmProvider: 'groq', llmModel: 'openai/gpt-oss-20b' }).llmModel).toBe('openai/gpt-oss-20b');
    store.update({ llmProvider: 'gemini', llmModel: 'gemini-3.8-flash' });
    expect(store.update({ offlineOnly: false }).llmModel).toBe('gemini-3.8-flash');
    db.close();
  });
});

describe('a stalled connection never hangs a job', () => {
  // A service that accepts the request and never answers, like a dropped mobile connection.
  const silent: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
    });
  const request = (signal: AbortSignal): ChatRequest => ({ messages: [{ role: 'user', content: 'hi' }], model: 'm', maxOutputTokens: 10, json: false, signal, task: 'chat' });

  it('a chat request gives up in time, as a network error the queue retries', async () => {
    const provider = new ChatHttpProvider('http://example.invalid', 'k', silent, 50);
    await expect(provider.complete(request(new AbortController().signal))).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/did not answer in time/) });
  });

  it('a transcription request does too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeout-'));
    const file = join(dir, 'a.ogg');
    writeFileSync(file, new Uint8Array(16));
    const provider = new WhisperHttpProvider('http://example.invalid', 'k', silent, 50);
    await expect(provider.transcribe({ filePath: file, fileName: 'a.ogg', mime: 'audio/ogg', durationMs: 1000, model: 'w', language: null, signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'network' });
  });

  it('canceling is still a cancel, not a failure', async () => {
    const provider = new ChatHttpProvider('http://example.invalid', 'k', silent, 60_000);
    const controller = new AbortController();
    const pending = provider.complete(request(controller.signal));
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('what a three-hour recording taught us', () => {
  const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  const invalid = () => new Response(JSON.stringify({ error: { message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.", code: 'json_validate_failed' } }), { status: 400 });
  const request: ChatRequest = { messages: [{ role: 'user', content: 'chapters' }], model: 'm', maxOutputTokens: 10, json: true, signal: new AbortController().signal, task: 'chapters' };

  it('a JSON reply Groq refuses as invalid is asked for once more', async () => {
    let calls = 0;
    const provider = new ChatHttpProvider('https://example.test/v1', 'k', async () => (++calls === 1 ? invalid() : ok('{"chapters":[]}')));
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{"chapters":[]}' });
    expect(calls).toBe(2);
  });

  it('refused twice, it is a server problem the queue retries, not a refusal that ends the job', async () => {
    const provider = new ChatHttpProvider('https://example.test/v1', 'k', async () => invalid());
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'server' });
    const plain = new ChatHttpProvider('https://example.test/v1', 'k', async () => invalid());
    await expect(plain.complete({ ...request, json: false })).rejects.toMatchObject({ kind: 'rejected' });
  });

  // Seen live: gpt-oss-120b spent 1,498 of 1,500 tokens reasoning and returned no text, 77 times running.
  const thoughtOnly = () => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning: 'thinking…' }, finish_reason: 'length' }], usage: { completion_tokens: 10 } }), { status: 200 });

  it('a reply that is all reasoning is asked for again with twice the room', async () => {
    const budgets: number[] = [];
    const provider = new ChatHttpProvider('https://example.test/v1', 'k', async (_url, init) => {
      budgets.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
      return budgets.length === 1 ? thoughtOnly() : ok('notes');
    });
    await expect(provider.complete({ ...request, json: false })).resolves.toMatchObject({ text: 'notes' });
    expect(budgets).toEqual([10, 20]);
  });

  it('all reasoning twice is a server problem the queue retries, with a clear reason', async () => {
    const provider = new ChatHttpProvider('https://example.test/v1', 'k', async () => thoughtOnly());
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'server', message: expect.stringContaining('thinking') });
  });

  it('a plain empty reply is still reported as empty, without the extra try', async () => {
    let calls = 0;
    const provider = new ChatHttpProvider('https://example.test/v1', 'k', async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), { status: 200 });
    });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'server', message: expect.stringContaining('empty') });
    expect(calls).toBe(1);
  });

  it('thinking models are asked to keep reasoning short; other services get no unknown fields', async () => {
    expect(reasoningOptions('groq', 'openai/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningOptions('gemini', 'gemini-3.5-flash-lite')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningOptions('groq', 'qwen/qwen3.8-27b')).toEqual({});
    expect(reasoningOptions('custom-chat', 'openai/gpt-oss-120b')).toEqual({});
    let body: Record<string, unknown> = {};
    const provider = new ChatHttpProvider('https://example.test/v1', 'k', async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ok('{}');
    }, undefined, (model) => reasoningOptions('groq', model));
    await provider.complete({ ...request, model: 'openai/gpt-oss-120b' });
    expect(body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low' });
  });
});
