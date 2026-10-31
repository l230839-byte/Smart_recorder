# Changelog

## Unreleased

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
