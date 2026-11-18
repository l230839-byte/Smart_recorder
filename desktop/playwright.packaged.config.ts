import { defineConfig } from '@playwright/test';

/** Drives the packaged EchoMind.exe built by `npm run dist`, to prove the release itself works. */
export default defineConfig({
  testDir: 'tests/packaged',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/packaged',
});
