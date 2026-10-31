import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type Db = DatabaseSync;

export function openDatabase(path: string, migrations: readonly string[] = MIGRATIONS): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db, migrations);
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Each migration commits with its version bump, so a failed one leaves the database as it was. */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`This database was created by a newer EchoMind (schema ${current}). Please update the app.`);
  }
  for (let v = current; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
