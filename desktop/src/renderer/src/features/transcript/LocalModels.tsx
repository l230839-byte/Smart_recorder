import { useState } from 'react';
import { CircleCheck, Download, HardDrive, Trash2, X } from 'lucide-react';
import { LOCAL_MODELS, type LocalModelId, type LocalModelStatus } from '@shared/providers';
import { Button, Card, ConfirmDialog, ProgressBar } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

function ModelRow({ status, chosen, onChoose, onDownload }: { status: LocalModelStatus; chosen: boolean; onChoose: () => void; onDownload: () => void }) {
  const toast = useToast();
  const info = LOCAL_MODELS[status.id];
  const job = status.downloading;
  return (
    <div className="local-model">
      <button type="button" className="provider-choice grow" role="radio" aria-checked={chosen} onClick={onChoose}>
        <span className="grow">
          <h3>
            {info.label} <span className="muted small">· {info.sizeMb} MB</span>
          </h3>
          <span className="muted small">{info.hint}</span>
        </span>
        {status.installed && (
          <span className="row small local-model-state">
            <CircleCheck size={15} aria-hidden /> Downloaded
          </span>
        )}
      </button>
      <div className="local-model-actions">
        {job ? (
          <>
            <ProgressBar value={job.total ? job.received / job.total : 0} label={`Downloading ${info.label}`} />
            <span className="muted small tabular">
              {mb(job.received)} of {mb(job.total)}
            </span>
            <Button size="sm" icon={X} onClick={() => api.cancelLocalModelDownload(status.id)}>
              Pause
            </Button>
          </>
        ) : status.installed ? (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void api.deleteLocalModel(status.id).catch(toast.showError)}>
            Delete
          </Button>
        ) : (
          <Button size="sm" icon={Download} onClick={onDownload}>
            {status.partialBytes ? `Continue (${mb(status.partialBytes)} done)` : 'Download'}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Offline Whisper's models. Choosing one makes it the model EchoMind uses; downloading happens only when
 * the person asks, from the official source, and is checked before use.
 */
export function LocalModelsCard({ value, offlineOnly, onChange }: { value: string | null; offlineOnly: boolean; onChange: (model: LocalModelId) => void }) {
  const toast = useToast();
  const list = useQuery(() => api.listLocalModels(), [], ['settings']);
  const [confirm, setConfirm] = useState<LocalModelId | null>(null);
  const chosen = (value && value in LOCAL_MODELS ? value : 'small') as LocalModelId;
  const download = (id: LocalModelId) => {
    onChange(id);
    api.downloadLocalModel(id).then(() => toast.show(`${LOCAL_MODELS[id].label} model ready. Transcription now works offline.`), toast.showError);
  };
  if (!list.data) return null;
  return (
    <Card>
      <div className="row" style={{ marginBottom: 'var(--s3)' }}>
        <HardDrive size={18} aria-hidden />
        <strong className="grow">Offline models</strong>
      </div>
      {!list.data.installed && (
        <div className="notice warning" role="status" style={{ marginBottom: 'var(--s3)' }}>
          Offline transcription is not included in this copy of EchoMind. Developers: run npm run fetch:whisper once.
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 'var(--s3)' }}>
        Choose a model and download it once. It is fetched from whisper.cpp&apos;s official model page on Hugging Face and checked before use; nothing from your recordings is ever sent. Larger models are more accurate but slower.
      </p>
      <div className="stack" role="radiogroup" aria-label="Offline model" style={{ gap: 'var(--s2)' }}>
        {list.data.models.map((m) => (
          <ModelRow key={m.id} status={m} chosen={chosen === m.id} onChoose={() => onChange(m.id)} onDownload={() => (offlineOnly ? setConfirm(m.id) : download(m.id))} />
        ))}
      </div>
      {!list.data.models.find((m) => m.id === chosen)?.installed && (
        <p className="small" role="status" style={{ marginTop: 'var(--s3)', color: 'var(--warning)' }}>
          The {LOCAL_MODELS[chosen].label} model is not downloaded yet, so offline transcription cannot start.
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title="Download while Offline only is on?"
          message={`This contacts Hugging Face once to download the ${LOCAL_MODELS[confirm].label} model (${LOCAL_MODELS[confirm].sizeMb} MB). Nothing from your recordings is sent, and Offline only stays on.`}
          confirmLabel="Download"
          onConfirm={() => {
            download(confirm);
            setConfirm(null);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}
