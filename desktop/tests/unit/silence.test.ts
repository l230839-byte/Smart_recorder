import { describe, expect, it } from 'vitest';
import { parseVerboseJson } from '../../src/main/ai/whisper-http';
import { audibleShare, isSilent, SILENCE_AMPLITUDE } from '../../src/shared/audio-level';

/** A waveform the way the media worker stores it: sqrt(peak) scaled to 0-255. */
const wave = (amplitudes: number[]) => Uint8Array.from(amplitudes.map((a) => Math.round(Math.min(1, Math.sqrt(a)) * 255)));

describe('telling a silent recording from a quiet one', () => {
  it('a microphone that gave nothing (peaks at -44 dBFS, as in a real 43-minute recording) is silent', () => {
    const dead = wave(Array.from({ length: 800 }, (_, i) => 0.002 + (i % 7) * 0.0006)); // at most about 0.0062
    expect(Math.max(...dead)).toBeLessThan(Math.ceil(Math.sqrt(SILENCE_AMPLITUDE) * 255));
    expect(isSilent(dead)).toBe(true);
    expect(audibleShare(dead)).toBe(0);
  });

  it('quiet speech with long pauses is not silent; nor is a lecture that starts after five minutes', () => {
    const quiet = wave(Array.from({ length: 800 }, (_, i) => (i % 10 === 0 ? 0.05 : 0.001)));
    expect(isSilent(quiet)).toBe(false);
    const lateStart = wave(Array.from({ length: 800 }, (_, i) => (i < 100 ? 0.001 : 0.2)));
    expect(isSilent(lateStart)).toBe(false);
    // ...but that lecture's first part, on its own, is silent and need not be transcribed.
    expect(isSilent(lateStart, 0, 0.1)).toBe(true);
    expect(isSilent(lateStart, 0.1, 0.3)).toBe(false);
  });

  it('a single click in silence does not count as sound; no waveform is never called silent', () => {
    const click = wave(Array.from({ length: 800 }, (_, i) => (i === 400 ? 0.9 : 0.001)));
    expect(isSilent(click)).toBe(true);
    expect(isSilent(null)).toBe(false);
    expect(isSilent(new Uint8Array(0))).toBe(false);
  });
});

describe("Whisper's silence hallucinations", () => {
  // The shape Groq returns; "Thank you." is what it wrote, 80 times, for a silent recording.
  const seg = (start: number, text: string, noSpeech: number, logprob: number) => ({ start, end: start + 2, text, no_speech_prob: noSpeech, avg_logprob: logprob });

  it('lines Whisper itself rates as probably not speech, and not confident, are dropped', () => {
    const result = parseVerboseJson(
      {
        text: ' Thank you. Hello everyone. Thank you.',
        segments: [seg(0, ' Thank you.', 0.92, -1.4), seg(5, ' Hello everyone.', 0.02, -0.2), seg(30, ' Thank you.', 0.88, -1.6)],
      },
      60_000,
    );
    expect(result.segments.map((s) => s.text)).toEqual([' Hello everyone.']);
  });

  it('confident speech is kept even if the no-speech guess is high, as Whisper itself does', () => {
    const result = parseVerboseJson({ segments: [seg(0, ' Yes.', 0.7, -0.3)] }, 5000);
    expect(result.segments).toHaveLength(1);
  });

  it('when every line was silence, the result is empty: the invented text never returns through the text fallback', () => {
    const result = parseVerboseJson({ text: ' Thank you. Thank you.', segments: [seg(0, ' Thank you.', 0.95, -1.2), seg(30, ' Thank you.', 0.9, -1.3)] }, 60_000);
    expect(result.segments).toEqual([]);
  });
});
