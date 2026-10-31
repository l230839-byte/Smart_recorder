import { randomUUID } from 'node:crypto';
import type { Summary, SummaryTemplate } from '@shared/models';
import type { Chapter, Suggestions, SummaryOptions } from '@shared/summaries';
import { transaction, type Db } from './database';

interface SummaryRow {
  id: string;
  recording_id: string;
  version: number;
  label: string;
  options: string;
  markdown: string;
  provider: string;
  model: string;
  transcript_version_id: string | null;
  dropped_citations: number;
  truncated: number;
  created_at: number;
}

function toSummary(r: SummaryRow): Summary {
  return {
    id: r.id,
    recordingId: r.recording_id,
    version: r.version,
    label: r.label,
    options: JSON.parse(r.options) as SummaryOptions,
    markdown: r.markdown,
    provider: r.provider,
    model: r.model,
    transcriptVersionId: r.transcript_version_id,
    droppedCitations: r.dropped_citations,
    truncated: r.truncated === 1,
    createdAt: r.created_at,
  };
}

export class SummaryRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  add(input: { recordingId: string; label: string; options: SummaryOptions; markdown: string; provider: string; model: string; transcriptVersionId: string | null; droppedCitations: number; truncated: boolean }): string {
    const id = randomUUID();
    transaction(this.db, () => {
      const next = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM summaries WHERE recording_id = ?').get(input.recordingId) as { v: number };
      this.db
        .prepare('INSERT INTO summaries (id, recording_id, version, label, options, markdown, provider, model, transcript_version_id, dropped_citations, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.recordingId, next.v, input.label, JSON.stringify(input.options), input.markdown, input.provider, input.model, input.transcriptVersionId, input.droppedCitations, input.truncated ? 1 : 0, this.now());
      this.db.prepare('INSERT INTO summary_search (recording_id, summary_id, text) VALUES (?, ?, ?)').run(input.recordingId, id, input.markdown.replace(/\(cite:\d+\)/g, ''));
    });
    return id;
  }

  list(recordingId: string): Summary[] {
    return (this.db.prepare('SELECT * FROM summaries WHERE recording_id = ? ORDER BY version DESC').all(recordingId) as unknown as SummaryRow[]).map(toSummary);
  }

  delete(id: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM summary_search WHERE summary_id = ?').run(id);
    });
  }

  get(id: string): Summary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow | undefined;
    return row ? toSummary(row) : null;
  }

  // Chapters belong to the transcript they were made from, and a new set replaces the old one.

  saveChapters(recordingId: string, transcriptVersionId: string | null, chapters: Chapter[]): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM chapters WHERE recording_id = ?').run(recordingId);
      const insert = this.db.prepare('INSERT INTO chapters (recording_id, idx, start_ms, end_ms, title, summary, transcript_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const c of chapters) insert.run(recordingId, c.idx, c.startMs, c.endMs, c.title, c.summary, transcriptVersionId);
    });
  }

  chapters(recordingId: string): Chapter[] {
    const rows = this.db.prepare('SELECT idx, start_ms, end_ms, title, summary FROM chapters WHERE recording_id = ? ORDER BY idx').all(recordingId) as unknown as { idx: number; start_ms: number; end_ms: number; title: string; summary: string }[];
    return rows.map((r) => ({ idx: r.idx, startMs: r.start_ms, endMs: r.end_ms, title: r.title, summary: r.summary }));
  }

  // Suggestions wait for the user: nothing changes in the library until they accept (prompt §12).

  saveSuggestions(recordingId: string, suggestions: Suggestions): void {
    this.db.prepare('INSERT OR REPLACE INTO ai_suggestions (recording_id, value, created_at) VALUES (?, ?, ?)').run(recordingId, JSON.stringify(suggestions), this.now());
  }

  suggestions(recordingId: string): Suggestions | null {
    const row = this.db.prepare('SELECT value FROM ai_suggestions WHERE recording_id = ?').get(recordingId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Suggestions) : null;
  }

  dismissSuggestions(recordingId: string): void {
    this.db.prepare('DELETE FROM ai_suggestions WHERE recording_id = ?').run(recordingId);
  }

  // Reusable templates (prompt §15.5)

  templates(): SummaryTemplate[] {
    const rows = this.db.prepare('SELECT id, name, options FROM summary_templates ORDER BY name COLLATE NOCASE').all() as unknown as { id: string; name: string; options: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, options: JSON.parse(r.options) as SummaryOptions }));
  }

  saveTemplate(name: string, options: SummaryOptions): string {
    const id = randomUUID();
    // A template is reusable across recordings, so it must not remember one recording's time range.
    const reusable: SummaryOptions = { ...options, scope: { kind: 'all' } };
    this.db.prepare('INSERT INTO summary_templates (id, name, options, created_at) VALUES (?, ?, ?, ?)').run(id, name.trim(), JSON.stringify(reusable), this.now());
    return id;
  }

  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM summary_templates WHERE id = ?').run(id);
  }
}
