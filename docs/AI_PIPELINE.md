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

### Offline transcription

The "On this computer" provider runs whisper.cpp's `whisper-cli` on each piece, which the media worker writes as 16 kHz mono 16-bit WAV (`pieceFormat: 'wav16k'`) instead of Opus. Arguments: the chosen model, `-l auto` unless a language is set (whisper.cpp's own default is English), all but one CPU core (at most 8), and JSON output, which `parseWhisperCppJson` reads (offsets in milliseconds; non-speech tags such as `[BLANK_AUDIO]` are dropped). Cancelling kills the process. Because it is `local`, the privacy gate asks for no key, consent or network, and Offline only does not block it; instead the gate waits until the chosen model is on disk. Models download through `LocalModelStore`: resumable with HTTP Range, written to a `.part` file, and renamed only after the SHA-256 matches.

### Gemini transcription

Gemini 3.5 Transcribe is reached through the Gemini API's Interactions endpoint (`/v1beta/interactions`), with each piece sent inline as Ogg/Opus and `transcription_config.mode` asking for verbatim text, speaker diarization and word timestamps. `parseGeminiTranscript` builds lines from the words: a new line at a change of speaker, at a sentence end after a pause of 0.7 s or more, at any sentence end past 20 s, and in any case past 40 s. Times are clamped to the piece. Speakers become "Speaker A", "Speaker B"… Gemini's labels restart with every request, so Gemini gets 25-minute pieces (`maxChunkMs`) instead of the usual 10. Silence returns no text and is reported as "speech not found", as for Whisper.

## What happens when something fails

| Failure | Behavior |
| --- | --- |
| HTTP 429, per-minute | Waits for `retry-after` (or a minute), explains, continues by itself |
| Daily or plan quota | Same, with a clear message and a longer default wait |
| Network or server error | Exponential backoff with jitter, up to 6 failures in a row, then Retry. Each finished piece resets the count, so a long recording on a flaky connection keeps going. |
| Bad key or refused request | Stops at once with a clear message |
| Model overloaded ("high demand", HTTP 503) | The request is tried on the provider's other models in EchoMind's list, without changing Settings; if all are busy, the queue waits and retries |
| Stalled connection | Every request has a time limit (5 minutes; 20 for a chat model and 30 for a Whisper server on your own computer), then counts as a network error |
| App crash or quit | Resumes after the last finished piece on next launch (checked live: a 3-hour job killed in part 14 finished parts 14 to 19 after reopening) |
| Window crash | The window's page is reloaded and says so; jobs keep running in the main process. Starts, quits and crashes are written to `logs/echomind.log` in the data folder, with paths and keys removed. |
| Speech not found | Fails with an explanation. No empty transcript is saved. |

## Summaries, chapters, suggestions (working)

All of these read the stored transcript, so changing a format never transcribes again.

1. **Prompt.** Each transcript line carries an id, such as `[S12 3:05]`. The system prompt requires citations, forbids invention, and declares the transcript to be data, not instructions.
2. **Long recordings.** `splitSegments` divides by characters. Notes on each piece are stored as they finish. If the notes are still too large for one request (a 3-hour recording on Groq makes about 16 sets), `reduceNotes` merges neighbours in rounds until they fit, saving each merge so a rate-limit pause never pays for it twice. A final request writes the result from the notes.
3. **Check.** `resolveCitations` turns real ids into links and removes invented ones, recording how many.
4. **Display.** `parseMarkdown` builds data and `MarkdownView` builds elements. No HTML is ever injected.

Models that reason before answering (Groq's gpt-oss, Gemini 2.5 and later) are asked for low reasoning effort (`reasoningOptions` in `shared/providers.ts`), because their hidden reasoning comes out of the same length limit as the answer. If a reply is still all reasoning and no text, it is asked for once more with twice the room, then treated as a server error the queue retries. Notes on each piece may use 2,000 tokens; 1,500 cut dense pieces off mid-sentence.

Chapters and suggestions ask for JSON, validate it, and retry once if it cannot be read; a reply Groq itself refuses as invalid JSON is asked for once more, then treated as a server error the queue retries. Titles for long recordings read lines spread across the whole recording, not just its start. HTTP 413 retries with smaller pieces. All jobs share `JobQueue`.

## Documents

An AI document is a `document` job on the same queue and pipeline as summaries: the same transcript, ids, citation checks, splitting and retries. The template supplies length, tone and instructions, and the person can add their own. Nothing is created if the request would be refused (offline only, no key, no consent), so there are never empty documents. The result is kept as the document's first version. Documents from the transcript, a summary or a blank page use no AI at all.

## Chat

Chat answers straight away rather than through the job queue, so a question never waits behind a long transcription. It uses the same provider, offline, key and consent checks.

1. **Scope.** The chosen recordings, a collection with its sub-collections, or the whole library, never including the trash.
2. **What to read.** If every transcript in scope fits the provider's budget (capped at 48,000 characters), all of it is read, which grounds answers best and makes "not mentioned" meaningful. Otherwise a short JSON plan from the model turns the question and recent turns into keyword searches (including other languages), a time range, or a request for an overview. Each search runs BM25 over `transcript_chunks`; results are merged by reciprocal rank fusion, the best passage of each recording first. Time ranges and overviews take an even selection of lines.
3. **Answer.** Lines are numbered S1, S2… across recordings. The model replies in JSON: the answer with citations, whether the recordings answered it ("yes", "partly", "no"), and any general knowledge, separately. One retry if the JSON is unreadable; plain text is accepted only if it is not broken JSON.
4. **Checks.** Citations are resolved against the exact lines sent and become links to that recording and moment. Unknown ids are removed and counted. Short rate limits (20 seconds or less) and network or server blips are retried up to three times; longer limits fail with when to try again.

Keyword retrieval cannot match a paraphrase with no shared words. The plan step reduces this by adding likely words and translations. There are no embeddings yet.

## AI Studio

Every Studio tool is a `studio` job on the shared queue. Lines are numbered S1, S2… across all chosen recordings and split into pieces that fit the provider.

- **Structured tools** (flashcards, quiz, action items, line-by-line translation) ask each piece for JSON with the count shared out by size, validate every item (a real source line, a correct option among distinct options, a real date), ask once more if the reply cannot be read, then merge pieces evenly and remove repeats.
- **Mind maps** need the whole picture, so long material is read as an even selection.
- **Written tools** (study notes, rewrite, comparison, custom, summary translation) use one request when the material fits; otherwise notes per piece, merged in rounds if needed (as for summaries), then one combined result. Citations are checked as in chat.
- Each finished piece is stored, so a retry continues where it stopped. "Too large" halves the piece size and starts again.

## Choosing a model

Settings › AI providers lists EchoMind's tested models first ("Recommended") and then the other models the service offers today ("Also offered"), read from its `/models` list with your key and kept for ten minutes. Only models fit for the purpose are shown: Whisper or Transcribe models for transcription; for text, everything except speech, safety, embedding, image, music and other specialised models. Offline, or without a key, the tested list is shown. Listing models sends only the key, never anything recorded.

## When a provider retires a model

Free services retire models often. A "model not found" or "decommissioned" reply is its own error: EchoMind asks the service for its models (`/models`), picks the first of its preferred list still offered (otherwise any text model), saves it in Settings and repeats the request. Results record the model that actually answered.

Gemini answers an unknown model with a bare 404 and no message, so a 404 on a chat request is treated the same way; if the model list cannot be read either, the original error is shown, because the address is then the likely problem. Gemini lists models as `models/gemini-…`; the prefix is removed. Changing the provider in Settings clears a model name that belongs to the old provider, so its default is used.

Citations are accepted as `[S12]`, `[ S12 ]`, `【S12】`, `［S12］` or `(S12)`, all checked the same way. Task due dates are worked out by EchoMind from the words the model reports ("by Friday"), never by the model.

## Adding a provider

Implement `TranscriptionProvider` or `ChatProvider` in `desktop/src/main/ai/types.ts`, add its facts to `desktop/src/shared/providers.ts`, and connect it in `makeProvider` or `makeChatProvider` in `desktop/src/main/index.ts`. A service with an OpenAI-compatible API needs only its address and models.

## Planned

Optional local semantic search (embeddings) is a candidate add-on.
