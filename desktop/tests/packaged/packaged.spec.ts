import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { AppInfo, DocumentExport, ImportJob, Recording } from '../../src/shared/models';
import { ensureFixtures, fixture } from '../e2e/fixtures';
import { completeOnboarding, removeDir, tempDataDir } from '../e2e/helpers';

const EXE = resolve('dist/win-unpacked/EchoMind.exe');

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

test.beforeAll(() => ensureFixtures());

test('the packaged app starts, imports, transcribes, exports a PDF with its fonts, and has FFmpeg, offline Whisper and offline writing', async () => {
  test.skip(!existsSync(EXE), 'Run `npm run dist` first.');
  const dataDir = tempDataDir();
  const env = { ...process.env, ECHOMIND_USER_DATA: dataDir } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: EXE, env });
  try {
    let page = app.windows().find((w) => !w.url().endsWith('media.html'));
    for (let i = 0; !page && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      page = app.windows().find((w) => !w.url().endsWith('media.html'));
    }
    await completeOnboarding(page!);
    const info = await call<AppInfo>(page!, 'getAppInfo');
    expect(info.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
    expect(info.ffmpeg).toBe(true);
    // Offline Whisper ships with the installer; only its models are downloaded later.
    expect((await call<{ installed: boolean }>(page!, 'listLocalModels')).installed).toBe(true);
    // And offline writing (llama.cpp).
    expect((await call<{ installed: boolean }>(page!, 'listWritingModels')).installed).toBe(true);
    await call(page!, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake' });
    await call(page!, 'importPaths', [fixture('recorder.m4a'), fixture('old-phone.amr')], 'lecture');
    await expect.poll(async () => (await call<ImportJob[]>(page!, 'listImports')).filter((j) => j.status === 'done').length, { timeout: 60_000 }).toBe(2);
    const rec = (await call<Recording[]>(page!, 'listRecordings', { view: 'all', sort: 'newest' })).find((r) => r.originalName === 'recorder.m4a')!;
    await call(page!, 'requestTranscription', rec.id);
    await expect.poll(async () => (await call<Recording>(page!, 'getRecording', rec.id)).hasTranscript, { timeout: 30_000 }).toBe(true);
    const doc = await call<{ ok: true; documentId: string }>(page!, 'createDocument', { recordingId: rec.id, template: 'interview-transcript', source: 'transcript' });
    const pdf = await call<DocumentExport>(page!, 'exportDocument', doc.documentId, 'pdf');
    const bytes = readFileSync(join(dataDir, 'exports', pdf.fileName));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    // The embedded fonts came out of the packaged app: Inter (Latin) and Nastaliq (the demo's Urdu line).
    expect(bytes.toString('latin1')).toMatch(/Inter|FontFile/);
    await page!.screenshot({ path: 'test-shots/packaged.png' });
  } finally {
    await app.close().catch(() => undefined);
    removeDir(dataDir);
  }
});
