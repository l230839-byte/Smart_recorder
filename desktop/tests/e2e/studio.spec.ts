import { expect, test, type Page } from '@playwright/test';
import type { DocumentRecord, ImportJob, ProcessingJob, Recording } from '../../src/shared/models';
import type { StudioOutput, Task } from '../../src/shared/studio';
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
  return recs;
}

const openStudioTool = async (page: Page, name: RegExp) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
  await page.getByRole('button', { name }).first().click();
};

test('study tools: flashcards to study, a quiz to take and save, a mind map, notes to PDF or Word', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    await transcribedAll(page, ['recorder.m4a']);

    // Flashcards: chosen recording, options, then study with keyboard and buttons.
    await openStudioTool(page, /^Flashcards/);
    await expect(page.getByRole('heading', { name: 'Flashcards' })).toBeVisible();
    await expect(page.getByRole('checkbox').first()).toBeChecked();
    await page.getByLabel('Number of cards').fill('4');
    await page.getByRole('button', { name: 'Easy' }).click();
    await page.screenshot({ path: 'test-shots/studio-tool.png' });
    await page.getByRole('button', { name: 'Generate' }).click();
    const card = page.locator('.flip-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('This is demo material')).toBeVisible();
    await expect(card).toContainText('Question');
    await page.keyboard.press('Space');
    await expect(card).toContainText('Answer');
    await expect(page.locator('.card-meta .cite')).toBeVisible();
    await page.screenshot({ path: 'test-shots/studio-flashcards.png' });
    await page.getByRole('button', { name: 'I knew it (K)' }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Still learning (L)' }).click();
    await expect(page.getByRole('heading', { name: 'You know 1 of 4' })).toBeVisible();
    await page.getByRole('button', { name: 'Study the 3 still to learn' }).click();
    await expect(page.getByText('1 of 3')).toBeVisible();
    await page.getByRole('button', { name: /All cards/ }).click();
    await expect(page.locator('.card-list li')).toHaveCount(4);

    // Quiz: multiple choice and short answers, checked, self-marked, saved.
    await openStudioTool(page, /^Quiz Generator/);
    await page.getByLabel('Number of questions').fill('3');
    await page.getByRole('checkbox', { name: 'True or false' }).uncheck();
    await page.getByRole('button', { name: 'Generate' }).click();
    const questions = page.locator('.quiz-q');
    await expect(questions).toHaveCount(3, { timeout: 15_000 });
    await questions.nth(0).locator('.quiz-option').first().click();
    await questions.nth(1).getByRole('textbox').fill('My own answer');
    await questions.nth(2).locator('.quiz-option').nth(1).click();
    await page.getByRole('button', { name: 'Check answers' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Score: 1 of 3' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save attempt' })).toBeDisabled();
    await questions.nth(1).getByRole('button', { name: 'Yes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Score: 2 of 3' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/studio-quiz.png' });
    await page.getByRole('button', { name: 'Save attempt' }).click();
    await expect(page.getByText('Earlier attempts: 2/3')).toBeVisible();

    // Mind map: drawn, and a point plays its moment.
    await openStudioTool(page, /^Mind Map/);
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByRole('img', { name: 'Mind map: Demo map' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'test-shots/studio-mindmap.png' });
    await page.locator('.mm-node.linked').first().click();
    await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();

    // Study notes become a document for PDF or Word, with the result's content.
    await openStudioTool(page, /^Study Notes/);
    await page.getByLabel('What to make').selectOption('revision');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('.md')).toContainText('Demo result', { timeout: 15_000 });
    await page.getByRole('button', { name: 'PDF or Word' }).click();
    await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(/Demo result/);
    const docs = await call<DocumentRecord[]>(page, 'listDocuments');
    expect(docs[0]!.title).toMatch(/^Revision sheet: /);

    // Results are listed in the Studio and on the recording.
    const results = await call<StudioOutput[]>(page, 'listStudio');
    expect(results.map((r) => r.kind)).toEqual(['study', 'mindmap', 'quiz', 'flashcards']);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
    await expect(page.locator('.result-card')).toHaveCount(4);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('tasks, translation, comparison, batch processing, and deletion', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    const [first, second] = await transcribedAll(page, ['recorder.m4a', 'tone.wav']);

    // Action items from a recording's page wait for review.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-row').first().locator('.rec-main').click();
    await page.getByRole('button', { name: 'Find action items' }).click();
    await expect(page.getByRole('heading', { name: /Found 1 new action item/ })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Open Tasks' }).click();
    await page.getByRole('button', { name: /To review \(1\)/ }).click();
    const found = page.locator('.task-row').first();
    await expect(found).toContainText('Demo: Add a real provider in Settings');
    await expect(found.locator('.task-quote')).toContainText('Add a real provider');
    await page.screenshot({ path: 'test-shots/tasks-review.png' });
    await found.getByRole('button', { name: 'Edit, then approve' }).click();
    await page.getByLabel('Due').fill('2020-01-01');
    await page.getByLabel('Who').fill('Me');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: /To do \(1\)/ }).click();
    await expect(page.locator('.task-row').first().locator('.due.overdue')).toBeVisible();
    await expect(page.getByText('1 task is overdue.')).toBeVisible();
    // Your own task, then done.
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Book the room');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('checkbox', { name: 'Mark "Book the room" as done' }).click();
    await expect(page.getByText('Done: Book the room')).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.task-row.done')).toContainText('Book the room');
    // Home counts what is open.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByText('1 task to do · 1 overdue')).toBeVisible();

    // Translation keeps every line with its time.
    await openStudioTool(page, /^Translation Studio/);
    await page.getByLabel('Into').fill('Urdu');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('table.translation tbody tr').first()).toContainText('[Demo translation]', { timeout: 15_000 });
    await expect(page.getByRole('columnheader', { name: 'Urdu' })).toBeVisible();

    // Comparison needs two recordings.
    await openStudioTool(page, /^Comparison/);
    await expect(page.locator('.tool-row input:checked')).toHaveCount(2);
    await page.locator('.tool-row').nth(1).getByRole('checkbox').uncheck();
    await expect(page.getByText('Choose at least 2 recordings.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await page.locator('.tool-row').nth(1).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('.md')).toContainText('Demo result', { timeout: 15_000 });

    // Workflow D: several recordings, one template, each in the queue.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.locator('.rec-row').nth(0).getByRole('checkbox').check();
    await page.locator('.rec-row').nth(1).getByRole('checkbox').check();
    await page.getByRole('toolbar', { name: 'Selected recordings' }).getByRole('button', { name: 'Process' }).click();
    const dialog = page.getByRole('dialog', { name: 'Process 2 recordings' });
    await dialog.getByRole('radio', { name: /Flashcards/ }).check();
    await dialog.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByText('2 recordings added to the queue')).toBeVisible();
    await expect
      .poll(async () => (await call<ProcessingJob[]>(page, 'listJobs')).filter((j) => j.kind === 'studio' && j.status === 'done').length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(5);
    expect((await call<StudioOutput[]>(page, 'listStudio')).filter((o) => o.kind === 'flashcards')).toHaveLength(2);

    // Deleting a recording forever removes what was made from it; the approved task stays, without its words.
    await call(page, 'trashRecordings', [first!.id]);
    await call(page, 'deleteForever', [first!.id]);
    const left = await call<StudioOutput[]>(page, 'listStudio');
    expect(left.every((o) => !o.recordingIds.includes(first!.id))).toBe(true);
    expect(left.map((o) => o.recordingIds)).toEqual([[second!.id]]);
    const tasks = await call<Task[]>(page, 'listTasks', {});
    expect(tasks.find((t) => t.title.startsWith('Demo:'))).toMatchObject({ recordingId: null, sourceText: '' });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
