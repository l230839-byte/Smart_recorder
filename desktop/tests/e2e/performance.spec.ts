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
