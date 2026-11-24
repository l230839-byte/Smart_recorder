import { expect, test, type Page } from '@playwright/test';
import type { ChatDetail, ChatThread } from '../../src/shared/chat';
import type { ImportJob, Recording } from '../../src/shared/models';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function transcribedAll(page: Page, names: string[]): Promise<Recording[]> {
  await call(page, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake' });
  await call(page, 'importPaths', names.map(fixture), 'lecture');
  await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports')).filter((j) => j.status === 'done').length, { timeout: 30_000 }).toBe(names.length);
  const recs = await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' });
  for (const r of recs) await call(page, 'requestTranscription', r.id);
  await expect.poll(async () => (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).every((r) => r.hasTranscript), { timeout: 30_000 }).toBe(true);
  // In the order asked for: imports run side by side, so "newest" depends on which finished first.
  return names.map((name) => recs.find((r) => r.originalName === name)!);
}

test('chat: ask a recording, citations play, sources, follow-ups, not found, many recordings, privacy on delete', async () => {
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    const [first, second] = await transcribedAll(page, ['recorder.m4a', 'tone.wav']);

    // From a recording's page.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-row', { hasText: 'recorder' }).locator('.rec-main').click();
    await page.getByRole('button', { name: 'Ask AI' }).click();
    await expect(page.getByRole('heading', { name: 'Ask your recordings' })).toBeVisible();
    await expect(page.locator('.chat-scope')).toContainText('recorder');
    await expect(page.locator('.chat-scope')).toContainText('1 recording with a transcript');
    await expect(page.getByRole('button', { name: 'What are the main points?' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/chat-empty.png' });

    // A question: the answer cites real moments, which play.
    const box = page.getByRole('textbox', { name: 'Your question' });
    await box.fill('How does the transcript keep timestamps?');
    await box.press('Enter');
    await expect(page.locator('.bubble').first()).toHaveText('How does the transcript keep timestamps?');
    const answer = page.locator('.turn.assistant').first();
    await expect(answer).toContainText('the transcript keeps timestamps', { timeout: 15_000 });
    await expect(answer).toContainText('Read the full transcript');
    await expect(answer).toContainText('Demo answer');
    await expect(page.getByRole('heading', { name: 'How does the transcript keep timestamps?' })).toBeVisible();
    const thread = (await call<ChatThread[]>(page, 'listChats'))[0]!;
    expect(thread.scopeLabel).toBe(first!.title);
    await answer.getByRole('button', { name: /^Play source at/ }).first().click();
    await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();
    await answer.getByRole('button', { name: /^Sources \(/ }).click();
    await expect(answer.locator('.source-list li').first()).toContainText('timestamps');

    // A follow-up, then something the recording does not cover.
    await box.fill('Who won the cricket match?');
    await box.press('Enter');
    const second_ = page.locator('.turn.assistant').nth(1);
    await expect(second_.getByText('Not in your recordings')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.thread-item')).toHaveCount(1);
    await page.screenshot({ path: 'test-shots/chat-answers.png' });

    // A new chat about several recordings, chosen in the picker.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.locator('.chat-scope')).toContainText('Whole library');
    await page.getByRole('button', { name: 'Change' }).click();
    const picker = page.getByRole('dialog', { name: 'Ask about' });
    await picker.getByRole('button', { name: 'Chosen recordings' }).click();
    await picker.getByRole('checkbox').nth(0).check();
    await picker.getByRole('checkbox').nth(1).check();
    await picker.getByRole('button', { name: 'Use this' }).click();
    await expect(page.locator('.chat-scope')).toContainText('2 recordings');
    await page.getByRole('button', { name: 'Compare what was said across these recordings.' }).click();
    await expect(page.locator('.turn.assistant').first()).toContainText('Read the full transcripts of 2 recordings', { timeout: 15_000 });
    await expect(page.locator('.thread-item')).toHaveCount(2);

    // From a Library selection.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.locator('.rec-row').first().getByRole('checkbox').check();
    await page.locator('.rec-row').nth(1).getByRole('checkbox').check();
    await page.getByRole('toolbar', { name: 'Selected recordings' }).getByRole('button', { name: 'Ask AI' }).click();
    await expect(page.locator('.chat-scope')).toContainText('2 recordings');

    // Rename and delete.
    await page.locator('.thread-item').first().click();
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Comparison');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.thread-item').first()).toContainText('Comparison');

    // Nothing is sent without a usable provider: a dialog explains why, and no question is stored.
    await call(page, 'updateSettings', { llmProvider: 'groq' });
    const before = (await call<ChatDetail>(page, 'getChat', thread.id)).turns.length;
    await page.locator('.thread-item', { hasText: 'How does the transcript' }).click();
    await box.fill('One more?');
    await box.press('Enter');
    // Offline only is on by default: the question would go to the model on this computer, which is not
    // downloaded, so nothing starts and nothing is sent.
    await expect(page.getByRole('dialog', { name: 'Download the offline model first' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Download the offline model first' }).getByRole('button', { name: 'Cancel' }).click();
    expect((await call<ChatDetail>(page, 'getChat', thread.id)).turns.length).toBe(before);
    await call(page, 'updateSettings', { llmProvider: 'fake' });

    // Deleting a recording forever deletes every chat that read it.
    await call(page, 'trashRecordings', [second!.id]);
    await call(page, 'deleteForever', [second!.id]);
    await expect.poll(async () => (await call<ChatThread[]>(page, 'listChats')).map((t) => t.scopeLabel)).toEqual([first!.title]);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('search: everything at once, with snippets, times, filters and a way to ask AI', async () => {
  test.setTimeout(90_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    const [rec] = await transcribedAll(page, ['recorder.m4a']);
    await call(page, 'addTag', rec!.id, 'semester-one');

    // Ctrl+K from anywhere.
    await page.keyboard.press('Control+k');
    const box = page.getByRole('searchbox', { name: 'Search everything' });
    await expect(box).toBeFocused();
    await expect(page.getByText('Search your whole library')).toBeVisible();

    await box.fill('timestamps');
    const result = page.locator('.search-result').first();
    await expect(result).toContainText('recorder');
    const hit = result.locator('.hit', { hasText: 'Transcript' }).first();
    await expect(hit.locator('mark')).toHaveText('timestamps');
    await expect(hit.locator('.cite')).toHaveText(/\d:\d\d/);
    await page.screenshot({ path: 'test-shots/search.png' });

    // Urdu is found as well, and a tag finds its recording.
    await box.fill('اردو');
    await expect(page.locator('.search-result .hit mark').first()).toHaveText('اردو');
    await box.fill('semester');
    await expect(page.locator('.hit', { hasText: 'Details' }).first()).toBeVisible();

    // Filters.
    await box.fill('timestamps');
    await page.getByLabel('Kind of content').selectOption('summary');
    await expect(page.getByText('Nothing found')).toBeVisible();
    await page.getByLabel('Kind of content').selectOption('');
    await expect(page.locator('.search-result')).toHaveCount(1);

    // Results open where they were found, and lead into a chat.
    await page.locator('.hit', { hasText: 'Transcript' }).first().click();
    await expect(page.getByRole('button', { name: 'Export transcript' })).toBeVisible();
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    await page.getByRole('button', { name: /Ask AI about 1 result/ }).click();
    await expect(page.locator('.chat-scope')).toContainText('recorder');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Search' }).click();
    await page.getByRole('searchbox', { name: 'Search everything' }).fill('nothing-like-this-word');
    await expect(page.getByText('Nothing found')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
