import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import electronPath from 'electron';

export const FIXTURES = resolve('test-fixtures');

export function ffmpegInstalled(): boolean {
  return existsSync(resolve('resources/bin/ffmpeg.exe'));
}

export function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

/** Generated on demand so no binary media lives in the repository. */
export function ensureFixtures(): void {
  if (existsSync(fixture('empty.wav'))) return;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronPath as unknown as string, [resolve('tests/fixtures/main.cjs'), FIXTURES], { env, encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0 || !existsSync(fixture('empty.wav'))) throw new Error(`Could not generate fixtures: ${result.stderr}`);
}
