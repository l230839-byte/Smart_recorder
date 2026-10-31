# EchoMind progress

**Current focus:** Desktop Phase 3, transcription. See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | Done, with known limits | [phase-02](docs/phases/phase-02-recording-import-library.txt) |
| 3 Transcription | Next | |
| 4–8 | Not started | |

## What works today

A complete offline recorder and library: crash-safe recording, batch import of common audio and video files, search, tags, nested collections, trash, trim, and a full player. AI features do not exist yet and are labelled as such in the app.

## What is untested

- A real microphone. Automated tests use Chromium's simulated one.
- Real drag and drop from Explorer and the native file dialog gestures.
- Any Windows machine other than the development one.

## Known limits

- AMR files are recognized but cannot be imported yet.
- No installer yet (Phase 8). Run from source with `npm run dev`.

See section 6 of the [Phase 2 report](docs/phases/phase-02-recording-import-library.txt) for the full list.
