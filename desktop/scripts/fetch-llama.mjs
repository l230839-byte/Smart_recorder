// Downloads the official llama.cpp Windows CPU build (MIT) into resources/bin/llama, checks it against the
// SHA-256 GitHub publishes for the asset, and saves llama.cpp's licence beside it. EchoMind runs its
// llama-server on this computer only (127.0.0.1) for offline summaries, chat and AI Studio. A build asset
// like FFmpeg and whisper.cpp: never committed, bundled into the installer. Pinned, not "latest".
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const TAG = 'b12193'; // published 2026-11-07
const ASSET = `llama-${TAG}-bin-win-cpu-x64.zip`;
const SHA256 = '6d9c0144272ab46b2d49f0404222bc164a375ae2f03c0394f2ea1aa91a0957fa';
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ASSET}`;
const LICENSE_URL = `https://raw.githubusercontent.com/ggml-org/llama.cpp/${TAG}/LICENSE`;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'resources', 'bin', 'llama');
const server = join(outDir, 'llama-server.exe');

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync(server)) {
  const work = join(tmpdir(), `echomind-llama-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const zip = join(work, ASSET);
    console.log(`Downloading llama.cpp ${TAG} (${ASSET})`);
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
    const found = files.find((f) => f.toLowerCase().endsWith('llama-server.exe'));
    if (!found) throw new Error('The release has no llama-server.exe.');
    // The server and the libraries it loads; the other tools in the release are not needed.
    const keep = files.filter((f) => dirname(f) === dirname(found) && (f === found || f.toLowerCase().endsWith('.dll')));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const f of keep) copyFileSync(f, join(outDir, f.slice(dirname(found).length + 1)));

    const license = await fetch(LICENSE_URL);
    if (!license.ok) throw new Error(`Could not fetch the licence: HTTP ${license.status}`);
    const text = await license.text();
    if (!/MIT License/i.test(text)) throw new Error('llama.cpp is no longer MIT licensed at this release. Refused.');
    writeFileSync(join(outDir, 'LLAMA-CPP-LICENSE.txt'), text);
    console.log(`Installed: ${keep.map((f) => f.slice(dirname(found).length + 1)).join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const run = spawnSync(server, ['--help'], { encoding: 'utf8' });
const help = `${run.stdout}${run.stderr}`;
for (const flag of ['--host', '--port', '--ctx-size', '--threads', '--model', '--jinja']) {
  if (!help.includes(flag)) throw new Error(`llama-server lacks ${flag}; EchoMind needs it.`);
}
console.log('llama.cpp ready (MIT).');
