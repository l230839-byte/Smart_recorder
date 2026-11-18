import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/migrations';
import type { Db } from '../db/database';
import { extractArchive, writeArchive, type ArchiveEntry } from './archive';

/** Backups hold the whole library; this guards against a damaged size field filling the disk. */
const MAX_RESTORE_BYTES = 2 * 1024 ** 4;
const STAGING = 'restore-staging';
const PREVIOUS = 'previous-data';
const READY = 'READY';
/** What a restore replaces, and what is kept aside so it can be undone by hand. */
const DATA_ITEMS = ['echomind.db', 'echomind.db-wal', 'echomind.db-shm', 'media', 'exports'];

async function filesUnder(dir: string, prefix: string): Promise<ArchiveEntry[]> {
  if (!existsSync(dir)) return [];
  const out: ArchiveEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path, `${prefix}${entry.name}/`)));
    else if (entry.isFile()) out.push({ name: `${prefix}${entry.name}`, path });
  }
  return out;
}

async function sizeOf(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const s = await stat(path);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

/**
 * Encrypted backup and restore to a place the user chooses, such as a USB drive or a synced cloud folder
 * (prompt §15.9). API keys are left out: they are protected by this Windows account and could not be read
 * elsewhere, so they are entered again after restoring on another computer.
 */
export class BackupService {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly appVersion: string,
  ) {}

  async create(file: string, password: string, onProgress: (done: number, total: number) => void): Promise<{ sizeBytes: number; recordings: number }> {
    if (password.length < 8) throw new Error('Use a password of at least 8 characters.');
    const snapshotDir = join(this.dataDir, 'tmp', `backup-${Date.now()}`);
    await mkdir(snapshotDir, { recursive: true });
    const snapshot = join(snapshotDir, 'echomind.db');
    try {
      // A consistent copy of the database, taken while EchoMind keeps running.
      this.db.prepare('VACUUM INTO ?').run(snapshot);
      const copy = new DatabaseSync(snapshot);
      copy.exec('DELETE FROM secrets; DELETE FROM app_lock; VACUUM;');
      const recordings = (copy.prepare('SELECT COUNT(*) AS n FROM recordings WHERE deleted_at IS NULL').get() as { n: number }).n;
      const documents = (copy.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
      copy.close();
      const entries = [{ name: 'db/echomind.db', path: snapshot }, ...(await filesUnder(join(this.dataDir, 'media'), 'media/')), ...(await filesUnder(join(this.dataDir, 'exports'), 'exports/'))];
      const sizeBytes = await writeArchive(file, { kind: 'backup', createdAt: Date.now(), appVersion: this.appVersion, summary: { recordings, documents } }, entries, password, onProgress);
      return { sizeBytes, recordings };
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  }

  /**
   * Checks and unpacks a backup next to the current data. Nothing is replaced yet: the swap happens at the
   * next launch, before the database is opened, so it can never mix old and new data.
   */
  async prepareRestore(file: string, password: string, onProgress: (done: number, total: number) => void): Promise<{ recordings: number; createdAt: number }> {
    const staging = join(this.dataDir, STAGING);
    const { header } = await extractArchive(file, staging, password, { kind: 'backup', maxBytes: MAX_RESTORE_BYTES, onProgress });
    const dbFile = join(staging, 'db', 'echomind.db');
    try {
      if (!existsSync(dbFile)) throw new Error('This backup has no library in it.');
      const check = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const ok = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
        if (ok !== 'ok') throw new Error('The library in this backup is damaged.');
        const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (version > MIGRATIONS.length) throw new Error('This backup was made by a newer version of EchoMind. Update EchoMind first.');
        const recordings = (check.prepare('SELECT COUNT(*) AS n FROM recordings WHERE deleted_at IS NULL').get() as { n: number }).n;
        await writeFile(join(staging, READY), JSON.stringify({ file, createdAt: header.createdAt }));
        return { recordings, createdAt: header.createdAt };
      } finally {
        check.close();
      }
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  }

  async cancelRestore(): Promise<void> {
    await rm(join(this.dataDir, STAGING), { recursive: true, force: true });
  }

  async previousData(): Promise<{ sizeBytes: number } | null> {
    const dir = join(this.dataDir, PREVIOUS);
    return existsSync(dir) ? { sizeBytes: await sizeOf(dir) } : null;
  }

  async deletePreviousData(): Promise<void> {
    await rm(join(this.dataDir, PREVIOUS), { recursive: true, force: true });
  }
}

/**
 * Run at launch before the database opens. Puts a checked, unpacked backup in place, keeping the data it
 * replaces in "previous-data" until the user removes it. Returns true when a restore was applied.
 */
export async function applyPendingRestore(dataDir: string): Promise<boolean> {
  const staging = join(dataDir, STAGING);
  if (!existsSync(join(staging, READY))) {
    if (existsSync(staging)) await rm(staging, { recursive: true, force: true });
    return false;
  }
  const previous = join(dataDir, PREVIOUS);
  await rm(previous, { recursive: true, force: true });
  await mkdir(previous, { recursive: true });
  for (const item of DATA_ITEMS) if (existsSync(join(dataDir, item))) await rename(join(dataDir, item), join(previous, item));
  await rename(join(staging, 'db', 'echomind.db'), join(dataDir, 'echomind.db'));
  for (const dir of ['media', 'exports']) {
    if (existsSync(join(staging, dir))) await rename(join(staging, dir), join(dataDir, dir));
    else await mkdir(join(dataDir, dir), { recursive: true });
  }
  await rm(staging, { recursive: true, force: true });
  return true;
}
