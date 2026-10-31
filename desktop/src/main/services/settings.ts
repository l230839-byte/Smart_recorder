import { DEFAULT_SETTINGS, type Settings } from '@shared/models';
import type { Db } from '../db/database';

/** Values must match the type of the default, or be null where null is the default. */
function validType(key: keyof Settings, value: unknown): boolean {
  const fallback = DEFAULT_SETTINGS[key];
  if (value === null) return fallback === null;
  return fallback === null || typeof value === typeof fallback;
}

export class SettingsStore {
  constructor(private readonly db: Db) {}

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  /** Unknown keys are ignored, so a stale or malformed caller cannot grow the table. */
  update(patch: Partial<Settings>): Settings {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS && value !== undefined && validType(key as keyof Settings, value)) upsert.run(key, JSON.stringify(value));
    }
    return this.get();
  }
}
