import { useState } from 'react';
import { CircleCheck, CloudOff, Download, HardDrive, Trash2, X } from 'lucide-react';
import { LOCAL_LLM_MODELS, LOCAL_MODELS, type LocalLlmModelId, type LocalModelId } from '@shared/providers';
import { Button, Card, ConfirmDialog, ProgressBar } from '../../design/components';
import { api, useQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;
const size = (sizeMb: number) => (sizeMb >= 1000 ? `${(sizeMb / 1024).toFixed(1)} GB` : `${sizeMb} MB`);

interface Status<Id extends string> {
  id: Id;
  installed: boolean;
  downloading: { received: number; total: number } | null;
  partialBytes: number;
}

/** What differs between the Whisper models and the writing models; the rest is the same card. */
interface Kind<Id extends string> {
  title: string;
  catalog: Record<Id, { label: string; sizeMb: number; hint: string }>;
  list: () => Promise<{ models: Status<Id>[]; installed: boolean }>;
  download: (id: Id) => Promise<void>;
  cancel: (id: Id) => void;
  remove: (id: Id) => Promise<void>;
  missingTool: string;
  ready: (label: string) => string;
  notReady: (label: string) => string;
}

export const WHISPER: Kind<LocalModelId> = {
  title: 'Offline transcription models',
  catalog: LOCAL_MODELS,
  list: () => api.listLocalModels(),
  download: (id) => api.downloadLocalModel(id),
  cancel: (id) => api.cancelLocalModelDownload(id),
  remove: (id) => api.deleteLocalModel(id),
  missingTool: 'Offline transcription is not included in this copy of EchoMind. Developers: run npm run fetch:whisper once.',
  ready: (label) => `${label} model ready. Transcription now works offline.`,
  notReady: (label) => `The ${label} model is not downloaded yet, so offline transcription cannot start.`,
};

export const WRITING: Kind<LocalLlmModelId> = {
  title: 'Offline writing models',
  catalog: LOCAL_LLM_MODELS,
  list: () => api.listWritingModels(),
  download: (id) => api.downloadWritingModel(id),
  cancel: (id) => api.cancelWritingModelDownload(id),
  remove: (id) => api.deleteWritingModel(id),
  missingTool: 'Offline writing is not included in this copy of EchoMind. Developers: run npm run fetch:llama once.',
  ready: (label) => `${label} ready. Summaries, chat and AI Studio now work offline.`,
  notReady: (label) => `The ${label} model is not downloaded yet, so offline summaries, chat and AI Studio cannot start.`,
};

function ModelRow<Id extends string>({ kind, status, chosen, onChoose, onDownload }: { kind: Kind<Id>; status: Status<Id>; chosen: boolean; onChoose: () => void; onDownload: () => void }) {
  const toast = useToast();
  const info = kind.catalog[status.id];
  const job = status.downloading;
  return (
    <div className="local-model">
      <button type="button" className="provider-choice grow" role="radio" aria-checked={chosen} onClick={onChoose}>
        <span className="grow">
          <h3>
            {info.label} <span className="muted small">· {size(info.sizeMb)}</span>
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
            <Button size="sm" icon={X} onClick={() => kind.cancel(status.id)}>
              Pause
            </Button>
          </>
        ) : status.installed ? (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void kind.remove(status.id).catch(toast.showError)}>
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
 * Models that run on this computer. Choosing one makes it the model EchoMind uses offline; downloading
 * happens only when the person asks, from the official source, and is checked before use.
 */
export function ModelsCard<Id extends string>({ kind, value, fallback, offlineOnly, onChange }: { kind: Kind<Id>; value: string | null; fallback: Id; offlineOnly: boolean; onChange: (model: Id) => void }) {
  const toast = useToast();
  const list = useQuery(() => kind.list(), [kind.title], ['settings']);
  const [confirm, setConfirm] = useState<Id | null>(null);
  const chosen = (value && value in kind.catalog ? value : fallback) as Id;
  const download = (id: Id) => {
    onChange(id);
    kind.download(id).then(() => toast.show(kind.ready(kind.catalog[id].label)), toast.showError);
  };
  if (!list.data) return null;
  return (
    <Card>
      <div className="row" style={{ marginBottom: 'var(--s3)' }}>
        <HardDrive size={18} aria-hidden />
        <strong className="grow">{kind.title}</strong>
      </div>
      {!list.data.installed && (
        <div className="notice warning" role="status" style={{ marginBottom: 'var(--s3)' }}>
          {kind.missingTool}
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 'var(--s3)' }}>
        Choose a model and download it once. It comes from its official page on Hugging Face and is checked before use; nothing from your recordings is ever sent. Larger models are better but slower.
      </p>
      <div className="stack" role="radiogroup" aria-label={kind.title} style={{ gap: 'var(--s2)' }}>
        {list.data.models.map((m) => (
          <ModelRow key={m.id} kind={kind} status={m} chosen={chosen === m.id} onChoose={() => onChange(m.id)} onDownload={() => (offlineOnly ? setConfirm(m.id) : download(m.id))} />
        ))}
      </div>
      {!list.data.models.find((m) => m.id === chosen)?.installed && (
        <p className="small" role="status" style={{ marginTop: 'var(--s3)', color: 'var(--warning)' }}>
          {kind.notReady(kind.catalog[chosen].label)}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title="Download while Offline only is on?"
          message={`This contacts Hugging Face once to download ${kind.catalog[confirm].label} (${size(kind.catalog[confirm].sizeMb)}). Nothing from your recordings is sent, and Offline only stays on.`}
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

/**
 * Everything needed to work with no internet, in one place: what is ready, what is missing, and one button
 * to fetch it all. With Offline only on, every AI feature uses these.
 */
export function OfflineCard({ transcriptionModel, writingModel, offlineOnly, onTurnOn }: { transcriptionModel: LocalModelId; writingModel: LocalLlmModelId; offlineOnly: boolean; onTurnOn: () => void }) {
  const toast = useToast();
  const whisper = useQuery(() => api.listLocalModels(), [], ['settings']);
  const writing = useQuery(() => api.listWritingModels(), [], ['settings']);
  const [confirm, setConfirm] = useState(false);
  if (!whisper.data || !writing.data) return null;
  const w = whisper.data.models.find((m) => m.id === transcriptionModel);
  const l = writing.data.models.find((m) => m.id === writingModel);
  const busy = Boolean(w?.downloading || l?.downloading);
  const missing = [!w?.installed && { kind: WHISPER, id: transcriptionModel }, !l?.installed && { kind: WRITING, id: writingModel }].filter(Boolean) as { kind: Kind<string>; id: string }[];
  const missingMb = missing.reduce((n, m) => n + m.kind.catalog[m.id]!.sizeMb, 0);
  const downloadAll = () => {
    for (const m of missing) void m.kind.download(m.id).catch(toast.showError);
  };
  const line = (label: string, status: Status<string> | undefined, sizeMb: number) => (
    <li className="row small">
      {status?.installed ? <CircleCheck size={15} aria-hidden className="mic-ok" /> : <Download size={15} aria-hidden />}
      <span className="grow">{label}</span>
      <span className="muted">{status?.installed ? 'Ready' : status?.downloading ? `${mb(status.downloading.received)} of ${mb(status.downloading.total)}` : `${size(sizeMb)} to download`}</span>
    </li>
  );
  return (
    <Card>
      <div className="row" style={{ marginBottom: 'var(--s2)' }}>
        <CloudOff size={18} aria-hidden />
        <strong className="grow">Work offline</strong>
        <span className={`badge ${offlineOnly ? 'badge-success' : ''}`}>{offlineOnly ? 'Offline only is on' : 'Online'}</span>
      </div>
      <p className="muted small">With Offline only on, transcription, summaries, chapters, chat, documents and AI Studio all run on this computer. Nothing is sent anywhere.</p>
      <ul className="stack offline-list" style={{ gap: 'var(--s2)', margin: 'var(--s3) 0' }}>
        {line(`Transcription: Whisper ${LOCAL_MODELS[transcriptionModel].label}`, w, LOCAL_MODELS[transcriptionModel].sizeMb)}
        {line(`Writing: ${LOCAL_LLM_MODELS[writingModel].label}`, l, LOCAL_LLM_MODELS[writingModel].sizeMb)}
      </ul>
      <div className="row wrap">
        {missing.length > 0 && (
          <Button variant="primary" icon={Download} disabled={busy} onClick={() => (offlineOnly ? setConfirm(true) : downloadAll())}>
            {busy ? 'Downloading…' : `Download for offline use (${size(missingMb)})`}
          </Button>
        )}
        {!offlineOnly && (
          <Button icon={CloudOff} onClick={onTurnOn}>
            Turn on Offline only
          </Button>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Download while Offline only is on?"
          message={`This contacts Hugging Face once to download the offline models (${size(missingMb)}). Nothing from your recordings is sent, and Offline only stays on.`}
          confirmLabel="Download"
          onConfirm={() => {
            downloadAll();
            setConfirm(false);
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </Card>
  );
}
