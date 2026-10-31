# AI pipeline

```text
Recorded, imported, dropped, opened, video ─▶ Ingestion ─▶ Library ─▶ Transcription ─▶ Transcript storage and search
                                                                                         │
                               Knowledge library ◀─ Output engine ◀─ AI processing ◀─────┘
                                                    (Phases 4 to 7)
```

Every source joins at ingestion, so nothing downstream depends on where audio came from.

## Transcription (working)

1. **Request.** `TranscriptionService.request` checks the privacy gate: offline only, key or address, consent.
2. **Plan.** `planChunks` splits audio at the quietest moment near each 10-minute limit, using stored waveform peaks.
3. **Encode.** The media worker writes each piece as 32 kbps mono Ogg/Opus, just before it is needed.
4. **Send.** The provider receives one piece at a time. The gate runs again first. Each finished piece is stored at once.
5. **Merge.** `mergeChunks` shifts timestamps onto the recording's timeline and saves an `original` version.
6. **Index.** The current version goes into `transcript_search`, so the Library can find it.

## What happens when something fails

| Failure | Behavior |
| --- | --- |
| HTTP 429, per-minute | Waits for `retry-after` (or a minute), explains, continues by itself |
| Daily or plan quota | Same, with a clear message and a longer default wait |
| Network or server error | Exponential backoff with jitter, up to 6 attempts, then Retry |
| Bad key or refused request | Stops at once with a clear message |
| App crash or quit | Resumes after the last finished piece on next launch |
| Speech not found | Fails with an explanation. No empty transcript is saved. |

## Summaries, chapters, suggestions (working)

All of these read the stored transcript, so changing a format never transcribes again.

1. **Prompt.** Each transcript line carries an id, such as `[S12 3:05]`. The system prompt requires citations, forbids invention, and declares the transcript to be data, not instructions.
2. **Long recordings.** `splitSegments` divides by characters. Notes on each piece are stored as they finish, and a final request writes the result from the notes.
3. **Check.** `resolveCitations` turns real ids into links and removes invented ones, recording how many.
4. **Display.** `parseMarkdown` builds data and `MarkdownView` builds elements. No HTML is ever injected.

Chapters and suggestions ask for JSON, validate it, and retry once if it cannot be read. HTTP 413 retries with smaller pieces. All jobs share `JobQueue`.

## Adding a provider

Implement `TranscriptionProvider` or `ChatProvider` in `desktop/src/main/ai/types.ts`, add its facts to `desktop/src/shared/providers.ts`, and connect it in `makeProvider` or `makeChatProvider` in `desktop/src/main/index.ts`. A service with an OpenAI-compatible API needs only its address and models.

## Planned

Documents (Phase 5), chat and retrieval (Phase 6), study tools and AI Studio (Phase 7).
