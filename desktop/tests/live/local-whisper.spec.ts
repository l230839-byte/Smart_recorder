// Offline Whisper (whisper.cpp) in the real app: the model downloads through EchoMind's own checked
// download, then the two-voice meeting is transcribed with Offline only ON, so nothing can be sent.
// LIVE_LOCAL_MODELS picks the models (default "tiny,small"); downloads are cached in .live-cache/models.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ImportJob, Recording, Transcript } from '../../src/shared/models';
import { LOCAL_MODELS, type LocalModelId } from '../../src/shared/providers';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from '../e2e/helpers';
import { call, waitJob } from './live-helpers';
import { FACTS, makeSpeech } from './meeting';

const MODELS = (process.env.LIVE_LOCAL_MODELS ?? 'tiny,small').split(',').map((m) => m.trim()) as LocalModelId[];

test('live: offline Whisper downloads its model, then transcribes with nothing sent', async () => {
  test.setTimeout(40 * 60_000);
  test.skip(!existsSync(resolve('resources/bin/whisper/whisper-cli.exe')), 'Run npm run fetch:whisper first.');
  const cache = resolve('.live-cache/models');
  const reportDir = resolve('.live-cache/reports');
  mkdirSync(cache, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const dataDir = tempDataDir();
  // Models already downloaded once are copied in, so a rerun does not fetch hundreds of MB again.
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  for (const id of MODELS) if (existsSync(join(cache, LOCAL_MODELS[id].file))) copyFileSync(join(cache, LOCAL_MODELS[id].file), join(dataDir, 'models', LOCAL_MODELS[id].file));
  const audio = makeSpeech(dataDir);
  const report: string[] = [`# Offline Whisper, live, ${new Date().toISOString()}`, ''];
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'importPaths', [audio], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;

    for (const id of MODELS) {
      const started = Date.now();
      await call(page, 'downloadLocalModel', id);
      const downloadS = (Date.now() - started) / 1000;
      copyFileSync(join(dataDir, 'models', LOCAL_MODELS[id].file), join(cache, LOCAL_MODELS[id].file));
      // Offline only stays ON: the transcription itself must need nothing from the network.
      await call(page, 'updateSettings', { offlineOnly: true, transcriptionProvider: 'local', transcriptionModel: id });
      const t0 = Date.now();
      await call(page, 'requestTranscription', rec.id);
      const job = await waitJob(page, () => call(page, 'latestJob', rec.id, 'transcribe'), 30 * 60_000);
      const seconds = (Date.now() - t0) / 1000;
      const segments = (await call<Transcript>(page, 'getTranscript', rec.id))?.segments ?? [];
      const text = segments.map((s) => s.text).join(' ');
      const facts = FACTS.filter(([, re]) => re.test(text)).length;
      const audioS = rec.durationMs / 1000;
      report.push(
        `## ${LOCAL_MODELS[id].label} (${LOCAL_MODELS[id].sizeMb} MB): ${job.status}${job.error ? ` (${job.error})` : ''}`,
        '',
        `Download ${downloadS.toFixed(1)} s (0 if cached). Transcribed ${audioS.toFixed(0)} s of audio in ${seconds.toFixed(1)} s (${(audioS / seconds).toFixed(1)}x real time). ${segments.length} lines. Facts heard: ${facts}/${FACTS.length}. Language: ${(await call<Transcript>(page, 'getTranscript', rec.id))?.version.language}.`,
        '',
        '```',
        ...segments.map((s) => `${(s.startMs / 1000).toFixed(1).padStart(6)}s ${s.text}`),
        '```',
        '',
      );
      expect(job.status, job.error ?? '').toBe('done');
      expect(facts, `${id} facts`).toBeGreaterThanOrEqual(id === 'tiny' ? FACTS.length - 4 : FACTS.length - 1);
    }
  } finally {
    writeFileSync(join(reportDir, 'local-whisper.md'), report.join('\n'));
    await closeApp(app);
    removeDir(dataDir);
  }
});
