import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { ProcessingJob } from '../../src/shared/models';

/** Keys from desktop/.env.live, which git ignores. */
export function loadKeys(): Record<string, string> {
  const file = resolve('.env.live');
  if (!existsSync(file)) return {};
  const keys: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) keys[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return keys;
}

export function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window.echomind.call as unknown as (m: string, ...x: unknown[]) => Promise<T>)(m as string, ...(a as unknown[])), [method, args] as const);
}

/** Waits for a job to finish. `onChange` sees each new status line, for reports of long jobs. */
export async function waitJob(page: Page, load: () => Promise<ProcessingJob | null>, timeoutMs = 6 * 60_000, onChange?: (job: ProcessingJob) => void): Promise<ProcessingJob> {
  let job: ProcessingJob | null = null;
  let last = '';
  await expect
    .poll(
      async () => {
        job = await load();
        if (job && onChange) {
          const line = `${job.status}|${job.stage}|${job.error ?? ''}`;
          if (line !== last) {
            last = line;
            onChange(job);
          }
        }
        return job && ['done', 'failed', 'canceled'].includes(job.status) ? job.status : 'running';
      },
      { timeout: timeoutMs, intervals: [1000, 2000, 3000, 5000] },
    )
    .not.toBe('running');
  return job!;
}

export const citeCount = (md: string) => (md.match(/\(cite:/g) ?? []).length;

/** Times cited in markdown, in ms: links look like (cite:12345) or (cite:12345@recordingId). */
export const citedTimes = (md: string) => [...md.matchAll(/\(cite:(\d+)/g)].map((m) => Number(m[1]));
