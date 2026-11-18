import { randomUUID } from 'node:crypto';
import {
  DEFAULT_STUDIO_OPTIONS,
  type QuizAnswer,
  type QuizAttempt,
  type StudioContent,
  type StudioKind,
  type StudioOptions,
  type StudioOutput,
  type StudioTemplate,
  type Task,
  type TaskEdit,
  type TaskStatus,
  type TaskSuggestion,
} from '@shared/studio';
import { transaction, type Db } from './database';

interface OutputRow {
  id: string;
  kind: StudioKind;
  title: string;
  options: string;
  content: string | null;
  dropped_citations: number;
  truncated: number;
  provider: string | null;
  created_at: number;
  recordings: string | null;
}

const OUTPUT_SELECT = `
  SELECT o.*, (SELECT json_group_array(json_object('id', r.id, 'title', r.title)) FROM (
    SELECT x.recording_id AS id, rec.title AS title FROM studio_output_recordings x JOIN recordings rec ON rec.id = x.recording_id
    WHERE x.output_id = o.id ORDER BY x.position) r) AS recordings
  FROM studio_outputs o`;

function toOutput(r: OutputRow): StudioOutput {
  const recs = JSON.parse(r.recordings ?? '[]') as { id: string; title: string }[];
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    recordingIds: recs.map((x) => x.id),
    recordingTitles: recs.map((x) => x.title),
    // Older results gain options added later, with their defaults.
    options: { ...DEFAULT_STUDIO_OPTIONS, ...(JSON.parse(r.options) as Partial<StudioOptions>) },
    content: r.content ? (JSON.parse(r.content) as StudioContent) : null,
    droppedCitations: r.dropped_citations,
    truncated: r.truncated === 1,
    provider: r.provider,
    createdAt: r.created_at,
  };
}

/** Everything AI Studio makes, saved with the recordings it came from (prompt §10). */
export class StudioRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: { kind: StudioKind; title: string; recordingIds: string[]; options: StudioOptions; provider: string }): string {
    const id = randomUUID();
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO studio_outputs (id, kind, title, options, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.kind, input.title, JSON.stringify(input.options), input.provider, this.now());
      const link = this.db.prepare('INSERT INTO studio_output_recordings (output_id, recording_id, position) VALUES (?, ?, ?)');
      input.recordingIds.forEach((rid, i) => link.run(id, rid, i));
    });
    return id;
  }

  get(id: string): StudioOutput | null {
    const row = this.db.prepare(`${OUTPUT_SELECT} WHERE o.id = ?`).get(id) as OutputRow | undefined;
    return row ? toOutput(row) : null;
  }

  list(recordingId?: string): StudioOutput[] {
    const rows = recordingId
      ? this.db.prepare(`${OUTPUT_SELECT} WHERE o.id IN (SELECT output_id FROM studio_output_recordings WHERE recording_id = ?) ORDER BY o.created_at DESC, o.rowid DESC`).all(recordingId)
      : this.db.prepare(`${OUTPUT_SELECT} ORDER BY o.created_at DESC, o.rowid DESC LIMIT 500`).all();
    return (rows as unknown as OutputRow[]).map(toOutput);
  }

  setContent(id: string, content: StudioContent, dropped: number, truncated: boolean): void {
    this.db.prepare('UPDATE studio_outputs SET content = ?, dropped_citations = ?, truncated = ? WHERE id = ?').run(JSON.stringify(content), dropped, truncated ? 1 : 0, id);
  }

  rename(id: string, title: string): void {
    const clean = title.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('A result needs a name.');
    this.db.prepare('UPDATE studio_outputs SET title = ? WHERE id = ?').run(clean.slice(0, 200), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM studio_outputs WHERE id = ?').run(id);
  }

  addAttempt(outputId: string, answers: QuizAnswer[], score: number, total: number): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO quiz_attempts (id, output_id, answers, score, total, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, outputId, JSON.stringify(answers), score, total, this.now());
    return id;
  }

  attempts(outputId: string): QuizAttempt[] {
    const rows = this.db.prepare('SELECT * FROM quiz_attempts WHERE output_id = ? ORDER BY created_at DESC, rowid DESC').all(outputId) as { id: string; output_id: string; answers: string; score: number; total: number; created_at: number }[];
    return rows.map((r) => ({ id: r.id, outputId: r.output_id, answers: JSON.parse(r.answers) as QuizAnswer[], score: r.score, total: r.total, createdAt: r.created_at }));
  }

  saveTemplate(name: string, kind: StudioKind, options: StudioOptions): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO studio_templates (id, name, kind, options, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), kind, JSON.stringify(options), this.now());
    return id;
  }

  templates(): StudioTemplate[] {
    const rows = this.db.prepare('SELECT id, name, kind, options FROM studio_templates ORDER BY name COLLATE NOCASE').all() as { id: string; name: string; kind: StudioKind; options: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, options: { ...DEFAULT_STUDIO_OPTIONS, ...(JSON.parse(r.options) as Partial<StudioOptions>) } }));
  }

  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM studio_templates WHERE id = ?').run(id);
  }
}

interface TaskRow {
  id: string;
  recording_id: string | null;
  recording_title: string | null;
  start_ms: number | null;
  source_text: string;
  title: string;
  description: string;
  due_date: string | null;
  due_text: string;
  owner: string;
  priority: Task['priority'];
  status: TaskStatus;
  remind_at: number | null;
  created_at: number;
  completed_at: number | null;
}

const TASK_SELECT = 'SELECT t.*, r.title AS recording_title FROM tasks t LEFT JOIN recordings r ON r.id = t.recording_id';

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    recordingId: r.recording_id,
    recordingTitle: r.recording_title,
    startMs: r.start_ms,
    sourceText: r.source_text,
    title: r.title,
    description: r.description,
    dueDate: r.due_date,
    dueText: r.due_text,
    owner: r.owner,
    priority: r.priority,
    status: r.status,
    remindAt: r.remind_at,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

/** Action items (prompt §14). Found tasks wait for the user's approval; nothing leaves the computer. */
export class TaskRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds found tasks for review, skipping ones already known for that recording. Returns how many were new. */
  addSuggestions(recordingIds: string[], suggestions: TaskSuggestion[]): number {
    let added = 0;
    transaction(this.db, () => {
      const exists = this.db.prepare("SELECT 1 FROM tasks WHERE lower(title) = lower(?) AND (recording_id IS ? OR recording_id IS NULL) AND status != 'dismissed'");
      const insert = this.db.prepare(
        "INSERT INTO tasks (id, recording_id, start_ms, source_text, title, description, due_date, due_text, owner, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?)",
      );
      for (const s of suggestions) {
        const rid = s.source?.recordingId ?? (recordingIds.length === 1 ? recordingIds[0]! : null);
        if (exists.get(s.title, rid)) continue;
        insert.run(randomUUID(), rid, s.source?.startMs ?? null, s.source?.text ?? '', s.title, s.description, s.dueDate, s.dueText, s.owner, s.priority, this.now());
        added++;
      }
    });
    return added;
  }

  create(input: { title: string; description?: string; dueDate?: string | null; recordingId?: string | null }): string {
    const title = input.title.trim();
    if (!title) throw new Error('A task needs a title.');
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO tasks (id, recording_id, title, description, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)")
      .run(id, input.recordingId ?? null, title.slice(0, 200), (input.description ?? '').trim(), input.dueDate ?? null, this.now());
    return id;
  }

  get(id: string): Task | null {
    const row = this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  list(filter: { status?: TaskStatus; recordingId?: string; text?: string } = {}): Task[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push('t.status = ?');
      params.push(filter.status);
    } else where.push("t.status != 'dismissed'");
    if (filter.recordingId) {
      where.push('t.recording_id = ?');
      params.push(filter.recordingId);
    }
    for (const word of (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      where.push("instr(lower(t.title || ' ' || t.description || ' ' || t.owner || ' ' || coalesce(r.title, '')), ?) > 0");
      params.push(word);
    }
    // Due first (soonest first), then undated, newest first.
    const rows = this.db.prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date, t.created_at DESC, t.rowid DESC`).all(...params) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  update(id: string, edit: TaskEdit): void {
    const current = this.get(id);
    if (!current) throw new Error('This task no longer exists.');
    if (edit.title !== undefined && !edit.title.trim()) throw new Error('A task needs a title.');
    if (edit.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(edit.dueDate)) throw new Error('Use a date like 2026-03-14.');
    const status = edit.status ?? current.status;
    const completedAt = status === 'done' ? (current.completedAt ?? this.now()) : null;
    const remindAt = edit.remindAt !== undefined ? edit.remindAt : current.remindAt;
    this.db
      .prepare('UPDATE tasks SET title = ?, description = ?, due_date = ?, owner = ?, priority = ?, status = ?, remind_at = ?, reminded = CASE WHEN ? THEN 0 ELSE reminded END, completed_at = ? WHERE id = ?')
      .run(
        (edit.title ?? current.title).trim().slice(0, 200),
        (edit.description ?? current.description).trim(),
        edit.dueDate !== undefined ? edit.dueDate : current.dueDate,
        (edit.owner ?? current.owner).trim(),
        edit.priority !== undefined ? edit.priority : current.priority,
        status,
        remindAt,
        edit.remindAt !== undefined ? 1 : 0,
        completedAt,
        id,
      );
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /** Reminders that are due and not yet shown. Marked as shown at once, so each appears only once. */
  takeDueReminders(): Task[] {
    const due = (this.db.prepare(`${TASK_SELECT} WHERE t.reminded = 0 AND t.remind_at IS NOT NULL AND t.remind_at <= ? AND t.status = 'open'`).all(this.now()) as unknown as TaskRow[]).map(toTask);
    const mark = this.db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?');
    for (const t of due) mark.run(t.id);
    return due;
  }

  counts(): { suggested: number; open: number; overdue: number } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const row = this.db
      .prepare("SELECT SUM(status = 'suggested') AS suggested, SUM(status = 'open') AS open, SUM(status = 'open' AND due_date IS NOT NULL AND due_date < ?) AS overdue FROM tasks")
      .get(today) as { suggested: number | null; open: number | null; overdue: number | null };
    return { suggested: row.suggested ?? 0, open: row.open ?? 0, overdue: row.overdue ?? 0 };
  }
}
