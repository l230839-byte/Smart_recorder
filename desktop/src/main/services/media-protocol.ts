import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { parseRange } from '@shared/media';
import type { LibraryRepository } from '../db/library';

export const MEDIA_SCHEME = 'echomind-media';

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
}

/**
 * Serves a recording's audio to the player, with the range support seeking needs. The URL holds only a
 * recording id, which is resolved through the database, so no path from the UI ever reaches the disk.
 */
export function handleMediaProtocol(library: LibraryRepository, mediaDir: string): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
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
