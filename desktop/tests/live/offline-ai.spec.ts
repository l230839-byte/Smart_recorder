// Every AI feature with Offline only ON: offline Whisper transcribes, the offline writing model (llama.cpp)
// writes the summary, chapters, answers and a quiz. Models are copied from .live-cache/models (fetched once
// through the app's own checked download, or by hand with matching hashes). LIVE_OFFLINE_LLM picks the
// writing model (default qwen3-4b).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ChatDetail } from '../../src/shared/chat';
import type { ImportJob, Recording, Summary, Transcript } from '../../src/shared/models';
import { LOCAL_LLM_MODELS, LOCAL_MODELS, type LocalLlmModelId } from '../../src/shared/providers';
import { DEFAULT_STUDIO_OPTIONS, type StudioOutput } from '../../src/shared/studio';
import { DEFAULT_SUMMARY_OPTIONS } from '../../src/shared/summaries';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from '../e2e/helpers';
import { call, citeCount, waitJob } from './live-helpers';
import { FACTS, makeSpeech, QUESTIONS } from './meeting';

const LLM = (process.env.LIVE_OFFLINE_LLM ?? 'qwen3-4b') as LocalLlmModelId;

test('live: everything works with Offline only on, on this computer', async () => {
  test.setTimeout(60 * 60_000);
  const cache = resolve('.live-cache/models');
  const needed = [LOCAL_MODELS.small.file, LOCAL_LLM_MODELS[LLM].file];
  test.skip(!needed.every((f) => existsSync(join(cache, f))), `Put ${needed.join(' and ')} in .live-cache/models first.`);
  test.skip(!existsSync(resolve('resources/bin/llama/llama-server.exe')), 'Run npm run fetch:llama first.');
  const reportDir = resolve('.live-cache/reports');
  mkdirSync(reportDir, { recursive: true });
  const dataDir = tempDataDir();
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  for (const f of needed) copyFileSync(join(cache, f), join(dataDir, 'models', f));
  const audio = makeSpeech(dataDir);
  const report: string[] = [`# Offline AI, live, ${new Date().toISOString()}`, '', `Writing model: ${LOCAL_LLM_MODELS[LLM].label}. Transcription: Whisper Small. Offline only ON throughout.`, ''];
  const factCheck = (text: string) => FACTS.filter(([, re]) => re.test(text)).length;
  const { app, page } = await launch(dataDir);
  const timed = async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const value = await run();
    report.push(`- ${label}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return value;
  };
  try {
    await completeOnboarding(page);
    // Offline only stays on; the chosen online services are never used.
    await call(page, 'updateSettings', { offlineOnly: true, transcriptionProvider: 'groq', llmProvider: 'groq', offlineTranscriptionModel: 'small', offlineLlmModel: LLM });
    await call(page, 'importPaths', [audio], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;

    const tJob = await timed('Transcription', async () => {
      await call(page, 'requestTranscription', rec.id);
      return waitJob(page, () => call(page, 'latestJob', rec.id, 'transcribe'), 20 * 60_000);
    });
    expect(tJob.status, tJob.error ?? '').toBe('done');
    expect(tJob.provider).toBe('local');
    const transcript = (await call<Transcript>(page, 'getTranscript', rec.id))!;
    report.push(`  ${transcript.segments.length} lines; facts heard ${factCheck(transcript.segments.map((s) => s.text).join(' '))}/${FACTS.length}`);

    const sJob = await timed('Structured summary', async () => {
      await call(page, 'requestSummary', rec.id, { ...DEFAULT_SUMMARY_OPTIONS, format: 'structured' });
      return waitJob(page, () => call(page, 'latestJob', rec.id, 'summarize'), 30 * 60_000);
    });
    expect(sJob.status, sJob.error ?? '').toBe('done');
    expect(sJob.provider).toBe('local-llm');
    const summary = (await call<Summary[]>(page, 'listSummaries', rec.id))[0]!;
    report.push(`  facts ${factCheck(summary.markdown)}/${FACTS.length}; citations kept ${citeCount(summary.markdown)}, invented and removed ${summary.droppedCitations}`, '', summary.markdown, '');

    const cJob = await timed('Chapters', async () => {
      await call(page, 'requestChapters', rec.id);
      return waitJob(page, () => call(page, 'latestJob', rec.id, 'chapters'), 20 * 60_000);
    });
    const chapters = await call<{ title: string; startMs: number }[]>(page, 'listChapters', rec.id);
    report.push(`  ${cJob.status}${cJob.error ? ` (${cJob.error})` : ''}: ${chapters.map((c) => `${(c.startMs / 1000).toFixed(0)}s ${c.title}`).join(' | ')}`);

    const thread = await call<string>(page, 'startChat', { kind: 'recordings', recordingIds: [rec.id] });
    for (const question of QUESTIONS.slice(0, 3)) {
      await timed(`Chat: ${question}`, async () => {
        await call(page, 'askChat', thread, question);
        await expect.poll(async () => (await call<ChatDetail>(page, 'getChat', thread)).turns.at(-1)?.status, { timeout: 15 * 60_000 }).not.toBe('pending');
      });
      const last = (await call<ChatDetail>(page, 'getChat', thread)).turns.at(-1)!;
      report.push(`  ${last.status} (${last.found ?? '-'}): ${(last.content || last.error || '').slice(0, 300).replace(/\n/g, ' ')}`);
    }

    const quiz = await timed('Quiz (5 questions)', async () => {
      const out = await call<{ ok: true; outputId: string }>(page, 'startStudio', { kind: 'quiz', recordingIds: [rec.id], options: { ...DEFAULT_STUDIO_OPTIONS, count: 5 } });
      const job = await waitJob(page, () => call(page, 'studioJob', out.outputId), 30 * 60_000);
      return { job, outputs: await call<StudioOutput[]>(page, 'listStudio', rec.id) };
    });
    report.push(`  ${quiz.job.status}${quiz.job.error ? ` (${quiz.job.error})` : ''}; ${quiz.outputs[0]?.title ?? ''}`);
    expect(quiz.job.status, quiz.job.error ?? '').toBe('done');
    expect(factCheck(summary.markdown)).toBeGreaterThanOrEqual(FACTS.length / 2);
  } finally {
    writeFileSync(join(reportDir, `offline-ai-${LLM}.md`), report.join('\n'));
    await closeApp(app);
    removeDir(dataDir);
  }
});
