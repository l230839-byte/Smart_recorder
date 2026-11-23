import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The only way the main process logs. Prompt §21: never log keys, transcripts or audio paths, so messages
 * are reduced to their kind and text with file paths and anything key-like removed.
 */
export function scrub(text: string): string {
  return text
    .replace(/[a-z]:\\[^\s'"]+/gi, '<path>')
    .replace(/\/(?:users|home|tmp|var)\/[^\s'"]+/gi, '<path>')
    .replace(/\b(gsk|sk|AIza)[-_A-Za-z0-9]{10,}/g, '<key>');
}

/** Kept small: it records only rare events (start, quit, crashes), so one old copy is plenty. */
const MAX_LOG_BYTES = 512 * 1024;
let logFile: string | null = null;

/** Where the diagnostics log lives (userData/logs). Until this is called, events go to the console only. */
export function initLogFile(dir: string): string {
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, 'echomind.log');
  return logFile;
}

function write(line: string): void {
  if (!logFile) return;
  try {
    try {
      if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A log that cannot be written must never take the app down with it.
  }
}

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const line = `${context}: ${scrub(message)}`;
  console.error(line);
  write(`ERROR ${line}`);
}

/**
 * Something that ended or interrupted the app: a quit, a crashed window, a stalled process. Kept on disk so
 * that "it just closed" leaves evidence of why.
 */
export function logEvent(event: string, detail = ''): void {
  const line = `${event}${detail ? ` ${scrub(detail)}` : ''}`;
  console.warn(line);
  write(line);
}
