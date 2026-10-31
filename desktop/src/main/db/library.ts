import { randomUUID } from 'node:crypto';
import type { Bookmark, Collection, ImportJob, ImportStatus, LibraryQuery, LibraryStats, Recording, RecordingMode, RecordingSource, Tag } from '@shared/models';
import { transaction, type Db } from './database';

const DAY_MS = 86_400_000;
export const RECENT_WINDOW_MS = 7 * DAY_MS;

interface RecordingRow {
  id: string;
  title: string;
  description: string;
  mode: RecordingMode;
  source: RecordingSource;
  original_name: string | null;
  format: string;
  codec: string;
  duration_ms: number;
  size_bytes: number;
  sample_rate: number;
  channels: number;
  favorite: number;
  archived: number;
  deleted_at: number | null;
  collection_id: string | null;
  created_at: number;
  imported_at: number | null;
  updated_at: number;
  tags_json: string;
  has_transcript: number;
}

const RECORDING_SELECT = `
  SELECT r.*, (
    SELECT json_group_array(json_object('id', t.id, 'name', t.name))
    FROM recording_tags rt JOIN tags t ON t.id = rt.tag_id
    WHERE rt.recording_id = r.id
  ) AS tags_json,
  EXISTS (SELECT 1 FROM transcript_versions v WHERE v.recording_id = r.id) AS has_transcript
  FROM recordings r`;

function toRecording(row: RecordingRow): Recording {
  const tags = JSON.parse(row.tags_json) as Tag[];
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    mode: row.mode,
    source: row.source,
    originalName: row.original_name,
    format: row.format,
    codec: row.codec,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    sampleRate: row.sample_rate,
    channels: row.channels,
    favorite: row.favorite === 1,
    archived: row.archived === 1,
    deletedAt: row.deleted_at,
    collectionId: row.collection_id,
    createdAt: row.created_at,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
    tags: tags.sort((a, b) => a.name.localeCompare(b.name)),
    hasTranscript: row.has_transcript === 1,
  };
}

/** Turns free text into a safe FTS5 prefix query. Every word must match; user syntax is never parsed. */
export function toFtsQuery(text: string): string | null {
  const words = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

const SORT_SQL: Record<LibraryQuery['sort'], string> = {
  newest: 'r.created_at DESC',
  oldest: 'r.created_at ASC',
  title: 'r.title COLLATE NOCASE ASC',
  longest: 'r.duration_ms DESC',
  largest: 'r.size_bytes DESC',
};

export interface NewRecording {
  id?: string;
  title: string;
  description?: string;
  mode: RecordingMode;
  source: RecordingSource;
  originalName?: string | null;
  format: string;
  codec: string;
  durationMs: number;
  sizeBytes: number;
  sampleRate: number;
  channels: number;
  sourceSha256?: string | null;
  collectionId?: string | null;
  fileName: string;
  mime: string;
  peaks: Uint8Array;
  createdAt?: number;
  bookmarks?: { positionMs: number; label: string; note: string | null }[];
}

export type RecordingPatch = Partial<Pick<Recording, 'title' | 'description' | 'mode' | 'collectionId' | 'favorite' | 'archived'>>;

/** All SQL for recordings, tags, bookmarks and collections. No Electron here, so it runs in plain unit tests. */
export class LibraryRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  insertRecording(input: NewRecording): string {
    const id = input.id ?? randomUUID();
    const t = this.now();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO recordings (id, title, description, mode, source, original_name, format, codec, duration_ms, size_bytes,
             sample_rate, channels, source_sha256, collection_id, created_at, imported_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.description ?? '',
          input.mode,
          input.source,
          input.originalName ?? null,
          input.format,
          input.codec,
          Math.round(input.durationMs),
          input.sizeBytes,
          input.sampleRate,
          input.channels,
          input.sourceSha256 ?? null,
          input.collectionId ?? null,
          input.createdAt ?? t,
          input.source === 'native' || input.source === 'recovered' ? null : t,
          t,
        );
      this.db
        .prepare('INSERT INTO media_objects (id, recording_id, kind, file_name, mime, size_bytes) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), id, 'audio', input.fileName, input.mime, input.sizeBytes);
      this.db.prepare('INSERT INTO waveforms (recording_id, peaks) VALUES (?, ?)').run(id, input.peaks);
      const insertBookmark = this.db.prepare('INSERT INTO bookmarks (id, recording_id, position_ms, label, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const b of input.bookmarks ?? []) insertBookmark.run(randomUUID(), id, Math.round(b.positionMs), b.label, b.note, t);
      this.reindex(id);
    });
    return id;
  }

  getRecording(id: string): Recording | null {
    const row = this.db.prepare(`${RECORDING_SELECT} WHERE r.id = ?`).get(id) as RecordingRow | undefined;
    return row ? toRecording(row) : null;
  }

  list(query: LibraryQuery): Recording[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    switch (query.view) {
      case 'trash':
        where.push('r.deleted_at IS NOT NULL');
        break;
      case 'archived':
        where.push('r.deleted_at IS NULL AND r.archived = 1');
        break;
      default:
        where.push('r.deleted_at IS NULL AND r.archived = 0');
    }
    if (query.view === 'recent') {
      where.push('r.created_at >= ?');
      params.push(this.now() - RECENT_WINDOW_MS);
    }
    if (query.view === 'favorites') where.push('r.favorite = 1');
    if (query.view === 'recorded') where.push("r.source IN ('native', 'recovered')");
    if (query.view === 'imported') where.push("r.source NOT IN ('native', 'recovered')");
    if (query.tagId) {
      where.push('EXISTS (SELECT 1 FROM recording_tags x WHERE x.recording_id = r.id AND x.tag_id = ?)');
      params.push(query.tagId);
    }
    if (query.collectionId) {
      where.push(`r.collection_id IN (
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM collections WHERE id = ?
          UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id
        ) SELECT id FROM tree)`);
      params.push(query.collectionId);
    }
    const fts = query.text ? toFtsQuery(query.text) : null;
    if (query.text?.trim() && !fts) return [];
    if (fts) {
      where.push('r.id IN (SELECT recording_id FROM recording_search WHERE recording_search MATCH ? UNION SELECT recording_id FROM transcript_search WHERE transcript_search MATCH ?)');
      params.push(fts, fts);
    }
    const sql = `${RECORDING_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${SORT_SQL[query.sort]}`;
    return (this.db.prepare(sql).all(...params) as unknown as RecordingRow[]).map(toRecording);
  }

  updateRecording(id: string, patch: RecordingPatch): void {
    const columns: Record<keyof RecordingPatch, string> = {
      title: 'title',
      description: 'description',
      mode: 'mode',
      collectionId: 'collection_id',
      favorite: 'favorite',
      archived: 'archived',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(columns) as [keyof RecordingPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE recordings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
    if (patch.title !== undefined || patch.description !== undefined) this.reindex(id);
  }

  setManyFlag(ids: string[], flag: 'favorite' | 'archived', value: boolean): void {
    const stmt = this.db.prepare(`UPDATE recordings SET ${flag} = ?, updated_at = ? WHERE id = ?`);
    transaction(this.db, () => ids.forEach((id) => stmt.run(value ? 1 : 0, this.now(), id)));
  }

  moveToCollection(ids: string[], collectionId: string | null): void {
    const stmt = this.db.prepare('UPDATE recordings SET collection_id = ?, updated_at = ? WHERE id = ?');
    transaction(this.db, () => ids.forEach((id) => stmt.run(collectionId, this.now(), id)));
  }

  trash(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE recordings SET deleted_at = ?, updated_at = ? WHERE id = ?');
    transaction(this.db, () => ids.forEach((id) => stmt.run(this.now(), this.now(), id)));
  }

  restore(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE recordings SET deleted_at = NULL, updated_at = ? WHERE id = ?');
    transaction(this.db, () => ids.forEach((id) => stmt.run(this.now(), id)));
  }

  trashedIds(olderThan?: number): string[] {
    const rows = this.db.prepare('SELECT id FROM recordings WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(olderThan ?? Number.MAX_SAFE_INTEGER) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Removes rows (children cascade) and returns the files the caller must delete. */
  deleteForever(ids: string[]): string[] {
    const files: string[] = [];
    const getFiles = this.db.prepare('SELECT file_name FROM media_objects WHERE recording_id = ?');
    const remove = this.db.prepare('DELETE FROM recordings WHERE id = ?');
    const removeSearch = this.db.prepare('DELETE FROM recording_search WHERE recording_id = ?');
    const removeTranscriptSearch = this.db.prepare('DELETE FROM transcript_search WHERE recording_id = ?');
    transaction(this.db, () => {
      for (const id of ids) {
        files.push(...(getFiles.all(id) as { file_name: string }[]).map((r) => r.file_name));
        remove.run(id);
        removeSearch.run(id);
        removeTranscriptSearch.run(id);
      }
      this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM recording_tags)');
    });
    return files;
  }

  /** A trashed copy does not count, so a file can be imported again after deleting it. */
  findBySha(sha256: string): Recording | null {
    const row = this.db.prepare(`${RECORDING_SELECT} WHERE r.source_sha256 = ? AND r.deleted_at IS NULL LIMIT 1`).get(sha256) as RecordingRow | undefined;
    return row ? toRecording(row) : null;
  }

  mediaFile(recordingId: string): { fileName: string; mime: string } | null {
    const row = this.db.prepare("SELECT file_name, mime FROM media_objects WHERE recording_id = ? AND kind = 'audio'").get(recordingId) as { file_name: string; mime: string } | undefined;
    return row ? { fileName: row.file_name, mime: row.mime } : null;
  }

  peaks(recordingId: string): Uint8Array | null {
    const row = this.db.prepare('SELECT peaks FROM waveforms WHERE recording_id = ?').get(recordingId) as { peaks: Uint8Array } | undefined;
    return row ? new Uint8Array(row.peaks) : null;
  }

  stats(): LibraryStats {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(duration_ms), 0) AS d, COALESCE(SUM(size_bytes), 0) AS s FROM recordings WHERE deleted_at IS NULL')
      .get() as { c: number; d: number; s: number };
    return { recordings: row.c, totalDurationMs: row.d, totalBytes: row.s };
  }

  storageTotals(): { mediaBytes: number; trashBytes: number; trashCount: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total,
                COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN size_bytes END), 0) AS trash,
                COALESCE(SUM(deleted_at IS NOT NULL), 0) AS trash_count
         FROM recordings`,
      )
      .get() as { total: number; trash: number; trash_count: number };
    return { mediaBytes: row.total, trashBytes: row.trash, trashCount: row.trash_count };
  }

  largest(limit: number): Recording[] {
    return (this.db.prepare(`${RECORDING_SELECT} WHERE r.deleted_at IS NULL ORDER BY r.size_bytes DESC LIMIT ?`).all(limit) as unknown as RecordingRow[]).map(toRecording);
  }

  // Tags

  /** Only tags on recordings the current view can show, so a filter chip never leads to an empty list. */
  tagsInUse(trashed: boolean): Tag[] {
    return this.db
      .prepare(
        `SELECT DISTINCT t.id, t.name FROM tags t
         JOIN recording_tags rt ON rt.tag_id = t.id
         JOIN recordings r ON r.id = rt.recording_id
         WHERE (r.deleted_at IS NOT NULL) = ?
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all(trashed ? 1 : 0) as unknown as Tag[];
  }

  addTag(recordingId: string, rawName: string): void {
    const name = rawName.trim().replace(/^#+/, '').trim();
    if (!name) return;
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)').run(randomUUID(), name);
      const tag = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: string };
      this.db.prepare('INSERT OR IGNORE INTO recording_tags (recording_id, tag_id) VALUES (?, ?)').run(recordingId, tag.id);
      this.reindex(recordingId);
    });
  }

  removeTag(recordingId: string, tagId: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM recording_tags WHERE recording_id = ? AND tag_id = ?').run(recordingId, tagId);
      this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM recording_tags)');
      this.reindex(recordingId);
    });
  }

  // Bookmarks

  bookmarks(recordingId: string): Bookmark[] {
    const rows = this.db.prepare('SELECT * FROM bookmarks WHERE recording_id = ? ORDER BY position_ms').all(recordingId) as unknown as {
      id: string;
      recording_id: string;
      position_ms: number;
      label: string;
      note: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({ id: r.id, recordingId: r.recording_id, positionMs: r.position_ms, label: r.label, note: r.note, createdAt: r.created_at }));
  }

  addBookmark(recordingId: string, positionMs: number, label: string, note: string | null): void {
    this.db.prepare('INSERT INTO bookmarks (id, recording_id, position_ms, label, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), recordingId, Math.round(positionMs), label, note, this.now());
    this.reindex(recordingId);
  }

  deleteBookmark(id: string): void {
    const row = this.db.prepare('SELECT recording_id FROM bookmarks WHERE id = ?').get(id) as { recording_id: string } | undefined;
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    if (row) this.reindex(row.recording_id);
  }

  // Collections

  collections(): Collection[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.parent_id, c.created_at,
           (SELECT COUNT(*) FROM recordings r WHERE r.collection_id = c.id AND r.deleted_at IS NULL) AS n
         FROM collections c ORDER BY c.name COLLATE NOCASE`,
      )
      .all() as unknown as { id: string; name: string; parent_id: string | null; created_at: number; n: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at, recordingCount: r.n }));
  }

  createCollection(name: string, parentId: string | null): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO collections (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)').run(id, name.trim(), parentId, this.now());
    return id;
  }

  renameCollection(id: string, name: string): void {
    this.db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name.trim(), id);
  }

  /** Refuses to move a collection inside itself, which would detach the whole branch. */
  moveCollection(id: string, parentId: string | null): void {
    if (parentId) {
      const inside = this.db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM collections WHERE id = ?
             UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id
           ) SELECT 1 FROM tree WHERE id = ?`,
        )
        .get(id, parentId);
      if (inside) throw new Error('A collection cannot be moved inside itself.');
    }
    this.db.prepare('UPDATE collections SET parent_id = ? WHERE id = ?').run(parentId, id);
  }

  /** Children move up one level and recordings stay in the library. */
  deleteCollection(id: string): void {
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT parent_id FROM collections WHERE id = ?').get(id) as { parent_id: string | null } | undefined;
      if (!row) return;
      this.db.prepare('UPDATE collections SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, id);
      this.db.prepare('UPDATE recordings SET collection_id = ? WHERE collection_id = ?').run(row.parent_id, id);
      this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    });
  }

  private reindex(id: string): void {
    const r = this.db.prepare('SELECT title, description FROM recordings WHERE id = ?').get(id) as { title: string; description: string } | undefined;
    this.db.prepare('DELETE FROM recording_search WHERE recording_id = ?').run(id);
    if (!r) return;
    const tags = this.db.prepare('SELECT t.name FROM tags t JOIN recording_tags rt ON rt.tag_id = t.id WHERE rt.recording_id = ?').all(id) as { name: string }[];
    const notes = this.db.prepare('SELECT label, note FROM bookmarks WHERE recording_id = ?').all(id) as { label: string; note: string | null }[];
    this.db
      .prepare('INSERT INTO recording_search (recording_id, title, description, tags, notes) VALUES (?, ?, ?, ?, ?)')
      .run(id, r.title, r.description, tags.map((t) => t.name).join(' '), notes.map((n) => `${n.label} ${n.note ?? ''}`).join(' '));
  }
}

interface ImportRow {
  id: string;
  batch_id: string;
  source_path: string;
  source_kind: RecordingSource;
  display_name: string;
  size_bytes: number | null;
  status: ImportStatus;
  progress: number;
  error: string | null;
  retryable: number;
  recording_id: string | null;
  duplicate_of: string | null;
  mode: RecordingMode;
  created_at: number;
}

export interface QueuedImport extends ImportJob {
  sourcePath: string;
  sourceKind: RecordingSource;
}

function toImportJob(r: ImportRow): QueuedImport {
  return {
    id: r.id,
    batchId: r.batch_id,
    sourcePath: r.source_path,
    sourceKind: r.source_kind,
    displayName: r.display_name,
    sizeBytes: r.size_bytes,
    status: r.status,
    progress: r.progress,
    error: r.error,
    retryable: r.retryable === 1,
    recordingId: r.recording_id,
    duplicateOf: r.duplicate_of,
    mode: r.mode,
    createdAt: r.created_at,
  };
}

export class ImportRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  add(batchId: string, sourcePath: string, displayName: string, sizeBytes: number | null, kind: RecordingSource, mode: RecordingMode): string {
    const id = randomUUID();
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO import_jobs (id, batch_id, source_path, source_kind, display_name, size_bytes, status, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, batchId, sourcePath, kind, displayName, sizeBytes, mode, t, t);
    return id;
  }

  list(): QueuedImport[] {
    return (this.db.prepare('SELECT * FROM import_jobs ORDER BY created_at DESC, rowid DESC').all() as unknown as ImportRow[]).map(toImportJob);
  }

  get(id: string): QueuedImport | null {
    const row = this.db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(id) as ImportRow | undefined;
    return row ? toImportJob(row) : null;
  }

  nextQueued(): QueuedImport | null {
    const row = this.db.prepare("SELECT * FROM import_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get() as ImportRow | undefined;
    return row ? toImportJob(row) : null;
  }

  setStatus(id: string, status: ImportStatus, progress: number): void {
    this.db.prepare('UPDATE import_jobs SET status = ?, progress = ?, updated_at = ? WHERE id = ?').run(status, progress, this.now(), id);
  }

  setProgress(id: string, progress: number): void {
    this.db.prepare('UPDATE import_jobs SET progress = ?, updated_at = ? WHERE id = ?').run(progress, this.now(), id);
  }

  finish(id: string, recordingId: string, warning: string | null): void {
    this.db.prepare("UPDATE import_jobs SET status = 'done', progress = 1, recording_id = ?, error = ?, updated_at = ? WHERE id = ?").run(recordingId, warning, this.now(), id);
  }

  duplicate(id: string, recordingId: string): void {
    this.db.prepare("UPDATE import_jobs SET status = 'duplicate', progress = 1, duplicate_of = ?, updated_at = ? WHERE id = ?").run(recordingId, this.now(), id);
  }

  fail(id: string, error: string, retryable: boolean): void {
    this.db.prepare("UPDATE import_jobs SET status = 'failed', error = ?, retryable = ?, updated_at = ? WHERE id = ?").run(error, retryable ? 1 : 0, this.now(), id);
  }

  requeue(id: string): void {
    this.db.prepare("UPDATE import_jobs SET status = 'queued', progress = 0, error = NULL, retryable = 1, updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Jobs cut off by a crash or quit go back in the queue. */
  requeueInterrupted(): void {
    this.db.prepare("UPDATE import_jobs SET status = 'queued', progress = 0, updated_at = ? WHERE status IN ('copying', 'checking', 'converting')").run(this.now());
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM import_jobs WHERE id = ?').run(id);
  }

  clearFinished(): void {
    this.db.prepare("DELETE FROM import_jobs WHERE status IN ('done', 'duplicate')").run();
  }
}

export interface SessionRow {
  id: string;
  title: string;
  mode: RecordingMode;
  description: string;
  bookmarks: { positionMs: number; label: string; note: string | null }[];
  startedAt: number;
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  create(session: Omit<SessionRow, 'bookmarks' | 'description'>): void {
    this.db.prepare('INSERT INTO recording_sessions (id, title, mode, started_at) VALUES (?, ?, ?, ?)').run(session.id, session.title, session.mode, session.startedAt);
  }

  get(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(id) as { id: string; title: string; mode: RecordingMode; description: string; bookmarks: string; started_at: number } | undefined;
    if (!row) return null;
    return { id: row.id, title: row.title, mode: row.mode, description: row.description, bookmarks: JSON.parse(row.bookmarks), startedAt: row.started_at };
  }

  all(): SessionRow[] {
    return (this.db.prepare('SELECT id FROM recording_sessions').all() as { id: string }[]).map((r) => this.get(r.id)!);
  }

  update(id: string, patch: { title?: string; description?: string }): void {
    if (patch.title !== undefined) this.db.prepare('UPDATE recording_sessions SET title = ? WHERE id = ?').run(patch.title, id);
    if (patch.description !== undefined) this.db.prepare('UPDATE recording_sessions SET description = ? WHERE id = ?').run(patch.description, id);
  }

  addBookmark(id: string, bookmark: SessionRow['bookmarks'][number]): void {
    const session = this.get(id);
    if (!session) return;
    this.db.prepare('UPDATE recording_sessions SET bookmarks = ? WHERE id = ?').run(JSON.stringify([...session.bookmarks, bookmark]), id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM recording_sessions WHERE id = ?').run(id);
  }
}
