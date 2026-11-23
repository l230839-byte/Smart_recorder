import { useEffect, useMemo, useState } from 'react';
import { BookOpen, BookOpenCheck, Briefcase, FileText, FlaskConical, GraduationCap, ListChecks, MessagesSquare, Sparkles, Target, WandSparkles } from 'lucide-react';
import { DOCUMENT_TEMPLATES, EXPORT_FORMATS, templateById, type DocumentSource, type ExportFormat } from '@shared/documents';
import { formatDateTime, formatDuration } from '@shared/format';
import { OUTPUT_LANGUAGES } from '@shared/summaries';
import { Button, LanguageField, Loading, PageHeader, type IconType } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useTranscribe } from '../transcript/ai-gate';
import './documents.css';

export const TEMPLATE_ICONS: Record<string, IconType> = {
  'academic-notes': GraduationCap,
  'lecture-report': BookOpen,
  'meeting-minutes': ListChecks,
  'business-report': Briefcase,
  'interview-transcript': MessagesSquare,
  'study-guide': BookOpenCheck,
  'executive-summary': Target,
  'research-notes': FlaskConical,
  custom: WandSparkles,
};

const SOURCES: { value: DocumentSource; label: string; hint: string }[] = [
  { value: 'ai', label: 'Write with AI', hint: 'The AI writes the document from the transcript, citing times.' },
  { value: 'transcript', label: 'Full transcript', hint: 'The transcript itself, laid out with speakers and times. No AI.' },
  { value: 'summary', label: 'A saved summary', hint: 'Start from a summary you already made. No new AI work.' },
  { value: 'blank', label: 'Blank page', hint: 'Write it yourself, with the same layout and export options.' },
];

interface Props {
  recordingId?: string;
  template?: string;
  source?: DocumentSource;
  summaryId?: string;
  exportAs?: ExportFormat;
}

/** Choosing what to make: a recording, one of the nine templates, and where the content comes from. */
export function NewDocument(props: Props) {
  const { replace } = useRouter();
  const { startDocument, dialogs } = useTranscribe();
  const recordings = useQuery(() => api.listRecordings({ view: 'all', sort: 'newest' }), [], ['library']);
  const [recordingId, setRecordingId] = useState(props.recordingId ?? '');
  const [templateId, setTemplateId] = useState(props.template ?? DOCUMENT_TEMPLATES[0]!.id);
  const [source, setSource] = useState<DocumentSource>(props.source ?? templateById(props.template ?? DOCUMENT_TEMPLATES[0]!.id).source);
  const [summaryId, setSummaryId] = useState(props.summaryId ?? '');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState(OUTPUT_LANGUAGES[0]!);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const summaries = useQuery(() => (recordingId ? api.listSummaries(recordingId) : Promise.resolve([])), [recordingId], ['summaries']);

  const recording = recordings.data?.find((r) => r.id === recordingId) ?? null;
  const template = templateById(templateId);

  // Pick a sensible recording when none was given: the newest one with a transcript.
  useEffect(() => {
    if (!recordingId && !props.recordingId && recordings.data && source !== 'blank') {
      const first = recordings.data.find((r) => r.hasTranscript);
      if (first) setRecordingId(first.id);
    }
  }, [recordings.data, recordingId, props.recordingId, source]);

  // A summary is chosen automatically when the recording has exactly the newest one to offer.
  useEffect(() => {
    if (source === 'summary' && summaries.data && !summaries.data.some((s) => s.id === summaryId)) setSummaryId(summaries.data[0]?.id ?? '');
  }, [source, summaries.data, summaryId]);

  const problem = useMemo(() => {
    if (source === 'blank') return null;
    if (!recording) return 'Choose a recording.';
    if (!recording.hasTranscript) return 'This recording has no transcript yet. Transcribe it first, or start from a blank page.';
    if (source === 'summary' && summaries.data && !summaries.data.length) return 'This recording has no summaries yet. Make one first, or choose another starting point.';
    if (source === 'summary' && !summaryId) return 'Choose a summary.';
    return null;
  }, [source, recording, summaries.data, summaryId]);

  if (!recordings.data) return <Loading />;

  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    // The template decides the natural starting point, unless the person picked a summary or a blank page on purpose.
    if (source === 'ai' || source === 'transcript') setSource(templateById(id).source === 'transcript' ? 'transcript' : 'ai');
  };

  const create = () => {
    if (problem || busy) return;
    setBusy(true);
    startDocument(
      {
        recordingId: source === 'blank' ? (recording?.id ?? null) : recording!.id,
        template: templateId,
        source,
        summaryId: source === 'summary' ? summaryId : undefined,
        title: title.trim() || undefined,
        language: source === 'ai' ? language : undefined,
        instructions: source === 'ai' ? instructions : undefined,
      },
      (documentId) => replace({ name: 'document', id: documentId, exportAs: props.exportAs }),
    );
    // The gate shows its own dialogs or errors; the button only needs to stop double clicks briefly.
    setTimeout(() => setBusy(false), 800);
  };

  return (
    <div className="page">
      <PageHeader
        title="New document"
        subtitle={props.exportAs ? `Make a document, check it, then export it as ${EXPORT_FORMATS[props.exportAs].label}. Every other format stays available.` : 'Turn a recording into a formatted document you can edit and export as PDF, Word, PowerPoint and more.'}
      />

      <form
        className="newdoc"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <section className="newdoc-step">
          <h2 className="newdoc-label">
            <span className="step-num">1</span>Template
          </h2>
          <div className="template-grid" role="radiogroup" aria-label="Template">
            {DOCUMENT_TEMPLATES.map((t) => {
              const Icon = TEMPLATE_ICONS[t.id] ?? FileText;
              const selected = t.id === templateId;
              return (
                <button key={t.id} type="button" role="radio" aria-checked={selected} className="template-card" onClick={() => chooseTemplate(t.id)}>
                  <span className="template-icon">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="grow">
                    <span className="template-name">{t.name}</span>
                    <span className="muted small">{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="newdoc-step">
          <h2 className="newdoc-label">
            <span className="step-num">2</span>Content
          </h2>
          <div className="newdoc-panel">
            <div className="field">
              <span className="field-label" id="nd-source-label">
                Start from
              </span>
              <div className="source-grid" role="radiogroup" aria-labelledby="nd-source-label">
                {SOURCES.map((s) => (
                  <label key={s.value} className="source-option">
                    <input type="radio" name="nd-source" value={s.value} checked={source === s.value} onChange={() => setSource(s.value)} />
                    <span className="source-name">{s.label}</span>
                  </label>
                ))}
              </div>
              <p className="muted small">{SOURCES.find((s) => s.value === source)!.hint}</p>
            </div>

            <div className="field">
              <label htmlFor="nd-recording">Recording</label>
              <select id="nd-recording" className="select" value={recordingId} onChange={(e) => setRecordingId(e.target.value)}>
                <option value="">{source === 'blank' ? 'None' : 'Choose a recording'}</option>
                {recordings.data.map((r) => (
                  <option key={r.id} value={r.id} disabled={source !== 'blank' && !r.hasTranscript}>
                    {`${r.title} · ${formatDuration(r.durationMs)}${r.hasTranscript ? '' : ' · no transcript yet'}`}
                  </option>
                ))}
              </select>
            </div>

            {source === 'summary' && !!summaries.data?.length && (
              <div className="field">
                <label htmlFor="nd-summary">Summary</label>
                <select id="nd-summary" className="select" value={summaryId} onChange={(e) => setSummaryId(e.target.value)}>
                  {summaries.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {`${s.label} · ${formatDateTime(s.createdAt)}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor="nd-title">Title</label>
              <input id="nd-title" className="input" dir="auto" maxLength={200} placeholder={recording ? `${recording.title}: ${template.name}` : template.name} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            {source === 'ai' && (
              <>
                <LanguageField id="nd-language" label="Language" value={language} options={OUTPUT_LANGUAGES} onChange={setLanguage} />
                <div className="field">
                  <label htmlFor="nd-instructions">{templateId === 'custom' ? 'What should the document contain?' : 'Extra instructions (optional)'}</label>
                  <textarea
                    id="nd-instructions"
                    className="textarea"
                    dir="auto"
                    placeholder={templateId === 'custom' ? 'For example: a one-page brief for my manager with the three decisions and their reasons' : 'For example: keep it under two pages'}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                </div>
              </>
            )}

            {problem && (
              <p className="muted small" role="status">
                {problem}
              </p>
            )}
            <Button type="submit" variant="primary" icon={source === 'ai' ? Sparkles : FileText} disabled={!!problem || busy}>
              {source === 'ai' ? 'Write document' : 'Create document'}
            </Button>
            {source === 'ai' && <p className="muted small">Uses the saved transcript. You can edit everything before exporting.</p>}
          </div>
        </section>
      </form>
      {dialogs}
    </div>
  );
}
