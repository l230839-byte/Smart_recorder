import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { makeSpeech } from './meeting';

test('the meeting audio can be generated on this computer', () => {
  const file = makeSpeech(mkdtempSync(join(tmpdir(), 'speech-')));
  const wav = readFileSync(file);
  const seconds = (wav.length - 44) / (16000 * 2);
  console.warn(`speech: ${seconds.toFixed(1)} s, ${wav.length} bytes`);
  expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  expect(seconds).toBeGreaterThan(40);
});
