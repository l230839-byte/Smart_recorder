import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { DocumentExport, Recording, Summary } from '../../src/shared/models';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function answerDialogs(app: ElectronApplication, save: string | null, open: string | null) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = (async () => ({ canceled: !paths.save, filePath: paths.save ?? '' })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: !paths.open, filePaths: paths.open ? [paths.open] : [] })) as typeof dialog.showOpenDialog;
  }, { save, open });
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

/**
 * Prompt §29, the application's definition of success, driven through the screens a person uses, with
 * free (here, demo) services, for a recording made in EchoMind and one imported from another recorder app.
 */
for (const source of ['recorded in EchoMind', 'imported from a phone recorder'] as const) {
  test(`§29 acceptance: ${source}`, async () => {
    test.setTimeout(240_000);
    const dataDir = tempDataDir();
    const outside = tempDataDir();
    const { app, page } = await launch(dataDir);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await completeOnboarding(page);
      await call(page, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake' });

      // 1-2. Record directly, or import the phone recorder's M4A; it is saved in the Library.
      if (source === 'recorded in EchoMind') {
        await nav(page, 'Record');
        await page.getByRole('radio', { name: /Lecture/ }).click();
        await page.getByLabel('Title (optional)').fill('Acceptance lecture');
        await page.getByRole('button', { name: 'Start recording' }).click();
        await page.waitForTimeout(3500);
        await page.getByRole('button', { name: 'Stop and save' }).click();
        await expect(page.getByRole('heading', { name: 'Acceptance lecture' })).toBeVisible({ timeout: 20_000 });
      } else {
        await answerDialogs(app, null, fixture('recorder.m4a'));
        await nav(page, 'Home');
        await page.getByRole('button', { name: /^Import/ }).first().click();
        await page.getByRole('button', { name: 'Choose files' }).click();
        await expect(page.getByText('Imported', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      }
      await nav(page, 'Library');
      await expect(page.locator('.rec-row')).toHaveCount(1);
      const [rec] = await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' });
      expect(rec!.source).toBe(source === 'recorded in EchoMind' ? 'native' : 'picker');

      // 3. Open it and generate a transcript.
      await page.locator('.rec-main').first().click();
      await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Open transcript' })).toBeVisible({ timeout: 30_000 });

      // 4. Usable timestamps, and editable.
      await page.getByRole('button', { name: 'Open transcript' }).click();
      await page.getByRole('button', { name: 'Timestamped', exact: true }).click();
      const block = page.locator('.t-block').first();
      await expect(block).toContainText(/\d:\d\d/);
      await block.hover();
      await block.getByRole('button', { name: /^Edit text at/ }).click();
      await page.getByLabel('Segment text').fill('The lecture starts with an overview of the course.');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Edited transcript')).toBeVisible();
      await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();

      // 5-6. Choose summary formats; each is generated and saved, from the same transcript.
      await page.getByRole('button', { name: 'Summaries', exact: true }).click();
      for (const format of ['bullets', 'paragraphs', 'structured']) {
        await page.getByLabel('Format').selectOption(format);
        await page.getByRole('button', { name: /^Generate/ }).click();
        await expect.poll(async () => (await call<Summary[]>(page, 'listSummaries', rec!.id)).map((s) => s.options.format), { timeout: 15_000 }).toContain(format);
      }
      await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();

      // 7-8. AI Chat answers from the recording and references the source.
      await page.getByRole('button', { name: 'Ask AI' }).click();
      await page.getByRole('textbox', { name: 'Your question' }).fill('What does the lecture start with?');
      await page.keyboard.press('Enter');
      const answer = page.locator('.turn.assistant').first();
      await expect(answer.getByRole('button', { name: /^Play source at/ }).first()).toBeVisible({ timeout: 15_000 });
      await answer.getByRole('button', { name: /^Sources \(/ }).click();
      await expect(answer.locator('.source-list li').first()).toBeVisible();
      await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();

      // 9. Flashcards and quiz questions.
      await page.getByRole('button', { name: 'More in AI Studio' }).click();
      await page.getByRole('button', { name: /^Flashcards/ }).click();
      await page.getByRole('button', { name: 'Generate' }).click();
      await expect(page.locator('.flip-card')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
      await page.getByRole('button', { name: /^Quiz Generator/ }).click();
      await page.getByRole('button', { name: 'Generate' }).click();
      await expect(page.locator('.quiz-q').first()).toBeVisible({ timeout: 15_000 });

      // 10. The document generator: a professional template, then a formatted PDF and an editable Word file.
      await nav(page, 'Library');
      await page.locator('.rec-main').first().click();
      await page.locator('section', { has: page.getByRole('heading', { name: 'Documents' }) }).getByRole('button', { name: 'New' }).click();
      await page.getByRole('radio', { name: /Detailed Lecture Report/ }).click();
      await page.getByRole('button', { name: 'Write document' }).click();
      await expect(page.getByRole('textbox', { name: 'Document text' })).not.toHaveValue('', { timeout: 20_000 });

      // 11. Preview, save, share and find it later.
      await expect(page.frameLocator('iframe[title="Page preview"]').locator('h1, h2').first()).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Export PDF' }).click();
      await expect(page.getByText('PDF saved')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Other export formats' }).click();
      await page.getByRole('menuitem', { name: 'Export Word (DOCX)' }).click();
      await expect(page.getByText('Word (DOCX) saved')).toBeVisible({ timeout: 30_000 });
      const exports = await call<DocumentExport[]>(page, 'listExports');
      const pdf = readFileSync(join(dataDir, 'exports', exports.find((e) => e.format === 'pdf')!.fileName));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const docx = await JSZip.loadAsync(readFileSync(join(dataDir, 'exports', exports.find((e) => e.format === 'docx')!.fileName)));
      expect(await docx.file('word/document.xml')!.async('string')).toContain('Lecture');

      // Found later in Documents, and shared by saving a copy anywhere.
      await nav(page, 'Home');
      await nav(page, 'AI Studio');
      await page.getByRole('button', { name: 'Documents', exact: true }).click();
      await page.getByRole('button', { name: /Exported files \(2\)/ }).click();
      const copy = join(outside, 'shared-report.pdf');
      await answerDialogs(app, copy, null);
      await page.locator('.export-row', { hasText: '.pdf' }).getByRole('button', { name: 'Save a copy' }).click();
      await expect(page.getByText('Copy saved')).toBeVisible();
      expect(existsSync(copy)).toBe(true);
      await page.screenshot({ path: `test-shots/acceptance-${source === 'recorded in EchoMind' ? 'recorded' : 'imported'}.png` });
      expect(errors).toEqual([]);
    } finally {
      await closeApp(app);
      removeDir(dataDir);
      removeDir(outside);
    }
  });
}
