import { describe, expect, it } from 'vitest';
import { clampPosition, findSilences, isTruncated, parseRange, planIngest, rejectionReason, skipTarget, sniffAmr, type MediaProbe } from '../../src/shared/media';
import { titleFromFileName } from '../../src/main/services/imports';
import { formatBytes, formatDuration, formatDurationLong, formatRelative, plural } from '../../src/shared/format';

const probe = (over: Partial<MediaProbe>): MediaProbe => ({
  container: 'MP3',
  hasVideo: false,
  codec: 'mp3',
  sampleRate: 44100,
  channels: 2,
  durationMs: 1000,
  canDecode: true,
  ...over,
});

describe('planIngest', () => {
  it('keeps common audio files byte for byte', () => {
    expect(planIngest(probe({}))).toEqual({ kind: 'keep', container: 'mp3' });
    expect(planIngest(probe({ container: 'MP4', codec: 'aac' }))).toEqual({ kind: 'keep', container: 'm4a' });
    expect(planIngest(probe({ container: 'Ogg', codec: 'opus' }))).toEqual({ kind: 'keep', container: 'ogg' });
    expect(planIngest(probe({ container: 'WAVE', codec: 'pcm-s16' }))).toEqual({ kind: 'keep', container: 'wav' });
    expect(planIngest(probe({ container: 'FLAC', codec: 'flac' }))).toEqual({ kind: 'keep', container: 'flac' });
  });

  it('extracts video audio without re-encoding when possible', () => {
    expect(planIngest(probe({ container: 'MP4', codec: 'aac', hasVideo: true }))).toEqual({ kind: 'remux', container: 'm4a' });
    expect(planIngest(probe({ container: 'Matroska', codec: 'opus', hasVideo: true }))).toEqual({ kind: 'remux', container: 'ogg' });
  });

  it('rewrites live WebM recordings so they get a real duration and seek index', () => {
    expect(planIngest(probe({ container: 'WebM', codec: 'opus' }))).toEqual({ kind: 'remux', container: 'ogg' });
  });

  it('rewrites raw ADTS AAC into a seekable container', () => {
    expect(planIngest(probe({ container: 'ADTS', codec: 'aac' }))).toEqual({ kind: 'remux', container: 'm4a' });
  });

  it('re-encodes codecs nothing can hold as is', () => {
    expect(planIngest(probe({ container: 'Other', codec: 'ac3' }))).toEqual({ kind: 'transcode', container: 'ogg' });
  });
});

describe('rejectionReason', () => {
  it('explains each failure in plain words', () => {
    expect(rejectionReason(probe({ codec: null }))).toMatch(/No audio track/);
    expect(rejectionReason(probe({ codec: null, hasVideo: true }))).toMatch(/video has no audio/);
    expect(rejectionReason(probe({ canDecode: false, codec: 'ac3' }))).toMatch(/ac3/);
    expect(rejectionReason(probe({}))).toBeNull();
  });
});

describe('isTruncated', () => {
  it('flags files that end well before their header claims', () => {
    expect(isTruncated(60_000, 30_000)).toBe(true);
    expect(isTruncated(60_000, 59_500)).toBe(false);
    expect(isTruncated(0, 0)).toBe(false);
    expect(isTruncated(2000, 1500)).toBe(false);
  });
});

describe('findSilences and skipTarget', () => {
  const peaks = [100, 100, 0, 0, 0, 0, 100, 0, 100, 0, 0];

  it('finds long quiet stretches and leaves short pauses alone', () => {
    expect(findSilences(peaks, 11_000)).toEqual([
      { startMs: 2000, endMs: 6000 },
      { startMs: 9000, endMs: 11_000 },
    ]);
  });

  it('handles empty input', () => {
    expect(findSilences([], 1000)).toEqual([]);
    expect(findSilences([1], 0)).toEqual([]);
  });

  it('jumps only when inside a silence', () => {
    const silences = findSilences(peaks, 11_000);
    expect(skipTarget(silences, 1000)).toBeNull();
    expect(skipTarget(silences, 2500)).toBe(5800);
    expect(skipTarget(silences, 5900)).toBeNull();
    expect(skipTarget(silences, 6500)).toBeNull();
  });
});

describe('clampPosition', () => {
  it('keeps a note inside the recording', () => {
    expect(clampPosition(-5, 100)).toBe(0);
    expect(clampPosition(500, 100)).toBe(100);
    expect(clampPosition(50.4, 100)).toBe(50);
  });
});

describe('sniffAmr', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('reads the real signature, not the file name', () => {
    expect(sniffAmr(bytes('#!AMR\nxxxx'))).toBe('amr-nb');
    expect(sniffAmr(bytes('#!AMR-WB\nxx'))).toBe('amr-wb');
    expect(sniffAmr(bytes('RIFFxxxxxxx'))).toBeNull();
    expect(sniffAmr(new Uint8Array())).toBeNull();
  });
});

describe('parseRange', () => {
  it('handles the forms the audio element sends', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('rejects what cannot be satisfied', () => {
    for (const bad of [null, '', 'bytes=', 'bytes=-', 'bytes=100-', 'bytes=20-10', 'chars=0-1', 'bytes=0-1,4-5']) {
      expect(parseRange(bad, 100), String(bad)).toBeNull();
    }
    expect(parseRange('bytes=0-', 0)).toBeNull();
  });
});

describe('titleFromFileName', () => {
  it('makes a readable title and keeps other languages', () => {
    expect(titleFromFileName('Lecture_12_final.mp3')).toBe('Lecture 12 final');
    expect(titleFromFileName('PTT-20260101-WA0007.opus')).toBe('PTT-20260101-WA0007');
    expect(titleFromFileName('موسم کی رپورٹ.m4a')).toBe('موسم کی رپورٹ');
    expect(titleFromFileName('no-extension')).toBe('no-extension');
    expect(titleFromFileName('.mp3')).toBe('.mp3');
  });
});

describe('formatting', () => {
  it('durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_661_000)).toBe('1:01:01');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDurationLong(0)).toBe('0 min');
    expect(formatDurationLong(10_000)).toBe('< 1 min');
    expect(formatDurationLong(3_600_000)).toBe('1 h');
    expect(formatDurationLong(7_500_000)).toBe('2 h 5 min');
  });

  it('sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB');
  });

  it('relative times and plurals', () => {
    const now = 1_700_000_000_000;
    expect(formatRelative(now - 5000, now)).toBe('Just now');
    expect(formatRelative(now - 120_000, now)).toBe('2 min ago');
    expect(formatRelative(now - 7_200_000, now)).toBe('2 h ago');
    expect(formatRelative(now - 86_400_000, now)).toBe('Yesterday');
    expect(plural(1, 'recording')).toBe('1 recording');
    expect(plural(2, 'recording')).toBe('2 recordings');
  });
});
