import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ChatDetail } from "../../src/shared/chat";
import type {
  CreateDocumentOutcome,
  DocumentExport,
  DocumentRecord,
  ImportJob,
  ProcessingJob,
  Recording,
  Summary,
  Transcript,
  UsageSummary,
} from "../../src/shared/models";
import {
  DEFAULT_STUDIO_OPTIONS,
  type StudioOutput,
  type Task,
} from "../../src/shared/studio";
import { DEFAULT_SUMMARY_OPTIONS } from "../../src/shared/summaries";
import { closeApp, completeOnboarding, launch } from "../e2e/helpers";
import { call, citedTimes, citeCount, loadKeys, waitJob } from "./live-helpers";
import {
  longQuestions,
  makeLongMeeting,
  SESSIONS,
  type LongAudio,
} from "./long-meeting";

/**
 * One- to three-hour recordings on the real services. Run with
 *   npm run test:live -- long.spec.ts            (LIVE_LONG_MINUTES=180 by default)
 * Stage 1 transcribes once with Groq and keeps the library in test-results/live-long; stage 2 runs every
 * text task on it, so text work can be repeated without spending the audio allowance again.
 */
const MINUTES = Number(process.env.LIVE_LONG_MINUTES ?? 180);
const PROVIDERS = (process.env.LIVE_LONG_PROVIDERS ?? "gemini,groq")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean) as ("gemini" | "groq")[];
/** Which text tasks stage 2 runs. Groq's free daily tokens do not cover every tool on three hours. */
const TASKS = new Set(
  (
    process.env.LIVE_LONG_TASKS ??
    "summary,chapters,title,minutes,quiz,tasks,chat"
  )
    .split(",")
    .map((t) => t.trim()),
);
// Outside test-results, which Playwright empties on every run: a transcribed 3-hour library costs
// hours of free-tier audio quota to rebuild.
const WORK = resolve(".live-cache/long");
const DATA = join(WORK, `data-${MINUTES}`);
const DONE = join(DATA, "transcribed.json");

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty.one",
  "twenty.two",
  "twenty.three",
  "twenty.four",
  "twenty.five",
  "twenty.six",
  "twenty.seven",
  "twenty.eight",
  "twenty.nine",
  "thirty",
];

function factsFound(text: string, sessions: number): number[] {
  return SESSIONS.slice(0, sessions).flatMap((s, i) =>
    s.factPattern.test(text) ? [i] : [],
  );
}

async function recordingOf(page: Page): Promise<Recording> {
  return (
    await call<Recording[]>(page, "listRecordings", {
      view: "all",
      sort: "newest",
    })
  )[0]!;
}

test.describe.configure({ mode: "serial" });

test("long stage 1: a long recording imports and transcribes on live Groq", async () => {
  const keys = loadKeys();
  test.skip(!keys.GROQ_API_KEY, "Add GROQ_API_KEY to desktop/.env.live.");
  test.skip(
    existsSync(DONE),
    "Already transcribed; delete test-results/live-long to start again.",
  );
  test.setTimeout(6 * 3600_000);

  mkdirSync(join(WORK, "audio"), { recursive: true });
  let started = Date.now();
  const audio = makeLongMeeting(join(WORK, "audio"), MINUTES);
  const report: string[] = [
    `# Long recording, stage 1: ${new Date().toISOString()}`,
    "",
    `Audio: ${clock(audio.durationMs)} of generated meeting, ${audio.sessions} sessions, AAC .m4a (made in ${((Date.now() - started) / 1000).toFixed(0)} s or cached).`,
    "",
  ];
  const write = () =>
    writeFileSync(
      join(WORK, `stage1-${MINUTES}.md`),
      report.join("\n"),
      "utf8",
    );

  // A library left by an interrupted run is reopened: EchoMind must carry on from the parts it finished.
  const resuming = existsSync(join(DATA, "echomind.db"));
  if (!resuming) {
    rmSync(DATA, { recursive: true, force: true });
    mkdirSync(DATA, { recursive: true });
  }
  const launched = await launch(DATA);
  const app = launched.app;
  let page = launched.page;
  // If the test loses its connection to the window, find the window again and note what happened.
  const live = async <T>(run: (p: Page) => Promise<T>): Promise<T> => {
    try {
      return await run(page);
    } catch (e) {
      if (!(e instanceof Error) || !/closed|crashed|destroyed/i.test(e.message))
        throw e;
      const windows = app.windows();
      report.push(
        `> Lost the page (${e.message.split("\n")[0]}). Windows now: ${windows.map((w) => w.url().split("/").pop()).join(", ") || "none"}.`,
        "",
      );
      const main = windows.find((w) => !w.url().endsWith("media.html"));
      if (!main) throw e;
      page = main;
      return run(page);
    }
  };
  try {
    let rec: Recording;
    if (resuming) {
      await page.getByRole("navigation", { name: "Main" }).waitFor();
      rec = await recordingOf(page);
      report.push(
        `## Reopened an interrupted run: ${rec.title}, ${clock(rec.durationMs)}.`,
        "",
      );
    } else {
      await completeOnboarding(page);
      await call(page, "updateSettings", {
        offlineOnly: false,
        transcriptionProvider: "groq",
        llmProvider: "groq",
      });
      await call(page, "saveProviderKey", "groq", keys.GROQ_API_KEY);
      await call(page, "acceptConsent", "groq", "audio");

      started = Date.now();
      await call(page, "importPaths", [audio.file], "meeting");
      await expect
        .poll(
          async () => (await call<ImportJob[]>(page, "listImports"))[0]?.status,
          { timeout: 20 * 60_000, intervals: [1000, 2000, 5000] },
        )
        .toBe("done");
      rec = await recordingOf(page);
      report.push(
        `## Import: ${((Date.now() - started) / 1000).toFixed(1)} s. Duration read: ${clock(rec.durationMs)} (generated ${clock(audio.durationMs)}). Stored as ${rec.format} ${rec.codec}, ${(rec.sizeBytes / 1e6).toFixed(1)} MB.`,
        "",
      );
      write();
    }

    started = Date.now();
    const log: string[] = [];
    if (await call<Transcript | null>(page, "getTranscript", rec.id)) {
      // Finished while the test was not watching: check it, never transcribe it again.
      log.push("- The transcription finished in the interrupted run.");
    } else {
      // Starts the job, or returns the one already queued or running.
      await call(page, "requestTranscription", rec.id);
    }
    const job = await waitJob(
      page,
      () =>
        live((p) =>
          call<ProcessingJob | null>(p, "latestJob", rec.id, "transcribe"),
        ),
      5 * 3600_000,
      (j) => {
        const wait = j.nextAttemptAt
          ? ` (next try in ${Math.round((j.nextAttemptAt - Date.now()) / 1000)} s)`
          : "";
        log.push(
          `- ${clock(Date.now() - started)} ${j.status}: ${j.stage}${j.error ? ` | ${j.error}` : ""}${wait}`,
        );
        writeFileSync(
          join(WORK, `stage1-${MINUTES}.md`),
          [...report, "## Transcription (running)", "", ...log].join("\n"),
          "utf8",
        );
      },
    );
    report.push(
      `## Transcription: ${job.status} after ${clock(Date.now() - started)}${job.error ? ` (${job.error})` : ""}`,
      "",
      ...log,
      "",
    );
    expect(job.status, job.error ?? "").toBe("done");

    const transcript = (await call<Transcript>(page, "getTranscript", rec.id))!;
    const segs = transcript.segments;
    const text = segs.map((s) => s.text).join(" ");
    const last = segs.at(-1)!;
    let gaps = 0;
    let repeats = 0;
    for (let i = 1; i < segs.length; i++) {
      if (segs[i]!.startMs - segs[i - 1]!.endMs > 15_000) gaps++;
      if (
        segs[i]!.text.trim() &&
        segs[i]!.text.trim() === segs[i - 1]!.text.trim()
      )
        repeats++;
    }
    report.push(
      `${segs.length} segments, ${text.length.toLocaleString()} characters. Last segment ends at ${clock(last.endMs)} of ${clock(rec.durationMs)}. Gaps over 15 s: ${gaps}. Lines repeated back to back: ${repeats}.`,
      "",
    );

    // Timestamps: where each "Session N" announcement landed, against where it really is.
    report.push(
      "| Session | Real start | Transcript | Drift | Fact in transcript |",
      "|---|---|---|---|---|",
    );
    const drifts: number[] = [];
    audio.sessionStartsMs.forEach((real, i) => {
      const re = new RegExp(`session\\s+(${i + 1}|${NUMBER_WORDS[i]})\\b`, "i");
      const seg = segs.find(
        (s) => re.test(s.text) && Math.abs(s.startMs - real) < 5 * 60_000,
      );
      const drift = seg ? seg.startMs - real : null;
      if (drift !== null) drifts.push(Math.abs(drift));
      report.push(
        `| ${i + 1} ${SESSIONS[i]!.topic} | ${clock(real)} | ${seg ? clock(seg.startMs) : "not found"} | ${drift === null ? "-" : `${(drift / 1000).toFixed(1)} s`} | ${SESSIONS[i]!.factPattern.test(text) ? "yes" : "NO"} |`,
      );
    });
    const facts = factsFound(text, audio.sessions);
    report.push(
      "",
      `Session starts found: ${drifts.length} of ${audio.sessions}. Largest drift: ${drifts.length ? (Math.max(...drifts) / 1000).toFixed(1) : "-"} s. Facts in transcript: ${facts.length} of ${audio.sessions}.`,
      "",
    );
    const usage = await call<UsageSummary[]>(page, "getUsage");
    report.push("## Usage", "", "```", JSON.stringify(usage, null, 2), "```");
    expect(drifts.length).toBeGreaterThan(audio.sessions * 0.8);
    expect(Math.max(...drifts)).toBeLessThan(10_000);
    writeFileSync(
      DONE,
      JSON.stringify({ recordingId: rec.id, audio } satisfies {
        recordingId: string;
        audio: LongAudio;
      }),
      "utf8",
    );
  } finally {
    write();
    await closeApp(app);
  }
});

test("long stage 2: every text task on the long transcript", async () => {
  const keys = loadKeys();
  test.skip(!existsSync(DONE), "Run stage 1 first.");
  test.setTimeout(4 * 3600_000);
  const { recordingId, audio } = JSON.parse(readFileSync(DONE, "utf8")) as {
    recordingId: string;
    audio: LongAudio;
  };
  const report: string[] = [
    `# Long recording, stage 2: ${new Date().toISOString()}`,
    "",
    `Transcript of ${clock(audio.durationMs)}, ${audio.sessions} sessions. Providers: ${PROVIDERS.join(", ")}.`,
    "",
  ];
  const write = () =>
    writeFileSync(
      join(WORK, `stage2-${MINUTES}-${PROVIDERS.join("-")}.md`),
      report.join("\n"),
      "utf8",
    );
  const spread = (times: number[]) =>
    times.length
      ? `cited times run from ${clock(Math.min(...times))} to ${clock(Math.max(...times))}; sessions with a citation: ${new Set(times.map((t) => audio.sessionStartsMs.findLastIndex((s) => s <= t))).size} of ${audio.sessions}`
      : "no citations";
  const JOB_TIMEOUT = 90 * 60_000;

  const { app, page } = await launch(DATA);
  try {
    await page.getByRole("navigation", { name: "Main" }).waitFor();
    const transcript = (await call<Transcript>(
      page,
      "getTranscript",
      recordingId,
    ))!;
    report.push(
      `${transcript.segments.length} segments, ${transcript.segments.reduce((n, s) => n + s.text.length, 0).toLocaleString()} characters.`,
      "",
    );

    for (const provider of PROVIDERS) {
      const key =
        provider === "gemini" ? keys.GEMINI_API_KEY : keys.GROQ_API_KEY;
      if (!key) {
        report.push(`## ${provider}: skipped (no key)`, "");
        continue;
      }
      await call(page, "saveProviderKey", provider, key);
      await call(page, "acceptConsent", provider, "text");
      await call(page, "updateSettings", { llmProvider: provider });
      const label = provider === "gemini" ? "Gemini" : "Groq";
      const timed = async <T>(
        task: string,
        name: string,
        run: () => Promise<{ job: ProcessingJob; result: T }>,
        describe: (result: T) => string[],
      ) => {
        if (!TASKS.has(task)) return;
        const started = Date.now();
        try {
          const { job, result } = await run();
          report.push(
            `## ${label}: ${name}: ${job.status} in ${clock(Date.now() - started)}${job.error ? ` (${job.error})` : ""}`,
            "",
            ...(job.status === "done" ? describe(result) : []),
            "",
          );
        } catch (e) {
          report.push(
            `## ${label}: ${name}: ERROR after ${clock(Date.now() - started)}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
            "",
          );
        }
        write();
      };
      const watch = (log: string[]) => (j: ProcessingJob) =>
        log.push(`- ${j.status}: ${j.stage}${j.error ? ` | ${j.error}` : ""}`);

      // Summary
      await timed(
        "summary",
        "structured summary",
        async () => {
          await call(page, "requestSummary", recordingId, {
            ...DEFAULT_SUMMARY_OPTIONS,
            format: "structured",
            length: "detailed",
          });
          const log: string[] = [];
          const job = await waitJob(
            page,
            () => call(page, "latestJob", recordingId, "summarize"),
            JOB_TIMEOUT,
            watch(log),
          );
          return {
            job,
            result: {
              summary: (
                await call<Summary[]>(page, "listSummaries", recordingId)
              )[0],
              log,
            },
          };
        },
        ({ summary, log }) => {
          if (!summary) return ["(no summary saved)"];
          const found = factsFound(summary.markdown, audio.sessions);
          return [
            ...log.slice(-12),
            "",
            `Model ${summary.model}. ${summary.markdown.length.toLocaleString()} characters. Citations kept: ${citeCount(summary.markdown)}, invented removed: ${summary.droppedCitations}, cut off: ${summary.truncated}. Session facts in it: ${found.length} of ${audio.sessions} (${found.map((i) => i + 1).join(", ")}). ${spread(citedTimes(summary.markdown))}.`,
            "",
            summary.markdown,
          ];
        },
      );

      // Chapters against the real session starts
      await timed(
        "chapters",
        "chapters",
        async () => {
          await call(page, "requestChapters", recordingId);
          const job = await waitJob(
            page,
            () => call(page, "latestJob", recordingId, "chapters"),
            JOB_TIMEOUT,
          );
          return {
            job,
            result: await call<{ title: string; startMs: number }[]>(
              page,
              "listChapters",
              recordingId,
            ),
          };
        },
        (chapters) => {
          const near = audio.sessionStartsMs.filter((s) =>
            chapters.some((c) => Math.abs(c.startMs - s) <= 30_000),
          ).length;
          return [
            `${chapters.length} chapters; real session starts with a chapter within 30 s: ${near} of ${audio.sessions}.`,
            "",
            ...chapters.map((c) => `- ${clock(c.startMs)} ${c.title}`),
          ];
        },
      );

      await timed(
        "title",
        "title and tags",
        async () => {
          await call(page, "requestSuggestions", recordingId);
          const job = await waitJob(
            page,
            () => call(page, "latestJob", recordingId, "suggest"),
            JOB_TIMEOUT,
          );
          return {
            job,
            result: await call<{ title: string; tags: string[] } | null>(
              page,
              "getSuggestions",
              recordingId,
            ),
          };
        },
        (s) => [s ? `${s.title} | ${s.tags.join(", ")}` : "(none)"],
      );

      await timed(
        "minutes",
        "meeting minutes document",
        async () => {
          const created = await call<CreateDocumentOutcome>(
            page,
            "createDocument",
            { recordingId, template: "meeting-minutes", source: "ai" },
          );
          if (!created.ok) throw new Error(`refused: ${created.reason}`);
          const job = await waitJob(
            page,
            () => call(page, "documentJob", created.documentId),
            JOB_TIMEOUT,
          );
          const doc = (await call<DocumentRecord>(
            page,
            "getDocument",
            created.documentId,
          ))!;
          let exported = "";
          if (job.status === "done") {
            const t = Date.now();
            const pdf = await call<DocumentExport>(
              page,
              "exportDocument",
              created.documentId,
              "pdf",
            );
            const docx = await call<DocumentExport>(
              page,
              "exportDocument",
              created.documentId,
              "docx",
            );
            exported = `PDF ${(pdf.sizeBytes / 1024).toFixed(0)} KB and DOCX ${(docx.sizeBytes / 1024).toFixed(0)} KB exported in ${((Date.now() - t) / 1000).toFixed(1)} s.`;
          }
          return { job, result: { doc, exported } };
        },
        ({ doc, exported }) => [
          `${exported} ${doc.markdown.length.toLocaleString()} characters. Citations: ${citeCount(doc.markdown)}, removed: ${doc.droppedCitations}. Session facts: ${factsFound(doc.markdown, audio.sessions).length} of ${audio.sessions}. ${spread(citedTimes(doc.markdown))}.`,
          "",
          doc.markdown.slice(0, 6000),
          doc.markdown.length > 6000 ? "\n[…]" : "",
        ],
      );

      for (const kind of ["quiz", "tasks"] as const) {
        await timed(
          kind,
          kind,
          async () => {
            const out = await call<{
              ok: boolean;
              outputId?: string;
              reason?: string;
            }>(page, "startStudio", {
              kind,
              recordingIds: [recordingId],
              options: {
                ...DEFAULT_STUDIO_OPTIONS,
                count: 12,
                questionTypes: ["mcq", "tf", "short"],
              },
            });
            if (!out.ok) throw new Error(`refused: ${out.reason}`);
            const job = await waitJob(
              page,
              () => call(page, "studioJob", out.outputId),
              JOB_TIMEOUT,
            );
            return {
              job,
              result: await call<StudioOutput>(page, "getStudio", out.outputId),
            };
          },
          (result) => {
            if (result.content?.type === "quiz") {
              const times = result.content.questions.flatMap((q) =>
                q.source ? [q.source.startMs] : [],
              );
              return [
                `${result.content.questions.length} questions, invented sources removed: ${result.droppedCitations}. ${spread(times)}.`,
                "",
                ...result.content.questions.map(
                  (q, i) =>
                    `${i + 1}. [${q.type}] ${q.question} | Answer: ${q.answer}${q.source ? ` (at ${clock(q.source.startMs)})` : " (no source)"}`,
                ),
              ];
            }
            return [];
          },
        );
      }
      if (TASKS.has("tasks")) {
        const tasks = await call<Task[]>(page, "listTasks", {
          status: "suggested",
        });
        const owners = new Set(tasks.map((t) => t.owner.toLowerCase()));
        const expected = SESSIONS.slice(0, audio.sessions).map(
          (s) => s.actionOwner,
        );
        report.push(
          `Action items: ${tasks.length}. Session owners found: ${expected.filter((o) => owners.has(o.toLowerCase())).length} of ${audio.sessions}.`,
          "",
          ...tasks.map(
            (t) =>
              `- ${t.title} | due ${t.dueDate ?? (t.dueText || "-")} | owner ${t.owner || "-"}`,
          ),
          "",
        );
        for (const t of tasks)
          await call(page, "updateTask", t.id, { status: "dismissed" });
        write();
      }

      // Chat: answers at the start, middle and end, and one that is not there.
      if (!TASKS.has("chat")) continue;
      const thread = await call<string>(page, "startChat", {
        kind: "recordings",
        recordingIds: [recordingId],
      });
      report.push(`## ${label}: chat`, "");
      for (const q of longQuestions(audio.sessions)) {
        const started = Date.now();
        await call(page, "askChat", thread, q.question);
        await expect
          .poll(
            async () =>
              (await call<ChatDetail>(page, "getChat", thread)).turns.at(-1)
                ?.status,
            { timeout: 30 * 60_000, intervals: [1000, 2000] },
          )
          .not.toBe("pending");
        const a = (await call<ChatDetail>(page, "getChat", thread)).turns.at(
          -1,
        )!;
        const verdict = q.pattern
          ? q.pattern.test(a.content)
            ? "CORRECT"
            : "WRONG"
          : a.found === "no"
            ? "CORRECT (not found)"
            : "CHECK";
        report.push(
          `**Q (${q.session === null ? "absent" : `session ${q.session + 1}, at ${clock(audio.sessionStartsMs[q.session]!)}`}): ${q.question}** ${verdict} (${((Date.now() - started) / 1000).toFixed(1)} s, found: ${a.found ?? "-"}, sources: ${a.sources.length})`,
          "",
          a.status === "failed" ? `FAILED: ${a.error}` : a.content,
          a.general ? `\n_General knowledge:_ ${a.general}` : "",
          "",
        );
        write();
      }
    }
    const usage = await call<UsageSummary[]>(page, "getUsage");
    report.push("## Usage", "", "```", JSON.stringify(usage, null, 2), "```");
  } finally {
    write();
    await closeApp(app);
  }
});
