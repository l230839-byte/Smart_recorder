// Downloads the official sherpa-onnx Windows build (Apache-2.0) into resources/bin/sherpa, checks it against
// the SHA-256 GitHub publishes for the asset, and keeps only the offline speaker-diarization tool and the
// libraries it loads, with sherpa-onnx's licence. EchoMind uses it to tell speakers apart on this computer.
// A build asset like FFmpeg: never committed, bundled into the installer. Pinned, not "latest".
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const TAG = 'v2.0.1'; // published 2026-10-26
const ASSET = 'sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2';
const SHA256 = 'a644dfe2f7944afec9a356d2557c0452380f20ffcf2f8c704653cfce37558596';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${TAG}/${ASSET}`;
const LICENSE_URL = `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/${TAG}/LICENSE`;
const TOOL = 'sherpa-onnx-offline-speaker-diarization.exe';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'resources', 'bin', 'sherpa');
const tool = join(outDir, TOOL);

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

if (!existsSync(tool)) {
  const work = join(tmpdir(), `echomind-sherpa-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const archive = join(work, ASSET);
    console.log(`Downloading sherpa-onnx ${TAG} (${ASSET})`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
    const actual = await sha256(archive);
    if (actual !== SHA256) throw new Error(`Checksum mismatch: expected ${SHA256}, got ${actual}`);

    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    // Windows' own tar reads .tar.bz2; a Git Bash tar earlier on PATH would take "C:" for a remote host.
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(existsSync(systemTar) ? systemTar : 'tar', ['-xf', archive, '-C', unpacked]);
    const files = walk(unpacked);
    const found = files.find((f) => f.toLowerCase().endsWith(TOOL));
    if (!found) throw new Error(`The release has no ${TOOL}.`);
    // The tool and the libraries beside it (onnxruntime, sherpa-onnx); the other programs are not needed.
    const dlls = files.filter((f) => f.toLowerCase().endsWith('.dll') && (dirname(f) === dirname(found) || /[\\/]lib[\\/]?$/i.test(dirname(f))));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    copyFileSync(found, tool);
    for (const f of dlls) copyFileSync(f, join(outDir, f.split(/[\\/]/).pop()));

    const license = await fetch(LICENSE_URL);
    if (!license.ok) throw new Error(`Could not fetch the licence: HTTP ${license.status}`);
    const text = await license.text();
    if (!/Apache License/i.test(text)) throw new Error('sherpa-onnx is no longer Apache licensed at this release. Refused.');
    writeFileSync(join(outDir, 'SHERPA-ONNX-LICENSE.txt'), text);
    console.log(`Installed: ${TOOL}, ${dlls.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const run = spawnSync(tool, ['--help'], { encoding: 'utf8' });
const help = `${run.stdout}${run.stderr}`;
for (const flag of ['--segmentation.pyannote-model', '--embedding.model', '--clustering.num-clusters', '--clustering.cluster-threshold']) {
  if (!help.includes(flag)) throw new Error(`The diarization tool lacks ${flag}; EchoMind needs it.`);
}
console.log('sherpa-onnx speaker diarization ready (Apache-2.0).');
