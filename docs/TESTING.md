# Testing

| Command (in `desktop/`) | What it runs |
| --- | --- |
| `npm run check` | Type check, ESLint, unit tests, licence check |
| `npm run test:e2e` | Builds, then drives the real Electron app with Playwright |
| `npm run test:packaged` | Drives the packaged `dist/win-unpacked/EchoMind.exe` after `npm run dist` |
| `npm run test:live` | Builds, then runs real transcription, summaries, chapters, a document and chat against Groq (and Gemini if a key is given). Skips without a key. |

- **Unit tests** (`tests/unit`, Vitest) need no Electron. The database tests use real SQLite in memory.
- **End-to-end tests** (`tests/e2e`, Playwright) launch the built app against a throwaway data folder set through `ECHOMIND_USER_DATA`, so real user data is never touched. Chromium's simulated microphone lets recording tests run with no hardware.
- **Live tests** (`tests/live`) need `GROQ_API_KEY`, and optionally `GEMINI_API_KEY`, in `desktop/.env.live`, which git ignores. They generate a two-voice meeting with Windows speech, so only generated audio is sent. Every result is checked against the meeting's known facts and written to `desktop/.live-cache/reports/` (git ignored, and kept when Playwright empties `test-results`) for a person to judge.
- **Long recordings** (`tests/live/long.spec.ts`) build a 3-hour meeting of 30 sessions from Windows speech, each with a known presenter, city, fact, decision and owner. Stage 1 imports and transcribes it and measures timing drift per session; stage 2 runs summaries, chapters, titles, minutes, quizzes, tasks and chat per provider and checks them against the known facts. Its cache lives in `desktop/.live-cache/long` (git ignored, and outside `test-results`, which Playwright empties on every run), because a transcribed 3-hour library costs hours of free audio quota to rebuild. Settings: `LIVE_LONG_MINUTES` (default 180), `LIVE_LONG_PROVIDERS` (default `gemini,groq`), `LIVE_LONG_TASKS`. Run it with `npx playwright test -c playwright.live.config.ts tests/live/long.spec.ts`.
- **Offline Whisper** (`tests/live/local-whisper.spec.ts`) downloads models through the app's own checked download (cached in `.live-cache/models`) and transcribes the two-voice meeting with Offline only on. `LIVE_LOCAL_MODELS` picks the models (default `tiny,small`). Needs `npm run fetch:whisper` first.
- **Acceptance** (`acceptance.spec.ts`) runs prompt §29 through the screens, for a recorded and an imported recording.
- **Accessibility** (`accessibility.spec.ts`) runs axe-core's WCAG 2.1 A/AA rules on every main screen in light and dark themes, and on the main screens in every accent and in high contrast.
- **Gemini transcription** (`tests/live/gemini-transcribe.spec.ts`) compares Gemini 3.5 Transcribe with Groq Whisper on the two-voice meeting (facts, timing, speaker accuracy). With `LIVE_GEMINI_LONG_MINUTES` set, it also transcribes a meeting of that length in 25-minute pieces and checks every session's start, fact and speaker label.
- **Safety** (`safety.spec.ts`) covers app lock, backup and restore, share bundles, and a session that must make no network request.
- Screenshots go to `test-shots/` and are reviewed by eye at the end of each phase.

Run Vitest from PowerShell or cmd, not Git Bash. Git Bash reports the drive as `D:` while Node resolves the project as `d:`, so Vitest loads twice and every test fails with "failed to find the current suite".

Terminals inside VS Code set `ELECTRON_RUN_AS_NODE`, which stops Electron from starting as an app. The `dev`, `start`, `test:e2e` and `test:live` scripts clear it through `scripts/run.mjs`.
