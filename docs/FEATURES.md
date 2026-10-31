# Features

Only what is implemented and verified is listed as **Working**.

| Feature | Status |
| --- | --- |
| Onboarding, local profile, privacy choice, key step | Working |
| Light, dark and system themes | Working |
| Recording with modes, bookmarks, notes, live waveform | Working (tested with a simulated microphone) |
| Crash recovery | Working |
| Import: MP3, WAV, M4A, AAC, OGG, Opus, FLAC, WebM; audio from video | Working |
| Import: AMR, WMA and others through FFmpeg | Written, not yet run. Needs `npm run fetch:ffmpeg`. |
| Batch queue, duplicates, corrupt file handling | Working |
| Library: views, search, sort, tags, nested collections, batch actions, trash | Working |
| Player: speed, skip silence, voice boost, bookmarks, trim | Working |
| Storage management | Working |
| Transcription: job queue, chunking, retry, resume, consent, encrypted keys | Working (tested with a local server following Groq's format) |
| Transcription on live Groq | Written, not yet run. Needs a key. |
| Transcript viewer: six views, editing with preserved original, versions, find, synced playback, export to TXT, SRT, VTT | Working |
| Speaker labels | Display works. Whisper providers supply none. |
| Usage and limits | Working |
| Summaries | Phase 4 |
| Documents and export | Phase 5 |
| AI chat, global search with snippets | Phase 6 |
| AI Studio, study tools, tasks | Phase 7 |
| App lock, backup, installer | Phase 8 |
