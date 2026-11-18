/**
 * Ordered, append-only schema migrations. `PRAGMA user_version` records how many have run.
 * Never edit a migration that has shipped; add a new one.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: settings and the recording library */ `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_collections_parent ON collections(parent_id);

  CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL,
    source TEXT NOT NULL,
    original_name TEXT,
    format TEXT NOT NULL,
    codec TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sample_rate INTEGER NOT NULL DEFAULT 0,
    channels INTEGER NOT NULL DEFAULT 0,
    source_sha256 TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    imported_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_recordings_created ON recordings(created_at);
  CREATE INDEX idx_recordings_collection ON recordings(collection_id);
  CREATE INDEX idx_recordings_deleted ON recordings(deleted_at);
  CREATE INDEX idx_recordings_sha ON recordings(source_sha256);

  CREATE TABLE media_objects (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('audio')),
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    UNIQUE (recording_id, kind)
  ) STRICT;

  CREATE TABLE waveforms (
    recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    peaks BLOB NOT NULL
  ) STRICT;

  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  ) STRICT;

  CREATE TABLE recording_tags (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (recording_id, tag_id)
  ) STRICT;
  CREATE INDEX idx_recording_tags_tag ON recording_tags(tag_id);

  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
    label TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_bookmarks_recording ON bookmarks(recording_id, position_ms);

  CREATE TABLE import_jobs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    display_name TEXT NOT NULL,
    size_bytes INTEGER,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    retryable INTEGER NOT NULL DEFAULT 1,
    recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL,
    duplicate_of TEXT REFERENCES recordings(id) ON DELETE SET NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_import_jobs_status ON import_jobs(status);

  -- A session row and its audio file exist from the moment recording starts, so a crash loses at most
  -- the last second of audio and no bookmarks.
  CREATE TABLE recording_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    bookmarks TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER NOT NULL
  ) STRICT;

  CREATE VIRTUAL TABLE recording_search USING fts5(
    recording_id UNINDEXED, title, description, tags, notes,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  /* 2: transcription, jobs, usage, consent and encrypted secrets */ `
  CREATE TABLE processing_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    retryable INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    language TEXT NOT NULL,
    next_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_jobs_status ON processing_jobs(status, next_attempt_at);
  CREATE INDEX idx_jobs_recording ON processing_jobs(recording_id);

  -- Finished pieces are kept until the whole job is done, so nothing is transcribed twice.
  CREATE TABLE job_chunks (
    job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    result TEXT,
    language TEXT,
    PRIMARY KEY (job_id, idx)
  ) STRICT;

  CREATE TABLE transcript_versions (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('original', 'edited')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    language TEXT,
    is_current INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (recording_id, version)
  ) STRICT;
  CREATE UNIQUE INDEX idx_transcript_one_current ON transcript_versions(recording_id) WHERE is_current = 1;

  CREATE TABLE transcript_segments (
    version_id TEXT NOT NULL REFERENCES transcript_versions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    confidence REAL,
    PRIMARY KEY (version_id, idx)
  ) STRICT;

  CREATE TABLE speakers (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    display_name TEXT NOT NULL,
    PRIMARY KEY (recording_id, label)
  ) STRICT;

  CREATE TABLE ai_usage (
    provider TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    audio_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, day)
  ) STRICT;

  CREATE TABLE provider_rate (
    provider TEXT PRIMARY KEY,
    info TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE provider_consents (
    provider TEXT PRIMARY KEY,
    accepted_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value BLOB NOT NULL
  ) STRICT;

  CREATE VIRTUAL TABLE transcript_search USING fts5(
    recording_id UNINDEXED, segment_idx UNINDEXED, start_ms UNINDEXED, text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  /* 3: summaries, chapters, suggestions, templates */ `
  ALTER TABLE processing_jobs ADD COLUMN options TEXT;
  ALTER TABLE ai_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ai_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    label TEXT NOT NULL,
    options TEXT NOT NULL,
    markdown TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    transcript_version_id TEXT REFERENCES transcript_versions(id) ON DELETE SET NULL,
    dropped_citations INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (recording_id, version)
  ) STRICT;

  CREATE TABLE chapters (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    transcript_version_id TEXT REFERENCES transcript_versions(id) ON DELETE SET NULL,
    PRIMARY KEY (recording_id, idx)
  ) STRICT;

  CREATE TABLE ai_suggestions (
    recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE summary_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    options TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE VIRTUAL TABLE summary_search USING fts5(
    recording_id UNINDEXED, summary_id UNINDEXED, text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  /* 4: documents, their versions and exported files */ `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    template TEXT NOT NULL,
    settings TEXT NOT NULL,
    markdown TEXT NOT NULL,
    dropped_citations INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_documents_recording ON documents(recording_id);

  CREATE TABLE document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    label TEXT NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    settings TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (document_id, version)
  ) STRICT;

  CREATE TABLE document_exports (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_document_exports_document ON document_exports(document_id);

  CREATE VIRTUAL TABLE document_search USING fts5(
    recording_id UNINDEXED, document_id UNINDEXED, text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  /* 5: passages for retrieval, and chats */ `
  CREATE VIRTUAL TABLE transcript_chunks USING fts5(
    recording_id UNINDEXED, first_idx UNINDEXED, last_idx UNINDEXED, start_ms UNINDEXED, end_ms UNINDEXED, text,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('recordings', 'collection', 'library')),
    collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  -- Every recording a chat is about or has quoted, so deleting a recording can delete those chats.
  CREATE TABLE chat_thread_recordings (
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    in_scope INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, recording_id)
  ) STRICT;
  CREATE INDEX idx_chat_thread_recordings_recording ON chat_thread_recordings(recording_id);

  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    error TEXT,
    found TEXT CHECK (found IN ('yes', 'partly', 'no')),
    general TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]',
    read_note TEXT NOT NULL DEFAULT '',
    dropped_citations INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at);
  `,

  /* 6: AI Studio results, quiz attempts, tasks and Studio templates */ `
  CREATE TABLE studio_outputs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    options TEXT NOT NULL,
    content TEXT,
    dropped_citations INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- The recordings a result was made from. Deleting any of them deletes the result.
  CREATE TABLE studio_output_recordings (
    output_id TEXT NOT NULL REFERENCES studio_outputs(id) ON DELETE CASCADE,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (output_id, recording_id)
  ) STRICT;
  CREATE INDEX idx_studio_output_recordings_recording ON studio_output_recordings(recording_id);

  CREATE TABLE quiz_attempts (
    id TEXT PRIMARY KEY,
    output_id TEXT NOT NULL REFERENCES studio_outputs(id) ON DELETE CASCADE,
    answers TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- Approved tasks belong to the user and outlive their recording; the link and quote are cleared.
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL,
    start_ms INTEGER,
    source_text TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    due_text TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    status TEXT NOT NULL CHECK (status IN ('suggested', 'open', 'done', 'dismissed')),
    remind_at INTEGER,
    reminded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  ) STRICT;
  CREATE INDEX idx_tasks_status ON tasks(status, due_date);
  CREATE INDEX idx_tasks_recording ON tasks(recording_id);
  CREATE INDEX idx_tasks_remind ON tasks(remind_at) WHERE reminded = 0;

  CREATE TABLE studio_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    kind TEXT NOT NULL,
    options TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  `,

  /* 7: app lock. One row; the PIN is stored only as a salted scrypt hash. */ `
  CREATE TABLE app_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt BLOB NOT NULL,
    hash BLOB NOT NULL,
    auto_lock_minutes INTEGER NOT NULL DEFAULT 5,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  `,
];
