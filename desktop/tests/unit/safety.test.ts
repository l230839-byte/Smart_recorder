import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { DocumentRepository } from '../../src/main/db/documents';
import { LibraryRepository } from '../../src/main/db/library';
import { SummaryRepository } from '../../src/main/db/summaries';
import { SecretStore, TranscriptRepository, type Cipher } from '../../src/main/db/transcripts';
import { AppLock } from '../../src/main/services/app-lock';
import { ArchivePasswordError, extractArchive, inspectArchive, safeEntryName, writeArchive } from '../../src/main/services/archive';
import { applyPendingRestore, BackupService } from '../../src/main/services/backup';
import { BundleService, validateManifest } from '../../src/main/services/bundles';
import { DEFAULT_DOCUMENT_SETTINGS } from '../../src/shared/documents';
import type { Segment } from '../../src/shared/transcript';

const seg = (idx: number, startMs: number, text: string, speaker: string | null = null): Segment => ({ idx, startMs, endMs: startMs + 1000, text, speaker, confidence: null });
const temp = () => mkdtempSync(join(tmpdir(), 'echomind-safety-'));
const header = { kind: 'backup' as const, createdAt: 1, appVersion: 'test', summary: {} };

describe('archives', () => {
  it('round-trip files and bytes, with and without a password', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(3_000_000, 7));
    for (const password of [null, 'correct horse']) {
      const file = join(dir, `x-${password ? 'enc' : 'plain'}`);
      await writeArchive(file, header, [{ name: 'db/a.bin', path: join(dir, 'a.bin') }, { name: 'note.txt', data: Buffer.from('یہ ٹھیک ہے') }, { name: 'empty', data: Buffer.alloc(0) }], password);
      expect((await inspectArchive(file)).encrypted).toBe(password !== null);
      const out = join(dir, `out-${password ? 'enc' : 'plain'}`);
      const { names } = await extractArchive(file, out, password, { kind: 'backup', maxBytes: 1e9 });
      expect(names).toEqual(['db/a.bin', 'note.txt', 'empty']);
      expect(readFileSync(join(out, 'db', 'a.bin')).equals(Buffer.alloc(3_000_000, 7))).toBe(true);
      expect(readFileSync(join(out, 'note.txt'), 'utf8')).toBe('یہ ٹھیک ہے');
      // Encrypted content is not readable in the file.
      if (password) expect(readFileSync(file).includes(Buffer.from('یہ ٹھیک ہے'))).toBe(false);
    }
  });

  it('a wrong password fails at once; tampering fails and leaves nothing behind', async () => {
    const dir = temp();
    const file = join(dir, 'b');
    await writeArchive(file, header, [{ name: 'secret.txt', data: Buffer.from('private words '.repeat(1000)) }], 'right password');
    await expect(extractArchive(file, join(dir, 'o1'), 'wrong password', { kind: 'backup', maxBytes: 1e9 })).rejects.toBeInstanceOf(ArchivePasswordError);
    await expect(extractArchive(file, join(dir, 'o1'), null, { kind: 'backup', maxBytes: 1e9 })).rejects.toThrow(/needs its password/);
    const bytes = readFileSync(file);
    const at = bytes.length - 100;
    bytes[at] = bytes[at]! ^ 0xff;
    writeFileSync(file, bytes);
    await expect(extractArchive(file, join(dir, 'o2'), 'right password', { kind: 'backup', maxBytes: 1e9 })).rejects.toThrow(/changed or damaged/);
    expect(existsSync(join(dir, 'o2'))).toBe(false);
  });

  it('refuse unsafe names, the wrong kind, oversized content and other files', async () => {
    for (const bad of ['../x', '/abs', 'a/../../b', 'C:/x', 'a\\b', '', 'a//b', 'con:x']) expect(safeEntryName(bad), bad).toBe(false);
    expect(safeEntryName('media/abc-123.ogg')).toBe(true);
    const dir = temp();
    await expect(writeArchive(join(dir, 'c'), header, [{ name: '../evil', data: Buffer.from('x') }], null)).rejects.toThrow(/Unsafe/);
    await writeArchive(join(dir, 'd'), header, [{ name: 'big', data: Buffer.alloc(5000) }], null);
    await expect(extractArchive(join(dir, 'd'), join(dir, 'o'), null, { kind: 'bundle', maxBytes: 1e9 })).rejects.toThrow(/backup, not a share bundle/);
    await expect(extractArchive(join(dir, 'd'), join(dir, 'o'), null, { kind: 'backup', maxBytes: 100 })).rejects.toThrow(/larger than/);
    writeFileSync(join(dir, 'e'), 'just text');
    await expect(inspectArchive(join(dir, 'e'))).rejects.toThrow(/not an EchoMind/);
  });
});

const cipher: Cipher = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => Buffer.from(b).toString() };

describe('backup and restore', () => {
  it('back up a library, restore it at the next launch, keep the old data aside, and leave keys out', async () => {
    const dataDir = temp();
    mkdirSync(join(dataDir, 'media'));
    mkdirSync(join(dataDir, 'exports', 'doc1'), { recursive: true });
    writeFileSync(join(dataDir, 'media', 'one.ogg'), 'AUDIO-ONE');
    writeFileSync(join(dataDir, 'exports', 'doc1', 'notes.pdf'), '%PDF');
    let db: Db = openDatabase(join(dataDir, 'echomind.db'));
    const library = new LibraryRepository(db);
    library.insertRecording({ title: 'Kept', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 1, sizeBytes: 1, sampleRate: 1, channels: 1, fileName: 'one.ogg', mime: 'audio/ogg', peaks: new Uint8Array(1) });
    new SecretStore(db, cipher).set('groq', 'secret-key');
    new AppLock(db).setPin('1234', null);
    const service = new BackupService(db, dataDir, 'test');
    const backupFile = join(temp(), 'b.echomind-backup');
    const progress: number[] = [];
    await expect(service.create(backupFile, 'short', () => undefined)).rejects.toThrow(/at least 8/);
    expect(await service.create(backupFile, 'a strong password', (done) => progress.push(done))).toMatchObject({ recordings: 1 });
    expect(progress.length).toBeGreaterThan(0);

    // The library changes after the backup.
    library.insertRecording({ title: 'Added later', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 1, sizeBytes: 1, sampleRate: 1, channels: 1, fileName: 'two.ogg', mime: 'audio/ogg', peaks: new Uint8Array(1) });
    await expect(service.prepareRestore(backupFile, 'not it', () => undefined)).rejects.toThrow(/password is not right/);
    expect(await service.prepareRestore(backupFile, 'a strong password', () => undefined)).toMatchObject({ recordings: 1 });
    db.close();

    // Next launch.
    expect(await applyPendingRestore(dataDir)).toBe(true);
    db = openDatabase(join(dataDir, 'echomind.db'));
    expect(new LibraryRepository(db).list({ view: 'all', sort: 'newest' }).map((r) => r.title)).toEqual(['Kept']);
    expect(new SecretStore(db, cipher).has('groq')).toBe(false);
    expect(new AppLock(db).state().enabled).toBe(false);
    expect(readFileSync(join(dataDir, 'media', 'one.ogg'), 'utf8')).toBe('AUDIO-ONE');
    expect(readFileSync(join(dataDir, 'exports', 'doc1', 'notes.pdf'), 'utf8')).toBe('%PDF');
    expect(existsSync(join(dataDir, 'previous-data', 'echomind.db'))).toBe(true);
    expect(await new BackupService(db, dataDir, 'test').previousData()).not.toBeNull();
    expect(await applyPendingRestore(dataDir)).toBe(false);
    db.close();
  });

  it('a backup from a newer version is refused before anything changes', async () => {
    const dataDir = temp();
    const db = openDatabase(join(dataDir, 'echomind.db'));
    db.exec('PRAGMA user_version = 999');
    const file = join(temp(), 'new.echomind-backup');
    await new BackupService(db, dataDir, 'test').create(file, 'a strong password', () => undefined);
    await expect(new BackupService(db, dataDir, 'test').prepareRestore(file, 'a strong password', () => undefined)).rejects.toThrow(/newer version/);
    expect(existsSync(join(dataDir, 'restore-staging'))).toBe(false);
    db.close();
  });
});

describe('share bundles', () => {
  let db: Db;
  let dir: string;
  afterEach(() => db.close());
  beforeEach(() => {
    db = openDatabase(':memory:');
    dir = temp();
  });

  it('carry a recording with its transcript, summaries, chapters and documents to another library', async () => {
    mkdirSync(join(dir, 'media'));
    writeFileSync(join(dir, 'media', 'r.ogg'), 'OGG-AUDIO');
    const library = new LibraryRepository(db);
    const transcripts = new TranscriptRepository(db);
    const summaries = new SummaryRepository(db);
    const documents = new DocumentRepository(db);
    const id = library.insertRecording({ title: 'Lecture 5', mode: 'lecture', source: 'picker', format: 'OGG', codec: 'Opus', durationMs: 60_000, sizeBytes: 9, sampleRate: 48000, channels: 1, fileName: 'r.ogg', mime: 'audio/ogg', peaks: new Uint8Array(1), bookmarks: [{ positionMs: 5000, label: 'Key point', note: null }] });
    library.addTag(id, 'exam');
    const v = transcripts.addOriginal(id, 'groq', 'whisper', 'ur', [seg(0, 0, 'سلام', 'A'), seg(1, 2000, 'Neural networks')]);
    transcripts.renameSpeaker(id, 'A', 'Dr. Khan');
    summaries.add({ recordingId: id, label: 'Bullets', options: {} as never, markdown: '- Point [0:00](cite:0)', provider: 'groq', model: 'm', transcriptVersionId: v, droppedCitations: 0, truncated: false });
    summaries.saveChapters(id, v, [{ idx: 0, startMs: 0, endMs: 2000, title: 'Intro', summary: 'Greeting' }]);
    documents.create({ recordingId: id, title: 'Notes', template: 'custom', settings: DEFAULT_DOCUMENT_SETTINGS, markdown: '## Notes' });

    // The receiving library, with a stand-in pipeline that records what it was asked to ingest.
    const other = openDatabase(':memory:');
    const otherLibrary = new LibraryRepository(other);
    const ingested: string[] = [];
    const receiver = new BundleService({
      library: otherLibrary,
      transcripts: new TranscriptRepository(other),
      summaries: new SummaryRepository(other),
      documents: new DocumentRepository(other),
      mediaDir: join(dir, 'media2'),
      tempDir: join(dir, 'tmp'),
      appVersion: 'test',
      pipeline: {
        ingest: async (req) => {
          ingested.push(readFileSync(req.workFile, 'utf8'));
          const rid = otherLibrary.insertRecording({ title: req.title, description: req.description, mode: req.mode, source: req.source, format: 'OGG', codec: 'Opus', durationMs: 60_000, sizeBytes: 9, sampleRate: 48000, channels: 1, fileName: 'x.ogg', mime: 'audio/ogg', peaks: new Uint8Array(1), createdAt: req.createdAt, bookmarks: req.bookmarks });
          await rename(req.workFile, join(dir, 'consumed'));
          return { recordingId: rid, warning: null };
        },
      },
    });
    const sender = new BundleService({ library, transcripts, summaries, documents, pipeline: { ingest: async () => ({ recordingId: '', warning: null }) }, mediaDir: join(dir, 'media'), tempDir: join(dir, 'tmp'), appVersion: 'test' });
    const file = join(dir, 'share.echomind');
    await sender.export(id, file);
    const { recordingId } = await receiver.import(file);

    expect(ingested).toEqual(['OGG-AUDIO']);
    const rec = otherLibrary.getRecording(recordingId)!;
    expect(rec).toMatchObject({ title: 'Lecture 5', mode: 'lecture' });
    expect(rec.tags.map((t) => t.name)).toEqual(['exam']);
    expect(otherLibrary.bookmarks(recordingId).map((b) => b.label)).toEqual(['Key point']);
    const t2 = new TranscriptRepository(other);
    expect(t2.segments(t2.current(recordingId)!.id).map((s) => s.text)).toEqual(['سلام', 'Neural networks']);
    expect(t2.speakerNames(recordingId)).toEqual({ A: 'Dr. Khan' });
    expect(new SummaryRepository(other).list(recordingId).map((s) => s.markdown)).toEqual(['- Point [0:00](cite:0)']);
    expect(new SummaryRepository(other).chapters(recordingId).map((c) => c.title)).toEqual(['Intro']);
    expect(new DocumentRepository(other).list(recordingId).map((d) => d.title)).toEqual(['Notes']);
    other.close();
  });

  it('manifests from elsewhere are checked and limited', () => {
    expect(() => validateManifest({ format: 'other' })).toThrow(/different version/);
    expect(() => validateManifest({ format: 'echomind-bundle', version: 1, audio: '../../evil' })).toThrow(/no usable audio/);
    const m = validateManifest({ format: 'echomind-bundle', version: 1, audio: 'audio/recording.ogg', recording: { title: 'x'.repeat(500), mode: 'hacker', tags: [1, 'ok'] }, transcript: { segments: [{ startMs: -5, endMs: 'x', text: 'Hi' }, { text: '   ' }] } });
    expect(m.recording.title).toHaveLength(200);
    expect(m.recording.mode).toBe('notes');
    expect(m.recording.tags).toEqual(['ok']);
    expect(m.transcript!.segments).toEqual([{ idx: 0, startMs: 0, endMs: 0, text: 'Hi', speaker: null, confidence: null }]);
  });
});

describe('app lock', () => {
  let db: Db;
  let now: number;
  beforeEach(() => {
    db = openDatabase(':memory:');
    now = 1_000_000;
  });
  afterEach(() => db.close());

  it('is off until a PIN is set, locks on demand and at launch, and unlocks only with the PIN', () => {
    let lock = new AppLock(db, () => now);
    expect(lock.state()).toEqual({ enabled: false, locked: false, autoLockMinutes: 5, waitUntil: null });
    expect(lock.lock()).toBe(false);
    expect(() => lock.setPin('12', null)).toThrow(/4 to 12 digits/);
    lock.setPin('2468', null);
    expect(lock.lock()).toBe(true);
    expect(lock.unlock('1111')).toBe(false);
    expect(lock.unlock('2468')).toBe(true);
    // A new launch starts locked.
    lock = new AppLock(db, () => now);
    expect(lock.isLocked()).toBe(true);
    expect(db.prepare('SELECT hex(hash) AS h FROM app_lock').get()).not.toEqual({ h: Buffer.from('2468').toString('hex').toUpperCase() });
  });

  it('changing or removing the PIN needs the current one', () => {
    const lock = new AppLock(db, () => now);
    lock.setPin('2468', null);
    expect(() => lock.setPin('1357', null)).toThrow(/current PIN/);
    expect(() => lock.setPin('1357', '0000')).toThrow(/current PIN/);
    lock.setPin('1357', '2468');
    expect(() => lock.disable('2468')).toThrow(/not right/);
    lock.disable('1357');
    expect(lock.state().enabled).toBe(false);
  });

  it('wrong PINs cost growing waits that survive a restart', () => {
    let lock = new AppLock(db, () => now);
    lock.setPin('2468', null);
    lock.lock();
    for (let i = 0; i < 4; i++) expect(lock.unlock('0000')).toBe(false);
    expect(lock.state().waitUntil).toBeNull();
    expect(lock.unlock('0000')).toBe(false);
    expect(lock.state().waitUntil).toBe(now + 30_000);
    lock = new AppLock(db, () => now);
    expect(() => lock.unlock('2468')).toThrow(/Try again in 30 seconds/);
    now += 30_001;
    expect(lock.unlock('0000')).toBe(false);
    expect(lock.state().waitUntil).toBe(now + 60_000);
    now += 60_001;
    expect(lock.unlock('2468')).toBe(true);
    lock.lock();
    expect(lock.unlock('0000')).toBe(false);
    expect(lock.state().waitUntil).toBeNull();
  });

  it('locks after the chosen idle time, or never', () => {
    const lock = new AppLock(db, () => now);
    lock.setPin('2468', null);
    lock.unlock('2468');
    expect(lock.idle(299)).toBe(false);
    expect(lock.idle(300)).toBe(true);
    lock.unlock('2468');
    lock.setAutoLock(0);
    expect(lock.idle(99_999)).toBe(false);
    expect(() => lock.setAutoLock(7)).toThrow(/offered/);
  });
});

describe('logging', () => {
  it('never carries file paths or keys', async () => {
    const { scrub } = await import('../../src/main/log');
    expect(scrub(String.raw`ENOENT: no such file, open 'C:\Users\Ali\AppData\Roaming\EchoMind\media\x.ogg'`)).toBe("ENOENT: no such file, open '<path>'");
    expect(scrub('Bad key gsk_abcdefghijklmnop123 rejected')).toBe('Bad key <key> rejected');
  });
});
