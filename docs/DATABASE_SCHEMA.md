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

## Migration 4: documents

| Change | Purpose |
| --- | --- |
| `documents` | The editable draft: Markdown plus layout settings (JSON), its template, and the recording it came from (optional) |
| `document_versions` | Snapshots: the first draft, versions the user saves, and the draft kept before a restore |
| `document_exports` | Each exported file, by its name inside the exports folder |
| `document_search` | FTS5 index over documents, so Library search finds them |
| `processing_jobs` | Gains the `document` kind. Its options name the document being written. |

Deleting a recording deletes its documents, their versions and export records by cascade. The app deletes the exported files and the FTS rows at the same time.

## Migration 5: passages and chats

| Change | Purpose |
| --- | --- |
| `transcript_chunks` | FTS5 table of overlapping passages (about 45 to 60 seconds each) of every current transcript, ranked with BM25 for chat. Rebuilt with the transcript; older transcripts are indexed once at launch. |
| `chat_threads` | A chat and its scope: chosen recordings, a collection (set to null if the collection is deleted), or the whole library |
| `chat_thread_recordings` | The recordings a chat is about and every recording whose text it has read, so deleting a recording deletes those chats |
| `chat_messages` | Questions and answers: Markdown with checked citations, whether the recordings answered it, general knowledge kept apart, sources, and what was read |

## Migration 6: AI Studio and tasks

| Change | Purpose |
| --- | --- |
| `studio_outputs` | Every Studio result: its kind, options, and content as JSON (Markdown, flashcards, quiz, mind map or translation) |
| `studio_output_recordings` | The recordings a result came from, in order. Deleting any of them deletes the result. |
| `quiz_attempts` | Answers and score for each attempt at a quiz |
| `tasks` | Action items: found (waiting for review), open, done or dismissed; due date, owner, priority, reminder, and the words and moment they came from |
| `studio_templates` | Saved options for a Studio tool |

Deleting a recording deletes its Studio results and the tasks found in it that were never approved. Approved tasks belong to the user and stay, with the link to the recording and its quoted words removed.
