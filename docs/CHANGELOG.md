# Changelog

## Unreleased

### 0.3.0, Phase 15: Every AI feature offline

- "On this computer (offline)" for writing: summaries, chapters, titles, chat, documents and AI Studio run on llama.cpp (MIT) with Qwen3 4B (2.4 GB) or Qwen3 1.7B (1.1 GB), both Apache-2.0, served only on 127.0.0.1.
- Offline only now means "use this computer's AI" instead of "AI off": every feature keeps working with no internet once the offline models are downloaded; the online choices are kept for later.
- Settings > AI providers > Work offline: what is ready, and one button to download what is missing.
- Model downloads resume by themselves after a dropped connection, and a download cut short is never deleted as a bad file.
- Fixed: citations written with their line time ([S11 0:38]) were left as raw text; an empty "not in the recordings" answer showed a blank reply.

### 0.2.0, Phase 14: Recordings you can trust

- A live microphone check on the Record screen names the device in use and warns, before recording, when no sound comes through.
- While recording, ten seconds of silence brings a red banner, a toast on any other screen, a red "No sound" sidebar indicator, and after a minute a Windows notification if the window is hidden. "Stop and choose another microphone" keeps what was captured.
- A saved microphone that is no longer connected falls back to the default, and says so.
- Recordings with no sound are flagged "No sound" in the Library and explained on their page.
- Silent stretches are never sent for transcription (no quota spent, nothing invented); Whisper lines it rates as probably not speech are dropped. Found live: a 43-minute recording from a silent microphone had been "transcribed" as "Thank you." 80 times.

### Phase 13: Offline transcription

- "On this computer (offline Whisper)": transcription with no internet and no key, through whisper.cpp (MIT). Works with Offline only on.
- Five multilingual models from 31 MB to 547 MB, downloaded once in Settings from the official source, checked by SHA-256, and resumable; download asks first when Offline only is on.
- Live: Tiny 11.5x and Small 2.2x real time on the development computer, 11 of 12 facts each, timings in line with the cloud providers.
- `npm run fetch:whisper` pins whisper.cpp b5454 and checks its published hash and MIT licence.

### Phase 12: AI models

- Gemini 3.5 Transcribe as a transcription provider: speaker labels and word timings from the audio. Live: all 12 facts, turns within 0.1 s of Groq Whisper, two voices told apart 100%. 25-minute pieces keep speaker labels steady for longer.
- Settings shows every suitable model a service offers today, with EchoMind's tested models first.
- An overloaded model ("high demand") hands the request to another model in the list instead of failing.
- Gemini's errors (sent as a JSON array) are now read properly; retired-model fallback never picks an image, music or other specialised model.
- Gemini text default stays 3.5 Flash-Lite (fastest and available); 3.6 Flash and Flash-Lite latest added as fallbacks.

### Phase 11: Themes

- Light mode moves from warm cream to cool "ink on paper" neutrals that suit the indigo brand.
- Dark mode buttons are saturated with white text (they looked disabled before); pages, surfaces and menus or dialogs now sit on three clear levels.
- Six accent colours (indigo, teal, rose, amber, green, slate) and high contrast in light and dark, which can follow Windows. Settings > Appearance.
- Every combination checked for WCAG AA contrast; the automated audit now runs on every accent and on high contrast.
- Appearance settings only accept their listed values. Theme changes cross-fade briefly, unless reduced motion is on.

### Phase 10: Logo and icons

- New mark, the "Level E": an E built from three audio-level bars with an echo dot. In the app it takes the theme's accent; the app icon is indigo.
- A real Windows icon (`icon.ico`, 16 to 256 px), with the four smallest sizes drawn on whole pixels so the taskbar icon is sharp.
- AI Studio's 15 tools are grouped by purpose (summaries and writing, study, meetings and tasks, documents and slides), each group with its own colour tile; Home's Ask card uses the AI colour.

### Phase 9: Stabilise (long recordings and bug fixes)

- 3-hour recordings proven live end to end: transcription (all 30 sessions' facts, under 1 s drift), resume after a kill, and every text task.
- Long transcripts: notes are merged in rounds and each merge is saved, so waits never repeat work; titles describe the whole recording.
- Groq's reasoning model no longer returns empty replies (it spent its whole budget thinking); reasoning models are asked for low effort, and an all-reasoning reply is retried with more room.
- Requests have time limits; jobs stop only after six failures in a row with no progress; chat retries short blips; Groq's "Failed to validate JSON" is retried.
- A crashed window reopens by itself with a notice; starts, quits and crashes are logged (paths and keys removed) to the data folder.
- Language choices are a normal dropdown with "Other language…"; Library rows line up with Home; the development window has the EchoMind icon.

### Live check on Groq

- First run with a real key: transcription excellent; every text task failed because Groq retired the default Llama models.
- Defaults moved to `openai/gpt-oss-120b`, and EchoMind now switches by itself when a provider retires a model.
- Citations written as 【S1】 or [ S1 ] are linked; task due dates are computed from the spoken words, not by the model.
- Final run: all 12 facts in the summary with 22 checked citations, correct dates, grounded chat. Report in docs/phases/live-check-groq.txt.

### Live check on Gemini

- First run failed every text task: Gemini answers an unknown model with a bare 404, and the Groq model name had been carried over when the provider changed.
- A 404 on a chat request now triggers the model switch; changing provider clears the old provider's model; Gemini's `models/` prefix is removed.
- Final run on gemini-3.5-flash-lite: summary with 29 checked citations and none invented, minutes with 40, a correct quiz, correct dates, grounded chat. Task titles must now stand on their own ("Test the payment screen", not "Test it").

### Phase 8: Hardening and release

- App lock with a PIN. While locked, the main process refuses all data and media, notifications hide titles, and wrong PINs cost growing waits that survive restarts.
- Encrypted backup and restore to any folder. A wrong password is caught at once and tampering at the end; nothing changes until the next launch, and the replaced library is kept.
- Share bundles that carry a recording with everything made from it; double-click to import.
- Start with Windows (minimized), so task reminders arrive on time.
- Windows installer with icon and `.echomind` file association, and a test that drives the packaged app.
- Accessibility: three colour-contrast problems fixed; every main screen passes an automated WCAG 2.1 AA check in both themes.
- Security: logs strip file paths and keys; a test proves a full session sends no network request with the demo providers.
- The §29 acceptance workflow runs end to end for a recorded and an imported recording.

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
