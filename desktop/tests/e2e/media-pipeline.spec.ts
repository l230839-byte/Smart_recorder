import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, Recording } from '../../src/shared/models';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, killTree, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function nav(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();
}

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function waitForImports(page: Page, expected: number): Promise<ImportJob[]> {
  let jobs: ImportJob[] = [];
  await expect
    .poll(
      async () => {
        jobs = await call<ImportJob[]>(page, 'listImports');
        return jobs.length === expected && jobs.every((j) => ['done', 'failed', 'duplicate'].includes(j.status));
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return jobs;
}

const listAll = (page: Page) => call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'title' });

test('workflow A: record with bookmarks and a note, keep going across screens, save and play', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    await nav(page, 'Record');
    await page.getByRole('radio', { name: /Meeting/ }).click();
    await page.getByLabel('Title (optional)').fill('Budget review');
    await page.screenshot({ path: 'test-results/shots/record-modes.png' });
    await page.getByRole('button', { name: 'Start recording' }).click();

    await expect(page.getByText('Recording', { exact: true })).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Bookmark' }).click();

    // Recording keeps running on other screens, with an always-visible indicator.
    await nav(page, 'Home');
    await expect(page.getByRole('button', { name: /^Recording, / })).toBeVisible();
    await page.waitForTimeout(1200);
    await nav(page, 'Record');
    await page.screenshot({ path: 'test-results/shots/record-active.png' });

    // A note belongs to the moment it was opened, even if typing takes a while.
    await page.getByRole('button', { name: 'Add note' }).click();
    const noteTitle = await page.getByRole('dialog').getByRole('heading').textContent();
    await page.getByLabel('Note', { exact: true }).fill('Budget approved');
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'Save note' }).click();

    // Time stops advancing while paused.
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await page.getByRole('timer').textContent();
    await page.waitForTimeout(1500);
    expect(await page.getByRole('timer').textContent()).toBe(paused);
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.waitForTimeout(800);

    await page.getByRole('button', { name: 'Stop and save' }).click();
    await expect(page.getByRole('heading', { name: 'Budget review' })).toBeVisible({ timeout: 20_000 });

    const [rec] = await listAll(page);
    expect(rec).toMatchObject({ title: 'Budget review', mode: 'meeting', source: 'native', format: 'OGG', codec: 'Opus' });
    expect(rec!.durationMs).toBeGreaterThan(4000);
    expect(rec!.durationMs).toBeLessThan(9000);

    const bookmarks = await call<{ positionMs: number; note: string | null }[]>(page, 'listBookmarks', rec!.id);
    expect(bookmarks).toHaveLength(2);
    expect(bookmarks[1]!.note).toBe('Budget approved');
    expect(noteTitle).toContain(`0:0${Math.floor(bookmarks[1]!.positionMs / 1000)}`);

    // No session file remains, and the media file is the only copy.
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    expect(readdirSync(join(dataDir, 'media'))).toHaveLength(1);

    // Plays and seeks through the media protocol.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(async () => page.getByText(/^0:0[1-9] \/ /).count(), { timeout: 8000 }).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/shots/recording-detail.png' });
    const slider = page.getByRole('slider', { name: 'Playback position' });
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('aria-valuenow', /^(9\d|100)$/);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('crash recovery: killing the app mid-recording loses nothing but the last moment', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await nav(page, 'Record');
    await page.getByLabel('Title (optional)').fill('Interrupted lecture');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Bookmark' }).click();
    await page.waitForTimeout(3000);

    // A hard kill of every process: no chance to save anything, like a crash or power cut.
    killTree(app);
    await new Promise((r) => setTimeout(r, 1500));
    expect(readdirSync(join(dataDir, 'sessions')).filter((f) => f.endsWith('.webm'))).toHaveLength(1);

    ({ app, page } = await launch(dataDir));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await expect.poll(async () => (await listAll(page)).length, { timeout: 20_000 }).toBe(1);
    const [rec] = await listAll(page);
    expect(rec).toMatchObject({ title: 'Interrupted lecture', source: 'recovered' });
    expect(rec!.durationMs).toBeGreaterThan(2500);
    expect(await call<unknown[]>(page, 'listBookmarks', rec!.id)).toHaveLength(1);
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    await nav(page, 'Library');
    await page.getByRole('button', { name: /Interrupted lecture/ }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('workflows B and D: batch import keeps the valid files, reports the bad ones, and never touches originals', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const missing = fixture('does-not-exist.mp3');
  removeDir(missing);
  try {
    await completeOnboarding(page);
    const good = ['voice-note.ogg', 'recorder.m4a', 'tone.wav', 'silent.mp3', 'lecture-video.webm', 'misnamed.mp3'];
    const bad = ['corrupt.m4a', 'fake.mp3', 'empty.wav'];
    const before = Object.fromEntries(good.map((f) => [f, sha(fixture(f))]));

    await call(page, 'importPaths', [...good, ...bad, 'truncated.m4a'].map(fixture).concat(missing), 'lecture');
    const jobs = await waitForImports(page, good.length + bad.length + 2);
    const byName = Object.fromEntries(jobs.map((j) => [j.displayName, j]));

    for (const f of bad) {
      expect(byName[f]!.status, f).toBe('failed');
      expect(byName[f]!.retryable, f).toBe(false);
    }
    expect(byName['does-not-exist.mp3']).toMatchObject({ status: 'failed', retryable: true });

    // The misnamed file is byte-identical to voice-note.ogg, so whichever runs second is a duplicate.
    const pair = [byName['voice-note.ogg']!.status, byName['misnamed.mp3']!.status].sort();
    expect(pair).toEqual(['done', 'duplicate']);

    expect(byName['truncated.m4a']).toMatchObject({ status: 'done' });
    expect(byName['truncated.m4a']!.error).toMatch(/ends early/);

    for (const f of ['recorder.m4a', 'tone.wav', 'silent.mp3', 'lecture-video.webm']) expect(byName[f]!.status, f).toBe('done');

    const recordings = await listAll(page);
    const byTitle = Object.fromEntries(recordings.map((r) => [r.originalName, r]));
    expect(byTitle['recorder.m4a']).toMatchObject({ format: 'M4A', codec: 'AAC', mode: 'lecture' });
    expect(byTitle['tone.wav']).toMatchObject({ format: 'WAV', codec: 'PCM' });
    expect(byTitle['silent.mp3']).toMatchObject({ format: 'MP3', codec: 'MP3' });
    expect(byTitle['recorder.m4a']!.durationMs).toBeGreaterThan(11_000);

    // Video: only the audio is kept, in its original codec.
    expect(byTitle['lecture-video.webm']).toMatchObject({ format: 'OGG', codec: 'Opus' });
    expect(byTitle['lecture-video.webm']!.durationMs).toBeGreaterThan(2500);

    // Originals are byte-identical afterwards.
    for (const f of good) expect(sha(fixture(f)), f).toBe(before[f]);

    // Importing the same file again is caught.
    await call(page, 'importPaths', [fixture('recorder.m4a')], 'meeting');
    const again = await waitForImports(page, jobs.length + 1);
    expect(again[0]).toMatchObject({ displayName: 'recorder.m4a', status: 'duplicate', duplicateOf: byTitle['recorder.m4a']!.id });
    expect((await listAll(page)).filter((r) => r.originalName === 'recorder.m4a')).toHaveLength(1);

    // Retry works once the missing file exists.
    writeFileSync(missing, readFileSync(fixture('silent.mp3')).subarray(0, 8340));
    await call(page, 'retryImport', byName['does-not-exist.mp3']!.id);
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports')).find((j) => j.displayName === 'does-not-exist.mp3')?.status, { timeout: 20_000 }).toBe('done');

    await page.getByRole('button', { name: /^Import\b/ }).first().click();
    await expect(page.getByText('Failed').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/shots/import-batch.png' });
    // No retry offered for files that can never work.
    const corruptRow = page.locator('.import-row', { hasText: 'corrupt.m4a' });
    await expect(corruptRow.getByRole('button', { name: 'Retry' })).toHaveCount(0);

    // Every imported recording plays.
    await page.locator('.import-row', { hasText: 'recorder.m4a' }).getByRole('button', { name: 'Open' }).first().click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(async () => page.getByText(/^0:0[1-9] \/ /).count(), { timeout: 8000 }).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/shots/import-playing.png' });

    expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    removeDir(missing);
  }
});

test('workflow C: a file opened with EchoMind goes straight into the library', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir, [fixture('recorder.m4a')]);
  try {
    await completeOnboarding(page);
    await expect.poll(async () => (await listAll(page)).map((r) => r.source), { timeout: 20_000 }).toEqual(['opened']);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('library: tags, search, favorites, collections, trash, restore, permanent delete', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'importPaths', ['recorder.m4a', 'tone.wav', 'voice-note.ogg'].map(fixture), 'lecture');
    await waitForImports(page, 3);
    await nav(page, 'Library');
    const row = (name: string) => page.locator('.rec-row', { hasText: name });

    // Tag from the detail screen, then filter by it.
    await row('recorder').locator('.rec-main').click();
    await page.locator('section', { hasText: 'Tags' }).getByRole('button', { name: 'Add' }).click();
    await page.getByRole('textbox', { name: 'Tag' }).fill('#budget');
    await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('#budget')).toBeVisible();
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    await page.getByRole('button', { name: '#budget', exact: true }).click();
    await expect(page.locator('.rec-row')).toHaveCount(1);
    await page.getByRole('button', { name: '#budget', exact: true }).click();

    // Search finds tags, and search syntax cannot break it.
    const search = page.getByRole('searchbox');
    await search.fill('budg');
    await expect(page.locator('.rec-row')).toHaveCount(1);
    await search.fill('"((*');
    await expect(page.getByText('Nothing matches')).toBeVisible();
    await search.fill('');
    await expect(page.locator('.rec-row')).toHaveCount(3);

    // Batch favorite.
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select tone' }).click();
    await page.getByRole('checkbox', { name: 'Select voice-note' }).click();
    await page.screenshot({ path: 'test-results/shots/library-selection.png' });
    await page.getByRole('toolbar').getByRole('button', { name: 'Favorite' }).click();
    await page.getByRole('button', { name: 'Favorites' }).click();
    await expect(page.locator('.rec-row')).toHaveCount(2);
    await page.getByRole('button', { name: 'All', exact: true }).click();

    // Nested collection includes recordings in sub-collections.
    await page.getByRole('button', { name: 'Collections' }).click();
    await page.getByRole('button', { name: 'New collection' }).click();
    await page.getByLabel('Name').fill('University');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await page.getByRole('button', { name: 'Options for University' }).click();
    await page.getByRole('menuitem', { name: 'New sub-collection' }).click();
    await page.getByLabel('Name').fill('Semester 1');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Semester 1')).toBeVisible();
    await page.screenshot({ path: 'test-results/shots/collections.png' });
    const collections = await call<{ id: string; name: string }[]>(page, 'listCollections');
    const recs = await listAll(page);
    await call(page, 'moveToCollection', [recs.find((r) => r.originalName === 'tone.wav')!.id], collections.find((c) => c.name === 'Semester 1')!.id);
    await page.locator('.collection-open', { hasText: 'University' }).click();
    await expect(page.locator('.rec-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();

    // Trash: leaves the library, its tag filter goes with it, and it can be restored.
    await row('recorder').hover();
    await page.getByRole('checkbox', { name: 'Select recorder' }).click();
    await page.getByRole('toolbar').getByRole('button', { name: 'Trash' }).click();
    await expect(page.locator('.rec-row')).toHaveCount(2);
    await expect(page.getByRole('group', { name: 'Tags' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(page.getByText('Removed permanently after 30 days')).toBeVisible();
    await page.screenshot({ path: 'test-results/shots/library-trash.png' });

    // A trashed recording offers no paid AI work.
    await row('recorder').locator('.rec-main').click();
    await expect(page.getByText('This recording is in the trash.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('heading', { name: 'AI', exact: true })).toBeVisible();
    expect((await listAll(page)).length).toBe(3);

    // Permanent delete removes the file from disk too.
    const filesBefore = readdirSync(join(dataDir, 'media')).length;
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    const target = (await listAll(page)).find((r) => r.originalName === 'recorder.m4a')!;
    await call(page, 'trashRecordings', [target.id]);
    await page.getByRole('button', { name: 'Empty trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Empty trash' }).click();
    await expect(page.getByText('Trash is empty')).toBeVisible();
    expect(readdirSync(join(dataDir, 'media')).length).toBe(filesBefore - 1);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('trim and player: exact range, untouched original, speed, skip silence and voice boost', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await completeOnboarding(page);
    await call(page, 'importPaths', [fixture('voice-note.ogg'), fixture('recorder.m4a')], 'lecture');
    await waitForImports(page, 2);
    const recs = await listAll(page);
    const source = recs.find((r) => r.originalName === 'voice-note.ogg')!;
    await nav(page, 'Library');
    await page.locator('.rec-row', { hasText: 'voice-note' }).locator('.rec-main').click();

    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Trim into new recording' }).click();
    // Full range: nothing to cut, so nothing to create.
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Create' })).toBeDisabled();
    await page.screenshot({ path: 'test-results/shots/trim-dialog.png' });
    await page.getByLabel(/^Start:/).fill('2000');
    await page.getByLabel(/^End:/).fill('7000');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: /voice-note \(trimmed\)/ })).toBeVisible({ timeout: 20_000 });

    const after = await listAll(page);
    const trimmed = after.find((r) => r.source === 'trim')!;
    expect(Math.abs(trimmed.durationMs - 5000)).toBeLessThan(250);
    expect(after.find((r) => r.id === source.id)!.durationMs).toBe(source.durationMs);

    // AAC keeps its codec through a trim.
    const m4a = after.find((r) => r.originalName === 'recorder.m4a' && r.source !== 'trim')!;
    const m4aId = await call<string>(page, 'trimRecording', m4a.id, 1000, 6000);
    const m4aTrim = await call<Recording>(page, 'getRecording', m4aId);
    expect(m4aTrim).toMatchObject({ format: 'M4A', codec: 'AAC' });
    expect(Math.abs(m4aTrim.durationMs - 5000)).toBeLessThan(250);

    // Full player, on the original with its 4-second silent gap.
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    await page.getByRole('button', { name: 'Back (Alt+Left)' }).click();
    await page.getByRole('searchbox').waitFor();
    await page.locator('.rec-row').filter({ hasText: 'voice-note' }).filter({ hasNotText: 'trimmed' }).locator('.rec-main').click();
    await page.getByRole('button', { name: 'Open full player' }).click();
    await page.getByRole('button', { name: '2×' }).click();
    await page.getByRole('switch', { name: 'Skip silence' }).click();
    await page.getByRole('switch', { name: 'Voice boost' }).click();
    await page.screenshot({ path: 'test-results/shots/player.png' });

    // 12 s at 2× with the 4 s gap skipped finishes in about 4 s, where playing it all takes 6 s.
    const start = Date.now();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 12_000 });
    expect(Date.now() - start).toBeLessThan(5500);

    // Speed persists.
    expect((await call<{ playbackSpeed: number }>(page, 'getSettings')).playbackSpeed).toBe(2);

    // Mini player appears on other screens, and playback stays reachable.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await nav(page, 'Home');
    const nowPlaying = page.getByRole('region', { name: 'Now playing' });
    await expect(nowPlaying).toBeVisible();
    await page.screenshot({ path: 'test-results/shots/home.png' });

    // Space toggles playback when nothing is focused.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const isPlaying = () => nowPlaying.getByRole('button', { name: 'Pause', exact: true }).count();
    const before = await isPlaying();
    await page.keyboard.press('Space');
    await expect.poll(isPlaying).toBe(before ? 0 : 1);

    // Starting a recording pauses playback, so the speakers are not recorded.
    if (await nowPlaying.getByRole('button', { name: 'Play', exact: true }).count()) await nowPlaying.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(nowPlaying.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await nav(page, 'Record');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await expect(nowPlaying.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('button', { name: 'Close player' }).click();
    await expect(page.getByRole('region', { name: 'Now playing' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('closing during a recording offers stop and save, and keep recording stays recording', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await nav(page, 'Record');
    await page.getByLabel('Title (optional)').fill('Do not lose me');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await page.waitForTimeout(2500);

    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 });
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.isVisible())!.close();
    });
    await page.waitForTimeout(500);
    await expect(page.getByRole('timer')).toBeVisible();

    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0 });
    });
    const closed = new Promise<void>((resolve) => app.on('close', () => resolve()));
    void app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.isVisible())!.close();
    });
    await closed;

    const next = await launch(dataDir);
    await next.page.getByRole('navigation', { name: 'Main' }).waitFor();
    const list = await listAll(next.page);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Do not lose me', source: 'native' });
    await next.app.close();
  } finally {
    removeDir(dataDir);
  }
});

test('an unplugged microphone stops the recording safely, and a blocked one explains what to do', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await nav(page, 'Record');

    // Windows has the microphone blocked.
    await page.evaluate(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      (window as unknown as { realGum: unknown }).realGum = real;
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    });
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('alert')).toContainText('Windows is blocking the microphone');
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);

    // The microphone disappears partway through.
    await page.evaluate(() => {
      const real = (window as unknown as { realGum: typeof navigator.mediaDevices.getUserMedia }).realGum;
      navigator.mediaDevices.getUserMedia = async (c) => {
        const stream = await real(c);
        (window as unknown as { track: MediaStreamTrack }).track = stream.getAudioTracks()[0]!;
        return stream;
      };
    });
    await page.getByLabel('Title (optional)').fill('Mic pulled');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as unknown as { track: MediaStreamTrack }).track.dispatchEvent(new Event('ended')));

    await expect(page.getByText('The microphone was disconnected')).toBeVisible({ timeout: 15_000 });
    const [saved] = await listAll(page);
    expect(saved).toMatchObject({ title: 'Mic pulled', source: 'native' });
    expect(saved!.durationMs).toBeGreaterThan(1000);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Mic pulled' })).toBeVisible();
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('discarding removes the audio, and stopping at once leaves nothing behind', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await nav(page, 'Record');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    expect(await listAll(page)).toEqual([]);

    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await expect(page.getByRole('button', { name: 'Start recording' }).or(page.getByRole('slider', { name: 'Playback position' }))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('a tiny unreadable leftover from a crash is cleared, while a substantial one is never deleted', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await closeApp(app);

    const db = new DatabaseSync(join(dataDir, 'echomind.db'));
    const insert = db.prepare("INSERT INTO recording_sessions (id, title, mode, started_at) VALUES (?, 'x', 'lecture', 1)");
    insert.run('tiny');
    insert.run('large');
    db.close();
    writeFileSync(join(dataDir, 'sessions', 'tiny.webm'), Buffer.alloc(200, 7));
    writeFileSync(join(dataDir, 'sessions', 'large.webm'), Buffer.alloc(200_000, 7));

    ({ app, page } = await launch(dataDir));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await expect.poll(() => readdirSync(join(dataDir, 'sessions')), { timeout: 15_000 }).toEqual(['large.webm']);
    expect(await listAll(page)).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('AMR is recognized from its content and refused with a clear message', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'importPaths', [fixture('old-phone.amr')], 'lecture');
    const [job] = await waitForImports(page, 1);
    expect(job).toMatchObject({ status: 'failed', retryable: false });
    expect(job!.error).toMatch(/AMR/);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('large file: an hour of audio imports with the app staying responsive', async () => {
  test.setTimeout(240_000);
  const dataDir = tempDataDir();
  const big = join(dataDir, 'one-hour.wav');
  const seconds = 3600;
  const rate = 16000;
  const bytes = seconds * rate * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const block = Buffer.alloc(1 << 20);
  for (let i = 0; i < block.length; i += 2) block.writeInt16LE(Math.round(Math.sin((i / 2 / rate) * 2 * Math.PI * 220) * 8000), i);
  const fd = openSync(big, 'w');
  writeSync(fd, header);
  for (let left = bytes; left > 0; left -= block.length) writeSync(fd, block, 0, Math.min(left, block.length));
  closeSync(fd);

  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    const started = Date.now();
    await call(page, 'importPaths', [big], 'lecture');
    let worstUiMs = 0;
    let peakMb = 0;
    let done = false;
    while (!done) {
      const before = Date.now();
      const jobs = await call<ImportJob[]>(page, 'listImports');
      worstUiMs = Math.max(worstUiMs, Date.now() - before);
      const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.memory.workingSetSize));
      peakMb = Math.max(peakMb, metrics.reduce((x, y) => x + y, 0) / 1024);
      expect(jobs[0]!.status).not.toBe('failed');
      done = jobs[0]!.status === 'done';
      await page.waitForTimeout(250);
    }
    const [rec] = await listAll(page);
    console.warn(`large file: ${Math.round(bytes / 1048576)} MB imported in ${Math.round((Date.now() - started) / 1000)} s, peak memory ${Math.round(peakMb)} MB, slowest UI call ${worstUiMs} ms`);
    expect(Math.abs(rec!.durationMs - seconds * 1000)).toBeLessThan(1000);
    expect(worstUiMs).toBeLessThan(1000);
    expect(peakMb).toBeLessThan(1500);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('storage screen reports real numbers', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'importPaths', [fixture('tone.wav')], 'lecture');
    await waitForImports(page, 1);
    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'Storage and trash' }).click();
    await expect(page.getByText(/used by EchoMind/)).toContainText(/1\.0 MB/);
    await page.screenshot({ path: 'test-results/shots/storage.png' });
    await page.getByLabel('Keep deleted recordings for').selectOption('7');
    expect((await call<{ trashRetentionDays: number }>(page, 'getSettings')).trashRetentionDays).toBe(7);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
