import { useState } from 'react';
import { BookOpenCheck, CheckSquare, Combine, FileSpreadsheet, FileText, FolderOpen, GraduationCap, Languages, ListChecks, MessagesSquare, Network, NotebookPen, PenLine, Presentation, ScrollText, Wand2, BookMarked } from 'lucide-react';
import type { ExportFormat } from '@shared/documents';
import { formatDuration, formatRelative } from '@shared/format';
import { STUDIO_KINDS, type StudioKind } from '@shared/studio';
import type { SummaryOptions } from '@shared/summaries';
import { Button, Dialog, EmptyState, PageHeader, SectionTitle, type IconType } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import './studio.css';

type ToolGroup = 'write' | 'study' | 'meetings' | 'documents';

/** Tools are grouped by what they are for; each group has its own colour, the same in every theme. */
const GROUPS: { key: ToolGroup; title: string; tone: 'primary' | 'teal' | 'ember' | 'neutral' }[] = [
  { key: 'write', title: 'Summaries and writing', tone: 'primary' },
  { key: 'study', title: 'Study', tone: 'teal' },
  { key: 'meetings', title: 'Meetings and tasks', tone: 'ember' },
  { key: 'documents', title: 'Documents and slides', tone: 'neutral' },
];

interface Tool {
  name: string;
  group: ToolGroup;
  hint: string;
  icon: IconType;
  /** A summary tool: opens Summaries with these settings for the recording chosen. */
  preset?: Partial<SummaryOptions>;
  /** A document tool: opens New document with this template and export format. */
  document?: { template?: string; exportAs?: ExportFormat };
  /** A Studio tool. */
  studio?: StudioKind;
}

// The tools of prompt §10, plus the study notes of §13. Every one works for any recording, whatever its source.
const TOOLS: Tool[] = [
  { name: 'Smart Summarizer', group: 'write', hint: 'Bullets, paragraphs, structured notes and more', icon: ScrollText, preset: {} },
  { name: 'Lecture Notes', group: 'write', hint: 'Topics, definitions, explanations, examples', icon: NotebookPen, preset: { format: 'academic', length: 'detailed', tone: 'academic' } },
  { name: 'Study Notes', group: 'study', hint: 'Study guides, revision sheets, definitions, formulas', icon: BookMarked, studio: 'study' },
  { name: 'Flashcards', group: 'study', hint: 'Question and answer cards to study', icon: BookOpenCheck, studio: 'flashcards' },
  { name: 'Quiz Generator', group: 'study', hint: 'MCQ, true/false, short and long questions', icon: GraduationCap, studio: 'quiz' },
  { name: 'Mind Map', group: 'study', hint: 'A visual map of concepts', icon: Network, studio: 'mindmap' },
  { name: 'Action Items', group: 'meetings', hint: 'Tasks, deadlines, responsibilities', icon: CheckSquare, studio: 'tasks' },
  { name: 'Meeting Minutes', group: 'meetings', hint: 'Formal meeting documentation', icon: ListChecks, document: { template: 'meeting-minutes' } },
  { name: 'PDF Generator', group: 'documents', hint: 'Professionally formatted PDFs', icon: FileText, document: { exportAs: 'pdf' } },
  { name: 'Word Generator', group: 'documents', hint: 'Editable DOCX files', icon: FileSpreadsheet, document: { exportAs: 'docx' } },
  { name: 'Presentations', group: 'documents', hint: 'Slides from recording content', icon: Presentation, document: { exportAs: 'pptx' } },
  { name: 'Translation Studio', group: 'write', hint: 'Transcripts and summaries in another language', icon: Languages, studio: 'translate' },
  { name: 'Comparison', group: 'meetings', hint: 'Differences, themes, changing decisions', icon: Combine, studio: 'compare' },
  { name: 'Rewrite Studio', group: 'write', hint: 'Reports, articles, emails, explanations', icon: PenLine, studio: 'rewrite' },
  { name: 'Custom Studio', group: 'write', hint: 'Your own instructions', icon: Wand2, studio: 'custom' },
];

const KIND_ICON: Record<StudioKind, IconType> = {
  flashcards: BookOpenCheck,
  quiz: GraduationCap,
  mindmap: Network,
  study: BookMarked,
  translate: Languages,
  compare: Combine,
  rewrite: PenLine,
  custom: Wand2,
  tasks: CheckSquare,
};

function SummaryPicker({ tool, onClose }: { tool: Tool; onClose: () => void }) {
  const { go } = useRouter();
  const recordings = useQuery(() => api.listRecordings({ view: 'all', sort: 'newest' }), []);
  const ready = recordings.data?.filter((r) => r.hasTranscript);
  return (
    <Dialog title={`${tool.name}: choose a recording`} onClose={onClose}>
      {ready && ready.length === 0 ? (
        <EmptyState icon={tool.icon} title="No transcripts yet" message="Transcribe a recording first. Every AI tool builds on its transcript." action={<Button onClick={() => { onClose(); go({ name: 'library' }); }}>Open Library</Button>} />
      ) : (
        <div className="stack" style={{ gap: 0, maxHeight: 360, overflowY: 'auto' }}>
          {ready?.map((r) => (
            <div key={r.id} className="collection-row">
              <button
                type="button"
                className="collection-open"
                onClick={() => {
                  onClose();
                  go({ name: 'summaries', id: r.id, preset: tool.preset });
                }}
              >
                <span className="grow truncate" dir="auto">
                  {r.title}
                </span>
                <span className="muted small tabular">{formatDuration(r.durationMs)}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function Studio({ recordingId }: { recordingId?: string }) {
  const { go } = useRouter();
  const [picking, setPicking] = useState<Tool | null>(null);
  const results = useQuery(() => api.listStudio(), [], ['studio', 'library']);
  const counts = useQuery(() => api.taskCounts(), [], ['tasks']);

  const open = (t: Tool) => {
    if (t.studio) go({ name: 'studio-tool', kind: t.studio, recordingIds: recordingId ? [recordingId] : undefined });
    else if (t.document) go({ name: 'document-new', ...t.document, recordingId });
    else if (recordingId) go({ name: 'summaries', id: recordingId, preset: t.preset });
    else setPicking(t);
  };

  return (
    <div className="page">
      <PageHeader
        title="AI Studio"
        subtitle="Transform recordings into anything. Every result is saved with the recordings it came from."
        actions={
          <>
            <Button variant="primary" icon={MessagesSquare} onClick={() => go({ name: 'chat', scope: { kind: 'library' } })}>
              Ask AI
            </Button>
            <Button icon={ListChecks} onClick={() => go({ name: 'tasks' })}>
              Tasks{counts.data?.suggested ? ` (${counts.data.suggested} to review)` : ''}
            </Button>
            <Button icon={FolderOpen} onClick={() => go({ name: 'documents' })}>
              Documents
            </Button>
          </>
        }
      />
      {GROUPS.map((g) => (
        <section key={g.key} className="studio-group" aria-labelledby={`studio-${g.key}`}>
          <h2 id={`studio-${g.key}`} className="studio-group-title">
            {g.title}
          </h2>
          <div className="studio-grid">
            {TOOLS.filter((t) => t.group === g.key).map((t) => (
              <button key={t.name} type="button" className="card studio-tool" onClick={() => open(t)}>
                <span className={`icon-tile tone-${g.tone}`}>
                  <t.icon size={20} aria-hidden />
                </span>
                <span className="grow">
                  <h3>{t.name}</h3>
                  <span className="muted small">{t.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      <section>
        <SectionTitle title="Your results" />
        {!results.data?.length ? (
          <p className="muted">Flashcards, quizzes, mind maps, notes and everything else you make here are kept in this list and on each recording.</p>
        ) : (
          <div className="studio-results">
            {results.data.slice(0, 30).map((o) => {
              const Icon = KIND_ICON[o.kind];
              return (
                <button key={o.id} type="button" className="result-card" onClick={() => go({ name: 'studio-output', id: o.id })}>
                  <span className="row muted small">
                    <Icon size={14} aria-hidden /> {STUDIO_KINDS[o.kind].label} · {formatRelative(o.createdAt)}
                    {!o.content && ' · in progress'}
                  </span>
                  <span className="result-title truncate" dir="auto">
                    {o.title}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      {picking && <SummaryPicker tool={picking} onClose={() => setPicking(null)} />}
    </div>
  );
}

export { KIND_ICON };
