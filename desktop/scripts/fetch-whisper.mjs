// Downloads the official whisper.cpp Windows build (MIT) into resources/bin/whisper, checks it against the
// SHA-256 GitHub publishes for the release asset, and saves whisper.cpp's licence beside it. A build
// asset like FFmpeg: never committed, bundled into the installer. Pinned to a build that had been public
// for weeks when chosen, rather than "latest".
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const TAG = 'b5454'; // published 2026-10-06
const ASSET = 'whisper-bin-x64.zip';
const SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
const URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/${ASSET}`;
const LICENSE_URL = `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${TAG}/LICENSE`;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'resources', 'bin', 'whisper');
const cli = join(outDir, 'whisper-cli.exe');

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Every file under a folder, so the zip's layout (with or without a Release folder) does not matter. */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync(cli)) {
  const work = join(tmpdir(), `echomind-whisper-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const zip = join(work, ASSET);
    console.log(`Downloading whisper.cpp ${TAG} (${ASSET})`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    const actual = await sha256(zip);
    if (actual !== SHA256) throw new Error(`Checksum mismatch: expected ${SHA256}, got ${actual}`);

    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    // Windows' own tar reads zips; a Git Bash tar earlier on PATH would take "C:" for a remote host.
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(existsSync(systemTar) ? systemTar : 'tar', ['-xf', zip, '-C', unpacked]);
    const files = walk(unpacked);
    const found = files.find((f) => f.toLowerCase().endsWith('whisper-cli.exe'));
    if (!found) throw new Error('The release has no whisper-cli.exe.');
    // The tool and the libraries it loads; the other example programs are not needed.
    const keep = files.filter((f) => dirname(f) === dirname(found) && (f === found || f.toLowerCase().endsWith('.dll')));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const f of keep) copyFileSync(f, join(outDir, f.slice(dirname(found).length + 1)));

    const license = await fetch(LICENSE_URL);
    if (!license.ok) throw new Error(`Could not fetch the licence: HTTP ${license.status}`);
    const text = await license.text();
    if (!/MIT License/i.test(text)) throw new Error('whisper.cpp is no longer MIT licensed at this release. Refused.');
    writeFileSync(join(outDir, 'WHISPER-CPP-LICENSE.txt'), text);
    console.log(`Installed: ${keep.map((f) => f.slice(dirname(found).length + 1)).join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// whisper-cli prints its help to stderr.
const run = spawnSync(cli, ['--help'], { encoding: 'utf8' });
const help = `${run.stdout}${run.stderr}`;
for (const flag of ['--output-json', '--language', '--threads', '--model', '--output-file']) {
  if (!help.includes(flag)) throw new Error(`whisper-cli lacks ${flag}; EchoMind needs it.`);
}
console.log('whisper.cpp ready (MIT).');
