import { scopeLabel, type ChatScope } from '@shared/chat';
import { MATCH_END, MATCH_START, type SearchHit, type SearchKind, type SearchQuery, type SearchResult } from '@shared/search';
import type { Db } from './database';
import { toFtsQuery } from './library';

export interface PassageHit {
  recordingId: string;
  firstIdx: number;
  lastIdx: number;
  startMs: number;
  endMs: number;
}

const COLLECTION_TREE = `WITH RECURSIVE tree(id) AS (
  SELECT id FROM collections WHERE id = ?
  UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id
) SELECT id FROM tree`;

const SNIPPET = (table: string, column: number, tokens = 14) => `snippet(${table}, ${column}, '${MATCH_START}', '${MATCH_END}', '…', ${tokens})`;

/** How much a match in each place says about a recording. A title match matters more than one line. */
const WEIGHT: Record<SearchKind, number> = { title: 3, chapter: 2, speaker: 2, summary: 1.5, document: 1.5, transcript: 1 };
const HITS_SHOWN: Record<SearchKind, number> = { title: 1, chapter: 2, speaker: 1, summary: 1, document: 2, transcript: 3 };
const ORDER: SearchKind[] = ['title', 'speaker', 'chapter', 'transcript', 'summary', 'document'];
const MAX_RESULTS = 60;

/** Retrieval for chat, and search across everything. Trashed recordings are never included. */
export class KnowledgeRepository {
  constructor(private readonly db: Db) {}

  /** The recordings a chat covers, newest first, leaving out the trash. */
  scopeRecordingIds(scope: ChatScope): string[] {
    if (scope.kind === 'recordings') {
      const rows = this.db.prepare('SELECT id FROM recordings WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, rowid DESC').all(JSON.stringify(scope.recordingIds)) as { id: string }[];
      return rows.map((r) => r.id);
    }
    if (scope.kind === 'collection') {
      if (!scope.collectionId) return [];
      const rows = this.db.prepare(`SELECT id FROM recordings WHERE deleted_at IS NULL AND collection_id IN (${COLLECTION_TREE}) ORDER BY created_at DESC, rowid DESC`).all(scope.collectionId) as { id: string }[];
      return rows.map((r) => r.id);
    }
    return (this.db.prepare('SELECT id FROM recordings WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC').all() as { id: string }[]).map((r) => r.id);
  }

  /** A scope's name for display, such as a recording's title or "Collection: Semester 1". */
  scopeLabel(scope: ChatScope): string {
    const recordings =
      scope.kind === 'recordings' ? (this.db.prepare('SELECT title FROM recordings WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(scope.recordingIds)) as { title: string }[]).map((r) => r.title) : [];
    const collection = scope.kind === 'collection' ? ((this.db.prepare('SELECT name FROM collections WHERE id = ?').get(scope.collectionId) as { name: string } | undefined)?.name ?? null) : null;
    return scopeLabel(scope, { recordings, collection });
  }

  /** Passages matching an FTS5 query, best first by BM25, within the given recordings. */
  searchPassages(ftsQuery: string, recordingIds: string[], limit = 30): PassageHit[] {
    if (!recordingIds.length) return [];
    const rows = this.db
      .prepare(
        `SELECT recording_id, first_idx, last_idx, start_ms, end_ms FROM transcript_chunks
         WHERE transcript_chunks MATCH ? AND recording_id IN (SELECT value FROM json_each(?))
         ORDER BY bm25(transcript_chunks) LIMIT ?`,
      )
      .all(ftsQuery, JSON.stringify(recordingIds), limit) as { recording_id: string; first_idx: number; last_idx: number; start_ms: number; end_ms: number }[];
    return rows.map((r) => ({ recordingId: r.recording_id, firstIdx: Number(r.first_idx), lastIdx: Number(r.last_idx), startMs: Number(r.start_ms), endMs: Number(r.end_ms) }));
  }

  /**
   * Every kind of content at once: names, descriptions, tags and notes, transcript lines, chapters,
   * speaker names, summaries and documents. Results are grouped by recording with their best snippets.
   */
  search(query: SearchQuery): SearchResult[] {
    const fts = toFtsQuery(query.text);
    const words = query.text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
    if (!fts || !words.length) return [];

    const filter: string[] = ['r.deleted_at IS NULL'];
    const params: (string | number)[] = [];
    if (query.collectionId) {
      filter.push(`r.collection_id IN (${COLLECTION_TREE})`);
      params.push(query.collectionId);
    }
    if (query.from !== undefined) {
      filter.push('r.created_at >= ?');
      params.push(query.from);
    }
    if (query.to !== undefined) {
      filter.push('r.created_at < ?');
      params.push(query.to);
    }
    const allowed = `SELECT r.id FROM recordings r WHERE ${filter.join(' AND ')}`;
    const want = (kind: SearchKind) => !query.kind || query.kind === kind;

    const found = new Map<string, { score: number; hits: Map<SearchKind, (SearchHit & { score: number })[]>; total: number }>();
    /** `count` is how many matches this hit stands for (all of a recording's matching lines, for the first one). */
    const add = (recordingId: string, hit: SearchHit, score: number, count = 1) => {
      const entry = found.get(recordingId) ?? { score: 0, hits: new Map(), total: 0 };
      // BM25 scores are negative, lower is better. Turned into positive relevance, weighted by place.
      const relevance = Math.max(0.01, -score) * WEIGHT[hit.kind];
      // More matches count for a little, with diminishing returns, so one long recording cannot dominate.
      entry.score = Math.max(entry.score, relevance) + 0.05 * Math.log2(1 + count);
      entry.total += count;
      const list = entry.hits.get(hit.kind) ?? [];
      list.push({ ...hit, score: relevance });
      entry.hits.set(hit.kind, list);
      found.set(recordingId, entry);
    };

    if (want('title')) {
      const rows = this.db
        .prepare(`SELECT recording_id, ${SNIPPET('recording_search', -1)} AS snip, bm25(recording_search) AS score FROM recording_search WHERE recording_search MATCH ? AND recording_id IN (${allowed}) ORDER BY score LIMIT 500`)
        .all(fts, ...params) as { recording_id: string; snip: string; score: number }[];
      for (const r of rows) add(r.recording_id, { kind: 'title', snippet: r.snip, startMs: null, targetId: null, label: null }, r.score);
    }
    if (want('transcript')) {
      // The best few lines of every matching recording, ranked within each recording, plus how many
      // matched. A plain overall limit would let a few recordings that use a word often crowd out the rest.
      const rows = this.db
        .prepare(
          `WITH matched AS (
             SELECT rowid AS rid, recording_id, bm25(transcript_search) AS score FROM transcript_search
             WHERE transcript_search MATCH ? AND recording_id IN (${allowed})
           ), ranked AS (
             SELECT rid, recording_id, score, ROW_NUMBER() OVER (PARTITION BY recording_id ORDER BY score) AS rn, COUNT(*) OVER (PARTITION BY recording_id) AS total FROM matched
           )
           SELECT ranked.recording_id, ranked.score, ranked.rn, ranked.total, transcript_search.start_ms, ${SNIPPET('transcript_search', 3, 18)} AS snip
           FROM ranked JOIN transcript_search ON transcript_search.rowid = ranked.rid
           WHERE ranked.rn <= ${HITS_SHOWN.transcript} AND transcript_search MATCH ?`,
        )
        .all(fts, ...params, fts) as { recording_id: string; score: number; rn: number; total: number; start_ms: number; snip: string }[];
      for (const r of rows) add(r.recording_id, { kind: 'transcript', snippet: r.snip, startMs: Number(r.start_ms), targetId: null, label: null }, r.score, r.rn === 1 ? r.total - Math.min(r.total, HITS_SHOWN.transcript) + 1 : 1);
    }
    if (want('summary')) {
      const rows = this.db
        .prepare(
          `SELECT s.recording_id, s.summary_id, ${SNIPPET('summary_search', 2, 18)} AS snip, bm25(summary_search) AS score, x.label AS label
           FROM summary_search s JOIN summaries x ON x.id = s.summary_id
           WHERE summary_search MATCH ? AND s.recording_id IN (${allowed}) ORDER BY score LIMIT 300`,
        )
        .all(fts, ...params) as { recording_id: string; summary_id: string; snip: string; score: number; label: string }[];
      for (const r of rows) add(r.recording_id, { kind: 'summary', snippet: cleanCites(r.snip), startMs: null, targetId: r.summary_id, label: r.label }, r.score);
    }
    if (want('document')) {
      const rows = this.db
        .prepare(
          `SELECT s.recording_id, s.document_id, ${SNIPPET('document_search', 2, 18)} AS snip, bm25(document_search) AS score, d.title AS label
           FROM document_search s JOIN documents d ON d.id = s.document_id
           WHERE document_search MATCH ? AND s.recording_id IN (${allowed}) ORDER BY score LIMIT 300`,
        )
        .all(fts, ...params) as { recording_id: string; document_id: string; snip: string; score: number; label: string }[];
      for (const r of rows) add(r.recording_id, { kind: 'document', snippet: cleanCites(r.snip), startMs: null, targetId: r.document_id, label: r.label }, r.score);
    }
    // Chapters and speaker names are few, so plain matching on every word is enough.
    const contains = (column: string) => words.map(() => `instr(lower(${column}), ?) > 0`).join(' AND ');
    if (want('chapter')) {
      const rows = this.db
        .prepare(`SELECT recording_id, start_ms, title, summary FROM chapters WHERE ${contains("title || ' ' || summary")} AND recording_id IN (${allowed}) LIMIT 300`)
        .all(...words, ...params) as { recording_id: string; start_ms: number; title: string; summary: string }[];
      for (const r of rows) add(r.recording_id, { kind: 'chapter', snippet: highlight(`${r.title}: ${r.summary}`, words), startMs: r.start_ms, targetId: null, label: r.title }, -2);
    }
    if (want('speaker')) {
      const rows = this.db
        .prepare(`SELECT recording_id, display_name FROM speakers WHERE ${contains('display_name')} AND recording_id IN (${allowed}) LIMIT 300`)
        .all(...words, ...params) as { recording_id: string; display_name: string }[];
      for (const r of rows) add(r.recording_id, { kind: 'speaker', snippet: highlight(r.display_name, words), startMs: null, targetId: null, label: null }, -2);
    }

    const ranked = [...found.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, MAX_RESULTS);
    if (!ranked.length) return [];
    const meta = new Map(
      (this.db.prepare('SELECT id, title, created_at, duration_ms, mode FROM recordings WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ranked.map(([id]) => id))) as {
        id: string;
        title: string;
        created_at: number;
        duration_ms: number;
        mode: string;
      }[]).map((r) => [r.id, r]),
    );
    return ranked.flatMap(([id, entry]) => {
      const r = meta.get(id);
      if (!r) return [];
      const hits = ORDER.flatMap((kind) => {
        const list = (entry.hits.get(kind) ?? []).sort((a, b) => b.score - a.score).slice(0, HITS_SHOWN[kind]);
        // Transcript lines read best in time order once the best ones are chosen.
        if (kind === 'transcript') list.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
        return list.map(({ score: _score, ...hit }) => hit);
      });
      return [{ recordingId: id, title: r.title, createdAt: r.created_at, durationMs: r.duration_ms, mode: r.mode, hits, totalHits: entry.total }];
    });
  }
}

function cleanCites(snippet: string): string {
  return snippet.replace(/\]\(cite:[^)]*\)/g, ']').replace(/\(cite:[^)]*\)?/g, '');
}

/** Marks every word in short text, as FTS5's snippet does for indexed text. */
function highlight(text: string, words: string[]): string {
  let out = text;
  for (const w of words) {
    const lower = out.toLowerCase();
    const i = lower.indexOf(w);
    if (i >= 0) out = `${out.slice(0, i)}${MATCH_START}${out.slice(i, i + w.length)}${MATCH_END}${out.slice(i + w.length)}`;
  }
  return out;
}
