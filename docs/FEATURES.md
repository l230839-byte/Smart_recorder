# Features

Only what is implemented and verified is listed as **Working**.

| Feature | Status |
| --- | --- |
| Onboarding, local profile, privacy choice, key step | Working |
| Light, dark and system themes | Working |
| Recording with modes, bookmarks, notes, live waveform | Working (tested with a simulated microphone) |
| Crash recovery: recordings, jobs and a crashed window; diagnostics log of starts, quits and crashes | Working |
| Import: MP3, WAV, M4A, AAC, OGG, Opus, FLAC, WebM; audio from video | Working |
| Import: AMR, WMA and others through the FFmpeg add-on | Working (verified 2026-11-10; needs `npm run fetch:ffmpeg` once) |
| Batch queue, duplicates, corrupt file handling | Working |
| Library: views, search, sort, tags, nested collections, batch actions, trash | Working |
| Player: speed, skip silence, voice boost, bookmarks, trim | Working |
| Storage management | Working |
| Transcription: job queue, chunking, retry, resume, consent, encrypted keys | Working (tested with a local server following Groq's format) |
| Transcription on live Groq | Working (live-checked 2026-11-20 and on a 3-hour recording 2026-11-22: all facts found, under 1 s timing drift, resumes after a kill) |
| Recordings of 1 to 3 hours: transcription, summaries, chapters, titles, minutes, quizzes, tasks and chat | Working (3-hour meeting live-checked 2026-11-22 and 23; free Groq limits mean waits, handled automatically; see FREE_STACK.md) |
| Transcript viewer: six views, editing with preserved original, versions, find, synced playback, export to TXT, SRT, VTT | Working |
| Speaker labels | Display works. Whisper providers supply none. |
| Usage and limits | Working |
| Summaries: formats, lengths, tones, languages, scope, focus, templates, versions | Working (tested with a local server following the documented format) |
| Citations checked against the transcript | Working |
| Chapters, suggested titles and tags | Working |
| Summaries, documents, chat, Studio on live Groq and Gemini | Working (both live-checked 2026-11-20; Gemini for text only) |
| Documents: 9 templates; from AI, the transcript, a summary or a blank page | Working (AI drafts tested with the demo provider and a local server format) |
| Document editor: autosave, formatting toolbar, live page preview, versions with safe restore | Working |
| Layout: cover, contents, page size, margins, fonts, Urdu script style, spacing, headings, bullets, numbering, accent, header, footer, page numbers, times, source note, transcript appendix, direction, language | Working |
| Export: PDF, DOCX, PPTX, HTML, Markdown, text; transcript also CSV | Working (files validated by reading them back) |
| Urdu in exports | Working. In PDFs Urdu displays correctly in Nastaliq, but only part of it can be copied out of the PDF (see Phase 5 report, L2). |
| Export center: open, show in folder, save a copy, delete, missing-file detection | Working |
| Chat with one recording, several, a collection or the whole library; follow-up questions; chat history | Working (tested with the demo model and scripted model replies) |
| Answers grounded in transcripts: citations that play, checked against what was read; "not in your recordings"; general knowledge kept apart | Working |
| Retrieval: whole transcripts when they fit, otherwise BM25 search over passages, guided by a short AI search plan (follow-ups, time ranges, other languages) | Working. Keyword-based: there is no semantic (embedding) search yet. |
| Global search: names, tags, notes, transcripts, chapters, speakers, summaries, documents; snippets with times; filters; Ctrl+K | Working |
| Chat on live Groq or Gemini | Working (live-checked 2026-11-20: cited answers, "not in the recording", general knowledge kept apart) |
| AI Studio: flashcards, quizzes, mind maps, study notes (8 kinds), translation, comparison, rewrite (6 styles), custom, with saved templates; every result saved with its recordings | Working (tested with the demo model and scripted replies) |
| Study: flashcard study mode, quizzes with difficulty, MCQ/true-false marked automatically, written answers self-marked, saved attempts, AI explanations labelled; PDF and Word export | Working |
| Mind maps: drawn, each point plays its source, export as PNG or SVG | Working |
| Action items: found in recordings, reviewed and approved by you, due dates, owners, priority, reminders as Windows notifications, search, history | Working. Reminders appear only while EchoMind is running. |
| Batch processing of several recordings (separate or combined results) | Working |
| Studio tools on live Groq or Gemini | Quiz and action items live-checked 2026-11-20 on both. Other Studio tools tested with the demo model only. |
| App lock with a PIN, enforced by the main process; auto-lock after idle, on Windows lock and before sleep | Working |
| Encrypted backup and restore (AES-256-GCM, scrypt), to any folder; previous library kept after a restore | Working (API keys are not included by design) |
| Share bundles: a recording with its transcript, summaries, chapters and documents in one file; opens with a double-click | Working |
| Start with Windows, minimized, for task reminders | Working in the installed app |
| Windows installer (NSIS, per user, file association) | Working. Not code-signed, so SmartScreen warns once. |
| Accessibility: WCAG 2.1 A/AA automated audit of every main screen, light and dark | Passing (axe-core). Not yet checked with a screen reader by a person. |
