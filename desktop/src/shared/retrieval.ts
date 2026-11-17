import type { Segment } from './transcript';

/**
 * Finding the right parts of transcripts. Transcripts are split into overlapping passages that are
 * indexed with SQLite FTS5 and ranked with BM25 (prompt §9: "FTS5/BM25 fallback"). Pure, so it is
 * tested without a database.
 */

export interface TranscriptChunk {
  firstIdx: number;
  lastIdx: number;
  startMs: number;
  endMs: number;
  text: string;
}

/** About 45 to 60 seconds of speech: long enough to hold a thought, short enough to rank well. */
export const CHUNK_CHARS = 700;

/**
 * Consecutive lines up to about `targetChars`. Each passage repeats the last line of the one before,
 * so a thought split across a boundary is still found whole in one of them.
 */
export function chunkSegments(segments: Segment[], targetChars = CHUNK_CHARS): TranscriptChunk[] {
  const lines = segments.filter((s) => s.text.trim());
  const chunks: TranscriptChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    let size = lines[i]!.text.length;
    while (j + 1 < lines.length && size + lines[j + 1]!.text.length + 1 <= targetChars) {
      j++;
      size += lines[j]!.text.length + 1;
    }
    const part = lines.slice(i, j + 1);
    // A repeated line that cannot be joined to the next adds nothing new, so it is not a passage again.
    const repeatOnly = j === i && chunks.length > 0 && chunks[chunks.length - 1]!.lastIdx === lines[i]!.idx;
    if (!repeatOnly) chunks.push({ firstIdx: part[0]!.idx, lastIdx: part[part.length - 1]!.idx, startMs: part[0]!.startMs, endMs: part[part.length - 1]!.endMs, text: part.map((s) => s.text.trim()).join(' ') });
    if (j + 1 >= lines.length) break;
    // Overlap by one line, unless the passage is a single long line (which would never advance).
    i = j > i ? j : j + 1;
  }
  return chunks;
}

// Words that carry no meaning for search. English and Urdu, the two languages the prompt names.
const STOPWORDS = new Set(
  (
    'a an the and or but if then than so of to in on at by for from with about into over after before under between is are was were be been being am do does did done have has had ' +
    'i me my we us our you your he him his she her it its they them their this that these those there here what which who whom whose when where why how all any each every some ' +
    'no not only own same such too very can could will would shall should may might must just also more most other again further once both few up down out off ' +
    'tell say said says please explain describe give show list find mention mentioned talk talked discuss discussed recording recordings lecture meeting about ' +
    'کا کی کے کو نے سے میں پر ہے ہیں تھا تھی تھے ہو ہوا ہوئی ہوئے اور یا بھی تو یہ وہ اس ان جو کہ کیا کیوں کیسے کب کہاں کون ایک کچھ گا گی گے رہا رہی رہے ہی نہ نہیں'
  ).split(' '),
);

/** The words of a question worth searching for, in their normal form. */
export function searchTerms(text: string, max = 16): string[] {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((w) => w && !STOPWORDS.has(w) && (w.length > 1 || /\p{N}/u.test(w)));
  return [...new Set(words)].slice(0, max);
}

/**
 * An FTS5 query that matches passages with any of the terms, so BM25 can rank by how many match and
 * how rare they are. Longer words also match their endings ("network" finds "networks").
 */
export function anyTermQuery(terms: string[]): string | null {
  if (!terms.length) return null;
  return terms.map((t) => (t.length >= 4 ? `"${t.replace(/"/g, '')}"*` : `"${t.replace(/"/g, '')}"`)).join(' OR ');
}

/**
 * Reciprocal rank fusion: combines several ranked lists (one per search) without comparing their raw
 * scores, which are not comparable. Items found by several searches rise to the top.
 */
export function fuseRankings<T>(lists: T[][], key: (item: T) => string, k = 60): T[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const entry = scores.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.item);
}

/** An even selection of lines across a transcript that fits the budget, for questions about the whole thing. */
export function spreadSample(segments: Segment[], maxChars: number): Segment[] {
  const total = segments.reduce((sum, s) => sum + s.text.length + 20, 0);
  if (total <= maxChars) return segments;
  const keepEvery = Math.ceil(total / maxChars);
  return segments.filter((_, i) => i % keepEvery === 0);
}

/** Characters a line takes in a prompt, with its id and time. */
export function promptChars(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + s.text.length + 24, 0);
}
