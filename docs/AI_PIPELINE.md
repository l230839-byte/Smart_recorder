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

## Documents

An AI document is a `document` job on the same queue and pipeline as summaries: the same transcript, ids, citation checks, splitting and retries. The template supplies length, tone and instructions, and the person can add their own. Nothing is created if the request would be refused (offline only, no key, no consent), so there are never empty documents. The result is kept as the document's first version. Documents from the transcript, a summary or a blank page use no AI at all.

## Chat

Chat answers straight away rather than through the job queue, so a question never waits behind a long transcription. It uses the same provider, offline, key and consent checks.

1. **Scope.** The chosen recordings, a collection with its sub-collections, or the whole library, never including the trash.
2. **What to read.** If every transcript in scope fits the provider's budget (capped at 48,000 characters), all of it is read, which grounds answers best and makes "not mentioned" meaningful. Otherwise a short JSON plan from the model turns the question and recent turns into keyword searches (including other languages), a time range, or a request for an overview. Each search runs BM25 over `transcript_chunks`; results are merged by reciprocal rank fusion, the best passage of each recording first. Time ranges and overviews take an even selection of lines.
3. **Answer.** Lines are numbered S1, S2… across recordings. The model replies in JSON: the answer with citations, whether the recordings answered it ("yes", "partly", "no"), and any general knowledge, separately. One retry if the JSON is unreadable; plain text is accepted only if it is not broken JSON.
4. **Checks.** Citations are resolved against the exact lines sent and become links to that recording and moment. Unknown ids are removed and counted. A short rate limit (20 seconds or less) is waited out once; longer ones fail with when to try again.

Keyword retrieval cannot match a paraphrase with no shared words. The plan step reduces this by adding likely words and translations. There are no embeddings yet.

## Adding a provider

Implement `TranscriptionProvider` or `ChatProvider` in `desktop/src/main/ai/types.ts`, add its facts to `desktop/src/shared/providers.ts`, and connect it in `makeProvider` or `makeChatProvider` in `desktop/src/main/index.ts`. A service with an OpenAI-compatible API needs only its address and models.

## Planned

Study tools and the rest of AI Studio (Phase 7). Optional local semantic search (embeddings) is a candidate add-on.
