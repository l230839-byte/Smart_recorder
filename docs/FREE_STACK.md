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
| Noto Serif, Noto Nastaliq Urdu, Noto Naskh Arabic (via Fontsource) | Document typefaces, including Urdu. Embedded in PDFs and HTML exports. | SIL OFL 1.1 |
| docx | Word files | MIT |
| PptxGenJS | PowerPoint files | MIT |
| JSZip (used by PptxGenJS) | Zip packaging | Dual MIT or GPL-3.0; used under MIT |
| pako (used by JSZip) | Compression | MIT and Zlib |
| FFmpeg, optional add-on | Reads formats the built-in decoders cannot, such as AMR and WMA | LGPL (BtbN shared build) |
| whisper.cpp (with ggml) | Offline transcription on this computer | MIT. Its Windows build also carries SDL2.dll (zlib licence). |
| llama.cpp (with ggml) | Offline summaries, chat, documents and AI Studio, run by EchoMind on this computer only | MIT. Its Windows build also carries libomp.dll (LLVM OpenMP: Apache-2.0 with LLVM exception). |
| Qwen3.5 4B, Qwen3 4B Instruct, Qwen3 1.7B (GGUF, 4-bit, quantized by Unsloth) | The offline writing models, downloaded by the person when they choose | Apache-2.0 |
| sherpa-onnx (with onnxruntime) | Offline speaker labels | Apache-2.0 (onnxruntime: MIT) |
| pyannote segmentation 3.0, 3D-Speaker ERes2Net | The two speaker models (6 MB and 26 MB), downloaded by the person when first used | MIT and Apache-2.0 |
| Whisper models (ggml files) | The offline models, downloaded by the person when they choose | MIT (OpenAI Whisper weights), converted by the whisper.cpp project |

Build and test tools (not shipped): electron-builder and NSIS (MIT and zlib licences) make the installer; axe-core (MPL-2.0) runs the accessibility audit.

PDFs are printed by the Chromium inside Electron, so no PDF library is needed. Test-only tools (not shipped): pdf.js (Apache-2.0) reads exported PDFs back, JSZip checks Word and PowerPoint files.

### FFmpeg notes

`npm run fetch:ffmpeg` downloads the LGPL shared build, verifies the checksum published with the release, and refuses any build configured with GPL or non-free code. It stays out of the repository and is copied into the installer. It runs as a separate process with replaceable shared libraries, which is how the LGPL's relinking requirement is met. Its licence file is copied alongside it. Source is available from [FFmpeg](https://ffmpeg.org/download.html) and [the build scripts](https://github.com/BtbN/FFmpeg-Builds).

### whisper.cpp notes

`npm run fetch:whisper` downloads the official Windows build of whisper.cpp release b5454 (published 2026-10-06, pinned rather than "latest"), checks it against the SHA-256 GitHub publishes for the file, keeps only `whisper-cli.exe` and the libraries it loads, saves the project's MIT licence beside them, and confirms the command-line options EchoMind uses. It stays out of the repository and is copied into the installer with FFmpeg. Models are not bundled: the person downloads one in Settings (31 MB to 547 MB) from huggingface.co/ggerganov/whisper.cpp, and EchoMind checks each file's published SHA-256 before using it.

Measured on 2026-11-23 on the development computer (70 seconds of two-voice meeting, Offline only on): Tiny 11.5x real time, Small 2.2x real time, both 11 of 12 facts. A 3-hour recording on Small takes about 80 minutes there; faster computers are faster.

### sherpa-onnx notes

`npm run fetch:sherpa` downloads the official Windows build of sherpa-onnx v2.0.1 (shared, Release, without text-to-speech; published 2026-10-26, pinned), checks the SHA-256 GitHub publishes, and keeps only the offline speaker-diarization tool, onnxruntime and sherpa-onnx's libraries, with the Apache licence. The segmentation model comes as a plain file from the project's own Hugging Face mirror (identical bytes to the GitHub archive, checked), so EchoMind never has to unpack archives. Measured: 11.6 seconds of audio in 1.15 seconds on one thread.

### llama.cpp notes

`npm run fetch:llama` downloads the official Windows CPU build of llama.cpp release b12193 (published 2026-11-07, pinned), checks it against the SHA-256 GitHub publishes, keeps `llama-server.exe` and the libraries beside it, saves the MIT licence and confirms the options EchoMind uses. Models are not bundled: the person downloads one in Settings (1.06 to 2.6 GB) from Hugging Face, checked against its published SHA-256. Chosen for licence first: Llama and Gemma models carry use restrictions, Qwen3 and Qwen3.5 are Apache-2.0. Larger open models (DeepSeek V3, GLM-4.6, Kimi K2, gpt-oss-120b) need tens to hundreds of GB of memory and do not fit a 16 GB laptop.

Measured on the development computer (7 CPU threads): Qwen3 1.7B loads in about 23 seconds the first time, reads a transcript at about 110 tokens a second and writes at about 19.

## AI providers

You supply your own key. Figures below were checked on 2026-10-31 and change often, so check the linked pages.

| Service | Used for | Free terms as documented | Check |
| --- | --- | --- | --- |
| Groq Whisper | Transcription | Free tier with a key. 25 MB per file. `retry-after` on HTTP 429. No training on customer data. Inputs not kept by default, with logs of up to 30 days for reliability or abuse checks. | [Limits](https://console.groq.com/settings/limits), [Your data](https://console.groq.com/docs/your-data) |
| Groq chat | Summaries and writing | Same key and data terms as above. Models checked live on 2026-11-20: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (Llama 3.x has been retired). If Groq retires a model, EchoMind switches to one it still offers by itself. | [Models](https://console.groq.com/docs/models) |
| Google Gemini Transcribe | Transcription with speaker labels | Same key and free-tier data terms as Gemini below: **Google may use free-tier audio to improve its products.** Model `gemini-3.5-transcribe`, up to 30 minutes per request with speakers and word times. | [Transcription](https://ai.google.dev/gemini-api/docs/transcribe) |
| Google Gemini | Summaries and writing | Free tier with a key. **Google may use free-tier content to improve its products.** Forum reports of free daily limits range from 20 to 250 requests. Models checked: `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.1-flash-lite`; the first was run live on 2026-11-20 (about 3 seconds per task). | [Pricing and data use](https://ai.google.dev/gemini-api/docs/pricing), [Models](https://ai.google.dev/gemini-api/docs/models) |
| Other OpenAI-compatible service | Transcription or writing | Set by whoever runs it, including a local Ollama | Their terms |
| Demo | Trying the app | Nothing leaves the computer. Placeholder text. | None |

Groq's public table shows Developer plan limits, and its free-plan values could not be read from the docs, so EchoMind hardcodes none. It shows the limits the service reports in its responses.

### What a 3-hour recording meets on the free tiers (measured 2026-11-22 and 23)

- **Groq Whisper** reported 7,200 seconds of audio an hour and 28,800 a day. A 3-hour recording (10,800 s) therefore transcribes in about 1 hour 40 minutes, mostly waiting; EchoMind waits by itself and continues. About two and a half such recordings fit in a day.
- **Groq chat** (`gpt-oss-120b`) reported 8,000 tokens a minute and 200,000 a day. A 3-hour summary reads 16 parts at about 5,000 tokens each, one part every 30 seconds or so, about 10 minutes in all and 40% of the day's tokens. Running every AI tool on one 3-hour recording can exceed a day; Gemini is the better choice for very long recordings.
- **Reasoning models** spend hidden "thinking" tokens from the same answer budget. Without a limit, `gpt-oss-120b` once spent 1,498 of 1,500 tokens thinking and wrote nothing, 77 times running. EchoMind now asks Groq's gpt-oss and Gemini's thinking models for low reasoning, which keeps it to a few hundred tokens.
- **Gemini** reads a whole 3-hour transcript in one request. Its free models often answer "high demand" (HTTP 503) for a while, one model at a time; EchoMind then tries the request on its other Gemini models (3.8 Flash, 3.6 Flash, Flash-Lite latest), and otherwise waits and retries.

Gemini transcription uses Google's dedicated model, Gemini 3.5 Transcribe, whose word times come from the audio itself (word_info annotations), not from text the model writes. Checked live on 2026-11-23 against Groq Whisper on the same meeting: every turn started within 0.1 s of Whisper's time, all 12 facts heard, and the two voices told apart with 100% accuracy. Speaker labels restart with each request, so EchoMind sends Gemini 25-minute pieces (it accepts 30 with speakers and word times on).

## How to swap a provider

See "Adding a provider" in [AI_PIPELINE.md](AI_PIPELINE.md).
