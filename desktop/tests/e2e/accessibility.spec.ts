import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, Recording } from '../../src/shared/models';
import { ensureFixtures, fixture } from './fixtures';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

test.beforeAll(() => ensureFixtures());

// axe-core injected straight into the window: Electron cannot open the extra page the Playwright wrapper uses.
const AXE_SOURCE = readFileSync(createRequire(__filename).resolve('axe-core/axe.min.js'), 'utf8');

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

/** WCAG 2.1 A and AA, checked by axe on the real screens, in every theme, accent and contrast. */
test('every main screen passes an automated WCAG 2.1 AA check, in light and dark, every accent and high contrast', async () => {
  test.setTimeout(480_000);
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const problems: string[] = [];
  try {
    await completeOnboarding(page);
    await call(page, 'updateSettings', { transcriptionProvider: 'fake', llmProvider: 'fake', offlineOnly: false });
    await call(page, 'importPaths', [fixture('recorder.m4a')], 'lecture');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 30_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;
    await call(page, 'requestTranscription', rec.id);
    await expect.poll(async () => (await call<Recording>(page, 'getRecording', rec.id)).hasTranscript, { timeout: 20_000 }).toBe(true);
    await call(page, 'createTask', { title: 'Check the audit' });

    const check = async (name: string) => {
      await page.waitForTimeout(300);
      if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> } }).axe;
        const result = await axe.run({ exclude: [['iframe']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return result.violations;
      });
      for (const v of violations as AxeViolation[]) problems.push(`${name}: ${v.id} (${v.impact}) ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    };
    const nav = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

    // Every screen in the default look, light and dark.
    for (const theme of ['light', 'dark'] as const) {
      await call(page, 'updateSettings', { theme, accent: 'indigo', contrast: 'standard' });
      await nav('Home');
      await check(`${theme} home`);
      await nav('Library');
      await check(`${theme} library`);
      await page.locator('.rec-main').first().click();
      await check(`${theme} recording`);
      await page.getByRole('button', { name: 'Open transcript' }).click();
      await check(`${theme} transcript`);
      await nav('Record');
      await check(`${theme} record`);
      await nav('AI Studio');
      await check(`${theme} studio`);
      await page.getByRole('button', { name: /^Quiz Generator/ }).click();
      await check(`${theme} studio tool`);
      await page.getByRole('button', { name: 'Search' }).first().click();
      await page.getByRole('searchbox', { name: 'Search everything' }).fill('timestamps');
      await expect(page.locator('.search-result').first()).toBeVisible();
      await check(`${theme} search`);
      await page.getByRole('button', { name: /Ask AI about/ }).click();
      await check(`${theme} chat`);
      await nav('Home');
      await page.getByRole('button', { name: /task to do/ }).click();
      await check(`${theme} tasks`);
      await nav('Settings');
      await check(`${theme} settings`);
      await page.getByRole('button', { name: /Backup and restore/ }).click();
      await check(`${theme} backup`);
    }

    // Every other accent and high contrast, in both themes, on the screens that use colour most.
    const variants: Record<string, string>[] = [
      ...(['teal', 'rose', 'amber', 'green', 'slate'] as const).flatMap((accent) => (['light', 'dark'] as const).map((theme) => ({ theme, accent, contrast: 'standard' }))),
      { theme: 'light', accent: 'indigo', contrast: 'high' },
      { theme: 'dark', accent: 'indigo', contrast: 'high' },
    ];
    for (const v of variants) {
      await call(page, 'updateSettings', v);
      const name = `${v.theme} ${v.contrast === 'high' ? 'high contrast' : v.accent}`;
      await nav('Home');
      await check(`${name} home`);
      await nav('Library');
      await page.locator('.rec-main').first().click();
      await check(`${name} recording`);
      await nav('AI Studio');
      await check(`${name} studio`);
      await nav('Settings');
      await check(`${name} settings`);
    }
    console.warn(`accessibility: ${problems.length} problems\n${problems.join('\n')}`);
    expect(problems).toEqual([]);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
