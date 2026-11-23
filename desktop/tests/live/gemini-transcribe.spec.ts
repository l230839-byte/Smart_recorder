// Live check of Gemini 3.5 Transcribe through the real app, on the generated two-voice meeting:
// facts heard, times from the audio, and whether the two voices are told apart. Groq Whisper on the
// same audio gives the comparison. Needs GEMINI_API_KEY (and GROQ_API_KEY for the comparison).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ImportJob, Recording, Transcript } from '../../src/shared/models';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from '../e2e/helpers';
import { call, loadKeys, waitJob } from './live-helpers';
import { makeLongMeeting, NUMBER_WORDS, SESSIONS } from './long-meeting';
import { FACTS, makeSpeech, SCRIPT } from './meeting';

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

async function transcribe(page: Page, recordingId: string, provider: 'gemini' | 'groq'): Promise<{ transcript: Transcript; seconds: number; error: string | null }> {
  await call(page, 'updateSettings', { transcriptionProvider: provider, transcriptionModel: null });
  const started = Date.now();
  await call(page, 'requestTranscription', recordingId);
  const job = await waitJob(page, () => call(page, 'latestJob', recordingId, 'transcribe'));
  return { transcript: (await call<Transcript>(page, 'getTranscript', recordingId))!, seconds: (Date.now() - started) / 1000, error: job.status === 'done' ? null : `${job.status}: ${job.error}` };
}

test('live: Gemini 3.5 Transcribe hears the facts, times every line and tells the two voices apart', async () => {
  test.setTimeout(15 * 60_000);
  const keys = loadKeys();
  test.skip(!keys.GEMINI_API_KEY, 'Add GEMINI_API_KEY to desktop/.env.live.');
  const reportDir = resolve('.live-cache/reports');
  mkdirSync(reportDir, { recursive: true });
  const dataDir = tempDataDir();
  const audio = makeSpeech(dataDir);
  const report: string[] = [`# Gemini transcription, live, ${new Date().toISOString()}`, ''];
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'updateSettings', { offlineOnly: false });
    await call(page, 'saveProviderKey', 'gemini', keys.GEMINI_API_KEY);
    await call(page, 'acceptConsent', 'gemini', 'audio');
    if (keys.GROQ_API_KEY) {
      await call(page, 'saveProviderKey', 'groq', keys.GROQ_API_KEY);
      await call(page, 'acceptConsent', 'groq', 'audio');
    }
    await call(page, 'importPaths', [audio], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;

    const runs: { provider: 'gemini' | 'groq'; facts: number; speakers: number; accuracy: number | null }[] = [];
    for (const provider of ['gemini', ...(keys.GROQ_API_KEY ? ['groq' as const] : [])] as const) {
      const { transcript, seconds, error } = await transcribe(page, rec.id, provider);
      report.push(`## ${provider} (${seconds.toFixed(1)} s)${error ? `: ${error}` : ''}`, '');
      expect(error, `${provider} transcription`).toBeNull();
      const segments = transcript.segments;
      const text = segments.map((s) => s.text).join(' ');
      const facts = FACTS.filter(([, re]) => re.test(text)).length;
      // Speaker accuracy: each voice should keep one label. Lines that match no script line are left out.
      const labelled = segments.map((s) => ({ voice: voiceOf(s.text), speaker: s.speaker })).filter((s) => s.voice && s.speaker);
      const labelFor = (voice: string) => {
        const counts = new Map<string, number>();
        for (const s of labelled.filter((l) => l.voice === voice)) counts.set(s.speaker!, (counts.get(s.speaker!) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      };
      const zira = labelFor('Zira');
      const david = labelFor('David');
      const right = labelled.filter((s) => s.speaker === (s.voice === 'Zira' ? zira : david)).length;
      const accuracy = labelled.length && zira !== david ? right / labelled.length : null;
      const speakers = new Set(segments.map((s) => s.speaker).filter(Boolean)).size;
      runs.push({ provider, facts, speakers, accuracy });
      const ordered = segments.every((s, i) => s.endMs >= s.startMs && (i === 0 || s.startMs >= segments[i - 1]!.startMs));
      report.push(
        `${segments.length} lines, ${speakers} speakers, times in order: ${ordered}. Facts heard: ${facts}/${FACTS.length}. Speaker accuracy: ${accuracy === null ? 'n/a' : `${Math.round(accuracy * 100)}%`} (${zira} = Zira, ${david} = David).`,
        '',
        '```',
        ...segments.map((s) => `${(s.startMs / 1000).toFixed(1).padStart(6)}s ${(s.speaker ?? '').padEnd(10)} ${s.text}`),
        '```',
        '',
      );
      expect(ordered).toBe(true);
    }
    writeFileSync(resolve(reportDir, 'gemini-transcribe.md'), report.join('\n'));
    const gemini = runs[0]!;
    expect(gemini.facts).toBeGreaterThanOrEqual(FACTS.length - 1);
    expect(gemini.speakers).toBeGreaterThanOrEqual(2);
    expect(gemini.accuracy ?? 0).toBeGreaterThanOrEqual(0.8);
  } finally {
    writeFileSync(resolve(reportDir, 'gemini-transcribe.md'), report.join('\n'));
    await closeApp(app);
    removeDir(dataDir);
  }
});

// A longer meeting in 25-minute pieces: the large inline requests, timing across pieces, and whether
// "Session N" (always read by David) keeps one speaker label within each piece.
const LONG_MINUTES = Number(process.env.LIVE_GEMINI_LONG_MINUTES ?? 0);

test('live: a long meeting on Gemini 3.5 Transcribe, in 25-minute pieces', async () => {
  test.skip(!LONG_MINUTES, 'Set LIVE_GEMINI_LONG_MINUTES (for example 60) to run.');
  test.setTimeout(3 * 3600_000);
  const keys = loadKeys();
  test.skip(!keys.GEMINI_API_KEY, 'Add GEMINI_API_KEY to desktop/.env.live.');
  const work = resolve('.live-cache/gemini-long');
  mkdirSync(join(work, 'audio'), { recursive: true });
  const audio = makeLongMeeting(join(work, 'audio'), LONG_MINUTES);
  const reportDir = resolve('.live-cache/reports');
  mkdirSync(reportDir, { recursive: true });
  const report: string[] = [`# Gemini transcription of a ${LONG_MINUTES}-minute meeting, ${new Date().toISOString()}`, ''];
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'gemini', transcriptionModel: null });
    await call(page, 'saveProviderKey', 'gemini', keys.GEMINI_API_KEY);
    await call(page, 'acceptConsent', 'gemini', 'audio');
    await call(page, 'importPaths', [audio.file], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 10 * 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;
    const started = Date.now();
    await call(page, 'requestTranscription', rec.id);
    const job = await waitJob(page, () => call(page, 'latestJob', rec.id, 'transcribe'), 2.5 * 3600_000, (j) => console.warn(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${j.status} | ${j.stage} | ${j.error ?? ''}`));
    report.push(`Transcription: ${job.status}${job.error ? ` (${job.error})` : ''} in ${((Date.now() - started) / 60_000).toFixed(1)} minutes.`, '');
    expect(job.status, job.error ?? '').toBe('done');
    const segs = (await call<Transcript>(page, 'getTranscript', rec.id))!.segments;
    const text = segs.map((s) => s.text).join(' ');
    const pieceOf = (ms: number) => Math.floor(ms / (25 * 60_000));
    const drifts: number[] = [];
    const announcers = new Map<number, Set<string>>();
    report.push('| Session | Real start | Transcript | Drift | Speaker | Fact |', '|---|---|---|---|---|---|');
    audio.sessionStartsMs.forEach((real, i) => {
      const re = new RegExp(`session\\s+(${i + 1}|${NUMBER_WORDS[i]})\\b`, 'i');
      const seg = segs.find((s) => re.test(s.text) && Math.abs(s.startMs - real) < 5 * 60_000);
      if (seg) {
        drifts.push(Math.abs(seg.startMs - real));
        if (seg.speaker) announcers.set(pieceOf(seg.startMs), (announcers.get(pieceOf(seg.startMs)) ?? new Set()).add(seg.speaker));
      }
      report.push(`| ${i + 1} | ${(real / 1000).toFixed(0)} s | ${seg ? `${(seg.startMs / 1000).toFixed(0)} s` : 'not found'} | ${seg ? `${((seg.startMs - real) / 1000).toFixed(1)} s` : '-'} | ${seg?.speaker ?? '-'} | ${SESSIONS[i]!.factPattern.test(text) ? 'yes' : 'NO'} |`);
    });
    const facts = audio.sessionStartsMs.filter((_, i) => SESSIONS[i]!.factPattern.test(text)).length;
    const steady = [...announcers.values()].filter((labels) => labels.size === 1).length;
    report.push('', `Sessions found: ${drifts.length} of ${audio.sessions}. Largest drift: ${drifts.length ? (Math.max(...drifts) / 1000).toFixed(1) : '-'} s. Facts: ${facts} of ${audio.sessions}. Pieces where the announcer kept one label: ${steady} of ${announcers.size}. Speakers in all: ${new Set(segs.map((s) => s.speaker).filter(Boolean)).size}.`);
    expect(drifts.length).toBeGreaterThanOrEqual(audio.sessions * 0.8);
    expect(Math.max(...drifts)).toBeLessThan(10_000);
    expect(facts).toBeGreaterThanOrEqual(audio.sessions * 0.8);
  } finally {
    writeFileSync(resolve(reportDir, `gemini-long-${LONG_MINUTES}.md`), report.join('\n'));
    await closeApp(app);
    removeDir(dataDir);
  }
});
