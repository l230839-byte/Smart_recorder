import { expect, test } from '@playwright/test';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

test('every screen fits the smallest window in dark mode, with no sideways scrolling', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await page.evaluate(() => window.echomind.call('updateSettings', { theme: 'dark' }));
    await page.evaluate((paths) => window.echomind.call('importPaths', paths, 'meeting'), [fixture('recorder.m4a'), fixture('tone.wav')]);
    await expect.poll(() => page.evaluate(() => window.echomind.call('listRecordings', { view: 'all', sort: 'newest' }).then((r) => r.length)), { timeout: 30_000 }).toBe(2);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.isVisible())!.setContentSize(860, 600);
    });

    const noSidewaysScroll = async (name: string) => {
      const overflow = await page.evaluate(() => {
        const content = document.querySelector('.content')!;
        return content.scrollWidth - content.clientWidth;
      });
      expect(overflow, name).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-shots/small-${name}.png` });
    };

    const nav = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();
    await noSidewaysScroll('home');
    await nav('Library');
    await expect(page.locator('.rec-row')).toHaveCount(2);
    await noSidewaysScroll('library');
    await page.locator('.rec-main').first().click();
    await expect(page.getByRole('button', { name: 'Open full player' })).toBeVisible();
    await noSidewaysScroll('detail');
    await page.getByRole('button', { name: 'Open full player' }).click();
    await noSidewaysScroll('player');
    await nav('Record');
    await noSidewaysScroll('record');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await page.waitForTimeout(1200);
    await noSidewaysScroll('recording');
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await nav('AI Studio');
    await noSidewaysScroll('studio');
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    await noSidewaysScroll('documents');
    await page.getByRole('button', { name: 'New document' }).first().click();
    await noSidewaysScroll('document-new');
    await page.getByRole('radio', { name: /Blank page/ }).check();
    await page.getByRole('button', { name: 'Create document' }).click();
    await page.getByRole('textbox', { name: 'Document text' }).fill('## Heading\n\nSome text for the page.');
    await page.getByRole('button', { name: 'Layout and style' }).click();
    await expect(page.frameLocator('iframe[title="Page preview"]').getByRole('heading', { name: 'Heading' })).toBeVisible({ timeout: 10_000 });
    await noSidewaysScroll('document-editor');
    await page.getByRole('button', { name: 'Search' }).first().click();
    await page.getByRole('searchbox', { name: 'Search everything' }).fill('recorder');
    await expect(page.locator('.search-result').first()).toBeVisible();
    await noSidewaysScroll('search');
    await page.getByRole('button', { name: /Ask AI about/ }).click();
    await expect(page.getByRole('textbox', { name: 'Your question' })).toBeVisible();
    await noSidewaysScroll('chat');
    await nav('Settings');
    await noSidewaysScroll('settings');
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
