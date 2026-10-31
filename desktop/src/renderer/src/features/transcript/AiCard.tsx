import { useState } from 'react';
import { CircleAlert, Clock, FileText, Heading, ListTree, RotateCcw, Sparkles, Tag, Type, X } from 'lucide-react';
import { formatDuration } from '@shared/format';
import type { ProcessingJob, Recording } from '@shared/models';
import { PROVIDER_INFO, providerLabel, TRANSCRIPT_LANGUAGES } from '@shared/providers';
import { Button, Card, ProgressBar } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { player } from '../../lib/player';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import '../summary/summary.css';
import { useTranscribe } from './ai-gate';

export function formatRetryTime(at: number | null): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function JobStatus({ job }: { job: ProcessingJob }) {
  const toast = useToast();
  const active = ['queued', 'running', 'waiting'].includes(job.status);
  if (active) {
    return (
      <div className="stack" style={{ marginTop: 'var(--s3)', gap: 'var(--s2)' }}>
        <div className="row">
          {job.status === 'waiting' ? <Clock size={15} aria-hidden /> : null}
          <span className="grow small">{job.status === 'waiting' ? `Waiting until about ${formatRetryTime(job.nextAttemptAt)}` : job.stage}</span>
          <Button size="sm" variant="ghost" icon={X} onClick={() => void api.cancelJob(job.id).catch(toast.showError)}>
            Cancel
          </Button>
        </div>
        <ProgressBar value={job.progress} label={`${job.stage} progress`} />
        {job.error && <p className="muted small">{job.error}</p>}
      </div>
    );
  }
  if (job.status === 'failed') {
    return (
      <div className="notice error" role="alert" style={{ marginTop: 'var(--s3)' }}>
        <CircleAlert size={18} aria-hidden />
        <span className="grow">{job.error}</span>
        {job.retryable && (
          <Button size="sm" icon={RotateCcw} onClick={() => void api.retryJob(job.id).catch(toast.showError)}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  return null;
}

/** The recording's AI tools. Identical for every source, as prompt §3 requires. */
export function AiCard({ recording }: { recording: Recording }) {
  const { go } = useRouter();
  const toast = useToast();
  const job = useQuery(() => api.latestJob(recording.id, 'transcribe'), [recording.id], ['jobs']);
  const chapterJob = useQuery(() => api.latestJob(recording.id, 'chapters'), [recording.id], ['jobs']);
  const suggestJob = useQuery(() => api.latestJob(recording.id, 'suggest'), [recording.id], ['jobs']);
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const usage = useQuery(() => api.getUsage(), [], ['jobs']);
  const chapters = useQuery(() => api.listChapters(recording.id), [recording.id], ['summaries']);
  const suggestions = useQuery(() => api.getSuggestions(recording.id), [recording.id], ['summaries']);
  const { start, startChapters, startSuggestions, dialogs } = useTranscribe();
  const [language, setLanguage] = useState<string | null>(null);
  const current = job.data;
  const active = current && ['queued', 'running', 'waiting'].includes(current.status);
  const failed = current?.status === 'failed';
  const chosen = language ?? settings.data?.transcriptionLanguage ?? 'auto';
  const provider = settings.data?.transcriptionProvider;
  const limit = settings.data?.dailyAudioLimitMinutes;
  const usedToday = usage.data?.find((u) => u.provider === provider)?.audioMsToday ?? 0;
  const overReminder = limit && usedToday > limit * 60_000;
  const suggested = suggestions.data;

  return (
    <>
      <Card>
        <div className="row">
          <Sparkles size={18} aria-hidden style={{ color: 'var(--teal)' }} />
          <h2 className="grow">{recording.hasTranscript ? 'Transcript and AI tools' : 'Create a transcript'}</h2>
          {recording.hasTranscript && (
            <Button size="sm" variant="primary" icon={FileText} onClick={() => go({ name: 'transcript', id: recording.id })}>
              Open transcript
            </Button>
          )}
        </div>

        {current && <JobStatus job={current} />}

        {!active && (
          <>
            {!recording.hasTranscript && !failed && (
              <p className="muted small" style={{ marginTop: 6 }}>
                Summaries and other AI tools all build on the transcript, and work the same for every recording.
              </p>
            )}
            {overReminder && (
              <div className="notice warning" role="status" style={{ marginTop: 'var(--s3)' }}>
                You passed your daily reminder of {limit} minutes for this service.
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 'var(--s3)' }}>
              <label className="small muted" htmlFor="ai-language">
                Language
              </label>
              <select id="ai-language" className="select" style={{ width: 190, height: 30, fontSize: 13 }} value={chosen} onChange={(e) => setLanguage(e.target.value)}>
                {TRANSCRIPT_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <Button size="sm" variant={recording.hasTranscript ? 'outline' : 'tonal'} onClick={() => start([recording.id], chosen)}>
                {recording.hasTranscript ? 'Transcribe again' : 'Transcribe'}
              </Button>
              {provider && (
                <span className="muted small">
                  Using {PROVIDER_INFO[provider].label}.{' '}
                  <button type="button" className="link" onClick={() => go({ name: 'providers' })}>
                    Change
                  </button>
                </span>
              )}
            </div>
          </>
        )}

        {recording.hasTranscript && (
          <div className="ai-actions">
            <Button size="sm" variant="tonal" icon={Sparkles} onClick={() => go({ name: 'summaries', id: recording.id })}>
              Summaries
            </Button>
            <Button size="sm" icon={ListTree} onClick={() => startChapters(recording.id)}>
              {chapters.data?.length ? 'Find chapters again' : 'Find chapters'}
            </Button>
            <Button size="sm" icon={Tag} onClick={() => startSuggestions(recording.id)}>
              Suggest title and tags
            </Button>
          </div>
        )}
        {chapterJob.data && chapterJob.data.status !== 'done' && chapterJob.data.status !== 'canceled' && <JobStatus job={chapterJob.data} />}
        {suggestJob.data && suggestJob.data.status !== 'done' && suggestJob.data.status !== 'canceled' && <JobStatus job={suggestJob.data} />}
        {dialogs}
      </Card>

      {suggested && (
        <Card>
          <div className="row">
            <Type size={18} aria-hidden style={{ color: 'var(--teal)' }} />
            <h2 className="grow">Suggestions</h2>
            <Button size="sm" variant="ghost" onClick={() => void api.dismissSuggestions(recording.id).catch(toast.showError)}>
              Dismiss
            </Button>
          </div>
          <div className="stack" style={{ marginTop: 'var(--s3)', gap: 'var(--s2)' }}>
            {suggested.title && suggested.title !== recording.title && (
              <div className="row">
                <Heading size={15} aria-hidden />
                <span className="grow" dir="auto">
                  {suggested.title}
                </span>
                <Button size="sm" onClick={() => void api.updateRecording(recording.id, { title: suggested.title }).catch(toast.showError)}>
                  Use this title
                </Button>
              </div>
            )}
            {suggested.tags.length > 0 && (
              <div className="suggestion-tags">
                {suggested.tags.map((t) => {
                  const added = recording.tags.some((x) => x.name.toLocaleLowerCase() === t.toLocaleLowerCase());
                  return (
                    <button key={t} type="button" className="chip" disabled={added} aria-pressed={added} onClick={() => void api.addTag(recording.id, t).catch(toast.showError)}>
                      {added ? '✓ ' : '+ '}#{t}
                    </button>
                  );
                })}
              </div>
            )}
            {suggested.topics.length > 0 && <p className="muted small">Topics: {suggested.topics.join(', ')}</p>}
            <p className="muted small">Nothing changes unless you choose it.</p>
          </div>
        </Card>
      )}

      {!!chapters.data?.length && (
        <section>
          <div className="section-title">
            <h2>Chapters</h2>
          </div>
          <Card>
            {chapters.data.map((c) => (
              <button key={c.idx} type="button" className="chapter-row" onClick={() => void player.load(recording, c.startMs, true)}>
                <span className="chapter-time tabular">{formatDuration(c.startMs)}</span>
                <span className="grow">
                  <span className="chapter-title" dir="auto">
                    {c.title}
                  </span>
                  {c.summary && (
                    <span className="muted small" dir="auto" style={{ display: 'block' }}>
                      {c.summary}
                    </span>
                  )}
                </span>
              </button>
            ))}
            {settings.data?.llmProvider === 'fake' && <p className="muted small">These are demo chapters from {providerLabel('fake')}.</p>}
          </Card>
        </section>
      )}
    </>
  );
}
