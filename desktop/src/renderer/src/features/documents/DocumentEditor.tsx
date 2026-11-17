import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bold,
  ChevronDown,
  CircleAlert,
  Clock,
  Ellipsis,
  FileAudio,
  FolderOpen,
  Heading2,
  Heading3,
  History,
  Italic,
  List,
  ListOrdered,
  Minus,
  PanelRight,
  RotateCcw,
  Save,
  SquarePen,
  Table,
  TextQuote,
  Trash2,
  X,
} from 'lucide-react';
import { EXPORT_FORMATS, PAGE_MM, templateById, type DocumentSettings, type ExportFormat } from '@shared/documents';
import { formatDateTime } from '@shared/format';
import { applyCommand, headingAnchorAt, type EditCommand } from '@shared/markdown-edit';
import { Button, Card, ConfirmDialog, Dialog, EmptyState, IconButton, Loading, Menu, ProgressBar, Segmented, TextPromptDialog, type IconType } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { formatRetryTime } from '../transcript/AiCard';
import { LayoutPanel } from './LayoutPanel';
import './documents.css';

interface Draft {
  title: string;
  markdown: string;
  settings: DocumentSettings;
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

const TOOLS: { command: EditCommand; label: string; icon: IconType; keys?: string }[] = [
  { command: 'h2', label: 'Heading', icon: Heading2 },
  { command: 'h3', label: 'Subheading', icon: Heading3 },
  { command: 'bold', label: 'Bold', icon: Bold, keys: 'Ctrl+B' },
  { command: 'italic', label: 'Italic', icon: Italic, keys: 'Ctrl+I' },
  { command: 'bullets', label: 'Bulleted list', icon: List },
  { command: 'numbers', label: 'Numbered list', icon: ListOrdered },
  { command: 'quote', label: 'Quote', icon: TextQuote },
  { command: 'table', label: 'Table', icon: Table },
  { command: 'rule', label: 'Divider', icon: Minus },
];

const SAVE_DELAY_MS = 500;

/** Edit on the left, the real page on the right. Every change is saved as you type. */
export function DocumentEditor({ id, exportAs = 'pdf' }: { id: string; exportAs?: ExportFormat }) {
  const { go, back } = useRouter();
  const toast = useToast();
  const doc = useQuery(() => api.getDocument(id), [id], ['documents']);
  const job = useQuery(() => api.documentJob(id), [id], ['jobs', 'documents']);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [rev, setRev] = useState(0);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [view, setView] = useState<'split' | 'edit' | 'preview'>('split');
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [dialog, setDialog] = useState<'versions' | 'save-version' | 'delete' | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void> | null>(null);

  // Take what is stored, unless the person has changes that are not saved yet. That covers the first
  // load, the AI's draft arriving, and restoring a version.
  const data = doc.data;
  useEffect(() => {
    if (!data || pending.current || saving.current) return;
    setDraft({ title: data.title, markdown: data.markdown, settings: data.settings });
  }, [data]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (saving.current) await saving.current;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState('saving');
    saving.current = api.updateDocument(id, next).then(
      () => {
        setSaveState(pending.current ? 'unsaved' : 'saved');
        setRev((r) => r + 1);
      },
      (e: unknown) => {
        pending.current ??= next;
        setSaveState('error');
        toast.showError(e);
      },
    );
    await saving.current;
    saving.current = null;
  }, [id, toast]);

  // Nothing typed is lost when leaving the screen.
  useEffect(() => () => void save(), [save]);

  const change = (patch: Partial<Draft>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    pending.current = next;
    setSaveState('unsaved');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  const followCursor = () => {
    const el = textarea.current;
    if (el) setAnchor(headingAnchorAt(el.value, el.selectionStart));
  };

  const run = (command: EditCommand) => {
    const el = textarea.current;
    if (!el) return;
    const edit = applyCommand(el.value, { start: el.selectionStart, end: el.selectionEnd }, command);
    el.focus();
    el.setSelectionRange(edit.from, edit.to);
    // insertText keeps the change on the text box's own undo stack, so Ctrl+Z undoes it.
    if (!document.execCommand('insertText', false, edit.insert)) {
      el.setRangeText(edit.insert, edit.from, edit.to, 'end');
      change({ markdown: el.value });
    }
    el.setSelectionRange(edit.select.start, edit.select.end);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save().then(() => toast.show('Saved'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, toast]);

  if (doc.data === null) return <EmptyState icon={SquarePen} title="This document no longer exists" message="It may have been deleted, or its recording was permanently deleted." action={<Button onClick={() => go({ name: 'documents' })}>Open documents</Button>} />;
  if (!data || !draft) return <Loading />;

  const current = job.data;
  const writing = !!current && ['queued', 'running', 'waiting'].includes(current.status);
  const failed = current?.status === 'failed' && !draft.markdown;
  const waitingForAi = writing && !draft.markdown;
  const template = templateById(data.template);

  const doExport = async (format: ExportFormat) => {
    await save();
    setExporting(format);
    try {
      const exported = await api.exportDocument(id, format);
      toast.show(`${EXPORT_FORMATS[format].label} saved`, { label: 'Open', run: () => void api.openExport(exported.id).catch(toast.showError) });
    } catch (e) {
      toast.showError(e);
    } finally {
      setExporting(null);
    }
  };

  const saveLabel = { saved: 'Saved', unsaved: 'Editing', saving: 'Saving…', error: 'Not saved' }[saveState];

  return (
    <div className="page doc-page">
      <header className="doc-head">
        <div className="grow doc-head-main">
          <input className="doc-title-input" aria-label="Document title" dir="auto" maxLength={200} value={draft.title} onChange={(e) => change({ title: e.target.value })} />
          <div className="doc-meta muted small">
            <span>{template.name}</span>
            {data.recordingId && data.recordingTitle && (
              <>
                <span aria-hidden>·</span>
                <button type="button" className="link-btn" dir="auto" onClick={() => go({ name: 'recording', id: data.recordingId! })}>
                  {data.recordingTitle}
                </button>
              </>
            )}
            <span aria-hidden>·</span>
            <span className={`save-state ${saveState}`} role="status">
              {saveLabel}
            </span>
          </div>
        </div>
        <div className="row doc-actions">
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'edit', label: 'Write' },
              { value: 'split', label: 'Both' },
              { value: 'preview', label: 'Page' },
            ]}
          />
          <IconButton icon={PanelRight} label="Layout and style" active={layoutOpen} onClick={() => setLayoutOpen((v) => !v)} />
          <IconButton icon={History} label="Versions" onClick={() => setDialog('versions')} />
          <div className="split-btn">
            <Button variant="primary" icon={exporting ? undefined : FolderOpen} disabled={!!exporting || waitingForAi} onClick={() => void doExport(exportAs)}>
              {exporting ? `Exporting ${EXPORT_FORMATS[exporting].label}…` : `Export ${EXPORT_FORMATS[exportAs].label}`}
            </Button>
            <Menu
              icon={ChevronDown}
              label="Other export formats"
              items={[
                ...(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((format) => ({
                  label: `Export ${EXPORT_FORMATS[format].label}`,
                  onSelect: () => void doExport(format),
                })),
                { label: 'All exports', icon: FolderOpen, onSelect: () => go({ name: 'documents' }) },
              ]}
            />
          </div>
          <Menu
            icon={Ellipsis}
            label="More"
            items={[
              { label: 'Save a version', icon: Save, onSelect: () => setDialog('save-version') },
              ...(data.recordingId ? [{ label: 'Open recording', icon: FileAudio, onSelect: () => go({ name: 'recording', id: data.recordingId! }) }] : []),
              { label: 'Delete document', icon: Trash2, danger: true, onSelect: () => setDialog('delete') },
            ]}
          />
        </div>
      </header>

      {writing && current && (
        <Card className="doc-job">
          <div className="row">
            {current.status === 'waiting' && <Clock size={15} aria-hidden />}
            <span className="grow small">{current.status === 'waiting' ? `Waiting until about ${formatRetryTime(current.nextAttemptAt)}` : `Writing your ${template.name.toLowerCase()}: ${current.stage}`}</span>
            <Button size="sm" variant="ghost" icon={X} onClick={() => void api.cancelJob(current.id).catch(toast.showError)}>
              Cancel
            </Button>
          </div>
          <ProgressBar value={current.progress} label="Document progress" />
          {current.error && <p className="muted small">{current.error}</p>}
        </Card>
      )}
      {failed && current && (
        <div className="notice error" role="alert">
          <CircleAlert size={18} aria-hidden />
          <span className="grow">{current.error ?? 'The document could not be written.'} You can try again, or write it yourself below.</span>
          {current.retryable && (
            <Button size="sm" icon={RotateCcw} onClick={() => void api.retryJob(current.id).catch(toast.showError)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {current?.provider === 'fake' && !!draft.markdown && (
        <div className="notice warning" role="status">
          This draft is demo text that only quotes the transcript. Add a real provider in Settings for an actual document.
        </div>
      )}
      {data.truncated && (
        <div className="notice warning" role="status">
          The AI stopped at its length limit, so the end may be missing.
        </div>
      )}
      {data.droppedCitations > 0 && (
        <div className="notice warning" role="status">
          {data.droppedCitations === 1 ? 'The AI cited a time that does not exist in the transcript. It was removed, so check the nearby claim.' : `The AI cited ${data.droppedCitations} times that do not exist in the transcript. They were removed, so check nearby claims.`}
        </div>
      )}

      <div className={`doc-work view-${view} ${layoutOpen ? 'with-layout' : ''}`}>
        {view !== 'preview' && (
          <section className="doc-pane doc-edit" aria-label="Text">
            <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
              {TOOLS.map((t) => (
                <IconButton key={t.command} icon={t.icon} size={16} label={t.keys ? `${t.label} (${t.keys})` : t.label} disabled={waitingForAi} onMouseDown={(e) => e.preventDefault()} onClick={() => run(t.command)} />
              ))}
            </div>
            <textarea
              ref={textarea}
              className="doc-text"
              aria-label="Document text"
              dir="auto"
              spellCheck
              disabled={waitingForAi}
              placeholder={waitingForAi ? 'The AI is writing. The draft appears here when it is ready.' : '## A heading\n\nWrite here. Use the buttons above for headings, lists and tables.'}
              value={draft.markdown}
              onChange={(e) => change({ markdown: e.target.value })}
              onSelect={followCursor}
              onKeyDown={(e) => {
                if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
                const key = e.key.toLowerCase();
                if (key === 'b' || key === 'i') {
                  e.preventDefault();
                  run(key === 'b' ? 'bold' : 'italic');
                }
              }}
            />
            <p className="doc-hint muted small">Times such as [3:05](cite:185000) link to that moment in the recording. Keep them to show where content came from.</p>
          </section>
        )}
        {view !== 'edit' && (
          <section className="doc-pane doc-preview" aria-label="Page preview">
            <PagePreview src={`echomind-doc://preview/${id}?v=${data.updatedAt}-${rev}${anchor ? `#${anchor}` : ''}`} pageWidthMm={PAGE_MM[draft.settings.pageSize][0]} />
            {saveState !== 'saved' && saveState !== 'error' && <span className="preview-badge">Updating…</span>}
          </section>
        )}
        {layoutOpen && <LayoutPanel settings={draft.settings} hasRecording={!!data.recordingId} onChange={(settings) => change({ settings })} onClose={() => setLayoutOpen(false)} />}
      </div>

      {dialog === 'versions' && (
        <VersionsDialog
          id={id}
          onSaveNew={() => setDialog('save-version')}
          onRestore={async (versionId) => {
            await save();
            await api.restoreDocumentVersion(id, versionId);
            toast.show('Version restored. Your previous draft was kept as a version.');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'save-version' && (
        <TextPromptDialog
          title="Save a version"
          label="Name"
          initial={`Version ${data.versionCount + 1}`}
          confirmLabel="Save"
          onConfirm={(label) => void save().then(() => api.saveDocumentVersion(id, label)).then(() => toast.show('Version saved'), toast.showError)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title="Delete this document?"
          message="The document, its versions and its exported files are permanently removed. The recording is not affected."
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            clearTimeout(timer.current);
            pending.current = null;
            void api.deleteDocument(id).then(back, toast.showError);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {saveState === 'error' && (
        <div className="notice error doc-save-error" role="alert">
          <CircleAlert size={18} aria-hidden />
          <span className="grow">Your last changes are not saved yet.</span>
          <Button size="sm" icon={RotateCcw} onClick={() => void save()}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

const PX_PER_MM = 96 / 25.4;
/** Room around the page inside the preview, matching the page's own grey border. */
const PAGE_GUTTER_PX = 48;

/**
 * The real page, scaled to fit the pane's width, so whole pages show with no sideways scrolling. The
 * frame is sandboxed with no permissions: the page can never run script or reach the app.
 */
function PagePreview({ src, pageWidthMm }: { src: string; pageWidthMm: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const natural = pageWidthMm * PX_PER_MM + PAGE_GUTTER_PX;
  const scale = size ? Math.min(1, size.width / natural) : 1;
  return (
    <div ref={box} className="page-preview">
      {size && (
        <iframe
          sandbox=""
          title="Page preview"
          src={src}
          style={{ width: size.width / scale, height: size.height / scale, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

function VersionsDialog({ id, onSaveNew, onRestore, onClose }: { id: string; onSaveNew: () => void; onRestore: (versionId: string) => Promise<void>; onClose: () => void }) {
  const toast = useToast();
  const versions = useQuery(() => api.listDocumentVersions(id), [id], ['documents']);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Dialog title="Versions" onClose={onClose}>
      <p className="muted small">Versions are snapshots you can go back to. Restoring one keeps your current draft as a version too, so nothing is lost.</p>
      <div className="version-list">
        {!versions.data ? (
          <Loading />
        ) : !versions.data.length ? (
          <p className="muted small">No versions yet.</p>
        ) : (
          versions.data.map((v) => (
            <div key={v.id} className="version-row">
              <span className="grow">
                <span className="version-label" dir="auto">
                  {v.label}
                </span>
                <span className="muted small">{formatDateTime(v.createdAt)}</span>
              </span>
              <Button size="sm" icon={RotateCcw} onClick={() => setConfirm(v.id)}>
                Restore
              </Button>
            </div>
          ))
        )}
      </div>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" icon={Save} onClick={onSaveNew}>
          Save current as a version
        </Button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Restore this version?"
          message="It replaces the current draft. The current draft is saved as a version first."
          confirmLabel="Restore"
          onConfirm={() => void onRestore(confirm).then(onClose, toast.showError)}
          onClose={() => setConfirm(null)}
        />
      )}
    </Dialog>
  );
}
