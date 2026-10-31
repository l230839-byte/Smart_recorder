import { expect, test } from '@playwright/test';
import { completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test('first run, navigation, theme and settings persist across a restart', async () => {
  const dataDir = tempDataDir();
  const errors: string[] = [];
  try {
    let { app, page } = await launch(dataDir);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await expect(page.getByRole('heading', { name: 'Turn every recording into knowledge' })).toBeVisible();
    await page.screenshot({ path: 'test-results/shots/onboarding.png' });
    await completeOnboarding(page, 'Sara');
    await expect(page.getByRole('heading', { name: /, Sara$/ })).toBeVisible();

    for (const section of ['Library', 'Record', 'AI Studio', 'Settings', 'Home']) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: section }).click();
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: section })).toHaveAttribute('aria-current', 'page');
    }

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Dark' }).click();
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    await page.screenshot({ path: 'test-results/shots/settings-dark.png' });

    // Offline-only is on by default, and turning it off requires a deliberate confirmation.
    const offline = page.getByRole('switch', { name: 'Offline only' });
    await expect(offline).toHaveAttribute('aria-checked', 'true');
    await offline.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(offline).toHaveAttribute('aria-checked', 'true');

    await app.close();
    ({ app, page } = await launch(dataDir));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await expect(page.getByRole('heading', { name: /, Sara$/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    await app.close();

    expect(errors).toEqual([]);
  } finally {
    removeDir(dataDir);
  }
});

test('the renderer has no access to Node or the file system', async () => {
  const dataDir = tempDataDir();
  try {
    const { app, page } = await launch(dataDir);
    const exposure = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      bridge: Object.keys(window.echomind).sort(),
    }));
    expect(exposure).toEqual({ require: 'undefined', process: 'undefined', bridge: ['call', 'on', 'platform'] });

    // A strict CSP is in place: injected inline script must not run.
    const ran = await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__injected = true';
      document.head.append(s);
      return (window as unknown as { __injected?: boolean }).__injected === true;
    });
    expect(ran).toBe(false);
    await app.close();
  } finally {
    removeDir(dataDir);
  }
});
