import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
}

const ROOT = resolve(process.cwd());

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'echomind-e2e-'));
}

export function removeDir(dir: string): void {
  // Best effort: an app still closing can hold files, and that must not hide the test's real result.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* left for the OS temp cleaner */
  }
}

export async function launch(dataDir: string, args: string[] = []): Promise<Launched> {
  const env = { ...process.env, ECHOMIND_USER_DATA: dataDir } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({
    args: [ROOT, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...args],
    cwd: ROOT,
    env,
    // Playwright pins pages to light mode by default, which would hide the app's real theme switching.
    colorScheme: null,
  });
  const page = await firstMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
  return { app, page, dataDir };
}

/** A failed test can leave a recording running, and the app rightly refuses to close then. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000));
  if ((await Promise.race([app.close().catch(() => undefined), timeout])) === 'timeout') killTree(app);
}

export function killTree(app: ElectronApplication): void {
  spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F']);
}

/** The hidden media worker is also a window; tests always drive the main one. */
async function firstMainWindow(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const main = app.windows().find((w) => !w.url().endsWith('media.html'));
    if (main) return main;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Main window did not open');
}

export async function completeOnboarding(page: Page, name = 'Test User'): Promise<void> {
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Start using EchoMind' }).click();
  await page.getByRole('navigation', { name: 'Main' }).waitFor();
}
