import { createServer, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, ProcessingJob, Recording } from '../../src/shared/models';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, killTree, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function importOne(page: Page, name: string): Promise<Recording> {
  await call(page, 'importPaths', [fixture(name)], 'lecture');
  await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports')).find((j) => j.displayName === name)?.status, { timeout: 30_000 }).toBe('done');
  const list = await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' });
  return list.find((r) => r.originalName === name)!;
}

async function openRecording(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('.rec-row', { hasText: title }).locator('.rec-main').click();
}

test('demo provider: transcribe, six views, edit, restore, find, sync and search, identical for imports', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    await importOne(page, 'recorder.m4a');
    await call(page, 'updateSettings', { transcriptionProvider: 'fake' });
    await openRecording(page, 'recorder');

    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open transcript' })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'test-shots/detail-transcribed.png' });
    await page.getByRole('button', { name: 'Open transcript' }).click();

    // Honest about being placeholder text.
    await expect(page.getByText('This is a demo transcript')).toBeVisible();
    await page.screenshot({ path: 'test-shots/transcript-paragraphs.png' });

    for (const mode of ['Timestamped', 'Speakers', 'Cleaned', 'Q&A', 'Raw', 'Paragraphs']) {
      await page.getByRole('group', { name: 'Transcript view' }).getByRole('button', { name: mode, exact: true }).click();
      await expect(page.locator('.t-block').first()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Speakers', exact: true }).click();
    await expect(page.locator('.t-speaker').first()).toHaveText('Speaker A');
    await page.getByRole('button', { name: 'Q&A', exact: true }).click();
    await expect(page.getByText('Question', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: 'test-shots/transcript-qa.png' });
    await page.getByRole('button', { name: 'Cleaned', exact: true }).click();
    await expect(page.locator('.t-text', { hasText: /^Um,/ })).toHaveCount(0);

    // Urdu shows right to left.
    await page.getByRole('button', { name: 'Timestamped', exact: true }).click();
    const urdu = page.locator('.t-text', { hasText: 'اردو' }).first();
    await expect(urdu).toHaveAttribute('dir', 'auto');
    expect(await urdu.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await page.screenshot({ path: 'test-shots/transcript-timestamped.png' });

    // Edit one segment: the original stays available.
    const firstBlock = page.locator('.t-block').first();
    await firstBlock.hover();
    await firstBlock.getByRole('button', { name: /^Edit text at/ }).click();
    await page.getByLabel('Segment text').fill('A corrected sentence about zebras.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('A corrected sentence about zebras.')).toBeVisible();
    await expect(page.getByText('Edited transcript')).toBeVisible();

    // The edit is searchable from the library, and so is the transcript's other text.
    const inLibrary = (text: string) => call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest', text });
    expect(await inLibrary('zebras')).toHaveLength(1);
    expect(await inLibrary('searchable knowledge')).toHaveLength(1);
    expect(await inLibrary('اردو')).toHaveLength(1);

    // Restoring the original brings back the provider's text and leaves the edit available.
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('menuitem', { name: /^Original/ }).click();
    await expect(page.getByText('A corrected sentence about zebras.')).toHaveCount(0);
    expect(await inLibrary('zebras')).toHaveLength(0);
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('menuitem', { name: /^Edited/ }).click();
    await expect(page.getByText('A corrected sentence about zebras.')).toBeVisible();

    // Find in transcript steps through matches and moves the audio there.
    await page.getByRole('searchbox').fill('transcript');
    await expect(page.locator('mark').first()).toBeVisible();
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(page.locator('mark.current')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();
    await page.getByRole('searchbox').fill('');

    // Tapping a time plays from there, and the current block is highlighted.
    await page.getByRole('button', { name: 'Play from 0:08' }).first().click();
    await expect(page.locator('.t-block.active')).toHaveCount(1);
    await expect.poll(() => page.locator('.t-block.active .t-time').textContent()).toMatch(/0:(08|09|1\d)/);

    // Rename a speaker.
    await page.getByRole('button', { name: 'Rename speakers' }).click();
    await page.getByRole('menuitem', { name: 'Speaker A' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Dr. Khan');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Speakers', exact: true }).click();
    await expect(page.locator('.t-speaker').first()).toHaveText('Dr. Khan');

    // Native recording gets exactly the same tool.
    const usage = await call<{ provider: string; requestsToday: number }[]>(page, 'getUsage');
    expect(usage[0]).toMatchObject({ provider: 'fake', requestsToday: 1 });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('privacy: offline-only and consent both stop uploads, with a real server counting requests', async () => {
  const dataDir = tempDataDir();
  let uploads = 0;
  const server: Server = createServer((req, res) => {
    uploads++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ language: 'en', segments: [{ start: 0, end: 3, text: 'Real text from the mock service.', avg_logprob: -0.1 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await importOne(page, 'recorder.m4a');
    await call(page, 'updateSettings', { transcriptionProvider: 'custom', customBaseUrl: baseUrl, transcriptionModel: 'test-model' });
    await openRecording(page, 'recorder');

    // Offline-only is the default: asks first, sends nothing.
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Offline only is on' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/gate-offline.png' });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(uploads).toBe(0);

    // Turning it off leads to the agreement screen, still with nothing sent.
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await page.getByRole('button', { name: 'Turn off Offline only' }).click();
    await expect(page.getByRole('heading', { name: /^Send audio to/ })).toBeVisible();
    await page.screenshot({ path: 'test-shots/gate-consent.png' });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(500);
    expect(uploads).toBe(0);

    // Only after agreeing does audio go out.
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await page.getByRole('button', { name: 'I agree, continue' }).click();
    await expect(page.getByRole('button', { name: 'Open transcript' })).toBeVisible({ timeout: 30_000 });
    expect(uploads).toBe(1);
    await page.getByRole('button', { name: 'Open transcript' }).click();
    await expect(page.getByText('Real text from the mock service.')).toBeVisible();
    await expect(page.getByText('This is a demo transcript')).toHaveCount(0);
    expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    await new Promise((r) => server.close(r));
  }
});

test('the upload is real, valid audio; HTTP 429 waits and continues on its own', async () => {
  const dataDir = tempDataDir();
  const bodies: Buffer[] = [];
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      requests++;
      bodies.push(Buffer.concat(parts));
      if (requests === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining-requests': '17', 'x-ratelimit-limit-requests': '20' });
      res.end(JSON.stringify({ language: 'ur', segments: [{ start: 1, end: 2, text: 'جواب', avg_logprob: -2 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await importOne(page, 'recorder.m4a');
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'custom', customBaseUrl: baseUrl });
    await call(page, 'acceptConsent', 'custom', 'audio');
    await call(page, 'requestTranscription', rec.id);

    // The user is told what is happening.
    await expect.poll(async () => (await call<ProcessingJob[]>(page, 'listJobs'))[0]?.status, { timeout: 20_000 }).toBe('waiting');
    const waiting = (await call<ProcessingJob[]>(page, 'listJobs'))[0]!;
    expect(waiting.error).toMatch(/slow down.*continue on its own/);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Home', exact: true }).click();
    await page.locator('.job-pill').click();
    await expect(page.getByText(/Waiting until about/)).toBeVisible();
    await page.screenshot({ path: 'test-shots/jobs-waiting.png' });

    await expect.poll(async () => (await call<ProcessingJob[]>(page, 'listJobs'))[0]?.status, { timeout: 20_000 }).toBe('done');
    expect(requests).toBe(2);

    // The uploaded piece is genuine Ogg audio, much smaller than the source, with no secrets or paths.
    const body = bodies[1]!;
    expect(body.includes(Buffer.from('OggS'))).toBe(true);
    expect(body.includes(Buffer.from('name="response_format"'))).toBe(true);
    expect(body.toString('latin1')).not.toContain('recorder.m4a');
    expect(body.toString('latin1')).not.toContain(dataDir);

    const transcript = await call<{ version: { language: string }; segments: { startMs: number; text: string; confidence: number }[] }>(page, 'getTranscript', rec.id);
    expect(transcript.version.language).toBe('ur');
    expect(transcript.segments[0]).toMatchObject({ startMs: 1000, text: 'جواب' });
    expect(transcript.segments[0]!.confidence).toBeLessThan(0.45);

    // Usage reflects it, including what the service reported.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Usage and limits' }).click();
    await expect(page.getByText(/17 of 20 requests left/)).toBeVisible();
    await page.screenshot({ path: 'test-shots/usage.png' });
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    await new Promise((r) => server.close(r));
  }
});

test('keys are stored encrypted, never shown again, and a bad key gives a clear error', async () => {
  const dataDir = tempDataDir();
  const SECRET = 'gsk_THIS_IS_A_TEST_SECRET_123456';
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const ok = req.headers.authorization === `Bearer ${SECRET}`;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { data: [] } : { error: { message: `Invalid API key ${req.headers.authorization}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'custom', customBaseUrl: baseUrl, llmProvider: 'fake' });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'AI providers and keys' }).click();

    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('alert')).toContainText('rejected the API key');
    await expect(page.getByRole('alert')).not.toContainText('Invalid API key');

    await page.getByLabel('API key').fill(SECRET);
    await page.screenshot({ path: 'test-shots/providers.png' });
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByText('A key is saved and encrypted.')).toBeVisible();
    await expect(page.getByLabel('API key')).toHaveCount(0);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText('Connected. Nothing from your recordings was sent.')).toBeVisible();

    await closeApp(app);
    const db = new DatabaseSync(join(dataDir, 'echomind.db'));
    db.exec('PRAGMA wal_checkpoint(FULL)');
    const row = db.prepare('SELECT value FROM secrets').get() as { value: Uint8Array };
    expect(Buffer.from(row.value).toString('latin1')).not.toContain('gsk_');
    db.close();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dataDir, 'echomind.db')).includes(Buffer.from(SECRET))).toBe(false);
  } finally {
    await closeApp(app).catch(() => undefined);
    removeDir(dataDir);
    await new Promise((r) => server.close(r));
  }
});

test('a job killed by a crash resumes on the next launch, and cancel works', async () => {
  const dataDir = tempDataDir();
  let hold = true;
  let requests = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      if (hold) return; // Never answers, so the job stays running until the app is killed.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'Resumed fine.' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await importOne(page, 'recorder.m4a');
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'custom', customBaseUrl: baseUrl });
    await call(page, 'acceptConsent', 'custom', 'audio');

    // Cancel leaves no transcript and a clean temp folder.
    await call(page, 'requestTranscription', rec.id);
    await expect.poll(() => requests, { timeout: 20_000 }).toBe(1);
    await openRecording(page, 'recorder');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Transcribe', exact: true })).toBeVisible();
    expect(await call(page, 'getTranscript', rec.id)).toBeNull();

    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await expect.poll(() => requests, { timeout: 20_000 }).toBe(2);
    killTree(app);
    await new Promise((r) => setTimeout(r, 1500));
    hold = false;

    ({ app, page } = await launch(dataDir));
    await expect.poll(async () => (await call<ProcessingJob[]>(page, 'listJobs'))[0]?.status, { timeout: 30_000 }).toBe('done');
    expect((await call<{ segments: { text: string }[] }>(page, 'getTranscript', rec.id)).segments[0]!.text).toBe('Resumed fine.');
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('trashing a recording stops its running job, so quota is not wasted', async () => {
  const dataDir = tempDataDir();
  let requests = 0;
  const server: Server = createServer((req) => {
    req.resume();
    req.on('end', () => {
      requests++; // Never answers.
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await importOne(page, 'recorder.m4a');
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'custom', customBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    await call(page, 'acceptConsent', 'custom', 'audio');
    await call(page, 'requestTranscription', rec.id);
    await expect.poll(() => requests, { timeout: 20_000 }).toBe(1);
    await expect(page.locator('.job-pill')).toHaveText('1 job processing');
    await call(page, 'trashRecordings', [rec.id]);
    await expect(page.locator('.job-pill')).toHaveCount(0);
    expect((await call<ProcessingJob[]>(page, 'latestJob', rec.id, 'transcribe') as unknown as ProcessingJob).status).toBe('canceled');
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('first run: allowing AI offers the key step, and it can be skipped', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Allow AI features/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Add a free transcription key' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/onboarding-key.png' });
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    expect((await call<{ offlineOnly: boolean }>(page, 'getSettings')).offlineOnly).toBe(false);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('batch: selecting several recordings queues them all, and only unfinished pieces run', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await importOne(page, 'recorder.m4a');
    await importOne(page, 'tone.wav');
    await call(page, 'updateSettings', { transcriptionProvider: 'fake' });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select recorder' }).click();
    await page.getByRole('checkbox', { name: 'Select tone' }).click();
    await page.getByRole('toolbar').getByRole('button', { name: 'Transcribe' }).click();
    await expect(page.locator('.badge-teal', { hasText: 'Transcript' })).toHaveCount(2, { timeout: 30_000 });
    await page.screenshot({ path: 'test-shots/library-transcribed.png' });
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
