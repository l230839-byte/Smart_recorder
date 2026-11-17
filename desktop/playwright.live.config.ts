import { defineConfig } from '@playwright/test';

/**
 * Tests against real AI services, with keys from desktop/.env.live (never committed). Run with
 * `npm run test:live`. They send generated speech, never anything personal, and write a report of
 * every result to test-results/live for a person to judge.
 */
export default defineConfig({
  testDir: 'tests/live',
  timeout: 20 * 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/live-output',
});
