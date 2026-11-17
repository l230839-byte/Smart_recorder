import { randomUUID } from 'node:crypto';
import type { DocumentExport, DocumentRecord, DocumentVersionInfo } from '@shared/models';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings, type ExportFormat } from '@shared/documents';
import { transaction, type Db } from './database';

interface DocumentRow {
  id: string;
  recording_id: string | null;
  recording_title: string | null;
  title: string;
  template: string;
  settings: string;
  markdown: string;
  dropped_citations: number;
  truncated: number;
  created_at: number;
  updated_at: number;
  versions: number;
}

const DOC_SELECT = `
  SELECT d.*, r.title AS recording_title, (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS versions
  FROM documents d LEFT JOIN recordings r ON r.id = d.recording_id`;

function toDocument(r: DocumentRow): DocumentRecord {
  return {
    id: r.id,
    recordingId: r.recording_id,
    recordingTitle: r.recording_title,
    title: r.title,
    template: r.template,
    // Older documents gain any setting added later, with its default.
    settings: { ...DEFAULT_DOCUMENT_SETTINGS, ...(JSON.parse(r.settings) as Partial<DocumentSettings>) },
    markdown: r.markdown,
    droppedCitations: r.dropped_citations,
    truncated: r.truncated === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    versionCount: r.versions,
  };
}

interface ExportRow {
  id: string;
  document_id: string;
  document_title: string;
  format: ExportFormat;
  file_name: string;
  size_bytes: number;
  created_at: number;
}

export class DocumentRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: { recordingId: string | null; title: string; template: string; settings: DocumentSettings; markdown: string }): string {
    const id = randomUUID();
    const t = this.now();
    this.db
      .prepare('INSERT INTO documents (id, recording_id, title, template, settings, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.recordingId, input.title, input.template, JSON.stringify(input.settings), input.markdown, t, t);
    this.reindex(id);
    return id;
  }

  get(id: string): DocumentRecord | null {
    const row = this.db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
    return row ? toDocument(row) : null;
  }

  list(recordingId?: string): DocumentRecord[] {
    const rows = recordingId
      ? (this.db.prepare(`${DOC_SELECT} WHERE d.recording_id = ? ORDER BY d.updated_at DESC`).all(recordingId) as unknown as DocumentRow[])
      : (this.db.prepare(`${DOC_SELECT} ORDER BY d.updated_at DESC`).all() as unknown as DocumentRow[]);
    return rows.map(toDocument);
  }

  /** The editor's live draft. Saved continually, so nothing typed is ever lost. */
  update(id: string, patch: { title?: string; markdown?: string; settings?: DocumentSettings }): void {
    const changes: [column: string, value: string][] = [];
    if (patch.title !== undefined) changes.push(['title', patch.title.trim() || 'Untitled document']);
    if (patch.markdown !== undefined) changes.push(['markdown', patch.markdown]);
    if (patch.settings !== undefined) changes.push(['settings', JSON.stringify(patch.settings)]);
    if (!changes.length) return;
    const sets = changes.map(([column]) => `${column} = ?`).join(', ');
    this.db.prepare(`UPDATE documents SET ${sets}, updated_at = ? WHERE id = ?`).run(...changes.map(([, value]) => value), this.now(), id);
    if (patch.title !== undefined || patch.markdown !== undefined) this.reindex(id);
  }

  /** The AI's first draft arrives. It is kept as version 1, so the user can always go back to it. */
  setGenerated(id: string, markdown: string, droppedCitations: number, truncated: boolean): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE documents SET markdown = ?, dropped_citations = ?, truncated = ?, updated_at = ? WHERE id = ?').run(markdown, droppedCitations, truncated ? 1 : 0, this.now(), id);
      this.snapshot(id, 'First draft');
    });
    this.reindex(id);
  }

  saveVersion(id: string, label: string): void {
    transaction(this.db, () => this.snapshot(id, label));
  }

  private snapshot(id: string, label: string): void {
    const doc = this.get(id);
    if (!doc) throw new Error('This document no longer exists.');
    const next = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM document_versions WHERE document_id = ?').get(id) as { v: number };
    this.db
      .prepare('INSERT INTO document_versions (id, document_id, version, label, title, markdown, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, next.v, label.trim() || `Version ${next.v}`, doc.title, doc.markdown, JSON.stringify(doc.settings), this.now());
  }

  versions(id: string): DocumentVersionInfo[] {
    const rows = this.db.prepare('SELECT id, version, label, created_at FROM document_versions WHERE document_id = ? ORDER BY version DESC').all(id) as unknown as { id: string; version: number; label: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, version: r.version, label: r.label, createdAt: r.created_at }));
  }

  /** Brings back an old version as the draft. The current draft is saved as a version first, so nothing is lost. */
  restoreVersion(id: string, versionId: string): void {
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT title, markdown, settings FROM document_versions WHERE id = ? AND document_id = ?').get(versionId, id) as { title: string; markdown: string; settings: string } | undefined;
      if (!row) throw new Error('This version no longer exists.');
      this.snapshot(id, 'Before restoring an older version');
      this.db.prepare('UPDATE documents SET title = ?, markdown = ?, settings = ?, updated_at = ? WHERE id = ?').run(row.title, row.markdown, row.settings, this.now(), id);
    });
    this.reindex(id);
  }

  /** Returns the export files the caller must delete. */
  delete(id: string): string[] {
    const files = (this.db.prepare('SELECT file_name FROM document_exports WHERE document_id = ?').all(id) as { file_name: string }[]).map((r) => r.file_name);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM document_search WHERE document_id = ?').run(id);
    });
    return files;
  }

  /** Export files of documents made from these recordings, which must go when the recordings do (prompt §21). */
  exportFilesForRecordings(recordingIds: string[]): string[] {
    const stmt = this.db.prepare('SELECT e.file_name FROM document_exports e JOIN documents d ON d.id = e.document_id WHERE d.recording_id = ?');
    return recordingIds.flatMap((id) => (stmt.all(id) as { file_name: string }[]).map((r) => r.file_name));
  }

  // Exports

  addExport(documentId: string, format: ExportFormat, fileName: string, sizeBytes: number): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO document_exports (id, document_id, format, file_name, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, documentId, format, fileName, sizeBytes, this.now());
    return id;
  }

  exports(): Omit<DocumentExport, 'exists'>[] {
    const rows = this.db
      .prepare('SELECT e.*, d.title AS document_title FROM document_exports e JOIN documents d ON d.id = e.document_id ORDER BY e.created_at DESC, e.rowid DESC')
      .all() as unknown as ExportRow[];
    return rows.map((r) => ({ id: r.id, documentId: r.document_id, documentTitle: r.document_title, format: r.format, fileName: r.file_name, sizeBytes: r.size_bytes, createdAt: r.created_at }));
  }

  getExport(id: string): { fileName: string; format: ExportFormat; documentId: string } | null {
    const row = this.db.prepare('SELECT file_name, format, document_id FROM document_exports WHERE id = ?').get(id) as { file_name: string; format: ExportFormat; document_id: string } | undefined;
    return row ? { fileName: row.file_name, format: row.format, documentId: row.document_id } : null;
  }

  deleteExport(id: string): void {
    this.db.prepare('DELETE FROM document_exports WHERE id = ?').run(id);
  }

  private reindex(id: string): void {
    const doc = this.db.prepare('SELECT recording_id, title, markdown FROM documents WHERE id = ?').get(id) as { recording_id: string | null; title: string; markdown: string } | undefined;
    this.db.prepare('DELETE FROM document_search WHERE document_id = ?').run(id);
    if (!doc?.recording_id) return;
    this.db.prepare('INSERT INTO document_search (recording_id, document_id, text) VALUES (?, ?, ?)').run(doc.recording_id, id, `${doc.title}\n${doc.markdown.replace(/\(cite:\d+\)/g, '')}`);
  }
}
