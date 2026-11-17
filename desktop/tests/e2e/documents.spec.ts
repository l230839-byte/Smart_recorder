import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';
import type { DocumentExport, DocumentRecord, ImportJob, Recording, Summary } from '../../src/shared/models';
import { DEFAULT_SUMMARY_OPTIONS } from '../../src/shared/summaries';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

const URDU = 'یہ اردو میں ایک جملہ ہے۔';

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function transcribed(page: Page, name = 'recorder.m4a'): Promise<Recording> {
  await call(page, 'importPaths', [fixture(name)], 'meeting');
  await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports')).find((j) => j.displayName === name)?.status, { timeout: 30_000 }).toBe('done');
  const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).find((r) => r.originalName === name)!;
  await call(page, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake' });
  await call(page, 'requestTranscription', rec.id);
  await expect.poll(async () => (await call<Recording>(page, 'getRecording', rec.id)).hasTranscript, { timeout: 20_000 }).toBe(true);
  return rec;
}

/** Text and font names of a PDF, read the way a PDF reader does. */
async function readPdf(path: string): Promise<{ pages: number; text: string; fonts: string[] }> {
  const bytes = readFileSync(path);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false }).promise;
  let text = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    text += `${(await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ')}\n`;
  }
  // Embedded fonts are named in the font dictionaries, as "ABCDEF+FontName" for a subset. Some of those
  // sit inside compressed object streams, so every stream is inflated and searched too.
  const raw = bytes.toString('latin1');
  const parts = [raw];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    try {
      parts.push(inflateSync(bytes.subarray(start, end)).toString('latin1'));
    } catch {
      /* not a compressed stream */
    }
  }
  // Outline (Type3) fonts are named by /FontName in their descriptor rather than /BaseFont.
  const fonts = [...new Set(parts.flatMap((p) => [...p.matchAll(/\/(?:BaseFont|FontName)\s*\/([^\s/<>[\]()]+)/g)].map((m) => m[1]!)))];
  return { pages: pdf.numPages, text, fonts };
}

test('documents: AI draft, editing, layout, versions, real PDF/Word/PowerPoint files, export center', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);

    // From the recording page.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-row', { hasText: 'recorder' }).locator('.rec-main').click();
    const docsSection = page.locator('section', { has: page.getByRole('heading', { name: 'Documents' }) });
    await expect(docsSection.getByText('Turn this recording into notes')).toBeVisible();
    await docsSection.getByRole('button', { name: 'New' }).click();

    // Nine templates, the recording already chosen.
    await expect(page.getByRole('heading', { name: 'New document' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Template' }).getByRole('radio')).toHaveCount(9);
    await expect(page.getByLabel('Recording')).toHaveValue(rec.id);
    await page.getByRole('radio', { name: /Meeting Minutes/ }).click();
    await expect(page.getByRole('radio', { name: /Meeting Minutes/ })).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: 'test-shots/documents-new.png' });
    await page.getByRole('button', { name: 'Write document' }).click();

    // The AI draft arrives in the editor, labelled as demo text.
    const text = page.getByRole('textbox', { name: 'Document text' });
    await expect(text).not.toHaveValue('', { timeout: 20_000 });
    await expect(page.getByText('This draft is demo text')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('recorder: Meeting Minutes');
    const doc = (await call<DocumentRecord[]>(page, 'listDocuments', rec.id))[0]!;
    expect(doc.versionCount).toBe(1);

    // Editing: typed text, a toolbar heading and Ctrl+B, saved automatically.
    await text.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nUrdu section');
    await page.keyboard.press('Shift+Home');
    await page.getByRole('button', { name: 'Heading', exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(`\n\n${URDU}\n\nImportant`);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Control+b');
    await expect(text).toHaveValue(/## Urdu section\n\nیہ اردو میں ایک جملہ ہے۔\n\n\*\*Important\*\*$/);
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    // Ctrl+Z undoes a toolbar change, because edits go through the text box's own undo.
    await page.keyboard.press('Control+z');
    await expect(text).toHaveValue(/\n\nImportant$/);
    await page.keyboard.press('Control+y');
    await expect(text).toHaveValue(/\*\*Important\*\*$/);

    // The preview is the real page, following the section being edited.
    const preview = page.frameLocator('iframe[title="Page preview"]');
    await expect(preview.getByRole('heading', { name: 'Urdu section' })).toBeVisible({ timeout: 10_000 });
    await expect(preview.getByText(URDU)).toBeVisible();
    await expect(preview.locator('strong', { hasText: 'Important' })).toBeVisible();

    // Layout choices reach the page.
    await page.getByRole('button', { name: 'Layout and style' }).click();
    await page.getByRole('switch', { name: 'Table of contents' }).click();
    await page.getByRole('radio', { name: 'Teal' }).click();
    await page.getByLabel('Header text').fill('Team notes');
    await expect(preview.getByRole('heading', { name: 'Contents' })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'test-shots/documents-editor.png' });
    await page.getByRole('button', { name: 'Close layout and style' }).click();

    // PDF: a real file with the text, the Urdu font embedded and a cover page.
    await page.getByRole('button', { name: 'Export PDF' }).click();
    await expect(page.getByText('PDF saved')).toBeVisible({ timeout: 30_000 });
    // Word and PowerPoint from the menu.
    for (const label of ['Word (DOCX)', 'PowerPoint (PPTX)']) {
      await page.getByRole('button', { name: 'Other export formats' }).click();
      await page.getByRole('menuitem', { name: `Export ${label}` }).click();
      await expect(page.getByText(`${label} saved`)).toBeVisible({ timeout: 30_000 });
    }

    const exports = await call<DocumentExport[]>(page, 'listExports');
    expect(exports.map((e) => e.format).sort()).toEqual(['docx', 'pdf', 'pptx']);
    const path = (format: string) => join(dataDir, 'exports', exports.find((e) => e.format === format)!.fileName);

    const pdf = await readPdf(path('pdf'));
    expect(pdf.pages).toBeGreaterThanOrEqual(3);
    expect(pdf.text).toContain('recorder: Meeting Minutes');
    expect(pdf.text).toContain('Urdu section');
    expect(pdf.text).toContain('Team notes');
    // Urdu is drawn with the embedded Nastaliq font. Chromium's PDF writer cannot map Nastaliq's joined
    // letter forms back to characters, so only some Urdu text can be copied out of a PDF (a documented
    // limitation; Word, Markdown and text exports keep it exactly). Unjoined words do survive.
    expect(pdf.fonts.some((f) => /NotoNastaliqUrdu/i.test(f)), pdf.fonts.join(', ')).toBe(true);
    expect(pdf.text.normalize('NFKC')).toContain('اردو');
    // And it looks right: Chromium's own PDF viewer renders the exported file.
    const shot = await app.evaluate(async ({ BrowserWindow }, file) => {
      const win = new BrowserWindow({ show: false, width: 1000, height: 1300, webPreferences: { plugins: true } });
      await win.loadURL(`file:///${file.replace(/\\/g, '/')}#page=3&zoom=page-width&toolbar=0`);
      await new Promise((r) => setTimeout(r, 3000));
      const image = await win.webContents.capturePage();
      win.destroy();
      return image.toPNG().toString('base64');
    }, path('pdf'));
    writeFileSync('test-shots/documents-pdf-page3.png', Buffer.from(shot, 'base64'));
    expect(pdf.fonts.some((f) => /Inter/i.test(f)), pdf.fonts.join(', ')).toBe(true);

    const docx = await (await JSZip.loadAsync(readFileSync(path('docx')))).file('word/document.xml')!.async('string');
    expect(docx).toContain(URDU);
    expect(docx).toContain('<w:bidi/>');
    expect(docx).toContain('TOC \\h \\o');
    const pptx = await JSZip.loadAsync(readFileSync(path('pptx')));
    const slides = Object.keys(pptx.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThanOrEqual(3);
    expect((await Promise.all(slides.map((f) => pptx.file(f)!.async('string')))).join('')).toContain(URDU);

    // Versions: save one, restore the first draft, and the current draft is kept.
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Save a version' }).click();
    await page.getByLabel('Name').fill('With Urdu section');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Version saved')).toBeVisible();
    await page.getByRole('button', { name: 'Versions' }).click();
    const versions = page.getByRole('dialog', { name: 'Versions' });
    await expect(versions.getByText('With Urdu section')).toBeVisible();
    await versions.locator('.version-row', { hasText: 'First draft' }).getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
    await expect(text).not.toHaveValue(/Urdu section/);
    await page.getByRole('button', { name: 'Versions' }).click();
    await expect(page.getByRole('dialog', { name: 'Versions' }).locator('.version-row')).toHaveCount(3);
    await expect(page.getByRole('dialog', { name: 'Versions' }).getByText('Before restoring an older version')).toBeVisible();
    await page.getByRole('dialog', { name: 'Versions' }).getByRole('button', { name: 'Close' }).click();

    // Export center: documents and files, a missing file, deleting a file.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    await expect(page.locator('.doc-row', { hasText: 'recorder: Meeting Minutes' })).toBeVisible();
    await page.getByRole('button', { name: 'Exported files (3)' }).click();
    await expect(page.locator('.export-row')).toHaveCount(3);
    await page.screenshot({ path: 'test-shots/documents-exports.png' });
    await page.locator('.export-row', { hasText: '.pptx' }).getByRole('button', { name: 'Delete file' }).click();
    await page.getByRole('button', { name: 'Delete file', exact: true }).last().click();
    await expect(page.locator('.export-row')).toHaveCount(2);
    expect(existsSync(path('pptx'))).toBe(false);

    // Deleting the recording forever removes its documents and their files.
    await call(page, 'trashRecordings', [rec.id]);
    await call(page, 'deleteForever', [rec.id]);
    await expect.poll(() => call<DocumentRecord[]>(page, 'listDocuments')).toEqual([]);
    expect(existsSync(path('pdf'))).toBe(false);
    expect(existsSync(path('docx'))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('documents: Studio tools, a summary becomes a document, blank pages, transcript documents', async () => {
  test.setTimeout(90_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);

    // Studio's PDF tool opens the same flow, with PDF as the main export.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
    await page.getByRole('button', { name: /PDF Generator/ }).click();
    await expect(page.getByText(/then export it as PDF/)).toBeVisible();
    await page.getByRole('radio', { name: /Interview Transcript/ }).click();
    await expect(page.getByRole('radio', { name: /Full transcript/ })).toBeChecked();
    await page.getByRole('button', { name: 'Create document' }).click();
    const text = page.getByRole('textbox', { name: 'Document text' });
    await expect(text).toHaveValue(/^## Transcript/);
    await expect(page.getByRole('button', { name: 'Export PDF' })).toBeVisible();
    // Back goes past the finished form, to the Studio.
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    await expect(page.getByRole('heading', { name: 'AI Studio' })).toBeVisible();

    // A summary becomes a document with no new AI work.
    await call(page, 'requestSummary', rec.id, { ...DEFAULT_SUMMARY_OPTIONS, format: 'bullets' });
    await expect.poll(async () => (await call<Summary[]>(page, 'listSummaries', rec.id)).length, { timeout: 15_000 }).toBe(1);
    const summary = (await call<Summary[]>(page, 'listSummaries', rec.id))[0]!;
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-row', { hasText: 'recorder' }).locator('.rec-main').click();
    await page.getByRole('button', { name: 'Summaries', exact: true }).click();
    await page.getByRole('button', { name: 'Make a document from this summary' }).click();
    await expect(page.getByRole('radio', { name: /A saved summary/ })).toBeChecked();
    await page.getByRole('button', { name: 'Create document' }).click();
    await expect(text).toHaveValue(summary.markdown);

    // A blank page with no recording: nothing about a source, and it can still be exported.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'AI Studio', exact: true }).click();
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    await page.getByRole('button', { name: 'New document' }).first().click();
    await page.getByRole('radio', { name: /Blank page/ }).check();
    await page.getByLabel('Recording').selectOption('');
    await page.getByLabel('Title').fill('Ideas');
    await page.getByRole('button', { name: 'Create document' }).click();
    await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Ideas');
    await text.fill('## One\n\nA thought');
    await page.getByRole('button', { name: 'Other export formats' }).click();
    await page.getByRole('menuitem', { name: 'Export Markdown' }).click();
    await expect(page.getByText('Markdown saved')).toBeVisible();
    const md = (await call<DocumentExport[]>(page, 'listExports')).find((e) => e.format === 'md')!;
    expect(readFileSync(join(dataDir, 'exports', md.fileName), 'utf8')).toBe('﻿# Ideas\n\n## One\n\nA thought\n');

    // Transcript export offers CSV.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-row', { hasText: 'recorder' }).locator('.rec-main').click();
    await page.getByRole('button', { name: 'Open transcript' }).click();
    await page.getByRole('button', { name: 'Export transcript' }).click();
    await expect(page.getByRole('menuitem', { name: 'Save as CSV' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
