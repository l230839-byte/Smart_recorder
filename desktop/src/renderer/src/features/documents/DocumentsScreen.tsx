import { useMemo, useState } from 'react';
import { Copy, ExternalLink, FileText, FileWarning, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { EXPORT_FORMATS, templateById } from '@shared/documents';
import { formatBytes, formatDateTime, plural } from '@shared/format';
import type { DocumentExport } from '@shared/models';
import { Button, ConfirmDialog, EmptyState, IconButton, Loading, PageHeader, SearchField, Segmented } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { TEMPLATE_ICONS } from './NewDocument';
import './documents.css';

/** Every document, and every file exported from one, in one place (prompt §11, export center). */
export function DocumentsScreen() {
  const { go } = useRouter();
  const toast = useToast();
  const documents = useQuery(() => api.listDocuments(), [], ['documents', 'library']);
  const exports = useQuery(() => api.listExports(), [], ['documents', 'library']);
  const [tab, setTab] = useState<'documents' | 'exports'>('documents');
  const [text, setText] = useState('');
  const [deleting, setDeleting] = useState<DocumentExport | null>(null);

  const needle = text.trim().toLowerCase();
  const shownDocs = useMemo(() => documents.data?.filter((d) => !needle || `${d.title} ${d.recordingTitle ?? ''} ${templateById(d.template).name}`.toLowerCase().includes(needle)), [documents.data, needle]);
  const shownExports = useMemo(() => exports.data?.filter((e) => !needle || `${e.documentTitle} ${e.fileName} ${e.format}`.toLowerCase().includes(needle)), [exports.data, needle]);

  if (!documents.data || !exports.data || !shownDocs || !shownExports) return <Loading />;

  const fileAction = (run: () => Promise<unknown>) => () => void run().catch(toast.showError);

  return (
    <div className="page">
      <PageHeader
        title="Documents"
        subtitle="Documents you made from recordings, and the files you exported from them."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => go({ name: 'document-new' })}>
            New document
          </Button>
        }
      />

      <div className="row wrap">
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'documents', label: `Documents (${documents.data.length})` },
            { value: 'exports', label: `Exported files (${exports.data.length})` },
          ]}
        />
        <div className="grow" style={{ minWidth: 220 }}>
          <SearchField value={text} onChange={setText} placeholder={tab === 'documents' ? 'Search documents' : 'Search exported files'} />
        </div>
      </div>

      {tab === 'documents' ? (
        !documents.data.length ? (
          <EmptyState icon={FileText} title="No documents yet" message="Turn any transcribed recording into notes, minutes, reports or slides. Choose one of nine templates, edit the result, then export it." action={<Button variant="primary" icon={Plus} onClick={() => go({ name: 'document-new' })}>New document</Button>} />
        ) : !shownDocs.length ? (
          <p className="muted">Nothing matches “{text}”.</p>
        ) : (
          <div className="doc-list">
            {shownDocs.map((d) => {
              const Icon = TEMPLATE_ICONS[d.template] ?? FileText;
              return (
                <button key={d.id} type="button" className="doc-row" onClick={() => go({ name: 'document', id: d.id })}>
                  <span className="template-icon">
                    <Icon size={17} aria-hidden />
                  </span>
                  <span className="grow doc-row-text">
                    <span className="doc-row-title truncate" dir="auto">
                      {d.title}
                    </span>
                    <span className="muted small truncate">
                      {templateById(d.template).name}
                      {d.recordingTitle ? ` · ${d.recordingTitle}` : ''}
                      {d.markdown ? '' : ' · empty'}
                    </span>
                  </span>
                  <span className="muted small doc-row-side">
                    <span>{formatDateTime(d.updatedAt)}</span>
                    <span>{plural(d.versionCount, 'version')}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )
      ) : !exports.data.length ? (
        <EmptyState icon={FolderOpen} title="No exported files yet" message="Open a document and choose Export. Every file you export is listed here, so you can open it again or save a copy anywhere." />
      ) : !shownExports.length ? (
        <p className="muted">Nothing matches “{text}”.</p>
      ) : (
        <div className="doc-list">
          {shownExports.map((e) => (
            <div key={e.id} className={`export-row ${e.exists ? '' : 'missing'}`}>
              <span className={`format-badge format-${e.format}`}>{EXPORT_FORMATS[e.format].extension.toUpperCase()}</span>
              <span className="grow doc-row-text">
                <span className="doc-row-title truncate" dir="auto">
                  {e.fileName.split(/[\\/]/).pop()}
                </span>
                <span className="muted small truncate">
                  <button type="button" className="link-btn" dir="auto" onClick={() => go({ name: 'document', id: e.documentId })}>
                    {e.documentTitle}
                  </button>
                  {` · ${formatDateTime(e.createdAt)} · ${e.exists ? formatBytes(e.sizeBytes) : 'file missing'}`}
                </span>
              </span>
              {e.exists ? (
                <>
                  <IconButton icon={ExternalLink} label="Open" onClick={fileAction(() => api.openExport(e.id))} />
                  <IconButton icon={FolderOpen} label="Show in folder" onClick={fileAction(() => api.showExport(e.id))} />
                  <IconButton icon={Copy} label="Save a copy" onClick={fileAction(async () => (await api.saveExportCopy(e.id)) && toast.show('Copy saved'))} />
                </>
              ) : (
                <span className="badge badge-warning" title="The file was moved or deleted outside EchoMind. Export the document again to recreate it.">
                  <FileWarning size={13} aria-hidden /> Missing
                </span>
              )}
              <IconButton icon={Trash2} label="Delete file" onClick={() => setDeleting(e)} />
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this exported file?"
          message="The file is removed from EchoMind's exports folder. The document itself stays, so you can export it again at any time."
          confirmLabel="Delete file"
          destructive
          onConfirm={() => void api.deleteExport(deleting.id).catch(toast.showError)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
