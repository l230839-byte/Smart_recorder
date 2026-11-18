# Testing

| Command (in `desktop/`) | What it runs |
| --- | --- |
| `npm run check` | Type check, ESLint, unit tests, licence check |
| `npm run test:e2e` | Builds, then drives the real Electron app with Playwright |
| `npm run test:packaged` | Drives the packaged `dist/win-unpacked/EchoMind.exe` after `npm run dist` |
| `npm run test:live` | Builds, then runs real transcription, summaries, chapters, a document and chat against Groq (and Gemini if a key is given). Skips without a key. |

- **Unit tests** (`tests/unit`, Vitest) need no Electron. The database tests use real SQLite in memory.
- **End-to-end tests** (`tests/e2e`, Playwright) launch the built app against a throwaway data folder set through `ECHOMIND_USER_DATA`, so real user data is never touched. Chromium's simulated microphone lets recording tests run with no hardware.
- **Live tests** (`tests/live`) need `GROQ_API_KEY`, and optionally `GEMINI_API_KEY`, in `desktop/.env.live`, which git ignores. They generate a two-voice meeting with Windows speech, so only generated audio is sent. Every result is checked against the meeting's known facts and written to `test-results/live/live-report.md` for a person to judge.
- **Acceptance** (`acceptance.spec.ts`) runs prompt §29 through the screens, for a recorded and an imported recording.
- **Accessibility** (`accessibility.spec.ts`) runs axe-core's WCAG 2.1 A/AA rules on every main screen in light and dark themes.
- **Safety** (`safety.spec.ts`) covers app lock, backup and restore, share bundles, and a session that must make no network request.
- Screenshots go to `test-shots/` and are reviewed by eye at the end of each phase.

Run Vitest from PowerShell or cmd, not Git Bash. Git Bash reports the drive as `D:` while Node resolves the project as `d:`, so Vitest loads twice and every test fails with "failed to find the current suite".

Terminals inside VS Code set `ELECTRON_RUN_AS_NODE`, which stops Electron from starting as an app. The `dev`, `start`, `test:e2e` and `test:live` scripts clear it through `scripts/run.mjs`.
