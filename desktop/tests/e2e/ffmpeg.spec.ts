import { expect, test } from '@playwright/test';
import type { ImportJob, Recording } from '../../src/shared/models';
import { ensureFixtures, ffmpegInstalled, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());
test.skip(!ffmpegInstalled(), 'Run "npm run fetch:ffmpeg" once to enable these tests.');

test('with the FFmpeg add-on, AMR imports and plays like any other recording', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await page.evaluate((path) => window.echomind.call('importPaths', [path], 'lecture'), fixture('old-phone.amr'));
    await expect
      .poll(() => page.evaluate(() => window.echomind.call('listImports').then((j: ImportJob[]) => j[0]?.status)), { timeout: 30_000 })
      .toBe('done');
    const [recording] = await page.evaluate(() => window.echomind.call('listRecordings', { view: 'all', sort: 'newest' })) as Recording[];
    expect(recording).toMatchObject({ format: 'OGG', codec: 'Opus', originalName: 'old-phone.amr' });
    expect(recording!.durationMs).toBeGreaterThan(9000);
    const info = await page.evaluate(() => window.echomind.call('getAppInfo'));
    expect(info.ffmpeg).toBe(true);

    // Damaged and fake files are still refused, with FFmpeg getting a chance first.
    await page.evaluate((path) => window.echomind.call('importPaths', [path], 'lecture'), fixture('fake.mp3'));
    await expect
      .poll(() => page.evaluate(() => window.echomind.call('listImports').then((j: ImportJob[]) => j.find((x) => x.displayName === 'fake.mp3')?.status)), { timeout: 30_000 })
      .toBe('failed');
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
