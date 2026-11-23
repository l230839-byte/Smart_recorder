import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWhisperCppJson } from '../../src/main/ai/local-whisper';
import { LocalModelStore } from '../../src/main/services/local-models';
import { LOCAL_MODELS, LOCAL_MODEL_IDS, PROVIDER_INFO, type LocalModelId } from '../../src/shared/providers';

describe('reading whisper.cpp output', () => {
  // The shape whisper-cli -oj wrote on 2026-11-23 for the two-voice test clip.
  const output = {
    result: { language: 'en' },
    transcription: [
      { timestamps: { from: '00:00:00,000', to: '00:00:05,680' }, offsets: { from: 0, to: 5680 }, text: ' Good morning everyone. The solar farm in Lahore produced 40 megawatt hours last week.' },
      { offsets: { from: 5700, to: 6400 }, text: ' [BLANK_AUDIO]' },
      { offsets: { from: 6560, to: 10720 }, text: ' Thanks Sarah. We decided to hire three engineers by March.' },
      { offsets: { from: 10900, to: 12500 }, text: ' (music)' },
    ],
  };

  it('keeps the words with their times and the detected language, and drops non-speech tags', () => {
    expect(parseWhisperCppJson(output, 12_000)).toEqual({
      language: 'en',
      segments: [
        { startMs: 0, endMs: 5680, text: 'Good morning everyone. The solar farm in Lahore produced 40 megawatt hours last week.', speaker: null, confidence: null },
        { startMs: 6560, endMs: 10720, text: 'Thanks Sarah. We decided to hire three engineers by March.', speaker: null, confidence: null },
      ],
    });
  });

  it('clamps times to the piece, and silence is an empty transcript', () => {
    const late = parseWhisperCppJson({ transcription: [{ offsets: { from: 9000, to: 12000 }, text: ' End.' }] }, 10_000);
    expect(late.segments[0]).toMatchObject({ startMs: 9000, endMs: 10_000 });
    expect(parseWhisperCppJson({ result: { language: 'en' }, transcription: [] }, 5000).segments).toEqual([]);
    expect(() => parseWhisperCppJson(null, 5000)).toThrow(/no readable result/);
  });
});

describe('offline models', () => {
  it('every published model is multilingual, has a size and a SHA-256, and Small comes first', () => {
    expect(PROVIDER_INFO.local).toMatchObject({ local: true, needsKey: false, pieceFormat: 'wav16k' });
    expect(PROVIDER_INFO.local.models[0]).toBe('small');
    for (const id of LOCAL_MODEL_IDS) {
      expect(LOCAL_MODELS[id].file).toMatch(/^ggml-[a-z0-9-]+-q\d_\d\.bin$/);
      expect(LOCAL_MODELS[id].file).not.toMatch(/\.en/);
      expect(LOCAL_MODELS[id].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  const content = Buffer.from('a small stand-in for a model file, long enough to split in two parts');
  const hash = createHash('sha256').update(content).digest('hex');
  const catalog = Object.fromEntries(LOCAL_MODEL_IDS.map((id) => [id, { file: `${id}.bin`, sizeMb: 1, sha256: hash }])) as Record<LocalModelId, { file: string; sizeMb: number; sha256: string }>;

  it('downloads, checks the hash, and only then gives the model its final name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echomind-models-'));
    const urls: string[] = [];
    const store = new LocalModelStore(dir, () => undefined, async (url) => {
      urls.push(String(url));
      return new Response(content, { status: 200, headers: { 'content-length': String(content.length) } });
    }, catalog);
    expect(store.installed('tiny')).toBe(false);
    await store.download('tiny');
    expect(urls).toEqual(['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/tiny.bin']);
    expect(store.installed('tiny')).toBe(true);
    expect(readFileSync(store.path('tiny'))).toEqual(content);
    expect(existsSync(`${store.path('tiny')}.part`)).toBe(false);
    await store.remove('tiny');
    expect(store.installed('tiny')).toBe(false);
  });

  it('continues an interrupted download from where it stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echomind-models-'));
    const half = 30;
    writeFileSync(join(dir, 'base.bin.part'), content.subarray(0, half));
    let range: string | null = null;
    const store = new LocalModelStore(dir, () => undefined, async (_url, init) => {
      range = new Headers(init?.headers).get('range');
      return new Response(content.subarray(half), { status: 206, headers: { 'content-length': String(content.length - half) } });
    }, catalog);
    expect(store.list().find((m) => m.id === 'base')!.partialBytes).toBe(half);
    await store.download('base');
    expect(range).toBe(`bytes=${half}-`);
    expect(readFileSync(store.path('base'))).toEqual(content);
  });

  it('a file that does not match its published hash is deleted, never used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echomind-models-'));
    const store = new LocalModelStore(dir, () => undefined, async () => new Response(Buffer.from('tampered'), { status: 200 }), catalog);
    await expect(store.download('small')).rejects.toThrow(/did not match its published checksum/);
    expect(store.installed('small')).toBe(false);
    expect(existsSync(`${store.path('small')}.part`)).toBe(false);
  });

  it('a failed connection keeps the part file and says how to continue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echomind-models-'));
    const store = new LocalModelStore(dir, () => undefined, async () => Promise.reject(new TypeError('fetch failed')), catalog);
    await expect(store.download('medium')).rejects.toThrow(/continues where it stopped/);
    expect(store.list().find((m) => m.id === 'medium')).toMatchObject({ installed: false, downloading: null });
  });
});
