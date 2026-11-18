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

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`${context}: ${scrub(message)}`);
}
