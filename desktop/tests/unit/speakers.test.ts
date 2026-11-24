import { describe, expect, it } from 'vitest';
import { assignSpeakers, parseDiarization } from '../../src/main/ai/diarize';
import type { Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, endMs: number, text: string): Segment => ({ idx, startMs, endMs, text, speaker: null, confidence: null });

describe('reading sherpa-onnx', () => {
  it('reads "start -- end speaker_N" lines (as printed on 2026-11-24) and ignores everything else', () => {
    const output = [
      'Elapsed seconds: 1.150 s',
      'Real time factor (RTF): 1.150 / 11.592 = 0.099',
      'OfflineSpeakerDiarizationConfig(segmentation=...)',
      'Started',
      '6.578 -- 7.372 speaker_00',
      '0.031 -- 1.297 speaker_01',
      '2.107 -- 5.785 speaker_01',
      '8.097 -- 10.966 speaker_00',
    ].join('\r\n');
    expect(parseDiarization(output)).toEqual([
      { startMs: 31, endMs: 1297, speaker: 'speaker_01' },
      { startMs: 2107, endMs: 5785, speaker: 'speaker_01' },
      { startMs: 6578, endMs: 7372, speaker: 'speaker_00' },
      { startMs: 8097, endMs: 10966, speaker: 'speaker_00' },
    ]);
    expect(parseDiarization('no speakers here')).toEqual([]);
  });
});

describe('labelling transcript lines', () => {
  const turns = parseDiarization(['0.031 -- 1.297 speaker_01', '2.107 -- 5.785 speaker_01', '6.578 -- 7.372 speaker_00', '8.097 -- 10.966 speaker_00'].join('\n'));

  it('each line gets the voice that speaks most during it, named in order of first appearance', () => {
    const lines = [seg(0, 100, 1200, 'Good morning everyone.'), seg(1, 2100, 5800, 'The solar farm produced 40 MWh.'), seg(2, 6600, 7400, 'Thanks Sarah.'), seg(3, 8200, 10900, 'We hire three engineers.')];
    expect(assignSpeakers(lines, turns).map((l) => l.speaker)).toEqual(['Speaker A', 'Speaker A', 'Speaker B', 'Speaker B']);
  });

  it('a line that straddles a change goes to whoever speaks longer in it', () => {
    expect(assignSpeakers([seg(0, 5500, 7300, 'end of one, start of other')], turns)[0]!.speaker).toBe('Speaker B');
    expect(assignSpeakers([seg(0, 4000, 6800, 'mostly the first voice')], turns)[0]!.speaker).toBe('Speaker A');
  });

  it('a line no voice covers takes a turn within two seconds, and is otherwise left unlabelled, not guessed', () => {
    expect(assignSpeakers([seg(0, 1400, 1900, 'in a short pause')], turns)[0]!.speaker).toBe('Speaker A');
    expect(assignSpeakers([seg(0, 20_000, 21_000, 'long after anyone spoke')], turns)[0]!.speaker).toBeNull();
  });

  it('the text, times and everything else about a line stay as they were', () => {
    const line = { ...seg(4, 8200, 10900, 'We hire three engineers.'), confidence: 0.8 };
    expect(assignSpeakers([line], turns)[0]).toEqual({ ...line, speaker: 'Speaker B' });
  });
});
