# Changelog

## Unreleased

### Phase 7: AI Studio, study tools and tasks

- Every AI Studio tool works: flashcards, quizzes, mind maps, study notes, translation, comparison, rewrite and custom, plus saved templates. Every result is kept with its recordings and can be exported to PDF or Word.
- Study: flashcards with a keyboard study mode; quizzes with difficulty, automatic marking, model answers, saved attempts; anything beyond the recording labelled as an AI explanation.
- Mind maps that play the moment behind each point, saved as PNG or SVG.
- Tasks: action items found in recordings wait for your approval; due dates, owners, priority, reminders, overdue warnings, search and history. Nothing is sent to a calendar or to anyone.
- Process several recordings at once from the Library, one result each or one combined.
- Long recordings are handled in parts, and finished parts are never repeated after a failure.

### Phase 6: AI chat and search

- Ask questions about one recording, several, a collection or the whole library, with follow-ups and saved chats.
- Every answer cites the moments it came from; citations play and are checked against what the AI actually read. Answers say plainly when the recordings do not cover something, and keep general knowledge in a separate box.
- Retrieval reads whole transcripts when they fit, and otherwise searches passages with BM25, guided by a short AI plan that resolves follow-ups, time ranges ("the first 20 minutes") and other languages.
- Search everything at once (Ctrl+K): names, tags, notes, transcripts, chapters, speakers, summaries and documents, with highlighted snippets, times and filters.
- Ask AI from a recording, a Library selection, a collection, search results, Home and AI Studio.
- Deleting a recording deletes every chat that read it.
- `npm run test:live` runs everything against real Groq and Gemini with your own key, using generated speech, and writes a report.
- Fixed while building: search could hide recordings when a word was common, an effect crashed with newer Chromium, chats on just-upgraded libraries missed older transcripts, and Back lost the search query.

### Phase 5: Documents and export

- Documents from any transcribed recording: nine templates, written by AI, laid out from the transcript, built from a summary, or started blank.
- Editor with autosave, a formatting toolbar with Ctrl+B and Ctrl+I, and a live, sandboxed preview of the real page that follows the section being edited.
- Every layout choice from the prompt, applied to the preview and every format.
- Export to PDF, Word, PowerPoint, HTML, Markdown and text. Urdu uses embedded Noto Nastaliq or Naskh fonts. Transcripts also export to CSV, protected against spreadsheet formulas.
- Versions: the first draft is kept, and restoring an older version saves the current draft first.
- Documents and exported files in one place, with open, show in folder, save a copy and delete. Deleting a recording deletes its documents and files.
- AI Studio: PDF, Word, Presentation and Meeting Minutes tools are live.
- Fixed while building: hidden times no longer change the rest of the text, two exports in the same second no longer share a file, and Urdu no longer falls back to a system font.

### FFmpeg add-on verified

- The LGPL FFmpeg add-on was installed and tested: AMR imports and plays, damaged files are still refused, and playlist tricks cannot reach other files.

### Phase 4: Summaries, and an audit of earlier phases

- Summaries: 14 formats, 6 lengths, 8 tones, any language, selected chapters, time ranges, selected text, focus and exclusion controls, custom instructions, saved templates and versions.
- Citations are checked against the transcript. Real ones play the source; invented ones are removed and reported.
- Topic chapters, and suggested titles and tags that wait for your choice.
- Providers: Groq, Google Gemini, any OpenAI-compatible service, and a demo model. Separate consent for text and audio.
- Fixed: duplicate race on import, video detection by extension, jobs running after trash, temp file build-up, MP3 trim, an error on quit.
- Hardened: per-window IPC checks, settings validation, recovery screen for render errors, smoother long transcripts.
- Added: description while recording, status and language in details, Select all, running jobs in the sidebar.

### Phase 3: Transcription

- Provider layer with Groq Whisper, any OpenAI-compatible service, and a labelled demo provider.
- Persistent job queue: long audio in pieces, waits out rate limits, resumes after crashes, never redoes finished work.
- Privacy gate: offline only, encrypted keys, and consent before the first upload to each provider.
- Transcript viewer: six views, editing that keeps the original, versions, find, synced playback, TXT, SRT and VTT export.
- Transcripts join Library search. Usage and limits screen. Key step in onboarding.
- Optional FFmpeg add-on for AMR, WMA and more (written, not yet run).

### Phase 2: Recording, import, library, playback

- Crash-safe recording with seven modes, bookmarks, notes and a live waveform.
- One ingestion pipeline for recorded, imported, dropped, opened, trimmed, recovered and video audio.
- Persistent batch import with duplicate detection, content-based format checks and per-file errors.
- Library with search (including Urdu), tags, nested collections, batch actions, trash and storage management.
- Player with speed, skip silence, voice boost, bookmarks, and lossless trim.

### Phase 1: Foundation

- New Windows desktop app: Electron, React and TypeScript.
- Secure process model, SQLite with migrations, design system with light and dark themes.
- Five-section navigation, first-run onboarding with a privacy choice, and settings.
