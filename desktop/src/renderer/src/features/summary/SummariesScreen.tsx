import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Clock, Copy, Download, FileText, RotateCcw, Save, Sparkles, Trash2, X } from 'lucide-react';
import { formatDateTime, formatDuration, plural } from '@shared/format';
import { markdownToClipboard } from '@shared/markdown';
import { providerLabel } from '@shared/providers';
import {
  OUTPUT_LANGUAGES,
  optionsForMode,
  SUMMARY_EMPHASIS,
  SUMMARY_EXTRACTS,
  SUMMARY_FORMATS,
  SUMMARY_LENGTHS,
  SUMMARY_TONES,
  type SummaryEmphasis,
  type SummaryExtract,
  type SummaryFormat,
  type SummaryLength,
  type SummaryOptions,
  type SummaryTone,
} from '@shared/summaries';
import { Button, Card, ConfirmDialog, EmptyState, IconButton, Loading, PageHeader, ProgressBar, TextPromptDialog } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { formatRetryTime } from '../transcript/AiCard';
import { useTranscribe } from '../transcript/ai-gate';
import { MarkdownView } from './MarkdownView';
import './summary.css';

function SelectField<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: Record<string, string | { label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {Object.entries(options).map(([key, option]) => (
          <option key={key} value={key}>
            {typeof option === 'string' ? option : option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface SummaryPreset {
  options: Partial<SummaryOptions>;
}

export function SummariesScreen({ id, preset, scope }: { id: string; preset?: Partial<SummaryOptions>; scope?: { startMs: number; endMs: number; label: string } }) {
  const { go } = useRouter();
  const toast = useToast();
  const recording = useQuery(() => api.getRecording(id), [id], ['library']);
  const summaries = useQuery(() => api.listSummaries(id), [id], ['summaries']);
  const job = useQuery(() => api.latestJob(id, 'summarize'), [id], ['jobs']);
  const chapters = useQuery(() => api.listChapters(id), [id], ['summaries']);
  const templates = useQuery(() => api.listTemplates(), [], ['summaries']);
  const transcript = useQuery(() => api.getTranscript(id), [id], ['transcripts']);
  const { startSummary, dialogs } = useTranscribe();
  const [options, setOptions] = useState<SummaryOptions | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]);
  const [scopeKind, setScopeKind] = useState<'all' | 'chapters' | 'range'>(scope ? 'range' : 'all');
  const [rangeFrom, setRangeFrom] = useState(scope ? String(Math.floor(scope.startMs / 60_000)) : '0');
  const [rangeTo, setRangeTo] = useState(scope ? String(Math.ceil(scope.endMs / 60_000)) : '');
  const [dialog, setDialog] = useState<'save-template' | 'delete' | null>(null);

  const rec = recording.data;
  useEffect(() => {
    if (rec && !options) setOptions({ ...optionsForMode(rec.mode), ...preset });
  }, [rec, options, preset]);

  const list = summaries.data;
  const selected = useMemo(() => list?.find((s) => s.id === selectedId) ?? list?.[0] ?? null, [list, selectedId]);
  const current = job.data;
  const active = current && ['queued', 'running', 'waiting'].includes(current.status);

  // A new result takes over the view as soon as it exists.
  useEffect(() => setSelectedId(null), [list?.[0]?.id]);

  if (recording.data === null) return <EmptyState icon={FileText} title="This recording no longer exists" message="It may have been permanently deleted." />;
  if (!rec || !options || !list) return <Loading />;

  const set = (patch: Partial<SummaryOptions>) => setOptions({ ...options, ...patch });
  const seek = (ms: number) => void player.load(rec, ms, true);

  const buildOptions = (): SummaryOptions | null => {
    if (scopeKind === 'chapters') {
      const chosen = (chapters.data ?? []).filter((c) => selectedChapters.includes(c.idx));
      if (!chosen.length) {
        toast.showError(new Error('Choose at least one chapter.'));
        return null;
      }
      return { ...options, scope: { kind: 'ranges', ranges: chosen.map((c) => ({ startMs: c.startMs, endMs: c.endMs })), label: chosen.length === 1 ? chosen[0]!.title : plural(chosen.length, 'chapter') } };
    }
    if (scopeKind === 'range') {
      const from = Number(rangeFrom) * 60_000;
      const to = rangeTo.trim() ? Number(rangeTo) * 60_000 : rec.durationMs;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        toast.showError(new Error('Enter a time range where the end comes after the start.'));
        return null;
      }
      return { ...options, scope: { kind: 'ranges', ranges: [{ startMs: from, endMs: to }], label: scope?.label ?? `${formatDuration(from)}–${formatDuration(to)}` } };
    }
    return { ...options, scope: { kind: 'all' } };
  };

  const generate = () => {
    const built = buildOptions();
    if (built) startSummary(id, built);
  };

  const isDemo = selected?.provider === 'fake';
  const stale = selected && transcript.data && selected.transcriptVersionId && selected.transcriptVersionId !== transcript.data.version.id;

  return (
    <div className="page summary-page">
      <PageHeader title="Summaries" subtitle={<span dir="auto">{rec.title}</span>} />

      {!rec.hasTranscript ? (
        <EmptyState icon={FileText} title="Create a transcript first" message="Summaries are written from the transcript." action={<Button onClick={() => go({ name: 'recording', id })}>Open recording</Button>} />
      ) : (
        <div className="summary-grid">
          <form
            className="summary-options"
            onSubmit={(e) => {
              e.preventDefault();
              generate();
            }}
          >
            {!!templates.data?.length && (
              <div className="field">
                <label htmlFor="s-template">Template</label>
                <div className="row">
                  <select
                    id="s-template"
                    className="select"
                    value=""
                    onChange={(e) => {
                      const template = templates.data?.find((t) => t.id === e.target.value);
                      if (template) setOptions(template.options);
                    }}
                  >
                    <option value="" disabled>
                      Use a saved template
                    </option>
                    {templates.data.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <SelectField<SummaryFormat> id="s-format" label="Format" value={options.format} options={SUMMARY_FORMATS} onChange={(format) => set({ format })} />
            <SelectField<SummaryLength> id="s-length" label="Length" value={options.length} options={SUMMARY_LENGTHS} onChange={(length) => set({ length })} />
            {options.length === 'custom' && (
              <div className="field">
                <label htmlFor="s-words">Word count</label>
                <input id="s-words" className="input" type="number" min={20} max={5000} value={options.customWords ?? ''} onChange={(e) => set({ customWords: e.target.value ? Number(e.target.value) : null })} />
              </div>
            )}
            <SelectField<SummaryTone> id="s-tone" label="Tone" value={options.tone} options={SUMMARY_TONES} onChange={(tone) => set({ tone })} />
            {options.tone === 'custom' && (
              <div className="field">
                <label htmlFor="s-custom-tone">Describe the tone</label>
                <input id="s-custom-tone" className="input" value={options.customTone} onChange={(e) => set({ customTone: e.target.value })} />
              </div>
            )}
            <div className="field">
              <label htmlFor="s-language">Language</label>
              <input id="s-language" className="input" list="s-languages" value={options.language} onChange={(e) => set({ language: e.target.value || OUTPUT_LANGUAGES[0]! })} />
              <datalist id="s-languages">
                {OUTPUT_LANGUAGES.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>

            <div className="field">
              <label htmlFor="s-scope">Cover</label>
              <select id="s-scope" className="select" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as typeof scopeKind)}>
                <option value="all">The whole recording</option>
                <option value="chapters" disabled={!chapters.data?.length}>
                  Selected chapters{chapters.data?.length ? '' : ' (create chapters first)'}
                </option>
                <option value="range">A time range</option>
              </select>
            </div>
            {scopeKind === 'chapters' && (
              <div className="stack" style={{ gap: 4 }}>
                {chapters.data?.map((c) => (
                  <label key={c.idx} className="row small">
                    <input type="checkbox" checked={selectedChapters.includes(c.idx)} onChange={(e) => setSelectedChapters(e.target.checked ? [...selectedChapters, c.idx] : selectedChapters.filter((x) => x !== c.idx))} />
                    <span className="truncate" dir="auto">
                      {c.title}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {scopeKind === 'range' && (
              <div className="row">
                <div className="field grow">
                  <label htmlFor="s-from">From (minutes)</label>
                  <input id="s-from" className="input" type="number" min={0} value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
                </div>
                <div className="field grow">
                  <label htmlFor="s-to">To (minutes)</label>
                  <input id="s-to" className="input" type="number" min={0} placeholder="End" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
                </div>
              </div>
            )}

            <details className="summary-more">
              <summary>More controls</summary>
              <div className="stack">
                <SelectField<SummaryExtract> id="s-extract" label="Extract" value={options.extract} options={SUMMARY_EXTRACTS} onChange={(extract) => set({ extract })} />
                <SelectField<SummaryEmphasis> id="s-emphasis" label="Emphasis" value={options.emphasis} options={SUMMARY_EMPHASIS} onChange={(emphasis) => set({ emphasis })} />
                <div className="field">
                  <label htmlFor="s-focus">Focus on topics</label>
                  <input id="s-focus" className="input" dir="auto" placeholder="For example: neural networks" value={options.focus} onChange={(e) => set({ focus: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="s-exclude">Leave out</label>
                  <input id="s-exclude" className="input" dir="auto" placeholder="For example: small talk at the start" value={options.exclude} onChange={(e) => set({ exclude: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="s-instructions">Custom instructions</label>
                  <textarea id="s-instructions" className="textarea" dir="auto" value={options.instructions} onChange={(e) => set({ instructions: e.target.value })} />
                </div>
              </div>
            </details>

            <div className="row wrap">
              <Button type="submit" variant="primary" icon={Sparkles} disabled={!!active} className="grow">
                {list.length ? 'Generate another' : 'Generate summary'}
              </Button>
              <IconButton icon={Save} label="Save these settings as a template" onClick={() => setDialog('save-template')} />
            </div>
            <p className="muted small">Uses the saved transcript. Nothing is transcribed again.</p>
          </form>

          <div className="stack" style={{ gap: 'var(--s4)' }}>
            {active && current && (
              <Card>
                <div className="row">
                  {current.status === 'waiting' && <Clock size={15} aria-hidden />}
                  <span className="grow small">{current.status === 'waiting' ? `Waiting until about ${formatRetryTime(current.nextAttemptAt)}` : current.stage}</span>
                  <Button size="sm" variant="ghost" icon={X} onClick={() => void api.cancelJob(current.id).catch(toast.showError)}>
                    Cancel
                  </Button>
                </div>
                <div style={{ marginTop: 'var(--s2)' }}>
                  <ProgressBar value={current.progress} label="Summary progress" />
                </div>
                {current.error && (
                  <p className="muted small" style={{ marginTop: 'var(--s2)' }}>
                    {current.error}
                  </p>
                )}
              </Card>
            )}
            {current?.status === 'failed' && (
              <div className="notice error" role="alert">
                <CircleAlert size={18} aria-hidden />
                <span className="grow">{current.error}</span>
                {current.retryable && (
                  <Button size="sm" icon={RotateCcw} onClick={() => void api.retryJob(current.id).catch(toast.showError)}>
                    Retry
                  </Button>
                )}
              </div>
            )}

            {!selected ? (
              !active && <EmptyState icon={Sparkles} title="No summaries yet" message="Choose your settings and generate one. You can make as many as you like, in different styles." />
            ) : (
              <Card className="summary-result">
                <div className="row wrap">
                  <select className="select summary-version" aria-label="Summary version" value={selected.id} onChange={(e) => setSelectedId(e.target.value)}>
                    {list.map((s) => (
                      <option key={s.id} value={s.id}>
                        {`${s.label} · ${formatDateTime(s.createdAt)}`}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    icon={Copy}
                    label="Copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(markdownToClipboard(selected.markdown)).then(() => toast.show('Copied'), toast.showError);
                    }}
                  />
                  <IconButton icon={Download} label="Save as Markdown" onClick={() => void api.exportSummary(selected.id, 'md').then((saved) => saved && toast.show('Summary saved'), toast.showError)} />
                  <IconButton icon={RotateCcw} label="Use these settings" onClick={() => setOptions(selected.options)} />
                  <IconButton icon={Trash2} label="Delete this version" onClick={() => setDialog('delete')} />
                </div>

                <div className="muted small" style={{ margin: '6px 0 var(--s3)' }}>
                  {providerLabel(selected.provider)}
                  {selected.provider === 'fake' ? '' : ` · ${selected.model}`}
                </div>

                {isDemo && (
                  <div className="notice warning" role="status">
                    This is demo text that only quotes the transcript. Add a real provider in Settings for an actual summary.
                  </div>
                )}
                {stale && (
                  <div className="notice warning" role="status">
                    The transcript has changed since this was written. Generate another to include your edits.
                  </div>
                )}
                {selected.truncated && (
                  <div className="notice warning" role="status">
                    This stopped at the length limit, so the end may be missing. Try a longer setting.
                  </div>
                )}
                {selected.droppedCitations > 0 && (
                  <div className="notice warning" role="status">
                    {selected.droppedCitations === 1 ? "The AI cited a source that does not exist in the transcript. That reference was removed, so check the nearby claim." : `The AI cited ${selected.droppedCitations} sources that do not exist in the transcript. Those references were removed, so check nearby claims.`}
                  </div>
                )}
                <MarkdownView markdown={selected.markdown} onCite={seek} />
                <p className="muted small" style={{ marginTop: 'var(--s4)' }}>
                  Select a time to hear the source. AI can make mistakes, so check anything important against the recording.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}

      {dialogs}
      {dialog === 'save-template' && (
        <TextPromptDialog title="Save as template" label="Template name" confirmLabel="Save" onConfirm={(name) => void api.saveTemplate(name, options).then(() => toast.show('Template saved'), toast.showError)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && selected && (
        <ConfirmDialog title="Delete this version?" message="This summary will be permanently removed." confirmLabel="Delete" destructive onConfirm={() => void api.deleteSummary(selected.id).catch(toast.showError)} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
