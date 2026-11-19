import { describe, expect, it } from 'vitest';
import { ModelFallbackProvider, pickModel } from '../../src/main/ai/model-fallback';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from '../../src/main/ai/types';
import { toProviderError } from '../../src/main/ai/whisper-http';

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
