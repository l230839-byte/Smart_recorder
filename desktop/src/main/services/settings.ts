import { DEFAULT_SETTINGS, SETTING_CHOICES, type Settings } from '@shared/models';
import { LLM_PROVIDER_INFO, PROVIDER_INFO } from '@shared/providers';
import type { Db } from '../db/database';

/** Values must match the type of the default, or be null where null is the default. */
function validType(key: keyof Settings, value: unknown): boolean {
  const fallback = DEFAULT_SETTINGS[key];
  if (value === null) return fallback === null;
  const choices = SETTING_CHOICES[key];
  if (choices && !choices.includes(value as string)) return false;
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
    const before = this.get();
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS && value !== undefined && validType(key as keyof Settings, value)) upsert.run(key, JSON.stringify(value));
    }
    // A model belongs to its provider. Changing provider without choosing a model goes back to the new
    // provider's default, so one service's model name is never sent to another (seen live: Groq's
    // model sent to Gemini).
    const after = this.get();
    if (after.llmProvider !== before.llmProvider && !('llmModel' in patch) && after.llmModel && !LLM_PROVIDER_INFO[after.llmProvider].models.includes(after.llmModel)) upsert.run('llmModel', 'null');
    if (after.transcriptionProvider !== before.transcriptionProvider && !('transcriptionModel' in patch) && after.transcriptionModel && !PROVIDER_INFO[after.transcriptionProvider].models.includes(after.transcriptionModel)) upsert.run('transcriptionModel', 'null');
    return this.get();
  }
}
