import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, Recording } from '../../src/shared/models';
import { ensureFixtures, ffmpegInstalled, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());
test.skip(!ffmpegInstalled(), 'Run "npm run fetch:ffmpeg" once to enable these tests.');

const statusOf = (page: Page, name: string) => page.evaluate((n) => window.echomind.call('listImports').then((j: ImportJob[]) => j.find((x) => x.displayName === n)?.status), name);

test('with the FFmpeg add-on, AMR imports and plays like any other recording', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await page.evaluate((path) => window.echomind.call('importPaths', [path], 'lecture'), fixture('old-phone.amr'));
    await expect.poll(() => statusOf(page, 'old-phone.amr'), { timeout: 30_000 }).toBe('done');
    const [recording] = (await page.evaluate(() => window.echomind.call('listRecordings', { view: 'all', sort: 'newest' }))) as Recording[];
    expect(recording).toMatchObject({ format: 'OGG', codec: 'Opus', originalName: 'old-phone.amr' });
    expect(recording!.durationMs).toBeGreaterThan(9000);
    const info = await page.evaluate(() => window.echomind.call('getAppInfo'));
    expect(info.ffmpeg).toBe(true);

    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.rec-main').first().click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    // Damaged and fake files are still refused, even with FFmpeg getting a chance.
    await page.evaluate((paths) => window.echomind.call('importPaths', paths, 'lecture'), [fixture('fake.mp3'), fixture('corrupt.m4a'), fixture('empty.wav')]);
    for (const name of ['fake.mp3', 'corrupt.m4a', 'empty.wav']) await expect.poll(() => statusOf(page, name), { timeout: 30_000 }).toBe('failed');
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('playlists and concat lists cannot make FFmpeg read other files on this computer', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    // Each points at a real, readable audio file elsewhere on disk. Importing one must not pull it in.
    const target = fixture('tone.wav').replace(/\\/g, '/');
    const hls = join(dataDir, 'trick.m3u8');
    writeFileSync(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\nfile:///${target}\n#EXT-X-ENDLIST\n`);
    const concat = join(dataDir, 'trick.txt.mp3');
    writeFileSync(concat, `ffconcat version 1.0\nfile '${target}'\n`);
    const sdp = join(dataDir, 'trick.sdp');
    writeFileSync(sdp, 'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=x\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio 5004 RTP/AVP 0\n');

    await page.evaluate((paths) => window.echomind.call('importPaths', paths, 'lecture'), [hls, concat, sdp]);
    for (const name of ['trick.m3u8', 'trick.txt.mp3', 'trick.sdp']) {
      await expect.poll(() => statusOf(page, name), { timeout: 30_000 }).toBe('failed');
    }
    expect(await page.evaluate(() => window.echomind.call('listRecordings', { view: 'all', sort: 'newest' }))).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
