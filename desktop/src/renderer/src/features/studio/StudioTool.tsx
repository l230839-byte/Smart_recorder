import { useEffect, useState } from 'react';
import { Save, Sparkles } from 'lucide-react';
import { formatDuration } from '@shared/format';
import { OUTPUT_LANGUAGES } from '@shared/summaries';
import {
  DEFAULT_STUDIO_OPTIONS,
  DIFFICULTIES,
  QUESTION_TYPES,
  REWRITE_STYLES,
  STUDIO_KINDS,
  STUDY_TYPES,
  type Difficulty,
  type QuestionType,
  type RewriteStyle,
  type StudioKind,
  type StudioOptions,
  type StudyType,
} from '@shared/studio';
import { Button, IconButton, Loading, PageHeader, SearchField, Segmented, TextPromptDialog } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { useTranscribe } from '../transcript/ai-gate';
import './studio.css';

const TARGET_LANGUAGES = OUTPUT_LANGUAGES.slice(1);

function Select<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: Record<string, { label: string } | string>; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {typeof v === 'string' ? v : v.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Setting up one Studio tool: which recordings, and the choices that tool offers. */
export function StudioTool({ kind, recordingIds = [] }: { kind: StudioKind; recordingIds?: string[] }) {
  const { replace, go } = useRouter();
  const toast = useToast();
  const { startText, dialogs } = useTranscribe();
  const info = STUDIO_KINDS[kind];
  const recordings = useQuery(() => api.listRecordings({ view: 'all', sort: 'newest' }), [], ['library']);
  const templates = useQuery(() => api.listStudioTemplates(), [], ['studio']);
  const [chosen, setChosen] = useState<string[]>(recordingIds);
  const [o, setO] = useState<StudioOptions>(DEFAULT_STUDIO_OPTIONS);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const summaries = useQuery(() => (kind === 'translate' && chosen[0] ? api.listSummaries(chosen[0]) : Promise.resolve([])), [kind, chosen[0]], ['summaries']);
  const single = info.maxRecordings === 1;

  // The newest transcribed recordings are chosen when none were given (two for a comparison), so most
  // uses need one click. Only once: clearing the choice afterwards is respected.
  const [defaulted, setDefaulted] = useState(recordingIds.length > 0);
  useEffect(() => {
    if (defaulted || !recordings.data) return;
    setDefaulted(true);
    const ready = recordings.data.filter((r) => r.hasTranscript).slice(0, info.minRecordings);
    if (ready.length) setChosen(ready.map((r) => r.id));
  }, [recordings.data, defaulted, info.minRecordings]);
  useEffect(() => {
    if (o.translateSource === 'summary' && summaries.data && !summaries.data.some((s) => s.id === o.summaryId)) setO((x) => ({ ...x, summaryId: summaries.data?.[0]?.id ?? null }));
  }, [o.translateSource, o.summaryId, summaries.data]);

  if (!recordings.data) return <Loading />;
  const set = (patch: Partial<StudioOptions>) => setO({ ...o, ...patch });
  const ready = recordings.data.filter((r) => r.hasTranscript);
  const needle = text.trim().toLowerCase();
  const shown = ready.filter((r) => !needle || r.title.toLowerCase().includes(needle));
  const kindTemplates = templates.data?.filter((t) => t.kind === kind) ?? [];

  const problem =
    chosen.length < info.minRecordings
      ? info.minRecordings === 1
        ? 'Choose a recording.'
        : `Choose at least ${info.minRecordings} recordings.`
      : chosen.length > info.maxRecordings
        ? `Choose up to ${info.maxRecordings} recordings.`
        : kind === 'quiz' && !o.questionTypes.length
          ? 'Choose at least one kind of question.'
          : kind === 'translate' && o.translateSource === 'summary' && !o.summaryId
            ? 'This recording has no summaries yet. Translate the transcript, or make a summary first.'
            : kind === 'custom' && !o.instructions.trim()
              ? 'Describe what you want.'
              : null;

  const generate = () => {
    if (problem || busy) return;
    setBusy(true);
    startText(
      () => api.startStudio({ kind, recordingIds: chosen, options: o }),
      (out) => replace({ name: 'studio-output', id: out.outputId }),
    );
    setTimeout(() => setBusy(false), 800);
  };

  return (
    <div className="page">
      <PageHeader title={info.label} subtitle={info.hint} />
      <div className="tool-grid">
        <section className="tool-panel" aria-label="Recordings">
          <h2 className="tool-heading">{single ? 'Recording' : `Recordings (${chosen.length} chosen${info.maxRecordings < 99 ? `, up to ${info.maxRecordings}` : ''})`}</h2>
          {!ready.length ? (
            <p className="muted">No recording has a transcript yet. Transcribe one first: every Studio tool builds on the transcript.</p>
          ) : (
            <>
              {ready.length > 6 && <SearchField value={text} onChange={setText} placeholder="Find recordings" />}
              <div className="tool-list" role={single ? 'radiogroup' : 'group'} aria-label="Recordings">
                {shown.map((r) => (
                  <label key={r.id} className="tool-row">
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name="studio-recording"
                      checked={chosen.includes(r.id)}
                      onChange={(e) => setChosen(single ? [r.id] : e.target.checked ? [...chosen, r.id] : chosen.filter((x) => x !== r.id))}
                    />
                    <span className="grow truncate" dir="auto">
                      {r.title}
                    </span>
                    <span className="muted small tabular">{formatDuration(r.durationMs)}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </section>

        <form
          className="tool-panel tool-options"
          onSubmit={(e) => {
            e.preventDefault();
            generate();
          }}
        >
          <h2 className="tool-heading">Options</h2>
          {!!kindTemplates.length && (
            <div className="field">
              <label htmlFor="st-template">Saved template</label>
              <select id="st-template" className="select" value="" onChange={(e) => setO(kindTemplates.find((t) => t.id === e.target.value)?.options ?? o)}>
                <option value="" disabled>
                  Use a saved template
                </option>
                {kindTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(kind === 'flashcards' || kind === 'quiz') && (
            <>
              <div className="field">
                <label htmlFor="st-count">{kind === 'quiz' ? 'Number of questions' : 'Number of cards'}</label>
                <input id="st-count" className="input" type="number" min={3} max={60} value={o.count} onChange={(e) => set({ count: Number(e.target.value) || 3 })} />
              </div>
              <div className="field">
                <span className="field-label">Difficulty</span>
                <Segmented label="Difficulty" value={o.difficulty} onChange={(difficulty: Difficulty) => set({ difficulty })} options={Object.entries(DIFFICULTIES).map(([value, label]) => ({ value: value as Difficulty, label }))} />
              </div>
            </>
          )}
          {kind === 'quiz' && (
            <fieldset className="field check-group">
              <legend className="field-label">Kinds of question</legend>
              {(Object.keys(QUESTION_TYPES) as QuestionType[]).map((t) => (
                <label key={t} className="row small">
                  <input type="checkbox" checked={o.questionTypes.includes(t)} onChange={(e) => set({ questionTypes: e.target.checked ? [...o.questionTypes, t] : o.questionTypes.filter((x) => x !== t) })} />
                  {QUESTION_TYPES[t]}
                </label>
              ))}
            </fieldset>
          )}
          {kind === 'study' && <Select<StudyType> id="st-study" label="What to make" value={o.studyType} options={STUDY_TYPES} onChange={(studyType) => set({ studyType })} />}
          {kind === 'rewrite' && <Select<RewriteStyle> id="st-style" label="Write it as" value={o.rewriteStyle} options={REWRITE_STYLES} onChange={(rewriteStyle) => set({ rewriteStyle })} />}
          {kind === 'translate' && (
            <>
              <div className="field">
                <span className="field-label">Translate</span>
                <Segmented
                  label="Translate"
                  value={o.translateSource}
                  onChange={(translateSource) => set({ translateSource })}
                  options={[
                    { value: 'transcript', label: 'The transcript' },
                    { value: 'summary', label: 'A summary' },
                  ]}
                />
              </div>
              {o.translateSource === 'summary' && !!summaries.data?.length && (
                <div className="field">
                  <label htmlFor="st-summary">Summary</label>
                  <select id="st-summary" className="select" value={o.summaryId ?? ''} onChange={(e) => set({ summaryId: e.target.value })}>
                    {summaries.data.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="st-target">Into</label>
                <input id="st-target" className="input" list="st-targets" value={o.targetLanguage} onChange={(e) => set({ targetLanguage: e.target.value })} />
                <datalist id="st-targets">
                  {TARGET_LANGUAGES.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </div>
            </>
          )}
          {kind !== 'translate' && kind !== 'tasks' && (
            <div className="field">
              <label htmlFor="st-language">Language</label>
              <input id="st-language" className="input" list="st-languages" value={o.language} onChange={(e) => set({ language: e.target.value || OUTPUT_LANGUAGES[0]! })} />
              <datalist id="st-languages">
                {OUTPUT_LANGUAGES.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>
          )}
          {kind !== 'translate' && kind !== 'tasks' && (
            <div className="field">
              <label htmlFor="st-instructions">{kind === 'custom' ? 'What should it make?' : 'Extra instructions (optional)'}</label>
              <textarea
                id="st-instructions"
                className="textarea"
                dir="auto"
                placeholder={kind === 'custom' ? 'For example: a professional 10-page academic document with definitions, formulas, examples, headings and a final revision section' : 'For example: focus on chapter 3'}
                value={o.instructions}
                onChange={(e) => set({ instructions: e.target.value })}
              />
            </div>
          )}
          {kind === 'tasks' && <p className="muted small">EchoMind finds tasks, deadlines and who is responsible. Each one waits for your approval in Tasks; nothing is sent to a calendar or anyone else.</p>}

          {problem && (
            <p className="muted small" role="status">
              {problem}
            </p>
          )}
          <div className="row">
            <Button type="submit" variant="primary" icon={Sparkles} disabled={!!problem || busy} className="grow">
              {kind === 'tasks' ? 'Find action items' : 'Generate'}
            </Button>
            {kind !== 'tasks' && <IconButton icon={Save} label="Save these options as a template" onClick={() => setSaving(true)} />}
          </div>
          <p className="muted small">Uses the saved transcripts. Results are kept with their recordings.</p>
          {!ready.length && (
            <Button variant="ghost" onClick={() => go({ name: 'library' })}>
              Open Library
            </Button>
          )}
        </form>
      </div>
      {saving && <TextPromptDialog title="Save as template" label="Template name" onConfirm={(name) => void api.saveStudioTemplate(name, kind, o).then(() => toast.show('Template saved'), toast.showError)} onClose={() => setSaving(false)} />}
      {dialogs}
    </div>
  );
}
