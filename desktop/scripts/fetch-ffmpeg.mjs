// Downloads the LGPL (shared-library) FFmpeg build into resources/bin, verifies its published checksum,
// and refuses it if it was configured with GPL or non-free code. It is a build asset: never committed,
// bundled into the installer.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const NAME = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1';
const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(root, 'resources', 'bin');
const ffmpeg = join(binDir, 'ffmpeg.exe');

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

if (!existsSync(ffmpeg)) {
  mkdirSync(binDir, { recursive: true });
  const work = join(tmpdir(), `echomind-ffmpeg-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const zip = join(work, 'ffmpeg.zip');
    console.log(`Downloading ${NAME}.zip`);
    const res = await fetch(`${RELEASE}/${NAME}.zip`);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));

    const sums = await (await fetch(`${RELEASE}/checksums.sha256`)).text();
    const line = sums.split('\n').find((l) => l.includes(`${NAME}.zip`));
    if (!line) throw new Error('The release publishes no checksum for this file.');
    const expected = line.trim().split(/\s+/)[0];
    const actual = await sha256(zip);
    if (expected !== actual) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);

    execFileSync('tar', ['-xf', zip, '-C', work]);
    const srcBin = join(work, NAME, 'bin');
    for (const file of readdirSync(srcBin)) {
      if (file !== 'ffplay.exe') copyFileSync(join(srcBin, file), join(binDir, file));
    }
    copyFileSync(join(work, NAME, 'LICENSE.txt'), join(binDir, 'FFMPEG-LICENSE.txt'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const config = execFileSync(ffmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
if (/--enable-(gpl|nonfree)\b/.test(config)) {
  rmSync(binDir, { recursive: true, force: true });
  throw new Error('This FFmpeg build contains GPL or non-free code. Refused and removed.');
}
console.log('FFmpeg ready: LGPL build, no GPL or non-free components.');
