import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ProcessingJob, Recording } from '../../src/shared/models';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from './helpers';

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

/** A WAV of pure silence: Chromium plays it as the microphone, like a muted or dead input. */
function silentWav(path: string, seconds = 5): string {
  const rate = 48_000;
  const data = Buffer.alloc(rate * seconds * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

test('a silent microphone is caught before recording, shouted about during it, and flagged after it', async () => {
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  const wav = silentWav(join(dataDir, 'silence.wav'));
  const { app, page } = await launch(dataDir, [`--use-file-for-fake-audio-capture=${wav}`]);
  try {
    await completeOnboarding(page);
    const nav = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

    // Before: the check names the device and says it hears nothing.
    await nav('Record');
    await expect(page.getByText('Microphone check:')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /No sound from/ })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'test-shots/mic-check-silent.png' });

    // During: after ten seconds of silence, on another screen, a toast and the sidebar say so.
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    await nav('Home');
    await expect(page.getByText(/No sound is coming from/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /no sound is coming through/i })).toBeVisible();
    await nav('Record');
    await expect(page.getByRole('alert').filter({ hasText: 'EchoMind cannot hear anything' })).toBeVisible();
    await page.screenshot({ path: 'test-shots/recording-silent.png' });
    await page.getByRole('button', { name: 'Stop and choose another microphone' }).click();

    // After: the recording is kept but flagged, and nothing is sent for transcription.
    await expect.poll(async () => (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).length, { timeout: 20_000 }).toBe(1);
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;
    expect(rec.silent).toBe(true);
    await nav('Library');
    await expect(page.locator('.rec-row').getByText('No sound')).toBeVisible();
    await page.locator('.rec-main').first().click();
    await expect(page.getByText('No sound was captured in this recording.')).toBeVisible();
    await page.screenshot({ path: 'test-shots/detail-silent.png' });
    await call(page, 'updateSettings', { transcriptionProvider: 'fake' });
    await call(page, 'requestTranscription', rec.id);
    await expect.poll(async () => (await call<ProcessingJob | null>(page, 'latestJob', rec.id, 'transcribe'))?.status, { timeout: 20_000 }).toBe('failed');
    expect((await call<ProcessingJob>(page, 'latestJob', rec.id, 'transcribe')).error).toMatch(/no sound/i);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});

test('a working microphone passes the check, and a missing saved one falls back to the default', async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByText('Sound is coming through')).toBeVisible({ timeout: 10_000 });
    // A microphone chosen earlier that is no longer connected.
    await call(page, 'updateSettings', { inputDeviceId: 'a-headset-that-is-not-connected' });
    await expect(page.getByText(/selected microphone is not connected/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText(/selected microphone is not available/)).toBeVisible({ timeout: 10_000 });
    // Long enough to keep (very short recordings are discarded as accidental).
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await expect.poll(async () => (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' })).length, { timeout: 20_000 }).toBe(1);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
  }
});
