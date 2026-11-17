import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BookOpen, CircleAlert, Copy, Ellipsis, Library as LibraryIcon, Lightbulb, MessageSquarePlus, MessagesSquare, Pencil, RotateCcw, Square, Trash2 } from 'lucide-react';
import { MAX_QUESTION_CHARS, STARTER_QUESTIONS, type ChatScope, type ChatThread, type ChatTurn } from '@shared/chat';
import { formatDuration, formatRelative, plural } from '@shared/format';
import { markdownToClipboard } from '@shared/markdown';
import { Button, ConfirmDialog, EmptyState, IconButton, Loading, Menu, TextPromptDialog } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { MarkdownView } from '../summary/MarkdownView';
import { useTranscribe } from '../transcript/ai-gate';
import { ScopePicker } from './ScopePicker';
import './chat.css';

/** Plays a cited moment, loading its recording first when it is not the one playing. */
function usePlayCitation() {
  const toast = useToast();
  return (ms: number, recordingId?: string) => {
    if (!recordingId) return;
    void api.getRecording(recordingId).then((rec) => {
      if (!rec) throw new Error('This recording no longer exists.');
      return player.load(rec, ms, true);
    }).catch(toast.showError);
  };
}

function Answer({ turn, onRetry, onStop }: { turn: ChatTurn; onRetry: () => void; onStop: () => void }) {
  const toast = useToast();
  const play = usePlayCitation();
  const [showSources, setShowSources] = useState(false);

  if (turn.status === 'pending') {
    return (
      <div className="chat-answer pending" role="status">
        <span className="thinking" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="muted">Reading your recordings…</span>
        <Button size="sm" variant="ghost" icon={Square} onClick={onStop}>
          Stop
        </Button>
      </div>
    );
  }
  if (turn.status === 'failed') {
    return (
      <div className="notice error" role="alert">
        <CircleAlert size={18} aria-hidden />
        <span className="grow">{turn.error ?? 'This answer could not be written.'}</span>
        <Button size="sm" icon={RotateCcw} onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const unlinked = turn.found !== 'no' && turn.sources.length === 0 && !!turn.content;
  return (
    <div className="chat-answer">
      {turn.found === 'no' && (
        <div className="answer-badge not-found">
          <BookOpen size={14} aria-hidden /> Not in your recordings
        </div>
      )}
      {turn.found === 'partly' && turn.sources.length > 0 && <div className="answer-badge partly">Partly answered by your recordings</div>}
      {turn.content && <MarkdownView markdown={turn.content} onCite={play} />}
      {turn.general && (
        <section className="general-knowledge" aria-label="General knowledge">
          <div className="general-title">
            <Lightbulb size={14} aria-hidden /> General knowledge, not from your recordings
          </div>
          <MarkdownView markdown={turn.general} onCite={play} />
        </section>
      )}
      {unlinked && (
        <div className="notice warning" role="status">
          EchoMind could not link this answer to any moment in your recordings. Check it before relying on it.
        </div>
      )}
      {turn.droppedCitations > 0 && (
        <div className="notice warning" role="status">
          {turn.droppedCitations === 1 ? 'The AI cited a line that was not in what it read. That reference was removed, so check the nearby claim.' : `The AI cited ${turn.droppedCitations} lines that were not in what it read. Those references were removed, so check nearby claims.`}
        </div>
      )}
      {turn.provider === 'fake' && <p className="muted small">Demo answer. Add a real provider in Settings for real answers.</p>}
      <div className="answer-foot">
        <span className="muted small">{turn.readNote}</span>
        <span className="grow" />
        {turn.sources.length > 0 && (
          <Button size="sm" variant="ghost" aria-expanded={showSources} onClick={() => setShowSources((v) => !v)}>
            {showSources ? 'Hide sources' : `Sources (${turn.sources.length})`}
          </Button>
        )}
        <IconButton
          icon={Copy}
          size={15}
          label="Copy answer"
          onClick={() => {
            const text = [turn.content, turn.general ? `General knowledge: ${turn.general}` : ''].filter(Boolean).join('\n\n');
            void navigator.clipboard.writeText(markdownToClipboard(text)).then(() => toast.show('Copied'), toast.showError);
          }}
        />
      </div>
      {showSources && (
        <ol className="source-list">
          {turn.sources.map((s) => (
            <li key={`${s.recordingId}@${s.startMs}`}>
              <button type="button" className="source-jump" onClick={() => play(s.startMs, s.recordingId)} aria-label={`Play ${s.recordingTitle} at ${formatDuration(s.startMs)}`}>
                <span className="cite tabular">{formatDuration(s.startMs)}</span>
                <span className="source-title truncate" dir="auto">
                  {s.recordingTitle}
                </span>
              </button>
              <p className="source-text selectable" dir="auto">
                {s.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ThreadList({ threads, current, onNew }: { threads: ChatThread[]; current: string | null; onNew: () => void }) {
  const { replace } = useRouter();
  return (
    <aside className="chat-threads" aria-label="Chats">
      <Button icon={MessageSquarePlus} onClick={onNew}>
        New chat
      </Button>
      <div className="thread-items">
        {threads.map((t) => (
          <button key={t.id} type="button" className="thread-item" aria-current={t.id === current ? 'page' : undefined} onClick={() => replace({ name: 'chat', threadId: t.id })}>
            <span className="thread-title truncate" dir="auto">
              {t.title}
            </span>
            <span className="muted small truncate">
              {t.scopeLabel} · {formatRelative(t.updatedAt)}
            </span>
          </button>
        ))}
        {!threads.length && <p className="muted small">Your chats appear here.</p>}
      </div>
    </aside>
  );
}

/**
 * Talk to recordings (prompt §9): one, several, a collection or the whole library. Answers cite moments
 * that play when selected, say plainly when the recordings do not cover something, and keep general
 * knowledge visibly apart.
 */
export function ChatScreen({ threadId, scope: initialScope }: { threadId?: string; scope?: ChatScope }) {
  const { replace } = useRouter();
  const toast = useToast();
  const { startText, dialogs } = useTranscribe();
  const threads = useQuery(() => api.listChats(), [], ['chats', 'library']);
  const detail = useQuery(() => (threadId ? api.getChat(threadId) : Promise.resolve(null)), [threadId], ['chats', 'library']);
  const [scope, setScope] = useState<ChatScope>(initialScope ?? { kind: 'library' });
  const scopeInfo = useQuery(() => api.chatScopeInfo(threadId && detail.data ? detail.data.thread.scope : scope), [threadId, detail.data?.thread.id, JSON.stringify(scope)], ['library', 'transcripts']);
  const [question, setQuestion] = useState('');
  const [picking, setPicking] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const thread = detail.data?.thread ?? null;
  const turns = useMemo(() => detail.data?.turns ?? [], [detail.data]);
  const pending = turns.some((t) => t.status === 'pending');
  const listed = (threads.data ?? []).filter((t) => t.messageCount > 0 || t.id === threadId);

  // The newest turn is always in view.
  // Braces matter: Chromium's scrollIntoView now returns a promise, which React would treat as a cleanup.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, turns.at(-1)?.status]);
  useEffect(() => {
    input.current?.focus();
  }, [threadId]);

  if (threadId && detail.data === null) return <EmptyState icon={MessagesSquare} title="This chat no longer exists" message="It was deleted, or a recording it used was permanently deleted." action={<Button onClick={() => replace({ name: 'chat' })}>New chat</Button>} />;
  if (!threads.data || (threadId && !detail.data)) return <Loading />;

  const activeScope = thread?.scope ?? scope;
  const many = activeScope.kind !== 'recordings' || activeScope.recordingIds.length > 1;

  const send = (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    let id = threadId ?? null;
    startText(
      async () => {
        // A new chat is created with its first question, so abandoned empty chats never pile up.
        id ??= await api.startChat(scope);
        return api.askChat(id, q);
      },
      () => {
        setQuestion('');
        if (!threadId && id) replace({ name: 'chat', threadId: id });
      },
    );
  };

  const info = scopeInfo.data;
  const noTranscripts = info && info.withTranscript === 0;

  return (
    <div className="chat-page">
      <ThreadList threads={listed} current={threadId ?? null} onNew={() => replace({ name: 'chat' })} />

      <section className="chat-main" aria-label="Conversation">
        <header className="chat-head">
          <div className="grow chat-head-text">
            <h1 className="truncate" dir="auto">
              {thread?.title ?? 'Ask your recordings'}
            </h1>
            <div className="chat-scope">
              <LibraryIcon size={14} aria-hidden />
              <span className="truncate" dir="auto">
                {thread?.scopeLabel ?? info?.label ?? ''}
              </span>
              {info && <span className="muted small">{`· ${info.withTranscript === 1 ? '1 recording with a transcript' : `${plural(info.withTranscript, 'recording')} with transcripts`}${info.recordings > info.withTranscript ? ` (of ${info.recordings})` : ''}`}</span>}
              {!thread && (
                <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
                  Change
                </Button>
              )}
            </div>
          </div>
          {thread && (
            <Menu
              icon={Ellipsis}
              label="Chat options"
              items={[
                { label: 'Rename', icon: Pencil, onSelect: () => setDialog('rename') },
                { label: 'Delete chat', icon: Trash2, danger: true, onSelect: () => setDialog('delete') },
              ]}
            />
          )}
        </header>

        <div className="chat-scroll">
          {thread && !thread.scopeValid && (
            <div className="notice warning" role="status">
              The collection this chat was about was deleted. Start a new chat to ask about other recordings.
            </div>
          )}
          {!turns.length ? (
            <div className="chat-empty">
              <MessagesSquare size={28} aria-hidden />
              <h2>Ask anything about {many ? 'these recordings' : 'this recording'}</h2>
              <p className="muted">Answers come from the transcripts, with times you can play. If something is not in them, EchoMind says so.</p>
              {noTranscripts ? (
                <p className="notice warning">{many ? 'None of these recordings has a transcript yet. Transcribe one first.' : 'This recording has no transcript yet. Transcribe it first.'}</p>
              ) : (
                <div className="starter-list">
                  {STARTER_QUESTIONS[many ? 'many' : 'single'].map((q) => (
                    <button key={q} type="button" className="chip" onClick={() => send(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <ol className="turns">
              {turns.map((t) =>
                t.role === 'user' ? (
                  <li key={t.id} className="turn user">
                    <div className="bubble selectable" dir="auto">
                      {t.content}
                    </div>
                  </li>
                ) : (
                  <li key={t.id} className="turn assistant">
                    <Answer
                      turn={t}
                      onRetry={() => startText(() => api.retryChat(t.id))}
                      onStop={() => void api.cancelChat(t.id).catch(toast.showError)}
                    />
                  </li>
                ),
              )}
            </ol>
          )}
          <div ref={bottom} />
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(question);
          }}
        >
          <textarea
            ref={input}
            aria-label="Your question"
            dir="auto"
            rows={1}
            maxLength={MAX_QUESTION_CHARS}
            placeholder={noTranscripts ? 'Transcribe a recording first' : many ? 'Ask about these recordings…' : 'Ask about this recording…'}
            disabled={!!noTranscripts || (thread !== null && !thread.scopeValid)}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(question);
              }
            }}
          />
          <IconButton icon={ArrowUp} label={pending ? 'Wait for the answer' : 'Send (Enter)'} type="submit" className="send-btn" disabled={!question.trim() || pending} />
        </form>
        <p className="composer-hint muted small">Enter sends, Shift+Enter adds a line. The question and the matching transcript passages go to your AI provider.</p>
      </section>

      {picking && (
        <ScopePicker
          initial={scope}
          onPick={(next) => {
            setScope(next);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {dialog === 'rename' && thread && <TextPromptDialog title="Rename chat" label="Name" initial={thread.title} onConfirm={(title) => void api.renameChat(thread.id, title).catch(toast.showError)} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && thread && (
        <ConfirmDialog
          title="Delete this chat?"
          message="The questions and answers are permanently removed. Recordings are not affected."
          confirmLabel="Delete"
          destructive
          onConfirm={() => void api.deleteChat(thread.id).then(() => replace({ name: 'chat' }), toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialogs}
    </div>
  );
}
