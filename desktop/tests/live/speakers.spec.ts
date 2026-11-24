// Offline speaker labels (sherpa-onnx) in the real app. The speaker models download through EchoMind's own
// checked download. Test 1: the two-voice meeting, fully offline (Whisper Small, Offline only on).
// Test 2 (LIVE_SPEAKERS_LONG=60): a 60-minute, ten-session meeting transcribed by Gemini, then labelled
// over the whole hour at once, to see whether each voice keeps one label from start to end.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, Recording, Transcript } from '../../src/shared/models';
import { LOCAL_MODELS } from '../../src/shared/providers';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from '../e2e/helpers';
import { call, loadKeys, waitJob } from './live-helpers';
import { makeLongMeeting, NUMBER_WORDS } from './long-meeting';
import { makeSpeech, SCRIPT } from './meeting';

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);

/** The script line a transcript line shares most words with, so each line's real voice is known. */
function voiceOf(text: string): 'Zira' | 'David' | null {
  const mine = words(text);
  let best: { voice: 'Zira' | 'David'; score: number } | null = null;
  for (const [voice, line] of SCRIPT) {
    const theirs = words(line);
    const score = [...mine].filter((w) => theirs.has(w)).length / Math.max(1, mine.size);
    if (!best || score > best.score) best = { voice, score };
  }
  return best && best.score >= 0.5 ? best.voice : null;
}

async function labelSpeakers(page: Page, recordingId: string, count: number | null): Promise<{ transcript: Transcript; seconds: number }> {
  const started = Date.now();
  await call(page, 'downloadSpeakerModels');
  const outcome = await call<{ ok: boolean }>(page, 'requestSpeakers', recordingId, count);
  expect(outcome.ok).toBe(true);
  const job = await waitJob(page, () => call(page, 'latestJob', recordingId, 'diarize'), 30 * 60_000);
  expect(job.status, job.error ?? '').toBe('done');
  return { transcript: (await call<Transcript>(page, 'getTranscript', recordingId))!, seconds: (Date.now() - started) / 1000 };
}

const reportDir = resolve('.live-cache/reports');

test('live: offline speaker labels on the two-voice meeting, with nothing sent anywhere', async () => {
  test.setTimeout(20 * 60_000);
  test.skip(!existsSync(resolve('resources/bin/sherpa/sherpa-onnx-offline-speaker-diarization.exe')), 'Run npm run fetch:sherpa first.');
  const whisper = resolve('.live-cache/models', LOCAL_MODELS.small.file);
  test.skip(!existsSync(whisper), 'Put the Whisper Small model in .live-cache/models first.');
  mkdirSync(reportDir, { recursive: true });
  const dataDir = tempDataDir();
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  copyFileSync(whisper, join(dataDir, 'models', LOCAL_MODELS.small.file));
  const audio = makeSpeech(dataDir);
  const report: string[] = [`# Offline speaker labels, live, ${new Date().toISOString()}`, ''];
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'importPaths', [audio], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;
    await call(page, 'updateSettings', { offlineOnly: true, offlineTranscriptionModel: 'small' });
    await call(page, 'requestTranscription', rec.id);
    const tJob = await waitJob(page, () => call(page, 'latestJob', rec.id, 'transcribe'), 10 * 60_000);
    expect(tJob.status, tJob.error ?? '').toBe('done');

    for (const count of [null, 2] as const) {
      const { transcript, seconds } = await labelSpeakers(page, rec.id, count);
      const labelled = transcript.segments.map((s) => ({ voice: voiceOf(s.text), speaker: s.speaker, text: s.text, startMs: s.startMs })).filter((s) => s.voice);
      const majority = (voice: string) => {
        const counts = new Map<string, number>();
        for (const s of labelled.filter((l) => l.voice === voice && l.speaker)) counts.set(s.speaker!, (counts.get(s.speaker!) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      };
      const zira = majority('Zira');
      const david = majority('David');
      const right = labelled.filter((s) => s.speaker && s.speaker === (s.voice === 'Zira' ? zira : david)).length;
      const accuracy = zira && david && zira !== david ? right / labelled.length : 0;
      report.push(
        `## Speakers: ${count ?? 'automatic'} (${seconds.toFixed(1)} s including the model download the first time)`,
        '',
        `Version: ${transcript.version.provider}. Speakers found: ${new Set(transcript.segments.map((s) => s.speaker).filter(Boolean)).size}. Accuracy against the script: ${Math.round(accuracy * 100)}% (${zira} = Zira, ${david} = David).`,
        '',
        '```',
        ...transcript.segments.map((s) => `${(s.startMs / 1000).toFixed(1).padStart(6)}s ${(s.speaker ?? '-').padEnd(10)} ${s.text}`),
        '```',
        '',
      );
      expect(transcript.version.provider).toBe('sherpa-onnx');
      expect(accuracy).toBeGreaterThanOrEqual(0.9);
    }
  } finally {
    writeFileSync(join(reportDir, 'speakers.md'), report.join('\n'));
    await closeApp(app);
    removeDir(dataDir);
  }
});

const LONG = Number(process.env.LIVE_SPEAKERS_LONG ?? 0);

test('live: one voice keeps one label for a whole hour', async () => {
  test.skip(!LONG, 'Set LIVE_SPEAKERS_LONG=60 to run.');
  test.setTimeout(90 * 60_000);
  const keys = loadKeys();
  test.skip(!keys.GEMINI_API_KEY, 'Needs GEMINI_API_KEY to transcribe the hour quickly.');
  mkdirSync(reportDir, { recursive: true });
  const work = resolve('.live-cache/gemini-long');
  mkdirSync(join(work, 'audio'), { recursive: true });
  const audio = makeLongMeeting(join(work, 'audio'), LONG);
  const dataDir = tempDataDir();
  const report: string[] = [`# Offline speaker labels over ${LONG} minutes, ${new Date().toISOString()}`, ''];
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'gemini', transcriptionModel: null });
    await call(page, 'saveProviderKey', 'gemini', keys.GEMINI_API_KEY);
    await call(page, 'acceptConsent', 'gemini', 'audio');
    await call(page, 'importPaths', [audio.file], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 10 * 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;
    await call(page, 'requestTranscription', rec.id);
    const tJob = await waitJob(page, () => call(page, 'latestJob', rec.id, 'transcribe'), 60 * 60_000);
    expect(tJob.status, tJob.error ?? '').toBe('done');

    const { transcript, seconds } = await labelSpeakers(page, rec.id, 2);
    // "Session N. The topic is…" is always read by the same voice (David): one label all hour long?
    const announcements = audio.sessionStartsMs.flatMap((real, i) => {
      const re = new RegExp(`session\\s+(${i + 1}|${NUMBER_WORDS[i]})\\b`, 'i');
      const line = transcript.segments.find((s) => re.test(s.text) && Math.abs(s.startMs - real) < 5 * 60_000);
      return line ? [{ session: i + 1, speaker: line.speaker, atMs: line.startMs }] : [];
    });
    const labels = new Map<string, number>();
    for (const a of announcements) if (a.speaker) labels.set(a.speaker, (labels.get(a.speaker) ?? 0) + 1);
    const main = [...labels.entries()].sort((a, b) => b[1] - a[1])[0];
    const steady = main ? main[1] / announcements.length : 0;
    report.push(
      `Labelling ${LONG} minutes took ${(seconds / 60).toFixed(1)} minutes on this computer. Speakers found: ${new Set(transcript.segments.map((s) => s.speaker).filter(Boolean)).size}.`,
      `The announcer kept one label for ${main?.[1] ?? 0} of ${announcements.length} sessions (${Math.round(steady * 100)}%).`,
      '',
      ...announcements.map((a) => `- Session ${a.session} at ${(a.atMs / 60_000).toFixed(1)} min: ${a.speaker ?? '-'}`),
    );
    expect(steady).toBeGreaterThanOrEqual(0.9);
  } finally {
    writeFileSync(join(reportDir, `speakers-long-${LONG}.md`), report.join('\n'));
    await closeApp(app);
    removeDir(dataDir);
  }
});
