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
];
