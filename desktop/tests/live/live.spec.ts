import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ChatDetail } from '../../src/shared/chat';
import type { CreateDocumentOutcome, DocumentExport, DocumentRecord, ImportJob, ProcessingJob, Recording, Summary, Transcript, UsageSummary } from '../../src/shared/models';
import { DEFAULT_STUDIO_OPTIONS, type StudioOutput, type Task } from '../../src/shared/studio';
import { DEFAULT_SUMMARY_OPTIONS } from '../../src/shared/summaries';
import { closeApp, completeOnboarding, launch, removeDir, tempDataDir } from '../e2e/helpers';
import { FACTS, makeSpeech, QUESTIONS } from './meeting';

function loadKeys(): Record<string, string> {
  const file = resolve('.env.live');
  if (!existsSync(file)) return {};
  const keys: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) keys[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return keys;
}

function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

async function waitJob(page: Page, load: () => Promise<ProcessingJob | null>): Promise<ProcessingJob> {
  let job: ProcessingJob | null = null;
  await expect
    .poll(
      async () => {
        job = await load();
        return job && ['done', 'failed', 'canceled'].includes(job.status) ? job.status : 'running';
      },
      { timeout: 6 * 60_000, intervals: [1000, 2000, 3000] },
    )
    .not.toBe('running');
  return job!;
}

const factCheck = (text: string) => FACTS.map(([name, re]) => `${re.test(text) ? '[x]' : '[ ]'} ${name}`).join('\n');
const citeCount = (md: string) => (md.match(/\(cite:/g) ?? []).length;

test('live: real transcription, summary, chapters, document and chat, judged against known facts', async () => {
  const keys = loadKeys();
  test.skip(!keys.GROQ_API_KEY, 'Add GROQ_API_KEY to desktop/.env.live to run against live Groq (and GEMINI_API_KEY for Gemini).');

  const reportDir = resolve('test-results/live');
  mkdirSync(reportDir, { recursive: true });
  const dataDir = tempDataDir();
  const audio = makeSpeech(dataDir);
  const report: string[] = [`# EchoMind live run, ${new Date().toISOString()}`, '', 'Audio: generated two-voice meeting (Windows David and Zira), 16 kHz mono WAV.', ''];
  const { app, page } = await launch(dataDir);
  try {
    await completeOnboarding(page);
    // Starts on a model Groq has retired, to prove EchoMind switches to one it still offers by itself.
    await call(page, 'updateSettings', { offlineOnly: false, transcriptionProvider: 'groq', llmProvider: 'groq', llmModel: 'llama-3.3-70b-versatile' });
    await call(page, 'saveProviderKey', 'groq', keys.GROQ_API_KEY);
    await call(page, 'acceptConsent', 'groq', 'audio');
    await call(page, 'acceptConsent', 'groq', 'text');

    await call(page, 'importPaths', [audio], 'meeting');
    await expect.poll(async () => (await call<ImportJob[]>(page, 'listImports'))[0]?.status, { timeout: 60_000 }).toBe('done');
    const rec = (await call<Recording[]>(page, 'listRecordings', { view: 'all', sort: 'newest' }))[0]!;

    // Transcription
    let started = Date.now();
    await call(page, 'requestTranscription', rec.id);
    const tJob = await waitJob(page, () => call(page, 'latestJob', rec.id, 'transcribe'));
    report.push(`## Groq transcription (${((Date.now() - started) / 1000).toFixed(1)} s): ${tJob.status}${tJob.error ? ` (${tJob.error})` : ''}`, '');
    expect(tJob.status, tJob.error ?? '').toBe('done');
    const transcript = (await call<Transcript>(page, 'getTranscript', rec.id))!;
    const text = transcript.segments.map((s) => s.text).join(' ');
    report.push(`Language detected: ${transcript.version.language}. ${transcript.segments.length} segments.`, '', '```', ...transcript.segments.map((s) => `${(s.startMs / 1000).toFixed(1)}s  ${s.text}`), '```', '', 'Facts present in the transcript:', factCheck(text), '');

    const runText = async (label: string) => {
      // Summary
      started = Date.now();
      await call(page, 'requestSummary', rec.id, { ...DEFAULT_SUMMARY_OPTIONS, format: 'structured' });
      const sJob = await waitJob(page, () => call(page, 'latestJob', rec.id, 'summarize'));
      const summary = (await call<Summary[]>(page, 'listSummaries', rec.id))[0];
      report.push(`## ${label}: structured summary (${((Date.now() - started) / 1000).toFixed(1)} s): ${sJob.status}${sJob.error ? ` (${sJob.error})` : ''}`, '');
      if (summary && sJob.status === 'done') {
        report.push(`Model ${summary.model}. Citations kept: ${citeCount(summary.markdown)}. Invented citations removed: ${summary.droppedCitations}. Cut off: ${summary.truncated}.`, '', summary.markdown, '', 'Facts present:', factCheck(summary.markdown), '');
      }

      // Chapters and suggestions
      await call(page, 'requestChapters', rec.id);
      const cJob = await waitJob(page, () => call(page, 'latestJob', rec.id, 'chapters'));
      const chapters = await call<{ title: string; startMs: number }[]>(page, 'listChapters', rec.id);
      report.push(`## ${label}: chapters: ${cJob.status}${cJob.error ? ` (${cJob.error})` : ''}`, '', ...chapters.map((c) => `- ${(c.startMs / 1000).toFixed(0)}s ${c.title}`), '');
      await call(page, 'requestSuggestions', rec.id);
      const gJob = await waitJob(page, () => call(page, 'latestJob', rec.id, 'suggest'));
      const suggestions = await call<{ title: string; tags: string[] } | null>(page, 'getSuggestions', rec.id);
      report.push(`## ${label}: suggested title and tags: ${gJob.status}${gJob.error ? ` (${gJob.error})` : ''}`, '', suggestions ? `${suggestions.title} | ${suggestions.tags.join(', ')}` : '(none)', '');

      // AI document: meeting minutes, exported
      started = Date.now();
      const created = await call<CreateDocumentOutcome>(page, 'createDocument', { recordingId: rec.id, template: 'meeting-minutes', source: 'ai' });
      if (created.ok) {
        const dJob = await waitJob(page, () => call(page, 'documentJob', created.documentId));
        const doc = (await call<DocumentRecord>(page, 'getDocument', created.documentId))!;
        report.push(`## ${label}: meeting minutes document (${((Date.now() - started) / 1000).toFixed(1)} s): ${dJob.status}${dJob.error ? ` (${dJob.error})` : ''}`, '');
        if (dJob.status === 'done') {
          const pdf = await call<DocumentExport>(page, 'exportDocument', created.documentId, 'pdf');
          const docx = await call<DocumentExport>(page, 'exportDocument', created.documentId, 'docx');
          report.push(`Exported PDF ${pdf.sizeBytes} bytes and DOCX ${docx.sizeBytes} bytes. Citations: ${citeCount(doc.markdown)}, removed: ${doc.droppedCitations}.`, '', doc.markdown, '', 'Facts present:', factCheck(doc.markdown), '');
        }
      } else {
        report.push(`## ${label}: document refused: ${created.reason}`, '');
      }

      // AI Studio: a quiz and action items, judged against the same facts.
      for (const kind of ['quiz', 'tasks'] as const) {
        started = Date.now();
        const out = await call<{ ok: boolean; outputId?: string; reason?: string }>(page, 'startStudio', { kind, recordingIds: [rec.id], options: { ...DEFAULT_STUDIO_OPTIONS, count: 6, questionTypes: ['mcq', 'tf', 'short'] } });
        if (!out.ok) {
          report.push(`## ${label}: ${kind} refused: ${out.reason}`, '');
          continue;
        }
        const job = await waitJob(page, () => call(page, 'studioJob', out.outputId));
        const result = await call<StudioOutput>(page, 'getStudio', out.outputId);
        report.push(`## ${label}: ${kind} (${((Date.now() - started) / 1000).toFixed(1)} s): ${job.status}${job.error ? ` (${job.error})` : ''}`, '');
        if (result.content?.type === 'quiz') {
          report.push(
            `Invented sources removed: ${result.droppedCitations}.`,
            '',
            ...result.content.questions.map((q, i) => `${i + 1}. [${q.type}] ${q.question}${q.options.length ? ` | ${q.options.join(' / ')}` : ''}\n   Answer: ${q.answer}${q.source ? ` (at ${(q.source.startMs / 1000).toFixed(0)}s)` : ' (no source)'}${q.explanationSupplemental ? ' [AI explanation]' : ''}`),
            '',
          );
        }
      }
      const found = await call<Task[]>(page, 'listTasks', { status: 'suggested' });
      report.push(`Action items found (${found.length}):`, '', ...found.map((t) => `- ${t.title} | due ${t.dueDate ?? t.dueText ?? '-'} | owner ${t.owner || '-'} | "${t.sourceText}"`), '', 'Facts present in the action items:', factCheck(found.map((t) => `${t.title} ${t.owner} ${t.dueText}`).join('. ')), '');
      // Dismissed, so the second provider's run finds them fresh.
      for (const t of found) await call(page, 'updateTask', t.id, { status: 'dismissed' });

      // Chat
      const thread = await call<string>(page, 'startChat', { kind: 'recordings', recordingIds: [rec.id] });
      report.push(`## ${label}: chat`, '');
      for (const q of QUESTIONS) {
        started = Date.now();
        await call(page, 'askChat', thread, q);
        await expect.poll(async () => (await call<ChatDetail>(page, 'getChat', thread)).turns.at(-1)?.status, { timeout: 3 * 60_000, intervals: [1000] }).not.toBe('pending');
        const a = (await call<ChatDetail>(page, 'getChat', thread)).turns.at(-1)!;
        report.push(`**Q: ${q}** (${((Date.now() - started) / 1000).toFixed(1)} s, found: ${a.found ?? '-'}, sources: ${a.sources.length}, removed citations: ${a.droppedCitations})`, '', a.status === 'failed' ? `FAILED: ${a.error}` : a.content, a.general ? `\n_General knowledge:_ ${a.general}` : '', '');
      }
    };

    await runText('Groq');
    if (keys.GEMINI_API_KEY) {
      await call(page, 'saveProviderKey', 'gemini', keys.GEMINI_API_KEY);
      await call(page, 'acceptConsent', 'gemini', 'text');
      await call(page, 'updateSettings', { llmProvider: 'gemini' });
      await runText('Gemini');
    } else {
      report.push('## Gemini: skipped (no GEMINI_API_KEY in .env.live)', '');
    }

    report.push(`## Model in use at the end: ${(await call<{ llmModel: string | null }>(page, 'getSettings')).llmModel} (started on the retired llama-3.3-70b-versatile)`, '');
    const usage = await call<UsageSummary[]>(page, 'getUsage');
    report.push('## Usage', '', '```', JSON.stringify(usage, null, 2), '```');
  } finally {
    writeFileSync(join(reportDir, 'live-report.md'), report.join('\n'), 'utf8');
    await closeApp(app);
    removeDir(dataDir);
  }
});
