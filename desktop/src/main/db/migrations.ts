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
];
