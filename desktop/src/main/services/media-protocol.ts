import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { parseRange } from '@shared/media';
import type { LibraryRepository } from '../db/library';

export const MEDIA_SCHEME = 'echomind-media';

/** Must run before the app is ready. */
export const DOCUMENT_SCHEME = 'echomind-doc';

/** Must run before the app is ready, and only once, so every scheme is registered here. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: DOCUMENT_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Serves a document page for the preview frame and for printing. The page carries no script and its
 * policy forbids any, along with every network request, so content from an AI can never act.
 */
export function handleDocumentProtocol(render: (documentId: string) => Promise<string>, locked: () => boolean = () => false): void {
  protocol.handle(DOCUMENT_SCHEME, async (request) => {
    if (locked()) return new Response('Locked', { status: 403 });
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\//, '');
    if (url.hostname !== 'preview' || !UUID.test(id)) return new Response('Not found', { status: 404 });
    try {
      const html = await render(id);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // No script, no network, nothing but its own styles and embedded fonts. Framing is allowed (the
          // editor shows it in a sandboxed frame); the scheme exists only inside EchoMind.
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'none'; base-uri 'none'; form-action 'none'",
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Serves a recording's audio to the player, with the range support seeking needs. The URL holds only a
 * recording id, which is resolved through the database, so no path from the UI ever reaches the disk.
 */
export function handleMediaProtocol(library: LibraryRepository, mediaDir: string, locked: () => boolean = () => false): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    // While the app is locked, no recording can be played or read.
    if (locked()) return new Response('Locked', { status: 403 });
    const id = new URL(request.url).pathname.replace(/^\//, '');
    const media = library.mediaFile(id);
    if (!media) return new Response('Not found', { status: 404 });
    const path = join(mediaDir, media.fileName);
    const size = (await stat(path).catch(() => null))?.size;
    if (size === undefined) return new Response('Not found', { status: 404 });

    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': media.mime, 'Access-Control-Allow-Origin': '*' };
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const range = parseRange(rangeHeader, size);
      if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      return new Response(Readable.toWeb(createReadStream(path, range)) as ReadableStream, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) },
      });
    }
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}
