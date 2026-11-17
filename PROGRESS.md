# EchoMind progress

**Current focus:** Desktop Phase 6, AI chat and search. See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | Done, with known limits | [phase-02](docs/phases/phase-02-recording-import-library.txt) |
| 3 Transcription | Done, not yet run on live Groq | [phase-03](docs/phases/phase-03-transcription.txt) |
| 4 Summaries, plus audit of 1–3 | Done, not yet run on live Groq or Gemini | [phase-04](docs/phases/phase-04-summaries.txt) |
| 5 Documents and export | Done; AI drafts not yet run on a live provider | [phase-05](docs/phases/phase-05-documents.txt) |
| 6 AI chat and search | Next | |
| 7–8 | Not started | |

## What works today

Record or import audio, transcribe it, read and edit the transcript, and generate summaries in many styles with citations that play the source. Find chapters and get suggested titles and tags. Turn any recording into a document from nine templates, edit it with a live page preview, keep versions, and export it as PDF, Word, PowerPoint, HTML, Markdown or text, with Urdu set in Nastaliq. Everything is searchable, jobs survive crashes and wait out rate limits, and nothing leaves the computer without permission.

## Needs the owner

1. **A free Groq key:** needed to confirm real transcription, summaries and AI documents, and to compare Urdu and mixed speech.

## What is untested

- Live Groq and Gemini. Tests use a local server that follows the documented formats.
- Exported Word and PowerPoint files in Microsoft Office itself. They are checked by reading their XML; Office and LibreOffice are not installed here.
- A real microphone, real drag and drop, native file dialogs and native notifications.
- Any Windows machine other than the development one.
- A real multi-hour transcription.

## Known limits

- Whisper providers give no speaker labels.
- No live transcript while recording.
- Grounding reduces invented content but cannot eliminate it, so citations make checking easy.
- In PDFs, Urdu displays correctly, but only part of it can be copied out as text. Word, Markdown and text exports keep it exactly.
- No installer yet (Phase 8). Run from source with `npm run dev`.

Each phase report has its full list.
