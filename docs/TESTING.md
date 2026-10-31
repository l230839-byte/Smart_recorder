# Testing

| Command (in `desktop/`) | What it runs |
| --- | --- |
| `npm run check` | Type check, ESLint, unit tests, licence check |
| `npm run test:e2e` | Builds, then drives the real Electron app with Playwright |

- **Unit tests** (`tests/unit`, Vitest) need no Electron. The database tests use real SQLite in memory.
- **End-to-end tests** (`tests/e2e`, Playwright) launch the built app against a throwaway data folder set through `ECHOMIND_USER_DATA`, so real user data is never touched. Chromium's simulated microphone lets recording tests run with no hardware.
- Screenshots go to `test-results/shots/` and are reviewed by eye at the end of each phase.

Terminals inside VS Code set `ELECTRON_RUN_AS_NODE`, which stops Electron from starting as an app. The `dev`, `start` and `test:e2e` scripts clear it through `scripts/run.mjs`.
