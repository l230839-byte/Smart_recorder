import { CircleAlert, CircleCheck, CircleSlash, Clock, ListChecks, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { formatRelative } from '@shared/format';
import { JOB_KIND_LABEL, type ProcessingJob } from '@shared/models';
import { providerLabel } from '@shared/providers';
import { Button, EmptyState, IconButton, Loading, PageHeader, ProgressBar } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { formatRetryTime } from './AiCard';
import './transcript.css';

function JobIcon({ job }: { job: ProcessingJob }) {
  if (job.status === 'done') return <CircleCheck size={20} aria-hidden style={{ color: 'var(--success)' }} />;
  if (job.status === 'failed') return <CircleAlert size={20} aria-hidden style={{ color: 'var(--danger)' }} />;
  if (job.status === 'canceled') return <CircleSlash size={20} aria-hidden style={{ color: 'var(--text-faint)' }} />;
  if (job.status === 'waiting') return <Clock size={20} aria-hidden style={{ color: 'var(--warning)' }} />;
  return <Loader2 size={20} aria-hidden className={job.status === 'running' ? 'spin' : ''} />;
}

export function JobsScreen() {
  const { go } = useRouter();
  const toast = useToast();
  const jobs = useQuery(() => api.listJobs(), [], ['jobs']);
  if (!jobs.data) return <Loading />;
  const finished = jobs.data.some((j) => j.status === 'done' || j.status === 'canceled');

  return (
    <div className="page">
      <PageHeader
        title="Processing jobs"
        subtitle="Jobs continue after a restart, and finished work is never redone."
        actions={
          finished ? (
            <Button variant="ghost" onClick={() => void api.clearFinishedJobs().catch(toast.showError)}>
              Clear finished
            </Button>
          ) : undefined
        }
      />
      {jobs.data.length === 0 ? (
        <EmptyState icon={ListChecks} title="Nothing is processing" message="AI work you start will appear here." />
      ) : (
        <div className="rec-list">
          {jobs.data.map((job) => {
            const active = ['queued', 'running', 'waiting'].includes(job.status);
            return (
              <div key={job.id} className="job-row">
                <JobIcon job={job} />
                <div className="grow">
                  <button type="button" className="mini-title truncate" dir="auto" onClick={() => go({ name: 'recording', id: job.recordingId })}>
                    {job.recordingTitle}
                  </button>
                  <div className="muted small">
                    {JOB_KIND_LABEL[job.kind]} · {job.status === 'waiting' ? `Waiting until about ${formatRetryTime(job.nextAttemptAt)}` : job.stage} · {providerLabel(job.provider)} · {formatRelative(job.createdAt)}
                  </div>
                  {job.error && <div className="small import-error" style={{ color: job.status === 'failed' ? 'var(--danger)' : 'var(--warning)' }}>{job.error}</div>}
                  {active && <div style={{ marginTop: 6 }}><ProgressBar value={job.progress} label={`Progress for ${job.recordingTitle}`} /></div>}
                </div>
                {job.status === 'failed' && job.retryable && (
                  <Button size="sm" icon={RotateCcw} onClick={() => void api.retryJob(job.id).catch(toast.showError)}>
                    Retry
                  </Button>
                )}
                {active ? (
                  <IconButton icon={X} label={`Cancel ${job.recordingTitle}`} onClick={() => void api.cancelJob(job.id).catch(toast.showError)} />
                ) : (
                  <IconButton icon={Trash2} size={16} label={`Remove ${job.recordingTitle} from this list`} onClick={() => void api.removeJob(job.id).catch(toast.showError)} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
