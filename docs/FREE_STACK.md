# Free stack

EchoMind uses free and open-source software only. `npm run check:licenses` fails if a production dependency is GPL, AGPL, or has an unknown licence.

## Runtime dependencies

| Component | Purpose | Licence |
| --- | --- | --- |
| Electron | App runtime (includes Chromium and Node) | MIT |
| React | UI | MIT |
| Mediabunny | Media probing, demuxing, muxing and conversion | MPL-2.0 (file-level copyleft; no effect on app code) |
| lucide-react | Icons | ISC |
| Inter (via Fontsource) | Typeface | SIL OFL 1.1 |
| FFmpeg, optional add-on | Reads formats the built-in decoders cannot, such as AMR and WMA | LGPL (BtbN shared build) |

### FFmpeg notes

`npm run fetch:ffmpeg` downloads the LGPL shared build, verifies the checksum published with the release, and refuses any build configured with GPL or non-free code. It stays out of the repository and is copied into the installer. It runs as a separate process with replaceable shared libraries, which is how the LGPL's relinking requirement is met. Its licence file is copied alongside it. Source is available from [FFmpeg](https://ffmpeg.org/download.html) and [the build scripts](https://github.com/BtbN/FFmpeg-Builds).

## AI providers

You supply your own key. Figures below were checked on 2026-10-31 and change often, so check the linked pages.

| Service | Used for | Free terms as documented | Check |
| --- | --- | --- | --- |
| Groq Whisper | Transcription | Free tier with a key. 25 MB per file. `retry-after` on HTTP 429. No training on customer data. Inputs not kept by default, with logs of up to 30 days for reliability or abuse checks. | [Limits](https://console.groq.com/settings/limits), [Your data](https://console.groq.com/docs/your-data) |
| Other OpenAI-compatible service | Transcription | Set by whoever runs it | Their terms |
| Demo | Trying the app | Nothing leaves the computer. Placeholder text. | None |

Groq's public table shows Developer plan limits, and its free-plan values could not be read from the docs, so EchoMind hardcodes none. It shows the limits the service reports in its responses.

### Evaluated, not used yet

**Google Gemini** is under evaluation for Phase 4. Free-tier content may be used to improve Google's products, and forum reports of free daily limits range from 20 to 250 requests, so it needs its own clear disclosure.

## How to swap a provider

See "Adding a provider" in [AI_PIPELINE.md](AI_PIPELINE.md).
