# Features

Only what is implemented and verified is listed as **Working**.

| Feature | Status |
| --- | --- |
| Onboarding, local profile, privacy choice, key step | Working |
| Light, dark and system themes | Working |
| Recording with modes, bookmarks, notes, live waveform | Working (tested with a simulated microphone) |
| Crash recovery | Working |
| Import: MP3, WAV, M4A, AAC, OGG, Opus, FLAC, WebM; audio from video | Working |
| Import: AMR, WMA and others through the FFmpeg add-on | Working (verified 2026-11-10; needs `npm run fetch:ffmpeg` once) |
| Batch queue, duplicates, corrupt file handling | Working |
| Library: views, search, sort, tags, nested collections, batch actions, trash | Working |
| Player: speed, skip silence, voice boost, bookmarks, trim | Working |
| Storage management | Working |
| Transcription: job queue, chunking, retry, resume, consent, encrypted keys | Working (tested with a local server following Groq's format) |
| Transcription on live Groq | Written, not yet run. Needs a key. |
| Transcript viewer: six views, editing with preserved original, versions, find, synced playback, export to TXT, SRT, VTT | Working |
| Speaker labels | Display works. Whisper providers supply none. |
| Usage and limits | Working |
| Summaries: formats, lengths, tones, languages, scope, focus, templates, versions | Working (tested with a local server following the documented format) |
| Citations checked against the transcript | Working |
| Chapters, suggested titles and tags | Working |
| Summaries on live Groq or Gemini | Written, not yet run. Needs a key. |
| Documents: 9 templates; from AI, the transcript, a summary or a blank page | Working (AI drafts tested with the demo provider and a local server format) |
| Document editor: autosave, formatting toolbar, live page preview, versions with safe restore | Working |
| Layout: cover, contents, page size, margins, fonts, Urdu script style, spacing, headings, bullets, numbering, accent, header, footer, page numbers, times, source note, transcript appendix, direction, language | Working |
| Export: PDF, DOCX, PPTX, HTML, Markdown, text; transcript also CSV | Working (files validated by reading them back) |
| Urdu in exports | Working. In PDFs Urdu displays correctly in Nastaliq, but only part of it can be copied out of the PDF (see Phase 5 report, L2). |
| Export center: open, show in folder, save a copy, delete, missing-file detection | Working |
| AI chat, global search with snippets | Phase 6 |
| AI Studio, study tools, tasks | Phase 7 |
| App lock, backup, installer | Phase 8 |
