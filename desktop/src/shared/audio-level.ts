/**
 * How loud audio is, from the stored waveform. Waveform buckets hold each stretch's peak amplitude on a
 * square-root curve scaled to 0-255 (see the media worker's analyze), so amplitude = (byte / 255)².
 */

/**
 * Below this peak amplitude (about −38 dBFS) a stretch counts as silent. Speech peaks are far higher, even
 * quietly spoken; a microphone that delivers nothing sits well below it. A real 43-minute recording from a
 * silent microphone peaked at −44 dBFS (0.0063) for its whole length.
 */
export const SILENCE_AMPLITUDE = 0.012;

/** At least this share of a recording (or piece) must be audible for it to count as having sound. */
const MIN_AUDIBLE_SHARE = 0.02;

const SILENCE_BYTE = Math.ceil(Math.sqrt(SILENCE_AMPLITUDE) * 255);

/** The share of buckets, between `from` and `to` (fractions of the whole), louder than silence. */
export function audibleShare(peaks: ArrayLike<number>, from = 0, to = 1): number {
  const start = Math.max(0, Math.floor(from * peaks.length));
  const end = Math.min(peaks.length, Math.max(start + 1, Math.ceil(to * peaks.length)));
  let loud = 0;
  for (let i = start; i < end; i++) if (peaks[i]! >= SILENCE_BYTE) loud++;
  return end > start ? loud / (end - start) : 0;
}

/**
 * True when (part of) a recording has essentially no sound: a muted or wrong microphone, or a silent file.
 * No waveform means "unknown", which is never treated as silent.
 */
export function isSilent(peaks: ArrayLike<number> | null | undefined, from = 0, to = 1): boolean {
  if (!peaks || peaks.length === 0) return false;
  return audibleShare(peaks, from, to) < MIN_AUDIBLE_SHARE;
}
