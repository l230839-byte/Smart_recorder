import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type CipherGCM, type DecipherGCM } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * EchoMind's archive format, for backups (encrypted) and share bundles (not encrypted).
 *
 *   "ECHOMIND-ARCHIVE 1\n", u32 header length, header JSON,
 *   entries: u32 name length, name (UTF-8), u64 size, bytes … ; a zero name length ends them,
 *   and, when encrypted, the 16-byte AES-256-GCM tag.
 *
 * Everything streams, so a library of many gigabytes never has to fit in memory. With a password, the
 * key comes from scrypt and the header carries a small encrypted check, so a wrong password is reported
 * at once instead of after reading the whole file. Tampering is caught by the GCM tag.
 */

const MAGIC = Buffer.from('ECHOMIND-ARCHIVE 1\n', 'utf8');
const TAG_BYTES = 16;
const KDF = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const CHECK_TEXT = Buffer.from('echomind-archive-ok', 'utf8');
const MAX_HEADER = 64 * 1024;
const MAX_NAME = 1024;

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: typeof KDF) => Promise<Buffer>;

export type ArchiveKind = 'backup' | 'bundle';

export interface ArchiveHeader {
  kind: ArchiveKind;
  createdAt: number;
  appVersion: string;
  /** Free-form details, such as counts, shown before restoring. */
  summary: Record<string, unknown>;
}

interface StoredHeader extends ArchiveHeader {
  encryption: null | { salt: string; iv: string; checkIv: string; check: string; checkTag: string };
}

export interface ArchiveEntry {
  name: string;
  /** A file to copy in, or bytes. */
  path?: string;
  data?: Buffer;
}

export class ArchivePasswordError extends Error {}

/** Names are relative paths made of safe parts, so an archive can never write outside its folder. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > MAX_NAME || name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name)) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[\u0000-\u001f<>:"|?*]/.test(part));
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), salt, 32, KDF);
}

class Sink {
  private cipher: CipherGCM | null = null;
  written = 0;

  constructor(private readonly out: WriteStream) {}

  encryptWith(cipher: CipherGCM): void {
    this.cipher = cipher;
  }

  async write(buf: Buffer): Promise<void> {
    const data = this.cipher ? this.cipher.update(buf) : buf;
    this.written += buf.length;
    if (data.length && !this.out.write(data)) await once(this.out, 'drain');
  }

  async finish(): Promise<void> {
    if (this.cipher) {
      const rest = this.cipher.final();
      if (rest.length) this.out.write(rest);
      this.out.write(this.cipher.getAuthTag());
    }
    this.out.end();
    await once(this.out, 'finish');
  }
}

/** Writes an archive. `onProgress` reports bytes of content written. */
export async function writeArchive(file: string, header: ArchiveHeader, entries: ArchiveEntry[], password: string | null, onProgress?: (done: number, total: number) => void): Promise<number> {
  let total = 0;
  for (const e of entries) {
    if (!safeEntryName(e.name)) throw new Error(`Unsafe name in archive: ${e.name}`);
    total += e.data ? e.data.length : (await stat(e.path!)).size;
  }
  const temp = `${file}.partial`;
  const out = createWriteStream(temp);
  const sink = new Sink(out);
  try {
    let encryption: StoredHeader['encryption'] = null;
    let cipher: CipherGCM | null = null;
    if (password !== null) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const checkIv = randomBytes(12);
      const key = await deriveKey(password, salt);
      const check = createCipheriv('aes-256-gcm', key, checkIv);
      const checkData = Buffer.concat([check.update(CHECK_TEXT), check.final()]);
      encryption = { salt: salt.toString('base64'), iv: iv.toString('base64'), checkIv: checkIv.toString('base64'), check: checkData.toString('base64'), checkTag: check.getAuthTag().toString('base64') };
      cipher = createCipheriv('aes-256-gcm', key, iv);
    }
    const headerJson = Buffer.from(JSON.stringify({ ...header, encryption } satisfies StoredHeader), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(headerJson.length);
    out.write(Buffer.concat([MAGIC, len, headerJson]));
    if (cipher) sink.encryptWith(cipher);

    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const size = e.data ? e.data.length : (await stat(e.path!)).size;
      const meta = Buffer.alloc(4 + name.length + 8);
      meta.writeUInt32BE(name.length, 0);
      name.copy(meta, 4);
      meta.writeBigUInt64BE(BigInt(size), 4 + name.length);
      await sink.write(meta);
      const before = sink.written;
      if (e.data) await sink.write(e.data);
      else for await (const chunk of createReadStream(e.path!, { highWaterMark: 1 << 20 })) await sink.write(chunk as Buffer);
      // A file that changed size while being read would corrupt the archive, so it is refused.
      if (sink.written - before !== size) throw new Error(`${e.name} changed while it was being saved. Try again.`);
      onProgress?.(sink.written, total);
    }
    await sink.write(Buffer.alloc(4));
    await sink.finish();
    await rename(temp, file);
    return (await stat(file)).size;
  } catch (e) {
    out.destroy();
    await rm(temp, { force: true });
    throw e;
  }
}

async function readHeader(file: string): Promise<{ header: StoredHeader; payloadStart: number; size: number }> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(MAGIC.length + 4);
    await handle.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not an EchoMind backup or bundle.');
    const length = head.readUInt32BE(MAGIC.length);
    if (length > MAX_HEADER) throw new Error('This file is damaged.');
    const json = Buffer.alloc(length);
    await handle.read(json, 0, length, head.length);
    let header: StoredHeader;
    try {
      header = JSON.parse(json.toString('utf8')) as StoredHeader;
    } catch {
      throw new Error('This file is damaged.');
    }
    return { header, payloadStart: head.length + length, size };
  } finally {
    await handle.close();
  }
}

/** The header, for showing what a file contains before anything is restored or imported. */
export async function inspectArchive(file: string): Promise<ArchiveHeader & { encrypted: boolean }> {
  const { header } = await readHeader(file);
  const { encryption, ...rest } = header;
  return { ...rest, encrypted: encryption !== null };
}

/**
 * Extracts every entry into `destDir`, refusing unsafe names and anything over `maxBytes`. With
 * encryption, a wrong password fails at once; tampering fails at the end, and then nothing extracted is
 * kept. Returns the names extracted.
 */
export async function extractArchive(file: string, destDir: string, password: string | null, options: { kind: ArchiveKind; maxBytes: number; onProgress?: (done: number, total: number) => void }): Promise<{ header: ArchiveHeader; names: string[] }> {
  const { header, payloadStart, size } = await readHeader(file);
  if (header.kind !== options.kind) throw new Error(options.kind === 'backup' ? 'This is a share bundle, not a backup. Use Import bundle instead.' : 'This is a backup, not a share bundle. Restore it from Backup instead.');
  let decipher: DecipherGCM | null = null;
  let end = size;
  if (header.encryption) {
    if (password === null) throw new ArchivePasswordError('This backup needs its password.');
    const enc = header.encryption;
    const key = await deriveKey(password, Buffer.from(enc.salt, 'base64'));
    try {
      const check = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.checkIv, 'base64'));
      check.setAuthTag(Buffer.from(enc.checkTag, 'base64'));
      const plain = Buffer.concat([check.update(Buffer.from(enc.check, 'base64')), check.final()]);
      if (!plain.equals(CHECK_TEXT)) throw new Error();
    } catch {
      throw new ArchivePasswordError('The password is not right.');
    }
    const tag = Buffer.alloc(TAG_BYTES);
    const handle = await open(file, 'r');
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    await handle.close();
    decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
    decipher.setAuthTag(tag);
    end = size - TAG_BYTES;
  }

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const names: string[] = [];
  const total = end - payloadStart;
  let done = 0;
  let pending: Buffer = Buffer.alloc(0);
  type State = 'name-length' | 'name' | 'size' | 'data' | 'end';
  let state: State = 'name-length';
  let need = 4;
  let remaining = 0n;
  let current: WriteStream | null = null;
  let extracted = 0;

  const openEntry = async (name: string) => {
    if (!safeEntryName(name)) throw new Error('This file contains an unsafe name and was not used.');
    const target = normalize(join(destDir, ...name.split('/')));
    if (!target.startsWith(normalize(destDir) + sep)) throw new Error('This file contains an unsafe name and was not used.');
    await mkdir(dirname(target), { recursive: true });
    names.push(name);
    current = createWriteStream(target);
  };
  const closeEntry = async () => {
    const stream = current as WriteStream | null;
    if (!stream) return;
    stream.end();
    await once(stream, 'finish');
    current = null;
  };

  const consume = async (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length) {
      if (state === 'end') throw new Error('This file is damaged.');
      if (state === 'data') {
        const take = Number(remaining < BigInt(pending.length) ? remaining : BigInt(pending.length));
        const stream = current as WriteStream | null;
        if (stream && take && !stream.write(pending.subarray(0, take))) await once(stream, 'drain');
        pending = pending.subarray(take);
        remaining -= BigInt(take);
        if (remaining === 0n) {
          await closeEntry();
          state = 'name-length';
          need = 4;
        }
        continue;
      }
      if (pending.length < need) return;
      const part = pending.subarray(0, need);
      pending = pending.subarray(need);
      if (state === 'name-length') {
        const length = part.readUInt32BE(0);
        if (length === 0) state = 'end';
        else if (length > MAX_NAME) throw new Error('This file is damaged.');
        else {
          state = 'name';
          need = length;
        }
      } else if (state === 'name') {
        await openEntry(part.toString('utf8'));
        state = 'size';
        need = 8;
      } else if (state === 'size') {
        remaining = part.readBigUInt64BE(0);
        extracted += Number(remaining);
        if (extracted > options.maxBytes) throw new Error('This file is larger than EchoMind accepts.');
        state = remaining === 0n ? 'name-length' : 'data';
        need = 4;
        if (remaining === 0n) await closeEntry();
      }
    }
  };

  try {
    const input = createReadStream(file, { start: payloadStart, end: end - 1, highWaterMark: 1 << 20 });
    for await (const raw of input) {
      const chunk = raw as Buffer;
      done += chunk.length;
      await consume(decipher ? decipher.update(chunk) : chunk);
      options.onProgress?.(done, total);
    }
    if (decipher) {
      try {
        await consume(decipher.final());
      } catch (e) {
        if (e instanceof Error && /auth|unable to authenticate/i.test(e.message)) throw new Error('This backup has been changed or damaged, so nothing from it was used.');
        throw e;
      }
    }
    // `consume` changes the state, which TypeScript cannot see from here.
    if ((state as State) !== 'end') throw new Error('This file is incomplete.');
    return { header, names };
  } catch (e) {
    await closeEntry().catch(() => undefined);
    await rm(destDir, { recursive: true, force: true });
    throw e;
  }
}
