# Releasing EchoMind for Windows

## Build the installer

In `desktop/`:

```sh
npm install
npm run fetch:ffmpeg     # optional: the LGPL FFmpeg add-on for AMR, WMA and other formats
npm run fetch:whisper    # whisper.cpp (MIT) for offline transcription; models are downloaded by users in the app
npm run fetch:llama      # llama.cpp (MIT) for offline writing; models are downloaded by users in the app
npm run check            # types, lint, unit tests, licences
npm run test:e2e         # the real app, end to end, including §29 acceptance and accessibility
npm run dist             # builds dist/EchoMind-Setup-<version>.exe
npm run test:packaged    # drives the packaged EchoMind.exe to prove the release itself works
```

`npm run dist` downloads Electron and the NSIS tools into electron-builder's cache the first time.
The installer is about 196 MB with the FFmpeg add-on and whisper.cpp (built 2026-11-23), about 110 MB without FFmpeg. Offline models are not in the installer; people download the one they choose in the app.

The icon files `build/icon.png` (512 px) and `build/icon.ico` (16 to 256 px) are committed. After changing the mark, run `npm run icon` to redraw both; sizes 16, 20, 24 and 32 are placed on whole pixels by hand in `scripts/make-icon.mjs`, so keep them in step with the drawing.

## What the installer does

- Installs for the current user, so it needs no administrator rights. The folder can be changed.
- Adds Start menu and desktop shortcuts, and opens `.echomind` share bundles with EchoMind.
- Uninstalling keeps your library. Delete `%APPDATA%\EchoMind` yourself to remove it, after a backup if you want one.

## It is not code-signed

Signing certificates cost money, and EchoMind uses free tools only. Windows SmartScreen therefore shows
"Windows protected your PC" the first time. Choose **More info**, then **Run anyway**. To check the file
first, compare its SHA-256 (`Get-FileHash .\EchoMind-Setup-0.1.0.exe`) with the one published with the release.

## Where things are

| What | Where |
| --- | --- |
| Library: database, audio, exported documents | `%APPDATA%\EchoMind` (Settings > About > Data folder > Open) |
| The library replaced by the last restore | `%APPDATA%\EchoMind\previous-data`, until you remove it in Settings > Backup |
| FFmpeg add-on | `resources\bin` inside the installation folder |

## Before publishing a release

1. Update `version` in `desktop/package.json` and the changelog.
2. Run everything above, and `npm run test:live` with a key to check live providers.
3. Install the built setup on a clean Windows user account and walk through §29: record, import, transcribe, summarize, chat, flashcards, document, PDF and Word.
4. Publish the `.exe` with its SHA-256.
