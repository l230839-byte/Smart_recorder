import { useState } from 'react';
import { CircleAlert, Clock, FileText, RotateCcw, Sparkles, X } from 'lucide-react';
import type { Recording } from '@shared/models';
import { PROVIDER_INFO, TRANSCRIPT_LANGUAGES } from '@shared/providers';
import { Button, Card, ProgressBar } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { useTranscribe } from './ai-gate';

export function formatRetryTime(at: number | null): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The recording's AI status. Identical for every source, as prompt §3 requires. */
export function AiCard({ recording }: { recording: Recording }) {
  const { go } = useRouter();
  const toast = useToast();
  const job = useQuery(() => api.latestJob(recording.id), [recording.id], ['jobs']);
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const { start, dialogs } = useTranscribe();
  const [language, setLanguage] = useState<string | null>(null);
  const current = job.data;
  const active = current && ['queued', 'running', 'waiting'].includes(current.status);
  const failed = current?.status === 'failed';
  const chosen = language ?? settings.data?.transcriptionLanguage ?? 'auto';

  return (
    <Card>
      <div className="row">
        <Sparkles size={18} aria-hidden style={{ color: 'var(--teal)' }} />
        <h2 className="grow">{recording.hasTranscript ? 'Transcript' : 'Create a transcript'}</h2>
        {recording.hasTranscript && (
          <Button size="sm" variant="primary" icon={FileText} onClick={() => go({ name: 'transcript', id: recording.id })}>
            Open transcript
          </Button>
        )}
      </div>

      {active && current && (
        <div className="stack" style={{ marginTop: 'var(--s3)', gap: 'var(--s2)' }}>
          <div className="row">
            {current.status === 'waiting' ? <Clock size={15} aria-hidden /> : null}
            <span className="grow small">
              {current.status === 'waiting' ? `Waiting until about ${formatRetryTime(current.nextAttemptAt)}` : current.stage}
            </span>
            <Button size="sm" variant="ghost" icon={X} onClick={() => void api.cancelJob(current.id).catch(toast.showError)}>
              Cancel
            </Button>
          </div>
          <ProgressBar value={current.progress} label="Transcription progress" />
          {current.error && <p className="muted small">{current.error}</p>}
        </div>
      )}

      {failed && current && (
        <div className="notice error" role="alert" style={{ marginTop: 'var(--s3)' }}>
          <CircleAlert size={18} aria-hidden />
          <span className="grow">{current.error}</span>
          {current.retryable && (
            <Button size="sm" icon={RotateCcw} onClick={() => void api.retryJob(current.id).catch(toast.showError)}>
              Retry
            </Button>
          )}
        </div>
      )}

      {!active && (
        <>
          {!recording.hasTranscript && !failed && (
            <p className="muted small" style={{ marginTop: 6 }}>
              Summaries, chat, study tools and documents all build on the transcript. They arrive in later build phases and work the same for every recording.
            </p>
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
            {settings.data && (
              <span className="muted small">
                Using {PROVIDER_INFO[settings.data.transcriptionProvider].label}.{' '}
                <button type="button" className="link" onClick={() => go({ name: 'providers' })}>
                  Change
                </button>
              </span>
            )}
          </div>
        </>
      )}
      {dialogs}
    </Card>
  );
}
