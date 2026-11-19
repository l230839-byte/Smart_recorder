# EchoMind progress

**Current focus:** The desktop app is complete. Next: the Android app (see the plan). See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | Done, with known limits | [phase-02](docs/phases/phase-02-recording-import-library.txt) |
| 3 Transcription | Done, not yet run on live Groq | [phase-03](docs/phases/phase-03-transcription.txt) |
| 4 Summaries, plus audit of 1–3 | Done, not yet run on live Groq or Gemini | [phase-04](docs/phases/phase-04-summaries.txt) |
| 5 Documents and export | Done; AI drafts not yet run on a live provider | [phase-05](docs/phases/phase-05-documents.txt) |
| 6 AI chat and search | Done; chat not yet run on a live provider | [phase-06](docs/phases/phase-06-chat-search.txt) |
| 7 AI Studio, study tools, tasks | Done; not yet run on a live provider | [phase-07](docs/phases/phase-07-studio.txt) |
| 8 Hardening and release | Done; installer not code-signed | [phase-08](docs/phases/phase-08-release.txt) |

## What works today

Record or import audio, transcribe it, read and edit the transcript, and generate summaries in many styles with citations that play the source. Find chapters and get suggested titles and tags. Turn any recording into a document from nine templates, edit it with a live page preview, keep versions, and export it as PDF, Word, PowerPoint, HTML, Markdown or text, with Urdu set in Nastaliq. Ask questions about one recording, several, a collection or the whole library, with answers that cite the moments they came from and say plainly when something is not in the recordings. Search everything at once with Ctrl+K. Make flashcards, quizzes, mind maps, study notes, translations, comparisons and rewrites; study and take quizzes in the app; and keep action items from recordings as tasks with reminders. Lock the app with a PIN, back up everything encrypted, share a recording with everything made from it, and install EchoMind with a Windows installer. Jobs survive crashes and wait out rate limits, and nothing leaves the computer without permission.

## Needs the owner

1. **Groq: done.** Live-checked on 2026-11-20 ([report](docs/phases/live-check-groq.txt)). Optionally add a Gemini key to `desktop/.env.live` to check Gemini too.
2. **An Urdu recording** of your own, to judge Urdu transcription and answers. Windows here has no Urdu voice to generate one.

## What is untested

- Gemini, and long recordings on live Groq. Groq was checked live with a 70-second meeting.
- Exported Word and PowerPoint files in Microsoft Office itself. They are checked by reading their XML.
- A real microphone, real drag and drop, native file dialogs and native notifications.
- Any Windows machine other than the development one.

## Known limits

- Whisper providers give no speaker labels.
- No live transcript while recording.
- Grounding reduces invented content but cannot eliminate it, so citations make checking easy.
- Chat and search match words, not meaning: a paraphrase with no shared words can be missed. The AI search plan adds likely words and translations to reduce this. Local semantic search is a planned add-on.
- In PDFs, Urdu displays correctly, but only part of it can be copied out as text. Word, Markdown and text exports keep it exactly.
- Task reminders appear only while EchoMind is running.
- The installer is not code-signed, so SmartScreen warns once.
- App lock is a PIN only: Windows Hello is not available to Electron apps.

Each phase report has its full list.
