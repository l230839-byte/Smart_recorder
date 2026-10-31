/** Pure decisions about media files. Shared by the ingest service, the media worker and tests. */

export const PEAK_BUCKETS = 800;

export interface MediaProbe {
  container: string;
  hasVideo: boolean;
  /** Null when the file has no audio track we can recognize. */
  codec: string | null;
  sampleRate: number;
  channels: number;
  durationMs: number;
  canDecode: boolean;
}

export type OutputContainer = 'ogg' | 'm4a' | 'mp3' | 'flac' | 'wav';

export const CONTAINER_MIME: Record<OutputContainer, string> = {
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

export const CONTAINER_LABEL: Record<OutputContainer, string> = {
  ogg: 'OGG',
  m4a: 'M4A',
  mp3: 'MP3',
  flac: 'FLAC',
  wav: 'WAV',
};

export const CODEC_LABEL: Record<string, string> = {
  opus: 'Opus',
  aac: 'AAC',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  amr: 'AMR',
};

export function codecLabel(codec: string): string {
  return CODEC_LABEL[codec] ?? (codec.startsWith('pcm') ? 'PCM' : codec.toUpperCase());
}

/** The container that holds this codec without re-encoding, or null if it must be re-encoded. */
export function containerForCodec(codec: string): OutputContainer | null {
  if (codec === 'aac') return 'm4a';
  if (codec === 'opus' || codec === 'vorbis') return 'ogg';
  if (codec === 'mp3') return 'mp3';
  if (codec === 'flac') return 'flac';
  if (codec.startsWith('pcm')) return 'wav';
  return null;
}

/** Containers the player handles directly, keyed by the name Mediabunny reports. */
const DIRECT_CONTAINERS: Record<string, OutputContainer> = {
  MP4: 'm4a',
  MP3: 'mp3',
  Ogg: 'ogg',
  FLAC: 'flac',
  WAVE: 'wav',
};

export type IngestPlan =
  /** The bytes are kept exactly as they arrived. */
  | { kind: 'keep'; container: OutputContainer }
  /** Audio is copied into a new container with no quality loss. */
  | { kind: 'remux'; container: OutputContainer }
  /** Audio is re-encoded because nothing can hold or play it as is. */
  | { kind: 'transcode'; container: 'ogg' };

/**
 * Decides how a validated file enters the library. Live recordings arrive as WebM, which has no
 * reliable duration or seek index, so they are always rewritten. Video keeps only its audio.
 */
export function planIngest(probe: MediaProbe): IngestPlan {
  const target = probe.codec ? containerForCodec(probe.codec) : null;
  if (!target) return { kind: 'transcode', container: 'ogg' };
  const direct = DIRECT_CONTAINERS[probe.container];
  if (direct === target && !probe.hasVideo) return { kind: 'keep', container: direct };
  return { kind: 'remux', container: target };
}

/** Why a file cannot enter the library, as a message for the user. Null means it is acceptable. */
export function rejectionReason(probe: MediaProbe): string | null {
  if (!probe.codec) return probe.hasVideo ? 'This video has no audio track.' : 'No audio track was found in this file.';
  if (!probe.canDecode) return `This file uses the ${probe.codec} codec, which EchoMind cannot decode.`;
  return null;
}

/** Frames were missing but nothing failed to decode: the file ends earlier than its header claims. */
export function isTruncated(claimedMs: number, decodedMs: number): boolean {
  return claimedMs > 0 && decodedMs < claimedMs * 0.9 && claimedMs - decodedMs > 1000;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

/**
 * Finds stretches quiet enough for "skip silence" from stored waveform peaks (0-255).
 * Short pauses are left alone, so speech keeps its natural rhythm.
 */
export function findSilences(peaks: ArrayLike<number>, durationMs: number, threshold = 10, minSilenceMs = 1500): TimeRange[] {
  const count = peaks.length;
  if (count === 0 || durationMs <= 0) return [];
  const bucketMs = durationMs / count;
  const ranges: TimeRange[] = [];
  let start = -1;
  for (let i = 0; i <= count; i++) {
    const quiet = i < count && peaks[i]! <= threshold;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      const range = { startMs: start * bucketMs, endMs: i * bucketMs };
      if (range.endMs - range.startMs >= minSilenceMs) ranges.push(range);
      start = -1;
    }
  }
  return ranges;
}

/** Where playback should jump to when skip-silence is on, or null to carry on. */
export function skipTarget(silences: TimeRange[], positionMs: number, leadOutMs = 200): number | null {
  for (const s of silences) {
    if (positionMs >= s.startMs && positionMs < s.endMs - leadOutMs) return s.endMs - leadOutMs;
    if (s.startMs > positionMs) break;
  }
  return null;
}

/** Keeps the moment a note was started, inside the valid range of the recording. */
export function clampPosition(positionMs: number, maxMs: number): number {
  return Math.round(Math.min(Math.max(0, positionMs), Math.max(0, maxMs)));
}

/** Audio file signatures the media library does not recognize itself. */
export function sniffAmr(head: Uint8Array): 'amr-nb' | 'amr-wb' | null {
  const text = String.fromCharCode(...head.subarray(0, 9));
  if (text.startsWith('#!AMR-WB\n')) return 'amr-wb';
  if (text.startsWith('#!AMR\n')) return 'amr-nb';
  return null;
}

/** Parses a single-range "bytes=" header. Returns null when it cannot be satisfied. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match) return null;
  const [, a, b] = match;
  if (!a && !b) return null;
  let start: number;
  let end: number;
  if (!a) {
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  return start > end || start >= size ? null : { start, end };
}

/** Container types that can pull in other files or run sources. Never fed to FFmpeg. */
const UNSAFE_DEMUXERS = new Set(['hls', 'dash', 'concat', 'ffconcat', 'lavfi', 'sdp', 'rtsp', 'tty', 'image2', 'mov_text', 'subviewer', 'webvtt', 'srt', 'ass']);

export function isUnsafeDemuxer(formatName: string): boolean {
  const names = formatName.split(',').map((n) => n.trim().toLowerCase());
  return names.length === 0 || names.some((n) => !n || UNSAFE_DEMUXERS.has(n));
}

export function ffprobeFormatArgs(input: string): string[] {
  return ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=format_name', '-of', 'default=nw=1:nk=1', input];
}

/** File access only, audio only, no metadata carried over, no prompts. */
export function ffmpegNormalizeArgs(input: string, output: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', '-progress', 'pipe:1', '-y', output];
}

export function parseProgressMs(text: string): number | null {
  const matches = [...text.matchAll(/out_time_us=(\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) / 1000 : null;
}
