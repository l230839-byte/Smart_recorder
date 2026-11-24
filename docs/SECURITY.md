# Security and privacy

Every recording is treated as sensitive private data.

## In place

| Control | Detail | Verified by |
| --- | --- | --- |
| Offline by default | `offlineOnly` starts on. Turning it off needs a confirmation and still sends nothing by itself. | `foundation.spec.ts`, `database.test.ts` |
| Renderer isolation | `sandbox`, `contextIsolation`, no `nodeIntegration`. The UI can only reach the listed API methods. | `foundation.spec.ts` |
| Content Security Policy | `default-src 'none'`, with only the app's own scripts, styles and fonts. No inline script, no network origins. | `foundation.spec.ts` |
| Navigation lockdown | The window cannot navigate elsewhere, open child windows or attach webviews. Only `https://` links open, in the system browser. | Code review |
| Permissions | Audio capture is the only permission ever granted. Camera is refused. | Code review |
| Media access | The player and worker use a recording id or numbered handle. No path from the UI reaches the disk, except files the user chose to import. | Code review |
| Close guard | Closing the window during a recording asks first, and stop and save keeps the audio. | `media-pipeline.spec.ts` |
| Sleep guard | Recording blocks system sleep. | Code review |
| Permanent delete | Removes the audio file, bookmarks, tags, waveform and search entries. | `library.test.ts`, `media-pipeline.spec.ts` |
| Encrypted keys | Stored only through Windows DPAPI and never returned to the UI. Refuses to save if encryption is unavailable. | `transcription.test.ts`, `transcription.spec.ts` |
| Consent gate | Offline only, key and agreement are checked at request and again just before sending. Consent is separate for audio and text. | `transcription.test.ts`, `transcription.spec.ts` (a real server counts requests) |
| Encrypted transport | Provider addresses must be `https://`. `http://` is accepted only for this computer. | `transcription.test.ts` |
| FFmpeg sandboxing | Separate process with no shell, files only, playlist-type containers refused. Runs only on copies EchoMind made. | `ffmpeg.spec.ts` (HLS, concat and SDP tricks are all refused) |
| Offline Whisper | whisper.cpp runs as a separate process with no shell, on a copy of the audio EchoMind wrote and a model file it checked; it has no network use. Its own binary is pinned and hash-checked at build time. | `local-whisper.test.ts`, `tests/live/local-whisper.spec.ts` (runs with Offline only on) |
| Offline writing server | llama.cpp's server is started by EchoMind bound to 127.0.0.1 on a random free port (unreachable from other computers), with its web page turned off, one model, no shell; it is stopped when idle and when EchoMind quits. | `tests/live/offline-ai.spec.ts` |
| Offline only | With Offline only on, every AI feature uses the providers on this computer; none can reach the network. Downloading a model is the one exception, and EchoMind asks first. | `transcription.test.ts`, `summaries.test.ts`, `providers.test.ts` |
| Model downloads | Only when the person asks, only from huggingface.co/ggerganov/whisper.cpp over https, checked against the published SHA-256 before the file gets its usable name; a mismatch is deleted. With Offline only on, EchoMind asks first. Nothing from recordings is sent. | `local-whisper.test.ts` |
| IPC sender checks | App API calls must come from the main window, and file handles from the media worker. | Code review |
| AI output rendering | Parsed into data and built as elements. No HTML injection, and only citation links survive. | `summaries.test.ts` |
| Prompt injection defense | The transcript is declared to be data, and citations are verified after the reply. It lowers the risk but cannot remove it. | `summaries.test.ts` |
| Trash stops AI work | Trashing or deleting a recording cancels its jobs. | `transcription.spec.ts` |
| Document preview | Served from an internal scheme with its own CSP: no script, no network, only inline styles and embedded fonts. Shown in an iframe sandboxed with no permissions. Every piece of text is escaped. | `documents.test.ts` (hostile titles and Markdown), `documents.spec.ts` |
| Exported files | Written only inside the app's exports folder, under names made safe for Windows. Opening and copying look files up by id, never by a path from the UI. | `documents.test.ts` |
| CSV formulas | Cells starting with `=`, `+`, `-` or `@` get a leading quote, so a transcript cannot run a formula in a spreadsheet. | `documents.test.ts` |
| Chat grounding | Transcript text is declared to be data, not instructions. Citations are checked against the exact lines sent; others are removed and counted. Answers with no checkable source are flagged. | `chat.test.ts` |
| Chat privacy | A chat sends only the question, recent turns and the chosen passages, after the same offline, key and consent checks as other AI work. Deleting a recording deletes every chat that read any of it. | `chat.test.ts`, `chat.spec.ts` |
| Search snippets | Matches are marked with control characters and shown as text, never as HTML. | `chat.test.ts`, `chat.spec.ts` |
| Live tests | Keys come from `desktop/.env.live`, which git ignores. Only generated speech is sent. | `.gitignore` |
| Tasks stay local | Found tasks need approval. Reminders are local notifications. Nothing is added to a calendar or sent to anyone (§14). | `studio.test.ts`, `studio.spec.ts` |
| Studio grounding | Every flashcard, question, map point and task must point at a real transcript line; invalid ones are removed and counted. Explanations beyond the recording are labelled. | `studio.test.ts` |
| App lock | PIN of 4 to 12 digits stored as a salted scrypt hash. While locked the main process refuses every API call except unlocking (and saving an ongoing recording), the media and document schemes return 403, and notifications hide titles. 5 free attempts, then waits from 30 seconds doubling to 15 minutes, kept across restarts. It is not disk encryption: use BitLocker for that. | `safety.test.ts`, `safety.spec.ts` |
| Backups | AES-256-GCM with a key from scrypt (N=2^16) and a fresh salt and IV per backup. A small encrypted check finds a wrong password at once; the GCM tag finds tampering, and then nothing extracted is kept. Restores are unpacked aside and swapped in at the next launch, keeping the previous library. Keys and the app lock are not included. | `safety.test.ts`, `safety.spec.ts` |
| Archive safety | Entry names are checked (no `..`, absolute paths, drive letters or control characters) and sizes limited, so a crafted backup or bundle cannot write outside its folder or fill the disk. Bundle manifests are validated field by field, and their audio goes through the normal import checks. | `safety.test.ts` |
| Logging | All main-process logging goes through `log.ts`, which removes file paths and key-like strings. Only starts, quits, crashes and errors are written to `logs/echomind.log` in the data folder (512 KB, one older copy kept); no recording, transcript or key content. | `safety.test.ts`, `safety.spec.ts` |
| Network | With demo providers, a full session (import, transcribe, summarize, chat, PDF, playback) makes no external request. | `safety.spec.ts` |
| No telemetry | The app makes no network requests of its own. | Code review; Phase 8 adds a network test |

## Not done

| Control | Why |
| --- | --- |
| Code signing | Certificates are paid, and EchoMind uses free tools only. See RELEASE.md. |

## Rules for contributors

Never log API keys, transcripts or audio paths. Never commit secrets. Deleting a recording must delete everything derived from it. There is no covert recording: capture is always started by the user and is always visibly indicated.
