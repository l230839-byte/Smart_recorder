import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ChatDetail } from '../../src/shared/chat';
import type { DocumentExport, ImportJob, Recording } from '../../src/shared/models';
import { DEFAULT_SUMMARY_OPTIONS } from '../../src/shared/summaries';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function transcribed(page: Page): Promise<Recording> {
  await call(page, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake' });
  await call(page, 'importPaths', [fixture('recorder.m4a')], 'lecture');
  await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 30_000 }).toBe('done');
  const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;
  await call(page, 'requestTranscription', rec.id);
  await expect.poll(async () => (await call<Recording>(page, 'getRecording', rec.id)).hasTranscript, { timeout: 20_000 }).toBe(true);
  return rec;
}

/** Native file dialogs cannot be clicked by a test, so the main process answers them with these paths. */
async function answerDialogs(app: ElectronApplication, save: string | null, open: string | null) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = (async () => ({ canceled: !paths.save, filePath: paths.save ?? '' })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: !paths.open, filePaths: paths.open ? [paths.open] : [] })) as typeof dialog.showOpenDialog;
  }, { save, open });
}

test('app lock: the PIN gates everything, wrong PINs are refused, and a new launch starts locked', async () => {
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    await transcribed(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('switch', { name: 'App lock' }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on app lock' });
    await dialog.getByLabel('PIN (4 to 12 digits)').fill('2468');
    await dialog.getByLabel('Type it again').fill('2469');
    await expect(dialog.getByText('The two PINs are different.')).toBeVisible();
    await dialog.getByLabel('Type it again').fill('2468');
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByLabel('Lock automatically')).toHaveValue('5');

    await page.getByRole('button', { name: 'Lock now' }).click();
    await expect(page.getByRole('heading', { name: 'EchoMind is locked' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/lock-screen.png' });
    // The main process refuses data while locked, not just the screen.
    await expect(call(page, 'listRecordings', { view: 'all', sort: 'newest' })).rejects.toThrow(/locked/);
    const media = await page.evaluate(async () => (await fetch('echomind-media://audio/anything').catch(() => null))?.status ?? 'blocked');
    expect([403, 'blocked']).toContain(media);
    await page.getByLabel('Enter your PIN').fill('1111');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('That PIN is not right.')).toBeVisible();
    await page.getByLabel('Enter your PIN').fill('2468');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'EchoMind is locked' })).toBeHidden();
    expect(await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).toHaveLength(1);

    await closeApp(app);
    ({ app, page } = await launch(dataDir));
    await expect(page.getByRole('heading', { name: 'EchoMind is locked' })).toBeVisible();
    await page.getByLabel('Enter your PIN').fill('2468');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('backup and restore: encrypted, password checked, the library replaced at the next launch with the old one kept', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const outside = tempDataDir();
  const backupFile = join(outside, 'library.echomind-backup');
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);
    await call(page, 'saveProviderKey', 'groq', 'gsk_not_a_real_key');
    await answerDialogs(app, backupFile, backupFile);

    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /Backup and restore/ }).click();
    await page.getByRole('button', { name: 'Back up now' }).click();
    const create = page.getByRole('dialog', { name: 'Create a backup' });
    await create.getByLabel(/Password for this backup/).fill('library password');
    await create.getByLabel('Type it again').fill('library password');
    await expect(create.getByRole('button', { name: 'Choose where to save' })).toBeDisabled();
    await create.getByRole('checkbox').check();
    await create.getByRole('button', { name: 'Choose where to save' }).click();
    await expect(page.getByText(/Backup saved: 1 recording/)).toBeVisible({ timeout: 30_000 });
    expect(existsSync(backupFile)).toBe(true);
    await page.screenshot({ path: 'test-shots/backup.png' });

    // After the backup, the recording is deleted.
    await call(page, 'trashRecordings', [rec.id]);
    await call(page, 'deleteForever', [rec.id]);
    expect(await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).toHaveLength(0);

    await page.getByRole('button', { name: 'Choose a backup' }).click();
    const restore = page.getByRole('dialog', { name: 'Restore this backup?' });
    await expect(restore).toContainText('with 1 recording');
    await restore.getByLabel('Backup password').fill('wrong password');
    await restore.getByRole('button', { name: 'Check and restore' }).click();
    await expect(page.getByText('The password is not right.')).toBeVisible();
    await page.getByRole('dialog', { name: 'Restore this backup?' }).getByLabel('Backup password').fill('library password');
    await page.getByRole('dialog', { name: 'Restore this backup?' }).getByRole('button', { name: 'Check and restore' }).click();
    await expect(page.getByRole('dialog', { name: 'Ready to restore' })).toBeVisible({ timeout: 30_000 });

    // The restart: closed here and launched again, as "Restart now" does.
    await closeApp(app);
    ({ app, page } = await launch(dataDir));
    await expect(page.getByText('Your backup has been restored.')).toBeHidden(); // shown as a native message box
    const recs = await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' });
    expect(recs.map((r) => r.title)).toEqual([rec.title]);
    expect(recs[0]!.hasTranscript).toBe(true);
    // Keys are not carried in backups.
    expect((await call<{ hasKey: boolean }>(page, 'getProviderStatus', 'groq', 'audio')).hasKey).toBe(false);
    expect(existsSync(join(dataDir, 'previous-data'))).toBe(true);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /Backup and restore/ }).click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => existsSync(join(dataDir, 'previous-data'))).toBe(false);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    removeDir(outside);
  }
});

test('share bundles carry a recording with its transcript, summaries and documents to another library', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const otherDir = tempDataDir();
  const outside = tempDataDir();
  const bundle = join(outside, 'lecture.echomind');
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const rec = await transcribed(page);
    await call(page, 'requestSummary', rec.id, { ...DEFAULT_SUMMARY_OPTIONS, format: 'bullets' });
    await expect.poll(async () => (await call<unknown[]>(page, 'listSummaries', rec.id)).length, { timeout: 15_000 }).toBe(1);
    await call(page, 'createDocument', { recordingId: rec.id, template: 'interview-transcript', source: 'transcript' });
    await answerDialogs(app, bundle, null);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-main').first().click();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Share as a bundle' }).click();
    await expect(page.getByText(/Bundle saved/)).toBeVisible();
    await closeApp(app);

    ({ app, page } = await launch(otherDir));
    await completeOnboarding(page);
    await answerDialogs(app, null, bundle);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: /^Import/ }).first().click();
    await page.getByRole('button', { name: 'Import a shared bundle' }).click();
    await expect(page.getByRole('button', { name: 'Open transcript' })).toBeVisible({ timeout: 30_000 });
    const [imported] = await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' });
    expect(imported).toMatchObject({ title: rec.title, hasTranscript: true });
    expect(await call<unknown[]>(page, 'listSummaries', imported!.id)).toHaveLength(1);
    expect(await call<unknown[]>(page, 'listDocuments', imported!.id)).toHaveLength(1);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    removeDir(otherDir);
    removeDir(outside);
  }
});

test('privacy: a whole session with the demo providers makes no network request at all', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await app.evaluate(({ session }) => {
      const seen: string[] = [];
      (globalThis as unknown as { __requests: string[] }).__requests = seen;
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        seen.push(details.url);
        callback({});
      });
    });
    await completeOnboarding(page);
    await call(page, 'updateSettings', { offlineOnly: false });
    const rec = await transcribed(page);
    await call(page, 'requestSummary', rec.id, { ...DEFAULT_SUMMARY_OPTIONS, format: 'bullets' });
    await expect.poll(async () => (await call<unknown[]>(page, 'listSummaries', rec.id)).length, { timeout: 15_000 }).toBe(1);
    const thread = await call<string>(page, 'startChat', { kind: 'library' });
    await call(page, 'askChat', thread, 'What is said about timestamps?');
    await expect.poll(async () => (await call<ChatDetail>(page, 'getChat', thread)).turns[1]?.status, { timeout: 15_000 }).toBe('done');
    const doc = await call<{ ok: true; documentId: string }>(page, 'createDocument', { recordingId: rec.id, template: 'interview-transcript', source: 'transcript' });
    await call<DocumentExport>(page, 'exportDocument', doc.documentId, 'pdf');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-main').first().click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1000);

    const requests = await app.evaluate(() => (globalThis as unknown as { __requests: string[] }).__requests);
    const external = requests.filter((u) => !/^(file|echomind-media|echomind-doc|data|blob|devtools|chrome-extension):/.test(u) && !u.startsWith('http://localhost'));
    expect(requests.length).toBeGreaterThan(0);
    expect(external).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
