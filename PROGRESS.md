# EchoMind progress

**Current focus:** Desktop Phase 7, AI Studio, study tools and tasks. See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | Done, with known limits | [phase-02](docs/phases/phase-02-recording-import-library.txt) |
| 3 Transcription | Done, not yet run on live Groq | [phase-03](docs/phases/phase-03-transcription.txt) |
| 4 Summaries, plus audit of 1–3 | Done, not yet run on live Groq or Gemini | [phase-04](docs/phases/phase-04-summaries.txt) |
| 5 Documents and export | Done; AI drafts not yet run on a live provider | [phase-05](docs/phases/phase-05-documents.txt) |
| 6 AI chat and search | Done; chat not yet run on a live provider | [phase-06](docs/phases/phase-06-chat-search.txt) |
| 7 AI Studio, study tools, tasks | Next | |
| 8 Hardening and release | Not started | |

## What works today

Record or import audio, transcribe it, read and edit the transcript, and generate summaries in many styles with citations that play the source. Find chapters and get suggested titles and tags. Turn any recording into a document from nine templates, edit it with a live page preview, keep versions, and export it as PDF, Word, PowerPoint, HTML, Markdown or text, with Urdu set in Nastaliq. Ask questions about one recording, several, a collection or the whole library, with answers that cite the moments they came from and say plainly when something is not in the recordings. Search everything at once with Ctrl+K. Jobs survive crashes and wait out rate limits, and nothing leaves the computer without permission.

## Needs the owner

1. **A free Groq key** (and optionally a Gemini key) in `desktop/.env.live`, then `npm run test:live`: runs everything against the real services with generated speech and writes a report to judge. Put the key in the file rather than in a chat message.
2. **An Urdu recording** of your own, to judge Urdu transcription and answers. Windows here has no Urdu voice to generate one.

## What is untested

- Live Groq and Gemini. Tests use the demo model, scripted replies and a local server that follows the documented formats.
- Exported Word and PowerPoint files in Microsoft Office itself. They are checked by reading their XML.
- A real microphone, real drag and drop, native file dialogs and native notifications.
- Any Windows machine other than the development one.

## Known limits

- Whisper providers give no speaker labels.
- No live transcript while recording.
- Grounding reduces invented content but cannot eliminate it, so citations make checking easy.
- Chat and search match words, not meaning: a paraphrase with no shared words can be missed. The AI search plan adds likely words and translations to reduce this. Local semantic search is a planned add-on.
- In PDFs, Urdu displays correctly, but only part of it can be copied out as text. Word, Markdown and text exports keep it exactly.
- No installer yet (Phase 8). Run from source with `npm run dev`.

Each phase report has its full list.
