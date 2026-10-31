# Changelog

## Unreleased

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
