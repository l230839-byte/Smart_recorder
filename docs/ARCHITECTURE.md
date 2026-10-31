# Architecture (desktop)

## Why Electron

| Need | How Electron meets it |
| --- | --- |
| Free, open source, no GPU, Windows first | MIT licence; development needs no emulator and little memory |
| Record, decode and play many audio formats | Chromium's media stack, WebCodecs and MediaRecorder |
| Correct Urdu and right-to-left rendering, on screen and in PDFs | Chromium text shaping and `printToPDF` |
| SQLite with FTS5, no native modules to compile | Node's built-in `node:sqlite` (checked inside Electron, including Urdu search) |
| Encrypted key storage | `safeStorage` (Windows DPAPI) |
| Real end-to-end tests with no hardware | Playwright drives the actual app; Chromium simulates a microphone |

Tauri was the main alternative. It was rejected because recording, decoding and PDF behavior would depend on the system's WebView2 and would need Rust services. Compose Desktop would have reused Kotlin but has no dependable multi-format playback.

## Processes

```text
Renderer (React UI)                Main process (Node)                   Media worker (hidden window)
sandboxed, no Node, strict CSP     owns the database and all files       sandboxed, no Node
window.echomind.call(...)  ──IPC──▶ services ──────── jobs over IPC ────▶ Mediabunny + WebCodecs:
                           ◀─events─                                      probe, decode, convert
```

- **Renderer** can only call the methods in `src/shared/api.ts`. It holds no business data beyond what is on screen, and it receives `data:changed` events to know when to re-read.
- **Main** owns SQLite, the file system, secrets and jobs. Long database work is avoided because `node:sqlite` is synchronous.
- **Media worker** exists because WebCodecs is only available in a renderer. Keeping it separate means a bad file can crash the worker without touching the UI, and the main process restarts it.

## Source layout

```text
desktop/src/
  shared/     Types, API contract, pure logic. No Electron or DOM, so it can be reused.
  main/       db/ (migrations, repositories), services/, security, windows
  preload/    The narrow bridges between renderer and main
  renderer/   src/design (tokens, components), src/lib, src/shell, src/features/*
desktop/tests/
  unit/       Fast tests that need no Electron
  e2e/        Playwright tests that drive the real app
```

## Decisions

| # | Decision | Reason |
| --- | --- | --- |
| 1 | Desktop before Android, as a new codebase | Product owner's request, and the free-stack prompt replaced the old OpenAI and Docker design. Old code stays on branch `legacy/android-v1`. |
| 2 | Mediabunny instead of FFmpeg | It is pure TypeScript under MPL-2.0, adds no binaries and avoids GPL build risks. Trade-off: formats outside Chromium's codecs need extra work. See phase 2 for AMR. |
| 3 | Simple typed route stack instead of a router library | The app has no URLs. About 60 lines replace a dependency. |
| 4 | `useQuery` plus change events instead of a state library | The database is the single source of truth, so there is no client cache to keep consistent. |
| 5 | Migrations are ordered, transactional SQL strings tracked by `user_version` | Simple and easy to verify. A failed migration leaves the database unchanged. |
