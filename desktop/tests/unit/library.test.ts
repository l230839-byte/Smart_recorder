import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { ImportRepository, LibraryRepository, RECENT_WINDOW_MS, SessionRepository, toFtsQuery, type NewRecording } from '../../src/main/db/library';

let db: Db;
let repo: LibraryRepository;
let clock = 1_000_000_000;

function recording(over: Partial<NewRecording> = {}): NewRecording {
  return {
    title: 'A recording',
    mode: 'lecture',
    source: 'native',
    format: 'OGG',
    codec: 'opus',
    durationMs: 1000,
    sizeBytes: 100,
    sampleRate: 48000,
    channels: 1,
    fileName: `${Math.random()}.ogg`,
    mime: 'audio/ogg',
    peaks: new Uint8Array([1, 2, 3]),
    ...over,
  };
}

beforeEach(() => {
  clock = 1_000_000_000;
  db = openDatabase(':memory:');
  repo = new LibraryRepository(db, () => clock);
});

const titles = (q: Parameters<LibraryRepository['list']>[0]) => repo.list(q).map((r) => r.title);

describe('unified recordings', () => {
  it('native, imported and video recordings share one table and one shape', () => {
    repo.insertRecording(recording({ title: 'mic', source: 'native' }));
    repo.insertRecording(recording({ title: 'whatsapp', source: 'picker' }));
    repo.insertRecording(recording({ title: 'lecture video', source: 'video' }));
    const all = repo.list({ view: 'all', sort: 'title' });
    expect(all.map((r) => r.title)).toEqual(['lecture video', 'mic', 'whatsapp']);
    expect(new Set(all.map((r) => Object.keys(r).join()))).toHaveLength(1);
  });

  it('views separate recorded from imported', () => {
    repo.insertRecording(recording({ title: 'mic', source: 'native' }));
    repo.insertRecording(recording({ title: 'saved', source: 'recovered' }));
    repo.insertRecording(recording({ title: 'file', source: 'dropped' }));
    expect(titles({ view: 'recorded', sort: 'title' })).toEqual(['mic', 'saved']);
    expect(titles({ view: 'imported', sort: 'title' })).toEqual(['file']);
  });

  it('recent only includes the last week', () => {
    repo.insertRecording(recording({ title: 'old', createdAt: clock - RECENT_WINDOW_MS - 1 }));
    repo.insertRecording(recording({ title: 'new', createdAt: clock }));
    expect(titles({ view: 'recent', sort: 'newest' })).toEqual(['new']);
  });
});

describe('trash', () => {
  it('hides trashed items from other views and restores them', () => {
    const id = repo.insertRecording(recording({ title: 'x' }));
    repo.trash([id]);
    expect(titles({ view: 'all', sort: 'newest' })).toEqual([]);
    expect(titles({ view: 'trash', sort: 'newest' })).toEqual(['x']);
    repo.restore([id]);
    expect(titles({ view: 'all', sort: 'newest' })).toEqual(['x']);
  });

  it('a trashed copy does not block importing the same file again', () => {
    const id = repo.insertRecording(recording({ sourceSha256: 'abc' }));
    expect(repo.findBySha('abc')?.id).toBe(id);
    repo.trash([id]);
    expect(repo.findBySha('abc')).toBeNull();
  });

  it('deleting forever removes bookmarks, tags, peaks, search entries and returns files', () => {
    const id = repo.insertRecording(recording({ title: 'secret', fileName: 'f.ogg', bookmarks: [{ positionMs: 5, label: 'b', note: null }] }));
    repo.addTag(id, 'private');
    expect(repo.deleteForever([id])).toEqual(['f.ogg']);
    expect(repo.getRecording(id)).toBeNull();
    expect(repo.bookmarks(id)).toEqual([]);
    expect(repo.peaks(id)).toBeNull();
    expect(repo.tagsInUse(false)).toEqual([]);
    expect(db.prepare("SELECT * FROM recording_search WHERE recording_search MATCH 'secret'").all()).toEqual([]);
    expect(db.prepare('SELECT * FROM tags').all()).toEqual([]);
  });

  it('finds only items past the retention period', () => {
    const old = repo.insertRecording(recording());
    repo.trash([old]);
    clock += 100;
    const fresh = repo.insertRecording(recording());
    repo.trash([fresh]);
    expect(repo.trashedIds(clock - 50)).toEqual([old]);
  });
});

describe('tags', () => {
  it('are unique regardless of case and ignore a leading #', () => {
    const a = repo.insertRecording(recording());
    repo.addTag(a, '#Exam');
    repo.addTag(a, 'exam');
    repo.addTag(a, '  ');
    expect(repo.getRecording(a)!.tags.map((t) => t.name)).toEqual(['Exam']);
  });

  it('only offers filters for tags used in the current view', () => {
    const live = repo.insertRecording(recording());
    const gone = repo.insertRecording(recording());
    repo.addTag(live, 'exam');
    repo.addTag(gone, 'exam');
    repo.addTag(gone, 'budget');
    repo.trash([gone]);
    expect(repo.tagsInUse(false).map((t) => t.name)).toEqual(['exam']);
    expect(repo.tagsInUse(true).map((t) => t.name)).toEqual(['budget', 'exam']);
  });

  it('filter the list', () => {
    const a = repo.insertRecording(recording({ title: 'a' }));
    repo.insertRecording(recording({ title: 'b' }));
    repo.addTag(a, 'exam');
    const tagId = repo.getRecording(a)!.tags[0]!.id;
    expect(titles({ view: 'all', sort: 'title', tagId })).toEqual(['a']);
  });
});

describe('search', () => {
  it('matches title, description, tags and notes by prefix', () => {
    const a = repo.insertRecording(recording({ title: 'Neural networks', description: 'gradient descent' }));
    repo.addTag(a, 'machine');
    repo.addBookmark(a, 5, 'Bookmark', 'exam question here');
    for (const q of ['neur', 'gradient', 'machine', 'question']) {
      expect(titles({ view: 'all', sort: 'newest', text: q })).toEqual(['Neural networks']);
    }
    expect(titles({ view: 'all', sort: 'newest', text: 'unrelated' })).toEqual([]);
  });

  it('finds Urdu and mixed-language text', () => {
    repo.insertRecording(recording({ title: 'موسم کی رپورٹ meeting' }));
    expect(titles({ view: 'all', sort: 'newest', text: 'موسم' })).toHaveLength(1);
    expect(titles({ view: 'all', sort: 'newest', text: 'موسم meet' })).toHaveLength(1);
  });

  it('stays current after renaming', () => {
    const a = repo.insertRecording(recording({ title: 'before' }));
    repo.updateRecording(a, { title: 'after' });
    expect(titles({ view: 'all', sort: 'newest', text: 'before' })).toEqual([]);
    expect(titles({ view: 'all', sort: 'newest', text: 'after' })).toEqual(['after']);
  });

  it('treats search syntax as plain text and never throws', () => {
    repo.insertRecording(recording({ title: 'normal' }));
    for (const q of ['"', 'a OR', 'NEAR(', '*', 'title:x', '-', '((', "'; DROP TABLE recordings;--"]) {
      expect(() => repo.list({ view: 'all', sort: 'newest', text: q })).not.toThrow();
    }
    expect(toFtsQuery('()*')).toBeNull();
    expect(titles({ view: 'all', sort: 'newest', text: '()*' })).toEqual([]);
    expect(repo.list({ view: 'all', sort: 'newest' })).toHaveLength(1);
  });
});

describe('collections', () => {
  it('include recordings from nested sub-collections', () => {
    const uni = repo.createCollection('University', null);
    const sem = repo.createCollection('Semester 1', uni);
    repo.insertRecording(recording({ title: 'deep', collectionId: sem }));
    repo.insertRecording(recording({ title: 'outside' }));
    expect(titles({ view: 'all', sort: 'title', collectionId: uni })).toEqual(['deep']);
  });

  it('deleting one keeps recordings and moves children up', () => {
    const uni = repo.createCollection('University', null);
    const sem = repo.createCollection('Semester 1', uni);
    const ml = repo.createCollection('ML', sem);
    const r = repo.insertRecording(recording({ collectionId: sem }));
    repo.deleteCollection(sem);
    expect(repo.getRecording(r)!.collectionId).toBe(uni);
    expect(repo.collections().find((c) => c.id === ml)!.parentId).toBe(uni);
  });

  it('refuse to move inside themselves', () => {
    const a = repo.createCollection('A', null);
    const b = repo.createCollection('B', a);
    expect(() => repo.moveCollection(a, b)).toThrow(/inside itself/);
    expect(() => repo.moveCollection(a, a)).toThrow(/inside itself/);
  });
});

describe('import jobs', () => {
  it('survive interruption and retry cleanly', () => {
    const jobs = new ImportRepository(db, () => clock);
    const id = jobs.add('batch', 'C:\\a.mp3', 'a.mp3', 10, 'picker', 'lecture');
    expect(jobs.nextQueued()?.id).toBe(id);
    jobs.setStatus(id, 'converting', 0.5);
    expect(jobs.nextQueued()).toBeNull();
    jobs.requeueInterrupted();
    expect(jobs.get(id)).toMatchObject({ status: 'queued', progress: 0 });
    jobs.fail(id, 'corrupt', false);
    expect(jobs.get(id)).toMatchObject({ status: 'failed', retryable: false, error: 'corrupt' });
    expect(jobs.nextQueued()).toBeNull();
    jobs.requeue(id);
    expect(jobs.get(id)).toMatchObject({ status: 'queued', error: null, retryable: true });
  });

  it('clearing finished keeps failures visible', () => {
    const jobs = new ImportRepository(db, () => clock);
    const a = jobs.add('b', 'a', 'a', 1, 'picker', 'lecture');
    const b = jobs.add('b', 'b', 'b', 1, 'picker', 'lecture');
    const r = repo.insertRecording(recording());
    jobs.finish(a, r, null);
    jobs.fail(b, 'bad', true);
    jobs.clearFinished();
    expect(jobs.list().map((j) => j.id)).toEqual([b]);
  });
});

describe('recording sessions', () => {
  it('keep bookmarks from the moment they are made, for crash recovery', () => {
    const sessions = new SessionRepository(db);
    sessions.create({ id: 's', title: 'T', mode: 'meeting', startedAt: 1 });
    sessions.addBookmark('s', { positionMs: 12_000, label: 'Bookmark', note: 'budget' });
    expect(sessions.all()).toEqual([{ id: 's', title: 'T', mode: 'meeting', description: '', startedAt: 1, bookmarks: [{ positionMs: 12_000, label: 'Bookmark', note: 'budget' }] }]);
    sessions.remove('s');
    expect(sessions.all()).toEqual([]);
  });
});
