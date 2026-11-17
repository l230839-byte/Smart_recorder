/** Global search (prompt §12): one query across every kind of content, with snippets and times. */

export type SearchKind = 'title' | 'transcript' | 'summary' | 'document' | 'chapter' | 'speaker';

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  title: 'Details',
  transcript: 'Transcript',
  summary: 'Summary',
  document: 'Document',
  chapter: 'Chapter',
  speaker: 'Speaker',
};

export interface SearchQuery {
  text: string;
  /** Limit to one kind of content. */
  kind?: SearchKind;
  collectionId?: string;
  /** Recorded on or after / before, as timestamps. */
  from?: number;
  to?: number;
}

/** Snippet text marks matches between these two characters, so they are shown without any HTML. */
export const MATCH_START = '\u0002';
export const MATCH_END = '\u0003';

export interface SearchHit {
  kind: SearchKind;
  snippet: string;
  /** Where in the recording, for transcript lines and chapters. */
  startMs: number | null;
  /** The summary or document it was found in. */
  targetId: string | null;
  /** Such as the document's title. */
  label: string | null;
}

export interface SearchResult {
  recordingId: string;
  title: string;
  createdAt: number;
  durationMs: number;
  mode: string;
  hits: SearchHit[];
  /** All matches in this recording, including those not shown. */
  totalHits: number;
}

/** Splits a snippet into plain and matched parts, for highlighting without HTML. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  const re = new RegExp(`${MATCH_START}([^${MATCH_END}]*)${MATCH_END}`, 'g');
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false });
    parts.push({ text: m[1]!, match: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts.map((p) => ({ ...p, text: p.text.replace(new RegExp(`[${MATCH_START}${MATCH_END}]`, 'g'), '') }));
}
