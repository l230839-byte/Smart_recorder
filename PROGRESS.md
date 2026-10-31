# EchoMind progress

**Current focus:** Desktop Phase 2: recording, import, library and playback. See [the plan](docs/IMPLEMENTATION_PLAN.md).

| Desktop phase | Status | Report |
| --- | --- | --- |
| 1 Foundation | Done | [phase-01](docs/phases/phase-01-foundation.txt) |
| 2 Recording, import, library, playback | In progress | |
| 3–8 | Not started | |

## What works today

First-run onboarding, navigation, themes and settings, all stored in a migrated SQLite database, in a sandboxed window with a strict Content Security Policy.

## Known limits

- No installer yet (Phase 8). Run from source with `npm run dev`.
- Nothing has been tested on another Windows machine yet.
