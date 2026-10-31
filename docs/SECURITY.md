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
| No telemetry | The app makes no network requests of its own. | Code review; Phase 8 adds a network test |

## Planned

| Control | Phase |
| --- | --- |
| Encrypted API keys (`safeStorage`), consent screen before first upload, log scrubbing | 3 |
| App lock, encrypted backups | 8 |

## Rules for contributors

Never log API keys, transcripts or audio paths. Never commit secrets. Deleting a recording must delete everything derived from it. There is no covert recording: capture is always started by the user and is always visibly indicated.
