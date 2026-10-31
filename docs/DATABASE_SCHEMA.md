# Database schema

SQLite at `<user data>/echomind.db`, in WAL mode with foreign keys enforced. Migrations live in `desktop/src/main/db/migrations.ts`. `PRAGMA user_version` records how many have run, and each one commits atomically. Large audio is stored as files, not in the database.

## Migration 1: library

| Table | Purpose |
| --- | --- |
| `settings` | Key-value settings stored as JSON |
| `collections` | Nested folders. Deleting a parent moves its children up to the top level. |
| `recordings` | One row per recording, whatever its source. `source` is informational only. |
| `media_objects` | The audio file of a recording (one row per kind) |
| `waveforms` | Peak data, kept apart so list queries stay light |
| `tags`, `recording_tags` | Case-insensitive unique tags and their links |
| `bookmarks` | Timestamped bookmarks and notes |
| `import_jobs` | Persistent per-file import queue, including retry state |
| `recording_sessions` | Exists from the moment recording starts, for crash recovery |
| `recording_search` | FTS5 index over title, description, tags and notes |

## Migration 2: transcription

| Table | Purpose |
| --- | --- |
| `processing_jobs` | Persistent queue: status, stage, progress, retry time, attempts |
| `job_chunks` | Each piece of a job with its stored result, so nothing is transcribed twice |
| `transcript_versions` | Original and edited versions. A partial unique index allows one current version per recording. |
| `transcript_segments` | Timestamped text, speaker and confidence |
| `speakers` | Names for speaker labels, per recording |
| `ai_usage` | Requests and audio per provider and day |
| `provider_rate` | The latest limits a service reported |
| `provider_consents` | Which providers the user agreed to |
| `secrets` | API keys, encrypted by Windows DPAPI |
| `transcript_search` | FTS5 index over the current version |

Deleting a recording cascades to all of these except the FTS index, which the repository clears in the same transaction.

## Migration 3: summaries

| Change | Purpose |
| --- | --- |
| `processing_jobs.options` | Settings for each job, as JSON |
| `ai_usage.input_tokens`, `output_tokens` | Token counts per provider and day |
| `summaries` | Versioned results, with their settings, model and source transcript version |
| `chapters` | Topic chapters. A new set replaces the old. |
| `ai_suggestions` | Suggested title, tags and topics, waiting for the user |
| `summary_templates` | Reusable settings |
| `summary_search` | FTS5 index over summary text |

Later phases add documents, chat, study material and tasks through new migrations.
