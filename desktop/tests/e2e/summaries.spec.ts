import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, ProcessingJob, Recording, Summary } from '../../src/shared/models';
import { DEFAULT_SUMMARY_OPTIONS } from '../../src/shared/summaries';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function transcribed(page: Page, name = 'recorder.m4a'): Promise<Recording> {
  await call(page, 'importPaths', [fixture(name)], 'lecture');
  await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports')).find((j) => j.displayName === name)?.status, { timeout: 30_000 }).toBe('done');
  const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).find((r) => r.originalName === name)!;
  await call(page, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake' });
  await call(page, 'requestTranscription', rec.id);
  await expect.poll(async () => (await call<Recording>(page, 'getRecording', rec.id)).hasTranscript, { timeout: 20_000 }).toBe(true);
  return rec;
}

async function openRecording(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('.rec-row', { hasText: title }).locator('.rec-main').click();
}

test('demo provider: formats, versions, citations jump to audio, no re-transcription, templates', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);
    await openRecording(page, 'recorder');
    await page.getByRole('button', { name: 'Summaries', exact: true }).click();

    await expect(page.getByText('No summaries yet')).toBeVisible();
    await page.screenshot({ path: 'test-shots/summaries-empty.png' });

    // Workflow B: bullets, then paragraphs, then structured, from one transcript.
    for (const [format, label] of [['bullets', 'Bullet points'], ['paragraphs', 'Paragraphs'], ['structured', 'Structured notes']] as const) {
      await page.getByLabel('Format').selectOption(format);
      await page.getByRole('button', { name: /^Generate/ }).click();
      await expect(page.getByLabel('Summary version').locator('option:checked')).toContainText(label, { timeout: 15_000 });
    }
    const versions = await call<Summary[]>(page, 'listSummaries', rec.id);
    expect(versions).toHaveLength(3);
    const jobs = await call<ProcessingJob[]>(page, 'listJobs');
    expect(jobs.filter((j) => j.kind === 'transcribe')).toHaveLength(1);

    await expect(page.getByText('This is demo text')).toBeVisible();
    await page.screenshot({ path: 'test-shots/summaries-result.png' });

    // Citations are real buttons that play the source, and raw ids are gone.
    await expect(page.locator('.md').getByText(/\[S\d/)).toHaveCount(0);
    const cite = page.getByRole('button', { name: /^Play source at 0:0[2-9]/ }).first();
    await cite.click();
    await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Now playing' }).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    // Older versions stay available.
    await page.getByLabel('Summary version').selectOption({ index: 2 });
    await expect(page.getByLabel('Summary version').locator('option:checked')).toContainText('Bullet points');

    // Every control reaches the service.
    await page.getByText('More controls').click();
    await page.getByLabel('Focus on topics').fill('neural networks');
    await page.getByLabel('Length').selectOption('custom');
    await page.getByLabel('Word count').fill('77');
    await page.getByLabel('Tone').selectOption('custom');
    await page.getByLabel('Describe the tone').fill('warm');
    await page.screenshot({ path: 'test-shots/summaries-controls.png' });

    // Saved template comes back, without the time range.
    await page.getByRole('button', { name: 'Save these settings as a template' }).click();
    await page.getByRole('textbox', { name: 'Template name' }).fill('Exam prep');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Length').selectOption('short');
    await page.getByLabel('Template', { exact: true }).selectOption({ label: 'Exam prep' });
    await expect(page.getByLabel('Length')).toHaveValue('custom');
    await expect(page.getByLabel('Word count')).toHaveValue('77');

    // A time range.
    await page.getByLabel('Cover').selectOption('range');
    await page.getByLabel('From (minutes)').fill('5');
    await page.getByLabel('To (minutes)').fill('2');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await expect(page.getByText('end comes after the start')).toBeVisible();
    expect(await call<Summary[]>(page, 'listSummaries', rec.id)).toHaveLength(3);

    // Delete a version.
    await page.getByLabel('Cover').selectOption('all');
    await page.getByRole('button', { name: 'Delete this version' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(async () => (await call<Summary[]>(page, 'listSummaries', rec.id)).length).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('chapters and suggestions: the user stays in control, and chapters scope a summary', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);
    await openRecording(page, 'recorder');

    await page.getByRole('button', { name: 'Find chapters' }).click();
    await expect(page.getByRole('heading', { name: 'Chapters' })).toBeVisible({ timeout: 15_000 });
    await page.locator('.chapter-row').nth(1).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();

    await page.getByRole('button', { name: 'Suggest title and tags' }).click();
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'test-shots/detail-ai-tools.png', fullPage: false });

    // Nothing changed by itself.
    let now = await call<Recording>(page, 'getRecording', rec.id);
    expect(now.title).toBe('recorder');
    expect(now.tags).toEqual([]);

    await page.getByRole('button', { name: '+ #demo' }).click();
    await expect(page.getByRole('button', { name: '✓ #demo' })).toBeVisible();
    await page.getByRole('button', { name: 'Use this title' }).click();
    await expect.poll(async () => (await call<Recording>(page, 'getRecording', rec.id)).title).toMatch(/^Demo title/);
    now = await call<Recording>(page, 'getRecording', rec.id);
    expect(now.tags.map((t) => t.name)).toEqual(['demo']);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toHaveCount(0);

    // A summary of just one chapter.
    await page.getByRole('button', { name: 'Summaries', exact: true }).click();
    await page.getByLabel('Cover').selectOption('chapters');
    await page.getByLabel('Demo chapter 1').check();
    await page.getByRole('button', { name: /^Generate/ }).click();
    await expect(page.getByLabel('Summary version').locator('option:checked')).toContainText('Demo chapter 1', { timeout: 15_000 });
    const [summary] = await call<Summary[]>(page, 'listSummaries', rec.id);
    expect(summary!.options.scope.kind).toBe('ranges');

    // Editing the transcript flags the summary as out of date.
    await call(page, 'editSegment', rec.id, 0, 'Changed text');
    await expect(page.getByText('The transcript has changed since this was written')).toBeVisible();
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('summaries search, Studio entry and selecting transcript text', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);
    await call(page, 'requestSummary', rec.id, DEFAULT_SUMMARY_OPTIONS);
    await expect.poll(async () => (await call<Summary[]>(page, 'listSummaries', rec.id)).length, { timeout: 15_000 }).toBe(1);
    expect(await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest', text: 'placeholder demo' })).toHaveLength(1);

    // AI Studio: working tools are buttons, and later ones say when they arrive.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
    await expect(page.getByText('Phase 5').first()).toBeVisible();
    await page.screenshot({ path: 'test-shots/studio.png' });
    await page.getByRole('button', { name: /^Lecture Notes/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /recorder/ }).click();
    await expect(page.getByLabel('Format')).toHaveValue('academic');
    await expect(page.getByLabel('Tone')).toHaveValue('academic');
    await expect(page.getByLabel('Length')).toHaveValue('detailed');

    // Select transcript text, then summarize just that.
    await openRecording(page, 'recorder');
    await page.getByRole('button', { name: 'Open transcript' }).click();
    await page.getByRole('button', { name: 'Timestamped', exact: true }).click();
    await page.locator('.t-text').nth(1).selectText();
    await page.locator('.t-text').nth(1).dispatchEvent('mouseup');
    await page.getByRole('button', { name: 'Summarize selection' }).click();
    await expect(page.getByLabel('Cover')).toHaveValue('range');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await expect(page.getByLabel('Summary version').locator('option:checked')).toContainText('Selection', { timeout: 15_000 });
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('a real server: consent is separate for text, the request is correct, 429 waits, invented citations go', async () => {
  const dataDir = tempDataDir();
  const bodies: { messages: { content: string }[]; model: string; max_tokens: number }[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(parts).toString()));
      if (bodies.length === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining-requests': '4', 'x-ratelimit-limit-requests': '5' });
      res.end(JSON.stringify({ choices: [{ message: { content: '## Real result\n\n- Grounded point [S1]\n- Hallucinated [S9999]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await transcribed(page);
    await call(page, 'updateSettings', { llmProvider: 'custom-chat', llmModel: 'test-model', llmBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    await openRecording(page, 'recorder');
    await page.getByRole('button', { name: 'Summaries', exact: true }).click();

    await page.getByRole('button', { name: /^Generate/ }).click();
    await expect(page.getByRole('heading', { name: 'Offline only is on' })).toBeVisible();
    await page.getByRole('button', { name: 'Turn off Offline only' }).click();
    await expect(page.getByRole('heading', { name: /^Send transcript text to/ })).toBeVisible();
    await page.screenshot({ path: 'test-shots/gate-text.png' });
    expect(bodies).toHaveLength(0);
    await page.getByRole('button', { name: 'I agree, continue' }).click();

    await expect(page.getByRole('heading', { name: 'Real result' })).toBeVisible({ timeout: 30_000 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.model).toBe('test-model');
    expect(bodies[1]!.messages[0]!.content).toMatch(/Never invent/);
    expect(bodies[1]!.messages[1]!.content).toContain('[S1 0:02]');

    // The invented citation is gone, and the user is told.
    await expect(page.getByText('cited a source that does not exist')).toBeVisible();
    await expect(page.locator('.md')).not.toContainText('9999');
    await expect(page.getByText('This is demo text')).toHaveCount(0);
    await page.screenshot({ path: 'test-shots/summaries-real.png' });

    const usage = await call<{ provider: string; tokensToday: number }[]>(page, 'getUsage');
    expect(usage.find((u) => u.provider === 'custom-chat')!.tokensToday).toBe(120);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('a broken screen shows recovery instead of a blank window, and other screens still work', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);
    await closeApp(app);

    // Corrupt one row so that drawing it fails, as a real bug would.
    const db = new DatabaseSync(join(dataDir, 'echomind.db'));
    db.prepare('UPDATE recordings SET mode = ? WHERE id = ?').run('not-a-mode', rec.id);
    db.close();

    ({ app, page } = await launch(dataDir));
    await expect(page.getByRole('heading', { name: 'This screen hit a problem' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/crash-screen.png' });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
