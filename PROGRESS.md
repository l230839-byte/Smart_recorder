# EchoMind progress

**Current focus:** Desktop Phase 5, documents and export. See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | Done, with known limits | [phase-02](docs/phases/phase-02-recording-import-library.txt) |
| 3 Transcription | Done, not yet run on live Groq | [phase-03](docs/phases/phase-03-transcription.txt) |
| 4 Summaries, plus audit of 1–3 | Done, not yet run on live Groq or Gemini | [phase-04](docs/phases/phase-04-summaries.txt) |
| 5 Documents and export | Next | |
| 6–8 | Not started | |

## What works today

Record or import audio, transcribe it, read and edit the transcript, and generate summaries in many styles with citations that play the source. Find chapters and get suggested titles and tags. Everything is searchable, jobs survive crashes and wait out rate limits, and nothing leaves the computer without permission.

## Needs the owner

1. **FFmpeg:** run `npm run fetch:ffmpeg` in `desktop/`, then `npm run build` and `npx playwright test ffmpeg`. The integration is written but has never run.
2. **A free Groq key:** needed to confirm real transcription and summaries, and to compare Urdu and mixed speech.

## What is untested

- Live Groq and Gemini. Tests use a local server that follows the documented formats.
- FFmpeg and AMR import.
- A real microphone, real drag and drop, native file dialogs and native notifications.
- Any Windows machine other than the development one.
- A real multi-hour transcription.

## Known limits

- Whisper providers give no speaker labels.
- No live transcript while recording.
- Grounding reduces invented content but cannot eliminate it, so citations make checking easy.
- No installer yet (Phase 8). Run from source with `npm run dev`.

Each phase report has its full list.
