# EchoMind

Turn every recording into knowledge, documents and action.

EchoMind is an AI recorder and knowledge app built entirely on free tools. Record audio or import it from anywhere, and every recording gets the same features, whatever its source. It runs locally with no account and no payments. AI features use free provider keys that you supply.

> **Status:** in active development, built phase by phase, Windows desktop first. See [PROGRESS.md](PROGRESS.md) for what works today and [the plan](docs/IMPLEMENTATION_PLAN.md) for what is coming. Features that are not built yet are labelled in the app.

## Run the desktop app from source

Requires Node.js 24 or newer on Windows.

```sh
cd desktop
npm install
npm run dev
```

To use the real transcription provider, add a free key under Settings > AI providers. To try everything with no key, choose the Demo provider there.

Optional: `npm run fetch:ffmpeg` installs the LGPL FFmpeg add-on, which lets EchoMind import AMR, WMA and other less common formats.

## Check it

```sh
cd desktop
npm run check      # types, lint, unit tests, dependency licences
npm run test:e2e   # builds, then drives the real app, including a simulated microphone
```

## Repository

| Path | Contents |
| --- | --- |
| `desktop/` | The Electron + React + TypeScript app |
| `docs/` | Plan, architecture, security, testing and other documentation |
| `docs/phases/` | One report per completed build phase |
| `EchoMind – Full Free-Stack Master Prompt.docx` | The product specification |

## Documentation

[Plan](docs/IMPLEMENTATION_PLAN.md) · [Architecture](docs/ARCHITECTURE.md) · [Features](docs/FEATURES.md) · [Database](docs/DATABASE_SCHEMA.md) · [Internal API](docs/API_DOCUMENTATION.md) · [AI pipeline](docs/AI_PIPELINE.md) · [Security](docs/SECURITY.md) · [Testing](docs/TESTING.md) · [Free stack](docs/FREE_STACK.md) · [Changelog](docs/CHANGELOG.md)
