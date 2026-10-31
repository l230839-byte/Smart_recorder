import { useState } from 'react';
import { CircleAlert, CircleCheck, Copy, FileAudio, FileUp, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { formatBytes, plural } from '@shared/format';
import { MODE_INFO, RECORDING_MODES, type ImportJob, type RecordingMode } from '@shared/models';
import { Button, Card, IconButton, PageHeader, ProgressBar } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useRouter } from '../../lib/router';
import { useToast } from '../../lib/toast';

const STATUS_TEXT: Record<ImportJob['status'], string> = {
  queued: 'Waiting',
  copying: 'Copying',
  checking: 'Checking audio',
  converting: 'Preparing audio',
  done: 'Imported',
  duplicate: 'Already in your library',
  failed: 'Failed',
};

const FORMATS = 'MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, WebM and video files such as MP4, MOV and MKV';

function JobRow({ job }: { job: ImportJob }) {
  const { go } = useRouter();
  const active = !['done', 'duplicate', 'failed'].includes(job.status);
  return (
    <div className="import-row">
      <span className={`import-icon ${job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : job.status === 'duplicate' ? 'dup' : ''}`}>
        {job.status === 'done' && <CircleCheck size={20} aria-hidden />}
        {job.status === 'failed' && <CircleAlert size={20} aria-hidden />}
        {job.status === 'duplicate' && <Copy size={20} aria-hidden />}
        {active && <Loader2 size={20} aria-hidden className="spin" />}
      </span>
      <div className="grow">
        <div className="truncate" dir="auto" title={job.displayName}>
          {job.displayName}
        </div>
        <div className="muted small">
          {STATUS_TEXT[job.status]}
          {job.sizeBytes !== null ? ` · ${formatBytes(job.sizeBytes)}` : ''}
        </div>
        {job.error && <div className={`small import-error ${job.status === 'failed' ? 'bad' : 'warn'}`}>{job.error}</div>}
        {active && <ProgressBar value={job.progress} label={`Importing ${job.displayName}`} />}
      </div>
      {job.status === 'done' && job.recordingId && (
        <Button size="sm" onClick={() => go({ name: 'recording', id: job.recordingId! })}>
          Open
        </Button>
      )}
      {job.status === 'duplicate' && job.duplicateOf && (
        <Button size="sm" onClick={() => go({ name: 'recording', id: job.duplicateOf! })}>
          View existing
        </Button>
      )}
      {job.status === 'failed' && job.retryable && (
        <Button size="sm" icon={RotateCcw} onClick={() => void api.retryImport(job.id)}>
          Retry
        </Button>
      )}
      {!active && <IconButton icon={Trash2} label={`Remove ${job.displayName} from this list`} size={16} onClick={() => void api.removeImport(job.id)} />}
    </div>
  );
}

export function ImportScreen() {
  const toast = useToast();
  const settings = useQuery(() => api.getSettings(), [], ['settings']);
  const jobs = useQuery(() => api.listImports(), [], ['imports']);
  const [mode, setMode] = useState<RecordingMode | null>(null);
  const selected = mode ?? settings.data?.defaultMode ?? 'lecture';
  const list = jobs.data ?? [];
  const finished = list.filter((j) => j.status === 'done' || j.status === 'duplicate').length;
  const active = list.filter((j) => !['done', 'duplicate', 'failed'].includes(j.status)).length;

  return (
    <div className="page">
      <PageHeader title="Import audio" subtitle="Imported recordings get exactly the same tools as ones you record here." />

      <div className="import-drop">
        <div className="empty-icon">
          <FileUp size={26} aria-hidden />
        </div>
        <h2>Choose files, or drop them anywhere in this window</h2>
        <p className="muted small">{FORMATS}. Your original files are never changed.</p>
        <div className="row wrap" style={{ marginTop: 'var(--s3)', justifyContent: 'center' }}>
          <label className="row small" htmlFor="import-mode">
            Mode
          </label>
          <select id="import-mode" className="select" style={{ width: 170 }} value={selected} onChange={(e) => setMode(e.target.value as RecordingMode)}>
            {RECORDING_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_INFO[m].label}
              </option>
            ))}
          </select>
          <Button variant="primary" icon={FileAudio} onClick={() => void api.pickAndImport(selected).catch(toast.showError)}>
            Choose files
          </Button>
        </div>
      </div>

      {list.length > 0 && (
        <section>
          <div className="section-title">
            <h2>{active > 0 ? `Importing ${plural(active, 'file')}` : 'Imports'}</h2>
            {finished > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void api.clearFinishedImports()}>
                Clear finished
              </Button>
            )}
          </div>
          <Card className="import-list">
            {list.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}
