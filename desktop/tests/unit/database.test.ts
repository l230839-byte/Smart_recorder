import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaVersion, type Db } from '../../src/main/db/database';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { SettingsStore } from '../../src/main/services/settings';
import { DEFAULT_SETTINGS } from '../../src/shared/models';

let db: Db;
afterEach(() => db?.close());

describe('migrations', () => {
  it('bring a new database to the latest version and can run again safely', () => {
    db = openDatabase(':memory:');
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });

  it('roll back completely when a migration fails', () => {
    db = openDatabase(':memory:', ['CREATE TABLE a (id TEXT) STRICT']);
    expect(() => migrate(db, ['CREATE TABLE a (id TEXT) STRICT', 'CREATE TABLE b (id TEXT); SELECT * FROM missing;'])).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
  });

  it('refuse a database from a newer version of the app', () => {
    db = openDatabase(':memory:');
    expect(() => migrate(db, [])).toThrow(/newer EchoMind/);
  });

  it('enforce foreign keys', () => {
    db = openDatabase(':memory:');
    expect(() => db.prepare("INSERT INTO bookmarks VALUES ('b', 'no-such-recording', 0, 'x', NULL, 0)").run()).toThrow();
  });

  it('provide FTS5 full-text search, including Urdu', () => {
    db = openDatabase(':memory:');
    db.prepare("INSERT INTO recording_search VALUES ('r1', 'موسم کی رپورٹ', '', '', '')").run();
    expect(db.prepare("SELECT recording_id FROM recording_search WHERE recording_search MATCH 'موسم'").all()).toHaveLength(1);
  });
});

describe('settings', () => {
  it('start from defaults, with offline-only on', () => {
    db = openDatabase(':memory:');
    const settings = new SettingsStore(db).get();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.offlineOnly).toBe(true);
  });

  it('persist updates and ignore unknown keys', () => {
    db = openDatabase(':memory:');
    const store = new SettingsStore(db);
    store.update({ theme: 'dark', displayName: 'علی', hacked: true } as never);
    const settings = store.get();
    expect(settings.theme).toBe('dark');
    expect(settings.displayName).toBe('علی');
    expect(settings).not.toHaveProperty('hacked');
  });
});
