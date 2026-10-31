import { formatDuration } from './format';
import type { TimeRange } from './media';

/** Pure transcript logic: chunk planning, merging, display modes and subtitle writers. */

export interface Segment {
  idx: number;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  /** 0 to 1 when the provider reports it. Low values are shown as uncertain. */
  confidence: number | null;
}

export type ChunkSegment = Omit<Segment, 'idx'>;

export const UNCERTAIN_BELOW = 0.45;

/**
 * Splits long audio into pieces, cutting at the quietest moment near each limit so no word is cut in half.
 * Falls back to the limit itself when there are no peaks to read.
 */
export function planChunks(durationMs: number, peaks: ArrayLike<number> | null, maxChunkMs: number, searchFraction = 0.15): TimeRange[] {
  const ranges: TimeRange[] = [];
  const bucketMs = peaks && peaks.length ? durationMs / peaks.length : 0;
  let start = 0;
  while (durationMs - start > maxChunkMs) {
    let cut = start + maxChunkMs;
    if (peaks && bucketMs > 0) {
      const from = Math.floor((start + maxChunkMs * (1 - searchFraction)) / bucketMs);
      const to = Math.min(peaks.length, Math.floor((start + maxChunkMs) / bucketMs));
      let quietest = Number.POSITIVE_INFINITY;
      for (let i = from; i < to; i++) {
        // On a tie, the later moment keeps pieces closer to the limit.
        if (peaks[i]! <= quietest) {
          quietest = peaks[i]!;
          cut = (i + 0.5) * bucketMs;
        }
      }
    }
    ranges.push({ startMs: Math.round(start), endMs: Math.round(cut) });
    start = cut;
  }
  if (durationMs > start || ranges.length === 0) ranges.push({ startMs: Math.round(start), endMs: Math.round(durationMs) });
  return ranges;
}

/** Shifts each chunk's timestamps back onto the recording's own timeline. */
export function mergeChunks(chunks: { startMs: number; segments: ChunkSegment[] }[]): Segment[] {
  const out: Segment[] = [];
  for (const chunk of chunks) {
    for (const s of chunk.segments) {
      const text = s.text.trim();
      if (!text) continue;
      out.push({ ...s, text, startMs: Math.round(chunk.startMs + s.startMs), endMs: Math.round(chunk.startMs + s.endMs), idx: out.length });
    }
  }
  return out;
}

export const TRANSCRIPT_MODES = ['paragraph', 'timestamped', 'speaker', 'cleaned', 'qa', 'raw'] as const;
export type TranscriptMode = (typeof TRANSCRIPT_MODES)[number];

export const TRANSCRIPT_MODE_LABEL: Record<TranscriptMode, string> = {
  paragraph: 'Paragraphs',
  timestamped: 'Timestamped',
  speaker: 'Speakers',
  cleaned: 'Cleaned',
  qa: 'Q&A',
  raw: 'Raw',
};

export interface TranscriptBlock {
  key: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  kind: 'text' | 'question' | 'answer';
  showTime: boolean;
  uncertain: boolean;
  /** Only one-segment blocks can be edited in place. */
  segmentIdx: number | null;
}

const FILLERS = /(^|[\s,])(?:um+|uh+|er+|erm+|hmm+|ah+)(?=[\s,.!?]|$)[,]?/gi;
const REPEATS = /\b(\p{L}+)(\s+\1\b)+/giu;

/** A plain text clean-up that works offline. It removes fillers and stutters but never rephrases. */
export function cleanText(text: string): string {
  const cleaned = text.replace(FILLERS, '$1').replace(REPEATS, '$1').replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,]+/, '').trim();
  return cleaned.charAt(0).toLocaleUpperCase() + cleaned.slice(1);
}

function isUncertain(s: Segment): boolean {
  return s.confidence !== null && s.confidence < UNCERTAIN_BELOW;
}

function single(s: Segment, text: string, showTime: boolean, kind: TranscriptBlock['kind'] = 'text'): TranscriptBlock {
  return { key: `s${s.idx}`, startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text, kind, showTime, uncertain: isUncertain(s), segmentIdx: s.idx };
}

function group(run: Segment[], kind: TranscriptBlock['kind'] = 'text', showTime = true): TranscriptBlock {
  const first = run[0]!;
  return {
    key: `g${first.idx}`,
    startMs: first.startMs,
    endMs: run[run.length - 1]!.endMs,
    speaker: first.speaker,
    text: run.map((s) => s.text).join(' '),
    kind,
    showTime,
    uncertain: false,
    segmentIdx: run.length === 1 ? first.idx : null,
  };
}

const PARAGRAPH_GAP_MS = 2500;
const PARAGRAPH_MAX_WORDS = 110;

function paragraphs(segments: Segment[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let run: Segment[] = [];
  let words = 0;
  for (const s of segments) {
    const last = run[run.length - 1];
    const count = s.text.split(/\s+/).length;
    if (last && (s.speaker !== last.speaker || s.startMs - last.endMs > PARAGRAPH_GAP_MS || words + count > PARAGRAPH_MAX_WORDS)) {
      out.push(group(run));
      run = [];
      words = 0;
    }
    run.push(s);
    words += count;
  }
  if (run.length) out.push(group(run));
  return out;
}

function bySpeaker(segments: Segment[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let run: Segment[] = [];
  for (const s of segments) {
    if (run.length && run[run.length - 1]!.speaker !== s.speaker) {
      out.push(group(run));
      run = [];
    }
    run.push(s);
  }
  if (run.length) out.push(group(run));
  return out;
}

const QUESTION = /[?؟]\s*$/;

function questionsAndAnswers(segments: Segment[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let run: Segment[] = [];
  const flush = () => {
    if (run.length) out.push(group(run, 'answer'));
    run = [];
  };
  for (const s of segments) {
    if (QUESTION.test(s.text)) {
      flush();
      out.push(single(s, s.text, true, 'question'));
    } else {
      run.push(s);
    }
  }
  flush();
  return out;
}

export function hasSpeakers(segments: Segment[]): boolean {
  return segments.some((s) => s.speaker);
}

export function hasQuestions(segments: Segment[]): boolean {
  return segments.some((s) => QUESTION.test(s.text));
}

export function toBlocks(mode: TranscriptMode, segments: Segment[]): TranscriptBlock[] {
  switch (mode) {
    case 'raw':
      return segments.map((s) => single(s, s.text, false));
    case 'cleaned':
      return segments.map((s) => single(s, cleanText(s.text), false)).filter((b) => b.text);
    case 'timestamped':
      return segments.map((s) => single(s, s.text, true));
    case 'paragraph':
      return paragraphs(segments);
    case 'speaker':
      return bySpeaker(segments);
    case 'qa':
      return questionsAndAnswers(segments);
  }
}

/** The block being spoken at this moment, or the last one started. */
export function activeBlockIndex(blocks: TranscriptBlock[], positionMs: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid]!.startMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Finds every match, ignoring case, as [start, end) offsets. */
export function findMatches(text: string, query: string): [number, number][] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hay = text.toLocaleLowerCase();
  const out: [number, number][] = [];
  let at = hay.indexOf(needle);
  while (at >= 0) {
    out.push([at, at + needle.length]);
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

export function speakerName(label: string | null, names: Record<string, string>): string | null {
  if (!label) return null;
  return names[label] ?? `Speaker ${label}`;
}

function subtitleTime(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(total % 1000, 3)}`;
}

function cueText(s: Segment, names: Record<string, string>): string {
  const who = speakerName(s.speaker, names);
  return who ? `${who}: ${s.text}` : s.text;
}

export function toSrt(segments: Segment[], names: Record<string, string> = {}): string {
  return segments.map((s, i) => `${i + 1}\n${subtitleTime(s.startMs, ',')} --> ${subtitleTime(s.endMs, ',')}\n${cueText(s, names)}\n`).join('\n');
}

export function toVtt(segments: Segment[], names: Record<string, string> = {}): string {
  const body = segments.map((s) => `${subtitleTime(s.startMs, '.')} --> ${subtitleTime(s.endMs, '.')}\n${cueText(s, names).replace(/-->/g, '→')}\n`).join('\n');
  return `WEBVTT\n\n${body}`;
}

export function toPlainText(segments: Segment[], names: Record<string, string> = {}): string {
  return segments.map((s) => `[${formatDuration(s.startMs)}] ${cueText(s, names)}`).join('\n');
}
