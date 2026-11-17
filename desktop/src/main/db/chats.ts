import { randomUUID } from 'node:crypto';
import { scopeLabel, type AnswerFound, type ChatScope, type ChatSource, type ChatThread, type ChatTurn } from '@shared/chat';
import { transaction, type Db } from './database';

interface ThreadRow {
  id: string;
  title: string;
  scope_kind: ChatScope['kind'];
  collection_id: string | null;
  collection_name: string | null;
  created_at: number;
  updated_at: number;
  messages: number;
}

interface TurnRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatTurn['status'];
  error: string | null;
  found: AnswerFound | null;
  general: string;
  sources: string;
  read_note: string;
  dropped_citations: number;
  provider: string | null;
  created_at: number;
}

const THREAD_SELECT = `
  SELECT t.*, c.name AS collection_name, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS messages
  FROM chat_threads t LEFT JOIN collections c ON c.id = t.collection_id`;

export const NEW_CHAT_TITLE = 'New chat';

/** Chats and their messages. Recording content in a chat is tracked, so deleting a recording deletes those chats. */
export class ChatRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(scope: ChatScope): string {
    const id = randomUUID();
    const t = this.now();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO chat_threads (id, title, scope_kind, collection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, NEW_CHAT_TITLE, scope.kind, scope.kind === 'collection' ? scope.collectionId : null, t, t);
      if (scope.kind === 'recordings') {
        const insert = this.db.prepare('INSERT OR IGNORE INTO chat_thread_recordings (thread_id, recording_id, in_scope) VALUES (?, ?, 1)');
        for (const rid of scope.recordingIds) insert.run(id, rid);
      }
    });
    return id;
  }

  private scopeOf(row: ThreadRow): ChatScope {
    if (row.scope_kind === 'library') return { kind: 'library' };
    if (row.scope_kind === 'collection') return { kind: 'collection', collectionId: row.collection_id ?? '' };
    const ids = this.db.prepare('SELECT recording_id FROM chat_thread_recordings WHERE thread_id = ? AND in_scope = 1 ORDER BY rowid').all(row.id) as { recording_id: string }[];
    return { kind: 'recordings', recordingIds: ids.map((r) => r.recording_id) };
  }

  private toThread(row: ThreadRow): ChatThread {
    const scope = this.scopeOf(row);
    const titles =
      scope.kind === 'recordings' && scope.recordingIds.length
        ? (this.db.prepare(`SELECT title FROM recordings WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(scope.recordingIds)) as { title: string }[]).map((r) => r.title)
        : [];
    return {
      id: row.id,
      title: row.title,
      scope,
      scopeLabel: scopeLabel(scope, { recordings: titles, collection: row.collection_name }),
      scopeValid: scope.kind === 'library' || (scope.kind === 'collection' ? row.collection_id !== null : scope.recordingIds.length > 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.messages,
    };
  }

  list(): ChatThread[] {
    return (this.db.prepare(`${THREAD_SELECT} ORDER BY t.updated_at DESC, t.rowid DESC`).all() as unknown as ThreadRow[]).map((r) => this.toThread(r));
  }

  get(id: string): ChatThread | null {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as ThreadRow | undefined;
    return row ? this.toThread(row) : null;
  }

  turns(threadId: string): ChatTurn[] {
    const rows = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as unknown as TurnRow[];
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      status: r.status,
      error: r.error,
      found: r.found,
      general: r.general,
      sources: JSON.parse(r.sources) as ChatSource[],
      readNote: r.read_note,
      droppedCitations: r.dropped_citations,
      provider: r.provider,
      createdAt: r.created_at,
    }));
  }

  /** A question and the answer it waits for. The first question names the chat. */
  addQuestion(threadId: string, question: string, provider: string, model: string): { questionId: string; answerId: string } {
    const questionId = randomUUID();
    const answerId = randomUUID();
    const t = this.now();
    transaction(this.db, () => {
      const insert = this.db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, status, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run(questionId, threadId, 'user', question, 'done', null, null, t);
      insert.run(answerId, threadId, 'assistant', '', 'pending', provider, model, t);
      const title = question.replace(/\s+/g, ' ').trim();
      this.db
        .prepare('UPDATE chat_threads SET updated_at = ?, title = CASE WHEN title = ? THEN ? ELSE title END WHERE id = ?')
        .run(t, NEW_CHAT_TITLE, title.length > 70 ? `${title.slice(0, 69).trimEnd()}…` : title, threadId);
    });
    return { questionId, answerId };
  }

  /** The question an answer belongs to, and the turns before it. */
  questionFor(answerId: string): { threadId: string; question: string; earlier: ChatTurn[] } | null {
    const row = this.db.prepare('SELECT thread_id FROM chat_messages WHERE id = ? AND role = ?').get(answerId, 'assistant') as { thread_id: string } | undefined;
    if (!row) return null;
    const turns = this.turns(row.thread_id);
    const at = turns.findIndex((t) => t.id === answerId);
    const question = turns[at - 1];
    if (!question || question.role !== 'user') return null;
    return { threadId: row.thread_id, question: question.content, earlier: turns.slice(0, at - 1) };
  }

  hasPending(threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_messages WHERE thread_id = ? AND status = 'pending'").get(threadId);
  }

  restart(answerId: string, provider: string, model: string): void {
    this.db.prepare("UPDATE chat_messages SET status = 'pending', error = NULL, content = '', provider = ?, model = ? WHERE id = ?").run(provider, model, answerId);
  }

  /** `read` is every recording whose text was sent to the model, cited or not: the answer may draw on any of them. */
  finish(answerId: string, answer: { content: string; found: AnswerFound; general: string; sources: ChatSource[]; readNote: string; dropped: number; read: string[] }): void {
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE chat_messages SET status = 'done', error = NULL, content = ?, found = ?, general = ?, sources = ?, read_note = ?, dropped_citations = ? WHERE id = ?")
        .run(answer.content, answer.found, answer.general, JSON.stringify(answer.sources), answer.readNote, answer.dropped, answerId);
      const thread = this.db.prepare('SELECT thread_id FROM chat_messages WHERE id = ?').get(answerId) as { thread_id: string } | undefined;
      if (!thread) return;
      const touch = this.db.prepare('INSERT OR IGNORE INTO chat_thread_recordings (thread_id, recording_id, in_scope) SELECT ?, id, 0 FROM recordings WHERE id = ?');
      for (const rid of new Set([...answer.read, ...answer.sources.map((s) => s.recordingId)])) touch.run(thread.thread_id, rid);
      this.db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(this.now(), thread.thread_id);
    });
  }

  fail(answerId: string, error: string): void {
    this.db.prepare("UPDATE chat_messages SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'").run(error, answerId);
  }

  /** Answers that were being written when EchoMind closed. */
  failInterrupted(): void {
    this.db.prepare("UPDATE chat_messages SET status = 'failed', error = 'EchoMind closed before this answer was ready. Ask again.' WHERE status = 'pending'").run();
  }

  rename(id: string, title: string): void {
    const clean = title.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('A chat needs a name.');
    this.db.prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run(clean.slice(0, 120), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
  }
}
