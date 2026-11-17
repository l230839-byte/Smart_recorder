import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

const RECORDINGS = 2000;
const SEGMENTS = 5000;

test('a large library and a very long transcript stay quick', async () => {
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await closeApp(app);

    const db = new DatabaseSync(join(dataDir, 'echomind.db'));
    db.exec('BEGIN');
    const now = Date.now();
    const insert = db.prepare("INSERT INTO recordings (id, title, mode, source, format, codec, duration_ms, size_bytes, created_at, updated_at) VALUES (?, ?, 'lecture', 'picker', 'OGG', 'Opus', 3600000, 1000, ?, ?)");
    const search = db.prepare("INSERT INTO recording_search (recording_id, title, description, tags, notes) VALUES (?, ?, '', '', '')");
    let longId = '';
    for (let i = 0; i < RECORDINGS; i++) {
      const id = randomUUID();
      if (i === RECORDINGS - 1) longId = id;
      const title = `Lecture ${i}`;
      insert.run(id, title, now - i * 1000, now);
      search.run(id, title);
    }
    const version = randomUUID();
    db.prepare("INSERT INTO transcript_versions (id, recording_id, version, kind, provider, model, is_current, created_at) VALUES (?, ?, 1, 'original', 'groq', 'm', 1, ?)").run(version, longId, now);
    const segment = db.prepare('INSERT INTO transcript_segments (version_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < SEGMENTS; i++) segment.run(version, i, i * 700, (i + 1) * 700, `This is sentence number ${i} of a very long lecture about neural networks and how they learn.`);
    db.exec('COMMIT');
    db.close();

    ({ app, page } = await launch(dataDir));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();

    let started = Date.now();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await expect(page.getByText(`${RECORDINGS} recordings`)).toBeVisible();
    const libraryMs = Date.now() - started;

    started = Date.now();
    await page.getByRole('searchbox').fill('Lecture 1999');
    await expect(page.locator('.rec-row')).toHaveCount(1);
    const searchMs = Date.now() - started;
    await page.locator('.rec-main').click();

    started = Date.now();
    await page.getByRole('button', { name: 'Open transcript' }).click();
    await expect(page.locator('.t-block').first()).toBeVisible();
    const transcriptMs = Date.now() - started;

    started = Date.now();
    await page.getByRole('button', { name: 'Timestamped', exact: true }).click();
    await expect(page.locator('.t-block')).toHaveCount(SEGMENTS);
    const switchMs = Date.now() - started;

    started = Date.now();
    await page.getByRole('searchbox').fill('neural');
    await expect(page.getByRole('status').filter({ hasText: `of ${SEGMENTS}` })).toBeVisible();
    const findMs = Date.now() - started;

    console.warn(`performance: library ${libraryMs} ms, search ${searchMs} ms, open transcript ${transcriptMs} ms, switch view ${switchMs} ms, find ${findMs} ms`);
    expect(libraryMs).toBeLessThan(3000);
    expect(transcriptMs).toBeLessThan(3000);
    expect(switchMs).toBeLessThan(3000);
    expect(findMs).toBeLessThan(3000);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('a three-hour document exports to PDF in seconds', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const markdown = Array.from({ length: 2500 }, (_, i) => `${i % 50 === 0 ? `## Part ${i / 50 + 1}\n\n` : ''}**Speaker ${i % 2 ? 'A' : 'B'}:** Sentence number ${i} about neural networks and گفتگو. [${Math.floor(i / 30)}:${String((i * 2) % 60).padStart(2, '0')}](cite:${i * 4000})\n`).join('\n');
    const { documentId } = (await page.evaluate(() => window.echomind.call('createDocument', { recordingId: null, template: 'custom', source: 'blank', title: 'Long' }))) as { documentId: string };
    await page.evaluate(([id, md]) => window.echomind.call('updateDocument', id, { markdown: md }), [documentId, markdown] as const);
    const started = Date.now();
    const exported = await page.evaluate((id) => window.echomind.call('exportDocument', id, 'pdf'), documentId);
    const pdfMs = Date.now() - started;
    console.warn(`performance: PDF of 2,500 paragraphs: ${pdfMs} ms, ${(exported.sizeBytes / 1024).toFixed(0)} KB`);
    expect(pdfMs).toBeLessThan(20_000);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('a 300-hour library: passages index once, search and library-wide chat stay quick', async () => {
  test.setTimeout(240_000);
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await closeApp(app);

    // 300 one-hour recordings with transcripts, written directly, as an older version would have left them.
    const COUNT = 300;
    const LINES = 300;
    const topics = ['neural networks', 'operating systems', 'client requirements', 'budget planning', 'photosynthesis', 'database indexes'];
    const db = new DatabaseSync(join(dataDir, 'echomind.db'));
    db.exec('BEGIN');
    const now = Date.now();
    const insert = db.prepare("INSERT INTO recordings (id, title, mode, source, format, codec, duration_ms, size_bytes, created_at, updated_at) VALUES (?, ?, 'lecture', 'picker', 'OGG', 'Opus', 3600000, 1000, ?, ?)");
    const search = db.prepare("INSERT INTO recording_search (recording_id, title, description, tags, notes) VALUES (?, ?, '', '', '')");
    const versionStmt = db.prepare("INSERT INTO transcript_versions (id, recording_id, version, kind, provider, model, is_current, created_at) VALUES (?, ?, 1, 'original', 'groq', 'm', 1, ?)");
    const segment = db.prepare('INSERT INTO transcript_segments (version_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)');
    const ts = db.prepare('INSERT INTO transcript_search (recording_id, segment_idx, start_ms, text) VALUES (?, ?, ?, ?)');
    for (let r = 0; r < COUNT; r++) {
      const id = randomUUID();
      insert.run(id, `Session ${r}`, now - r * 1000, now);
      search.run(id, `Session ${r}`);
      const version = randomUUID();
      versionStmt.run(version, id, now);
      for (let i = 0; i < LINES; i++) {
        const text = `In session ${r} we discussed ${topics[(r + i) % topics.length]} in detail, point ${i}${r === 137 && i === 42 ? ', and the secret deadline is the ninth of March' : ''}.`;
        segment.run(version, i, i * 12_000, (i + 1) * 12_000, text);
        ts.run(id, i, i * 12_000, text);
      }
    }
    db.exec('COMMIT');
    db.close();

    ({ app, page } = await launch(dataDir));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    const call = <T,>(method: string, ...args: unknown[]) => page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);

    // Passages for all 300 transcripts are built once, in the background, shortly after launch.
    let started = Date.now();
    await expect
      .poll(async () => (await call<{ hits: unknown[] }[]>('searchEverything', { text: 'secret deadline' })).length, { timeout: 60_000 })
      .toBe(1);
    const firstSearchMs = Date.now() - started;

    started = Date.now();
    const results = await call<unknown[]>('searchEverything', { text: 'neural networks' });
    const searchMs = Date.now() - started;
    expect(results.length).toBeGreaterThan(40);

    await call('updateSettings', { llmProvider: 'fake' });
    const thread = await call<string>('startChat', { kind: 'library' });
    // A question across the whole library, asked before the background pass could finish: chat indexes
    // what it needs first, so the answer is still complete.
    started = Date.now();
    await call('askChat', thread, 'When is the secret deadline?');
    await expect.poll(async () => (await call<{ turns: { status: string; content: string }[] }>('getChat', thread)).turns[1]?.status, { timeout: 30_000 }).toBe('done');
    const chatMs = Date.now() - started;
    const answer = (await call<{ turns: { content: string; readNote: string }[] }>('getChat', thread)).turns[1]!;
    expect(answer.content).toContain('secret deadline');
    // Once everything is indexed, a question is quicker still.
    started = Date.now();
    await call('askChat', thread, 'What did session 12 say about photosynthesis?');
    await expect.poll(async () => (await call<{ turns: { status: string }[] }>('getChat', thread)).turns[3]?.status, { timeout: 30_000 }).toBe('done');
    const warmMs = Date.now() - started;
    console.warn(`performance: 300 one-hour transcripts: search ready ${firstSearchMs} ms after launch, search ${searchMs} ms, first library-wide question ${chatMs} ms including indexing (${answer.readNote}), next question ${warmMs} ms`);
    expect(searchMs).toBeLessThan(2000);
    expect(chatMs).toBeLessThan(8000);
    expect(warmMs).toBeLessThan(2000);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
