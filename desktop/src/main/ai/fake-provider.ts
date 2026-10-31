import type { ChunkSegment } from '@shared/transcript';
import type { TranscribeRequest, TranscribeResult, TranscriptionProvider } from './types';

const LINES = [
  'This is placeholder text from the demo provider, not your audio.',
  'Today we are looking at how a recording becomes searchable knowledge.',
  'What is the most important thing to remember from this session?',
  'Um, the transcript keeps timestamps so you can jump to any moment.',
  'یہ ایک آزمائشی جملہ ہے جو اردو متن کی جانچ کے لیے ہے۔',
  'Add a real provider in Settings when you want an actual transcript.',
];
const SEGMENT_MS = 2000;

/** Makes up a transcript with no network, so the whole app can be built and tried with no key. */
export class FakeProvider implements TranscriptionProvider {
  constructor(private readonly delayMs = 150) {}

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      request.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Canceled', 'AbortError'));
      });
    });
    const segments: ChunkSegment[] = [];
    for (let start = 0, i = 0; start < request.durationMs; start += SEGMENT_MS, i++) {
      segments.push({
        startMs: start,
        endMs: Math.min(start + SEGMENT_MS, request.durationMs),
        speaker: i % 4 < 2 ? 'A' : 'B',
        text: LINES[i % LINES.length]!,
        confidence: i % 5 === 3 ? 0.3 : 0.95,
      });
    }
    return { language: 'en', segments, rate: null };
  }

  async testConnection(): Promise<void> {}
}
