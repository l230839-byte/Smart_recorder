# EchoMind progress

**Current focus:** waiting on two owner actions below, then Desktop Phase 4, summaries. See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | Done, with known limits | [phase-02](docs/phases/phase-02-recording-import-library.txt) |
| 3 Transcription | Done, not yet run on live Groq | [phase-03](docs/phases/phase-03-transcription.txt) |
| 4 Summaries | Next | |
| 5–8 | Not started | |

## What works today

An offline recorder and library, plus transcription: crash-safe recording, batch import, search that includes transcripts, trash, trim, a full player, and a transcript viewer with six views, editing that keeps the original, find, and synced playback. Jobs survive crashes and wait out rate limits by themselves. Nothing leaves the computer without permission.

## Needs the owner

1. **FFmpeg:** run `npm run fetch:ffmpeg` in `desktop/`, then `npx playwright test ffmpeg`. The integration is written but has never run.
2. **A free Groq key:** needed to confirm real transcription and to compare Urdu and mixed speech.
3. **GitHub access:** this PC is signed in as an account that cannot push to the repository.

## What is untested

- Live Groq. Tests use a local server that follows Groq's documented format.
- FFmpeg and AMR import.
- A real microphone, real drag and drop, native file dialogs and native notifications.
- Any Windows machine other than the development one.
- A real multi-hour transcription.

## Known limits

- Whisper providers give no speaker labels.
- No live transcript while recording.
- No installer yet (Phase 8). Run from source with `npm run dev`.

Each phase report has its full list.
