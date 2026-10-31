import { useState } from 'react';
import { BookOpenCheck, CheckSquare, Combine, FileSpreadsheet, FileText, GraduationCap, Languages, ListChecks, Network, NotebookPen, PenLine, Presentation, ScrollText, Wand2 } from 'lucide-react';
import { formatDuration } from '@shared/format';
import type { SummaryOptions } from '@shared/summaries';
import { Button, Card, Dialog, EmptyState, PageHeader, type IconType } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import './studio.css';

interface Tool {
  name: string;
  hint: string;
  icon: IconType;
  /** The build phase that delivers it. Tools are only clickable once they work (prompt §16). */
  phase: number;
  preset?: Partial<SummaryOptions>;
}

const TOOLS: Tool[] = [
  { name: 'Smart Summarizer', hint: 'Bullets, paragraphs, structured notes and more', icon: ScrollText, phase: 4, preset: {} },
  { name: 'Lecture Notes', hint: 'Topics, definitions, explanations, examples', icon: NotebookPen, phase: 4, preset: { format: 'academic', length: 'detailed', tone: 'academic' } },
  { name: 'PDF Generator', hint: 'Professionally formatted PDFs', icon: FileText, phase: 5 },
  { name: 'Word Generator', hint: 'Editable DOCX files', icon: FileSpreadsheet, phase: 5 },
  { name: 'Presentations', hint: 'Slides from recording content', icon: Presentation, phase: 5 },
  { name: 'Flashcards', hint: 'Question and answer cards', icon: BookOpenCheck, phase: 7 },
  { name: 'Quiz Generator', hint: 'MCQ, true/false, short and long questions', icon: GraduationCap, phase: 7 },
  { name: 'Mind Map', hint: 'A visual map of concepts', icon: Network, phase: 7 },
  { name: 'Action Items', hint: 'Tasks, deadlines, responsibilities', icon: CheckSquare, phase: 7 },
  { name: 'Meeting Minutes', hint: 'Formal meeting documentation', icon: ListChecks, phase: 7 },
  { name: 'Translation Studio', hint: 'Transcripts and generated content', icon: Languages, phase: 7 },
  { name: 'Comparison', hint: 'Differences, themes, changing decisions', icon: Combine, phase: 7 },
  { name: 'Rewrite Studio', hint: 'Reports, articles, emails, explanations', icon: PenLine, phase: 7 },
  { name: 'Custom Studio', hint: 'Your own instructions', icon: Wand2, phase: 7 },
];

function RecordingPicker({ tool, onClose }: { tool: Tool; onClose: () => void }) {
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

export function Studio() {
  const [picking, setPicking] = useState<Tool | null>(null);
  return (
    <div className="page">
      <PageHeader title="AI Studio" subtitle="Transform recordings into anything. Tools marked with a phase arrive when that build phase finishes." />
      <div className="studio-grid">
        {TOOLS.map((t) =>
          t.preset ? (
            <button key={t.name} type="button" className="card studio-tool" onClick={() => setPicking(t)}>
              <t.icon size={20} aria-hidden />
              <span className="grow">
                <h3>{t.name}</h3>
                <span className="muted small">{t.hint}</span>
              </span>
            </button>
          ) : (
            <Card key={t.name} className="studio-tool">
              <t.icon size={20} aria-hidden />
              <div className="grow">
                <h3>{t.name}</h3>
                <p className="muted small">{t.hint}</p>
              </div>
              <span className="badge">Phase {t.phase}</span>
            </Card>
          ),
        )}
      </div>
      {picking && <RecordingPicker tool={picking} onClose={() => setPicking(null)} />}
    </div>
  );
}
