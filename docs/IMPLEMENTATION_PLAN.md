# EchoMind implementation plan

The source of truth is `EchoMind – Full Free-Stack Master Prompt.docx`. Its roadmap (§24) is Android-first.
The product owner asked for the **desktop app first**, so the same eight phases are built for Windows
desktop, then repeated for Android. Every prompt section is assigned to a phase below.

Each phase is finished only when it is implemented, tested (normal use, edge cases, errors), reviewed as
designer and developer, and written up in `docs/phases/phase-NN-*.txt`. Only then does the next one start.

## Desktop phases

| # | Phase | Delivers | Prompt sections | Result |
| --- | --- | --- | --- | --- |
| 1 | Foundation | Electron + React + TypeScript project, secure process model, SQLite with migrations, design system (light and dark), five-section navigation, onboarding with privacy choice, settings, test and lint tooling, docs | 0, 1, 2, 16, 19 (base), 21 (base), 26, 27 | Runnable, secure shell |
| 2 | Recording, import, library, playback | Recording engine with crash recovery, modes, bookmarks and notes; one ingestion pipeline (picker, drag and drop, "Open with", batch queue, video, duplicates, corruption checks); library with collections, tags, trash, FTS search and storage screen; player with speed, skip silence, voice boost and trim | 3, 4, 5, 6, 12, 18 (input to library), 22 | A complete offline recorder |
| 3 | Transcription | Persistent job queue with backoff; AI provider layer with a fake provider first, then free real providers with your own key; encrypted key storage; consent screen; chunking of long audio; transcript viewer with 6 modes, editing with preserved original, search and synced playback; usage and limits | 0, 7, 18, 19, 23 | Any recording becomes searchable text |
| 4 | Summaries | Format, length, tone, language, focus and exclusion controls; mode templates (§6); chapters; suggested titles and tags; versions; timestamp citations; never re-transcribes | 6, 8, 15.1, 15.5, 15.10 | Grounded, customizable summaries |
| 5 | Documents and export | PDF (Chromium engine, correct Urdu shaping with bundled Noto fonts), DOCX, PPTX, TXT, MD, HTML, SRT, VTT, CSV; 9 templates; preview and editor; versions; export center and history | 11 | Real, validated documents |
| 6 | AI chat and search | Chunking, embeddings or FTS5/BM25 fallback, grounded answers with citations, multi-recording and collection chat, global search with snippets and timestamps | 9, 12 (search), 15.2, 15.3, 15.12 | Talk to your recordings |
| 7 | AI Studio and study tools | Flashcards, quizzes with attempts, study guides, tasks and reminders, minutes, translation, mind map, comparison, rewrite, custom templates, batch processing | 10, 13, 14, 15.5, 17 (workflow D) | Recording-to-productivity platform |
| 8 | Hardening and release | App lock, encrypted backup and restore, portable share bundles, security, performance and accessibility passes, recovery tests, Windows installer, full docs, §29 acceptance run | 15.6–15.9, 21, 22, 25, 27, 29 | Beta-quality Windows release |

## After desktop

| # | Phase | Notes |
| --- | --- | --- |
| A | Android app | Kotlin/Compose per §2. The earlier Android code is on branch `legacy/android-v1`. Reuse its recorder, import and UI where they fit the free stack. |
| S | Optional Server mode (§20) | Self-hosted FastAPI behind the same repository interfaces. Starts from the legacy `backend/`. Optional by the prompt's own rule. |

## How the Android-specific requirements map to desktop

| Prompt (Android) | Desktop equivalent |
| --- | --- |
| Foreground service, screen-off recording | Recording stays alive across screens and while minimized; system sleep blocked while recording; visible indicator |
| Share intent ("Share to EchoMind") | "Open with EchoMind", files passed on the command line, drag and drop |
| Storage Access Framework | Native file dialogs; cloud drives through their synced folders |
| Android Keystore | Windows DPAPI through Electron `safeStorage` |
| Room | SQLite (`node:sqlite`, FTS5) |
| Media3, MediaCodec | Chromium media stack with WebCodecs and Mediabunny |
| PdfDocument | Chromium `printToPDF` (HarfBuzz shaping) |
| WorkManager, AlarmManager | Persistent job queue in the main process; native notifications |
| Phone calls, audio focus | Microphone unplugged or muted, permission revoked |
