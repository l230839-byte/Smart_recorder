import { useState } from 'react';
import { CircleAlert, Clock, Copy, Ellipsis, FileDown, ListChecks, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { formatDateTime, formatDuration, plural } from '@shared/format';
import { markdownToClipboard } from '@shared/markdown';
import { STUDIO_KINDS, studioMarkdown, type StudioOutput } from '@shared/studio';
import { Button, Card, ConfirmDialog, EmptyState, Loading, Menu, PageHeader, ProgressBar, TextPromptDialog } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { MarkdownView } from '../summary/MarkdownView';
import { formatRetryTime } from '../transcript/AiCard';
import { useTranscribe } from '../transcript/ai-gate';
import { FlashcardsView } from './FlashcardsView';
import { MindMapView } from './MindMapView';
import { QuizView } from './QuizView';
import './studio.css';

function usePlay() {
  const toast = useToast();
  return (ms: number, recordingId: string) =>
    void api
      .getRecording(recordingId)
      .then((rec) => {
        if (!rec) throw new Error('This recording no longer exists.');
        return player.load(rec, ms, true);
      })
      .catch(toast.showError);
}

/** One Studio result: progress while it is made, then the result itself, ready to use and export. */
export function StudioOutputScreen({ id }: { id: string }) {
  const { go, back } = useRouter();
  const toast = useToast();
  const play = usePlay();
  const { startDocument, dialogs } = useTranscribe();
  const output = useQuery(() => api.getStudio(id), [id], ['studio', 'library']);
  const job = useQuery(() => api.studioJob(id), [id], ['jobs', 'studio']);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);

  if (output.data === null) return <EmptyState icon={Sparkles} title="This result no longer exists" message="It was deleted, or a recording it came from was permanently deleted." action={<Button onClick={() => go({ name: 'studio' })}>Open AI Studio</Button>} />;
  const o = output.data;
  if (!o) return <Loading />;
  const current = job.data;
  const active = current && ['queued', 'running', 'waiting'].includes(current.status);
  const playFirst = (ms: number, recordingId?: string) => play(ms, recordingId ?? o.recordingIds[0]!);
  const exportable = o.content && o.content.type !== 'tasks';

  const toDocument = (exportAs: 'pdf' | 'docx') =>
    startDocument({ recordingId: o.recordingIds[0] ?? null, template: 'custom', source: 'studio', studioId: o.id, title: o.title }, (documentId) => go({ name: 'document', id: documentId, exportAs }));

  return (
    <div className="page studio-output">
      <PageHeader
        title={<span dir="auto">{o.title}</span>}
        subtitle={<Sources output={o} />}
        actions={
          <>
            {exportable && (
              <>
                <Button icon={FileDown} onClick={() => toDocument('pdf')}>
                  PDF or Word
                </Button>
                <Button
                  icon={Copy}
                  onClick={() => void navigator.clipboard.writeText(markdownToClipboard(studioMarkdown(o.content!, o.title))).then(() => toast.show('Copied'), toast.showError)}
                >
                  Copy
                </Button>
              </>
            )}
            <Menu
              icon={Ellipsis}
              label="More"
              items={[
                { label: 'Make another like this', icon: RotateCcw, onSelect: () => go({ name: 'studio-tool', kind: o.kind, recordingIds: o.recordingIds }) },
                { label: 'Rename', icon: Pencil, onSelect: () => setDialog('rename') },
                { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setDialog('delete') },
              ]}
            />
          </>
        }
      />

      {active && current && (
        <Card className="studio-job">
          <div className="row">
            {current.status === 'waiting' && <Clock size={15} aria-hidden />}
            <span className="grow small">{current.status === 'waiting' ? `Waiting until about ${formatRetryTime(current.nextAttemptAt)}` : current.stage}</span>
            <Button size="sm" variant="ghost" icon={X} onClick={() => void api.cancelJob(current.id).catch(toast.showError)}>
              Cancel
            </Button>
          </div>
          <ProgressBar value={current.progress} label={`${STUDIO_KINDS[o.kind].label} progress`} />
          {current.error && <p className="muted small">{current.error}</p>}
        </Card>
      )}
      {!o.content && current && (current.status === 'failed' || current.status === 'canceled') && (
        <div className="notice error" role="alert">
          <CircleAlert size={18} aria-hidden />
          <span className="grow">{current.status === 'canceled' ? 'This was canceled.' : current.error}</span>
          {current.retryable && current.status === 'failed' && (
            <Button size="sm" icon={RotateCcw} onClick={() => void api.retryJob(current.id).catch(toast.showError)}>
              Retry
            </Button>
          )}
        </div>
      )}

      {o.content && (
        <>
          {o.provider === 'fake' && (
            <div className="notice warning" role="status">
              This is demo material that only quotes the transcript. Add a real provider in Settings for real results.
            </div>
          )}
          {o.droppedCitations > 0 && (
            <div className="notice warning" role="status">
              {o.droppedCitations === 1 ? 'The AI pointed to a line that does not exist. That reference was removed, so check the nearby item.' : `The AI pointed to ${o.droppedCitations} lines that do not exist. Those references were removed, so check nearby items.`}
            </div>
          )}
          {o.truncated && (
            <div className="notice warning" role="status">
              This stopped at the length limit, so the end may be missing.
            </div>
          )}
          <Result output={o} onPlay={playFirst} onTasks={() => go({ name: 'tasks' })} />
        </>
      )}

      {dialogs}
      {dialog === 'rename' && <TextPromptDialog title="Rename" label="Name" initial={o.title} onConfirm={(title) => void api.renameStudio(o.id, title).catch(toast.showError)} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog title="Delete this result?" message="It is permanently removed, with any quiz attempts. The recordings are not affected." confirmLabel="Delete" destructive onConfirm={() => void api.deleteStudio(o.id).then(back, toast.showError)} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function Sources({ output }: { output: StudioOutput }) {
  const { go } = useRouter();
  return (
    <span className="studio-sources">
      {STUDIO_KINDS[output.kind].label} · {formatDateTime(output.createdAt)} · from{' '}
      {output.recordingTitles.map((t, i) => (
        <span key={output.recordingIds[i]}>
          {i > 0 && ', '}
          <button type="button" className="link-btn" dir="auto" onClick={() => go({ name: 'recording', id: output.recordingIds[i]! })}>
            {t}
          </button>
        </span>
      ))}
    </span>
  );
}

function Result({ output, onPlay, onTasks }: { output: StudioOutput; onPlay: (ms: number, recordingId?: string) => void; onTasks: () => void }) {
  const content = output.content!;
  switch (content.type) {
    case 'flashcards':
      return <FlashcardsView cards={content.cards} onPlay={onPlay} />;
    case 'quiz':
      return <QuizView outputId={output.id} questions={content.questions} onPlay={onPlay} />;
    case 'mindmap':
      return <MindMapView root={content.root} title={output.title} onPlay={onPlay} />;
    case 'markdown':
      return (
        <Card>
          <MarkdownView markdown={content.markdown} onCite={onPlay} />
          <p className="muted small" style={{ marginTop: 'var(--s4)' }}>
            Select a time to hear the source. AI can make mistakes, so check anything important against the recording.
          </p>
        </Card>
      );
    case 'translation': {
      const missing = content.lines.filter((l) => !l.text).length;
      return (
        <Card>
          {missing > 0 && (
            <div className="notice warning" role="status">
              {plural(missing, 'line was', 'lines were')} not translated. Their original text is shown.
            </div>
          )}
          <table className="translation">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Original</th>
                <th scope="col">{content.language}</th>
              </tr>
            </thead>
            <tbody>
              {content.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <button type="button" className="cite tabular" aria-label={`Play at ${formatDuration(l.startMs)}`} onClick={() => onPlay(l.startMs)}>
                      {formatDuration(l.startMs)}
                    </button>
                  </td>
                  <td dir="auto" className="muted">
                    {l.original}
                  </td>
                  <td dir="auto" className="selectable">
                    {l.text || l.original}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      );
    }
    case 'tasks':
      return (
        <EmptyState
          icon={ListChecks}
          title={content.count ? `Found ${plural(content.count, 'new action item')}` : 'No new action items'}
          message={content.count ? 'They are waiting for your review in Tasks. Approve the ones you want to keep; nothing is sent anywhere.' : 'Nothing new that someone committed to or was asked to do. Tasks found before are already in Tasks.'}
          action={<Button variant="primary" onClick={onTasks}>Open Tasks</Button>}
        />
      );
  }
}
